const NVIDIA_ENDPOINT_BASE = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_CHAT_MODELS = [
  "qwen/qwen3-coder-480b-a35b-instruct",
  "moonshotai/kimi-k2.5",
  "mistralai/devstral-2-123b-instruct-2512",
  "deepseek-ai/deepseek-v3.2",
  "meta/llama-3.3-70b-instruct"
] as const;
export const DEFAULT_NVIDIA_EMBEDDING_MODELS = [
  "nvidia/nv-embedcode-7b-v1",
  "nvidia/nv-embed-v1",
  "snowflake/arctic-embed-l"
] as const;
export const DEFAULT_NVIDIA_VISION_MODELS = [
  "meta/llama-3.2-90b-vision-instruct",
  "microsoft/phi-4-multimodal-instruct",
  "microsoft/phi-3-vision-128k-instruct"
] as const;
export const DEFAULT_NVIDIA_SAFETY_MODELS = [
  "meta/llama-guard-4-12b",
  "nvidia/llama-3.1-nemotron-safety-guard-8b-v3"
] as const;
export const DEFAULT_NVIDIA_PII_MODELS = [
  "nvidia/gliner-pii"
] as const;

export interface NvidiaChatCompletionRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface NvidiaChatCompletionChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

export interface NvidiaChatCompletionResponse {
  id?: string;
  choices?: NvidiaChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function isNvidiaHostedModel(modelId: string): boolean {
  const trimmed = modelId.trim();
  // Exclude Bedrock cross-region inference prefixes
  if (trimmed.startsWith("us.anthropic.") || trimmed.startsWith("eu.anthropic.")) return false;
  return /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(trimmed);
}

export function resolveNvidiaEndpoint(): string {
  return (process.env.NVIDIA_ENDPOINT || process.env.NVIDIA_BASE_URL || NVIDIA_ENDPOINT_BASE).trim();
}

export function resolveNvidiaApiKey(fallbackToken?: string): string | undefined {
  const direct = process.env.NVIDIA_API_KEY || process.env.NVAPI_KEY || process.env.NVIDIA_BEARER_TOKEN;
  if (direct && direct.trim()) return direct.trim();
  if (fallbackToken && fallbackToken.trim()) return fallbackToken.trim();
  return undefined;
}

function csvModels(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.filter(Boolean)));
}

export function resolveEmbeddingModels(): string[] {
  return uniqueModels([
    ...csvModels("MESH_EMBEDDING_FALLBACK_MODELS"),
    process.env.MESH_EMBEDDING_MODEL || DEFAULT_NVIDIA_EMBEDDING_MODELS[0],
    ...DEFAULT_NVIDIA_EMBEDDING_MODELS
  ]);
}

export function resolveVisionModels(): string[] {
  return uniqueModels([
    process.env.MESH_VISION_MODEL || DEFAULT_NVIDIA_VISION_MODELS[0],
    ...csvModels("MESH_VISION_FALLBACK_MODELS"),
    ...DEFAULT_NVIDIA_VISION_MODELS
  ]);
}

export function resolveSafetyModels(): string[] {
  return uniqueModels([
    process.env.MESH_SAFETY_MODEL || DEFAULT_NVIDIA_SAFETY_MODELS[0],
    process.env.MESH_SAFETY_MODEL_SECONDARY || DEFAULT_NVIDIA_SAFETY_MODELS[1],
    ...csvModels("MESH_SAFETY_FALLBACK_MODELS"),
    ...DEFAULT_NVIDIA_SAFETY_MODELS
  ]);
}

export function resolvePiiModels(): string[] {
  return uniqueModels([
    process.env.MESH_PII_MODEL || DEFAULT_NVIDIA_PII_MODELS[0],
    ...csvModels("MESH_PII_FALLBACK_MODELS"),
    ...DEFAULT_NVIDIA_PII_MODELS
  ]);
}

export async function nvidiaChatCompletion(
  request: NvidiaChatCompletionRequest,
  options: { apiKey?: string; abortSignal?: AbortSignal; baseUrl?: string; extraHeaders?: Record<string, string> } = {}
): Promise<{ response: Response; data: NvidiaChatCompletionResponse | null; rawText: string }> {
  const apiKey = resolveNvidiaApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is required for NVIDIA-hosted models.");
  }

  const base = (options.baseUrl || resolveNvidiaEndpoint()).replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(options.extraHeaders || {})
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 2048,
      stream: request.stream ?? false
    }),
    signal: options.abortSignal
  });

  const rawText = await response.text();
  let data: NvidiaChatCompletionResponse | null = null;
  try {
    data = JSON.parse(rawText) as NvidiaChatCompletionResponse;
  } catch {
    data = null;
  }
  return { response, data, rawText };
}

