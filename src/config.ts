import path from "node:path";

import { config as loadDotEnv } from "dotenv";

loadDotEnv();

/**
 * Default Mesh LLM proxy. The Cloudflare Worker injects the Bedrock API key
 * server-side so end users need no AWS credentials.
 *
 * Override with BEDROCK_ENDPOINT to point at a different proxy, or at
 * https://bedrock-runtime.<region>.amazonaws.com directly (BYOK, requires
 * AWS_BEARER_TOKEN_BEDROCK).
 */
const DEFAULT_ENDPOINT_BASE = "https://mesh-llm.edgar-baumann.workers.dev";

/**
 * Default model id on Bedrock. Elmo can override via BEDROCK_MODEL_ID.
 */
const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export function shortPathLabel(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || fullPath;
}

function optionalString(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    return fallback;
  }
  return value.trim();
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

function resolveBearerToken(): string | undefined {
  const keys = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "BEDROCK_BEARER_TOKEN",
    "BEDROCK_API_KEY"
  ];
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export interface AppConfig {
  bedrock: {
    endpointBase: string;
    bearerToken?: string;
    modelId: string;
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
  supabase: {
    url?: string;
    key?: string;
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
      endpointBase: optionalString("BEDROCK_ENDPOINT", DEFAULT_ENDPOINT_BASE),
      bearerToken: resolveBearerToken(),
      modelId: optionalString("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID),
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
    },
    supabase: {
      url: process.env.SUPABASE_URL?.trim() || undefined,
      key: process.env.SUPABASE_KEY?.trim() || undefined
    }
  };
}
