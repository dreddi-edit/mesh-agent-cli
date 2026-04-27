---
phase: 01-foundation-hardening
plan: "02"
subsystem: llm-client
tags: [llm, retry, timeout, abort-signal, bedrock]
dependency_graph:
  requires: ["01-01"]
  provides: ["fetchWithRetry", "isRetryableStatus", "logEndpoint", "AbortSignal.any timeout"]
  affects: ["src/llm-client.ts"]
tech_stack:
  added: []
  patterns: ["exponential-backoff-retry", "AbortSignal.any composition", "stderr endpoint log"]
key_files:
  created:
    - tests/error-and-sanitization.test.mjs
  modified:
    - src/llm-client.ts
decisions:
  - "fetchWithRetry delays (1s/2s/4s) are real delays even in tests — retry tests take 20s total; acceptable for correctness"
  - "Existing fallback test updated: primary model now exhausts all retries before fallback is attempted"
  - "converseStream() uses combinedSignal on its bare fetch() call (no fetchWithRetry — streaming retry is out of scope)"
metrics:
  duration: "~25 minutes"
  completed: "2026-04-27"
  tasks_completed: 2
  files_changed: 2
  files_created: 1
---

# Phase 01 Plan 02: LLM Client Hardening Summary

**One-liner:** Retry-with-backoff (3 retries, 1s/2s/4s jitter) and 60-second AbortSignal.any timeout added to BedrockLlmClient, plus startup endpoint log.

## What Was Built

Two hardening additions to `src/llm-client.ts`:

### Methods Added to BedrockLlmClient

| Method | Line | Type | Description |
|--------|------|------|-------------|
| `logEndpoint()` | 96 | public | Writes `[Mesh] LLM endpoint: <url>` to stderr — called from agent-loop.ts at startup (wired in Plan 04) |
| `isRetryableStatus(status)` | 250 | private | Returns true for 429, 408, 5xx — the per-request retry gate |
| `fetchWithRetry(url, init, maxRetries=3)` | 254 | private | Retries fetch up to 3 times with 1s/2s/4s exponential backoff + 25% jitter |
| `combinedSignal` (inline) | 117, 163 | local | `AbortSignal.any([callerSignal, AbortSignal.timeout(60_000)])` in both `converse()` and `converseStream()` |

### Integration Points

- `converse()` now calls `this.fetchWithRetry(...)` instead of bare `fetch()`, with `combinedSignal` passed as the `signal`
- `converseStream()` now uses `combinedSignal` (same `AbortSignal.any` pattern) on its bare `fetch()` call — no `fetchWithRetry` for streaming (buffered-response reconstruction out of scope)
- `shouldTryFallback()` and the outer model-fallback loop are unchanged — retry and fallback are orthogonal: `fetchWithRetry` exhausts same-model retries first, then returns the final failing response for the fallback loop to evaluate

## TDD Gate Compliance

**RED commit:** `aff18c0` — `test(01-02): add failing tests for fetchWithRetry same-model retry behavior`
- 3 new tests added; 2 failed (no implementation), 1 passed (400 non-retry was already correct behavior)

**GREEN commit:** `70e9d56` — `feat(01-02): add fetchWithRetry() and isRetryableStatus() to BedrockLlmClient`
- All 4 tests pass after implementation

## Test Coverage

### tests/llm-client.test.mjs (4 tests, all pass)
1. `Bedrock client retries fallback model on transient 429 response` — original; updated to account for full retry exhaustion before fallback
2. `fetchWithRetry retries same model up to 3 times on 429 before failing` — 4 total calls (1+3), then throws `LLM request failed`
3. `fetchWithRetry succeeds on 3rd retry attempt` — 2x 429 then 200, returns text response
4. `fetchWithRetry does NOT retry on non-retryable 400 error` — exactly 1 fetch call

### tests/error-and-sanitization.test.mjs (4 tests, all pass) — NEW FILE
1. `logEndpoint writes LLM endpoint to stderr`
2. `converse() passes combinedSignal derived from caller signal to fetch`
3. `converse() applies timeout signal even when no caller abort signal is provided`
4. `AbortSignal.any combines caller abort signal with 60s timeout (LLM-02)` — test 4 per plan acceptance criteria

## Deviations from Plan

### [Plan Inconsistency - Noted] fetchWithRetry count acceptance criterion

**Found during:** Task 1 verification
**Issue:** Plan acceptance criteria states `grep "fetchWithRetry" src/llm-client.ts | wc -l` should output at least 3 ("definition + 2 call sites minimum"). But the plan itself explicitly states "Do NOT modify converseStream()" — leaving only 1 real call site. The internal loop body uses bare `fetch()` not `this.fetchWithRetry()`. Result: 2 occurrences (definition + 1 call in `converse()`).
**Resolution:** The functional behavior is correct per the plan's own implementation spec. The acceptance criterion count of 3 is a documentation error in the plan. All other acceptance criteria pass.

### [Rule 1 - Bug] Fallback test updated to match new retry behavior

**Found during:** Task 1 GREEN testing
**Issue:** Original fallback test assumed 1st call = primary (429), 2nd call = fallback (200). With `fetchWithRetry`, the 2nd call is a retry of primary (also 429), not the fallback. The fallback is only tried after all 4 primary attempts fail.
**Fix:** Updated test mock to return 429 for all primary-model URLs and 200 only for fallback-model URLs. Updated assertion to check `requestedUrls[requestedUrls.length - 1]` matches fallback-model instead of `requestedUrls[1]`.
**Files modified:** `tests/llm-client.test.mjs`
**Commit:** `70e9d56`

### [Rule 2 - Missing critical test file] Created tests/error-and-sanitization.test.mjs

**Found during:** Task 2 verification step (plan required this file to exist)
**Issue:** Plan's Task 2 verification command references `tests/error-and-sanitization.test.mjs` which was listed as a "Wave 0 gap" in RESEARCH.md but not created by plan 01-01. Without this file, Task 2 verification cannot run.
**Fix:** Created the file with 4 tests covering `logEndpoint()`, `combinedSignal` presence, no-caller-signal timeout, and the `AbortSignal.any` test (test 4 per plan).
**Files created:** `tests/error-and-sanitization.test.mjs`
**Commit:** `b76d762`

## Threat Surface Scan

No new network endpoints, auth paths, or file access patterns introduced. Changes are internal to `BedrockLlmClient` — no new trust boundaries created.

The retry amplification threat (T-02-01) is mitigated: `isRetryableStatus()` limits retries to 429/408/5xx only, `maxRetries=3` caps attempts at 4 total per model, and jitter prevents thundering herd.

The timeout threat (T-02-02) is mitigated: `AbortSignal.timeout(60_000)` fires in both `converse()` and `converseStream()` regardless of whether the caller passes an abort signal.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `aff18c0` | test | RED — add failing tests for fetchWithRetry same-model retry |
| `70e9d56` | feat | GREEN — add fetchWithRetry() and isRetryableStatus(), update tests |
| `b76d762` | feat | Task 2 — AbortSignal.any wiring, logEndpoint(), error-and-sanitization tests |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src/llm-client.ts` exists | FOUND |
| `tests/llm-client.test.mjs` exists | FOUND |
| `tests/error-and-sanitization.test.mjs` exists | FOUND |
| `01-02-SUMMARY.md` exists | FOUND |
| commit `aff18c0` exists | FOUND |
| commit `70e9d56` exists | FOUND |
| commit `b76d762` exists | FOUND |
