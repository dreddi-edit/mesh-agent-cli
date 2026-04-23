import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";
import ora from "ora";
import boxen from "boxen";

import { AppConfig, shortPathLabel } from "./config.js";
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

interface WireTool {
  wireName: string;
  tool: ToolDefinition;
}

interface RunHooks {
  onToolStart?: (wireName: string, input: Record<string, unknown>) => void;
  askPermission?: (msg: string) => Promise<boolean>;
}

function sanitizeToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.length > 0 ? normalized : "tool";
}

function toWireTools(tools: ToolDefinition[]): WireTool[] {
  const used = new Set<string>();
  const result: WireTool[] = [];

  for (const tool of tools) {
    const base = sanitizeToolName(tool.name);
    let wireName = base;
    let index = 2;
    while (used.has(wireName)) {
      wireName = `${base}_${index}`;
      index += 1;
    }
    used.add(wireName);
    result.push({ wireName, tool });
  }

  return result;
}

function toToolSpecs(wireTools: WireTool[]): ToolSpec[] {
  return wireTools.map(({ wireName, tool }) => ({
    name: wireName,
    description: tool.description ?? "",
    inputSchema:
      (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {}
      }
  }));
}

function formatArgsPreview(args: Record<string, unknown>): string {
  const raw = JSON.stringify(args);
  if (!raw) return "{}";
  return raw.length <= 100 ? raw : `${raw.slice(0, 97)}...`;
}

function formatMultiline(prefix: string, message: string): string {
  const lines = String(message || "").split("\n");
  if (lines.length <= 1) {
    return `${prefix}${lines[0] ?? ""}`;
  }
  return `${prefix}${lines[0]}\n${lines.slice(1).map((line) => `    ${line}`).join("\n")}`;
}

