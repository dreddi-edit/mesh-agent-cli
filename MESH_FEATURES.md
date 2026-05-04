# Mesh CLI - The Definitive Technical Manual (Unabridged)

Mesh is a high-performance **Terminal Engineering Operating System**. It is designed to be the first agent that doesn't just "chat" about code, but lives inside the codebase with deep AST awareness, isolated execution futures, real-time runtime telemetry, and external protocol support.

---

## 🏗 Philosophy: Zero-Config & Capsule-First

1.  **Zero-Config**: Built-in Supabase Auth and Bedrock Proxy. No AWS keys or environment setup required to start coding.
2.  **Capsule-First**: To avoid context-window explosion, Mesh never reads raw code unless absolutely necessary. It works with "Capsules"—distilled semantic snapshots of files.
3.  **Extensible**: Fully supports the Model Context Protocol (MCP) to plug into external systems natively.

---

## 🎙 1. Voice Coding Engine (Speech-to-Speech)

Mesh features a fully local, low-latency voice interface for hands-free engineering.

-   **Command**: `/voice [on|off|setup]`
-   **Transcription (STT)**: Uses **Whisper** (via `@xenova/transformers`). 
    -   *Models*: Base (~141MB), Small (Recommended, ~466MB), Medium (~1.5GB).
    -   *Features*: Auto-language detection, silence detection, and 5s recording chunks.
-   **Synthesis (TTS)**: Uses native system voices (macOS `say`, etc.) for zero-latency feedback.
    -   *Logic*: Adapts tone based on language (e.g., "Anna" for German, "Daniel" for English).
-   **Voice Doctor**: `/doctor voice fix` automates the installation of Homebrew dependencies (FFmpeg) and model downloads.

---

## 📦 2. Memory & Compression (The Capsule System)

The most advanced part of Mesh's architecture, designed to save 90% of tokens.

### Tiered Intelligence
-   **Low-Tier**: 1-sentence purpose summaries for broad directory scanning.
-   **Medium-Tier**: Structural data (exports, symbols, imports, dependencies).
-   **High-Tier**: Full semantic context including side-effects and risk profiles.

### Smart Cache Invalidation
-   **Content Hashing**: Uses robust MD5 `contentHash` tracking alongside `mtimeMs`. The agent avoids expensive re-indexing during git checkouts or timestamp updates if the actual file content hasn't changed.

### Mesh-Alien-OS (Void Protocol)
When tokens are tight, Mesh switches to **Alien Mode**:
-   **`workspace.generate_lexicon`**: Generates a project-specific dictionary where every common term gets a numeric ID (e.g., `1: "AuthManager"`).
-   **`workspace.session_index_symbols`**: Maps every function/class in the current context to a short ID (e.g., `!10`).
-   **`workspace.alien_patch`**: Edits code using **Symbolic Opcodes** and numeric IDs.
    -   *Example*: `!1 > { s: f: #A() { r: a: #B() } }` 
    -   *Translation*: "In file 1, make an async function (Auth) that returns the awaited result of B."
    -   *Result*: Near-zero token usage for complex multi-file edits.

---

## 🌩 3. Neural RAG Infrastructure

Mesh runs a complete search engine locally.

-   **Indexer**: Scans 10,000+ files, respects `.gitignore`, and generates persistent capsules in `~/.config/mesh/indexes/`.
-   **Hybrid Search**: 
    -   **Vector Similarity**: Using local dense embeddings (`@xenova/transformers` with `all-MiniLM-L6-v2`) via fully asynchronous AST-aware pipelines.
    -   **Keyword Signals**: BM25-style matching for exact symbol names.
    -   **AST Signals**: Boosts files that define searched symbols.
-   **Semantic Cache**: Uses an in-memory L1 Cosine Similarity cache (`> 0.95` similarity threshold) to instantly short-circuit repeated or highly similar RAG queries, saving token generation costs.
-   **`workspace.ask_codebase`**: The entry point for the agent to query the repo with modes like `architecture`, `bug`, or `test-impact`. Returns strict `[Fonte: path]` attribution for zero-hallucination source tracking.

---

## ⏱ 4. Multiverse Engine (Ghost Timelines & Shadow Runs)

Mesh never guesses; it verifies in parallel futures.

