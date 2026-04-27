/**
 * Bedrock Converse API client for mesh-agent-cli.
 *
 * Sends requests to an endpoint that speaks the native AWS Bedrock Converse
 * protocol at POST {endpointBase}/model/{modelId}/converse.
 *
 * In production the endpointBase points at the Mesh LLM proxy (Cloudflare
 * Worker) which injects the Bedrock API key server-side so end users do not
 * need any AWS credentials.
 *
 * Power users can also point endpointBase at bedrock-runtime directly and
 * pass a Bedrock API key via bearerToken (BYOK).
 */

import { DEFAULT_MODEL_ID } from "./model-catalog.js";

export type TextBlock = { text: string };
export type ImageBlock = {
  image: {
    format: "png" | "jpeg" | "gif" | "webp";
    source: { bytes: string }; // Base64
  };
};
export type ToolUseBlock = {
  toolUse: { toolUseId: string; name: string; input: Record<string, unknown> };
};
export type ToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: Array<{ text: string } | { json: unknown } | { image: { format: "png", source: { bytes: string } } }>;
    status?: "success" | "error";
  };
};
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface ConverseMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface LlmResponseText {
  kind: "text";
  text: string;
  stopReason: string;
  usage?: ConverseUsage;
}

export interface LlmResponseToolUse {
  kind: "tool_use";
  toolUses: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>;
  text?: string;
  stopReason: string;
  usage?: ConverseUsage;
}

export type LlmResponse = LlmResponseText | LlmResponseToolUse;

export interface ConverseUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface LlmClientOptions {
  endpointBase: string;
  modelId: string;
  fallbackModelIds?: string[];
  bearerToken?: string;
  temperature: number;
  maxTokens: number;
}

interface ConverseResponseShape {
  output?: {
    message?: {
      role?: string;
      content?: Array<
        | { text: string }
        | { toolUse: { toolUseId: string; name: string; input: unknown } }
      >;
    };
  };
  stopReason?: string;
  usage?: ConverseUsage;
}

export class BedrockLlmClient {
  constructor(private readonly options: LlmClientOptions) {}

  async converse(
    messages: ConverseMessage[],
    tools: ToolSpec[],
    systemPrompt: string | Array<{ text: string; cache_control?: any }>,
    modelIdOverride?: string,
    abortSignal?: AbortSignal,
    maxTokensOverride?: number
  ): Promise<LlmResponse> {
    const body = this.buildBody(messages, tools, systemPrompt, maxTokensOverride);

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }

    const attempts: string[] = [];
    for (const activeModelId of this.candidateModelIds(modelIdOverride)) {
      const response = await fetch(this.buildUrl(activeModelId), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortSignal
      });

      if (response.ok) {
        const data = (await response.json()) as ConverseResponseShape;
        return this.parseResponse(data);
      }

