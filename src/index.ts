#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentLoop } from "./agent-loop.js";
import { AuthManager } from "./auth.js";
import { loadConfig } from "./config.js";
import { LocalToolBackend } from "./local-tools.js";
import { McpClient } from "./mcp-client.js";
import { ToolBackend } from "./tool-backend.js";
import { CompositeToolBackend } from "./composite-backend.js";
import { runDaemonCli } from "./daemon.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const auth = new AuthManager();

  // Handle `mesh logout` shorthand
  if (process.argv[2] === "logout") {
    await auth.signOut();
    return;
  }

  if (process.argv[2] === "daemon") {
    const code = await runDaemonCli(process.argv.slice(3));
    process.exitCode = code;
    return;
  }

  // Auth gate — blocks until user is logged in
  const user = await auth.ensureAuthenticated();
  void user; // available for per-user features (e.g. namespaced capsule cache)

  let backend: ToolBackend | null = null;

  try {
    const localBackend = new LocalToolBackend(config.agent.workspaceRoot, config);
    const backends: ToolBackend[] = [localBackend];

    // Load MCPs from .mesh/mcp.json
    const mcpConfigPath = path.join(config.agent.workspaceRoot, ".mesh", "mcp.json");
    try {
      const mcpRaw = await fs.readFile(mcpConfigPath, "utf8");
      const mcpServers = JSON.parse(mcpRaw);
      for (const [name, serverConfig] of Object.entries(mcpServers)) {
        if ((serverConfig as any).command) {
          const client = new McpClient((serverConfig as any).command, (serverConfig as any).args || []);
          await client.initialize();
          backends.push(client);
        }
      }
    } catch {
      // Ignore if missing
    }

    if (config.agent.mode === "mcp") {
      const command = config.mcp.command;
      if (!command) {
        throw new Error("MCP mode selected but no MESH_MCP_COMMAND configured");
      }
      const mcp = new McpClient(command, config.mcp.args);
      await mcp.initialize();
      backends.push(mcp);
    }

    backend = new CompositeToolBackend(backends);

    const agent = new AgentLoop(config, backend);
    const prompt = process.argv.slice(2).join(" ");
    await agent.runCli(prompt);
  } finally {
    if (backend) {
      await backend.close();
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exitCode = 1;
});
