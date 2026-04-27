# Pitfalls Research

**Domain:** AI Coding Agent CLI -- Investor Demo Stabilization
**Researched:** 2026-04-27
**Confidence:** HIGH (based on codebase analysis + domain knowledge of AI demo failure modes)

## Critical Pitfalls

### Pitfall 1: The "Happy Path Illusion" -- Commands Work Once, Fail on Variant Inputs

**What goes wrong:**
A slash command like `/twin` works with no arguments during rehearsal, but an investor types `/twin build extra-arg` or runs `/twin` in a repo with no git history, and it throws an unhandled exception. Many of the 40+ commands have been tested on zero or one path. The `as any` casts (68+ across core files) hide type mismatches that surface as runtime `undefined` property access errors.

**Why it happens:**
Commands like `runDigitalTwin`, `runPredictiveRepair`, etc. cast tool results with `as any` and immediately access nested properties (`result.twin.files?.total`, `result.queue`, `result.diagnosticsOk`). If the backend tool returns a different shape -- empty object, error string, null -- the display code crashes. The pattern `const result: any = await this.backend.callTool(...)` followed by `result.someProperty` appears in nearly every moonshot handler.

**How to avoid:**
1. For every command shown in the demo, test three scenarios: (a) default/no args, (b) with expected args, (c) with the repo in a "bare" state (no `.mesh/`, no prior index).
2. Add null-coalescing guards on every property access in command handlers: `result?.twin?.files?.total ?? "n/a"`.
3. Wrap every handler body in try/catch with a user-friendly fallback message (many already have this, but verify they all do).

**Warning signs:**
- Running a command and seeing `Cannot read properties of undefined` in the terminal.
- A spinner that starts but never stops (the `ora` spinner is created before the try block in some handlers, meaning exceptions can leave it spinning forever).

**Phase to address:**
Phase 1 (Command Triage) -- before any demo rehearsal. Every command must be run once and its error path verified.

---

### Pitfall 2: LLM Latency Kills Demo Momentum -- The 30-Second Silence

**What goes wrong:**
An investor asks "show me how it debugs" and the presenter types a command. The LLM call takes 15-45 seconds. The screen shows "Thinking..." with a spinner. The room goes silent. The investor checks their phone. The magic is broken.

Commands that call `runSingleTurn()` internally (like `/distill`, `/hologram`, `/synthesize`, `/fix`) make full LLM round-trips. The `maxStepsForInput` function limits steps to 2-4, but each step can take 10-30 seconds. A `/distill` call invokes a sub-agent, which makes its own LLM calls.

**Why it happens:**
Bedrock latency is 5-30s per call depending on context size. The context assembler at `agent-loop.ts:1575` accumulates reports without bounds. After a few commands in a session, context grows and every subsequent call is slower. There is no timeout on individual LLM calls (the `converse` method has no timeout, only an `AbortSignal` that nobody triggers automatically).

**How to avoid:**
1. Pre-warm the demo session: run `/index` and one LLM command before the investor arrives so the first real call is not cold-start.
2. Keep a rehearsal script with known-fast commands first (local commands like `/status`, `/cost`, `/help` are instant).
3. Fill silence: narrate what the tool is doing while it thinks. The spinner text updates with tool names -- point this out.
4. If a command hangs for more than 20 seconds, have `/compact` ready to reduce context and retry.
5. Do NOT run `/distill` or `/synthesize` live -- pre-generate their artifacts before the demo and show the results.

**Warning signs:**
- `api turn: up50,000+ down...` -- context has blown up; subsequent calls will be slow.
- Spinner stuck on "Thinking..." with no tool events appearing.
- Session has been running for 10+ turns without `/compact`.

**Phase to address:**
Phase 2 (Demo Script Preparation) -- build the rehearsal sequence. Also Phase 1 to add defensive timeouts.

---

### Pitfall 3: The "Last Fix Breaks Everything" Cascade

