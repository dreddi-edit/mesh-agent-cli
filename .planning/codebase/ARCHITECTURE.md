# Architecture

**Analysis Date:** 2026-04-27

## Pattern Overview

**Overall:** Agentic CLI with pluggable tool backends and composable "moonshot" engines

**Key Characteristics:**
- Multi-layer abstraction: CLI → Agent Loop → Tool Backends → LLM Client
- Context budgeting with multi-tier compression (RecallMax deduplication)
- Pluggable tool infrastructure supporting local tools, MCP, and custom backends
- Timeline-based experimentation for safe verification before promotion
- State machine progression: ready → reviewed → merged/rejected
- Moonshot engines for high-value specialized operations (precrime, self-defending, tribunal)
- Workspace indexing with semantic embeddings for code discovery

## Layers

**Presentation Layer (CLI/Interface):**
- Purpose: User interaction, command parsing, output formatting
- Location: `src/index.ts`, `src/agent-loop.ts` (REPL/turn handling)
- Contains: CLI argument parsing, markdown rendering, voice I/O, prompts
- Depends on: Agent loop, tool backends, LLM client
- Used by: End users via terminal, script invocation

**Agent Loop (Orchestration):**
- Purpose: Main agentic turn executor—accepts user input, calls LLM, routes tool execution, collects results
- Location: `src/agent-loop.ts` (197KB file, primary orchestrator)
- Contains: Turn lifecycle management, token budgeting, message transcript, tool routing, error handling
- Depends on: LLM client, tool backends, context assembler, voice manager, state managers
- Used by: CLI entry point (`src/index.ts`), daemon runtime

**Tool Backend Layer (Extensibility):**
- Purpose: Abstract tool invocation—local tools, MCP servers, custom engines
- Location: 
  - Base interface: `src/tool-backend.ts`
  - Local implementation: `src/local-tools.ts` (254KB file, monolithic implementation)
  - MCP client: `src/mcp-client.ts`
  - Composite router: `src/composite-backend.ts`
- Contains: Tool discovery, tool execution with validation, progress streaming, approval gates
- Depends on: Workspace index, workspace operations, user approval flows
- Used by: Agent loop for all tool calls

**Workspace Context Layer (Code Intelligence):**
- Purpose: Index, query, and understand the codebase semantically
- Location: 
  - Indexing: `src/workspace-index.ts`
  - Brain (pattern matching): `src/mesh-brain.ts`
  - MCP adapter: `src/mesh-core-adapter.ts`
- Contains: Tree-sitter parsing, semantic embeddings, symbol tracking, impact analysis
- Depends on: Tree-sitter via mesh-core, transformers for embeddings, cache manager
- Used by: Local tools for context queries, precrime analysis, refactoring decisions

**LLM Communication Layer:**
- Purpose: Bedrock Converse API abstraction with fallback models
- Location: `src/llm-client.ts`
- Contains: Model selection, request building, response parsing, usage tracking
- Depends on: Config (model ID, endpoint, tokens), tool specifications
- Used by: Agent loop for all LLM calls

**Context Assembly Layer (Token Optimization):**
- Purpose: Budget and compress multi-part context—system prompt, history, current turn, tools, runtime state
- Location: `src/context-assembler.ts`
- Contains: Token counting, deduplication (RecallMax), history trimming, context prioritization
- Depends on: Session summaries, runtime context, tool specs
- Used by: Agent loop before each LLM call

**State & Storage Layer:**
- Purpose: Persist and retrieve session/execution state
- Location:
  - Session capsules: `src/session-capsule-store.ts`
  - Timeline manager: `src/timeline-manager.ts`
  - Cache manager: `src/cache-manager.ts`
  - Context artifacts: `src/context-artifacts.ts`
- Contains: Session history, workspace snapshots (timelines), embedding cache, artifact storage
- Depends on: File system, git (for worktrees)
- Used by: Agent loop, moonshot engines, workspace tools

**Configuration Layer:**
- Purpose: Load and validate runtime configuration
- Location: `src/config.ts`
- Contains: Model ID selection, workspace root resolution, MCP mode flags, telemetry settings
- Depends on: Environment variables, user settings file, local workspace settings
- Used by: All layers for runtime configuration

## Data Flow

**Single Turn (User Input → Tool Execution → LLM Response):**

1. User enters prompt at CLI
2. `index.ts` routes to `AgentLoop.runCli(prompt)`
3. AgentLoop:
   - Creates/loads session capsule (history, runtime context, summary)
   - Calls `ContextAssembler.assemble()` with:
     - System prompt
     - Conversation history (trimmed by token budget)
     - Current turn messages
     - Available tools
     - Runtime context (from RuntimeObserver)
   - Invokes `LlmClient.converse()` with assembled context
4. LLM returns either text or tool calls
5. For each tool call:
   - Route via `CompositeToolBackend.callTool(name, args)`
   - Local tools (`LocalToolBackend`) process immediately
   - MCP tools delegate to MCP server
   - Tool results collected
6. Tool results appended to transcript
7. If max steps reached or LLM ends turn, return to user
8. Else, loop back to step 3 with tool results in history

**Workspace Query (e.g., `workspace.ask_codebase`):**

1. Query routed to `LocalToolBackend.callTool("workspace.ask_codebase", args)`
2. Query rewritten by `WorkspaceIndex.ask()` using embeddings + code search
3. Results scored and ranked by semantic relevance
4. Tree-sitter symbols resolved via `MeshCoreAdapter`
5. Context artifact created and stored
6. Summary returned to agent

