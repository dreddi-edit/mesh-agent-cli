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
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
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

  private buildUrl(modelId: string): string {
    const base = this.options.endpointBase.replace(/\/+$/, "");
    return `${base}/model/${encodeURIComponent(modelId)}/converse`;
  }

  private buildErrorHint(status: number, body: string, modelId: string): string {
    if (
      status === 400 &&
      body.includes("on-demand throughput isn’t supported")
    ) {
      return ` | Hint: model '${modelId}' needs an inference profile id. Try '/model us.anthropic.claude-sonnet-4-5-20250929-v1:0'`;
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
    let toolUse:
      | { toolUseId: string; name: string; input: Record<string, unknown> }
      | undefined;

    for (const block of content) {
      if ("text" in block && typeof block.text === "string") {
        textParts.push(block.text);
      } else if ("toolUse" in block && block.toolUse) {
        toolUse = {
          toolUseId: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: (block.toolUse.input ?? {}) as Record<string, unknown>
        };
      }
    }

    const text = textParts.join("\n").trim();

    if (toolUse) {
      return {
        kind: "tool_use",
        toolUseId: toolUse.toolUseId,
        name: toolUse.name,
        input: toolUse.input,
        text: text || undefined,
        stopReason,
        usage
      };
    }

    return { kind: "text", text, stopReason, usage };
  }
}
