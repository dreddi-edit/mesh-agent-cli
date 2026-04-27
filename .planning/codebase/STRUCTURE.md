# Codebase Structure

**Analysis Date:** 2026-04-27

## Directory Layout

```
/Users/edgarbaumann/Desktop/mesh-agent-cli/
├── src/                        # TypeScript source (19,285 LOC total)
│   ├── index.ts                # CLI entry point
│   ├── daemon.ts               # Daemon process entry + socket server
│   ├── agent-loop.ts           # Main agent turn executor (197KB)
│   │
│   ├── llm-client.ts           # Bedrock Converse API abstraction
│   ├── context-assembler.ts    # Token budgeting and context compression
│   ├── model-catalog.ts        # Model ID constants and fallback lists
│   │
│   ├── tool-backend.ts         # ToolBackend interface (abstract)
│   ├── local-tools.ts          # LocalToolBackend implementation (254KB, monolithic)
│   ├── mcp-client.ts           # McpClient backend
│   ├── composite-backend.ts    # CompositeToolBackend router
│   ├── tool-schema.ts          # Tool input validation
│   │
│   ├── workspace-index.ts      # Codebase semantic indexing + queries
│   ├── mesh-brain.ts           # Pattern matching client (local + remote)
│   ├── mesh-core-adapter.ts    # Tree-sitter AST interface
│   ├── cache-manager.ts        # Embedding cache management
│   │
│   ├── timeline-manager.ts     # Experiment timeline (worktrees + snapshots)
│   ├── agent-os.ts             # Agent spawning + lifecycle management
│   ├── session-capsule-store.ts # Session history persistence
│   ├── context-artifacts.ts    # Intermediate result storage
│   ├── runtime-observer.ts     # Process state + recent context (21KB)
│   ├── runtime-api.ts          # Headless API for embedding
│   │
│   ├── config.ts               # Configuration loading + validation
│   ├── auth.ts                 # Authentication + keychain integration
│   ├── daemon-protocol.ts      # Daemon ↔ CLI socket protocol
│   │
│   ├── dashboard-server.ts     # Web UI server (54KB, visualization)
│   ├── voice-manager.ts        # Speech I/O (18KB)
│   ├── terminal-preview.ts     # Rich terminal output capture
│   ├── mesh-portal.ts          # Web UI launcher
│   ├── structured-logger.ts    # JSON logging
│   ├── command-safety.ts       # Shell command approval
│   │
│   ├── mesh-gateway.ts         # HTTP gateway routing (legacy?)
│   ├── mesh-canvas-overlay.js  # Canvas rendering overlay (frontend artifact)
│   │
│   ├── agents/                 # Multi-agent orchestration engines
│   │   ├── persona-loader.ts   # Load role-specific agent definitions
│   │   ├── critic.ts           # Critic agent for code review
│   │   └── redteam.ts          # Red team agent for adversarial testing
│   │
│   ├── moonshots/              # Specialized high-value engines (22 files)
│   │   ├── precrime.ts         # Predictive incident detection
│   │   ├── shadow-deploy.ts    # Shadow deployment & rollback
│   │   ├── semantic-git.ts     # Semantic commit & change understanding
│   │   ├── tribunal.ts         # LLM voting for consensus decisions
│   │   ├── causal-autopsy.ts   # Root cause analysis framework
│   │   ├── hive-mind.ts        # Multi-agent consensus
│   │   ├── session-resurrection.ts  # Replay sessions from history
│   │   ├── self-defending.ts   # Auto-generated security patches
│   │   ├── proof-carrying-change.ts # Verification-first commits
│   │   ├── living-software.ts  # Self-aware code artifacts
│   │   ├── schrodingers-ast.ts # Dual-state AST exploration
│   │   ├── todo-resolver.ts    # Automated TODO item resolution
│   │   ├── conversational-codebase.ts  # Natural language code interface
│   │   ├── natural-language-source.ts  # NL→ source code generation
│   │   ├── probabilistic-codebase.ts   # Probabilistic code inference
│   │   ├── fluid-mesh.ts       # Dynamic mesh topology
│   │   ├── ephemeral-execution.ts      # Temporary sandboxed execution
│   │   ├── semantic-sheriff.ts # Semantic violation detection
│   │   ├── live-wire.ts        # Live code injection + reload
│   │   ├── spec-code.ts        # Spec-driven code generation
│   │   └── common.ts           # Shared utilities (jsonl, file ops)
│   │
│   ├── security/               # Security-related engines
│   │   └── self-defending.ts   # Auto-patch generation for vulnerabilities
│   │
│   ├── quality/                # Code quality + testing engines
│   │   ├── property-tests.ts   # Property-based test generation
│   │   └── smt.ts              # SMT solver for edge case finding
│   │
│   ├── refactor/               # Refactoring tools
│   │   └── ts-compiler.ts      # TypeScript compiler API wrapper
│   │
│   ├── runtime/                # Runtime debugging + replay
│   │   └── replay.ts           # Command/test execution replay engine
│   │
│   ├── timeline/               # Timeline analysis
│   │   └── symptom-bisect.ts   # Binary search for failure root cause
│   │
│   ├── integrations/           # External service integrations
│   │   ├── telemetry/          # Mesh Brain telemetry + signal scoring
│   │   │   └── manager.ts
│   │   ├── issues/             # Issue tracking integration
│   │   │   └── manager.ts
│   │   └── chatops/            # Chat platform integration
│   │       └── manager.ts
│   │
│   └── audit/                  # Audit logging
│       └── logger.ts
│
├── dist/                       # Compiled output (tsconfig: outDir)
│   └── index.js, daemon.js, *.js (auto-generated, not committed)
│
├── mesh-core/                  # JavaScript workspace analysis library
│   ├── src/                    # .js files (not .ts)
│   │   ├── MeshServer.js
│   │   ├── workspace-operations.js
│   │   ├── workspace-helpers.js
│   │   ├── tree-sitter-worker.cjs
│   │   ├── compression-core.cjs
│   │   └── logger.js
│   └── lib/                    # Compiled output (package.json: main points here)
│
├── packages/                   # Monorepo packages
│   ├── mesh-brain/            # Pattern database client
│   │   ├── dna.ts
│   │   └── index.ts
│   └── mesh-chatops/          # Chat integration
│       └── index.ts
│
├── worker/                    # Cloudflare Worker (Mesh LLM proxy)
│   └── (separate TypeScript project)
│
├── video/                     # Video rendering (Remotion)
│   └── (separate TypeScript/React project)
│
├── scripts/                   # Build & utility scripts
│   ├── minify.js             # Post-build minification
│   ├── postinstall.cjs       # Post-install setup
│   ├── run-tests.cjs         # Test runner
│   ├── run-eval.ts           # Benchmark runner
│   └── update-brew.sh        # Homebrew release updater
│
├── benchmarks/                # Evaluation suite
│   ├── mesh-cli-niah.ts      # NIAH (Needle in Haystack) benchmark
│   ├── mesh-cli-swe.ts       # Software engineering benchmark
│   ├── mini_swe_bedrock_model.py
│   └── results/              # Benchmark output (json, md, traj)
│
├── docs/                      # User documentation
│   ├── mesh-cli-command-guide.md
│   └── self-host.md
│
├── helm/                      # Kubernetes Helm charts
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/deployment.yaml
│
├── assets/                    # Static assets
│   └── mesh-banner.svg
│
├── plans/                     # Long-term roadmap
│   └── moonshot-autonomy-plan.md
│
├── config.toml               # Local configuration (workspace-specific)
├── docker-compose.yml        # Docker compose (self-hosted deployment)
├── package.json              # Main project manifest
├── tsconfig.json             # TypeScript configuration
├── .prettierrc                # Code formatter config
└── .eslintrc                  # Linter config
```

