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

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Mesh CLI",
      "",
      "Usage:",
      "  mesh                         start interactive agent",
      "  mesh \"<task>\"                 run one task",
      "  mesh daemon <start|status|digest|stop>",
      "  mesh logout",
      "  mesh --version",
      "",
      "Inside the interactive CLI, run /help for command groups."
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (firstArg === "--help" || firstArg === "-h" || firstArg === "help") {
    printHelp();
    return;
  }

  if (firstArg === "--version" || firstArg === "-v" || firstArg === "version") {
    process.stdout.write(`${await readPackageVersion()}\n`);
    return;
  }

  const config = await loadConfig();
  const auth = new AuthManager();

  // Handle `mesh logout` shorthand
  if (firstArg === "logout") {
    await auth.signOut();
    return;
  }

  if (firstArg === "daemon") {
    const code = await runDaemonCli(args.slice(1));
    process.exitCode = code;
    return;
  }

  // Auth gate — blocks until user is logged in
  const user = await auth.ensureAuthenticated();
  void user; // available for per-user features (e.g. namespaced capsule cache)
  config.bedrock.bearerToken ||= auth.getAccessToken();

  let backend: ToolBackend | null = null;
  let shuttingDown = false;
  const closeBackend = async () => {
    if (!backend || shuttingDown) {
      return;
    }
    shuttingDown = true;
    await backend.close().catch(() => undefined);
  };
  const installSignalHandlers = () => {
    const handleSignal = (signal: NodeJS.Signals) => {
      void closeBackend().finally(() => {
        process.exitCode = process.exitCode || 130;
        process.stderr.write(`\nReceived ${signal}, shutting down Mesh cleanly.\n`);
      });
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  };

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
    installSignalHandlers();

    const agent = new AgentLoop(config, backend);
    const prompt = process.argv.slice(2).join(" ");
    await agent.runCli(prompt);
  } finally {
    await closeBackend();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exitCode = 1;
});
