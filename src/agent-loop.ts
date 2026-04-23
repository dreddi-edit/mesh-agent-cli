import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AppConfig } from "./config.js";
import { BedrockLlmClient, LlmMessage } from "./llm-client.js";
import { buildLlmSafeMeshContext } from "./mesh-gateway.js";
import { ToolBackend, ToolDefinition } from "./tool-backend.js";

function buildToolDescriptor(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
  }));
}

export class AgentLoop {
  private readonly llm: BedrockLlmClient;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend
  ) {
    this.llm = new BedrockLlmClient({
      endpoint: config.bedrock.endpoint,
      bearerToken: config.bedrock.bearerToken,
      modelId: config.bedrock.modelId,
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
      `mesh-agent-cli ready (mode=${this.config.agent.mode}, workspace=${this.config.agent.workspaceRoot}). Type 'exit' to quit.\n`
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

      const answer = await this.runSingleTurn(userInput);
      output.write(`Agent> ${answer}\n`);
    }

    rl.close();
  }

  private async runSingleTurn(userInput: string): Promise<string> {
    const tools = await this.backend.listTools();
    const toolDescriptors = buildToolDescriptor(tools);

    const transcript: LlmMessage[] = [
      {
        role: "user",
        content: userInput
      }
    ];

    for (let step = 0; step < this.config.agent.maxSteps; step += 1) {
      const decision = await this.llm.decide(transcript, toolDescriptors);

      if (decision.type === "final") {
        return decision.answer;
      }

      const toolExists = tools.some((tool) => tool.name === decision.tool_name);
      if (!toolExists) {
        transcript.push({
          role: "assistant",
          content: `Tool '${decision.tool_name}' is not available. Choose one of listed tools.`
        });
        continue;
      }

      const toolResult = await this.backend.callTool(decision.tool_name, decision.arguments);
      const meshContext = await buildLlmSafeMeshContext(
        decision.tool_name,
        decision.arguments,
        toolResult
      );

      transcript.push({
        role: "assistant",
        content: meshContext
      });
    }

    return `Stopped after ${this.config.agent.maxSteps} tool steps without final answer.`;
  }
}
