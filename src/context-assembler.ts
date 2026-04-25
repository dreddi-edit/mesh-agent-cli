import { ConverseMessage, ContentBlock, ToolSpec } from "./llm-client.js";

export interface ContextAssemblerOptions {
  maxInputTokens?: number;
  historyTokenBudget?: number;
  currentTurnTokenBudget?: number;
  toolTokenBudget?: number;
  toolResultTokenBudget?: number;
}

export interface ContextBudgetReport {
  maxInputTokens: number;
  systemTokens: number;
  runtimeContextTokens: number;
  historyTokens: number;
  currentTurnTokens: number;
  toolTokens: number;
  totalTokens: number;
  messagesIn: number;
  messagesOut: number;
  toolsIn: number;
  toolsOut: number;
  trimmedMessages: number;
  trimmedChars: number;
}

export interface AssembledModelInput {
  messages: ConverseMessage[];
  tools: ToolSpec[];
  report: ContextBudgetReport;
}

const DEFAULT_MAX_INPUT_TOKENS = 16_000;
const DEFAULT_HISTORY_TOKENS = 2_000;
const DEFAULT_CURRENT_TURN_TOKENS = 8_000;
const DEFAULT_TOOL_TOKENS = 3_000;
const DEFAULT_TOOL_RESULT_TOKENS = 900;

export class ContextAssembler {
  private readonly maxInputTokens: number;
  private readonly historyTokenBudget: number;
  private readonly currentTurnTokenBudget: number;
  private readonly toolTokenBudget: number;
  private readonly toolResultTokenBudget: number;

  constructor(options: ContextAssemblerOptions = {}) {
    this.maxInputTokens = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    this.historyTokenBudget = options.historyTokenBudget ?? DEFAULT_HISTORY_TOKENS;
    this.currentTurnTokenBudget = options.currentTurnTokenBudget ?? DEFAULT_CURRENT_TURN_TOKENS;
    this.toolTokenBudget = options.toolTokenBudget ?? DEFAULT_TOOL_TOKENS;
    this.toolResultTokenBudget = options.toolResultTokenBudget ?? DEFAULT_TOOL_RESULT_TOKENS;
  }

  assemble(args: {
    transcript: ConverseMessage[];
    currentTurnStart: number;
    tools: ToolSpec[];
    systemPrompt: string;
    sessionSummary?: string | null;
    runtimeContext?: string | null;
  }): AssembledModelInput {
    const currentTurnStart = Math.max(0, Math.min(args.currentTurnStart, args.transcript.length));
    const prior = args.transcript.slice(0, currentTurnStart);
    const current = args.transcript.slice(currentTurnStart);
    let trimmedChars = 0;

    const runtimeContext = this.clampText(args.runtimeContext ?? "", 2_800);
    const summaryMessage = args.sessionSummary
      ? this.messageFromText("user", `Session capsule:\n${this.clampText(args.sessionSummary, 1_600)}`)
      : null;
    const runtimeMessage = runtimeContext
      ? this.messageFromText("user", `Local compressed context:\n${runtimeContext}`)
      : null;

    const retainedHistory: ConverseMessage[] = [];
    let historyTokens = 0;
    for (let index = prior.length - 1; index >= 0; index -= 1) {
      const compact = this.compactMessage(prior[index], "history");
      const tokens = estimateTokensForMessage(compact);
      if (historyTokens + tokens > this.historyTokenBudget && retainedHistory.length >= 2) {
        trimmedChars += estimateCharsForMessage(prior[index]);
        continue;
      }
      retainedHistory.unshift(compact);
      historyTokens += tokens;
      if (historyTokens >= this.historyTokenBudget) break;
    }

    const compactCurrent: ConverseMessage[] = [];
    let currentTokens = 0;
    for (const message of current) {
      const compact = this.compactMessage(message, "current");
      const tokens = estimateTokensForMessage(compact);
      if (currentTokens + tokens > this.currentTurnTokenBudget) {
        const reduced = this.trimMessageToTokenBudget(compact, Math.max(300, this.currentTurnTokenBudget - currentTokens));
        compactCurrent.push(reduced);
        trimmedChars += Math.max(0, estimateCharsForMessage(compact) - estimateCharsForMessage(reduced));
        break;
      }
      compactCurrent.push(compact);
      currentTokens += tokens;
    }

    const tools = trimToolSpecs(args.tools, this.toolTokenBudget);
    const messages = [
      ...(summaryMessage ? [summaryMessage] : []),
      ...(runtimeMessage ? [runtimeMessage] : []),
      ...retainedHistory,
      ...compactCurrent
    ];

    let report = this.report(args, messages, tools, trimmedChars);
    const protectedTailCount = Math.max(1, compactCurrent.length);
    while (report.totalTokens > this.maxInputTokens && messages.length > protectedTailCount) {
      trimmedChars += estimateCharsForMessage(messages[0]);
      messages.shift();
      report = this.report(args, messages, tools, trimmedChars);
    }

    if (report.totalTokens > this.maxInputTokens && tools.length > 0) {
      tools.splice(Math.max(1, Math.floor(tools.length / 2)));
      report = this.report(args, messages, tools, trimmedChars);
    }

    return { messages, tools, report };
  }

