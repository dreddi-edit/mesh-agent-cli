<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@edgarelmo/mesh-agent-cli/assets/mesh-banner.svg" alt="Mesh - Terminal-first AI engineering agent" width="100%">
</p>

<p align="center">
  <strong>An Agentic Operating System that turns your repository into a self-improving workspace.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@edgarelmo/mesh-agent-cli"><img alt="npm package" src="https://img.shields.io/npm/v/@edgarelmo/mesh-agent-cli?color=14B8A6"></a>
  <img alt="license" src="https://img.shields.io/badge/license-UNLICENSED-111827">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-334155">
</p>

## Overview

Mesh is an AI coding agent for engineers who want more than autocomplete. It runs directly in your terminal, understands your entire workspace, tests changes in isolated timelines, and writes verified code.

It combines deep local code intelligence with advanced autonomous pipelines to not just *write* code, but to **verify, debug, and understand** it.

## Install & Quick Start

Requires Node.js 20+.

```bash
npm install -g @edgarelmo/mesh-agent-cli
cd path/to/your/project
mesh init
```

*Note for Mac/Linux Users: You can log in using your full email or just your username (the part before the `@`) if typing special characters in the terminal is awkward.*

## Core Capabilities

Mesh is built around autonomous workflows and safety. Here are the features that make Mesh fundamentally different:

### 1. The Ghost Engineer (Timelines)
Mesh doesn't blindly edit your active files. It creates an invisible "Ghost Timeline" (an isolated git worktree), writes the code there, runs your tests (`npm test`, `tsc`), fixes any errors autonomously, and only promotes the code to your main branch when it's 100% green. 

### 2. Issue Autopilot (`/autopilot`)
From ticket to verified Pull Request in one command. Feed Mesh a GitHub/Linear URL. It reads the issue, finds the relevant files, writes the fix in a Ghost Timeline, verifies it, and prepares the PR.

### 3. Cross-Model Tribunal (`/tribunal`)
For hard architectural decisions or complex bugs. Mesh summons three distinct AI personas (Correctness, Performance, Security). They debate the problem, critique each other's solutions, and synthesize a dominant, deeply vetted architecture plan.

### 4. Cognitive Session Resurrection (`/resurrect`)
Stop losing context over the weekend. `mesh /resurrect capture` saves your exact mental state: open files, the goal, failed approaches, and open questions. On Monday, run `/resurrect` and pick up exactly where your brain left off.

### 5. Semantic Contract Sheriff (`/sheriff`)
Protects against behavioral drift. The Sheriff fingerprints the *semantic meaning* of your modules. If a refactor keeps the tests green but accidentally changes the module's core purpose, the Sheriff throws a critical alert.

### 6. Causal Autopsy (`/causal`)
When a test fails, Mesh doesn't just read the stack trace. It reconstructs the causal chain by looking at the error, recent git commits, and config changes to find the *actual* root cause.

## Golden Path Commands

Inside an interactive `mesh` session, you can use conversational prompts or specific slash commands:

- `/start` - Initial repo briefing and health check.
- `/change <prompt>` - Scope a narrow edit, apply a surgical patch, run verification, and get a structured risk report.
- `/index` - Build the persistent local code-intelligence index.
- `/company query <question>` - Ask the codebase with grounded citations and recommended files.
- `/doctor` - Run system health checks (Auth, API connectivity, environment).

## Privacy & Security

- **Strict Command Guardrails:** Destructive commands (`rm -rf`, `chmod 777`) and credential exfiltration are blocked.
- **Opt-in Telemetry:** Data collection is disabled by default and requires explicit opt-in.
- **Local Workspaces:** Source code never leaves your machine unless explicitly sent to the LLM for a specific task.
- **Enterprise Audit Log:** Every action the AI takes is recorded in a cryptographically signed, tamper-proof hash chain (`/audit verify`).

---
*Mesh Agent CLI — Private Alpha*