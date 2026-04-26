# Mesh Moonshots Implementation Map

This document records how the ten Mesh Moonshot bets are implemented in this CLI codebase. The implementation is intentionally product-facing but conservative: each bet is exposed as a stable local tool, writes a deterministic `.mesh/` ledger, and has integration coverage through `LocalToolBackend`.

The source references came from the Downloads `README.md`, `00-philosophy.md`, and `05-self-defending-code.md`. Only `05-self-defending-code.md` existed as a full individual bet document, so the other nine are implemented from the README descriptions and the existing Mesh substrate.

## Shared Implementation Shape

All ten Moonshots are wired through `LocalToolBackend` in `src/local-tools.ts`.

Shared rules:
- Tool inputs are validated by `src/tool-schema.ts` before dispatch.
- Command-running Moonshots use `src/command-safety.ts`.
- Generated state lives under `.mesh/` and is ignored by git.
- Tests exercise the public tool surface rather than only isolated classes.

Shared helper:
- `src/moonshots/common.ts`
  - Workspace file collection with cache/build directory pruning.
  - JSON/JSONL ledger helpers.
  - Small path, line-number, and numeric utilities.

Integration tests:
- `tests/moonshots.test.mjs`
  - Creates a real fixture workspace.
  - Calls all ten tools through `LocalToolBackend.callTool`.
  - Verifies each tool emits concrete findings, contracts, ledgers, manifests, or health scores.

Public surface checks:
- `tests/public-surfaces.test.js`
- `MESH_FEATURES.md`

## 1. Bidirectional Spec ↔ Code

Tool:
- `workspace.spec_code`

Implementation:
- `src/moonshots/spec-code.ts`

Actions:
- `synthesize`
  - Scans source files for route declarations, exported functions, and test cases.
  - Converts those into behavior contracts.
  - Writes the contract ledger to `.mesh/spec-code/contracts.json`.
- `check`
  - Re-synthesizes contracts and compares them against the previous ledger.
  - Reports `new-behavior` and `removed-behavior` drift items.
- `status`
  - Reads the last ledger without rescanning.

Why this maps to the bet:
- The bet says behavior should become the source of truth. This implementation creates an explicit behavior-contract layer from current code and tests, then detects drift between the codebase and the last known behavior ledger.

Current output:
- `contracts[]`
  - `id`
  - `file`
  - `line`
  - `kind`: `route`, `exported-function`, or `test`
  - `subject`
  - `behavior`
  - `evidence`
- `drift[]`
- `summary`

Verification:
- `tests/moonshots.test.mjs` verifies exported behavior for `normalizeProfile` is synthesized.

## 2. The Merge That Does Not Exist

Tool:
- `workspace.semantic_git`

Implementation:
- `src/moonshots/semantic-git.ts`

Actions:
- `analyze`
  - Scans files for Git conflict markers.
  - Extracts each conflict hunk.
  - Builds symbol sets for both sides.
  - Classifies each hunk as:
    - `auto_resolvable` when both sides touch distinct symbols.
    - `needs_review` when both sides overlap or are structurally ambiguous.
  - Writes `.mesh/semantic-git/last-analysis.json`.

Why this maps to the bet:
- The bet is about replacing textual conflict handling with semantic conflict handling. This implementation makes the first semantic distinction: whether two conflict sides actually overlap at the symbol level.

Current output:
- `conflicts[]`
  - `file`
  - `startLine`
  - `oursLines`
  - `theirsLines`
  - `classification`
  - `reason`
- `autoResolvable`
- `needsReview`
- `semanticMergeReady`

Verification:
- `tests/moonshots.test.mjs` creates a conflict where one side adds `alpha` and the other adds `beta`, then verifies it is classified as auto-resolvable.

## 3. The Conversational Codebase

Tool:
- `workspace.conversational_codebase`

Implementation:
- `src/moonshots/conversational-codebase.ts`

