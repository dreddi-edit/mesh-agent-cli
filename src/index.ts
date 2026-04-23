#!/usr/bin/env node

import { AgentLoop } from "./agent-loop.js";
import { getConfig } from "./config.js";
import { McpClient } from "./mcp-client.js";

async function main(): Promise<void> {
  const config = getConfig();
  const mcp = new McpClient(config.mcp.command, config.mcp.args);

  try {
    await mcp.initialize();
    const agent = new AgentLoop(config, mcp);
    const prompt = process.argv.slice(2).join(" ");
    await agent.runCli(prompt);
  } finally {
    await mcp.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exitCode = 1;
});
