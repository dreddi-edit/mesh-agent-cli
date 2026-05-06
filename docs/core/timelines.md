# Verification & Timelines

Mesh handles code changes with a **Safety-First** philosophy. Instead of editing your source of truth directly, it uses isolated environments called "Timelines".

## The Lifecycle of a Change

1. **Proposal:** Mesh identifies a required code change.
2. **Timeline Creation:** A `ghost_verify` task is initiated. Mesh creates a temporary git worktree (a separate folder with a copy of your code).
3. **Execution:** The patch is applied within this isolated folder.
4. **Verification:** Mesh runs your project's test suite, linter, and type-checker inside the worktree.
5. **Promotion:** Only if all checks pass is the change applied to your actual working directory.

## Why this matters

Traditional agents often "hallucinate" code that doesn't compile or breaks existing tests. By using Timelines, Mesh ensures:
- **Zero Regressions:** Broken code never reaches your `main` branch.
- **Background Work:** Mesh can test complex changes in the background while you continue working.
- **Deterministic Fixes:** When Mesh says it fixed a bug, it has already proven it by running the tests.

## Working with Timelines

You can interact with timelines using the following internal concepts:
- `workspace.timeline_create`: Manually spin up a new verification environment.
- `workspace.ghost_verify`: The primary tool for "speculative" changes.
- `workspace.alien_patch`: Applying external logic to a local environment safely.
