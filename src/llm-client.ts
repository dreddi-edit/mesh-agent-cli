export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentDecisionFinal {
  type: "final";
  answer: string;
}

export interface AgentDecisionTool {
  type: "tool_call";
  tool_name: string;
  arguments: Record<string, unknown>;
}

export type AgentDecision = AgentDecisionFinal | AgentDecisionTool;

interface LlmClientOptions {
  endpoint: string;
  bearerToken?: string;
  modelId?: string;
  temperature: number;
  maxTokens: number;
}

export class BedrockLlmClient {
  constructor(private readonly options: LlmClientOptions) {}

  async decide(messages: LlmMessage[], tools: unknown[]): Promise<AgentDecision> {
    const systemContract = [
      "You are a terminal AI agent.",
      "You can either answer directly or request exactly one tool call.",
      "Return strict JSON only, no markdown, no prose outside JSON.",
      "Schema:",
      "{\"type\":\"final\",\"answer\":\"...\"}",
      "or",
      "{\"type\":\"tool_call\",\"tool_name\":\"...\",\"arguments\":{}}"
    ].join("\n");

    const payload = {
      modelId: this.options.modelId,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      tools,
      messages: [{ role: "system", content: systemContract }, ...messages]
    };

    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }

    const response = await fetch(this.options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const rawText = this.extractText(data);
    const parsed = this.tryParseJson(rawText);

    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return {
        type: "final",
        answer: rawText
      };
    }

    if (parsed.type === "tool_call") {
      const toolName = String((parsed as Record<string, unknown>).tool_name ?? "");
      const args = (parsed as Record<string, unknown>).arguments;
      if (!toolName || !args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("LLM returned invalid tool_call format");
      }

      return {
        type: "tool_call",
        tool_name: toolName,
        arguments: args as Record<string, unknown>
      };
    }

    return {
      type: "final",
      answer: String((parsed as Record<string, unknown>).answer ?? rawText)
    };
  }

  private extractText(data: Record<string, unknown>): string {
    const explicitText = data.text;
    if (typeof explicitText === "string") {
      return explicitText;
    }

    const choices = data.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const maybeMessage = (choices[0] as Record<string, unknown>).message as
        | Record<string, unknown>
        | undefined;
      const content = maybeMessage?.content;
      if (typeof content === "string") {
        return content;
      }
    }

    const output = data.output as Record<string, unknown> | undefined;
    const message = output?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        return first.text;
      }
    }

    throw new Error("Unsupported LLM response format (no text found)");
  }

  private tryParseJson(raw: string): unknown {
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // Some models wrap JSON in markdown code fences.
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (!fenced) {
        return null;
      }
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
  }
}
