import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";
import ora from "ora";
import boxen from "boxen";
import pkg from "enquirer";
const { Select, Confirm } = pkg as any;

import { AppConfig, loadUserSettings, saveUserSettings, shortPathLabel, UserSettings } from "./config.js";
import {
  BedrockLlmClient,
  ConverseMessage,
  ContentBlock,
  ToolSpec
} from "./llm-client.js";
import { buildLlmSafeMeshContext } from "./mesh-gateway.js";
import { PersistedSessionCapsule, SessionCapsuleStore } from "./session-capsule-store.js";
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
  onToolEnd?: (wireName: string, ok: boolean, resultPreview: string) => void;
  askPermission?: (msg: string) => Promise<boolean>;
}

interface SessionCapsule extends PersistedSessionCapsule {}

interface StructuredSessionCapsule {
  summary: string;
  decisions: string[];
  openThreads: string[];
  nextActions: string[];
  filesTouched: string[];
  toolActivity: string[];
}

interface SlashCommand {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
}

interface ModelOption {
  label: string;
  value: string;
  aliases: string[];
  note: string;
}

interface ParsedCommandArgs {
  positionals: string[];
  keyValues: Record<string, string>;
}

const MODEL_OPTIONS: ModelOption[] = [
  {
    label: "Claude Sonnet 4.6",
    value: "us.anthropic.claude-sonnet-4-6",
    aliases: ["sonnet4.6", "sonnet-4.6", "sonnet46"],
    note: "default"
  },
  {
    label: "Claude Opus 4.6",
    value: "us.anthropic.claude-opus-4-6-v1",
    aliases: ["opus4.6", "opus-4.6", "opus46"],
    note: "powerful"
  },
  {
    label: "Claude Haiku 4.5",
    value: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    aliases: ["haiku4.5", "haiku-4.5", "haiku45"],
    note: "modern fast"
  }
];
const ALLOWED_THEMES = new Set(["cyan", "magenta", "yellow", "green", "blue", "white"]);

function uniqueLimited(values: string[], limit: number): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, limit);
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

function shortModelName(id: string): string {
  const match = MODEL_OPTIONS.find((option) => id.includes(option.value) || option.value.includes(id));
  if (match) return match.label;
  const parts = id.split(".");
  const last = parts[parts.length - 1];
  if (last.includes("claude-sonnet")) return "Claude Sonnet";
  return id.split(":").pop() || id;
}

function normalizeModelInput(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  for (const option of MODEL_OPTIONS) {
    if (option.aliases.includes(value) || value === option.value.toLowerCase()) {
      return option.value;
    }
  }
  return raw.trim();
}

function previewText(value: string, maxLen = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function parseCommandArgs(args: string[]): ParsedCommandArgs {
  const positionals: string[] = [];
  const keyValues: Record<string, string> = {};
  for (const arg of args) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex > 0) {
      const key = arg.slice(0, eqIndex).trim().toLowerCase();
      const value = arg.slice(eqIndex + 1).trim();
      if (key) keyValues[key] = value;
    } else if (arg.trim()) {
      positionals.push(arg.trim());
    }
  }
  return { positionals, keyValues };
}

function resolveModelOption(raw: string): ModelOption | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  return (
    MODEL_OPTIONS.find(
      (option) =>
        option.value.toLowerCase() === normalized ||
        option.aliases.includes(normalized) ||
        option.label.toLowerCase() === normalized
    ) ?? null
  );
}

