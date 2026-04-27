# Architecture Research: Stabilizing Mesh CLI Without Major Refactoring

**Domain:** AI coding agent CLI stabilization
**Researched:** 2026-04-27
**Confidence:** HIGH

## Current System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLI Entry (src/index.ts)                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │           Agent Loop (src/agent-loop.ts, 4700 lines)    │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │    │
│  │  │ Slash Cmd│ │ Turn Exec│ │ Rendering│ │ Voice    │   │    │
│  │  │ Router   │ │ Engine   │ │ Pipeline │ │ Mode     │   │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                             │                                    │
├─────────────────────────────┼────────────────────────────────────┤
│  ┌──────────────┐  ┌────────┴──────┐  ┌────────────────────┐    │
│  │ LLM Client   │  │ Composite     │  │ Context Assembler  │    │
│  │ (Bedrock)    │  │ Tool Backend  │  │ (Token Budget)     │    │
│  │ + Fallbacks  │  │               │  │                    │    │
│  └──────────────┘  └───────┬───────┘  └────────────────────┘    │
│                            │                                     │
├────────────────────────────┼─────────────────────────────────────┤
│  ┌─────────────────────────┴───────────────────────────────┐    │
│  │      Local Tools (src/local-tools.ts, 6000 lines)       │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │    │
│  │  │ Core FS  │ │ Workspace│ │ Moonshot │ │ Agent OS │   │    │
│  │  │ Tools    │ │ Index    │ │ Engines  │ │ Tools    │   │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │    │
│  └─────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ .mesh/   │  │ Sessions │  │ Timelines│  │ Config   │        │
│  │ Artifacts│  │ Capsules │  │ (git wt) │  │          │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Stabilization Risk |
|-----------|----------------|-------------------|
| Agent Loop | Turn orchestration, slash command dispatch, output rendering | HIGH -- single 4700-line file mixes all concerns |
| Local Tools | 80+ tool implementations, moonshot engine delegation | HIGH -- any tool failure cascades into broken commands |
| LLM Client | Bedrock API calls, model fallback chain, streaming | MEDIUM -- has fallback chain but error messages leak to UI |
| Context Assembler | Token budgeting, history trimming | LOW -- well-isolated, defensive |
| Composite Backend | Tool routing across backends | LOW -- thin delegation layer |
| Command Safety | Destructive command blocking | LOW -- stateless, well-tested pattern |

## Stabilization Patterns (No Refactoring Required)

### Pattern 1: Defensive Slash Command Wrapping

**What:** Wrap every slash command handler in a uniform try/catch/finally that guarantees the spinner stops and the user always sees a meaningful message, never a raw stack trace.

**When to use:** Every slash command handler in `handleSlashCommand()`. Currently, most handlers like `runDigitalTwin`, `runPredictiveRepair`, `runIndexing` have their own try/catch, but the patterns are inconsistent. Some catch-blocks show raw `Error.message` which may contain internal details.

**Trade-offs:** Slightly more boilerplate. Worth it for demo reliability.

**Current problem (from codebase):**
```typescript
// agent-loop.ts line 2556 -- raw error message exposed
} catch (error) {
  spinner.fail(pc.red(`Digital Twin failed: ${(error as Error).message}`));
}
```

**Stabilized pattern:**
```typescript
private async runSlashCommandSafe(
  label: string,
  fn: (spinner: ReturnType<typeof ora>) => Promise<void>
): Promise<void> {
  const spinner = ora({ text: `${label}...`, color: "cyan" }).start();
  try {
    await fn(spinner);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Classify error for user-friendly display
    if (msg.includes("LLM request failed")) {
      spinner.fail(pc.red(`${label}: LLM backend unavailable. Check /doctor for connectivity.`));
    } else if (msg.includes("Tool not found")) {
      spinner.fail(pc.red(`${label}: Required tool unavailable in current mode.`));
    } else if (msg.includes("Context firewall")) {
      spinner.fail(pc.red(`${label}: Context too large. Run /compact first.`));
    } else {
      spinner.fail(pc.red(`${label} failed: ${msg.slice(0, 200)}`));
    }
  }
}
```

**Implementation:** Add this one helper method to `AgentLoop`, then update each slash command to use it. This is a ~50-line change, not a refactor.

### Pattern 2: Tool Execution Circuit Breaker

**What:** The codebase already tracks `consecutiveErrors` per tool signature (agent-loop.ts line 1514-1521). Extend this to provide the LLM with a clearer "stop retrying" signal after 2 failures of the same tool, and surface which tools are broken to the user via `/doctor`.