Actions:
- `map`
  - Scans the workspace for exported/local symbols.
  - Builds `.mesh/conversations/symbol-memory.json`.
  - Preserves existing notes attached to symbols.
- `record`
  - Records a human or agent note against a symbol.
- `ask`
  - Ranks symbol memory by query, symbol name, file path, and notes.
  - Returns a compact answer plus matches.
- `status`
  - Reports memory size.

Why this maps to the bet:
- The codebase becomes a participant when symbols accumulate memory and can answer questions about their own location, kind, and history. This is the minimal durable substrate for that loop.

Current output:
- `answer`
- `matches[]`
- `.mesh/conversations/symbol-memory.json`

Verification:
- `tests/moonshots.test.mjs` maps symbols, records a note on `normalizeProfile`, and asks for it.

## 4. Probabilistic Codebases

Tool:
- `workspace.probabilistic_codebase`

Implementation:
- `src/moonshots/probabilistic-codebase.ts`

Actions:
- `plan`
  - Scans for routes, high-leverage hotspots, and pure exported functions.
  - Produces candidate experiments with routing weights and guardrails.
  - Writes `.mesh/probabilistic/experiments.json`.
- `status`
  - Reads the latest experiment manifest.

Why this maps to the bet:
- The bet says code should converge under real load with multiple candidate implementations. This implementation does not route production traffic yet; it creates the manifest that defines safe candidates, default control/candidate split, promotion gates, and rollback triggers.

Current output:
- `experiments[]`
  - `id`
  - `file`
  - `kind`: `route`, `hotspot`, or `pure-function`
  - `rationale`
  - `routing`
  - `guardrails`
- `rolloutPolicy`

Verification:
- `tests/moonshots.test.mjs` verifies a route file becomes an experiment candidate.

## 5. Self-Defending Code

Tool:
- `workspace.self_defend`

Implementation:
- `src/security/self-defending.ts`

Actions:
- `scan`
  - Scans regex literals and `new RegExp(...)` calls.
  - Scores ReDoS risk using structural backtracking heuristics.
  - Writes `.mesh/security/last-self-defense.json`.
  - Appends `.mesh/security/log.jsonl`.
- `probe`
  - Runs adversarial confirmation in a child Node process with a timeout.
  - Marks findings as `confirmed`, `timeout`, or `suspicious`.
- `status`
  - Ensures and reports security policy files.

Generated policy files:
- `.mesh/security/policy.yaml`
- `.mesh/security/sensitive.yaml`
- `.mesh/security/log.jsonl`

Why this maps to the bet:
- The full Moonshot asks for continuous adversaries and verified fixes. This implements the first concrete vulnerability class from the reference doc: ReDoS. It includes scanning, adversarial probing, policy defaults, and a security ledger.

Current output:
- `findings[]`
  - `file`
  - `line`
  - `pattern`
  - `score`
  - `status`
  - `evidence`
  - `recommendation`

Verification:
- `tests/moonshots.test.mjs` verifies `/^(a+)+$/` is detected as suspicious.

## 6. End Of The Staging Environment

Tool:
- `workspace.end_staging`

Implementation:
- `src/moonshots/shadow-deploy.ts`

Actions:
- `shadow`
  - Creates an isolated timeline.
  - Runs a verification command in that timeline.
  - Reads production telemetry signals if present.
  - Writes `.mesh/shadow-deploy/last-ledger.json`.
- `status`
  - Reads the last shadow deploy ledger.

Safety:
- Calls `assertCommandAllowed` before running the command.
- Uses existing `TimelineManager`, so main workspace files are not changed.

Why this maps to the bet:
- The bet says deploy stops being a singular risk event when verification and shadow execution happen before promotion. This implementation creates the promotion/readiness ledger in an isolated timeline.

Current output:
- `timelineId`
- `command`
- `exitCode`
- `verdict`
- `changedFiles`
- `gates`
- `stdout`
- `stderr`

Verification:
- `tests/moonshots.test.mjs` verifies a passing shadow command produces a passing verification gate.