export class AgentLoop {
  private ghostTextListener: any = null;
  private readonly llm: BedrockLlmClient;
  private readonly useAnsi = output.isTTY;
  private readonly sessionStore: SessionCapsuleStore;
  private currentModelId: string;
  private currentBranch = "nogit";
  private transcript: ConverseMessage[] = [];
  private sessionCapsule: SessionCapsule | null = null;
  private lastToolEventAt: string | null = null;
  private sessionTokens = { inputTokens: 0, outputTokens: 0 };
  private workspaceContext = "";
  private abortController: AbortController | null = null;
  private autoApproveTools = false;
  private themeColor: any = pc.cyan;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend
  ) {
    this.sessionStore = new SessionCapsuleStore(config.agent.workspaceRoot);
    this.currentModelId = config.bedrock.modelId;
    this.llm = new BedrockLlmClient({
      endpointBase: config.bedrock.endpointBase,
      modelId: this.currentModelId,
      bearerToken: config.bedrock.bearerToken,
      temperature: config.bedrock.temperature,
      maxTokens: config.bedrock.maxTokens
    });
    
    // Set theme color from config
    const colorStr = config.agent.themeColor || "cyan";
    if ((pc as any)[colorStr]) {
      this.themeColor = (pc as any)[colorStr];
    }
  }

  async runCli(initialPrompt?: string): Promise<void> {
    this.sessionCapsule = await this.sessionStore.load();

    try {
      const { execSync } = await import("node:child_process");
      const gitBranch = execSync("git branch --show-current 2>/dev/null", { stdio: "pipe", cwd: this.config.agent.workspaceRoot }).toString().trim();
      const gitStatus = execSync("git status --short 2>/dev/null", { stdio: "pipe", cwd: this.config.agent.workspaceRoot }).toString().trim();
      if (gitBranch) {
        this.currentBranch = gitBranch;
        this.workspaceContext = `Workspace context:\n- Git branch: ${gitBranch}\n- Git status:\n${gitStatus || "clean"}`;
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
    let rl = readline.createInterface({
      input: input,
      output: output,
      terminal: true,
      completer: (line) => this.completeInput(line)
    });

    let lastSigInt = 0;
    rl.on("SIGINT", () => {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
        output.write("\n\n" + pc.dim("Request aborted. Returning to prompt.") + "\n");
      } else {
        const now = Date.now();
        if (now - lastSigInt < 2000) {
          rl.close();
          output.write("\n\n" + pc.dim("Aborted by user.") + "\n");
          process.exit(0);
        } else {
          lastSigInt = now;
          output.write("\n" + this.themeColor(pc.bold("Press Ctrl+C again within 2s to exit")) + "\n");
        }
      }
    });

    this.setupGhostText(rl, input, output);


    while (true) {
      const prompt = this.buildPrompt();
      let userInput = "";
      try {
        userInput = (await rl.question(prompt)).trim();
      } catch (err) {
        break;
      }
      if (!userInput) {
        continue;
      }

      if (userInput.toLowerCase() === "exit") {
        break;
      }

      if (userInput.startsWith("/")) {
        const handled = await this.handleSlashCommand(userInput, rl);
        if (handled.shouldExit) {
          break;
        }
        if (handled.wasHandled) {
          continue;
        }
      }

      try {
        // Remove redundant renderUserTurn(userInput) to fix double message issue
        const spinner = this.useAnsi ? ora({ text: "Thinking...", color: "cyan" }).start() : undefined;
        
        const answer = await this.runSingleTurn(userInput, {
          onToolStart: (wireName, args) => {
            if (spinner) {
              spinner.text = `Running tool ${pc.cyan(wireName)} ${pc.dim(formatArgsPreview(args))}`;
            }
            this.renderToolEvent("start", wireName, formatArgsPreview(args));
          },
          onToolEnd: (wireName, ok, resultPreview) => {
            if (spinner) {
              spinner.text = ok ? `Completed ${pc.cyan(wireName)}` : `Failed ${pc.cyan(wireName)}`;
            }
            this.renderToolEvent(ok ? "success" : "error", wireName, resultPreview);
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
        this.renderAssistantTurn(answer);
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
    const autoCompactMessage = await this.autoCompactIfNeeded();
    if (autoCompactMessage) {
      this.renderSystemMessage(autoCompactMessage);
    }

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
          this.buildRuntimeSystemPrompt(),
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
          hooks?.onToolEnd?.(response.name, true, this.normalizeCapsuleLine(resultText, 120));
        } catch (error) {
          resultText = `Tool execution failed: ${(error as Error).message}`;
          errored = true;
          hooks?.onToolEnd?.(response.name, false, this.normalizeCapsuleLine(resultText, 120));
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
    const width = output.columns || 80;
    const hr = "═".repeat(width);
    
    const banner = [
      " __  __ _____ ____  _   _             ▟          ▙",
      "|  \\/  | ____/ ___|| | | |            ▟            ▙ ",
      "| |\\/| |  _| \\___ \\| |_| |           █              █  ",
      "| |  | | |___ ___) |  _  |            ▜            ▛ ",
      "|_|  |_|_____|____/|_| |_|             ▜          ▛",
      ""
    ];

    if (!this.useAnsi) {
      output.write("\n" + hr + "\n");
      output.write(banner.join("\n") + "\n");
      output.write(
        [
          `mesh  ${this.config.agent.mode}  ${shortPathLabel(this.config.agent.workspaceRoot)}`,
          `branch: ${this.currentBranch}   model: ${shortModelName(this.currentModelId)}`,
          "commands: /help /status /capsule /model /setup /clear /exit",
          "tip: press TAB for slash-command autocomplete"
        ].join("\n") + "\n"
      );
      return;
    }
    
    output.write("\n" + this.themeColor(hr) + "\n");
    output.write(this.themeColor(banner.join("\n")) + "\n");
    output.write(
      [
        `${this.themeColor(pc.bold("mesh"))}  ${pc.dim(this.config.agent.mode)}  ${pc.dim(shortPathLabel(this.config.agent.workspaceRoot))}`,
        `${pc.dim("branch:")} ${this.themeColor(this.currentBranch)}   ${pc.dim("model:")} ${this.themeColor(shortModelName(this.currentModelId))}`,
        `${pc.dim("commands:")} ${pc.magenta("/help")} ${pc.magenta("/status")} ${pc.magenta("/capsule")} ${pc.magenta("/model pick")} ${pc.magenta("/setup")} ${pc.magenta("/clear")} ${pc.magenta("/exit")}`,
        `${pc.dim("tip:")} ${pc.dim("Type / and press TAB for command completion")}`
      ].join("\n") + "\n"
    );
    output.write(this.themeColor(hr) + "\n");
  }

  private buildPrompt(): string {
    if (!this.useAnsi) {
      return `\nmesh/${this.currentBranch}> `;
    }
    const left = `${this.themeColor(pc.bold("mesh"))}${pc.dim("/")}${pc.dim(this.currentBranch)}`;
    return `\n${left} ${this.themeColor(pc.bold("::"))} `;
  }

  private async printSync(): Promise<void> {
    const status: any = await this.backend.callTool("workspace.check_sync", {});
    if (!status.l2Enabled) {
      output.write(pc.yellow("\nCloud (L2) cache is disabled. Enable it in /setup.\n"));
      return;
    }
    output.write(
      [
        "",
        `${this.themeColor(pc.bold("Cloud Sync Status"))}`,
        `${pc.dim("L2 Capsules:")} ${pc.green(status.l2Count)}`,
        `${pc.dim("L2 Status:")}   ${pc.green("Connected")}`,
        ""
      ].join("\n")
    );
  }

  private async printStatus(): Promise<void> {
    const status: any = await this.backend.callTool("workspace.get_index_status", {});
    const transcriptChars = this.estimateTranscriptChars();
    output.write(
      [
        "",
        `${pc.dim("mode:")}      ${this.config.agent.mode}`,
        `${pc.dim("workspace:")} ${shortPathLabel(this.config.agent.workspaceRoot)}`,
        `${pc.dim("model:")}     ${this.currentModelId}`,
        `${pc.dim("cloud:")}     ${this.config.agent.enableCloudCache ? pc.green("on") : pc.red("off")}`,
        `${pc.dim("index:")}     ${status.cachedFiles}/${status.totalFiles} files cached (${status.percent}%)`,
        `${pc.dim("session:")}   ${this.transcript.length} messages / ${transcriptChars} chars`,
        `${pc.dim("capsule:")}   ${this.sessionCapsule ? pc.green(`active (${this.sessionCapsule.sourceMessages} -> ${this.sessionCapsule.retainedMessages})`) : pc.dim("none")}`,
        ""
      ].join("\n")
    );
  }

  private async runSetup(rl: readline.Interface): Promise<void> {
    output.write(this.themeColor("\n" + "═".repeat(40) + "\n"));
    output.write(this.themeColor(pc.bold("  MESH SETUP WIZARD\n")));
    output.write(this.themeColor("═".repeat(40) + "\n"));
    
    const current = await loadUserSettings();
    const modelRaw = (
      await rl.question(
        `Default Model ID [${pc.dim(current.modelId)}] (alias: sonnet4.6): `
      )
    ).trim();
    const cloudRaw = (
      await rl.question(
        `Enable Cloud (L2) sync? [${pc.dim(current.enableCloudCache ? "y" : "n")}]: `
      )
    ).trim().toLowerCase();
    const themeRaw = (
      await rl.question(
        `Theme Color [${pc.dim(current.themeColor)}] (cyan/magenta/yellow/green/blue/white): `
      )
    ).trim();
    const customKeyRaw = (
      await rl.question(
        `Custom API Key (empty = keep, '-' = clear) [${pc.dim(current.customApiKey ? "set" : "none")}]: `
      )
    ).trim();

    const modelId = normalizeModelInput(modelRaw || current.modelId);
    const cloudCache =
      cloudRaw === ""
        ? current.enableCloudCache
        : cloudRaw === "y" || cloudRaw === "yes" || cloudRaw === "true" || cloudRaw === "1";
    const allowedThemes = new Set(["cyan", "magenta", "yellow", "green", "blue", "white"]);
    const theme = allowedThemes.has(themeRaw) ? themeRaw : current.themeColor;
    const customKey =
      customKeyRaw === ""
        ? current.customApiKey
        : customKeyRaw === "-"
          ? undefined
          : customKeyRaw;

    const newSettings: UserSettings = {
      modelId,
      enableCloudCache: cloudCache,
      themeColor: theme,
      customApiKey: customKey
    };

    await saveUserSettings(newSettings);
    output.write(pc.green("\n✔ Settings saved! Restart mesh to apply changes.\n"));
    output.write(this.themeColor("═".repeat(40) + "\n"));
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
        `${pc.dim("session usage:")} ${this.themeColor(inT.toLocaleString())} ${pc.dim("input /")} ${this.themeColor(outT.toLocaleString())} ${pc.dim("output tokens")}`,
        `${pc.dim("session cost:")}  ${pc.green("$" + cost.toFixed(4))}`,
        ""
      ].join("\n")
    );
  }

  private setupGhostText(rl: readline.Interface, input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    if (!this.useAnsi) return;
    
    // Remove only our previous listener if it exists
    if (this.ghostTextListener) {
      input.removeListener("keypress", this.ghostTextListener);
    }

    let lastGhostText = "";
    this.ghostTextListener = (_: any, key: any) => {
      if (!this.useAnsi || !key) return;
      if (key.name === "return" || key.name === "enter") return;
      
      setTimeout(() => {
        const line = (rl as any).line || "";
        if (line.startsWith("/") && !line.includes(" ")) {
          const commands = this.getSlashCommands().flatMap(c => [c.name, ...(c.aliases || [])]);
          const match = commands.find(c => c.startsWith(line) && c !== line);
          if (match) {
            const hint = match.slice(line.length);
            if (hint !== lastGhostText) {
              output.write(pc.dim(hint) + "\u001b[" + hint.length + "D");
              lastGhostText = hint;
            }
          } else if (lastGhostText) {
            output.write(" ".repeat(lastGhostText.length) + "\u001b[" + lastGhostText.length + "D");
            lastGhostText = "";
          }
        } else if (lastGhostText) {
          output.write(" ".repeat(lastGhostText.length) + "\u001b[" + lastGhostText.length + "D");
          lastGhostText = "";
        }
      }, 5);
    };

    input.on("keypress", this.ghostTextListener);
  }

  private renderUserTurn(text: string): void {
    const label = this.useAnsi ? pc.bold(pc.white("you")) : "you";
    output.write(`\n${label}> ${text}\n`);
  }

  private renderAssistantTurn(text: string): void {
    if (this.useAnsi) {
      output.write("\n" + this.themeColor(pc.bold("assistant")) + pc.dim(" › ") + text + "\n");
      return;
    }
    output.write(`\nassistant> ${text}\n`);
  }

  private renderSystemMessage(text: string): void {
    const prefix = this.useAnsi ? pc.yellow("system>") : "system>";
    output.write(`\n${prefix} ${text}\n`);
  }

  private renderToolEvent(kind: "start" | "success" | "error", wireName: string, detail: string): void {
    this.lastToolEventAt = new Date().toISOString();
    const label =
      kind === "start"
        ? pc.dim("tool>")
        : kind === "success"
          ? pc.green("tool<")
          : pc.red("tool<");
    output.write(`\n${label} ${pc.cyan(wireName)}${detail ? ` ${pc.dim(detail)}` : ""}\n`);
  }

  private printHelp(): void {
    const commands = this.getSlashCommands();
    output.write(
      [
        "",
        ...commands.map((command) => {
          const names = [command.name, ...(command.aliases ?? [])].join(", ");
          return `${pc.magenta(names.padEnd(24, " "))}${command.description}  ${pc.dim(command.usage)}`;
        })
      ].join("\n") + "\n"
    );
  }

  private getSlashCommands(): SlashCommand[] {
    return [
      { name: "/help", aliases: ["/commands"], usage: "/help", description: "show commands" },
      { name: "/status", usage: "/status", description: "show runtime, session, and index state" },
      { name: "/capsule", aliases: ["/memory"], usage: "/capsule [show|compact|clear|export [path]|stats|path]", description: "inspect or manage session capsule" },
      { name: "/index", usage: "/index", description: "re-index workspace and generate file capsules" },
      { name: "/sync", usage: "/sync", description: "check cloud (L2) cache synchronization" },
      { name: "/setup", usage: "/setup [noninteractive key=value ...]", description: "interactive or scripted settings" },
      { name: "/model", usage: "/model [pick|list|id|save]", description: "interactive chooser or switch model" },
      { name: "/cost", usage: "/cost", description: "show token usage and estimated cost" },
      { name: "/approvals", usage: "/approvals [status|on|off]", description: "control tool auto-approval mode" },
      { name: "/doctor", usage: "/doctor [brief|full]", description: "show runtime diagnostics" },
      { name: "/compact", usage: "/compact", description: "compress transcript into session capsule" },
      { name: "/clear", usage: "/clear", description: "clear terminal UI" },
      { name: "/exit", aliases: ["/quit"], usage: "/exit", description: "quit" }
    ];
  }

  private async handleSlashCommand(
    rawInput: string,
    rl: readline.Interface
  ): Promise<{ wasHandled: boolean; shouldExit: boolean }> {
    const [command, ...args] = rawInput.split(/\s+/g);

    switch (command.toLowerCase()) {
      case "/help":
      case "/commands":
        this.printHelp();
        return { wasHandled: true, shouldExit: false };
      case "/status":
        await this.printStatus();
        return { wasHandled: true, shouldExit: false };
      case "/index":
        await this.runIndexing();
        return { wasHandled: true, shouldExit: false };
      case "/sync":
        await this.printSync();
        return { wasHandled: true, shouldExit: false };
      case "/setup":
        await this.handleSetupCommand(args, rl);
        return { wasHandled: true, shouldExit: false };
      case "/clear":
        output.write(this.useAnsi ? "\x1b[2J\x1b[H" : "\n");
        this.printBanner();
        return { wasHandled: true, shouldExit: false };
      case "/model":
        await this.handleModelCommand(args, rl);
        return { wasHandled: true, shouldExit: false };
      case "/cost":
        this.printCost();
        return { wasHandled: true, shouldExit: false };
      case "/compact":
        output.write(this.themeColor(`\n${await this.compactTranscript()}\n`));
        return { wasHandled: true, shouldExit: false };
      case "/capsule":
      case "/memory":
        await this.handleCapsuleCommand(args);
        return { wasHandled: true, shouldExit: false };
      case "/approvals":
        this.handleApprovalsCommand(args);
        return { wasHandled: true, shouldExit: false };
      case "/doctor":
        await this.runDoctor(args);
        return { wasHandled: true, shouldExit: false };
      case "/exit":
      case "exit":
      case "/quit":
        return { wasHandled: true, shouldExit: true };
      default:
        output.write(`\nUnknown command: ${rawInput}. Use /help.\n`);
        return { wasHandled: true, shouldExit: false };
    }
  }

  private async handleModelCommand(args: string[], rl: readline.Interface): Promise<void> {
    const parsed = parseCommandArgs(args);
    const nextModel = [...parsed.positionals, parsed.keyValues.model ?? ""].join(" ").trim();
    if (!nextModel || nextModel === "pick" || nextModel === "choose") {
      await this.chooseModelInteractive(rl);
      return;
    }
    if (nextModel === "list" || nextModel === "ls") {
      output.write(
        [
          "",
          `${this.themeColor(pc.bold("Available Models"))}`,
          ...MODEL_OPTIONS.map((option) => {
            const aliases = option.aliases.join(", ");
            const active = option.value === this.currentModelId ? pc.green(" active") : "";
            return `${option.label}  ${pc.dim(option.value)}${active}\n${pc.dim(`aliases: ${aliases} | ${option.note}`)}`;
          }),
          ""
        ].join("\n")
      );
      return;
    }
    if (nextModel === "current") {
      output.write(`\ncurrent model: ${this.currentModelId}\n`);
      return;
    }
    if (nextModel === "save") {
      const current = await loadUserSettings();
      await saveUserSettings({ ...current, modelId: this.currentModelId });
      output.write(`\ndefault model saved: ${this.themeColor(shortModelName(this.currentModelId))}\n`);
      return;
    }
    const resolved = resolveModelOption(nextModel);
    if (!resolved && nextModel.startsWith("/")) {
      output.write(`\nInvalid model argument: ${nextModel}\n`);
      return;
    }
    this.currentModelId = resolved?.value ?? normalizeModelInput(nextModel);
    output.write(`\nmodel switched: ${this.themeColor(shortModelName(this.currentModelId))}\n`);
  }

  private async chooseModelInteractive(rl: readline.Interface): Promise<void> {
    const choices = MODEL_OPTIONS.map((opt) => ({
      name: opt.value,
      message: `${pc.bold(opt.label)} ${pc.dim(opt.note)}`,
      hint: opt.value === this.currentModelId ? pc.green("(active)") : pc.dim(opt.value)
    }));

    const prompt = new Select({
      name: "model",
      message: "Select an AI model",
      choices,
      stdin: input,
      stdout: output
    });

    try {
      const pickedValue = await prompt.run();
      this.setupGhostText(rl, input, output);
      const picked = MODEL_OPTIONS.find((o) => o.value === pickedValue)!;
      
      this.currentModelId = picked.value;
      output.write(`\nmodel switched: ${this.themeColor(picked.label)}\n`);

      const confirmPrompt = new Confirm({
        name: "save",
        message: "Save as default model?",
        stdin: input,
        stdout: output
      });

      const shouldSave = await confirmPrompt.run();
      this.setupGhostText(rl, input, output);
      if (shouldSave) {
        const current = await loadUserSettings();
        await saveUserSettings({ ...current, modelId: picked.value });
        output.write(pc.green("Default model saved.\n"));
      }
    } catch {
      output.write(pc.dim("\nSelection cancelled.\n"));
    }
  }

  private completeInput(line: string): [string[], string] {
    const commands = this.getSlashCommands().flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    const trimmed = line.trimStart();

    if (!trimmed.startsWith("/")) {
      return [[], line];
    }

    const parts = trimmed.split(/\s+/g);
    const cmd = parts[0].toLowerCase();
    const partial = parts[parts.length - 1]?.toLowerCase() ?? "";

    if (parts.length <= 1 && !line.endsWith(" ")) {
      const hits = commands.filter((item) => item.startsWith(cmd));
      return [hits.length ? hits : commands, cmd];
    }

    const modelChoices = [
      "list",
      "current",
      "save",
      "pick",
      ...MODEL_OPTIONS.flatMap((option) => option.aliases)
    ];
    const capsuleChoices = ["show", "compact", "clear", "export", "stats", "path"];
    const approvalsChoices = ["status", "on", "off"];
    const doctorChoices = ["brief", "full"];
    const setupChoices = ["noninteractive", "model=", "cloud=", "theme=", "key=", "endpoint="];

    let pool: string[] = [];
    switch (cmd) {
      case "/model":
        pool = modelChoices;
        break;
      case "/capsule":
      case "/memory":
        pool = capsuleChoices;
        break;
      case "/approvals":
        pool = approvalsChoices;
        break;
      case "/doctor":
        pool = doctorChoices;
        break;
      case "/setup":
        pool = setupChoices;
        break;
      default:
        pool = [];
    }

    const token = line.endsWith(" ") ? "" : partial;
    const hits = pool.filter((item) => item.toLowerCase().startsWith(token));
    return [hits.length ? hits : pool, token];
  }

  private async handleCapsuleCommand(args: string[]): Promise<void> {
    const action = (args[0] || "show").toLowerCase();
    if (action === "clear") {
      this.sessionCapsule = null;
      await this.sessionStore.clear();
      output.write("\nSession capsule cleared.\n");
      return;
    }
    if (action === "compact") {
      output.write(this.themeColor(`\n${await this.compactTranscript()}\n`));
      return;
    }
    if (action === "export") {
      await this.exportSessionCapsule(args[1]);
      return;
    }
    if (action === "path") {
      output.write(`\n${this.getDefaultCapsuleExportPath()}\n`);
      return;
    }
    if (!this.sessionCapsule) {
      output.write("\nNo active session capsule.\n");
      return;
    }
    const parsed = this.parseSessionCapsule(this.sessionCapsule.summary);
    if (action === "stats") {
      output.write(
        [
          "",
          `${this.themeColor(pc.bold("Capsule Stats"))}`,
          `${pc.dim("generated:")}    ${this.sessionCapsule.generatedAt}`,
          `${pc.dim("scope:")}        ${this.sessionCapsule.sourceMessages} -> ${this.sessionCapsule.retainedMessages} messages`,
          `${pc.dim("decisions:")}    ${parsed.decisions.length}`,
          `${pc.dim("open threads:")} ${parsed.openThreads.length}`,
          `${pc.dim("next actions:")} ${parsed.nextActions.length}`,
          `${pc.dim("files:")}        ${parsed.filesTouched.length}`,
          `${pc.dim("tools:")}        ${parsed.toolActivity.length}`,
          ""
        ].join("\n")
      );
      return;
    }
    output.write(
      [
        "",
        `${this.themeColor(pc.bold("Session Capsule"))}`,
        `${pc.dim("generated:")} ${this.sessionCapsule.generatedAt}`,
        `${pc.dim("scope:")}     ${this.sessionCapsule.sourceMessages} -> ${this.sessionCapsule.retainedMessages} messages`,
        "",
        this.formatStructuredCapsule(parsed),
        ""
      ].join("\n")
    );
  }

  private handleApprovalsCommand(args: string[]): void {
    const action = (args[0] || "status").toLowerCase();
    if (action === "on") {
      this.autoApproveTools = true;
      output.write("\nAuto-approval enabled for write/run tools.\n");
      return;
    }
    if (action === "off") {
      this.autoApproveTools = false;
      output.write("\nAuto-approval disabled.\n");
      return;
    }
    output.write(`\nAuto-approval: ${this.autoApproveTools ? "on" : "off"}\n`);
  }

  private async handleSetupCommand(args: string[], rl: readline.Interface): Promise<void> {
    const parsed = parseCommandArgs(args);
    if (parsed.positionals[0]?.toLowerCase() !== "noninteractive") {
      await this.runSetup(rl);
      return;
    }

    const current = await loadUserSettings();
    const patch = parsed.keyValues;

    if (Object.keys(patch).length === 0) {
      output.write(
        [
          "",
          "Usage: /setup noninteractive model=sonnet4.6 cloud=on theme=cyan key=- endpoint=-",
          "Keys: model, cloud, theme, key, endpoint",
          ""
        ].join("\n")
      );
      return;
    }

    const resolvedModel = patch.model ? resolveModelOption(String(patch.model)) : null;
    if (patch.model && !resolvedModel && !String(patch.model).includes(".")) {
      output.write(`\nUnknown model alias: ${patch.model}. Use /model list.\n`);
      return;
    }
    if (patch.theme && !ALLOWED_THEMES.has(String(patch.theme))) {
      output.write(`\nInvalid theme: ${patch.theme}. Allowed: ${Array.from(ALLOWED_THEMES).join(", ")}\n`);
      return;
    }

    const nextSettings: UserSettings = {
      modelId: patch.model ? (resolvedModel?.value ?? normalizeModelInput(String(patch.model))) : current.modelId,
      enableCloudCache: patch.cloud ? ["1", "true", "on", "yes", "y"].includes(String(patch.cloud).toLowerCase()) : current.enableCloudCache,
      themeColor: patch.theme ? String(patch.theme) : current.themeColor,
      customApiKey:
        patch.key === "-"
          ? undefined
          : patch.key !== undefined
            ? String(patch.key)
            : current.customApiKey,
      customEndpoint:
        patch.endpoint === "-"
          ? undefined
          : patch.endpoint !== undefined
            ? String(patch.endpoint)
            : current.customEndpoint
    };

    await saveUserSettings(nextSettings);
    output.write(
      [
        "",
        `${pc.green("Settings updated.")}`,
        `${pc.dim("model:")} ${shortModelName(nextSettings.modelId)}`,
        `${pc.dim("cloud:")} ${nextSettings.enableCloudCache ? "on" : "off"}`,
        `${pc.dim("theme:")} ${nextSettings.themeColor}`,
        ""
      ].join("\n")
    );
  }

  private async runDoctor(args: string[] = []): Promise<void> {
    const mode = (args[0] || "brief").toLowerCase();
    const indexStatus: any = await this.backend.callTool("workspace.get_index_status", {});
    const syncStatus: any = await this.backend.callTool("workspace.check_sync", {});
    const transcriptChars = this.estimateTranscriptChars();
    const capsule = this.sessionCapsule ? this.parseSessionCapsule(this.sessionCapsule.summary) : null;

    const lines = [
      "",
      `${this.themeColor(pc.bold("Doctor"))}`,
      `${pc.dim("workspace:")}    ${this.config.agent.workspaceRoot}`,
      `${pc.dim("mode:")}         ${this.config.agent.mode}`,
      `${pc.dim("model:")}        ${shortModelName(this.currentModelId)} ${pc.dim(`(${this.currentModelId})`)}`,
      `${pc.dim("approvals:")}    ${this.autoApproveTools ? pc.green("on") : pc.yellow("off")}`,
      `${pc.dim("cloud sync:")}   ${syncStatus.l2Enabled ? pc.green(`on (${syncStatus.l2Count} capsules)`) : pc.yellow("off")}`,
      `${pc.dim("index:")}        ${indexStatus.cachedFiles}/${indexStatus.totalFiles} cached (${indexStatus.percent}%)`,
      `${pc.dim("session:")}      ${this.transcript.length} messages / ${transcriptChars} chars`,
      `${pc.dim("capsule:")}      ${this.sessionCapsule ? pc.green("loaded") : pc.dim("none")}`,
      `${pc.dim("last tool:")}    ${this.lastToolEventAt ?? "none"}`
    ];

    if (mode === "full") {
      lines.push(
        `${pc.dim("capsule path:")} ${this.getDefaultCapsuleExportPath()}`,
        `${pc.dim("theme:")}        ${this.config.agent.themeColor}`
      );
      if (capsule) {
        lines.push(
          `${pc.dim("decisions:")}    ${capsule.decisions.length ? capsule.decisions.join(" | ") : "-"}`,
          `${pc.dim("open threads:")} ${capsule.openThreads.length ? capsule.openThreads.join(" | ") : "-"}`,
          `${pc.dim("next actions:")} ${capsule.nextActions.length ? capsule.nextActions.join(" | ") : "-"}`
        );
      }
    }

    lines.push("");
    output.write(lines.join("\n"));
  }

  private async exportSessionCapsule(requestedPath?: string): Promise<void> {
    if (!this.sessionCapsule) {
      output.write("\nNo active session capsule to export.\n");
      return;
    }

    const targetPath = requestedPath
      ? path.resolve(this.config.agent.workspaceRoot, requestedPath)
      : this.getDefaultCapsuleExportPath();
    const structured = this.parseSessionCapsule(this.sessionCapsule.summary);
    const content = [
      "# Session Capsule",
      "",
      `- Generated: ${this.sessionCapsule.generatedAt}`,
      `- Workspace: ${this.config.agent.workspaceRoot}`,
      `- Scope: ${this.sessionCapsule.sourceMessages} -> ${this.sessionCapsule.retainedMessages} messages`,
      "",
      this.formatStructuredCapsule(structured),
      ""
    ].join("\n");

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
    output.write(`\nSession capsule exported to ${targetPath}\n`);
  }

  private buildRuntimeSystemPrompt(): string {
    const sections = [SYSTEM_PROMPT];
    if (this.workspaceContext) {
      sections.push(this.workspaceContext);
    }
    if (this.sessionCapsule) {
      sections.push(
        [
          "Session capsule:",
          this.sessionCapsule.summary,
          `Capsule metadata: generated_at=${this.sessionCapsule.generatedAt} source_messages=${this.sessionCapsule.sourceMessages} retained_messages=${this.sessionCapsule.retainedMessages}`
        ].join("\n")
      );
    }
    return sections.join("\n\n");
  }

  private async autoCompactIfNeeded(): Promise<string | null> {
    if (this.transcript.length < 18 && this.estimateTranscriptChars() < 18000) {
      return null;
    }
    return this.compactTranscript({ reason: "auto" });
  }

  private async compactTranscript(options?: { reason?: "manual" | "auto" }): Promise<string> {
    if (this.transcript.length === 0) {
      return "Transcript already empty. No compaction needed.";
    }

    const sourceMessages = this.transcript.length;
    const retainedMessages = Math.min(6, sourceMessages);
    const retained = this.transcript.slice(-retainedMessages);
    const older = this.transcript.slice(0, Math.max(0, sourceMessages - retainedMessages));
    const summary = this.buildSessionCapsuleSummary(older, retained);

    this.sessionCapsule = {
      summary,
      generatedAt: new Date().toISOString(),
      sourceMessages,
      retainedMessages
    };
    this.transcript = retained;
    await this.sessionStore.save(this.sessionCapsule);

    const prefix = options?.reason === "auto" ? "Auto-compacted session." : "Session compacted.";
    const saved = Math.max(0, sourceMessages - retainedMessages);
    return `${prefix} Retained ${retainedMessages} recent messages, compressed ${saved} older messages into capsule.`;
  }

  private buildSessionCapsuleSummary(older: ConverseMessage[], retained: ConverseMessage[]): string {
    const userRequests: string[] = [];
    const assistantReplies: string[] = [];
    const toolCalls: string[] = [];
    const toolResults: string[] = [];
    const filesTouched: string[] = [];

    for (const message of older) {
      for (const block of message.content) {
        if ("text" in block && block.text.trim()) {
          const normalized = this.normalizeCapsuleLine(block.text);
          if (!normalized) continue;
          if (message.role === "user") {
            if (userRequests.length < 8) userRequests.push(normalized);
          } else {
            if (assistantReplies.length < 8) assistantReplies.push(normalized);
          }
        }
        if ("toolUse" in block) {
          const args = formatArgsPreview(block.toolUse.input);
          toolCalls.push(`${block.toolUse.name} ${args}`);
          const input = block.toolUse.input as Record<string, unknown>;
          if (typeof input.path === "string" && input.path.trim()) {
            filesTouched.push(input.path.trim());
          }
        }
        if ("toolResult" in block) {
          const firstText = block.toolResult.content.find((item) => "text" in item && typeof item.text === "string");
          if (firstText && "text" in firstText) {
            const normalized = this.normalizeCapsuleLine(firstText.text);
            if (normalized) toolResults.push(normalized);
          }
        }
      }
    }

    const previous = this.sessionCapsule ? this.parseSessionCapsule(this.sessionCapsule.summary) : null;
    const structured: StructuredSessionCapsule = {
      summary: this.normalizeCapsuleLine(
        assistantReplies[assistantReplies.length - 1] || userRequests[userRequests.length - 1] || `Conversation progressed through ${older.length} summarized messages.`,
        220
      ),
      decisions: uniqueLimited(
        [
          ...(previous?.decisions ?? []),
          ...assistantReplies.slice(-4),
          ...toolResults.filter((entry) => /saved|updated|created|switched|cleared|exported|connected|indexed/i.test(entry))
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        8
      ),
      openThreads: uniqueLimited(
        [
          ...(previous?.openThreads ?? []),
          ...userRequests.slice(-5),
          ...toolResults.filter((entry) => /error|failed|denied|omitted|unknown/i.test(entry))
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        8
      ),
      nextActions: uniqueLimited(
        [
          ...(previous?.nextActions ?? []),
          ...assistantReplies.filter((entry) => /next|should|can|recommend|suggest/i.test(entry)),
          retained.length ? `Continue from ${retained.length} preserved recent messages.` : ""
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        8
      ),
      filesTouched: uniqueLimited(
        [
          ...(previous?.filesTouched ?? []),
          ...filesTouched
        ].map((entry) => this.normalizeCapsuleLine(entry, 120)),
        12
      ),
      toolActivity: uniqueLimited(
        [
          ...(previous?.toolActivity ?? []),
          ...toolCalls.slice(-8),
          ...toolResults.slice(-4)
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        12
      )
    };

    return this.serializeStructuredCapsule(structured);
  }

  private serializeStructuredCapsule(capsule: StructuredSessionCapsule): string {
    const sections = [
      `summary: ${capsule.summary}`,
      ...this.serializeCapsuleSection("decisions", capsule.decisions),
      ...this.serializeCapsuleSection("open_threads", capsule.openThreads),
      ...this.serializeCapsuleSection("next_actions", capsule.nextActions),
      ...this.serializeCapsuleSection("files_touched", capsule.filesTouched),
      ...this.serializeCapsuleSection("tool_activity", capsule.toolActivity)
    ];
    return sections.join("\n");
  }

  private serializeCapsuleSection(name: string, values: string[]): string[] {
    return [
      `${name}:`,
      ...(values.length ? values.map((value) => `- ${value}`) : ["- none"])
    ];
  }

  private parseSessionCapsule(raw: string): StructuredSessionCapsule {
    const lines = String(raw || "").split("\n");
    const result: StructuredSessionCapsule = {
      summary: "",
      decisions: [],
      openThreads: [],
      nextActions: [],
      filesTouched: [],
      toolActivity: []
    };

    let currentSection: keyof Omit<StructuredSessionCapsule, "summary"> | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("summary:")) {
        result.summary = trimmed.slice("summary:".length).trim();
        currentSection = null;
        continue;
      }
      if (trimmed === "decisions:") {
        currentSection = "decisions";
        continue;
      }
      if (trimmed === "open_threads:") {
        currentSection = "openThreads";
        continue;
      }
      if (trimmed === "next_actions:") {
        currentSection = "nextActions";
        continue;
      }
      if (trimmed === "files_touched:") {
        currentSection = "filesTouched";
        continue;
      }
      if (trimmed === "tool_activity:") {
        currentSection = "toolActivity";
        continue;
      }
      if (trimmed.startsWith("- ") && currentSection) {
        const value = trimmed.slice(2).trim();
        if (value && value !== "none") {
          result[currentSection].push(value);
        }
      }
    }

    if (!result.summary) {
      result.summary = this.normalizeCapsuleLine(raw, 220);
    }
    return result;
  }

  private formatStructuredCapsule(capsule: StructuredSessionCapsule): string {
    return [
      `Summary: ${capsule.summary}`,
      ...this.formatCapsuleSection("Decisions", capsule.decisions),
      ...this.formatCapsuleSection("Open Threads", capsule.openThreads),
      ...this.formatCapsuleSection("Next Actions", capsule.nextActions),
      ...this.formatCapsuleSection("Files Touched", capsule.filesTouched),
      ...this.formatCapsuleSection("Tool Activity", capsule.toolActivity)
    ].join("\n");
  }

  private formatCapsuleSection(title: string, values: string[]): string[] {
    return [
      "",
      title,
      ...(values.length ? values.map((value) => `- ${value}`) : ["- none"])
    ];
  }

  private getDefaultCapsuleExportPath(): string {
    return path.join(this.config.agent.workspaceRoot, ".mesh", "session-capsule.md");
  }

  private normalizeCapsuleLine(text: string, maxLen = 180): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (!singleLine) return "";
    return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen - 3)}...` : singleLine;
  }

  private estimateTranscriptChars(): number {
    return this.transcript.reduce((total, message) => {
      return total + message.content.reduce((contentTotal, block) => {
        if ("text" in block) {
          return contentTotal + block.text.length;
        }
        if ("toolUse" in block) {
          return contentTotal + JSON.stringify(block.toolUse.input).length + block.toolUse.name.length;
        }
        if ("toolResult" in block) {
          return contentTotal + JSON.stringify(block.toolResult).length;
        }
        return contentTotal;
      }, 0);
    }, 0);
  }
}