-   **`workspace.timeline_create`**: Spawns a "Ghost" workspace using Git Worktrees.
-   **`workspace.timeline_apply_patch`**: Applies candidate fixes to the isolated copy.
-   **`workspace.timeline_run`**: Executes tests, builds, or linters inside the ghost copy.
-   **`workspace.timeline_compare`**: Diffs multiple timelines to find the safest fix.
-   **`workspace.timeline_promote`**: Merges a verified timeline back into the master branch.
-   **`workspace.run_in_shadow`**: Uses `rsync` to create a fast, disposable clone of the workspace to run destructive shell commands safely without affecting the working directory.

---

## 🔮 5. Runtime Autopsy & Holograms

Mesh can "see" your code as it runs.

-   **Command**: `/hologram start <cmd>`
-   **V8 Telemetry**: Injects a specialized `node:inspector` script into your process via `NODE_OPTIONS`.
-   **Uncaught Exception Freezing**: When a crash occurs, Mesh freezes the V8 engine, dumps the **full call stack**, and captures all **local variable values** at the moment of failure.
-   **`runtime.start`, `runtime.capture_failure`, `runtime.fix_failure`**: The automated pipeline where the agent receives the memory dump and patches the bug.
-   **Current v1 behavior**: Node-backed runs capture real inspector pause data when possible; non-Node processes fall back to stack/log reconstruction.

---

## 🦄 6. Unicorn Feature: Neuro-Kinetic UI Injection (Real-Time Canvas)

Mesh is the first agent that turns any local codebase into a visual IDE. Using a transparent canvas overlay, users can manipulate UI elements directly in the browser while Mesh writes production-grade code in the background.

### Core Capabilities
-   **Intent-Based Design**: Alt+Click any element to open a prompt field. Describe changes like "Make this a glassmorphism card" or "Modernize this button."
-   **Zero-Latency Ghost Styles**: The agent emits immediate CSS `PREVIEW_STYLE` blocks. Mesh pushes these to the browser via CDP in milliseconds for instant feedback before the permanent code is even written.
-   **Multimodal Vision Loop**: After a ghost patch, Mesh captures a precise screenshot of the element and sends it back to the LLM (Claude Sonnet 4.5) for visual verification. The agent "sees" if the design is correct and self-corrects before patching the file.
-   **Smart Paradigm Detection**: Mesh automatically detects if a project uses Tailwind CSS. It translates visual intents into utility classes (e.g., `p-4` -> `p-16`) instead of generic inline styles.
-   **Sibling & Parent Awareness**: The agent receives the surrounding HTML context to ensure layout changes (like Flexbox or Grid) are structurally sound.

### Technical Architecture
1.  **CDP Two-Way Portal**: A persistent `CdpClient` in `src/mesh-portal.ts` holds a live bridge to the local dev server.
2.  **Visual Event Stream**: The `mesh-canvas-overlay.js` script tracks React Fiber nodes (`__source`) to trace DOM elements back to their exact source file and line number.
3.  **Silent Background Sync**: The CLI performs "Silent Syncs" for visual mutations, keeping the terminal clean while the code evolves.

---

## 🔗 7. Quantum Entanglement Sync

A specialized engine for multi-repo orchestration.

-   **Command**: `/entangle <path>`
-   **AST Synchronization**: When you perform an `alien_patch` or `rename_symbol` in the primary repo, Mesh automatically scans entangled repos for matching AST patterns and proposes/applies the same change to maintain cross-repo consistency in real-time.
-   **Implementation**: Integrated directly into the `LocalToolBackend.alienPatch` logic.

---

## 🌐 8. MCP Protocol & External Integrations

Mesh acts as an MCP (Model Context Protocol) Client to seamlessly add third-party tools.

-   **Configuration**: Direct MCP mode reads environment variables (`MESH_MCP_COMMAND`, `MESH_MCP_ARGS`). Workspace MCP files (`.mesh/mcp.json`) are opt-in via `MESH_ENABLE_WORKSPACE_MCP=1` or the runtime API's `includeWorkspaceMcp: true`.
-   **Environment Isolation**: MCP subprocesses inherit only a small safe environment allowlist by default. Add explicit variables with `MESH_MCP_ENV_ALLOWLIST`, or use `MESH_MCP_INHERIT_ENV=1` only for trusted servers.
-   **Implementation**: `McpClient` in `mcp-client.ts` uses JSON-RPC over `stdio` to initialize, discover tools (`tools/list`), and execute them natively alongside Mesh's built-in tools.

