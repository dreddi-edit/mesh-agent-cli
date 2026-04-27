# Project Research Summary

**Project:** Mesh CLI -- Investor-Readiness Sprint
**Domain:** AI coding agent CLI (terminal-first, moonshot engines, Bedrock/Claude backend)
**Researched:** 2026-04-27
**Confidence:** HIGH

## Executive Summary

Mesh is a feature-complete AI coding agent CLI with ~40 slash commands, moonshot intelligence engines (tribunal, sheriff, causal, precrime, ghost, fork, hologram), and a `.mesh/` artifact persistence layer that no direct competitor matches. The stack (TypeScript/Node.js, Bedrock Converse via Cloudflare Worker proxy, ora/picocolors/marked-terminal) is sound and should not be changed. The problem is entirely in how the stack is used: no retry logic on LLM calls, inconsistent error handling across slash command handlers, raw LLM output piped directly to the markdown renderer, scattered `fs.writeFile` calls that can corrupt or skip artifacts, and missing `.mesh/` state that causes commands to return confusing empty output.

The investor-readiness gap is not a missing feature — it is a reliability and polish gap. Investors in this space have used Claude Code, Aider, and Cursor. They will know immediately when output is garbled, when a command silently fails, or when a spinner hangs. A single raw stack trace or `Cannot read properties of undefined` error during a live demo shifts the conversation from "exciting product" to "can this team ship?" The highest-ROI work is: (1) wrapping every slash command handler in a uniform try/catch/finally that guarantees a clean error message and stopped spinner, (2) sanitizing LLM output before rendering, (3) adding exponential backoff and timeouts to the LLM client, and (4) ensuring every command writes a valid `.mesh/` artifact.

Mesh's genuine differentiators — `/tribunal` (multi-AI debate), `/sheriff` (semantic fingerprinting), `/causal` (dependency graphs), `/precrime` (predictive bug analysis) — are novel and visually compelling. No competitor has these. But they only land if the baseline (startup, `/status`, `/index`, file editing, clean output) works flawlessly. The sprint strategy is: harden the foundation first, then verify differentiators, then freeze code and rehearse. Demo only 5-7 commands in a narrative arc; breadth without reliability is a liability.

---

## Key Findings

### Recommended Stack

The existing stack requires zero new dependencies. All fixes are internal. The critical hardening targets are the custom `llm-client.ts` (no retry, no timeout, wrong `cache_control` format for Bedrock), the `renderAssistantTurn` method (raw LLM output passed to `marked.parse()` without sanitization), and the scattered artifact write patterns (inconsistent `mkdir`, no atomic writes, no artifact manifest).

**Core technologies — assessment:**
- **TypeScript 5.3.3 / Node.js LTS:** Solid. Do not upgrade during sprint.
- **ora ^7.0.1 (spinners):** Correct choice. Fix: ensure every handler has `spinner.stop()` in `finally`.
- **picocolors ^1.0.0 (colors):** Zero-dep, already used. No changes needed.
- **marked ^11.0.1 + marked-terminal ^6.2.0:** Keep. Fix: sanitize LLM output before passing to `marked.parse()`.
- **Custom Bedrock LLM client:** Keep. Fix: add exponential backoff (~15 lines), `AbortSignal.timeout()` (5 lines), fix `/converse-stream` worker route (~10 lines).
- **Cloudflare Worker proxy:** Missing `/converse-stream` route — streaming always falls back to non-streaming for proxied users. Quick fix during Phase 1.
- **`.mesh/` artifact writes:** Consolidate into atomic write utility (~20 lines). No new dependency needed.

**Do NOT add:** `@aws-sdk/client-bedrock-runtime` (50+ transitive deps), `ink` (full TUI rewrite), `p-retry`, `write-file-atomic`, `@hapi/boom`. All required fixes are under 20 lines each and require no new packages.

### Expected Features

The AI coding agent CLI market has set clear investor expectations. Mesh has all table-stakes features implemented; the issue is reliability and output quality, not feature gaps.