**What goes wrong:**
You fix a broken command at 3 AM before the demo. The fix touches `local-tools.ts` (6,000 lines) or `agent-loop.ts` (4,760 lines). A subtle change breaks 5 other commands that share the same code path. You discover this during the demo.

**Why it happens:**
The monolithic architecture means any change to `local-tools.ts` or `agent-loop.ts` can have unintended side effects. There are no tests. The `as any` casts prevent TypeScript from catching breakage. The tool backend is shared state -- `this.backend.callTool()` from every slash command goes through the same `LocalToolBackend` instance.

**How to avoid:**
1. FREEZE CODE at least 3 hours before the demo. No more changes. Period.
2. After any code change, test ALL demo-critical commands, not just the one you fixed.
3. If a command is broken and unfixable in 30 minutes, REMOVE IT from the demo script rather than attempting a risky fix.
4. Keep a known-good build tagged in git. If a fix breaks things, `git stash` and return to the known-good state.

**Warning signs:**
- Changing more than 10 lines in a monolithic file within 4 hours of the demo.
- A "quick fix" that requires understanding code 200 lines away.
- TypeScript compiles but you haven't tested the runtime.

**Phase to address:**
Phase 3 (Final Stabilization) -- enforce the code freeze rule. Tag the known-good commit.

---

### Pitfall 4: Bedrock/Network Failure During the Live Demo

**What goes wrong:**
AWS Bedrock returns 429 (rate limit), 500 (server error), or the network drops. The LLM client has fallback logic (`shouldTryFallback` for 404/429/500+) but fallback model IDs may not be configured or may also fail. The error message shown is the raw attempt string: `"LLM request failed after 2 attempt(s): model-id -> 429: ..."` which looks terrible to investors.

**Why it happens:**
The `BedrockLlmClient.converse()` method concatenates all failure attempts into one error string and throws. The `agent-loop.ts:1173` catch block displays this raw error: `Error: ${(err as Error).message}`. There's also a Cloudflare Worker proxy in the chain (per `llm-client.ts` comments) whose status is unclear -- it might be an extra failure point.

**How to avoid:**
1. Verify the EXACT call chain before the demo: is it CLI -> Bedrock direct, or CLI -> Cloudflare Worker -> Bedrock? Test both paths.
2. Set up fallback model IDs in config (the `fallbackModelIds` array in `LlmClientOptions`).
3. Prepare an offline fallback: pre-generate outputs for the 3-4 key demo commands and have them ready as `.mesh/` artifacts to show if the API goes down.
4. Test Bedrock connectivity 30 minutes before the demo from the exact machine/network you will use.
5. Have a mobile hotspot as backup network.

