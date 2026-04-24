# Mesh Moonshot Features

Short list of never-seen-before features that make Mesh more than a coding agent.

## Status
- **Implemented v1**: Multiverse Fix Racing, Failure Autopsy, UI-To-Code X-Ray, Codebase Digital Twin, Predictive Repair Daemon, Engineering Memory That Learns, Intent Compiler, Live Architecture Cockpit, Causal Software Intelligence, Autonomous Discovery Lab, Reality Fork Engine, Ghost Engineer Replay.
- **Planned**: Autonomous Refactor Migration Engine, Self-Improving Agent Runtime.

## Legendary Moonshots

### Causal Software Intelligence
Mesh builds a causal repo graph rather than a plain dependency map. The graph links files, symbols, routes, risks, related tests, predictive repair signals, Engineering Memory rules, and git change pressure. The goal is to answer why a module is risky, what causes delivery drag, and which change would reduce future failures.

- Current v1: `workspace.causal_intelligence` builds `.mesh/causal-intelligence.json` and supports `build`, `read`, `status`, and `query`.
- Evidence model: deterministic graph nodes/edges plus ranked insights with severity, confidence, likely files, and recommended action.
- CLI: `/causal build`, `/causal status`, `/causal query <question>`.

### Autonomous Discovery Lab
Mesh runs its own local research pass over the codebase. It combines Causal Intelligence, diagnostics, Predictive Repair, Digital Twin, and Engineering Memory, then returns ranked experiments with proof steps.

- Current v1: `workspace.discovery_lab` writes `.mesh/discovery-lab.json` with discoveries, hypotheses, evidence, experiment steps, verification commands, recommended tools, and history.
- The lab does not silently mutate production files. It proposes proof-first experiments and routes risky changes through timelines or `agent.race_fixes`.
- CLI: `/lab run`, `/lab status`, `/lab clear`.

### Reality Fork Engine
Mesh converts an intent into multiple alternate project realities, scores each reality, and can materialize them as isolated timelines. This turns "one patch" into a structured comparison between possible futures.

- Current v1: `workspace.reality_fork` writes `.mesh/reality-forks/latest.json` with scored proposals, target files, constraints, expected effects, verification gates, and promotion criteria.
- `action: "fork"` creates actual isolated timelines and writes a per-fork contract artifact inside each timeline.
- CLI: `/fork plan <intent>`, `/fork fork <intent>`, `/fork status`, `/fork clear`.

### Ghost Engineer Replay
Mesh learns how the local engineer tends to work inside this repo, then predicts and checks future work against that learned style. This is not generic memory; it models file-reading order, patch shape, verification habits, docs discipline, risk posture, naming style, and divergence rules.

- Current v1: `workspace.ghost_engineer` writes `.mesh/ghost-engineer/profile.json` plus prediction artifacts in `.mesh/ghost-engineer/predictions/`.
- `learn` analyzes Git history when available, dirty files, Digital Twin, Causal Intelligence, and Engineering Memory.
- `predict` returns likely first reads, files, implementation order, tests, docs, verification, rollback, causal signals, and a style-conformant autopilot patch plan.
- `divergence` scores a plan against the learned profile and reports concrete warnings like missing verification, unjustified dependencies, wide blast radius, missing docs, or risk without proof.
- `patch` materializes a safe isolated timeline containing the autopilot contract and promotion gates instead of mutating the main workspace.
- CLI: `/ghost learn`, `/ghost profile`, `/ghost predict <goal>`, `/ghost divergence <plan>`, `/ghost patch <goal>`.

## 1. Multiverse Fix Racing (Automated Parallel Verification)
Mesh acts as a "Future Simulator" that computes multiple realities simultaneously and promotes the most stable future.

### Workflow & Logic
- **Candidate Generation**: Mesh generates $N$ (default: 3) different patches using distinct strategies (e.g., "Minimal Intervention", "Complete Refactoring", "Robust Error-Handling").
- **Isolated Spawning**: For each patch, Mesh calls `workspace.timeline_create` to spawn a dedicated Git Worktree.
- **Parallel Execution**: Verification commands (e.g., `npm test`, `tsc`, `vitest`) are executed concurrently across all timelines.
- **Telemetry Analysis**: Mesh captures more than just Pass/Fail:
  - **Diff Elegance**: Line count change and side-effect avoidance.
  - **Runtime Performance**: Execution time regressions.
  - **Linter Score**: Checks for new warnings introduced by the fix.
- **The Judge**: A specialized reviewer agent evaluates results and executes `workspace.timeline_promote` for the "winning" future.

