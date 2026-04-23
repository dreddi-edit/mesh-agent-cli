import path from "node:path";

import { config as loadDotEnv } from "dotenv";

loadDotEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: ${raw}`);
  }
  return parsed;
}

function parseJsonArray(raw: string, name: string): string[] {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error("must be a JSON array of strings");
    }
    return value;
  } catch (error) {
    throw new Error(`Invalid ${name}: ${(error as Error).message}`);
  }
}

function parseMode(raw: string | undefined): "local" | "mcp" {
  const normalized = String(raw || "local").trim().toLowerCase();
  return normalized === "mcp" ? "mcp" : "local";
}

export interface AppConfig {
  bedrock: {
    endpoint: string;
    bearerToken?: string;
    modelId?: string;
    temperature: number;
    maxTokens: number;
  };
  agent: {
    maxSteps: number;
    mode: "local" | "mcp";
    workspaceRoot: string;
  };
  mcp: {
    command?: string;
    args: string[];
  };
}

export function getConfig(): AppConfig {
  const mode = parseMode(process.env.AGENT_MODE);
  const mcpArgsRaw = process.env.MESH_MCP_ARGS ?? "[]";
  const mcpCommand = process.env.MESH_MCP_COMMAND?.trim();

  if (mode === "mcp" && !mcpCommand) {
    throw new Error("Missing required env var in mcp mode: MESH_MCP_COMMAND");
  }

  return {
    bedrock: {
      endpoint: required("BEDROCK_ENDPOINT"),
      bearerToken: process.env.AWS_BEARER_TOKEN_BEDROCK,
      modelId: process.env.BEDROCK_MODEL_ID,
      temperature: optionalNumber("BEDROCK_TEMPERATURE", 0),
      maxTokens: optionalNumber("BEDROCK_MAX_TOKENS", 1200)
    },
    agent: {
      maxSteps: optionalNumber("AGENT_MAX_STEPS", 8),
      mode,
      workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT || process.cwd())
    },
    mcp: {
      command: mcpCommand,
      args: parseJsonArray(mcpArgsRaw, "MESH_MCP_ARGS")
    }
  };
}