---

## 📊 9. Control Plane & UI (Dashboard & Multi-Modal)

Tools to bridge the terminal and the visual realm.

-   **Command**: `/dashboard`
-   **3D Code Graph**: Renders your codebase as a force-directed WebGL graph in the browser.
-   **Local API Token**: The CLI launcher passes the dashboard API token through the URL fragment; the server never renders that token into HTML.
-   **Live Pulse**: The terminal agent emits "Pulses" via WebSockets (`dashboardSocket`) to the dashboard to show real-time tool activity.
-   **Neuro-Kinetic Mutations**: Enable with `/inspect`. Allows you to manipulate the codebase through the UI dashboard.
-   **`frontend.preview`**: Uses Chrome CDP to take headless screenshots of URLs and renders them directly in the terminal via Kitty/iTerm2 image protocols.
-   **`web.inspect_ui`**: Triggers a Playwright headless browser to screenshot and evaluate web UI visually.
-   **`web.read_docs`**: Fetches and cleans HTML from the web (strips scripts/styles) for the agent to read external docs natively.
-   **Current v1 behavior**: The overlay captures React source hints and recent network activity, then passes that evidence to the agent loop for route tracing.
-   **Live Architecture Cockpit**: `/dashboard` now renders a cockpit snapshot that combines Digital Twin, repair queue, Engineering Memory, timelines, runtime runs, git/index state, and a health score.

---

## 🧠 10. Digital Twin, Memory & Intent Compiler

Mesh maintains a persistent local model of the repo and uses it to turn intent into verified engineering work.

-   **`workspace.digital_twin` / `/twin`**: Builds `.mesh/digital-twin.json` with files, symbols, routes, tests, env names, deploy/config hints, git state, and risk hotspots.
-   **`workspace.predictive_repair` / `/repair`**: Analyzes diagnostics, watcher signals, dirty files, risk hotspots, and learned rules, then stores prepared fixes in `.mesh/predictive-repair.json`.
-   **`workspace.engineering_memory` / `/learn`**: Records accepted/rejected patterns, risk modules, reviewer preferences, and repo-specific rules in `.mesh/engineering-memory.json`.
-   **`workspace.intent_compile` / `/intent`**: Turns product intent into `.mesh/intent-compiler/latest.json` with likely files, interfaces, tests, risks, rollout, rollback, and verification command.
-   **`workspace.causal_intelligence` / `/causal`**: Builds `.mesh/causal-intelligence.json`, a causal graph linking files, symbols, routes, risks, tests, repair signals, Engineering Memory rules, and git change pressure.
-   **`workspace.discovery_lab` / `/lab`**: Runs an autonomous opportunity scan and writes `.mesh/discovery-lab.json` with ranked experiments, evidence, expected impact, verification commands, and recommended tools.
-   **`workspace.reality_fork` / `/fork`**: Converts an intent into multiple scored implementation realities and can materialize them as isolated timelines with per-fork contracts.
-   **`workspace.ghost_engineer` / `/ghost`**: Learns the local engineer's repo-specific implementation style from Git, dirty work, Digital Twin, Causal Intelligence, and Engineering Memory. It predicts how the engineer would approach a goal, detects plan divergence, and can materialize a style-conformant autopilot timeline.

### Implemented Moonshot Stack
-   **Multiverse Fix Racing**: `agent.race_fixes` creates parallel candidate timelines, verifies them, scores telemetry, and recommends a winner.
-   **Failure Autopsy**: `runtime.capture_deep_autopsy` captures inspector-backed Node crash reports with scope data and log fallback.
-   **UI-To-Code X-Ray**: `/inspect` overlay captures React source hints, network activity, route evidence, and sends it into the agent loop.
-   **Codebase Digital Twin**: `.mesh/digital-twin.json` summarizes files, symbols, routes, tests, env, deploy/config, git, and risk hotspots.
-   **Predictive Repair Daemon**: `.mesh/predictive-repair.json` stores diagnostic and watcher-driven repair candidates.
-   **Engineering Memory**: `.mesh/engineering-memory.json` persists repo rules, risk modules, accepted/rejected patterns, and learned events.
-   **Intent Compiler**: `.mesh/intent-compiler/latest.json` turns product intent into likely files, risks, tests, rollout, rollback, and verification.
-   **Live Architecture Cockpit**: `/dashboard` reads `workspace.cockpit_snapshot` for index, git, repair, memory, timelines, runtime, causal, discovery, reality fork, and ghost state.
-   **Causal Software Intelligence**: `.mesh/causal-intelligence.json` turns repo evidence into causal insights and queryable recommendations.
-   **Autonomous Discovery Lab**: `.mesh/discovery-lab.json` proposes evidence-backed improvement experiments.
-   **Reality Fork Engine**: `.mesh/reality-forks/latest.json` compares alternate future implementations and can spawn their timelines.
-   **Ghost Engineer Replay**: `.mesh/ghost-engineer/profile.json` models the engineer's local style and produces predictions, divergence checks, and autopilot timelines.

