#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import pc from "picocolors";
import { AgentLoop } from "./agent-loop.js";
import { AuthManager } from "./auth.js";
import { loadConfig } from "./config.js";
import { LocalToolBackend } from "./local-tools.js";
import { McpClient } from "./mcp-client.js";
import { ToolBackend } from "./tool-backend.js";
import { CompositeToolBackend } from "./composite-backend.js";
import { runDaemonCli } from "./daemon.js";
import { buildSessionManager, type SessionManager } from "./session-manager.js";
import { collectSupportInfo, formatSupportInfo } from "./support.js";

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
      "  mesh init                    run first-run setup and repo briefing",
      "  mesh doctor [fix]            run diagnostics and optional safe fixes",
      "  mesh support                 print bug-report support info",
      "  mesh \"<task>\"                 run one task",
      "  mesh daemon <start|status|digest|stop>",
      "  mesh logout",
      "  mesh --version",
      "",
      "Inside the interactive CLI, run /help for command groups."
    ].join("\n") + "\n"
  );
}

async function checkForUpdates(currentVersion: string): Promise<void> {
  const cacheDir = path.join(os.homedir(), ".config", "mesh");
  const cacheFile = path.join(cacheDir, "update-check.json");
  const now = Date.now();

  try {
    const raw = await fs.readFile(cacheFile, "utf8");
    const cache = JSON.parse(raw);
    if (cache.lastCheck && now - cache.lastCheck < 24 * 60 * 60 * 1000) {
      return;
    }
  } catch {
    // No cache or invalid
  }

  try {
    const res = await fetch("https://registry.npmjs.org/@edgarelmo/mesh-agent-cli/latest", {
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      const data = await res.json() as { version: string };
      if (data.version && data.version !== currentVersion) {
        process.stdout.write(
          [
            "",
            pc.yellow(pc.bold("  Update Available!")),
            `  Mesh version ${pc.green(data.version)} is out. (Current: ${currentVersion})`,
            `  Run ${pc.cyan("npm install -g @edgarelmo/mesh-agent-cli")} to update.`,
            ""
          ].join("\n") + "\n"
        );
      }
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ lastCheck: now, latestVersion: data.version }));
    }
  } catch {
    // Silent fail if offline or timeout
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const firstArg = args[0];
  const currentVersion = await readPackageVersion();

  if (firstArg === "--help" || firstArg === "-h" || firstArg === "help") {
    printHelp();
    return;
  }

  if (firstArg === "--version" || firstArg === "-v" || firstArg === "version") {
    process.stdout.write(`${currentVersion}\n`);
    return;
  }

  // Background update check
  void checkForUpdates(currentVersion).catch(() => null);

  if (firstArg === "support") {
    process.stdout.write(formatSupportInfo(await collectSupportInfo(await readPackageVersion())));
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

  if (firstArg === "doctor") {
    await auth.restoreAuthenticated().catch(() => null);
    config.bedrock.bearerToken ||= auth.getAccessToken();
    const localBackend = new LocalToolBackend(config.agent.workspaceRoot, config);
    const backend = new CompositeToolBackend([localBackend]);
    try {
      const agent = new AgentLoop(config, backend);
      await agent.runDoctorCli(args.slice(1));
    } finally {
      await backend.close().catch(() => undefined);
    }
    return;
  }

  if (firstArg === "init") {
    const localBackend = new LocalToolBackend(config.agent.workspaceRoot, config);
    const backend = new CompositeToolBackend([localBackend]);
    try {
      const agent = new AgentLoop(config, backend);
      await agent.runInit(args.slice(1), auth);
    } finally {
      await backend.close().catch(() => undefined);
    }
    return;
  }

  // Auth gate — blocks until user is logged in
  const user = await auth.ensureAuthenticated();
  void user; // available for per-user features (e.g. namespaced capsule cache)
  config.bedrock.bearerToken ||= auth.getAccessToken();

  let backend: ToolBackend | null = null;
  let shuttingDown = false;
  const sessionManager: SessionManager = buildSessionManager(config.agent.workspaceRoot);
  sessionManager.start();

  const closeBackend = async () => {
    if (!backend || shuttingDown) {
      return;
    }
    shuttingDown = true;
    await sessionManager.stop();
    await backend.close().catch(() => undefined);
  };
  const installSignalHandlers = () => {
    const handleSignal = (signal: NodeJS.Signals) => {
      shuttingDown = true;
      const flush = async () => {
        await sessionManager.stop();
        await backend?.close().catch(() => undefined);
      };
      flush().finally(() => {
        process.exitCode = process.exitCode || 130;
        process.stderr.write(`\nReceived ${signal}, shutting down Mesh cleanly.\n`);
        process.exit(0);
      });
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
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
    if (firstArg === "init") {
      await agent.runInit(args.slice(1));
      return;
    }
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
