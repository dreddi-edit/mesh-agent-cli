# Mesh Moonshot Enhancements Plan: The Final Leap to Autonomy

This document outlines the detailed implementation plan to evolve four core Mesh Moonshot engines from passive ledgers (analysis) into fully autonomous, timeline-verified mutation engines. This bridges the gap between identifying structural realities and materially acting upon them, surpassing traditional IDE assistants (Copilot) and chat-based executors (Claude Code).

## Objective
To implement four major functional expansions within the existing `src/moonshots/` architecture:
1.  **Semantic Git Auto-Merge:** Elevate `semantic-git.ts` from classification to autonomous AST-based resolution for non-overlapping hunk conflicts.
2.  **TODO/FIXME Resolver:** Introduce an autonomous agent routine that parses technical debt markers, generates fixes in ghost timelines, verifies them, and prepares promotion PRs.
3.  **Self-Defense Expansion:** Broaden `self-defending.ts` beyond ReDoS to detect and structurally block SQLi, Path Traversal, and Command Injection vulnerabilities before they compile.
4.  **Autonomous Testing Engine:** Integrate continuous, missing-path test generation and execution into `living-software.ts`, driving code coverage actively in the background.

---

## 1. Semantic Git Auto-Merge

### Current State
`src/moonshots/semantic-git.ts` identifies conflict markers and classifies them as `auto_resolvable` (no AST symbol overlap) or `needs_review`.

### Implementation Steps
1.  **AST-Aware Parser Integration:** 
    *   Enhance the hunk extraction logic to parse the `ours` and `theirs` blocks into isolated AST nodes (using the existing `tree-sitter` worker or `ts-morph`).
2.  **Conflict Synthesizer:**
    *   For conflicts marked `auto_resolvable`, create a new method `synthesizeResolution(conflict)` that intelligently interleaves the distinct nodes.
    *   If `ours` adds function A and `theirs` adds function B in the same file region, the synthesizer sequentially places A then B, respecting module scope.
3.  **Timeline Verification (The Sandbox):**
    *   Before applying the resolution to the main worktree, spawn a Ghost Timeline (`workspace.timeline_create`).
    *   Apply the synthesized AST patches.
    *   Run syntax validation (`tsc --noEmit`) and existing test suites within the timeline.
4.  **Promotion:**
    *   If the timeline passes verification, promote the changes back to the main worktree and mark the file as resolved (`git add <file>`).

### Testing Strategy
*   **Fixture:** Create a dummy branch with a deterministic Git conflict containing non-overlapping additions.
*   **Assertion:** Verify `synthesizeResolution` produces valid syntax containing both additions.
*   **Integration:** Ensure the timeline verification gates prevent structurally invalid auto-merges from reaching the main worktree.

---

## 2. TODO/FIXME Resolver Engine

### Concept
Turn static technical debt comments into active repair tasks. 

### Implementation Steps
1.  **Debt Scanner:**
    *   Create a specialized grep pattern or AST traversal to extract all `// TODO:` and `// FIXME:` comments, preserving their surrounding lexical scope.
2.  **Intent Translation:**
    *   Pipe the extracted comment and surrounding capsule into the `workspace.intent_compile` engine to convert the human remark into a structured patch plan.
3.  **Execution via Fix Racing:**
    *   Leverage the existing Multiverse Fix Racing paradigm (`workspace.reality_fork`).
    *   Spawn a timeline, apply the intended patch (resolving the TODO), and remove the comment line.
4.  **Verification & PR Prep:**
    *   Execute the project's tests. If successful, use `workspace.finalize_task` to stash the fixed debt into a cleanly named branch (e.g., `mesh-auto/resolve-todo-auth`).

### Testing Strategy
*   **Unit:** Test the extraction parser against various comment formats and multiline JSDoc TODOs.
*   **Integration:** Seed a fixture file with `// TODO: rename variable x to userCount`. Verify the engine correctly identifies, plans, and applies the variable rename in a mock timeline.

---

## 3. Expanded Self-Defending Code

### Current State
`src/security/self-defending.ts` currently only analyzes Regex expressions for ReDoS vulnerabilities.

### Implementation Steps
1.  **Rule Expansion (Static Signatures):**
    *   **Command Injection:** Scan for `spawn`, `exec`, `eval` where arguments derive from unstructured/untyped string interpolation (identifying `any` or loose `string` types in the AST).
    *   **Path Traversal:** Scan for `fs.readFile`, `fs.writeFile`, `path.join` where arguments are directly derived from HTTP request parameters without sanitization boundaries.
    *   **SQLi:** Scan for raw string interpolation inside query execution blocks (e.g., `` db.query(`SELECT * FROM users WHERE id = ${id}`) ``).
2.  **Structural Blocking (The Defense):**
    *   Modify the `scan` action to inject protective utility wrappers around identified vulnerable signatures if auto-merge is approved (e.g., wrapping a path lookup in a `sanitizePath` guard).
3.  **Adversarial Probing Expansion:**
    *   Extend the `probe` action to emit mock payloads containing directory traversal dots (`../../`) or SQL injection strings (`' OR 1=1 --`) in isolated child processes.

### Testing Strategy
*   **Security Fixtures:** Introduce deliberate, vulnerable patterns in a test directory.
*   **Assertion:** Verify the expanded rule sets accurately flag the patterns with high severity scores. Ensure the adversarial prober successfully triggers the expected timeout or rejection.

---

## 4. Autonomous Testing Engine

### Concept
Automatically synthesize missing edge-case tests to improve coverage and system resilience, tying into the `workspace.living_software` pulse.

### Implementation Steps
1.  **Coverage Gap Analysis:**
    *   In the `living_software.ts` pulse routine, integrate a fast coverage heuristic. Identify exported functions lacking associated `.test.ts` or `.spec.ts` files.
2.  **Generative Mocking:**
    *   Utilize the `webapp-testing` and `backend-testing` skills to generate structural unit tests.
    *   Specifically focus on boundary condition generation (nulls, empty strings, max integers) for the identified uncovered functions.
3.  **Timeline Execution:**
    *   Write the generated tests to a Ghost Timeline.
    *   Execute the test runner.
4.  **Iterative Refinement:**
    *   If the generated test fails due to a genuine bug in the target code, flag it in the `predictive-repair` ledger.
    *   If it fails due to bad mock setup, discard or retry the generation.
    *   If it passes, promote the new test file to the main worktree.

### Testing Strategy
*   **Mock Function:** Create a simple, untested math or string utility function in the fixture space.
*   **Integration:** Trigger the engine and assert that a valid, passing test file is generated, executed in a timeline, and subsequently merged.