export async function nvidiaEmbedding(
  model: string,
  input: string,
  options: { apiKey?: string; inputType?: "query" | "passage"; abortSignal?: AbortSignal; baseUrl?: string } = {}
): Promise<number[]> {
  const apiKey = resolveNvidiaApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is required for NVIDIA embeddings.");
  }

  const payload: Record<string, unknown> = {
    model,
    input: [input]
  };
  if (options.inputType) payload.input_type = options.inputType;

  const base = (options.baseUrl || resolveNvidiaEndpoint()).replace(/\/+$/, "");
  const response = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: options.abortSignal
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`NVIDIA embeddings failed (${response.status}): ${rawText.slice(0, 240)}`);
  }
  const parsed = JSON.parse(rawText) as { data?: Array<{ embedding?: number[] }> };
  return parsed.data?.[0]?.embedding ?? [];
}

export async function nvidiaEmbeddingWithFallbacks(
  input: string,
  options: { apiKey?: string; inputType?: "query" | "passage"; abortSignal?: AbortSignal; models?: string[]; baseUrl?: string } = {}
): Promise<{ model: string; embedding: number[] }> {
  let lastError: Error | null = null;
  for (const model of options.models ?? resolveEmbeddingModels()) {
    try {
      const embedding = await nvidiaEmbedding(model, input, {
        apiKey: options.apiKey,
        inputType: options.inputType ?? (model.startsWith("nvidia/") ? "query" : undefined),
        abortSignal: options.abortSignal,
        baseUrl: options.baseUrl
      });
      if (embedding.length > 0) {
        return { model, embedding };
      }
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error("No NVIDIA embedding model produced a result.");
}

export async function analyzeImageWithNvidia(
  imageBase64: string,
  prompt: string,
  model = process.env.MESH_VISION_MODEL || DEFAULT_NVIDIA_VISION_MODELS[0],
  apiKey?: string,
  baseUrl?: string
): Promise<string> {
  let lastError: Error | null = null;
  for (const candidate of uniqueModels([model, ...resolveVisionModels()])) {
    const { response, data, rawText } = await nvidiaChatCompletion(
      {
        model: candidate,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
            ]
          }
        ],
        temperature: 0,
        maxTokens: 400
      },
      { apiKey, abortSignal: AbortSignal.timeout(30_000), baseUrl }
    );
    if (response.ok) {
      return extractNvidiaText(data);
    }
    lastError = new Error(`Vision model ${candidate} failed (${response.status}): ${rawText.slice(0, 240)}`);
  }
  throw lastError ?? new Error(`Vision model ${model} failed.`);
}

export async function classifySafetyWithNvidia(
  text: string,
  model = process.env.MESH_SAFETY_MODEL || DEFAULT_NVIDIA_SAFETY_MODELS[0],
  apiKey?: string,
  baseUrl?: string
): Promise<string> {
  let lastError: Error | null = null;
  for (const candidate of uniqueModels([model, ...resolveSafetyModels()])) {
    const { response, data, rawText } = await nvidiaChatCompletion(
      {
        model: candidate,
        messages: [
          {
            role: "user",
            content:
              "Classify the following engineering artifact for security/safety relevance. " +
              "Return a compact one-line verdict with risk level and rationale.\n\n" +
              text
          }
        ],
        temperature: 0,
        maxTokens: 160
      },
      { apiKey, abortSignal: AbortSignal.timeout(30_000), baseUrl }
    );
    if (response.ok) {
      return extractNvidiaText(data);
    }
    lastError = new Error(`Safety model ${candidate} failed (${response.status}): ${rawText.slice(0, 240)}`);
  }
  throw lastError ?? new Error(`Safety model ${model} failed.`);
}

export async function detectPiiWithNvidia(
  text: string,
  model = process.env.MESH_PII_MODEL || DEFAULT_NVIDIA_PII_MODELS[0],
  apiKey?: string,
  baseUrl?: string
): Promise<string> {
  let lastError: Error | null = null;
  for (const candidate of uniqueModels([model, ...resolvePiiModels()])) {
    const { response, data, rawText } = await nvidiaChatCompletion(
      {
        model: candidate,
        messages: [
          {
            role: "user",
            content:
              "Detect sensitive entities, credentials, tokens, or PII in the following text. " +
              "Return compact JSON if possible.\n\n" +
              text
          }
        ],
        temperature: 0,
        maxTokens: 220
      },
      { apiKey, abortSignal: AbortSignal.timeout(30_000), baseUrl }
    );
    if (response.ok) {
      return extractNvidiaText(data);
    }
    lastError = new Error(`PII model ${candidate} failed (${response.status}): ${rawText.slice(0, 240)}`);
  }
  throw lastError ?? new Error(`PII model ${model} failed.`);
}

export function extractNvidiaText(data: NvidiaChatCompletionResponse | null): string {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}
