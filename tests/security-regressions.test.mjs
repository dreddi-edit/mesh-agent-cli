import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard token is not rendered into server-generated HTML", () => {
  const source = readFileSync(new URL("../src/dashboard-server.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /DASHBOARD_TOKEN='\$\{sessionToken\}'/);
  assert.match(source, /sessionStorage\.getItem\('meshDashboardToken'\)/);
  assert.match(source, /location\.hash/);
  assert.match(source, /mode: 0o600/);
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
