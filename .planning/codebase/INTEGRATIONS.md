# External Integrations

**Analysis Date:** 2026-04-27

## APIs & External Services

**Large Language Model (LLM):**
- AWS Bedrock Converse API - LLM inference for agent reasoning
  - SDK/Client: Custom HTTP client in `src/llm-client.ts`
  - Auth: Bearer token (BEDROCK_API_KEY, BEDROCK_BEARER_TOKEN, or AWS_BEARER_TOKEN_BEDROCK)
  - Default endpoint: Mesh shared proxy at https://mesh-llm.edgar-baumann.workers.dev
  - Alternative: Direct Bedrock at `https://bedrock-runtime.<region>.amazonaws.com` (BYOK mode)
  - Models: Claude Sonnet 4.6 (primary), Claude Opus 4.6, Claude Haiku 4.5

**Mesh Brain (Optional ML Insights):**
- Mesh Brain endpoint - Query patterns for optimization suggestions, DNA fingerprinting
  - SDK/Client: `src/mesh-brain.ts`
  - Authentication: None (public endpoint if configured)
  - Endpoint: Via `MESH_BRAIN_ENDPOINT` environment variable
  - Capabilities: Pattern matching, repository DNA analysis, telemetry contribution

**Mesh Portal (Browser Automation):**
- Chrome DevTools Protocol (CDP) - Browser control for UI capture and interaction
  - SDK/Client: Custom CDP client in `src/mesh-portal.ts`
  - No auth required (local Chrome instance)
  - Spawns Chrome headlessly with debugging port

## Data Storage

**Databases:**
- Supabase PostgreSQL (optional, L2 cache only)
  - Connection: Via `SUPABASE_URL` / `SUPABASE_KEY`
  - ORM: Supabase JS client (`@supabase/supabase-js`)
  - Table: `capsules` - Stores generated code analysis results

**File Storage:**
- Local filesystem only for L1 cache
  - L1 cache path: `~/.cache/mesh-agent-cache/{workspace-hash}/`
  - Stores JSON serialized code analysis artifacts

**Caching (Two-Tier):**
- L1 Cache: Local file system (per-workspace, temp directory)
- L2 Cache: Supabase PostgreSQL (optional, team/cross-machine sharing)
- No in-memory caching framework; simple Map-based queue in `src/cache-manager.ts`

## Authentication & Identity

**Auth Provider:**
- Supabase Auth (email/password)
  - Implementation: `src/auth.ts`
  - Public Supabase URL: https://msmonxiacxhendxehezw.supabase.co
  - Anon key: Built-in, Row Level Security enforced
  - Session storage: `~/.config/mesh/session.json`
  - Refresh tokens: System keychain via `keytar`

**MCP (Model Context Protocol):**
- Optional MCP server integration for tool backends
  - Spawned via `MESH_MCP_COMMAND` and `MESH_MCP_ARGS`
  - Communication: stdio-based JSON-RPC

## Monitoring & Observability

**Error Tracking:**
- None actively integrated; optional Sentry endpoint (stub in `src/integrations/telemetry/sentry.ts`)

**Logs:**
- Structured logging to file system
  - Logger: `src/structured-logger.ts`
  - Path: `.mesh/debug.log` or specified log path
  - Format: JSON lines

**Telemetry (Opt-in):**
- Telemetry contribution mode (opt-in via settings)
- Sends anonymized patterns to Mesh Brain for ML improvement
- Endpoint: Configurable via `MESH_BRAIN_ENDPOINT`

## CI/CD & Deployment

**Hosting:**
- **CLI:** npm registry distribution as `@edgarelmo/mesh-agent-cli`
- **Worker (LLM Proxy):** Cloudflare Workers at https://mesh-llm.edgar-baumann.workers.dev
- **Core Proxy:** Express server (mesh-core) for local development/testing

**CI Pipeline:**
- GitHub Actions via `.github/workflows/`
- No explicit CD shown in package.json; manual `wrangler deploy` for worker

## Environment Configuration

**Required env vars (with defaults):**
- None strictly required for basic usage; all have sensible defaults

**Critical for full features:**
- `SUPABASE_URL` / `SUPABASE_KEY` - For cloud cache and team collaboration
- `BEDROCK_API_KEY` - Only if using BYOK (bring-your-own-key Bedrock); else proxy provides it
- `MESH_BRAIN_ENDPOINT` - For pattern matching and repository DNA analysis

**Secrets location:**
- System keychain (via `keytar`) - Refresh tokens
- `.env` file (not committed) - Local overrides
- Supabase auth JWT - Bearer token in requests

## Webhooks & Callbacks

**Incoming:**
- Dashboard server at `http://localhost:5555` (configurable)
  - Endpoint: `src/dashboard-server.ts`
  - Serves static dashboard UI for timeline/history visualization

**Outgoing:**
- Optional Mesh Brain telemetry contributions (POST to brain endpoint)
- Bedrock Converse requests (POST to bedrock-runtime)

## Issue Tracking Integration (Stubs)

**GitHub Issues:**
- Integration stub at `src/integrations/issues/github.ts`
- Status: Not fully implemented (returns filtered fallback data)

**Jira:**
- Integration stub at `src/integrations/issues/jira.ts`
- Status: Not fully implemented (returns filtered fallback data)

**Linear:**
- Integration stub at `src/integrations/issues/linear.ts`
- Status: Not fully implemented

## Related Services

**Mesh Core Adapter:**
- Communicates with mesh-core for advanced code analysis
  - Import: `src/mesh-core-adapter.ts`
  - Spawns mesh-core process locally or connects to running instance
  - Protocol: stdio/HTTP

**Timeline Management:**
- Local timeline persistence for conversation history
  - Storage: `.mesh/history/`
  - Format: JSON timeline entries with execution context

---

*Integration audit: 2026-04-27*
