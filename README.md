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

Mesh is built around autonomous workflows and engineering safety. Unlike standard chat assistants, Mesh operates as a peer with full workspace context:

### 1. The Ghost Engineer (Timelines)
Mesh doesn't blindly edit your source files. It creates an invisible "Ghost Timeline" (isolated git worktree) to apply changes. It runs your local tests, linters, and type-checks autonomously, and only promotes the code to your main branch when the build is 100% green.

### 2. Deep Code Intelligence
Mesh maintains a **High-Density AI Brain** of your repository. 
- **Semantic RAG:** Uses NVIDIA **nv-embedcode** models for high-precision code retrieval.
- **Token-Optimized:** Project metadata is refactored into compact, whitespace-free data structures to maximize LLM reasoning accuracy.
- **Zero-Config:** All intelligence features are securely proxied through the Mesh LLM Gateway — elite performance for every user without personal API keys.

### 3. Issue Autopilot (`/autopilot`)
Go from ticket to verified PR in one command. Mesh reads issue descriptions (GitHub/Linear/Jira), identifies relevant modules, drafts the solution in a Ghost Timeline, and verifies the fix before preparing the final PR.

### 4. Cross-Model Tribunal (`/tribunal`)
For complex architectural decisions, Mesh summons three distinct AI specialist personas. They debate the implementation, critique edge cases, and synthesize a deeply vetted technical plan.

### 5. Cognitive Session Resurrection (`/resurrect`)
Preserve your mental model across sessions. `/resurrect capture` saves open files, current intent, and failed attempts. Start your next session by restoring the exact context where you left off.

## Golden Path Commands

Mesh supports both conversational prompts and specialized slash commands:

- `/start` - Initial repo briefing and workspace health check.
- `/change <prompt>` - Scope a narrow edit, apply a surgical patch, and get a verification report.
- `/index` - Synchronize the local high-density intelligence brain.
- `/company query` - Search the codebase brain with semantic NVIDIA-powered RAG.
- `/doctor` - Run system diagnostics (Auth, Gateway connectivity, environment).
- `/model` - Switch between Claude 4.6 Sonnet (default), specialized NVIDIA, or Google models.

## Privacy & Security

- **Strict Command Guardrails:** Destructive commands (`rm -rf`, `chmod 777`) and credential exfiltration are blocked.
- **Opt-in Telemetry:** Data collection is disabled by default and requires explicit opt-in.
- **Local Workspaces:** Source code never leaves your machine unless explicitly sent to the LLM for a specific task.
- **Enterprise Audit Log:** Every action the AI takes is recorded in a cryptographically signed, tamper-proof hash chain (`/audit verify`).

---
*Mesh Agent CLI — Private Alpha*