## 2. Failure Autopsy (Deep State Reconstruction)
Mesh reconstructs the "Causal Chain of Failure" by freezing the exact memory state at the moment of a crash.

### Technical Components
- **V8-Snapshotting**: Injects `node:inspector` (CDP) to pause the process on `uncaughtException` instead of exiting.
- **State-Dumping**: Automatically retrieves all local variables (`Scope-Analysis`) for every stack frame.
- **Causal Linker**: Maps runtime values back to the AST via `tree-sitter`. (e.g., If `config.db.url` is `null`, Mesh traces back to where this object was initialized).
- **Evidence Report**: Generates an interactive failure timeline:
  - `t-10s`: Request received at `/api/user`.
  - `t-5s`: DB Connection pool exhausted.
  - `t-0s`: Crash in `db-client.ts:42` (Variable `conn` is `undefined`).
  - Inspector-backed local variable capture is available for Node-backed runs; non-Node runs fall back to log reconstruction.

## 3. UI-To-Code X-Ray (Visual Architecture Mapping)
A single click in the browser opens the "Vertical Slice" through the entire application stack.

### Operation
- **Fiber-Tracing**: Extracts the `__source` attribute from React elements to find the exact source file.
- **Network Hooking**: Mesh correlates XHR/Fetch requests occurring during the interaction with specific backend endpoints.
- **Full-Stack Bridge**:
  1. **Frontend**: Identifies `UserButton.tsx`.
  2. **API**: Detects call to `PUT /users/me`.
  3. **Backend**: Uses `workspace.trace_symbol` to find `UserController.updateMe` and the corresponding `UserService.save`.
  4. **Database**: Shows the final SQL/Prisma query executed.
- **Visualization**: The dashboard renders this path as a glowing connection in a 3D graph, showing the data flow from mouse click to disk.
  - The current v1 captures React source hints plus recent network activity and route matches; DB-level tracing remains future work.

## Additional Features
4. **Codebase Digital Twin**  
   A runnable model of the repo: symbols, routes, tests, DB schema, env, deploy paths, and runtime traces. Mesh predicts what breaks before editing.
   - Current v1: `workspace.digital_twin` builds `.mesh/digital-twin.json` with files, symbols, routes, tests, env names, deploy/config hints, git state, and risk hotspots.

5. **Predictive Repair Daemon**  
   Mesh watches dev server logs, tests, browser console, and git diffs, then prepares verified fixes before the user asks.
   - Current v1: `workspace.predictive_repair` analyzes diagnostics, watcher signals, dirty files, risk hotspots, and Engineering Memory, then stores a prepared queue in `.mesh/predictive-repair.json`.

6. **Engineering Memory That Learns**  
   Mesh learns repo-specific rules from accepted and rejected changes: architecture boundaries, reviewer preferences, risky modules, and deploy rules.
   - Current v1: `workspace.engineering_memory` persists repo rules, risk modules, accepted/rejected patterns, and learned events in `.mesh/engineering-memory.json`.

7. **Intent Compiler**  
   Mesh turns product intent into verified engineering work: schema, backend, frontend, tests, docs, telemetry, rollout, and rollback.
   - Current v1: `workspace.intent_compile` writes `.mesh/intent-compiler/latest.json` with likely files, interfaces, test strategy, risks, rollout, and verification command.

8. **Autonomous Refactor Migration Engine**  
   Mesh performs large migrations incrementally, verifies behavior preservation, and ships safe PR slices.

9. **Live Architecture Cockpit**  
   A real supervision dashboard for timelines, agents, failures, risk hotspots, dependency graphs, runtime traffic, and coverage gaps.
   - Current v1: `workspace.cockpit_snapshot` feeds `/dashboard` with Digital Twin, repair queue, Engineering Memory, timelines, runtime runs, git/index state, and health score.

10. **Self-Improving Agent Runtime**  
    Mesh measures every run, learns which strategies worked, and updates local agent definitions automatically.

## Build First
1. **Causal Software Intelligence** (Implemented v1)
2. **Autonomous Discovery Lab** (Implemented v1)
3. **Reality Fork Engine** (Implemented v1)
4. **Ghost Engineer Replay** (Implemented v1)
5. **Multiverse Fix Racing** (Implemented v1)
6. **Failure Autopsy** (Implemented v1)
7. **UI-To-Code X-Ray** (Implemented v1)

## Core Wedge
Mesh should be the first local engineering operating system that tries many futures, verifies them, learns the repo, and only promotes proven work.