**When to use:** Already partially implemented. The enhancement is making the error tracking accessible to `/doctor` for demo diagnostics.

**Trade-offs:** None. This is additive.

**Current state (from codebase):**
```typescript
// agent-loop.ts line 1515-1521
const errorCount = (this.consecutiveErrors.get(errorKey) || 0) + 1;
this.consecutiveErrors.set(errorKey, errorCount);
let resultText = `Tool execution failed: ${errorMsg}`;
if (errorCount >= 2) {
  resultText += "\n\n[MESH SYSTEM WARNING] This exact error has occurred...";
}
```

**Enhancement:**
```typescript
// Add to /doctor output
private getToolHealthSummary(): string[] {
  if (this.consecutiveErrors.size === 0) return ["All tools healthy"];
  return Array.from(this.consecutiveErrors.entries())
    .filter(([_, count]) => count >= 2)
    .map(([key, count]) => `${key.split(" -> ")[0]}: ${count} consecutive failures`);
}
```

### Pattern 3: LLM Response Sanitization Pipeline

**What:** A post-processing pipeline for LLM text responses that strips formatting artifacts before rendering. The PROJECT.md notes "LLM responses have formatting artifacts" and "weird characters" as an active problem.

**When to use:** Applied once in the `renderAssistantTurn` method (agent-loop.ts line 3420) and in `forceFinalAnswer` (line 1589).

**Trade-offs:** Minor latency (regex passes). Essential for demo polish.

**Implementation:**
```typescript
private sanitizeLlmOutput(text: string): string {
  let clean = text;
  // Strip common LLM artifacts
  clean = clean.replace(/[​-‍﻿]/g, ""); // zero-width chars
  clean = clean.replace(/ /g, " ");                 // non-breaking spaces
  clean = clean.replace(/\\n/g, "\n");                    // escaped newlines in raw text
  clean = clean.replace(/```\s*```/g, "");                // empty code blocks
  clean = clean.replace(/\n{4,}/g, "\n\n\n");             // excessive blank lines
  // Strip thinking tags that leak into output
  clean = clean.replace(/<thought>[\s\S]*?<\/thought>/g, "");
  return clean.trim();
}
```

### Pattern 4: Graceful Degradation for Missing Dependencies

**What:** Many moonshot engines import heavy dependencies (tree-sitter, transformers, Xenova models). When these are missing, the tool should return a clear "not available" message rather than throwing an unhandled import error.

**When to use:** Every moonshot engine constructor and the `VectorManager.getModel()` (local-tools.ts line 12-42).

**Current state:** `VectorManager` already does this correctly -- returns `null` on failure. But individual moonshot engines may throw on construction.

**Implementation pattern:**
```typescript
// In local-tools.ts callTool, wrap moonshot calls
case "workspace.precrime":
  try {
    return await this.precrime.run(args);
  } catch (err) {
    if ((err as Error).message?.includes("Cannot find module")) {
      return { error: "Precrime engine unavailable: missing dependency. Run npm install." };
    }
    throw err;
  }
```

### Pattern 5: Output Artifact Guarantee

**What:** Every slash command that does meaningful work should write a `.mesh/` artifact, even if the command partially fails. The PROJECT.md is explicit: "Command results persist as files in .mesh/ (not just chat output)."

**When to use:** All slash commands that produce analysis results.

**Trade-offs:** More disk writes. Essential for investor demo ("show me the output").

**Implementation pattern:**
```typescript
// After each slash command produces a result, persist it
private async persistCommandArtifact(
  command: string,
  result: unknown,
  status: "success" | "partial" | "error"
): Promise<string> {
  const dir = path.join(this.config.agent.workspaceRoot, ".mesh", "commands");
  await fs.mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `${command.replace("/", "")}-${timestamp}.json`);
  await fs.writeFile(filePath, JSON.stringify({
    command, status, timestamp: new Date().toISOString(),
    result: typeof result === "string" ? result : result
  }, null, 2), "utf8");
  return filePath;
}
```

### Pattern 6: Streaming Fallback Chain

**What:** The LLM client already implements a streaming-to-non-streaming fallback (agent-loop.ts line 1322-1347), setting `this.streamingUnavailable = true` when streaming fails. This is good. The stabilization is to make this happen silently (no user-visible error flash).

**Current state:** Already implemented. The `isStreamingEndpointUnavailable` check catches streaming failures and falls back to `converse()`. No changes needed here.

**Assessment:** This pattern is already correctly implemented.

### Pattern 7: Timeout Guards for Tool Execution