      const errBody = await response.text();
      const hint = this.buildErrorHint(response.status, errBody, activeModelId);
      attempts.push(`${activeModelId} -> ${response.status}: ${errBody.slice(0, 220)}${hint}`);
      if (!this.shouldTryFallback(response.status)) {
        break;
      }
    }

    throw new Error(`LLM request failed after ${attempts.length} attempt(s): ${attempts.join(" | ")}`);
  }

  async *converseStream(
    messages: ConverseMessage[],
    tools: ToolSpec[],
    systemPrompt: string | Array<{ text: string; cache_control?: any }>,
    modelIdOverride?: string,
    abortSignal?: AbortSignal,
    maxTokensOverride?: number
  ): AsyncGenerator<{ kind: "text" | "tool_use" | "stop"; text?: string; toolUse?: any; usage?: ConverseUsage }> {
    const body = this.buildBody(messages, tools, systemPrompt, maxTokensOverride);

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }

    let response: Response | null = null;
    const attempts: string[] = [];
    for (const activeModelId of this.candidateModelIds(modelIdOverride)) {
      response = await fetch(this.buildUrl(activeModelId).replace("/converse", "/converse-stream"), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortSignal
      });

      if (response.ok) {
        break;
      }

      const errBody = await response.text().catch(() => "");
      const hint = this.buildErrorHint(response.status, errBody, activeModelId);
      attempts.push(`${activeModelId} -> ${response.status}: ${errBody.slice(0, 220)}${hint}`);
      if (!this.shouldTryFallback(response.status)) {
        throw new Error(`LLM streaming failed after ${attempts.length} attempt(s): ${attempts.join(" | ")}`);
      }
    }

    if (!response?.ok) {
      throw new Error(`LLM streaming failed after ${attempts.length} attempt(s): ${attempts.join(" | ")}`);
    }

    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.contentBlockDelta?.delta?.text) {
            const delta = event.contentBlockDelta.delta.text;
            
            const hazard = detectStreamingHazard(buffer, delta);
            if (hazard) {
              yield { kind: "stop", text: `\n[JIT REVERSION] Aborted: ${hazard}` };
              return;
            }

            yield { kind: "text", text: delta };
          }
          if (event.contentBlockStart?.start?.toolUse) {
            yield { kind: "tool_use", toolUse: event.contentBlockStart.start.toolUse };
          }
          if (event.metadata?.usage) {
            yield { kind: "stop", usage: event.metadata.usage };
          }
        } catch {
          // Fragmented JSON
        }
      }
    }
  }

  private buildUrl(modelId: string): string {
    const base = this.options.endpointBase.replace(/\/+$/, "");
    return `${base}/model/${encodeURIComponent(modelId)}/converse`;
  }

  private candidateModelIds(modelIdOverride?: string): string[] {
    return Array.from(new Set([
      modelIdOverride || this.options.modelId,
      ...(this.options.fallbackModelIds ?? [])
    ].filter(Boolean)));
  }

  private shouldTryFallback(status: number): boolean {
    return status === 404 || status === 429 || status >= 500;
  }

  private buildErrorHint(status: number, body: string, modelId: string): string {
    if (
      status === 400 &&
      body.includes("on-demand throughput isn’t supported")
    ) {
      return ` | Hint: model '${modelId}' needs an inference profile id. Try '/model ${DEFAULT_MODEL_ID}'`;
    }
    if (status === 403 && body.includes("\"model_not_allowed\"")) {
      return " | Hint: this model is blocked by worker ALLOWED_MODELS.";
    }
    return "";
  }

  private buildBody(
    messages: ConverseMessage[],
    tools: ToolSpec[],
    systemPrompt: string | Array<{ text: string; cache_control?: any }>,
    maxTokensOverride?: number
  ): Record<string, unknown> {
    // Map messages to ensure image/multimodal blocks are correctly structured
    const mappedMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content.map(block => {
        if ("image" in block) {
          return {
            image: {
              format: block.image.format,
              source: { bytes: block.image.source.bytes }
            }
          };
        }
        return block;
      })
    }));

    let systemArray: Array<{ text: string; cache_control?: any }>;
    if (typeof systemPrompt === "string") {
      systemArray = [
        { 
          text: systemPrompt,
          ...(systemPrompt.length > 1000 ? { cache_control: { type: "ephemeral" } } : {})
        }
      ];
    } else {
      systemArray = systemPrompt;
    }

    const body: Record<string, unknown> = {
      messages: mappedMessages,
      system: systemArray,
      inferenceConfig: {
        temperature: this.options.temperature,
        maxTokens: maxTokensOverride ?? this.options.maxTokens
      }
    };

    const hasToolBlocks = messages.some(msg => 
      msg.content.some(block => "toolUse" in block || "toolResult" in block)
    );

    if (tools.length > 0 || hasToolBlocks) {
      const toolConfig = {
        tools: tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: {
              json: tool.inputSchema ?? { type: "object", properties: {} }
            }
          }
        }))
      };
      
      // Inject cache marker on the last tool to ensure the entire tool block is cached
      if (toolConfig.tools.length > 0) {
        const lastTool = toolConfig.tools[toolConfig.tools.length - 1];
        (lastTool.toolSpec as any).cache_control = { type: "ephemeral" };
      }
      body.toolConfig = toolConfig;
    }

    return body;
  }

  private parseResponse(data: ConverseResponseShape): LlmResponse {
    const content = data.output?.message?.content ?? [];
    const stopReason = data.stopReason ?? "end_turn";
    const usage = data.usage;

    const textParts: string[] = [];
    const toolUses: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of content) {
      if ("text" in block && typeof block.text === "string") {
        textParts.push(block.text);
      } else if ("toolUse" in block && block.toolUse) {
        toolUses.push({
          toolUseId: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: (block.toolUse.input ?? {}) as Record<string, unknown>
        });
      }
    }

    const text = textParts.join("\n").trim();

    if (toolUses.length > 0) {
      return { kind: "tool_use", toolUses, text: text || undefined, stopReason, usage };
    }

    return { kind: "text", text, stopReason, usage };
  }
}

export function detectStreamingHazard(streamSoFar: string, delta: string): string | null {
  const window = `${streamSoFar}${delta}`.slice(-1200);
  const checks: Array<{ pattern: RegExp; reason: string }> = [
    {
      pattern: /\b(?:undefined|null)\s*\.\s*[a-zA-Z_$][\w$]*/i,
      reason: "potential null/undefined property access detected in stream"
    },
    {
      pattern: /\b(?:undefined|null)\s*\[/i,
      reason: "potential null/undefined indexed access detected in stream"
    },
    {
      pattern: /\b(?:document|window|localStorage)\b(?!\s*typeof)\s*\.\s*[a-zA-Z_$][\w$]*/i,
      reason: "browser-only global access detected without an environment guard"
    },
    {
      pattern: /\bprocess\.env\.[A-Z0-9_]+\s*\.\s*[a-zA-Z_$][\w$]*/i,
      reason: "unsafe chained env access detected in stream"
    },
    {
      pattern: /\b[A-Za-z_$][\w$]*\s+as\s+any\b/,
      reason: "type erasure via 'as any' detected in stream"
    }
  ];

  for (const check of checks) {
    if (check.pattern.test(window)) {
      return check.reason;
    }
  }
  return null;
}