export class AgentLoop {
  private readonly llm: BedrockLlmClient;
  private readonly useAnsi = output.isTTY;
  private currentModelId: string;
  private transcript: ConverseMessage[] = [];
  private sessionTokens = { inputTokens: 0, outputTokens: 0 };
  private systemPrompt: string = SYSTEM_PROMPT;
  private abortController: AbortController | null = null;
  private autoApproveTools = false;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend
  ) {
    this.currentModelId = config.bedrock.modelId;
    this.llm = new BedrockLlmClient({
      endpointBase: config.bedrock.endpointBase,
      modelId: this.currentModelId,
      bearerToken: config.bedrock.bearerToken,
      temperature: config.bedrock.temperature,
      maxTokens: config.bedrock.maxTokens
    });
  }

  async runCli(initialPrompt?: string): Promise<void> {
    try {
      const { execSync } = await import("node:child_process");
      const gitBranch = execSync("git branch --show-current 2>/dev/null", { stdio: "pipe", cwd: this.config.agent.workspaceRoot }).toString().trim();
      const gitStatus = execSync("git status --short 2>/dev/null", { stdio: "pipe", cwd: this.config.agent.workspaceRoot }).toString().trim();
      if (gitBranch) {
        this.systemPrompt += `\n\nWorkspace context:\n- Git branch: ${gitBranch}\n- Git status:\n${gitStatus || "clean"}`;
      }
    } catch {
      // Not a git repository or git not installed
    }

    if (initialPrompt?.trim()) {
      const result = await this.runSingleTurn(initialPrompt);
      output.write(`${result}\n`);
      return;
    }

    this.printBanner();
    const commands = ["/help", "/status", "/index", "/sync", "/model", "/cost", "/compact", "/clear", "/exit"];
    const rl = readline.createInterface({
      input: input,
      output: output,
      terminal: true,
      completer: (line: string): [string[], string] => {
        const hits = commands.filter((c) => c.startsWith(line));
        return [hits.length ? hits : commands, line];
      }
    });

    rl.on("SIGINT", () => {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
        output.write("\n\n" + pc.dim("Request aborted. Returning to prompt.") + "\n");
      } else {
        rl.close();
        output.write("\n\n" + pc.dim("Aborted by user.") + "\n");
        process.exit(0);
      }
    });

    while (true) {
      const prompt = this.useAnsi ? pc.cyan("\n> ") : "\n> ";
      const userInput = (await rl.question(prompt)).trim();
      if (!userInput) {
        continue;
      }
      if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "/exit") {
        break;
      }
      if (userInput === "/help") {
        this.printHelp();
        continue;
      }
      if (userInput === "/status") {
        await this.printStatus();
        continue;
      }
      if (userInput === "/index") {
        await this.runIndexing();
        continue;
      }
      if (userInput === "/sync") {
        await this.printSync();
        continue;
      }
      if (userInput === "/clear") {
        output.write(this.useAnsi ? "\x1b[2J\x1b[H" : "\n");
        this.printBanner();
        continue;
      }
      if (userInput.startsWith("/model")) {
        const nextModel = userInput.slice("/model".length).trim();
        if (!nextModel) {
          output.write(`\nmodel: ${this.currentModelId}\n`);
        } else {
          this.currentModelId = nextModel;
          output.write(`\nmodel switched: ${this.currentModelId}\n`);
        }
        continue;
      }
      if (userInput === "/cost") {
        this.printCost();
        continue;
      }
      if (userInput === "/compact") {
        this.transcript = [];
        output.write(pc.cyan("\nTranscript cleared. Context is now compact.\n"));
        continue;
      }

      try {
        const spinner = this.useAnsi ? ora({ text: "Thinking...", color: "cyan" }).start() : undefined;
        
        const answer = await this.runSingleTurn(userInput, {
          onToolStart: (wireName, args) => {
            if (spinner) {
              spinner.text = `Running tool ${pc.cyan(wireName)} ${pc.dim(formatArgsPreview(args))}`;
            } else {
              output.write(`\ntool ${wireName} ${formatArgsPreview(args)}\n`);
            }
          },
          askPermission: async (msg) => {
            if (spinner) spinner.stop();
            const p = this.useAnsi ? pc.yellow(`\n[Action Required] ${msg} [y/N/A]: `) : `\n[Action Required] ${msg} [y/N/A]: `;
            const ans = (await rl.question(p)).trim().toLowerCase();
            if (ans === "a") {
              this.autoApproveTools = true;
              if (spinner) spinner.start();
              return true;
            }
            const allowed = ans === "y" || ans === "yes";
            if (spinner) spinner.start();
            return allowed;
          }
        });
        
        if (spinner) {
          spinner.stop();
        }
        
        if (this.useAnsi) {
          output.write("\n" + boxen(answer, {
            padding: 1,
            margin: 1,
            borderStyle: "round",
            borderColor: "cyan",
            title: "Mesh Agent",
            titleAlignment: "center"
          }) + "\n");
        } else {
          output.write(`\n${answer}\n`);
        }
      } catch (error) {
        const errorLabel = this.useAnsi ? pc.red("error> ") : "error> ";
        output.write(
          `\n${formatMultiline(errorLabel, (error as Error).message)}\n`
        );
      }
    }

    rl.close();
  }

  private async runSingleTurn(userInput: string, hooks?: RunHooks): Promise<string> {
    const tools = await this.backend.listTools();
    const wireTools = toWireTools(tools);
    const toolSpecs = toToolSpecs(wireTools);
    const wireToolMap = new Map(wireTools.map((item) => [item.wireName, item]));

    this.transcript.push({ role: "user", content: [{ text: userInput }] });

    let lastAssistantText = "";
    this.abortController = new AbortController();

    try {
      for (let step = 0; step < this.config.agent.maxSteps; step += 1) {
        const response = await this.llm.converse(
          this.transcript,
          toolSpecs,
          this.systemPrompt,
          this.currentModelId,
          this.abortController.signal
        );

        if (response.usage) {
          this.sessionTokens.inputTokens += response.usage.inputTokens ?? 0;
          this.sessionTokens.outputTokens += response.usage.outputTokens ?? 0;
        }

        if (response.kind === "text") {
          this.transcript.push({ role: "assistant", content: [{ text: response.text }] });
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
        this.transcript.push({ role: "assistant", content: assistantContent });

        // Execute the tool
        const selectedTool = wireToolMap.get(response.name);

        if (!selectedTool) {
          this.transcript.push({
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: response.toolUseId,
                  status: "error",
                  content: [{ text: `Tool '${response.name}' is not available.` }]
                }
              }
            ]
          });
          continue;
        }

        let resultText: string;
        let errored = false;

        // Tool Security Check
        if ((selectedTool.tool.name === "workspace.run_command" || selectedTool.tool.name === "workspace.write_file") && !this.autoApproveTools) {
          if (hooks?.askPermission) {
            const allowed = await hooks.askPermission(`Allow ${selectedTool.tool.name} to run?`);
            if (!allowed) {
              this.transcript.push({
                role: "user",
                content: [
                  {
                    toolResult: {
                      toolUseId: response.toolUseId,
                      status: "error",
                      content: [{ text: "User denied permission to run this tool." }]
                    }
                  }
                ]
              });
              continue;
            }
          }
        }

        try {
          hooks?.onToolStart?.(response.name, response.input);
          const raw = await this.backend.callTool(selectedTool.tool.name, response.input);
          resultText = await buildLlmSafeMeshContext(selectedTool.tool.name, response.input, raw);
        } catch (error) {
          resultText = `Tool execution failed: ${(error as Error).message}`;
          errored = true;
        }

        this.transcript.push({
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
    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        return lastAssistantText || "Request aborted.";
      }
      throw err;
    } finally {
      this.abortController = null;
    }

    return (
      lastAssistantText ||
      `Stopped after ${this.config.agent.maxSteps} tool steps without final answer.`
    );
  }

  private printBanner(): void {
    const banner = [
      "  __  __   ______   _____   _    _ ",
      " |  \\/  | |  ____| / ____| | |  | |",
      " | \\  / | | |__   | (___   | |__| |",
      " | |\\/| | |  __|   \\___ \\  |  __  |",
      " | |  | | | |____  ____) | | |  | |",
      " |_|  |_| |______||_____/  |_|  |_|",
      ""
    ];

    if (!this.useAnsi) {
      output.write("\n" + banner.join("\n") + "\n");
      output.write(
        [
          `mesh  ${this.config.agent.mode}  ${shortPathLabel(this.config.agent.workspaceRoot)}`,
          `model: ${this.currentModelId}`,
          "commands: /help /status /index /sync /model /clear /exit"
        ].join("\n") + "\n"
      );
      return;
    }
    
    output.write("\n" + pc.cyan(banner.join("\n")) + "\n");
    output.write(
      [
        `${pc.cyan(pc.bold("mesh"))}  ${pc.dim(this.config.agent.mode)}  ${pc.dim(shortPathLabel(this.config.agent.workspaceRoot))}`,
        `${pc.dim("model:")} ${pc.cyan(this.currentModelId)}`,
        `${pc.dim("commands:")} ${pc.magenta("/help")} ${pc.magenta("/status")} ${pc.magenta("/index")} ${pc.magenta("/sync")} ${pc.magenta("/model")}`
      ].join("\n") + "\n"
    );
  }

  private async printSync(): Promise<void> {
    const status: any = await this.backend.callTool("workspace.check_sync", {});
    if (!status.l2Enabled) {
      output.write(pc.yellow("\nCloud (L2) cache is disabled. Check your SUPABASE_URL/KEY.\n"));
      return;
    }
    output.write(
      [
        "",
        `${pc.cyan(pc.bold("Cloud Sync Status"))}`,
        `${pc.dim("L2 Capsules:")} ${pc.green(status.l2Count)}`,
        `${pc.dim("L2 Status:")}   ${pc.green("Connected")}`,
        ""
      ].join("\n")
    );
  }

  private async printStatus(): Promise<void> {
    const status: any = await this.backend.callTool("workspace.get_index_status", {});
    output.write(
      [
        "",
        `${pc.dim("mode:")}      ${this.config.agent.mode}`,
        `${pc.dim("workspace:")} ${shortPathLabel(this.config.agent.workspaceRoot)}`,
        `${pc.dim("model:")}     ${this.currentModelId}`,
        `${pc.dim("index:")}     ${status.cachedFiles}/${status.totalFiles} files cached (${status.percent}%)`,
        ""
      ].join("\n")
    );
  }

  private async runIndexing(): Promise<void> {
    if (!this.backend.indexEverything) {
      output.write(pc.red("\nIndexing is only available in local mode.\n"));
      return;
    }

    const spinner = ora({ text: "Scanning workspace...", color: "cyan" }).start();
    try {
      for await (const progress of this.backend.indexEverything()) {
        spinner.text = `Indexing [${progress.current}/${progress.total}] ${pc.dim(progress.path)}`;
      }
      spinner.succeed(pc.green("Workspace indexed successfully."));
    } catch (err) {
      spinner.fail(pc.red(`Indexing failed: ${(err as Error).message}`));
    }
  }

  private printCost(): void {
    const inT = this.sessionTokens.inputTokens;
    const outT = this.sessionTokens.outputTokens;
    const cost = (inT * 0.003 / 1000) + (outT * 0.015 / 1000);
    output.write(
      [
        "",
        `${pc.dim("session usage:")} ${pc.cyan(inT.toLocaleString())} ${pc.dim("input /")} ${pc.cyan(outT.toLocaleString())} ${pc.dim("output tokens")}`,
        `${pc.dim("session cost:")}  ${pc.green("$" + cost.toFixed(4))}`,
        ""
      ].join("\n")
    );
  }

  private printHelp(): void {
    output.write(
      [
        "",
        `${pc.magenta("/help")}             show commands`,
        `${pc.magenta("/status")}           show indexing status & runtime info`,
        `${pc.magenta("/index")}            re-index workspace (generate capsules)`,
        `${pc.magenta("/sync")}             check cloud (L2) cache synchronization`,
        `${pc.magenta("/model")}            show current model`,
        `${pc.magenta("/model <id>")}       switch model for next messages`,
        `${pc.magenta("/cost")}             show token usage and approx cost`,
        `${pc.magenta("/compact")}          clear transcript context`,
        `${pc.magenta("/clear")}            clear terminal UI`,
        `${pc.magenta("/exit")}             quit`
      ].join("\n") + "\n"
    );
  }
}
