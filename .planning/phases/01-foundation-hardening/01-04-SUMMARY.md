---
phase: 01-foundation-hardening
plan: "04"
subsystem: error-handling
tags: [error-handling, json-parse, slash-commands, llm-endpoint, agent-loop]

# Dependency graph
requires: ["01-02", "01-03"]
provides:
  - "runSlashCommandSafe() private method on AgentLoop (src/agent-loop.ts line 2565)"
  - "JSON.parse wraps at lines 734, 879, 2416 (package.json, ghost styles, intent file)"
  - "Tool error format updated to [Mesh] Error: prefix (line 1537)"
  - "handleSlashCommand() outer try/catch safety net (line 3979)"
  - "logEndpoint() call wired at runCli() startup (line 929)"
affects:
  - output-layer
  - handleSlashCommand
  - tool-execution-catch

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "runSlashCommandSafe: ora spinner wrapper with error classification + consecutiveErrors tracking"
    - "JSON.parse hardening: inner try/catch with [Mesh] Error: message at all 3 unguarded sites"
    - "[Mesh] Error: format: uniform branded error prefix with recovery suggestion in all error paths"

key-files:
  created: []
  modified:
    - "src/agent-loop.ts"

key-decisions:
  - "Ghost styles error message upgraded from dim silent to pc.red [Mesh] Error: to meet >=5 count requirement"
  - "logEndpoint() placed at very top of runCli() — fires before checkInit() so endpoint is visible even if init fails"
  - "/twin case wrapped with runSlashCommandSafe() as the mandatory call-site (done criteria); outer try/catch handles all other cases"
  - "Intent file JSON.parse wrapped with inner try/catch inside existing outer try — distinguishes corrupt JSON from missing file"

requirements-completed:
  - ERR-01
  - ERR-02
  - ERR-03
  - ERR-04
  - LLM-04

# Metrics
duration: "~6 minutes"
completed: 2026-04-27
---

# Phase 01 Plan 04: Error Hardening Summary

**`runSlashCommandSafe()`, outer dispatch safety net, 3 JSON.parse guards, branded `[Mesh] Error:` tool errors, and `logEndpoint()` startup call — all Phase 1 error hardening requirements closed**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-04-27T21:17:44Z
- **Completed:** 2026-04-27T21:24:00Z
- **Tasks:** 2 auto tasks (Task 3 is checkpoint:human-verify — awaiting user)
- **Files modified:** 1

## Accomplishments

### Task 1: JSON.parse guards + tool error format

- Wrapped `pkg = JSON.parse(...)` in `handleInspect()` (line 734) with try/catch; fallback to `{}` keeps devScript logic intact
- Wrapped `JSON.parse(match[1])` in ghost delta handler (line 879) with inner try/catch; failure emits `[Mesh] Error: Ghost styles parse failed`
- Added inner try/catch around `JSON.parse(intentRaw)` in `runSynthesize()` (line 2416); failure emits `[Mesh] Error: Intent file is corrupted. Try /index first`
- Changed tool execution error prefix from `Tool execution failed: ${errorMsg}` to `[Mesh] Error: ${toolName} failed — ${errorMsg}. ${hint}` with ENOENT/EACCES/timeout classification

### Task 2: runSlashCommandSafe, outer safety net, logEndpoint

- Added `private async runSlashCommandSafe(label, fn)` at line 2565 — ora spinner wrapper with 6-category error classification and `consecutiveErrors` Map tracking
- Wired `/twin` case to use `runSlashCommandSafe()` as the required call site
- Wrapped entire `switch (command)` block in `handleSlashCommand()` with outer try/catch returning `{ wasHandled: true, shouldExit: false }` — CLI never crashes on unhandled command throws
- Added `this.llm.logEndpoint()` at top of `runCli()` (line 929) — active endpoint visible on every startup

## Task Commits

Each task was committed atomically:

1. **Task 1: JSON.parse guards + tool error format** - `17fb4b5` (fix)
2. **Task 2: runSlashCommandSafe + safety net + logEndpoint** - `306a268` (feat)

## Files Created/Modified

- `src/agent-loop.ts` — 4 JSON.parse sites hardened, tool error format updated, `runSlashCommandSafe()` added, outer dispatch try/catch added, `logEndpoint()` wired

## Key Line Numbers in src/agent-loop.ts

| Change | Line |
|--------|------|
| `let pkg: Record<string, any> = {}` + try/catch (handleInspect) | 734 |
| Inner try/catch for ghost styles parse | 879 |
| Inner try/catch for intent file parse (`[Mesh] Error: Intent file is corrupted`) | 2416 |
| Tool error format: `[Mesh] Error: ${toolName} failed —` | 1537 |
| `this.llm.logEndpoint()` at runCli() startup | 929 |
| `private async runSlashCommandSafe()` | 2565 |
| `/twin` case using `runSlashCommandSafe()` | 3784 |
| Outer try/catch wrapping `switch (command)` | 3740 / 3979 |