**Warning signs:**
- `BEDROCK_ENDPOINT` or `AWS_BEARER_TOKEN_BEDROCK` env vars not set or expired.
- Getting 403 "model_not_allowed" errors (means the worker's ALLOWED_MODELS list is wrong).
- Different behavior on WiFi vs. wired connection.

**Phase to address:**
Phase 1 (Infrastructure Verification) -- first thing to validate. Also Phase 3 (prepare offline fallbacks).

---

### Pitfall 5: Spinner/UI Hang Leaves Terminal in Broken State

**What goes wrong:**
An `ora` spinner starts, an exception is thrown before the `finally` block, and the spinner keeps spinning -- or worse, the terminal cursor disappears, stdin echoing is disabled, or the readline interface is left in a broken state. The presenter has to Ctrl+C, which kills the process entirely, and restarting takes 15+ seconds.

**Why it happens:**
The pattern in many handlers is:
```typescript
const spinner = ora(...).start();
try {
  // LLM call that can throw
  spinner.succeed(...);
} catch (e) {
  spinner.fail(...);
}
```
This is correct, but some code paths call `spinner.stop()` inside hooks that may not fire. The readline interface at `agent-loop.ts:1057` is closed after slash commands, but if the command throws before returning `{ wasHandled: true }`, the readline may not close properly. The `runSingleTurn` method at line 1238 also creates an `AbortController` but never auto-aborts on timeout.

**How to avoid:**
1. Test each demo command twice in sequence -- the second run catches state leaks from the first.
2. Learn the recovery shortcut: Ctrl+C should abort the current operation. Verify it works for each command.
3. Have a second terminal window ready with `mesh` already launched as a hot spare.
4. If the terminal looks broken (no cursor, no echo), type `reset` and Enter blindly -- it restores the terminal.

**Warning signs:**
- Spinner spinning with no text updates for more than 30 seconds.
- Terminal not echoing typed characters.
- `ora` warnings in stderr about being called after process exit.

**Phase to address:**
Phase 1 (Command Stabilization) -- audit spinner lifecycle in every demo command.

---

### Pitfall 6: `.mesh/` Directory Missing or Stale Artifacts Shown

**What goes wrong:**
The demo starts in a fresh repo clone (or after `rm -rf .mesh/`), and commands that read from `.mesh/` fail silently or show stale data from a previous session. `/synthesize` reads `.mesh/latest_intent.json` and fails if it does not exist. `/brain` reads `.mesh/project-brain.md`. The dashboard reads `.mesh/dashboard/events.json`. If these files are missing, commands show unhelpful empty output or "No recent structural intent detected."

**Why it happens:**
Commands assume prior state exists. The `runSynthesize` at line 2403 reads `latest_intent.json` -- if absent, the catch block says "No recent structural intent detected" which is confusing. Many tools write to `.mesh/` but there is no "bootstrap" command that creates the full directory structure. `/index` creates some state but not all.

**How to avoid:**
1. Before the demo, run the FULL bootstrap sequence: `/index`, `/distill`, `/twin build`, and one general question. This populates `.mesh/` with all needed state.
2. Do NOT delete `.mesh/` between demo runs.
3. If presenting on a new repo, prepare it the night before by running the full command set.
4. Keep a `.mesh/` backup: `cp -r .mesh .mesh-backup` after a good state.

**Warning signs:**
- `ls .mesh/` shows very few files or missing subdirectories.
- Commands returning "n/a" for all fields.
- Dashboard showing empty graphs or "No events yet."

**Phase to address:**
Phase 2 (Demo Script Preparation) -- create the bootstrap checklist. Phase 3 -- verify on the actual demo machine.

---

### Pitfall 7: JSON.parse Crash on Malformed LLM Response

**What goes wrong:**
The LLM returns malformed JSON (truncated response, markdown-wrapped JSON, or creative formatting). `JSON.parse` throws, and because many parse sites lack try/catch (identified in CONCERNS.md), the agent loop crashes or shows a raw stack trace.

**Why it happens:**
At least 8 `JSON.parse` calls in `agent-loop.ts` lack proper error handling. The streaming parser at `llm-client.ts:197` has a bare `catch {}` (swallows all errors silently), which can cause incomplete tool call data to propagate. The context assembler at line 293 does `JSON.parse(raw.slice(jsonStart))` which fails if there is non-JSON content after the first `{`.

**How to avoid:**
1. Wrap all demo-path JSON.parse calls in try/catch with fallback values.
2. For the 5-6 commands in the demo script, trace which JSON.parse calls they hit and verify those specific paths.
3. If an LLM response looks garbled, `/reset` clears the transcript and prevents the bad response from corrupting future context.

**Warning signs:**
- `SyntaxError: Unexpected token` in the terminal.
- A command that partially works and then dies mid-output.
- Tool results showing `[object Object]` instead of formatted data.

**Phase to address:**
Phase 1 (Critical Bug Fixes) -- add try/catch to the highest-risk JSON.parse sites.

---

### Pitfall 8: Prefix Matching Ambiguity Triggers Wrong Command

**What goes wrong:**
The investor types `/d` intending `/dashboard` but gets `/distill` instead (because `commandList` has `/distill` before `/dashboard`). Or types `/s` and gets `/status` instead of `/sync`. The prefix matching at `agent-loop.ts:3639` returns the first match from `commandList` in declaration order, which is arbitrary.

**Why it happens:**
The `commandList` array at line 3627 defines priority. The prefix matcher filters all commands starting with the typed prefix and returns `matches[0]`. Commands like `/d` match `/dashboard`, `/distill`, `/daemon`, `/doctor`, `/debug` -- the first in the array wins.

**How to avoid:**
1. Always type full command names during the demo.
2. In the demo script, list exact command strings to type.
3. Optionally: reorder `commandList` to put demo-critical commands first within each prefix group.

**Warning signs:**
- A command running that you did not intend.
- "Usage:" help text appearing unexpectedly (triggered the wrong command).

**Phase to address:**
Phase 2 (Demo Script Preparation) -- document exact strings. Low priority fix for the code itself.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `as any` on every tool result | Avoids writing 40+ result type interfaces | Runtime crashes on shape mismatches, invisible during development | During 1-day sprint ONLY -- but add `?.` null chaining on property access |
| Monolithic files (6K+ lines) | All code in one place, easy git blame | Impossible to parallelize work, risky to modify anything | Never in normal dev -- but do NOT refactor during this sprint |
| No tests for any command | Faster development velocity | Every change is a blind gamble; regression is invisible | During sprint -- but compensate with manual testing checklist |
| Bare `catch {}` in streaming parser | Prevents crash on fragmented JSON | Silently drops tool call data, causing tools to run with empty inputs | Acceptable for demo if fallback behavior is verified |
| Sub-agent delegation for `/distill` | Leverages existing agent infrastructure | Doubled LLM latency, doubled failure surface, doubled cost | Run before demo, not during |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| AWS Bedrock | Using model ID directly instead of inference profile ID (causes 400 "on-demand throughput isn't supported") | Use the inference profile ID from `model-catalog.ts`. Check `DEFAULT_MODEL_ID`. |
| Cloudflare Worker proxy | Assuming it is active when it may be down or misconfigured | Verify the endpoint: `curl -X POST $BEDROCK_ENDPOINT/model/$MODEL_ID/converse -H "Content-Type: application/json" -d '{}'` -- expect a 400 (bad request), not 502/504. |
| Dashboard server | Starting the CLI without the dashboard server running, or vice versa | Dashboard reads from `.mesh/dashboard/` files. The dashboard server (`dashboard-server.ts`) must be started separately. Test `/dashboard` command before demo. |
| Git operations in tool backend | Running in a repo with no commits, no `.git/`, or detached HEAD | Pre-verify: `git status` works, HEAD points to a branch, there are at least a few commits for `/replay`, `/bisect`, etc. |
| Xenova transformers (embeddings) | First-use triggers a 500MB model download that hangs the CLI | Pre-load by running `/index` on the demo repo well before the demo. If it hangs, set `MESH_SKIP_EMBEDDINGS=1` (if supported) or accept that embedding commands won't work. |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded transcript/context growth | Each LLM call takes longer; eventually hits token limit and throws "Context firewall" error | Run `/compact` after every 5-6 turns. Run `/reset` between demo sections. | After ~15 turns of tool-heavy interaction |
| File watcher spawning background re-indexing | CPU spikes, terminal becomes sluggish, fan noise during demo | Only relevant if editing files during demo. If not editing, not a risk. | When >10 files change in quick succession |
| Sub-agent spawning during `/distill`, `/synthesize` | Double or triple LLM calls; one sub-agent call means 2+ Bedrock requests | Pre-generate output artifacts. Do not run sub-agent commands live. | Every time -- inherent to the design |
| Dashboard event file growing unbounded | Dashboard becomes slow to load, JSON parse takes seconds | Delete `.mesh/dashboard/events.json` and restart if >1MB. Keep demo sessions short. | After ~50+ events in a session |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Showing `BEDROCK_ENDPOINT` or `AWS_BEARER_TOKEN_BEDROCK` on screen | Investor sees credentials in terminal env output or error messages | Clear terminal before demo. Do NOT run `env` or show `.env` files. Set env vars in shell profile, not inline. |
| LLM error messages leaking internal infrastructure | Error like "LLM request failed: us-east-1.bedrock..." reveals AWS account region and endpoint structure | Wrap LLM errors in user-friendly messages before the demo. Do not fix in code (risky), but know how to handle if it appears. |
| Running destructive commands during demo | `/fix` applies patches, `/ghost` creates branches, tool calls can write files | Use a dedicated demo repo that is disposable. Never demo on a production codebase. |
| Dashboard CORS allowing localhost only | If demo involves showing dashboard on a different machine, it will be blocked | Dashboard server at `dashboard-server.ts:118` validates origin. Run browser on same machine as CLI. |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Command produces output but no `.mesh/` artifact | Investor sees text scroll by but nothing tangible to examine afterward | Verify each demo command writes to `.mesh/`. Show the file after: `ls .mesh/` or open in editor. |
| Raw LLM response with markdown formatting artifacts | Terminal shows `**bold**` or `### heading` as literal text instead of rendered | The system prompt says "No markdown formatting" but LLM may ignore it. Have `/compact` ready to clear and retry. |
| No progress indication during long operations | Investor thinks the tool is frozen | Narrate what the spinner text says. Point out tool execution steps as they appear. |
| Error messages in German mixed with English | The codebase has German strings (`"Kurz: Code lesen, aendern..."`, `"offene probleme"`) that might appear | Use English locale in demo. The `maxStepsForInput` regex matches German terms, which is fine for matching but may leak into error messages. |
| Command does nothing visible, returns silently | Some handlers like `runInspect` just print a static message and return | Test each command. If it only prints a static hint, either skip it in the demo or acknowledge it as a "setup step." |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **`/distill` output:** Often produces output in terminal but the `.mesh/project-brain.md` file is empty or never written -- verify the file exists AND has content after running.
- [ ] **`/twin build` display:** Shows "Digital Twin build complete" success message but all fields display "n/a" because the tool result shape does not match what the handler expects.
- [ ] **`/dashboard` launch:** Says "Dashboard launched" but the browser shows a blank page because `events.json` does not exist or the server process crashed silently.
- [ ] **`/hologram start npm run dev`:** Prints "Injecting telemetry proxy" but the telemetry script path may not exist, causing the child process to fail with no visible error.
- [ ] **`/doctor` output:** May report all-green but individual checks are no-ops or catch-and-swallow errors internally.
- [ ] **Streaming responses:** Text appears to stream but the final answer is empty because `accumulatedText` was never appended to the transcript (streaming path vs. non-streaming path divergence at lines 1276-1367).
- [ ] **`/voice` mode:** Says "Voice mode ON" but ffmpeg/whisper-cpp are not installed, causing silent failure on the next voice input attempt.
- [ ] **`/cost` display:** Shows $0.0000 because `sessionTokens` were not updated (usage field missing from some Bedrock response paths).

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Terminal in broken state (no cursor/echo) | LOW | Type `reset` + Enter blindly. Or Ctrl+C, then `stty sane`, then restart `mesh`. |
| LLM call hanging indefinitely | LOW | Ctrl+C aborts the current operation. The agent loop should catch the abort. Retry with a simpler prompt. |
| Wrong command triggered by prefix | LOW | Let it finish (most commands are quick), then run the correct command with full name. |
| Bedrock API down | MEDIUM | Switch to pre-generated artifacts. Show `.mesh/` files directly. Narrate: "Here's what the tool produced in our last session." |
| Context blown up, every call is slow | LOW | Run `/compact` or `/reset`. Context will be trimmed. Subsequent calls will be fast. |
| `.mesh/` artifacts missing | MEDIUM | Run `/index` then the needed command. Takes 30-60 seconds. Alternatively, restore from `.mesh-backup/`. |
| Dashboard showing stale/empty data | LOW | Restart dashboard server. Run one command to generate fresh events. Refresh browser. |
| Cascading failure after code fix | HIGH | `git stash` to revert to last known good. Rebuild with `npm run build`. Restart `mesh`. Takes 2-3 minutes. |
| Investor asks to try a command not in script | MEDIUM | Stay calm. If the command is known-working, let them try it. If unknown, say "Let me show you [related working command] which demonstrates the same capability." |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Happy Path Illusion (variant inputs crash) | Phase 1: Command Triage | Run every demo command 3 ways: no args, expected args, edge case. All must not crash. |
| LLM Latency kills momentum | Phase 2: Demo Script | Time every demo command. None should take >15s. Pre-generate anything that takes >20s. |
| Last Fix Breaks Everything | Phase 3: Code Freeze | Tag known-good commit. Verify all commands after freeze. No code changes after tag. |
| Bedrock/Network failure | Phase 1: Infrastructure | `curl` test to Bedrock endpoint succeeds. Fallback model IDs configured. Pre-generated offline artifacts ready. |
| Spinner/UI hang | Phase 1: Command Stabilization | Every command tested for clean exit. Ctrl+C tested for each. Second terminal window prepared. |
| `.mesh/` missing or stale | Phase 2: Demo Preparation | Full bootstrap sequence run on demo repo. `.mesh-backup/` snapshot saved. |
| JSON.parse crash | Phase 1: Critical Fixes | Add try/catch to the 8 highest-risk JSON.parse sites in agent-loop.ts. |
| Prefix matching ambiguity | Phase 2: Demo Script | Document exact command strings. Rehearse with exact typing. |

## Demo-Specific Tactical Advice

### The 5-Minute Rule
Investors decide in the first 5 minutes whether this is interesting. Front-load the most impressive, most reliable commands. Save experimental/risky commands for "if we have time."

### The Narration Pattern
When the tool is thinking, narrate: "Right now Mesh is reading the repository structure, identifying the tech stack, and generating a project brain." This turns dead air into engagement.

### The Recovery Script
Memorize this sequence for when things go wrong:
1. Ctrl+C (abort current)
2. `/reset` (clear context)
3. `/clear` (clean screen)
4. Start the demo command again

### The "Two Repos" Strategy
Have two demo repos open in two terminal tabs:
- Tab 1: The primary demo repo (fully bootstrapped)
- Tab 2: A backup repo with pre-generated `.mesh/` state

If Tab 1 breaks, switch to Tab 2 seamlessly.

### Commands to NEVER Run Live (Pre-generate Only)
- `/distill` -- sub-agent call, slow, can fail
- `/synthesize` -- requires prior file edits, fragile
- `/entangle` -- needs a second repo, complex setup
- `/voice` -- requires external dependencies (ffmpeg, whisper)
- `/hologram start` -- telemetry injection, many failure modes

### Commands Safe for Live Demo
- `/help`, `/commands` -- instant, always works
- `/status` -- instant, shows repo info
- `/index` -- fast if already indexed, shows progress
- `/cost` -- instant, shows session economics
- `/dashboard` -- if pre-verified, opens browser
- `/twin build` -- if pre-verified on this repo
- `/doctor` -- if pre-verified, shows health check

## Sources

- Direct codebase analysis of `agent-loop.ts` (4,760 lines), `local-tools.ts` (6,000 lines), `llm-client.ts`, `dashboard-server.ts`
- `.planning/codebase/CONCERNS.md` -- known bugs, fragile areas, security issues
- `.planning/PROJECT.md` -- project constraints and requirements
- Pattern analysis of 40+ slash command handlers in `agent-loop.ts:3615-3865`
- LLM client fallback logic analysis in `llm-client.ts:100-250`
- Domain expertise: AI agent demo failure patterns (live LLM demos, CLI tool presentations)

---
*Pitfalls research for: AI Coding Agent CLI Investor Demo*
*Researched: 2026-04-27*
