import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { DEFAULT_FALLBACK_MODEL_IDS, DEFAULT_MODEL_ID } from "./model-catalog.js";

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

const LEGACY_DEFAULT_MODEL_IDS = new Set([
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
]);

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

function parseCsv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeModelId(modelId: string | undefined): string {
  const trimmed = modelId?.trim();
  if (!trimmed || LEGACY_DEFAULT_MODEL_IDS.has(trimmed)) {
    return DEFAULT_MODEL_ID;
  }
  return trimmed;
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

export interface UserSettings {
  modelId: string;
  themeColor: string;
  enableCloudCache: boolean;
  telemetry?: boolean;
  customApiKey?: string;
  customEndpoint?: string;
  voice: VoiceSettings;
}

export interface VoiceSettings {
  configured: boolean;
  language: string;
  speed: number;
  voice: string;
  microphone: string;
  transcriptionModel: string;
}

export interface AppConfig {
  bedrock: {
    endpointBase: string;
    bearerToken?: string;
    modelId: string;
    fallbackModelIds: string[];
    temperature: number;
    maxTokens: number;
  };
  agent: {
    maxSteps: number;
    mode: "local" | "mcp";
    workspaceRoot: string;
    enableCloudCache: boolean;
    themeColor: string;
    voice: VoiceSettings;
  };
  mcp: {
    command?: string;
    args: string[];
  };
  supabase: {
    url?: string;
    key?: string;
  };
  telemetry: {
    contribute: boolean;
    meshBrainEndpoint?: string;
  };
}

const SETTINGS_PATH = path.join(os.homedir(), ".config", "mesh", "settings.json");
const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  configured: false,
  language: "auto",
  speed: 260,
  voice: "auto",
  microphone: "default",
  transcriptionModel: "small"
};

function normalizeVoiceSettings(value?: Partial<VoiceSettings> | null): VoiceSettings {
  const speed = Number(value?.speed);
  return {
    configured: value?.configured === true,
    language: value?.language?.trim() || DEFAULT_VOICE_SETTINGS.language,
    speed: Number.isFinite(speed) ? speed : DEFAULT_VOICE_SETTINGS.speed,
    voice: value?.voice?.trim() || DEFAULT_VOICE_SETTINGS.voice,
    microphone: value?.microphone?.trim() || DEFAULT_VOICE_SETTINGS.microphone,
    transcriptionModel:
      value?.transcriptionModel?.trim() || DEFAULT_VOICE_SETTINGS.transcriptionModel
  };
}

export async function loadUserSettings(): Promise<UserSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as UserSettings;
    const modelId = normalizeModelId(parsed.modelId);
    return {
      modelId,
      themeColor: parsed.themeColor || "cyan",
      enableCloudCache:
        typeof parsed.enableCloudCache === "boolean" ? parsed.enableCloudCache : true,
      telemetry: parsed.telemetry,
      customApiKey: parsed.customApiKey,
      customEndpoint: parsed.customEndpoint,
      voice: normalizeVoiceSettings(parsed.voice)
    };
  } catch {
    return {
      modelId: DEFAULT_MODEL_ID,
      themeColor: "cyan",
      enableCloudCache: true,
      voice: DEFAULT_VOICE_SETTINGS
    };
  }
}

export async function saveUserSettings(settings: UserSettings): Promise<void> {
  const dir = path.dirname(SETTINGS_PATH);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export async function loadConfig(): Promise<AppConfig> {
  const userSettings = await loadUserSettings();
  const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT || process.cwd());

  // Try loading local workspace settings
  let localSettings: Partial<UserSettings> = {};
  try {
    const localRaw = await fs.readFile(path.join(workspaceRoot, ".mesh", "config.json"), "utf-8");
    localSettings = JSON.parse(localRaw);
  } catch {
    // No local settings, ignore
  }

  const mode = parseMode(process.env.AGENT_MODE);
  const mcpArgsRaw = process.env.MESH_MCP_ARGS ?? "[]";
  const mcpCommand = process.env.MESH_MCP_COMMAND?.trim();
  const configuredModelId = normalizeModelId(
    process.env.BEDROCK_MODEL_ID ||
      localSettings.modelId ||
      userSettings.modelId
  );
  const envFallbackModelIds = parseCsv("BEDROCK_FALLBACK_MODEL_IDS")
    .map(normalizeModelId)
    .filter((modelId) => modelId !== configuredModelId);

  if (mode === "mcp" && !mcpCommand) {
    throw new Error("Missing required env var in mcp mode: MESH_MCP_COMMAND");
  }

  const rawEndpoint = localSettings.customEndpoint || userSettings.customEndpoint || optionalString("BEDROCK_ENDPOINT", DEFAULT_ENDPOINT_BASE);
  const endpointBase = (() => {
    try {
      const u = new URL(rawEndpoint);
      if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
        throw new Error(`BEDROCK_ENDPOINT must use HTTPS (got ${rawEndpoint})`);
      }
      return rawEndpoint;
    } catch (e) {
      if ((e as Error).message.startsWith("BEDROCK_ENDPOINT")) throw e;
      throw new Error(`Invalid BEDROCK_ENDPOINT URL: ${rawEndpoint}`);
    }
  })();

  return {
    bedrock: {
      endpointBase,
      bearerToken: localSettings.customApiKey || userSettings.customApiKey || resolveBearerToken(),
      modelId: configuredModelId,
      fallbackModelIds: envFallbackModelIds.length > 0
        ? envFallbackModelIds
        : DEFAULT_FALLBACK_MODEL_IDS.filter((modelId) => modelId !== configuredModelId),
      temperature: optionalNumber("BEDROCK_TEMPERATURE", 0),
      maxTokens: optionalNumber("BEDROCK_MAX_TOKENS", 3000)
    },
    agent: {
      maxSteps: optionalNumber("AGENT_MAX_STEPS", 8),
      mode,
      workspaceRoot,
      enableCloudCache: localSettings.enableCloudCache ?? userSettings.enableCloudCache,
      themeColor: localSettings.themeColor || userSettings.themeColor,
      voice: normalizeVoiceSettings(localSettings.voice ?? userSettings.voice)
    },
    mcp: {
      command: mcpCommand,
      args: parseJsonArray(mcpArgsRaw, "MESH_MCP_ARGS")
    },
    supabase: {
      url: process.env.SUPABASE_URL?.trim() || undefined,
      key: process.env.SUPABASE_KEY?.trim() || undefined
    },
    telemetry: {
      contribute:
        userSettings.telemetry === true ||
        process.env.MESH_TELEMETRY === "1" ||
        process.env.MESH_TELEMETRY === "true",
      meshBrainEndpoint:
        process.env.MESH_BRAIN_ENDPOINT?.trim() ||
        undefined
    }
  };
}
