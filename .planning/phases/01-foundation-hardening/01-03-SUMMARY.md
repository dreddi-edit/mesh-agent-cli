---
phase: 01-foundation-hardening
plan: "03"
subsystem: output
tags: [llm-output, sanitization, rendering, markdown, typescript]

# Dependency graph
requires: []
provides:
  - "sanitizeLlmOutput() private method on AgentLoop class (src/agent-loop.ts line 3430)"
  - "export function sanitizeLlmOutput() at module level (src/agent-loop.ts line 4796)"
  - "renderAssistantTurn() now calls sanitizeLlmOutput before marked.parse()"
  - "8 unit tests covering all sanitization behaviors"
affects:
  - output-layer
  - renderAssistantTurn
  - forceFinalAnswer

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "sanitize-before-render: all LLM output is cleaned before markdown parsing and display"
    - "dual-export pattern: private method for runtime + module-level export for unit testing"

key-files:
  created:
    - "tests/error-and-sanitization.test.mjs"
  modified:
    - "src/agent-loop.ts"

key-decisions:
  - "Used dual-export pattern: private method for AgentLoop runtime + module-level export for testability without heavy config"
  - "Strip block content entirely for CoT tags (<thinking>/<thought>) — users must never see internal reasoning"
  - "Preserve content for wrapper tags (<artifact>/<result>/<answer>) — only remove the tags themselves"
  - "Close unclosed code fences (odd fenceCount) to prevent markdown render breakage (D-12)"
  - "Strip orphaned pipe-only table rows to prevent broken table rendering (D-12)"

patterns-established:
  - "sanitizeLlmOutput: all LLM text passes through sanitization before rendering"
  - "TDD RED/GREEN: tests committed before implementation for sanitization behaviors"

requirements-completed:
  - LLM-03

# Metrics
duration: 8min
completed: 2026-04-27
---

# Phase 01 Plan 03: LLM Output Sanitization Summary

**`sanitizeLlmOutput()` private method strips CoT XML tags, repairs code fences, and is wired into `renderAssistantTurn()` before `marked.parse()`, preventing raw `<thinking>` blocks from appearing in user output**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-27T21:15:00Z
- **Completed:** 2026-04-27T21:23:00Z
- **Tasks:** 1 (TDD: RED + GREEN commits)
- **Files modified:** 2

## Accomplishments

- Added `private sanitizeLlmOutput(text: string): string` on the `AgentLoop` class (line 3430 of agent-loop.ts), stripping all CoT tag blocks and repairing malformed output
- Modified `renderAssistantTurn()` to call `sanitizeLlmOutput()` before `marked.parse()`, so the ANSI path renders `marked.parse(cleaned)` and the plain-text path outputs `cleaned` instead of raw `text`
- Added module-level `export function sanitizeLlmOutput()` (line 4796) with identical logic for unit testing without instantiating AgentLoop
- Created 8 unit tests in `tests/error-and-sanitization.test.mjs` covering all sanitization behaviors — all pass, full suite 33/33 green

## Task Commits

Each task was committed atomically with TDD RED/GREEN phases:

1. **RED — Failing tests** - `54b4f8f` (test)
   - `tests/error-and-sanitization.test.mjs` — 8 tests, all failing (export not yet present)

2. **GREEN — Implementation** - `7911dda` (feat)
   - `src/agent-loop.ts` — private method + export + renderAssistantTurn wiring

## Files Created/Modified

- `tests/error-and-sanitization.test.mjs` — 8 unit tests for sanitizeLlmOutput behaviors
- `src/agent-loop.ts` — renderAssistantTurn() modified (line 3420), sanitizeLlmOutput() private method added (line 3430), export function added (line 4796)

## Key Line Numbers in src/agent-loop.ts

| Location | Line |
|----------|------|
| `renderAssistantTurn()` call to `sanitizeLlmOutput` | 3421 |
| `marked.parse(cleaned)` (was `marked.parse(text)`) | 3422 |
| `private sanitizeLlmOutput(text: string): string` | 3430 |
| `export function sanitizeLlmOutput(text: string): string` | 4796 |

## Test Results (Before and After)

**Before implementation:** All tests failed at module load with `SyntaxError: The requested module does not provide an export named 'sanitizeLlmOutput'`

**After implementation:** All 8 tests pass:
- Test 1: strips `<thinking>` blocks and content — PASS
- Test 2: strips `<thought>` blocks and content — PASS
- Test 3: removes `<artifact>/<result>/<answer>` tags, keeps content — PASS
- Test 4: preserves normal markdown and code blocks — PASS
- Test 5: closes unclosed code fences (odd fenceCount) — PASS
- Test 6: does not modify balanced code fences — PASS
- Test 7: strips orphaned pipe-only table rows — PASS
- Test 8: handles multiline thinking block followed by real content — PASS

Full suite: 33/33 tests pass.

## Decisions Made

- Used dual-export pattern (private method + module-level export) so the method can be unit-tested without instantiating AgentLoop, which requires full config setup
- CoT block content (`<thinking>`, `<thought>`, `<reflection>`, `<scratchpad>`) is stripped entirely — users should never see internal model reasoning
- Wrapper tag content (`<artifact>`, `<result>`, `<answer>`) is preserved — only the XML tags are removed, not the user-visible text
- Unclosed code fences cause markdown rendering to break; the odd-fenceCount check appends a closing ` ``` ` as a D-12 repair
- Orphaned `|`-only lines are stripped to prevent malformed table rendering

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- sanitizeLlmOutput is now available to all code paths that go through renderAssistantTurn(), including forceFinalAnswer() which already calls renderAssistantTurn()
- Plan 01-04 can safely add JSON.parse guards and runSlashCommandSafe() — the output sanitization foundation is in place
- No blockers

---

## Self-Check

**Created files exist:**
- `tests/error-and-sanitization.test.mjs`: FOUND
- `.planning/phases/01-foundation-hardening/01-03-SUMMARY.md`: this file

**Commits exist:**
- `54b4f8f`: FOUND (test commit — RED phase)
- `7911dda`: FOUND (feat commit — GREEN phase)

## Self-Check: PASSED

---
*Phase: 01-foundation-hardening*
*Completed: 2026-04-27*
