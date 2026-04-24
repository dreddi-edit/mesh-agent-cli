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

export type TextBlock = { text: string };
export type ToolUseBlock = {
  toolUse: { toolUseId: string; name: string; input: Record<string, unknown> };
};
export type ToolResultBlock = {
  toolResult: {
    toolUseId: string;
    content: Array<{ text: string } | { json: unknown }>;
    status?: "success" | "error";
  };
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
    systemPrompt: string,
    modelIdOverride?: string,
    abortSignal?: AbortSignal
  ): Promise<LlmResponse> {
    const activeModelId = modelIdOverride || this.options.modelId;
    const url = this.buildUrl(activeModelId);
    const body = this.buildBody(messages, tools, systemPrompt);

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortSignal
    });

    if (!response.ok) {
      const errBody = await response.text();
      const hint = this.buildErrorHint(response.status, errBody, activeModelId);
      throw new Error(
        `LLM request failed (${response.status}): ${errBody.slice(0, 500)}${hint}`
      );
    }

    const data = (await response.json()) as ConverseResponseShape;
    return this.parseResponse(data);
  }

  async *converseStream(
    messages: ConverseMessage[],
    tools: ToolSpec[],
    systemPrompt: string,
    modelIdOverride?: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<{ kind: "text" | "tool_use" | "stop"; text?: string; toolUse?: any; usage?: ConverseUsage }> {
    const activeModelId = modelIdOverride || this.options.modelId;
    const url = this.buildUrl(activeModelId).replace("/converse", "/converse-stream");
    const body = this.buildBody(messages, tools, systemPrompt);

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortSignal
    });

    if (!response.ok) {
      throw new Error(`LLM streaming failed (${response.status})`);
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
            yield { kind: "text", text: event.contentBlockDelta.delta.text };
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

  private buildErrorHint(status: number, body: string, modelId: string): string {
    if (
      status === 400 &&
      body.includes("on-demand throughput isn’t supported")
    ) {
      return ` | Hint: model '${modelId}' needs an inference profile id. Try '/model us.anthropic.claude-sonnet-4-6'`;
    }
    if (status === 403 && body.includes("\"model_not_allowed\"")) {
      return " | Hint: this model is blocked by worker ALLOWED_MODELS.";
    }
    return "";
  }

  private buildBody(
    messages: ConverseMessage[],
    tools: ToolSpec[],
    systemPrompt: string
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages,
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        temperature: this.options.temperature,
        maxTokens: this.options.maxTokens
      }
    };

    if (tools.length > 0) {
      body.toolConfig = {
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