**Must have (P0 — demo blockers, all exist, need polish):**
- CLI starts cleanly with no errors or warnings
- `/status` shows system state clearly
- `/index` completes with progress and writes `.mesh/` artifacts
- Natural language code Q&A returns codebase-specific answers (not generic)
- File editing via agent shows correct diffs
- `/cost` shows token usage and estimated cost
- Clean output formatting — no escape characters, no raw markdown tokens, no `[object Object]`
- Error handling everywhere — no unhandled exceptions, no raw stack traces

**Should have (P1 — Mesh's differentiators, demo enhancers):**
- `/tribunal <problem>` — multi-AI debate, artifact saved to `.mesh/tribunal/`
- `/sheriff scan` + `/sheriff verify` — semantic fingerprinting with drift detection
- `/dashboard` — opens in browser, shows real `.mesh/` data
- `/capsule show` — session memory proof
- `/doctor` — health diagnostics with real checks (not no-op green lights)
- `/undo` — safety net signal
- `/model list` — model flexibility signal

**Defer (P2/P3 — not for this demo):**
- `/voice` — external dep chain (ffmpeg, whisper, piper) is high failure risk
- `/hologram` — V8 telemetry injection, too many failure modes
- `/chatops`, `/production`, `/issues`, `/entangle` — require external services
- `/distill`, `/synthesize` — sub-agent calls: slow, double failure surface; pre-generate only, never run live

**Anti-features to suppress:**
- Running 40+ commands as a feature dump — overwhelms investors and reveals shallow implementations
- Any command not verified end-to-end on the demo machine
- Raw LLM responses with visible `<thought>` tags or literal markdown syntax

### Architecture Approach

The architecture is a monolith with a 4,760-line `agent-loop.ts` and a 6,000-line `local-tools.ts`. This must NOT be refactored during the sprint — module extraction requires designing interfaces and is multi-day work disguised as cleanup. All stabilization work must be additive: new private methods on existing classes, new wrapper utilities in separate files, null-coalescing guards on existing property accesses.

**Major components and stabilization actions:**

1. **Agent Loop (`agent-loop.ts`)** — Add `runSlashCommandSafe()` wrapper method; add `sanitizeLlmOutput()` before `marked.parse()`; add `persistCommandArtifact()` after each command; audit all 40+ slash command handlers for consistent try/catch/finally.
2. **LLM Client (`llm-client.ts`)** — Add `fetchWithRetry()` with exponential backoff for 429/408/5xx; add `AbortSignal.timeout()` wrapper; add `/converse-stream` route to worker proxy.
3. **Local Tools (`local-tools.ts`)** — Add per-tool timeout via `withTimeout()` wrapper (especially `run_command` and moonshot engines); add graceful degradation for moonshot engine missing-dependency errors.
4. **Artifact Layer (`.mesh/`)** — Create `src/artifact-writer.ts` with atomic write (temp+rename pattern); add artifact manifest entry after each command write; verify dashboard file watcher covers `.mesh/commands/`.
5. **Context Assembler** — Already well-isolated and defensive. No changes needed.

**Data flow (stabilized):** User input → `runSlashCommandSafe` wrapper → handler → `sanitizeLlmOutput` → `renderAssistantTurn` → `persistCommandArtifact`. Every path through this flow must stop the spinner and show a user-friendly message, even on failure.

### Critical Pitfalls

1. **Happy Path Illusion — commands crash on variant inputs** — The 68+ `as any` casts in `agent-loop.ts` cause `Cannot read properties of undefined` when a tool returns a different shape than expected. Prevention: add `?.` null-coalescing guards on every property access in command handlers; test each demo command with no args, expected args, and against a bare repo with no prior `.mesh/` state.

2. **LLM latency kills demo momentum** — Bedrock calls take 5-30s per turn. Context grows unbounded across a session, making each successive call slower. Sub-agent commands (`/distill`, `/synthesize`) double the latency and failure surface. Prevention: pre-generate artifacts for slow commands before the demo; run `/compact` every 5-6 turns; narrate spinner text to fill silence; add 60-second hard timeout on LLM calls.

3. **Last fix breaks everything** — `agent-loop.ts` and `local-tools.ts` are monoliths with no tests; any change can break unrelated commands via shared state. Prevention: freeze code at least 3 hours before demo; tag the known-good commit; after any change, test ALL demo-critical commands, not just the one fixed; if a command cannot be fixed in 30 minutes, remove it from the demo script.

4. **Bedrock/network failure during live demo** — The current raw error surface (`LLM request failed after 2 attempt(s): ...`) leaks internal infrastructure detail. The Cloudflare Worker proxy is an extra failure point. Prevention: verify the exact call chain before demo; configure fallback model IDs; pre-generate artifacts for 3-4 key commands as offline fallback; test connectivity 30 minutes before demo from the exact machine and network.

5. **`.mesh/` missing or stale artifacts** — Commands like `/synthesize`, `/twin`, and `/brain` read from `.mesh/` files that only exist after prior commands. If `.mesh/` is empty (fresh clone, accidental deletion), they return confusing empty output. Prevention: run the full bootstrap sequence the night before (index → distill → twin build → one general question); keep a `.mesh-backup/` snapshot; never run `rm -rf .mesh/` between demo sessions.

6. **JSON.parse crash on malformed LLM response** — At least 8 unguarded `JSON.parse` calls in `agent-loop.ts`. When the LLM returns truncated or markdown-wrapped JSON, the agent loop crashes with `SyntaxError: Unexpected token`. Prevention: wrap all demo-path `JSON.parse` calls in try/catch with fallback values.

7. **Spinner/UI hang leaves terminal broken** — If an exception is thrown before the `finally` block, ora keeps spinning and the terminal may lose cursor echo. Prevention: use `finally { spinner.stop() }` in every handler; learn `reset` command for terminal recovery; keep a second terminal window with mesh pre-launched as a hot spare.

---

## Implications for Roadmap

The sprint is 1 day (27 April 2026, deadline: 28 April evening). The dependency ordering is strict: output sanitization enables clean rendering of everything downstream; the slash command wrapper prevents crashes across all commands; artifact persistence enables the dashboard; demo script preparation depends on a stable codebase.

### Phase 1: Foundation Hardening (do first, ~3 hours)

**Rationale:** These are horizontal fixes — each one benefits every subsequent command at once. Sanitization must come before any command is tested. The slash command wrapper must exist before command-specific fixes are applied. LLM reliability must be proven before demo rehearsal begins.

**Delivers:** A baseline where no command crashes the REPL, LLM output renders cleanly, and transient Bedrock errors are handled gracefully.

**Implements:**
- `sanitizeLlmOutput()` in `renderAssistantTurn` — strip `<thought>` blocks, zero-width chars, escaped newlines, excessive blank lines
- `runSlashCommandSafe()` wrapper method with error classification and guaranteed `finally { spinner.stop() }`
- `fetchWithRetry()` with exponential backoff (3 retries, 429/408/5xx) + `AbortSignal.timeout(60s)` in `llm-client.ts`
- `/converse-stream` route added to Cloudflare Worker proxy (~10 lines)
- Atomic artifact writer in `src/artifact-writer.ts` (temp+rename pattern, ~20 lines)
- Try/catch added to the 8 highest-risk `JSON.parse` call sites in `agent-loop.ts`

**Avoids:** Pitfall 5 (spinner hang — wrapper uses `finally`); Pitfall 6 (JSON.parse crash — guarded parse); Pitfall 4 (raw Bedrock error messages — error classification in wrapper).

**Research flag:** Standard patterns. No additional research needed — all implementations are documented in STACK.md and ARCHITECTURE.md with concrete code examples.

### Phase 2: Command Reliability Audit (do second, ~3 hours)

**Rationale:** With the wrapper in place, this phase is mechanical: run every P0/P1 command, identify what breaks, fix using the wrapper and null-guard pattern. The dependency order within this phase: fix the command, verify its artifact writes, verify its spinner stops cleanly.

**Delivers:** Every P0 and P1 command runs end-to-end without crashing. Each command writes a valid `.mesh/` artifact. `/doctor` reports real health status (not no-op green lights).

**Implements:**
- Apply `runSlashCommandSafe()` to all 40+ slash command cases in the switch statement
- Add null-coalescing guards (`?.` and `?? "n/a"`) to all tool result property accesses in command handlers
- Add `withTimeout()` wrapper (30s default) to `run_command` and moonshot engine calls in `callTool()`
- Graceful degradation for moonshot engines with missing dependencies (return clear "not available" message, not a crash)
- `persistCommandArtifact()` added to each command handler after the result is produced
- `/doctor` enhanced with `getToolHealthSummary()` — surfaces `consecutiveErrors` tracking already in codebase
- Full bootstrap sequence verified on demo repo (index → distill → twin build → general Q)

**Avoids:** Pitfall 1 (Happy Path Illusion — null guards and try/catch coverage); Pitfall 6 (`.mesh/` missing — bootstrap sequence documented and run).

**Research flag:** No additional research needed. All patterns are already partially present in the codebase as described in ARCHITECTURE.md.

### Phase 3: Output Polish and Dashboard (do third, ~2 hours)

**Rationale:** With commands working correctly, this phase makes them look professional. The dashboard is a powerful visual proof mechanism unique to Mesh among CLI tools, but is only worth demonstrating if it displays real data — which requires Phase 2's artifact persistence to work first.

**Delivers:** Clean, consistent terminal output across all demo commands. Dashboard loads in under 3 seconds with real `.mesh/` data. Token costs display correctly. The "polished product" visual impression that distinguishes Mesh from a prototype.

**Implements:**
- Output formatting consistency: consistent prefix styling in `renderAssistantTurn`, `renderToolEvent`, `renderSystemMessage`; no `[object Object]`; code blocks with language labels; no raw markdown tokens visible
- Dashboard artifact visibility: verify file watcher covers `.mesh/commands/`; no "undefined" or "null" visible in dashboard UI
- `/cost` fix: verify `sessionTokens` updated on ALL Bedrock response paths (streaming and non-streaming diverge at lines 1276-1367)
- Worker rate limit increase: `RATE_LIMIT_PER_MIN` 30 → 60 for rapid demo command sequences
- `BEDROCK_MAX_TOKENS` override to 8,000 for slash commands (prevent truncated analysis output)

**Avoids:** Anti-feature (raw formatting artifacts visible to investors); Pitfall 2 (latency — verify context size stays bounded; add explicit `/compact` usage to demo script).

**Research flag:** Dashboard implementation may need a quick audit of `dashboard-server.ts` file watcher configuration to confirm it picks up `.mesh/commands/` artifacts. Otherwise standard patterns apply.

### Phase 4: Code Freeze and Demo Rehearsal (do last, ~2 hours)

**Rationale:** After Phase 3, no more code changes. This phase is verification and rehearsal only. The goal is finding remaining issues with enough time to either fix them (if small and low-risk) or remove them from the demo script (if risky). The code freeze is not optional — Pitfall 3 (Last Fix Breaks Everything) is the most likely way a demo dies.

**Delivers:** A tagged known-good git commit. A verified 5-7 command demo script in a narrative arc. Pre-generated `.mesh/` artifacts for slow/risky commands. A `.mesh-backup/` snapshot. Recovery procedures memorized.

**Implements:**
- Run every P0 and P1 command three ways on demo repo: no args, expected args, bare repo state
- Time every demo command (target: under 15 seconds; pre-generate anything over 20 seconds)
- Pre-generate `/distill` and `/synthesize` artifacts before demo
- Run full bootstrap sequence on the actual demo repo (not a test repo)
- Create `.mesh-backup/` snapshot after good state achieved
- Tag known-good commit: `git tag demo-ready-$(date +%Y%m%d)`
- Prepare two terminal windows (primary demo repo + backup repo with pre-generated state)
- Verify Bedrock connectivity from demo machine and network 30 minutes before start
- Rehearse the golden path twice end-to-end

**Avoids:** Pitfall 3 (code freeze prevents cascade failures); Pitfall 2 (timing commands eliminates latency surprises); Pitfall 4 (connectivity pre-check eliminates network failure surprises).

**Research flag:** No research needed. This is operational preparation.

### Phase Ordering Rationale

- Phase 1 before Phase 2: Sanitization and the wrapper must exist before testing individual commands. Testing without them produces noisy failures that mask the real issues.
- Phase 2 before Phase 3: Artifact persistence (Phase 2) is a prerequisite for the dashboard (Phase 3). A dashboard with empty `.mesh/` is worse than no dashboard.
- Phase 3 before Phase 4: Polish must be complete before freezing. The freeze is permanent — no polish changes after tagging.
- Code freeze at 3+ hours before demo deadline: non-negotiable. Allows time to discover and recover from freeze-state issues before the actual demo.

### Golden Demo Path (Recommended Investor Narrative)

| Step | Command | What It Proves | Risk |
|------|---------|---------------|------|
| 1 | Launch + `/status` | Tool works, professional UI, fast startup | LOW |
| 2 | `/index` | Codebase intelligence, visible progress | LOW if pre-indexed |
| 3 | Natural language Q about the codebase | Context-aware AI, not a generic chatbot | MEDIUM |
| 4 | Ask agent to make a code change | "Can it actually code?" | MEDIUM |
| 5 | `/tribunal "microservices vs monolith?"` | Unique differentiator — multi-AI debate | LOW (self-contained) |
| 6 | `/sheriff scan` + `/sheriff verify` | Novel semantic fingerprinting — no competitor has this | MEDIUM |
| 7 | `/dashboard` | Visual proof layer — `.mesh/` artifacts visible | MEDIUM if pre-verified |
| 8 | `/cost` | Transparency — investors appreciate cost visibility | LOW |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations based on direct codebase analysis at specific line numbers. No guesswork. |
| Features | HIGH | Table stakes verified against Claude Code/Aider/Cursor/Cline. Differentiators verified by reading engine implementations in `local-tools.ts`. |
| Architecture | HIGH | All patterns already partially present in codebase. Recommendations extend existing patterns, do not introduce new ones. |
| Pitfalls | HIGH | Derived from direct analysis of `CONCERNS.md`, specific line numbers in `agent-loop.ts`, and verified failure modes in the LLM client. |

**Overall confidence:** HIGH

### Gaps to Address

- **`cache_control` format mismatch (MEDIUM):** Mesh uses Anthropic direct API `cache_control: { type: "ephemeral" }` format but routes through Bedrock which expects `cachePoint: { type: "default" }`. Impact through the Cloudflare Worker proxy is unclear — it may silently ignore these fields or cause validation errors. Verify during Phase 1: check Bedrock responses for cache-related warnings; compare token counts with and without the fields. If ignored, skip the fix. If causing 400 errors, fix the format.

- **Streaming vs. non-streaming path divergence (MEDIUM):** PITFALLS.md flags that `accumulatedText` may not be appended to the transcript on the streaming path (lines 1276-1367), causing empty final answers. Verify during Phase 2 by testing commands on both paths. Fix if confirmed.

- **`/doctor` check depth (MEDIUM):** PITFALLS.md flags that `/doctor` may report all-green when individual checks are no-ops. The exact implementation of each diagnostic check in `runDoctor()` needs to be audited during Phase 2 before relying on it in the demo.

- **Xenova transformers first-use download:** If the demo repo has not been indexed before, the first `/index` run may trigger a ~500MB model download that hangs the CLI silently. Run `/index` on the actual demo repo the night before (not morning of) to ensure this is pre-cached.

---

## Sources

### Primary (HIGH confidence)
- Codebase: `src/agent-loop.ts` (4,760 lines) — slash command handlers, rendering pipeline, error patterns
- Codebase: `src/local-tools.ts` (6,000 lines) — tool implementations, moonshot engine delegates
- Codebase: `src/llm-client.ts` (~380 lines) — Bedrock client, streaming, fallback chain
- Codebase: `worker/src/index.ts` (175 lines) — Cloudflare Worker proxy, routing gaps
- Codebase: `src/context-assembler.ts` — token budgeting, context firewall
- AWS Bedrock Converse API official docs — retry codes, `cachePoint` vs `cache_control` format, inference profiles
- `.planning/codebase/CONCERNS.md` — known bugs, fragile areas, security issues
- `.planning/PROJECT.md` — project constraints and requirements

### Secondary (MEDIUM confidence)
- Claude Code (anthropic.com/claude-code) — table stakes feature baseline for investor expectations
- Aider (aider.chat) — feature comparison, repo-map pattern
- Cursor (cursor.com) — IDE-bound feature comparison
- Cline (github.com/cline/cline) — VSCode sidebar comparison

### Tertiary (LOW confidence)
- Investor demo failure pattern analysis — domain heuristics about live LLM demo failure modes; not validated against this specific investor audience

---
*Research completed: 2026-04-27*
*Ready for roadmap: yes*