## Directory Purposes

**src/:** 
- Purpose: Main TypeScript source code
- Contains: Core agent, tool backends, workspace analysis, moonshot engines
- Key files: `index.ts` (CLI), `agent-loop.ts` (orchestrator), `local-tools.ts` (tools)

**src/moonshots/:**
- Purpose: High-value specialized operations (research/experimental features)
- Contains: 22 engine implementations, each with distinct capability
- Key files: `precrime.ts`, `tribunal.ts`, `semantic-git.ts`
- Pattern: Self-contained, stores state in `.mesh/` directory

**src/agents/:**
- Purpose: Multi-agent orchestration and role-specific behaviors
- Contains: Persona loading, critic/redteam agents
- Pattern: Agents spawned by `AgentOs.spawn()`, tracked in timeline system

**src/integrations/:**
- Purpose: External service integrations (telemetry, issues, chat)
- Contains: Manager classes for each integration type
- Pattern: Lazy-loaded, optional, can fail gracefully

**dist/:**
- Purpose: Compiled JavaScript output
- Generated by: `npm run build` (tsc + minify)
- Not committed to git

**mesh-core/:**
- Purpose: Workspace analysis library (JavaScript, not TypeScript)
- Contains: Tree-sitter bindings, workspace operations, compression utilities
- Pattern: C++ native modules compiled to .js/.cjs
- Consumed by: `src/workspace-index.ts` and `src/local-tools.ts`

**packages/:**
- Purpose: Internal npm packages (monorepo)
- Contains: `mesh-brain`, `mesh-chatops`
- Pattern: Independently versioned, can be published

**scripts/:**
- Purpose: Build, post-install, test automation
- Key files: `minify.js` (reduce dist size), `run-tests.cjs` (test orchestration)

**benchmarks/:**
- Purpose: Evaluation suite for agent performance
- Contains: NIAH (retrieval), SWE (software engineering) benchmarks
- Output: `results/` directory with JSON + Markdown reports

## Key File Locations

**Entry Points:**
- `src/index.ts` - CLI entry point (100 lines, orchestrates backend setup)
- `src/daemon.ts` - Daemon process entry (200+ lines)