## Final Grep Counts

| Pattern | Count |
|---------|-------|
| `[Mesh] Error:` occurrences in agent-loop.ts | 5 |
| `runSlashCommandSafe` occurrences | 2 (definition + /twin call) |
| `fetchWithRetry` in llm-client.ts | present |
| `sanitizeLlmOutput` in agent-loop.ts | present |
| `logEndpoint` in agent-loop.ts + llm-client.ts | present |
| `Tool execution failed:` (should be 0) | 0 |

## Test Results

All 37 tests pass after both tasks:

```
# tests 37
# pass 37
# fail 0
```

## Checkpoint Status

Task 3 is `type="checkpoint:human-verify" gate="blocking"` — awaiting user verification:

1. `npm test` — exits 0, all 37 tests pass
2. Endpoint log: `this.llm.logEndpoint()` fires at `runCli()` startup → `[Mesh] LLM endpoint: <url>` on stderr
3. LLM output sanitization: `sanitizeLlmOutput()` strips `<thinking>` / `<thought>` before `marked.parse()`
4. Error format: `/synthesize` without prior `/index` shows `[Mesh] Error: Intent file is corrupted. Try /index first`
5. All key patterns grep positive

## Decisions Made

- Ghost styles error message changed from `pc.dim("[Mesh] Ghost styles parse failed")` to `pc.red("[Mesh] Error: Ghost styles parse failed")` to satisfy the >=5 `[Mesh] Error:` count requirement and match the D-01 format convention
- `logEndpoint()` placed before `checkInit()` so the endpoint URL is visible even on first-run init failures
- Inner try/catch pattern used for intent file parse (rather than restructuring the outer try/catch) to precisely distinguish "intent file missing" (outer catch, ENOENT → friendly skip message) from "intent file corrupt" (inner catch, SyntaxError → `[Mesh] Error:` with `/index` hint)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Ghost styles error upgraded to [Mesh] Error: prefix**
- **Found during:** Task 2 acceptance criteria check
- **Issue:** Initial implementation used `pc.dim("[Mesh] Ghost styles parse failed")` — no `[Mesh] Error:` prefix, so `[Mesh] Error:` count was only 4, below the >=5 requirement
- **Fix:** Changed to `pc.red("[Mesh] Error: Ghost styles parse failed — skipping live preview update.")` — satisfies D-01 error format, meets count requirement, and is more visible to users
- **Files modified:** `src/agent-loop.ts`
- **Commit:** `306a268` (included in Task 2 commit)

## Threat Surface Scan

All mitigations from the plan's `<threat_model>` are implemented:

| Threat | Mitigation | Status |
|--------|-----------|--------|
| T-04-01 DoS: slash command crash | `runSlashCommandSafe()` + outer try/catch in `handleSlashCommand()` | DONE |
| T-04-02 InfoDisc: stack traces in output | All error paths use `err.message` sliced to 200 chars | DONE |
| T-04-03 InfoDisc: corrupt JSON SyntaxError showing path | All 3 JSON.parse sites wrapped with `[Mesh] Error:` messages | DONE |
| T-04-04 Tampering: tool error injection (accepted) | Out of scope per plan | ACCEPTED |
| T-04-05 InfoDisc: logEndpoint() leaking credentials | `logEndpoint()` writes to stderr, URL only (no auth header) | DONE |

No new network endpoints, auth paths, or file access patterns introduced. All changes are defensive wrappers within existing code paths.

---

## Self-Check

**Modified files exist:**
- `src/agent-loop.ts`: FOUND

**Commits exist:**
- `17fb4b5`: FOUND (fix — Task 1)
- `306a268`: FOUND (feat — Task 2)

**Key patterns present:**
- `[Mesh] Error: Intent file is corrupted`: FOUND (line 2430)
- `[Mesh] Error: Ghost styles parse failed`: FOUND (line 883)
- `let pkg`: FOUND (line 734)
- `[Mesh] Error:.*failed` (tool error): FOUND (line 1537)
- `private async runSlashCommandSafe`: FOUND (line 2565)
- `consecutiveErrors.set(cmdKey`: FOUND (line 2599)
- `[Mesh] Error: Command.*failed`: FOUND (line 3981)
- `this.llm.logEndpoint()`: FOUND (line 929)
- `[Mesh] Error:` count >= 5: 5 occurrences FOUND
- `Tool execution failed:` count == 0: 0 FOUND

## Self-Check: PASSED

---
*Phase: 01-foundation-hardening*
*Completed: 2026-04-27*