**Timeline Experiment (e.g., `agent.spawn`, `agent.review`):**

1. `AgentOs.spawn()` creates new timeline (git worktree or copy) and agent record
2. Changes applied via `TimelineManager.applyPatch()`
3. Verification commands run via `TimelineManager.run()`
4. Results compared and verdict computed
5. `AgentOs.review()` presents timeline diff to user
6. On approval, `TimelineManager.promote()` merges back to main branch

**Moonshot Invocation (e.g., `workspace.precrime`):**

1. Query routed to appropriate engine (e.g., `PrecrimeEngine.run()`)
2. Engine performs analysis:
   - Collect changed files
   - Score each for risk
   - Fetch historical patterns (local or remote via Mesh Brain)
   - Generate predictions + preventive actions
3. Store metadata (jsonl, json) under `.mesh/`
4. Return structured predictions to agent

**State Management:**

- **Session state:** Persisted in `SessionCapsuleStore` (wrapped in .mesh directory)
- **Execution artifacts:** Stored in context artifact store for later retrieval
- **Timeline state:** Managed by `TimelineManager` in `~/.config/mesh/timelines/[hash]/`
- **Workspace index:** Cached in `~/.config/mesh/workspace-index/[hash]/`
- **Runtime context:** Built fresh each turn by `RuntimeObserver` (process state, recent files, errors)

## Key Abstractions

**ToolBackend Interface:**
- Purpose: Pluggable tool provider abstraction
- Examples: `LocalToolBackend`, `McpClient`, `CompositeToolBackend`
- Pattern: Each backend implements `listTools()` and `callTool(name, args)` contract

**Timeline Record:**
- Purpose: Isolated experimental workspace for testing changes
- Examples: git worktree (preferred) or filesystem copy
- Lifecycle: created → patched → run → promoted/rejected

**Context Artifact:**
- Purpose: Store intermediate computation results for reuse across turns
- Pattern: Lazy-loaded, cached, with versioning support
- Examples: workspace query results, test outputs, compilation diagnostics

**Moonshot Engine:**
- Purpose: Specialized high-value operation with its own state management
- Examples: `PrecrimeEngine`, `TribunalEngine`, `SemanticGitEngine`
- Pattern: Self-contained `run(args)` method, stores outcomes in `.mesh/`

**WorkspaceIndex:**
- Purpose: Semantic codebase understanding via embeddings + AST
- Pattern: Lazy embedding generation, batch caching, mode-specific queries
- Modes: architecture, bug, edit-impact, test-impact, ownership, recent-change, runtime-path

## Entry Points

**CLI Entry (`src/index.ts`):**
- Location: `src/index.ts`
- Triggers: `mesh <prompt>` or `mesh-agent <prompt>` command
- Responsibilities: 
  - Load config and auth
  - Build tool backend stack (local + MCP + custom)
  - Instantiate agent loop
  - Run agent with provided prompt
  - Clean shutdown on signal

**Daemon Entry (`src/daemon.ts`):**
- Location: `src/daemon.ts`
- Triggers: `mesh daemon start|status|stop|digest` command
- Responsibilities:
  - Long-running background process for predictive repair
  - Socket-based communication with CLI for state queries
  - Periodic workspace analysis (when system idle)
  - Contributes telemetry to Mesh Brain

**MCP Server Mode (`src/index.ts` line 74-82):**
- Location: Integrated in `src/index.ts` main()
- Triggers: `AGENT_MODE=mcp` environment variable
- Responsibilities:
  - Load MCP server from `MESH_MCP_COMMAND` env var
  - Add MCP backend to tool stack
  - Otherwise operate identically to local mode

**Runtime API (`src/runtime-api.ts`):**
- Location: `src/runtime-api.ts`
- Triggers: Embedded in agent loop for headless operation
- Responsibilities: Expose agent as programmatic API (not CLI-bound)

## Error Handling

**Strategy:** Typed errors with recovery pathways—tools fail gracefully, agent continues

**Patterns:**
- Tool execution errors caught at `LocalToolBackend.callTool()`, returned as error content blocks
- LLM failures trigger fallback model chain (primary → fallback[0] → fallback[1])
- Timeline operations use git error detection for graceful degradation (git-worktree → copy)
- Validation errors raised via `ToolInputValidationError` with schema reference
- Command safety checks via `assertCommandAllowed()` pre-execution; safe failures only

## Cross-Cutting Concerns

**Logging:** 
- Tool: `StructuredLogger` in `src/structured-logger.ts`
- Pattern: JSON-structured logs with timestamps, context correlation
- Location: `.mesh/logs/` or stderr depending on mode

**Validation:** 
- Tool: `validateToolInput()` in `src/tool-schema.ts`
- Pattern: JSON Schema validation on all tool inputs
- Enforcement: Called before tool execution in `LocalToolBackend`

**Authentication:** 
- Tool: `AuthManager` in `src/auth.ts`
- Pattern: OS keychain integration (via keytar), fallback to token file
- Enforcement: Gate at CLI entry point

**Telemetry & Observability:**
- Pattern: Optional, opt-in via Mesh Brain contribution toggle
- Components: `MeshBrainClient` for pattern queries, `TelemetryManager` for signal scoring
- Storage: Local jsonl files in `.mesh/` with remote sync capability

**Command Safety:**
- Tool: `assertCommandAllowed()` in `src/command-safety.ts`
- Pattern: Whitelist-based (safe shell commands) + explicit approval gates for unsafe ops
- Enforcement: All tool calls validated before execution

---

*Architecture analysis: 2026-04-27*
