<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@edgarelmo/mesh-agent-cli/assets/mesh-banner.svg" alt="Mesh - Terminal-first AI engineering agent" width="100%">
</p>

<p align="center">
  <strong>A terminal-first AI engineering agent that turns your repository into an inspectable, testable, self-improving workspace.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@edgarelmo/mesh-agent-cli"><img alt="npm package" src="https://img.shields.io/npm/v/@edgarelmo/mesh-agent-cli?color=14B8A6"></a>
  <img alt="license" src="https://img.shields.io/badge/license-UNLICENSED-111827">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-334155">
</p>

## Overview

Mesh is an AI coding agent for engineers who want more than autocomplete. It runs in the terminal, understands the local workspace, keeps persistent project memory, tests candidate changes in isolated timelines, and produces durable evidence in `.mesh/` instead of relying only on chat history.

The core idea: code changes should be explored, verified, explained, and remembered. Mesh combines local code intelligence, runtime debugging, speculative worktrees, autonomous repair loops, semantic contracts, and project-level memory into one CLI.

## Install

Install Mesh globally so the `mesh` command is linked into your shell:

```bash
npm install -g @edgarelmo/mesh-agent-cli
mesh
```

Useful alternatives:

```bash
# Run without a global install
npx -p @edgarelmo/mesh-agent-cli mesh

# Run after a local project install
./node_modules/.bin/mesh
```

If global install succeeds but `mesh` is not found, your npm global bin directory is probably not on `PATH`:

```bash
npm config get prefix
ls "$(npm config get prefix)/bin/mesh"
```

Add `$(npm config get prefix)/bin` to your shell `PATH` if the binary exists but the command is unavailable.

## Quick Start

```bash
cd path/to/your/project
mesh init
```

`mesh init` runs the first-user golden path: diagnostics with safe local fixes, workspace indexing, status, and a repo briefing.

Inside an interactive `mesh` session, the equivalent path is:

```text
/start
explain the main runtime path with citations
/change find the failing test and patch the smallest fix
```

Then ask for real engineering work:

```text
map this codebase and explain the main runtime path
find the failing test and patch the smallest fix
preview http://localhost:3000 and inspect the UI
create a timeline for this migration and verify it before promotion
```

Mesh writes project-specific artifacts to `.mesh/` and persistent per-workspace indexes to `~/.config/mesh/`.

## First-User Readiness

Before onboarding a new user or workspace, run:

```bash
npm run verify:release
mesh --version
mesh --help
mesh support
mesh init
```

Inside the target repo, run `mesh init` or `/start` first. `/doctor fix` applies safe local repairs such as creating Mesh state directories and workspace config; destructive or user-shell changes remain manual.

The full pre-release checklist lives in [docs/go-live.md](docs/go-live.md). Privacy and support guidance live in [docs/privacy.md](docs/privacy.md) and [docs/support.md](docs/support.md).

Default behavior is conservative:

- Source files stay local unless a model/tool call needs context for the task.
- If the OS keychain is unavailable, Mesh falls back to a `0600` session file under `~/.config/mesh/` instead of failing startup.
- Mesh Brain telemetry contribution is opt-in and disabled by default.
- Background resolver and embeddings are opt-in to avoid surprise CPU, model downloads, or provider costs.
- Tests run with file watchers disabled to avoid OS watcher-limit flakiness.

## Core Capabilities

### Workspace Intelligence

Mesh builds a persistent understanding of your repository: file capsules, symbol maps, dependency hints, codebase summaries, and project memory. This lets the agent reason over large codebases without repeatedly dumping raw files into the model context.

Common commands:

- `/start` runs the first-user path: doctor, index, status, and repo briefing.
- `/index` re-indexes the workspace.
- `/company build` builds the durable Company Codebase Brain with cited repo knowledge, rules, risks, decisions, and verification memory.
- `/company query <question>` asks the Company Brain with grounded citations and recommended files.
- `/status` shows runtime, model, session, git, and index state.
- `/capsule` inspects or manages compressed session memory.
- `/distill` updates the project brain context.
- `/twin` builds or reads the Codebase Digital Twin.

### Issue-To-PR Autopilot

