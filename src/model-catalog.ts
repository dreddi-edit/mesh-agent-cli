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
  pricing: { inputPer1k: number; outputPer1k: number };
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    label: "Claude Sonnet 4.6",
    value: DEFAULT_MODEL_ID,
    aliases: ["sonnet4.6", "sonnet-4.6", "sonnet46"],
    note: "default",
    pricing: { inputPer1k: 0.003, outputPer1k: 0.015 }
  },
  {
    label: "Claude Opus 4.6",
    value: OPUS_MODEL_ID,
    aliases: ["opus4.6", "opus-4.6", "opus46"],
    note: "powerful",
    pricing: { inputPer1k: 0.015, outputPer1k: 0.075 }
  },
  {
    label: "Claude Haiku 4.5",
    value: HAIKU_MODEL_ID,
    aliases: ["haiku4.5", "haiku-4.5", "haiku45"],
    note: "modern fast",
    pricing: { inputPer1k: 0.00025, outputPer1k: 0.00125 }
  }
];