## 7. Fluid Mesh Of Capabilities

Tool:
- `workspace.fluid_mesh`

Implementation:
- `src/moonshots/fluid-mesh.ts`

Actions:
- `map`
  - Extracts package scripts, route capabilities, tool capabilities, and exported symbols.
  - Infers lightweight dependency edges from imports.
  - Writes `.mesh/fluid-mesh/capabilities.json`.
- `status`
  - Reads the latest capability manifest.

Why this maps to the bet:
- The bet says repositories stop being the unit of software. This implementation maps the repo into portable capability units: scripts, routes, tools, and symbols.

Current output:
- `capabilities[]`
  - `id`
  - `name`
  - `file`
  - `line`
  - `kind`
  - `provides`
  - `dependsOn`
- `graph[]`
- `exportable`

Verification:
- `tests/moonshots.test.mjs` verifies `package.json` test script is exposed as `script:test` and `/login` is exposed as `http:GET:/login`.

## 8. Precrime For Software

Tool:
- `workspace.precrime`

Implementation:
- `src/moonshots/precrime.ts`

Actions:
- `analyze`
  - Looks at changed files when git is available, otherwise scans the workspace.
  - Scores files using risk-boundary heuristics:
    - auth/session/token code
    - shell/runtime execution
    - database/query boundaries
    - externally reachable request paths
    - missing adjacent test coverage
    - production telemetry signals
  - Writes `.mesh/precrime/predictions.json`.
- `status`
  - Reads the latest prediction ledger.

Why this maps to the bet:
- The bet says bugs are predictable from code, team/change patterns, and cross-repo/production signals. This implementation produces a local prediction ledger from the signals Mesh already has.

Current output:
- `predictions[]`
  - `file`
  - `probability`
  - `severity`
  - `reasons`
  - `preventiveActions`
- `summary`

Verification:
- `tests/moonshots.test.mjs` verifies auth-ish code is predicted as a risk.

## 9. Natural Language As Source Language

Tool:
- `workspace.natural_language_source`

Implementation:
- `src/moonshots/natural-language-source.ts`

Actions:
- `compile`
  - Takes `intent` or `source`.
  - Compiles it into a constrained implementation IR:
    - operations
    - target files
    - test requirement
    - risk level
    - acceptance clauses
  - Produces patch and verification plans.
  - Writes `.mesh/natural-language-source/last-compile.json`.
- `status`
  - Reads the latest compile ledger.

Why this maps to the bet:
- The bet says prose becomes source. This implementation creates the compiler boundary: natural language is parsed into a stable intermediate representation and verification plan before any patching occurs.

Current output:
- `ir`
- `patchPlan`
- `verificationPlan`

Verification:
- `tests/moonshots.test.mjs` verifies an intent containing “Add validation” compiles to `add` and `validate` operations.

## 10. Living Software

Tool:
- `workspace.living_software`

Implementation:
- `src/moonshots/living-software.ts`

Actions:
- `pulse`
  - Reads ledgers from the other Moonshot systems.
  - Computes health scores:
    - `immune`
    - `predictive`
    - `adaptive`
    - `memory`
    - `deployConfidence`
    - `specIntegrity`
    - `capabilityFluidity`
    - `languageReadiness`
    - `proofReadiness`
    - `causalClarity`
  - Classifies the workspace as:
    - `embryonic`
    - `learning`
    - `self-maintaining`
  - Writes `.mesh/living-software/pulse.json`.
- `status`
  - Reads the latest pulse.

Why this maps to the bet:
- The bet is the synthesis of the other nine. This implementation makes that synthesis explicit by treating their ledgers as organ systems, including the natural-language compiler ledger, proof-carrying change ledger, and causal autopsy ledger, then producing a single state pulse with next interventions.

Current output:
- `scores`
- `organismState`
- `signals`
- `nextInterventions`

Verification:
- `tests/moonshots.test.mjs` runs the previous ledgers, then verifies `workspace.living_software` emits a valid organism state and numeric scores.