  private report(
    args: {
      transcript: ConverseMessage[];
      tools: ToolSpec[];
      systemPrompt: string;
      runtimeContext?: string | null;
    },
    messages: ConverseMessage[],
    tools: ToolSpec[],
    trimmedChars: number
  ): ContextBudgetReport {
    const runtimeContextTokens = estimateTokens(args.runtimeContext ?? "");
    const systemTokens = estimateTokens(args.systemPrompt);
    const toolTokens = estimateTokens(JSON.stringify(tools));
    const currentTurnTokens = messages.reduce((sum, message) => sum + estimateTokensForMessage(message), 0);
    return {
      maxInputTokens: this.maxInputTokens,
      systemTokens,
      runtimeContextTokens,
      historyTokens: Math.max(0, currentTurnTokens - runtimeContextTokens),
      currentTurnTokens,
      toolTokens,
      totalTokens: systemTokens + currentTurnTokens + toolTokens,
      messagesIn: args.transcript.length,
      messagesOut: messages.length,
      toolsIn: args.tools.length,
      toolsOut: tools.length,
      trimmedMessages: Math.max(0, args.transcript.length - messages.length),
      trimmedChars
    };
  }

  private compactMessage(message: ConverseMessage, scope: "history" | "current"): ConverseMessage {
    return {
      role: message.role,
      content: message.content.map((block) => this.compactBlock(block, scope))
    };
  }

  private compactBlock(block: ContentBlock, scope: "history" | "current"): ContentBlock {
    if ("text" in block) {
      const limit = scope === "current" ? 4_000 : 900;
      return { text: this.clampText(block.text, limit) };
    }
    if ("toolUse" in block) {
      return {
        toolUse: {
          toolUseId: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: clampJsonObject(block.toolUse.input, 900)
        }
      };
    }
    if ("toolResult" in block) {
      const text = block.toolResult.content
        .map((item) => ("text" in item ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      return {
        toolResult: {
          toolUseId: block.toolResult.toolUseId,
          status: block.toolResult.status,
          content: [{ text: this.clampText(text, scope === "current" ? this.toolResultTokenBudget * 4 : 900) }]
        }
      };
    }
    if ("image" in block) {
      return block;
    }
    return block;
  }

  private trimMessageToTokenBudget(message: ConverseMessage, budget: number): ConverseMessage {
    const charBudget = Math.max(200, budget * 4);
    let remaining = charBudget;
    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if ("text" in block) {
        const text = this.clampText(block.text, remaining);
        remaining -= text.length;
        content.push({ text });
      } else if ("toolResult" in block) {
        const text = block.toolResult.content
          .map((item) => ("text" in item ? item.text : ""))
          .filter(Boolean)
          .join("\n");
        const reduced = this.clampText(text, remaining);
        remaining -= reduced.length;
        content.push({
          toolResult: {
            toolUseId: block.toolResult.toolUseId,
            status: block.toolResult.status,
            content: [{ text: reduced }]
          }
        });
      } else {
        content.push(block);
      }
      if (remaining <= 80) break;
    }
    return { role: message.role, content: content.length ? content : [{ text: "[context trimmed]" }] };
  }

  private messageFromText(role: ConverseMessage["role"], text: string): ConverseMessage {
    return { role, content: [{ text }] };
  }

  private clampText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 80))}\n[context trimmed: ${text.length - maxChars} chars omitted]`;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(String(text || "").length / 4);
}

export function estimateTokensForMessage(message: ConverseMessage): number {
  return estimateTokens(JSON.stringify(message));
}

export function estimateCharsForMessage(message: ConverseMessage): number {
  return JSON.stringify(message).length;
}

function trimToolSpecs(tools: ToolSpec[], maxTokens: number): ToolSpec[] {
  const retained: ToolSpec[] = [];
  let total = 0;
  const ordered = [...tools].sort((left, right) => Number(left.name !== "workspace_open_artifact") - Number(right.name !== "workspace_open_artifact"));
  for (const tool of ordered) {
    const compact = compactToolSpec(tool);
    const cost = estimateTokens(JSON.stringify(compact));
    if (retained.length > 0 && total + cost > maxTokens) continue;
    retained.push(compact);
    total += cost;
  }
  return retained.length ? retained : tools.slice(0, 1).map(compactToolSpec);
}

function compactToolSpec(tool: ToolSpec): ToolSpec {
  return {
    name: tool.name,
    description: clamp(tool.description ?? "", 220),
    inputSchema: compactSchema(tool.inputSchema ?? { type: "object", properties: {} }, 0)
  };
}

function compactSchema(value: unknown, depth: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || depth > 3) return { type: "object" };
  if (Array.isArray(value)) return { type: "array" };
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["type", "required", "properties", "items", "enum", "description", "default"]) {
    if (!(key in input)) continue;
    if (key === "description") {
      output[key] = clamp(String(input[key] ?? ""), 120);
    } else if (key === "properties" && input[key] && typeof input[key] === "object" && !Array.isArray(input[key])) {
      const properties: Record<string, unknown> = {};
      for (const [propName, propValue] of Object.entries(input[key] as Record<string, unknown>).slice(0, 12)) {
        properties[propName] = compactSchema(propValue, depth + 1);
      }
      output[key] = properties;
    } else {
      output[key] = input[key];
    }
  }
  return output;
}

function clampJsonObject(value: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  const raw = JSON.stringify(value);
  if (raw.length <= maxChars) return value;
  return { preview: `${raw.slice(0, maxChars - 40)}...`, omittedChars: raw.length - maxChars };
}

function clamp(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}
