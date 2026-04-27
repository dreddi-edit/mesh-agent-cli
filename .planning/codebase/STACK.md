# Technology Stack

**Analysis Date:** 2026-04-27

## Languages

**Primary:**
- TypeScript 5.3.3 - All source code (`src/`, `worker/`, `mesh-core/`)
- JavaScript - Build scripts and configuration

**Secondary:**
- Python - Benchmark testing suite (`benchmarks/`)

## Runtime

**Environment:**
- Node.js (latest LTS) - CLI runtime

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core CLI:**
- No traditional framework; pure Node.js with custom abstractions

**Testing:**
- Custom test runner via `scripts/run-tests.cjs`

**Build/Dev:**
- TypeScript Compiler (tsc) - Primary build tool
- tsx (^4.7.1) - TypeScript execution for development
- Terser (^5.29.1) - JavaScript minification (see `scripts/minify.js`)

**Worker (Cloudflare):**
- Wrangler (^4.84.1) - Cloudflare Workers development and deployment platform
- @cloudflare/workers-types (^4.20250121.0) - Type definitions for Workers runtime

**Additional Rendering:**
- Remotion (in `video/` subdirectory) - Video generation from React components

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` (^2.39.7) - Why it matters: Used for authentication (email/password with Supabase Auth) and optional cloud cache storage (L2 capsule cache)
- `@xenova/transformers` (^2.17.2) - Why it matters: In-process embeddings for RAG and semantic search without external ML endpoints
- `keytar` (^7.9.0) - Why it matters: Secure credential storage in system keychain (refresh tokens)

**CLI Utilities:**
- `enquirer` (^2.4.1) - Interactive prompts for user input (authentication, queries)
- `ora` (^7.0.1) - Spinner animations and status indicators
- `boxen` (^7.1.1) - Terminal box drawing for formatted output
- `picocolors` (^1.0.0) - Terminal color output without dependencies
- `marked` (^11.0.1) + `marked-terminal` (^6.2.0) - Markdown rendering in terminal

**Code Analysis & Transformation:**
- `ts-morph` (^24.0.0) - AST manipulation for TypeScript/JavaScript refactoring
- `z3-solver` (^4.13.0) - Constraint solving for code analysis

**File Operations:**
- `glob` (^11.0.0) - File pattern matching (gitignore-aware file discovery)
- `ignore` (^7.0.5) - Parse `.gitignore` for file exclusion

**Core Infrastructure:**
- `tree-sitter` + language-specific parsers (mesh-core) - Syntax tree parsing for 10+ languages (JavaScript, TypeScript, Python, Go, Rust, Java, C#, C++, PHP, Ruby, Swift, Kotlin, HTML, CSS, JSON, YAML, TOML)
- `express` (^4.19.2) - HTTP server (mesh-core proxy)
- `http-proxy` (^1.18.1) - HTTP request forwarding (mesh-core)
- `dotenv` (^16.4.5) - Environment variable loading

**Configuration Parsing:**
- `ini` (^6.0.0) - INI file parsing
- `yaml` (^2.8.3) - YAML parsing
- `toml` (^4.1.1) - TOML parsing
- `fast-xml-parser` (^5.5.10) - XML parsing
- `node-sql-parser` (^5.4.0) - SQL parsing
- `marked` (^17.0.5) - Markdown parsing

**Code Processing:**
- `html-minifier-terser` (^7.2.0) - HTML minification

## Configuration

**Environment:**
- Configured via `.env` file (optional) or environment variables
- All LLM settings are optional — defaults to shared Mesh LLM proxy
- Settings file: `~/.config/mesh/settings.json` (user-level, persistent)
- Local workspace config: `.mesh/config.json` (per-project)

**Key Env Variables:**
- `BEDROCK_ENDPOINT` - Override LLM endpoint (defaults to Mesh shared proxy)
- `AWS_BEARER_TOKEN_BEDROCK` / `BEDROCK_BEARER_TOKEN` / `BEDROCK_API_KEY` - For BYOK mode
- `BEDROCK_MODEL_ID` - Model selection
- `BEDROCK_FALLBACK_MODEL_IDS` - Comma-separated fallback models for transient failures
- `BEDROCK_TEMPERATURE` - Inference temperature (default 0)
- `BEDROCK_MAX_TOKENS` - Max tokens per response (default 3000)
- `AGENT_MAX_STEPS` - Max tool steps per turn (default 8)
- `AGENT_MODE` - "local" (default) or "mcp"
- `WORKSPACE_ROOT` - Root directory for agent operations
- `SUPABASE_URL` / `SUPABASE_KEY` - Optional cloud cache configuration
- `MESH_MCP_COMMAND` / `MESH_MCP_ARGS` - MCP mode configuration
- `MESH_BRAIN_ENDPOINT` - Optional telemetry endpoint

## Platform Requirements

**Development:**
- Node.js with npm
- TypeScript knowledge
- System keychain (for credential storage)
- Chrome/Chromium (for browser automation in mesh-portal)

**Production:**
- **CLI deployment:** Installed via npm as a global CLI package
- **Worker deployment:** Cloudflare Workers (via wrangler deploy)
- **Backend services:** Express server in mesh-core for local proxy
- **Optional services:** Supabase (for cloud cache and auth)

## Build & Deployment

**CLI Build:**
```bash
npm run build          # tsc + terser minification (output: dist/)
npm run typecheck      # Type checking only
npm run dev           # Live development with tsx
```

**Worker Build & Deploy:**
- Worker codebase at `worker/`
- Deployed to Cloudflare Workers via `wrangler deploy`
- Endpoint: `https://mesh-llm.edgar-baumann.workers.dev`
- Environment: Managed via `wrangler.toml`

**Publishing:**
- Package published to npm as `@edgarelmo/mesh-agent-cli`
- Entry points: `mesh`, `mesh-agent` (CLI), `mesh-daemon` (daemon mode)
- Private build step via `prepublishOnly` hook

---

*Stack analysis: 2026-04-27*