## Shipped Mesh Extensions

These are not part of the original ten Moonshot references. They were added after the first ten as concrete Mesh-native product surfaces.

## 11. Proof-Carrying Changes

Tool:
- `workspace.proof_carrying_change`

Implementation:
- `src/moonshots/proof-carrying-change.ts`
- Wired through `src/local-tools.ts`

Actions:
- `generate`
  - Builds a promotion proof bundle without mutating the workspace.
  - Reads the current git status, git diff stat, recent commit, package scripts, and Mesh ledgers.
  - Falls back to a workspace file observation mode when the target directory is not a git checkout.
  - Writes `.mesh/proof-carrying-change/proof.json`.
- `verify`
  - Runs a supplied `verificationCommand` after `assertCommandAllowed`.
  - Captures command exit code, stdout, stderr, duration, and gate result.
  - Writes the same proof bundle with the verification run attached.
- `status`
  - Reads the latest proof bundle.

What it proves:
- Intent:
  - Explicit user intent if provided.
  - Falls back to the natural-language source ledger when available.
- Change set:
  - Changed files, status codes, line counts, diff stat, recent commit, and git availability.
- Touched capabilities:
  - Matches changed files against `.mesh/fluid-mesh/capabilities.json`.
- Affected contracts:
  - Matches changed files against `.mesh/spec-code/contracts.json`.
- Risk model:
  - Scores changed-line volume, high-risk path boundaries, Precrime predictions, self-defense findings, spec drift, and shadow deploy state.
- Gates:
  - `intent`
  - `changeSet`
  - `spec`
  - `security`
  - `verification`
  - `rollback`
- Verification:
  - Direct `verify` command result when action is `verify`.
  - Latest shadow deploy ledger when action is `generate`.
  - Available package scripts as review context.
- Rollback:
  - Patch-reversal plan bound to the exact changed files.
  - Manual-review flag when untracked or fallback-observed files are present.
- Unresolved assumptions:
  - Missing intent, missing spec ledger, missing fluid mesh ledger, missing self-defense ledger, missing verification, or missing changed-file evidence.

Current output:
- `proofId`
- `verdict`: `ready_to_promote`, `ready_with_review`, `incomplete`, or `blocked`
- `changeSet`
- `touchedCapabilities`
- `affectedContracts`
- `riskModel`
- `gates`
- `verification`
- `rollbackPath`
- `unresolvedAssumptions`
- `sourceLedgers`

Why this is a real Mesh feature:
- Mesh already has timelines, spec-code, precrime, self-defense, fluid mesh, shadow deploy, and living software. This tool turns those separate ledgers into a single review/promotion artifact that a human or agent can require before shipping a change.

Verification:
- `tests/moonshots.test.mjs` generates a proof after creating the underlying ledgers and verifies:
  - route capability evidence is attached,
  - profile behavior contracts are attached,
  - the verification gate passes from the shadow deploy ledger.

## 12. Causal Autopsy Engine

Tool:
- `workspace.causal_autopsy`

Implementation:
- `src/moonshots/causal-autopsy.ts`
- Wired through `src/local-tools.ts`

Actions:
- `investigate`
  - Accepts `symptom`, `runId`, or `failingCommand`.
  - Reads runtime observer state when `runId` is provided.
  - Runs a supplied `failingCommand` after `assertCommandAllowed`.
  - Reads git status, diff stat, recent commits, proof bundle, self-defense, precrime, shadow deploy, spec-code, fluid mesh, and living-software ledgers.
  - Scans workspace source for symptom-token matches.
  - Writes `.mesh/causal-autopsy/last-autopsy.json`.
- `status`
  - Reads the latest causal autopsy.

What it reconstructs:
- Runtime evidence:
  - Error summary.
  - Stack frames.
  - Runtime run status and exit code.
  - Captured stdout/stderr tails.
  - Runtime autopsy causal chain when available.
- Change evidence:
  - Current changed files.
  - Git diff stat.
  - Recent commits.
