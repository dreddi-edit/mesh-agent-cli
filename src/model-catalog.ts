export const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
export const DEFAULT_FALLBACK_MODEL_IDS = [
  "us.anthropic.claude-haiku-4-5-20251001-v1:0"
] as const;

export const OPUS_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
export const HAIKU_MODEL_ID = DEFAULT_FALLBACK_MODEL_IDS[0];

export interface ModelCatalogEntry {
  label: string;
  value: string;
  aliases: string[];
  note: string;
  provider?: "bedrock" | "nvidia";
  pricing: { inputPer1k: number; outputPer1k: number };
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    label: "Claude 4.6 Sonnet",
    value: DEFAULT_MODEL_ID,
    aliases: ["sonnet4.6", "sonnet-4.6", "sonnet46"],
    note: "default",
    pricing: { inputPer1k: 0.003, outputPer1k: 0.015 }
  },
  {
    label: "Claude 4.6 Opus",
    value: OPUS_MODEL_ID,
    aliases: ["opus4.6", "opus-4.6", "opus46"],
    note: "powerful",
    pricing: { inputPer1k: 0.015, outputPer1k: 0.075 }
  },
  {
    label: "Claude 4.5 Haiku",
    value: HAIKU_MODEL_ID,
    aliases: ["haiku4.5", "haiku-4.5", "haiku45"],
    note: "modern fast",
    pricing: { inputPer1k: 0.00025, outputPer1k: 0.00125 }
  },
  {
    label: "Qwen 3 Coder 480B",
    value: "qwen/qwen3-coder-480b-a35b-instruct",
    aliases: ["qwen3coder", "qwen3-coder", "qwen-coder-480b"],
    note: "nvidia code default",
    provider: "nvidia",
    pricing: { inputPer1k: 0, outputPer1k: 0 }
  },
  {
    label: "Kimi K2.5",
    value: "moonshotai/kimi-k2.5",
    aliases: ["kimi", "kimi-k2.5", "k2.5"],
    note: "nvidia deep reasoning",
    provider: "nvidia",
    pricing: { inputPer1k: 0, outputPer1k: 0 }
  },
  {
    label: "Devstral 2 123B",
    value: "mistralai/devstral-2-123b-instruct-2512",
    aliases: ["devstral2", "devstral", "devstral-2"],
    note: "nvidia coding fallback",
    provider: "nvidia",
    pricing: { inputPer1k: 0, outputPer1k: 0 }
  },
  {
    label: "DeepSeek V3.2",
    value: "deepseek-ai/deepseek-v3.2",
    aliases: ["deepseekv3.2", "deepseek-v3.2", "deepseek32"],
    note: "nvidia strong generalist",
    provider: "nvidia",
    pricing: { inputPer1k: 0, outputPer1k: 0 }
  },
  {
    label: "Llama 3.3 70B",
    value: "meta/llama-3.3-70b-instruct",
    aliases: ["llama3.3", "llama-3.3", "llama-70b"],
    note: "nvidia robust fallback",
    provider: "nvidia",
    pricing: { inputPer1k: 0, outputPer1k: 0 }
  },
  {
    label: "Minimax M2.7",
    value: "minimax/minimax-m2.7",
    aliases: ["minimax", "minimax-m2.7", "m2.7"],
    note: "nvidia high-throughput",
    provider: "nvidia",
    pricing: { inputPer1k: 0, outputPer1k: 0 }
  }
];
