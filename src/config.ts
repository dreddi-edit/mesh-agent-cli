import { config as loadDotEnv } from "dotenv";

loadDotEnv();

const TEST_BEDROCK_TOKEN =
  "ABSKQmVkcm9ja0FQSUtleS0zbzE3LWF0LTk2MDU4Mzk3MzgyNToxRkdnM2dKaGJ2U1grSkdVWHdEWG5ZZGNaMUdIT2ZxSUNPTXEvYXZCZnBYWTBFNmEzYUdtTXlsck4zTT0=";

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
  };
  mcp: {
    command: string;
    args: string[];
  };
}

export function getConfig(): AppConfig {
  const mcpArgsRaw = process.env.MESH_MCP_ARGS ?? "[]";

  return {
    bedrock: {
      endpoint: required("BEDROCK_ENDPOINT"),
      bearerToken: process.env.AWS_BEARER_TOKEN_BEDROCK || TEST_BEDROCK_TOKEN,
      modelId: process.env.BEDROCK_MODEL_ID,
      temperature: optionalNumber("BEDROCK_TEMPERATURE", 0),
      maxTokens: optionalNumber("BEDROCK_MAX_TOKENS", 1200)
    },
    agent: {
      maxSteps: optionalNumber("AGENT_MAX_STEPS", 8)
    },
    mcp: {
      command: required("MESH_MCP_COMMAND"),
      args: parseJsonArray(mcpArgsRaw, "MESH_MCP_ARGS")
    }
  };
}
