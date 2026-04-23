#!/usr/bin/env node

import { AgentLoop } from "./agent-loop.js";
import { getConfig } from "./config.js";
import { LocalToolBackend } from "./local-tools.js";
import { McpClient } from "./mcp-client.js";
import { ToolBackend } from "./tool-backend.js";

async function main(): Promise<void> {
  const config = getConfig();
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
      backend = new LocalToolBackend(config.agent.workspaceRoot);
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