**Configuration:**
- `src/config.ts` - Runtime configuration loading (267 lines)
- `package.json` - Project manifest, dependencies, bin entries
- `tsconfig.json` - TypeScript compiler options (strict mode enabled)

**Core Logic:**
- `src/agent-loop.ts` - Main agent turn executor (197KB, 6000+ LOC)
- `src/local-tools.ts` - All workspace/runtime tools (254KB, 8000+ LOC)
- `src/llm-client.ts` - LLM API communication (11KB)
- `src/context-assembler.ts` - Token budgeting (13KB)

**Testing:**
- Test files co-located with source (not detected in structure scan)
- Test runner: `npm run test` → `scripts/run-tests.cjs`

**State Storage:**
- Session data: `.mesh/capsules/` (workspace-local)
- Timelines: `~/.config/mesh/timelines/[hash]/` (user-global)
- Index cache: `~/.config/mesh/workspace-index/[hash]/` (user-global)
- Brain state: `.mesh/brain.json` (workspace-local)

## Naming Conventions

**Files:**
- TypeScript source: `camelCase.ts` (e.g., `agent-loop.ts`, `workspace-index.ts`)
- Utility files: `kebab-case.ts` (e.g., `command-safety.ts`)
- JavaScript (legacy): `camelCase.js` (e.g., `MeshServer.js`)

**Directories:**
- Domain modules: `lowercase-plural` (e.g., `moonshots/`, `agents/`, `integrations/`)
- Feature groups: `lowercase` (e.g., `security/`, `quality/`, `refactor/`)

**Functions & Classes:**
- Classes: `PascalCase` (e.g., `AgentLoop`, `LocalToolBackend`)
- Functions: `camelCase` (e.g., `runDaemonCli()`, `assertCommandAllowed()`)
- Enums/Types: `PascalCase` (e.g., `CodeQueryMode`, `TimelineStatus`)

**Tool Names (via LocalToolBackend):**
- Format: `namespace.operation` (e.g., `workspace.ask_codebase`, `workspace.read_file`)
- Namespaces: `workspace`, `runtime`, `agent`, specific moonshots
- Operations: `snake_case` (e.g., `ask_codebase`, `explain_symbol`, `apply_patch`)

## Where to Add New Code

**New Workspace Tool:**
- Primary code: `src/local-tools.ts` - Add case in `callTool()` switch statement (search for "workspace.")
- Tool definition: Add `{ name, description, inputSchema }` to tools list
- Validation: Define schema, validate via `validateToolInput()` at tool entry

**New Moonshot Engine:**
- Implementation: `src/moonshots/[feature-name].ts`
- Pattern: Extend class with `async run(args)` method, store state in `.mesh/[feature]/`
- Registration: Import in `src/local-tools.ts`, add case in moonshot routing
- Example: `src/moonshots/precrime.ts` (precrime analysis engine)

**New Integration Manager:**
- Implementation: `src/integrations/[service-name]/manager.ts`
- Pattern: Manager class with `initialize()` and `execute()` methods
- Registration: Import in `src/local-tools.ts`, instantiate in `LocalToolBackend` constructor
- Example: `src/integrations/telemetry/manager.ts`

**Utility Functions:**
- Shared helpers: `src/moonshots/common.ts` (for moonshot utilities)
- General utilities: Create module-specific file (e.g., `string-utils.ts`)
- Do not pollute root `src/` with utility files

**New Multi-Agent Type:**
- Persona definition: `src/agents/[role].ts` (implements agent behavior)
- Loader integration: Update `PersonaLoader` in `src/agents/persona-loader.ts`
- Example: `src/agents/critic.ts` (code review agent)

## Special Directories

**`.mesh/` (workspace-local state):**
- Purpose: Store session capsules, brain state, moonshot outcomes
- Generated: Yes (created on first run)
- Committed: No (gitignored)
- Contents:
  - `capsules/` - Session history
  - `brain.json` - Pattern contributions
  - `precrime/` - Predictive incident outcomes
  - `timelines/` - Experiment metadata
  - `logs/` - Execution logs

**`~/.config/mesh/` (user-global state):**
- Purpose: User settings, workspace indexes, shared timeline state
- Generated: Yes (created on first run)
- Committed: No (user machine only)
- Contents:
  - `settings.json` - User preferences
  - `agents/[workspace-hash]/` - Agent records
  - `timelines/[workspace-hash]/` - Timeline worktrees/snapshots
  - `workspace-index/[workspace-hash]/` - Embedding cache

**`dist/`:**
- Purpose: Compiled output
- Generated: Yes (by `npm run build`)
- Committed: No (gitignored)
- Pattern: TypeScript compiled to ES2022 modules + minified via Terser

**`node_modules/`:**
- Purpose: Dependencies (lockfile: `package-lock.json`)
- Generated: Yes (by `npm install`)
- Committed: No (gitignored)

---

*Structure analysis: 2026-04-27*
