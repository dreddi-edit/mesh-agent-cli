<p align="center">
  <img src="https://raw.githubusercontent.com/dreddi-edit/mesh-agent-cli/main/assets/mesh-banner.svg" alt="Mesh - Terminal-first AI engineering agent" width="100%">
</p>

<p align="center">
  <strong>Terminal-first AI engineering agent with local code intelligence, runtime debugging, speculative timelines, and worker orchestration.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@edgarelmo/mesh-agent-cli"><img alt="npm package" src="https://img.shields.io/npm/v/@edgarelmo/mesh-agent-cli?color=14B8A6"></a>
  <img alt="license" src="https://img.shields.io/badge/license-UNLICENSED-111827">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-334155">
</p>

## Install

Install Mesh globally. The `mesh` terminal command is created by npm's global `bin` linking.

```bash
npm install -g @edgarelmo/mesh-agent-cli
mesh
```

Do not use plain `npm install @edgarelmo/mesh-agent-cli` if you expect `mesh` to work as a shell command. A local install only creates `./node_modules/.bin/mesh` inside that project.

Useful alternatives:

```bash
# Run after a local install
./node_modules/.bin/mesh

# Run without installing globally
npx -p @edgarelmo/mesh-agent-cli mesh
```

If `npm install -g` succeeds but `mesh` is still not found, your npm global bin directory is not on `PATH`:

```bash
npm config get prefix
ls "$(npm config get prefix)/bin/mesh"
```

Add `$(npm config get prefix)/bin` to your shell `PATH` if the file exists but the command is unavailable.

## What Mesh Does

Mesh is built for engineering work from the terminal. It combines an agent loop with workspace-aware tools so it can inspect, edit, test, and reason over real codebases.

- **Local code intelligence**: `workspace.ask_codebase`, `workspace.explain_symbol`, and `workspace.impact_map` use a persistent index under `~/.config/mesh/indexes/<workspace-hash>`.
- **Runtime debugging**: `.mesh/runbooks/*.json` profiles power `runtime.start`, `runtime.capture_failure`, `runtime.trace_request`, `runtime.explain_failure`, and `runtime.fix_failure`.
- **Speculative timelines**: `workspace.timeline_create`, `workspace.timeline_apply_patch`, `workspace.timeline_run`, `workspace.timeline_compare`, and `workspace.timeline_promote` test candidate changes in isolated worktrees or checkout copies.
- **Worker orchestration**: `.mesh/agents/*.md` role definitions feed `agent.spawn`, `agent.status`, `agent.review`, and `agent.merge_verified`.
- **Terminal frontend preview**: `/preview <url> [widthxheight]` captures Chromium screenshots via CDP and renders inline where supported.
- **Local supervision view**: `/dashboard` opens the code graph and live tool event control plane.
- **Voice mode**: `/voice` enables local speech-to-speech workflows. On macOS, `mesh doctor voice fix` installs voice dependencies via Homebrew.

## Quick Start

```bash
cd path/to/your/project
mesh
```

From inside Mesh, ask for the work you want done:

```text
map this codebase and explain the main runtime path
find the failing test and patch the smallest fix
preview http://localhost:3000 and inspect the UI
```

Mesh stores project-specific artifacts in `.mesh/` and persistent per-workspace indexes under `~/.config/mesh/`.

## Requirements

- Node.js 20 or newer.
- macOS, Linux, or any environment where npm global binaries are available on `PATH`.
- Optional for voice mode on macOS: Homebrew with `ffmpeg` and `whisper-cpp`.

## Package Commands

The npm package exposes two equivalent global commands:

```bash
mesh
mesh-agent
```

Both commands point to the same CLI entrypoint.

## License

UNLICENSED. All rights reserved.

This repository and npm package are not released under the MIT license or any other open-source license.