- Config and dependency deltas:
  - Config-like changed files.
  - Package/lockfile changed files.
- Ledger evidence:
  - Existing proof bundle.
  - Precrime predictions.
  - Self-defense findings.
  - Spec-code drift.
  - Shadow deploy status.
- Suspect ranking:
  - Scores files using stack-frame presence, current diff membership, symptom-token matches, Precrime probability, self-defense findings, spec drift, config deltas, and dependency deltas.
- Causal graph:
  - Nodes for symptom, runtime evidence, proof, and top suspect files.
  - Edges showing observed failure and likely causal file links with confidence.
- Missing invariants:
  - Regression tests, runtime evidence, spec-code contracts, proof bundle, and shadow verification gaps.

Current output:
- `incident`
- `runtimeEvidence`
- `causalChain`
- `suspects`
- `graph`
- `configDeltas`
- `dependencyDeltas`
- `missingInvariants`
- `nextActions`

Why this is a real Mesh feature:
- Runtime debugging, Precrime, proof bundles, and spec-code are useful alone, but incidents require causal compression. This tool creates a blame-proof explanation graph that points from symptom to evidence to likely source files and missing invariants.

Verification:
- `tests/moonshots.test.mjs` runs a symptom-only autopsy against the fixture after Precrime and self-defense ledgers exist and verifies:
  - `src/auth.ts` is ranked as a suspect,
  - the causal graph is populated,
  - missing invariants are emitted.

## Future Feature Notes

These three ideas are intentionally documented but not implemented in this pass.

## 13. Executable Engineering Culture

Concept:
- Mesh watches how senior engineers review code, write tests, reject unsafe abstractions, debug incidents, and name things.
- It compiles that behavior into repo-local policies, examples, review prompts, red flags, and agent personas.

Likely implementation location:
- `src/agents/`
- `src/audit/`
- `.mesh/culture/`

Likely tool:
- `workspace.engineering_culture`

Expected ledger:
- `.mesh/culture/policy.json`

## 14. Capability Markets Inside The Repo

Concept:
- Every function, script, route, tool, and service becomes a registered capability with input/output contract, owner, cost, reliability, tests, examples, and composition affordances.
- Agents stop editing files blindly and start buying, composing, replacing, or improving capabilities.

Likely implementation location:
- Extend `src/moonshots/fluid-mesh.ts`
- Add capability scoring and ownership metadata.

Likely tool:
- `workspace.capability_market`

Expected ledger:
- `.mesh/capability-market/market.json`

## 15. Autonomous Product Evolution Loop

Concept:
- Mesh links feedback, telemetry, bugs, docs, roadmap, code contracts, experiments, and proof bundles.
- It proposes product changes, builds candidates in timelines, tests them against specs and production-like traces, then asks for promotion.

Likely implementation location:
- `src/integrations/`
- `src/timeline/`
- `src/moonshots/probabilistic-codebase.ts`
- `src/moonshots/proof-carrying-change.ts`

Likely tool:
- `workspace.product_evolution`

Expected ledger:
- `.mesh/product-evolution/proposals.json`

## Current Boundaries

These implementations are complete local product surfaces, not research-complete endpoints. The important boundaries are:

- Self-defense currently implements ReDoS only, matching the first MVP in `05-self-defending-code.md`.
- Semantic Git analyzes conflict semantics but does not auto-edit conflict files.
- Probabilistic Codebases produce the experiment manifest and guardrails, but do not route production traffic.
- Natural Language Source compiles prose into IR and plans, but does not directly mutate source files.
- Proof-Carrying Changes generate and verify promotion evidence, but do not enforce repository branch protection by themselves.
- Causal Autopsy ranks causal suspects and builds an evidence graph, but it does not automatically patch the incident.
- Living Software synthesizes local ledgers; it does not autonomously schedule all interventions yet.

Those boundaries are intentional. The tools now expose stable contracts and durable ledgers, which lets future agents build deeper automation without changing the public surface.