---

## 🤖 11. Agent OS (Swarms & Delegation)

For massive tasks, Mesh spawns specialized workers.

-   **`agent.spawn`**: Launches a single worker with a specific role defined in `.mesh/agents/*.md`.
-   **`agent.spawn_swarm`**: Orchestrates multiple sub-agents in parallel to research or refactor different parts of the codebase simultaneously.
-   **`agent.invoke_sub_agent`**: Spins up a fast, low-temperature LLM (like Haiku) specifically for rapid data gathering.
-   **`agent.plan`**: Allows the agent to maintain an explicit architectural plan across long sessions.
-   **`workspace.finalize_task`**: Commits the finished work to a new Git branch and stages it for a Pull Request.

---

## 🛡 12. Safety, Reliability & DX

-   **Surgical Undo**: `/undo` reverts the last 50 edits step-by-step using an internal content stack in `LocalToolBackend`.
-   **Semantic Undo**: `workspace.semantic_undo` uses Git to surgically `git revert -n` specific concepts based on commit history.
-   **Loop Defense**: Tracks consecutive tool errors. If the same error occurs twice, the agent is hard-blocked with a `[MESH SYSTEM WARNING]` to prevent token burning.
-   **Git-Awareness**: The System Prompt is dynamically updated with `git status` output before every turn.
-   **Auto-Healing (Self-Healing Patches)**: Every `patch_surgical` run triggers a background `tsc --noEmit` or `node --check`. If a syntax error is introduced, Mesh automatically rolls back the file before the user even sees it.

---

## ⚙️ 13. Exhaustive Command & Tool Reference

