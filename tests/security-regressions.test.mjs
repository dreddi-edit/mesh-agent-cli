import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard token is not rendered into server-generated HTML", () => {
  const serverSource = readFileSync(new URL("../src/dashboard-server.ts", import.meta.url), "utf8");
  const clientSource = readFileSync(new URL("../dashboard/src/useDashboardSocket.ts", import.meta.url), "utf8");

  assert.doesNotMatch(serverSource, /DASHBOARD_TOKEN='\$\{sessionToken\}'/);
  assert.doesNotMatch(serverSource, /renderHtml|renderLegacyHtml/);
  assert.match(clientSource, /sessionStorage\.getItem\("meshDashboardToken"\)/);
  assert.match(clientSource, /location\.hash/);
  assert.match(serverSource, /WebSocketServer/);
  assert.match(serverSource, /mode: 0o600/);
});

test("react dashboard does not use innerHTML rendering or fetch polling", () => {
  const clientSources = [
    readFileSync(new URL("../dashboard/src/App.tsx", import.meta.url), "utf8"),
    readFileSync(new URL("../dashboard/src/useDashboardSocket.ts", import.meta.url), "utf8")
  ].join("\n");
  const serverSource = readFileSync(new URL("../src/dashboard-server.ts", import.meta.url), "utf8");

  assert.doesNotMatch(clientSources, /innerHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(clientSources, /\bfetch\(/);
  assert.doesNotMatch(serverSource, /\/api\/state|\/api\/actions/);
});

test("daemon socket permissions are applied after listen creates the socket", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
  const listenIndex = source.indexOf("server.listen(DAEMON_SOCKET_PATH");
  const chmodIndex = source.indexOf("fs.chmod(DAEMON_SOCKET_PATH, 0o600", listenIndex);

  assert.ok(listenIndex > -1, "daemon must listen on the configured socket path");
  assert.ok(chmodIndex > listenIndex, "socket chmod must happen after listen creates it");
});

test("workspace MCP is opt-in and MCP subprocesses do not inherit full env by default", () => {
  const runtimeApi = readFileSync(new URL("../src/runtime-api.ts", import.meta.url), "utf8");
  const mcpClient = readFileSync(new URL("../src/mcp-client.ts", import.meta.url), "utf8");

  assert.match(runtimeApi, /shouldLoadWorkspaceMcp/);
  assert.match(runtimeApi, /MESH_ENABLE_WORKSPACE_MCP/);
  assert.doesNotMatch(runtimeApi, /includeWorkspaceMcp !== false/);
  assert.match(mcpClient, /MESH_MCP_INHERIT_ENV/);
  assert.doesNotMatch(mcpClient, /env: process\.env/);
});

test("self-defense regex probing uses worker threads instead of node -e subprocesses", () => {
  const source = readFileSync(new URL("../src/security/self-defending.ts", import.meta.url), "utf8");

  assert.match(source, /node:worker_threads/);
  assert.doesNotMatch(source, /process\.execPath,\s*\[\s*["']-e["']/);
});
