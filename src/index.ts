#!/usr/bin/env node

import { AgentLoop } from "./agent-loop.js";
import { AuthManager } from "./auth.js";
import { getConfig } from "./config.js";
import { LocalToolBackend } from "./local-tools.js";
import { McpClient } from "./mcp-client.js";
import { ToolBackend } from "./tool-backend.js";

async function main(): Promise<void> {
  const config = getConfig();
  const auth = new AuthManager();

  // Handle `mesh logout` shorthand
  if (process.argv[2] === "logout") {
    await auth.signOut();
    return;
  }

  // Auth gate — blocks until user is logged in
  const user = await auth.ensureAuthenticated();
  void user; // available for per-user features (e.g. namespaced capsule cache)

  let backend: ToolBackend | null = null;
  let mcp: McpClient | null = null;

  try {
    if (config.agent.mode === "mcp") {
      const command = config.mcp.command;
      if (!command) {
        throw new Error("MCP mode selected but no MESH_MCP_COMMAND configured");
      }
      mcp = new McpClient(command, config.mcp.args);
      await mcp.initialize();
      backend = mcp;
    } else {
      backend = new LocalToolBackend(config.agent.workspaceRoot, config);
    }

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
