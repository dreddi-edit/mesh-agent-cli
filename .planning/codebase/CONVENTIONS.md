# Coding Conventions

**Analysis Date:** 2026-04-27

## Naming Patterns

**Files:**
- TypeScript source: `kebab-case.ts` (e.g., `agent-loop.ts`, `llm-client.ts`, `cache-manager.ts`)
- Test files: `kebab-case.test.mjs` or `kebab-case.spec.mjs` (e.g., `auth.test.mjs`, `llm-client.test.mjs`)
- Configuration: lowercase (e.g., `config.ts`, `model-catalog.ts`)
- Interfaces and types: PascalCase prefixed (e.g., `ConverseMessage`, `LlmResponse`, `CacheEntry`)

**Functions:**
- camelCase for all functions and methods
- Async functions use `async` keyword: `async loadUserSettings()`, `async getCapsule()`
- Private methods/functions prefixed with underscore or `private` keyword: `private buildUrl()`, `private readState()`
- Exported utility functions: `export function normalizeModelId()`, `export function normalizeErrorSignature()`
- Factory/builder functions use descriptive names: `buildBody()`, `buildUrl()`, `parseResponse()`

**Variables:**
- camelCase for all variables: `messageQueue`, `workspaceHash`, `supabaseClient`
- Constants in UPPER_SNAKE_CASE: `DEFAULT_MODEL_ID`, `DEFAULT_ENDPOINT_BASE`, `LEGACY_DEFAULT_MODEL_IDS`
- Acronyms preserved in constants: `SUPABASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`
- Leading underscore for unused variables: `void user;` or `const _ = unused;`

**Types and Interfaces:**
- PascalCase: `AppConfig`, `ConverseMessage`, `LlmResponse`, `AuthResult`, `CacheEntry`
- Discriminator union types use `ok` field pattern: `{ ok: true; data: T } | { ok: false; reason: string }`
- Generic type parameters: `T`, `E`, `R` (single uppercase letters)
- Nested interfaces use qualified names: `CacheEntry`, `MeshBrainClientOptions`

## Code Style

**Formatting:**
- TypeScript strict mode enabled (tsconfig.json: `"strict": true`)
- Tab width: 2 spaces (inferred from source files)
- No automatic formatter configured (no .eslintrc or .prettierrc at root)
- Import paths use `.js` extensions for ESM: `import { AgentLoop } from "./agent-loop.js"`

**Linting:**
- ESLint available but no root config
- Check: `npm run lint` runs `eslint src/**/*.ts`
- Project uses TypeScript strict mode for type safety

## Import Organization

**Order:**
1. Node.js built-in modules: `import { promises as fs } from "node:fs"`
2. Third-party packages: `import { createClient } from "@supabase/supabase-js"`
3. Local modules: `import { AgentLoop } from "./agent-loop.js"`

**Style:**
- Use named imports: `import { TimelineManager } from "./timeline-manager.js"`
- Use default imports where appropriate: `import pc from "picocolors"`
- Namespace imports for complex modules: `import { promises as fs } from "node:fs"`
- CommonJS modules aliased: `import pkg from "enquirer"; const { prompt } = pkg;`
- Always include `.js` extension for local ESM imports (required for Node.js ESM)

**Path Aliases:**
- Not used; absolute imports from `node:` or relative `.js` paths only

## Error Handling

**Patterns:**
- Explicit error catching with descriptive messages: `throw new Error("Invalid numeric env var ${name}: ${raw}")`
- Type-safe error handling: `catch (error) { const message = error instanceof Error ? error.message : String(error); }`
- Silent catches for optional operations: `catch { // Not in L1 or invalid }`
- Result types for non-thrown errors: `{ ok: true; user: MeshUser } | { ok: false; reason: string }`
- Fallback returns on catch: `catch { return null }`, `catch { return [] }`, `catch { return {} }`
- No error swallowing without explanation - comments explain intent: `catch { // Ignore if missing }`

**Error Context:**
- Include variable/field names in error messages: `Invalid ${name}:`, `Invalid session shape`
- Preserve original error messages: `catch (error) { throw new Error(\`...: ${(error as Error).message}\`) }`
- Environment validation errors early: `if (!command) { throw new Error("MCP mode selected but no MESH_MCP_COMMAND configured"); }`