**What:** Long-running tools (workspace.run_command, workspace.ask_codebase with large repos, moonshot engines) can hang indefinitely. Add timeout wrappers to prevent demo freezes.

**When to use:** Any tool that shells out or does heavy computation.

**Implementation:**
```typescript
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// Usage in callTool:
case "workspace.run_command":
  return withTimeout(this.runCommand(args, opts?.onProgress), 30_000, "run_command");
```

## Data Flow: Stabilized Turn Execution

```
[User Input]
    |
    v
[tryLocalIntentAnswer] --> quick answer (no LLM call)
    |                       if matched
    v (not matched)
[handleSlashCommand] --> [runSlashCommandSafe wrapper]
    |                         |
    |                    try { handler(spinner) }
    |                    catch { user-friendly error + persist artifact }
    |                    finally { spinner.stop() }
    |
    v (not slash command)
[runSingleTurn]
    |
    +--> [prepareModelInput] --> ContextAssembler.assemble()
    |         |
    |         +--> [Context firewall check] -- reject if over token limit
    |
    +--> [LLM call] --> streaming with fallback to non-streaming
    |         |
    |         +--> [Model fallback chain] if primary fails
    |
    +--> [Tool execution loop]
    |         |
    |         +--> [Duplicate detection] (seenToolSignatures)
    |         +--> [Family budget] (read: 4, search: 3, action: 2)
    |         +--> [Approval gate] if requiresApproval
    |         +--> [Circuit breaker] consecutiveErrors tracking
    |         +--> [Fact verification pre-flight] for write ops
    |
    +--> [forceFinalAnswer] if tool budget exhausted
    |
    v
[sanitizeLlmOutput] --> [renderAssistantTurn] --> [persistCommandArtifact]
```

## Suggested Fix Order (Dependency-Aware)

The fixes below are ordered so that each builds on the previous. This is critical for a 1-day sprint.

### Phase 1: Foundation (Do First -- 1 hour)

**Fix 1.1: LLM response sanitization**
- Location: `agent-loop.ts` `renderAssistantTurn()` (line 3420)
- Why first: Every subsequent fix produces output that benefits from clean rendering
- Dependencies: None
- Effort: ~15 minutes

**Fix 1.2: Defensive slash command wrapper**
- Location: `agent-loop.ts` new `runSlashCommandSafe()` method
- Why second: Prevents any slash command from crashing the REPL
- Dependencies: None
- Effort: ~30 minutes (add wrapper + update ~25 slash command cases)

**Fix 1.3: Error message classification**
- Location: Inside `runSlashCommandSafe()`
- Why: Transforms cryptic LLM/network errors into user-friendly messages
- Dependencies: Fix 1.2
- Effort: ~15 minutes

### Phase 2: Command Reliability (Do Second -- 2 hours)

**Fix 2.1: Audit every slash command for try/catch coverage**
- Location: Each `run*` method in `agent-loop.ts`
- Why: Some handlers may not have try/catch at all
- Dependencies: Fix 1.2 (wrapper available)
- Effort: ~30 minutes

**Fix 2.2: Timeout guards for tool execution**
- Location: `local-tools.ts` `callTool()` (line 2010)
- Why: Prevents demo-killing hangs on slow tools
- Dependencies: None (can parallelize with 2.1)
- Effort: ~20 minutes

**Fix 2.3: Graceful degradation for moonshot engines**
- Location: `local-tools.ts` moonshot cases in `callTool()`
- Why: Moonshot engines with missing deps should degrade, not crash
- Dependencies: None
- Effort: ~30 minutes

**Fix 2.4: Tool health reporting in /doctor**
- Location: `agent-loop.ts` `runDoctor()` (line 4242)
- Why: Demo diagnostic -- quickly see what is broken
- Dependencies: Fix 2.1 (errors being tracked)
- Effort: ~20 minutes

### Phase 3: Output Polish (Do Third -- 1.5 hours)

**Fix 3.1: Artifact persistence for slash commands**
- Location: `agent-loop.ts` new `persistCommandArtifact()` method
- Why: Investors need to see `.mesh/` files proving work was done
- Dependencies: Fix 1.2 (wrapper provides clean entry point)
- Effort: ~30 minutes

**Fix 3.2: Dashboard artifact visibility**
- Location: Dashboard server code (contextual)
- Why: Dashboard should reflect command results
- Dependencies: Fix 3.1 (artifacts exist to display)
- Effort: ~30 minutes