Mesh can turn a GitHub issue, local issue snapshot, or manual ticket into a verified implementation workflow. The autopilot builds a repo-grounded plan from the Company Brain, creates an isolated timeline, applies a generated or supplied patch, runs verification, reviews the diff, writes a proof bundle, and can optionally create a PR branch/PR.

Common commands:

- `/autopilot plan <issueUrl|ticket text>` builds the implementation plan and patch prompt.
- `/autopilot run <issueUrl|ticket text>` executes the patch workflow in an isolated timeline.
- `/autopilot pr <issueUrl|ticket text>` verifies the change and attempts PR branch/PR creation.

Artifacts are written to `.mesh/autopilot/` and `.mesh/company-brain/`.

### Safe Code Changes

Mesh can edit real files, but it is designed around verification. Risky changes can be tested in isolated timelines before they ever touch the main workspace. Timeline workflows support patching, running verification commands, comparing diffs, and controlled promotion.

Common capabilities:

- `/change <small goal>` scopes one narrow edit, applies the smallest safe patch, runs detected verification when available, and summarizes files, verification, risk, and next action.
- isolated timeline creation and verification
- patch validation and surgical edits
- command safety checks for destructive shell patterns
- tool input validation before execution
- undo support for recent agent file changes

### Runtime Debugging

Mesh can start commands under runtime observation, capture failures, extract stack traces, explain likely causes, and turn failures into timeline-first fix tasks. For Node.js, Mesh includes an inspector-backed autopsy path that can capture deeper exception context when available.

Useful commands:

- `/hologram start <cmd>`
- `/replay <traceId|sentryEventId>`
- `/bisect <symptom>`
- runtime tools such as `runtime.capture_failure`, `runtime.explain_failure`, and `runtime.fix_failure`

### Autonomous Engineering Workflows

Mesh includes higher-level workflows for planning, discovery, repair, and multi-agent execution:

- `/intent <goal>` compiles a product intent into an implementation contract.
- `/fork <intent>` creates alternate implementation realities.
- `/ghost` learns and replays the local engineer's implementation style.
- `/lab` runs autonomous discovery over project signals.
- `/repair` surfaces predictive repair opportunities.
- `/tribunal <problem>` convenes a structured AI panel for hard engineering decisions.
- `/resurrect` captures or restores session state across future sessions.

### UI, Dashboard, and Voice

Mesh includes developer-experience features for live work:

- `/preview <url>` captures a local frontend screenshot from the terminal.
- `/inspect [url]` attaches a visual agent portal for UI inspection.
- `/dashboard` launches a local supervision dashboard for project state and tool events.
- `/voice [on|off|setup]` enables local speech-to-speech workflows where supported.

## Moonshot Workflows

Mesh ships several advanced workflows that are designed to turn the codebase into a more active system:

### Self-Defending Code

`workspace.self_defend` scans and probes security-sensitive patterns, confirms selected vulnerability classes, writes security ledgers, and can create verified timeline patches for deterministic fixes such as simple ReDoS hardening.

### Precrime for Software

`workspace.precrime` predicts likely future incidents from changed files, risk boundaries, telemetry signals, local outcome history, and optional global Mesh Brain patterns. It can gate risky changes before promotion.

### Bidirectional Spec-Code

`workspace.spec_code` synthesizes behavior contracts from code, routes, and tests; accepts human-declared specs; detects drift; locks important contracts; and emits materialization plans for missing behavior.

### Semantic Git

`workspace.semantic_git` analyzes merge conflicts semantically, plans safe resolutions, verifies them in timelines, and only promotes when explicitly requested and verification passes.

### Semantic Sheriff

`/sheriff` fingerprints module semantics and reports when refactors silently change what code means, even if syntax still looks valid.

### Living Software Stack

Additional experimental workflows include natural-language source planning, fluid capability maps, causal autopsy, proof-carrying changes, session resurrection, tribunal decisions, and living-software pulse reports.

## Typical Workflows

### Understand a New Repository

```text
/index
/twin build
/causal build
explain the main request path and the riskiest modules
```

### Make a Risky Change Safely

```text
/intent migrate auth middleware to the new session model
/fork plan migrate auth middleware to the new session model
run the safest timeline and verify with npm test
```

