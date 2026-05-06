# Causal Autopsy

Causal Autopsy is Mesh's premier debugging engine. It transforms the frustrating cycle of "trial and error" into a deterministic, automated workflow.

## The Problem: The Debugging Loop
Normally, debugging involves:
1. Seeing a test fail.
2. Guessing the cause.
3. Making a change.
4. Running the test again.
5. Repeating until fixed.

## The Solution: Causal Autopsy
Causal Autopsy automates this entire loop:

### 1. Introspection
When a test fails, Mesh doesn't just look at the error message. It uses `runtime-observer.ts` to capture the full state of the process at the moment of failure, including stack traces, local variables, and environment state.

### 2. Semantic Analysis
Mesh matches the failure point against its **Semantic RAG** index to find all related functions, upstream callers, and downstream effects.

### 3. Isolated Drafting
A new **Ghost Timeline** is created. Mesh writes a potential fix inside this isolated environment.

### 4. Empirical Verification
Mesh runs the specific failing test again inside the timeline. If the test passes, it then runs the *entire* test suite to ensure no regressions were introduced.

### 5. Final Promotion
Only after a successful "Clean Run" is the fix presented to you for final approval and merge.

## How to Trigger
Simply tell Mesh:
> "The auth tests are failing. Run a causal autopsy and fix it."

Mesh will handle the rest and provide a detailed report of the root cause and the verified solution.