**Fix 3.3: Output formatting consistency**
- Location: `renderAssistantTurn`, `renderToolEvent`, `renderSystemMessage`
- Why: Polish -- consistent prefix styling, no raw objects in output
- Dependencies: Fix 1.1 (sanitization in place)
- Effort: ~30 minutes

### Phase 4: Verification (Do Last -- 30 minutes)

**Fix 4.1: Run every slash command once**
- Manual verification sweep
- Dependencies: All prior fixes
- Effort: ~30 minutes

## Anti-Patterns to Avoid During Stabilization

### Anti-Pattern 1: Extracting Modules Under Deadline

**What people do:** See the 4700-line agent-loop.ts and immediately want to split it into modules.
**Why it is wrong:** Module extraction changes import graphs, call patterns, and state sharing. In a monolith, internal state is accessed directly. Splitting it requires designing interfaces. This is multi-day work disguised as "quick cleanup."
**Do this instead:** Add wrapper methods *inside* the existing file. A new private method on the same class costs zero architectural risk.

### Anti-Pattern 2: Adding Retry Loops to LLM Calls

**What people do:** Wrap `llm.converse()` in a retry loop with exponential backoff.
**Why it is wrong:** The LLM client already has a model fallback chain (primary -> fallback[0] -> fallback[1]). Adding retries on top creates retry-of-fallback-of-retry behavior that can burn through API quota and add 30+ second delays.
**Do this instead:** Trust the existing fallback chain. If all models fail, surface a clean error.

### Anti-Pattern 3: Catching and Silencing Errors

**What people do:** Add `catch(() => {})` or `catch(() => null)` everywhere to prevent crashes.
**Why it is wrong:** The codebase already has some of this (e.g., `.catch(() => null)` on trace_symbol calls). Broad silencing hides real problems. During a demo, an undiagnosed silent failure is worse than a caught-and-displayed error.
**Do this instead:** Catch, classify, display, and persist. Every error should produce a visible (but polished) message.

### Anti-Pattern 4: Disabling Features to Prevent Failures

**What people do:** Comment out broken moonshot commands to prevent them from appearing.
**Why it is wrong:** Reduces the feature surface for the demo. The slash commands themselves are value propositions.
**Do this instead:** Let commands exist but degrade gracefully. "/precrime" that says "Index not ready, run /index first" is better than no /precrime at all.

## Integration Points

### LLM Backend (Bedrock via Worker/Direct)

| Concern | Current State | Stabilization Action |
|---------|---------------|---------------------|
| Connection failure | Falls back through model chain | Ensure error message is user-friendly, not raw HTTP status |
| Streaming failure | Falls back to non-streaming (already works) | No change needed |
| Token overflow | Context firewall rejects (line 1577) | Ensure error message says "run /compact" |
| Slow response | No timeout | Add 60-second timeout on LLM calls |

### Tool Backend (Local + MCP)

| Concern | Current State | Stabilization Action |
|---------|---------------|---------------------|
| Tool not found | Returns error status (line 1439) | Already good |
| Tool throws | Caught, tracked in consecutiveErrors | Enhance error classification |
| Tool hangs | No timeout | Add per-tool timeout (30s default) |
| Validation failure | ToolInputValidationError thrown | Already caught in callTool() |

### .mesh/ Artifact Storage

| Concern | Current State | Stabilization Action |
|---------|---------------|---------------------|
| Directory missing | Some commands create with `mkdir -p` | Ensure ALL commands create dir first |
| Write failure | Inconsistent handling | Wrap in try/catch, do not fail the command |
| Dashboard sync | Unclear if dashboard reads new artifacts | Verify dashboard file watcher covers .mesh/commands/ |

## Scaling Considerations

Not relevant for stabilization sprint, but noted for post-demo:

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 user (demo) | Current architecture is fine. Focus on reliability. |
| 10 users (beta) | Split agent-loop.ts into turn-engine, slash-commands, rendering modules |
| 100+ users | Extract local-tools.ts into per-domain tool backends, add proper test suite |

## Sources

- Direct codebase analysis of `src/agent-loop.ts` (4700 lines), `src/local-tools.ts` (6000 lines), `src/llm-client.ts`, `src/composite-backend.ts`, `src/context-assembler.ts`, `src/command-safety.ts`, `src/tool-schema.ts`
- `.planning/PROJECT.md` for requirements and constraints
- `.planning/codebase/ARCHITECTURE.md` for existing architecture documentation
- Pattern confidence: HIGH -- all recommendations are based on patterns already partially present in the codebase

---
*Architecture research for: Mesh CLI stabilization sprint*
*Researched: 2026-04-27*
