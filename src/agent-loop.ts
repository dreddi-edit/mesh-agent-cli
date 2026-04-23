import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AppConfig } from "./config.js";
import {
  BedrockLlmClient,
  ConverseMessage,
  ContentBlock,
  ToolSpec
} from "./llm-client.js";
import { buildLlmSafeMeshContext } from "./mesh-gateway.js";
import { ToolBackend, ToolDefinition } from "./tool-backend.js";

const SYSTEM_PROMPT = [
  "You are mesh-agent, a terminal AI coding agent.",
  "You operate inside a workspace and can call tools to inspect or modify it.",
  "Prefer calling tools over guessing. When you have enough information,",
  "give a concise, direct final answer. No markdown headers, no fluff.",
  "German or English: match the user."
].join(" ");

function toToolSpecs(tools: ToolDefinition[]): ToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema:
      (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {}
      }
  }));
}

export class AgentLoop {
  private readonly llm: BedrockLlmClient;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend
  ) {
    this.llm = new BedrockLlmClient({
      endpointBase: config.bedrock.endpointBase,
      modelId: config.bedrock.modelId,
      bearerToken: config.bedrock.bearerToken,
      temperature: config.bedrock.temperature,
      maxTokens: config.bedrock.maxTokens
    });
  }

  async runCli(initialPrompt?: string): Promise<void> {
    if (initialPrompt?.trim()) {
      const result = await this.runSingleTurn(initialPrompt);
      output.write(`${result}\n`);
      return;
    }

    output.write(
      `mesh-agent ready (mode=${this.config.agent.mode}, workspace=${this.config.agent.workspaceRoot}). Type 'exit' to quit.\n`
    );
    const rl = readline.createInterface({ input, output });

    while (true) {
      const userInput = (await rl.question("\nYou> ")).trim();
      if (!userInput) {
        continue;
      }
      if (userInput.toLowerCase() === "exit") {
        break;
      }

      try {
        const answer = await this.runSingleTurn(userInput);
        output.write(`\nAgent> ${answer}\n`);
      } catch (error) {
        output.write(
          `\n[error] ${(error as Error).message}\n`
        );
      }
    }

    rl.close();
  }

  private async runSingleTurn(userInput: string): Promise<string> {
    const tools = await this.backend.listTools();
    const toolSpecs = toToolSpecs(tools);

    const transcript: ConverseMessage[] = [
      { role: "user", content: [{ text: userInput }] }
    ];

    let lastAssistantText = "";

    for (let step = 0; step < this.config.agent.maxSteps; step += 1) {
      const response = await this.llm.converse(transcript, toolSpecs, SYSTEM_PROMPT);

      if (response.kind === "text") {
        return response.text || lastAssistantText || "(no answer)";
      }

      lastAssistantText = response.text ?? lastAssistantText;

      // Record the assistant turn that issued the toolUse.
      const assistantContent: ContentBlock[] = [];
      if (response.text) {
        assistantContent.push({ text: response.text });
      }
      assistantContent.push({
        toolUse: {
          toolUseId: response.toolUseId,
          name: response.name,
          input: response.input
        }
      });
      transcript.push({ role: "assistant", content: assistantContent });

      // Execute the tool (or report unknown tool) and push a user-turn tool result.
      const toolExists = tools.some((tool) => tool.name === response.name);

      if (!toolExists) {
        transcript.push({
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: response.toolUseId,
                status: "error",
                content: [
                  {
                    text: `Tool '${response.name}' is not available. Pick one of: ${tools
                      .map((t) => t.name)
                      .join(", ")}`
                  }
                ]
              }
            }
          ]
        });
        continue;
      }

      let resultText: string;
      let errored = false;
      try {
        const raw = await this.backend.callTool(response.name, response.input);
        resultText = await buildLlmSafeMeshContext(response.name, response.input, raw);
      } catch (error) {
        resultText = `Tool execution failed: ${(error as Error).message}`;
        errored = true;
      }

      transcript.push({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: response.toolUseId,
              status: errored ? "error" : "success",
              content: [{ text: resultText }]
            }
          }
        ]
      });
    }

    return (
      lastAssistantText ||
      `Stopped after ${this.config.agent.maxSteps} tool steps without final answer.`
    );
  }
}