### Complete Slash Commands
| Command | Usage | Description |
| :--- | :--- | :--- |
| `/help` | `/help` | Show reference. Aliases: `/commands`. |
| `/status` | `/status` | Show runtime, session, and index state. |
| `/capsule` | `/capsule [cmd]` | Inspect or manage the session capsule. |
| `/index` | `/index` | Re-index workspace and generate file capsules. |
| `/distill` | `/distill` | Analyze workspace and update the project brain context. |
| `/synthesize` | `/synthesize`| Auto-generate structural changes based on background heuristics. |
| `/twin` | `/twin [build\|read\|status]` | Build or inspect the Codebase Digital Twin. |
| `/repair` | `/repair [analyze\|status\|clear]` | Inspect the Predictive Repair queue. |
| `/learn` | `/learn [read\|learn]` | Read or refresh Engineering Memory. |
| `/intent` | `/intent <product intent>` | Compile product intent into an implementation contract. |
| `/causal` | `/causal [build\|read\|status\|query <question>]` | Build or query Causal Software Intelligence. |
| `/lab` | `/lab [run\|status\|clear]` | Run the Autonomous Discovery Lab. |
| `/fork` | `/fork [plan\|fork\|status\|clear] <intent>` | Plan or materialize alternate implementation realities. |
| `/ghost` | `/ghost [learn\|profile\|predict\|divergence\|patch] <input>` | Learn and replay the local engineer's implementation style. |
| `/fix` | `/fix` | Apply a background-resolved fix for a current linter/compiler error. |
| `/hologram` | `/hologram <cmd>`| Run command with V8 telemetry injection for live memory debugging. |
| `/entangle` | `/entangle <path>`| Quantum-link a second repository to sync AST mutations in real-time. |
| `/inspect` | `/inspect` | Enable neuro-kinetic UI mutations in the dashboard. |
| `/preview` | `/preview <url>`| Show real frontend screenshot in terminal via Chrome CDP. |
| `/dashboard` | `/dashboard` | Launch local interactive 3D codebase visualizer. |
| `/sync` | `/sync` | Check cloud (L2) cache synchronization. |
| `/setup` | `/setup [args]` | Interactive or scripted settings. |
| `/model` | `/model [pick]` | Interactive chooser or switch model. |
| `/cost` | `/cost` | Show token usage and estimated cost. |
| `/approvals` | `/approvals [status]`| Control tool auto-approval mode. |
| `/undo" | `/undo` | Revert the last file change made by the agent. |
| `/steps` | `/steps [<n>]` | Set max tool steps for this session. |
| `/doctor` | `/doctor [fix]`| Show runtime diagnostics (and fix missing deps). |
| `/compact` | `/compact` | Compress transcript into session capsule. |
| `/clear" | `/clear` | Clear terminal UI. |
| `/voice` | `/voice [on\|off]`| Toggle or configure Speech-to-Speech mode. |
| `/exit" | `/exit` | Quit. |

### Complete Agent Tool Roster (85+ Local Tools)
*(Tools grouped by domain, exactly as exposed by `LocalToolBackend`)*

**Filesystem Core:**
`workspace.list_files`, `workspace.read_file`, `workspace.read_file_raw`, `workspace.read_multiple_files`, `workspace.read_file_lines`, `workspace.list_directory`, `workspace.get_file_info`, `workspace.write_file`, `workspace.move_file`, `workspace.delete_file`

**Patching & AST:**
`workspace.patch_file`, `workspace.patch_surgical`, `workspace.validate_patch`, `workspace.alien_patch`, `workspace.ghost_verify`, `workspace.rename_symbol`, `workspace.query_ast`

**Search & Intelligence:**
`workspace.search_files`, `workspace.grep_content`, `workspace.grep_capsules`, `workspace.grep_ripgrep`, `workspace.list_symbols`, `workspace.expand_symbol`, `workspace.get_file_graph`, `workspace.read_dir_overview`, `workspace.ask_codebase`, `workspace.explain_symbol`, `workspace.impact_map`, `workspace.expand_execution_path`, `workspace.find_references`, `workspace.trace_symbol`

**Git & Timelines:**
`workspace.git_status`, `workspace.git_diff`, `workspace.get_recent_changes`, `workspace.semantic_undo`, `workspace.finalize_task`, `workspace.timeline_create`, `workspace.timeline_apply_patch`, `workspace.timeline_run`, `workspace.timeline_compare`, `workspace.timeline_promote`, `workspace.timeline_list`

**Moonshots:**
`workspace.self_defend`, `workspace.precrime`, `workspace.end_staging`, `workspace.semantic_git`, `workspace.probabilistic_codebase`, `workspace.conversational_codebase`, `workspace.spec_code`, `workspace.natural_language_source`, `workspace.fluid_mesh`, `workspace.living_software`

**Proof & Autopsy:**
`workspace.proof_carrying_change`, `workspace.causal_autopsy`

**System & Execution:**
`workspace.run_command`, `workspace.run_in_shadow`, `workspace.run_with_telemetry`, `workspace.get_env_info`, `workspace.get_diagnostics`

`workspace.run_command` blocks destructive operations plus credential-shaped reads, environment dumps, command substitution, and nested shell execution.

**Runtime Telemetry:**
`runtime.start`, `runtime.capture_failure`, `runtime.trace_request`, `runtime.explain_failure`, `runtime.fix_failure`

**Multi-Agent & Planning:**
`agent.spawn`, `agent.spawn_swarm`, `agent.invoke_sub_agent`, `agent.status`, `agent.review`, `agent.merge_verified`, `agent.plan`

**Web & UI:**
`web.read_docs`, `web.inspect_ui`, `frontend.preview`

**Void Protocol & Internal Memory:**
`workspace.session_index_symbols`, `workspace.generate_lexicon`, `workspace.get_index_status`, `workspace.index_status`, `workspace.check_sync`, `workspace.index_everything`, `workspace.digital_twin`, `workspace.predictive_repair`, `workspace.engineering_memory`, `workspace.intent_compile`, `workspace.cockpit_snapshot`, `workspace.causal_intelligence`, `workspace.discovery_lab`, `workspace.reality_fork`, `workspace.ghost_engineer`
