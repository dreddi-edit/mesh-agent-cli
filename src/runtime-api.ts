import fs from "node:fs/promises";
import path from "node:path";
import { AgentLoop, type HeadlessTurnResult, type RunHooks } from "./agent-loop.js";
import { AuthManager } from "./auth.js";
import { CompositeToolBackend } from "./composite-backend.js";
import { loadConfig, type AppConfig } from "./config.js";
import { LocalToolBackend } from "./local-tools.js";
import { McpClient } from "./mcp-client.js";
import type { ToolBackend } from "./tool-backend.js";

export interface MeshRuntimeOptions {
  workspaceRoot: string;
  includeWorkspaceMcp?: boolean;
  /** Skip authentication. Only set true in trusted server-side contexts where auth is handled externally. */
  skipAuth?: boolean;
}

export interface MeshRuntimeStatus {
  ok: boolean;
  workspaceRoot: string;
  mode: AppConfig["agent"]["mode"];
  modelId: string;
  toolBackends: number;
}

export class MeshRuntime {
  private readonly agent: AgentLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend,
    private readonly toolBackendCount: number
  ) {
    this.agent = new AgentLoop(config, backend);
  }

  status(): MeshRuntimeStatus {
    return {
      ok: true,
      workspaceRoot: this.config.agent.workspaceRoot,
      mode: this.config.agent.mode,
      modelId: this.config.bedrock.modelId,
      toolBackends: this.toolBackendCount
    };
  }

  async runTurn(input: string, hooks?: RunHooks): Promise<HeadlessTurnResult> {
    return this.agent.runHeadlessTurn(input, hooks);
  }

  async close(): Promise<void> {
    await this.backend.close().catch(() => undefined);
  }
}

export async function createMeshRuntime(options: MeshRuntimeOptions): Promise<MeshRuntime> {
  let accessToken: string | undefined;
  if (!options.skipAuth) {
    const auth = new AuthManager();
    await auth.ensureAuthenticated();
    accessToken = auth.getAccessToken();
  }

  const config = await loadConfig();
  config.agent.workspaceRoot = path.resolve(options.workspaceRoot);
  config.bedrock.bearerToken ||= accessToken;

  const backends: ToolBackend[] = [new LocalToolBackend(config.agent.workspaceRoot, config)];

  if (shouldLoadWorkspaceMcp(options)) {
    const mcpConfigPath = path.join(config.agent.workspaceRoot, ".mesh", "mcp.json");
    await loadWorkspaceMcpBackends(mcpConfigPath, backends);
  }

  if (config.agent.mode === "mcp") {
    if (!config.mcp.command) {
      throw new Error("MCP mode selected but no MESH_MCP_COMMAND configured");
    }
    const mcp = new McpClient(config.mcp.command, config.mcp.args);
    await mcp.initialize();
    backends.push(mcp);
  }

  return new MeshRuntime(config, new CompositeToolBackend(backends), backends.length);
}

function shouldLoadWorkspaceMcp(options: MeshRuntimeOptions): boolean {
  if (typeof options.includeWorkspaceMcp === "boolean") {
    return options.includeWorkspaceMcp;
  }
  return /^(1|true|yes)$/i.test(process.env.MESH_ENABLE_WORKSPACE_MCP ?? "");
}

async function loadWorkspaceMcpBackends(configPath: string, backends: ToolBackend[]): Promise<void> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const mcpServers = JSON.parse(raw) as Record<string, { command?: string; args?: string[] }>;
    for (const serverConfig of Object.values(mcpServers)) {
      if (!serverConfig.command) {
        continue;
      }
      const client = new McpClient(serverConfig.command, serverConfig.args ?? []);
      await client.initialize();
      backends.push(client);
    }
  } catch {
    // Missing or invalid workspace MCP config should not block local runtime startup.
  }
}