**Fallback Strategy:**
- Three-tier config resolution: environment → local settings → user settings → default
- Safe optional chains: `?.trim()` to avoid null errors
- Non-null fallbacks: `process.env[name] ?? ""` then filter

## Logging

**Framework:** `console` (no logging library)

**Patterns:**
- Process stderr for errors: `process.stderr.write()`
- Process stdout for interactive prompts: `process.stdout.write()`
- Structured logging available in `StructuredLogger` class (`src/structured-logger.ts`)
- Structured format: JSON Lines (one JSON object per line)
- Timestamps: ISO 8601 `new Date().toISOString()`
- Secret redaction: fields matching `/token|secret|password|api[_-]?key|authorization/i` replaced with `[redacted]`

**StructuredLogger Usage:**
```typescript
const logger = new StructuredLogger(workspaceRoot);
await logger.write("info", "event_name", { data: value });
```

## Comments

**When to Comment:**
- Explain non-obvious decisions: `// nosec: public-supabase-anon-key` (security review markers)
- Document intentional silent failures: `// Not in L1 or invalid`, `// Ignore if missing`
- Clarify complex algorithms: shown in normalization functions, pattern matching
- Mark security-related logic: `// Prototype pollution protection` (visible in auth validation)

**JSDoc/TSDoc:**
- Used for public function documentation: `/** Restore a persisted session, or prompt login if none / expired. */`
- Multiline JSDoc blocks for module-level documentation (visible in `llm-client.ts` header)
- One-line JSDoc for simple functions: typical pattern but not required for internal functions

**Style:**
- Single-line comments for brief explanations: `// handle signal handler cleanup`
- Multiline /** */ blocks for public APIs only
- No automatic comment wrapping (no prettier config)

## Function Design

**Size:** 
- Typically 20-50 lines for utility functions
- Larger functions (100+ lines) reserved for stateful operations (`converse()`, `converseStream()`)
- Private helper methods keep public interfaces concise

**Parameters:**
- Destructured objects for multiple related params: `async getCapsule(filePath: string, tier: string, mtimeMs: number, contentHash?: string)`
- Options objects for complex configurations: `constructor(private readonly options: LlmClientOptions)`
- Type safety enforced: no implicit `any` - parameters always typed

**Return Values:**
- Promises for async operations: `Promise<T>`
- Discriminator unions for error cases: `LlmResponse = LlmResponseText | LlmResponseToolUse`
- `null` for optional results: `CacheEntry | null`
- Generator functions for streaming: `AsyncGenerator<StreamEvent>`
- Result tuples rarely used; prefer explicit types

**Naming:**
- Descriptive names: `ensureAuthenticated()`, `promptLogin()`, `buildUrl()`, `parseResponse()`
- Verb-first for actions: `load()`, `save()`, `restore()`, `build()`, `parse()`
- Predicate prefix for booleans: `is*`, `should*`, `has*`: `isSessionShape()`, `shouldTryFallback()`

## Module Design

**Exports:**
- Explicit named exports: `export function`, `export class`, `export interface`
- Classes are primary export pattern: `export class AuthManager`, `export class BedrockLlmClient`
- Type exports separate: `export interface AppConfig`, `export type AuthResult`
- No wildcard exports (`export *`)

**Barrel Files:**
- Not used; direct imports from source files
- Each module exports only its own types and classes

**File Organization:**
- Type definitions at top: interfaces, types, constants
- Class definitions next: exported classes with private methods below
- Utility functions at bottom: standalone helper functions, type guards
- Private helpers: prefixed with underscore or `private` keyword

**Dependencies:**
- Explicit dependency injection: `constructor(config: AppConfig)`, `constructor(backends: ToolBackend[])`
- Configuration passed at construction: not global state
- Service classes stateful; utility functions pure

## Type Guards and Validation

**Pattern:**
- Explicit type guards with descriptive names: `function isSessionShape(obj: unknown): obj is Omit<Session>`
- Checked properties validated: `typeof obj === "object" && obj !== null && "access_token" in obj`
- Guard-based control flow: type narrows after guard pass

**Validation:**
- Functions to validate config: `normalizeModelId()`, `normalizeVoiceSettings()`, `parseJsonArray()`
- Early return on validation failure: throw error or return default
- Environmental parsing separated: `optionalString()`, `optionalNumber()`, `parseCsv()`

---

*Convention analysis: 2026-04-27*