### Debug a Runtime Failure

```text
/hologram start npm test
explain the captured failure and propose the smallest timeline fix
```

### Harden a Project

```text
run self defense probe on the repo
run precrime gate on changed files
/sheriff scan
/sheriff verify
```

### Resolve Merge Conflicts

```text
run semantic git analyze on the conflicted file
plan a semantic resolution
resolve it in a timeline and verify before promotion
```

## Commands

The CLI exposes a broad `/help` surface for interactive use. A detailed command-by-command guide lives in:

[docs/mesh-cli-command-guide.md](docs/mesh-cli-command-guide.md)

Common top-level commands:

- `/help` show available commands
- `/status` show runtime and session state
- `/index` build workspace intelligence
- `/preview` inspect local UI output
- `/dashboard` open the local supervision view
- `/company` build/query the durable Company Codebase Brain
- `/autopilot` run issue-to-verified-PR workflows
- `/intent`, `/fork`, `/ghost`, `/lab` run advanced engineering workflows
- `/doctor` diagnose local environment issues
- `/setup` configure model, cloud cache, theme, endpoint, and voice settings

## Configuration

Important environment variables:

- `WORKSPACE_ROOT`: override the workspace root.
- `BEDROCK_ENDPOINT`: use a custom LLM endpoint.
- `BEDROCK_MODEL_ID`: override the default model.
- `BEDROCK_FALLBACK_MODEL_IDS`: comma-separated fallback model IDs for transient failures.
- `BEDROCK_MAX_TOKENS`: default output token cap.
- `AGENT_MAX_STEPS`: per-turn tool/model loop cap. Default: `8`.
- `MESH_DISABLE_WATCHERS`: disable file watchers when set to `1`, `true`, or `yes`.
- `MESH_ENABLE_BACKGROUND_RESOLVER`: opt in to background diagnostics after file changes.
- `MESH_ENABLE_EMBEDDINGS`: opt in to local/remote embedding generation for the persistent index.
- `MESH_EMBEDDING_TIMEOUT_MS`: timeout for embedding work. Default: `8000`.
- `MESH_INDEX_PARALLELISM`: indexing concurrency. Default: `12`.
- `MESH_EMBEDDING_MODEL`: local retrieval embedding model.
- `MESH_STATE_DIR`: override local Mesh state directory.
- `MESH_BRAIN_ENDPOINT`: optional Mesh Brain contribution endpoint when telemetry contribution is enabled.

User settings are stored under `~/.config/mesh/`. Project artifacts are stored under `.mesh/`.

## Release

Before publishing, run:

```bash
npm run verify:release
npm run publish:dry-run
```

The release and rollback runbook lives in [docs/release-runbook.md](docs/release-runbook.md). See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Requirements

- Node.js 20 or newer.
- macOS, Linux, or another environment where npm global binaries work.
- Optional for voice mode on macOS: Homebrew with `ffmpeg` and `whisper-cpp`.
- Optional for frontend preview/dashboard flows: a local browser environment capable of Chrome/CDP-style capture.

## Package Commands

The npm package exposes:

```bash
mesh
mesh-agent
mesh-daemon
```

`mesh` and `mesh-agent` point to the same CLI entrypoint. `mesh-daemon` starts the daemon entrypoint.

## Maturity Notes

Mesh is actively evolving. Core workspace operations, indexing, timeline verification, runtime capture, command safety, audit logging, and the main terminal agent loop are intended to be practical for real projects.

Some advanced workflows are intentionally conservative:

- Self-defense currently auto-patches only deterministic classes where Mesh can verify behavior safely.
- Precrime is a local predictive model plus optional global pattern input; it is not a guarantee that an incident will or will not happen.
- Semantic Git can safely resolve distinct-symbol conflicts, but overlapping behavior still requires review.
- Bidirectional Spec-Code can synthesize and check contracts, but arbitrary full code generation from specs remains a reviewed workflow.
- Dashboard, voice, visual inspection, and some moonshot systems depend on local environment and available integrations.

Use timeline verification, tests, and review gates for production-critical changes.

## License

UNLICENSED. All rights reserved.

This repository and npm package are not released under the MIT license or any other open-source license.
