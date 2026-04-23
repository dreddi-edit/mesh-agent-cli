import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";
import ora from "ora";
import boxen from "boxen";
import pkg from "enquirer";
type EnquirerCtor = new (options: Record<string, unknown>) => { run(): Promise<unknown> };
const { Select, Confirm, Input } = pkg as unknown as { Select: EnquirerCtor; Confirm: EnquirerCtor; Input: EnquirerCtor };

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
  "You are Mesh, a high-performance terminal AI coding agent designed by edgarelmo.",
  "Your purpose is to assist developers with complex engineering tasks directly within their workspace.",
  "Core Principles:",
  "1. Efficiency: Use tools to gather ground-truth data instead of making assumptions. Follow the CAPSULE-FIRST hierarchy: Always prefer 'workspace.read_file' (Capsules) and 'workspace.grep_capsules' (Cache-search) for initial understanding. ONLY use 'workspace.read_file_raw' or 'workspace.grep_content' when you have a confirmed need to edit code or see exact implementation details missing from the capsule.",
  "2. Precision: When analyzing code, be exact about file paths, line numbers, and syntax.",
  "3. Mesh-Compression: All tool outputs are processed through the Mesh-Compression pipeline. This pipeline normalizes whitespaces, removes redundant JSON structures, and uses advanced compression algorithms to fit massive amounts of technical context into your limited attention window.",
  "4. Action-Oriented: Focus on solving the user's problem. Give concise, direct final answers. Avoid markdown headers, verbose fluff, or redundant summaries.",
  "5. Adaptability: Match the language of the user (German or English).",
  "Operating Environment: You run as a CLI tool on the user's machine with access to a rich toolset. Your priority is to minimize I/O and token usage by leveraging the Mesh-Compression cache aggressively. If you feel you lack context, suggest the user run '/index' to pre-cache the entire workspace."
].join("\n");

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
  pricing: { inputPer1k: number; outputPer1k: number };
}

interface ParsedCommandArgs {
  positionals: string[];
  keyValues: Record<string, string>;
}

interface IndexStatus {
  cachedFiles: number;
  totalFiles: number;
  percent: string;
}

interface SyncStatus {
  l2Enabled: boolean;
  l2Count: number;
}

const MODEL_OPTIONS: ModelOption[] = [
  {
    label: "Claude Sonnet 4.6",
    value: "us.anthropic.claude-sonnet-4-6",
    aliases: ["sonnet4.6", "sonnet-4.6", "sonnet46"],
    note: "default",
    pricing: { inputPer1k: 0.003, outputPer1k: 0.015 }
  },
  {
    label: "Claude Opus 4.6",
    value: "us.anthropic.claude-opus-4-6-v1",
    aliases: ["opus4.6", "opus-4.6", "opus46"],
    note: "powerful",
    pricing: { inputPer1k: 0.015, outputPer1k: 0.075 }
  },
  {
    label: "Claude Haiku 4.5",
    value: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    aliases: ["haiku4.5", "haiku-4.5", "haiku45"],
    note: "modern fast",
    pricing: { inputPer1k: 0.00025, outputPer1k: 0.00125 }
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

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

function fitTerminalLine(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

export class AgentLoop {
  private ghostTextListener: ((...args: unknown[]) => void) | null = null;
  private readonly llm: BedrockLlmClient;
  private readonly useAnsi = output.isTTY;
  private readonly sessionStore: SessionCapsuleStore;
  private currentModelId: string;
  private currentBranch = "nogit";
  private localInstructions = "";
  private transcript: ConverseMessage[] = [];
  private sessionCapsule: SessionCapsule | null = null;
  private lastToolEventAt: string | null = null;
  private sessionTokens = { inputTokens: 0, outputTokens: 0 };
  private workspaceContext = "";
  private abortController: AbortController | null = null;
  private autoApproveTools = false;
  private themeColor: (text: string) => string = pc.cyan;

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
    
    const colorStr = config.agent.themeColor || "cyan";
    const colorFn = pc[colorStr as keyof typeof pc];
    if (typeof colorFn === "function") {
      this.themeColor = colorFn as (text: string) => string;
    }
  }

  async runCli(initialPrompt?: string): Promise<void> {
    await this.checkInit();
    this.sessionCapsule = await this.sessionStore.load();

    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const cwd = this.config.agent.workspaceRoot;
      const [branchResult, statusResult] = await Promise.allSettled([
        execFileAsync("git", ["branch", "--show-current"], { cwd }),
        execFileAsync("git", ["status", "--short"], { cwd })
      ]);
      const gitBranch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
      const gitStatus = statusResult.status === "fulfilled" ? statusResult.value.stdout.trim() : "";
      if (gitBranch) {
        this.currentBranch = gitBranch;
        this.workspaceContext = `Workspace context:\n- Git branch: ${gitBranch}\n- Git status:\n${gitStatus || "clean"}`;
      }
    } catch {
      // Not a git repository or git not installed
    }

    try {
      const instrPath = path.join(this.config.agent.workspaceRoot, ".mesh", "instructions.md");
      this.localInstructions = await fs.readFile(instrPath, "utf-8");
    } catch {
      // No local instructions
    }

    if (initialPrompt?.trim()) {
      const result = await this.runSingleTurn(initialPrompt);
      output.write(`${result}\n`);
      return;
    }

    this.printBanner();
    await this.printStatus();

    let lastSigInt = 0;

    while (true) {
      const rl = readline.createInterface({
        input: input,
        output: output,
        terminal: true,
        completer: (line) => this.completeInput(line)
      });
      this.setupGhostText(rl, input, output);

      rl.on("SIGINT", () => {
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
          output.write("\n\n" + pc.dim("Request aborted. Returning to prompt.") + "\n");
        } else {
          const now = Date.now();
          if (now - lastSigInt < 2000) {
            rl.close();
            process.exit(0);
          } else {
            lastSigInt = now;
            output.write("\n" + this.themeColor(pc.bold("Press Ctrl+C again within 2s to exit")) + "\n");
            // Clear current line and trigger loop restart
            (rl as any).line = "";
            rl.write("\n");
          }
        }
      });

      const prompt = this.buildPrompt();
      let userInput = "";
      try {
        userInput = (await rl.question(prompt)).trim();
      } catch (err) {
        rl.close();
        break;
      }

      if (!userInput) {
        rl.close();
        continue;
      }

      if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
        rl.close();
        break;
      }

      if (userInput.startsWith("/")) {
        const handled = await this.handleSlashCommand(userInput, rl);
        rl.close();
        if (handled.shouldExit) {
          break;
        }
        if (handled.wasHandled) {
          continue;
        }
      }

      try {
        const spinner = this.useAnsi ? ora({ text: "Thinking...", color: "cyan", stream: output }).start() : undefined;
        let answer: string | undefined;
        try {
          answer = await this.runSingleTurn(userInput, {
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
              // Use a fresh RL for permission to avoid prompt conflicts
              const tempRl = readline.createInterface({ input, output });
              const ans = (await tempRl.question(p)).trim().toLowerCase();
              tempRl.close();
              
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
        } finally {
          if (spinner) {
            spinner.stop();
            spinner.clear();
          }
        }

        if (answer) {
          this.renderAssistantTurn(answer);
        }

        const compactionMessage = await this.autoCompactIfNeeded();
        if (compactionMessage) {
          this.renderSystemMessage(compactionMessage);
        }
      } catch (err) {
        this.renderSystemMessage(pc.red(`Error: ${(err as Error).message}`));
      } finally {
        rl.close();
      }
    }
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

    const preTurnLength = this.transcript.length;
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
        if (selectedTool.tool.requiresApproval && !this.autoApproveTools) {
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
      this.transcript = this.transcript.slice(0, preTurnLength);
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

    // Banner split into parts so we can color the two brackets independently:
    //   mesh  → themeColor (user-configurable via config.agent.themeColor)
    //   left  → themeColor (stays in sync with MESH)
    //   right → accentColor (brand purple, stays purple across themes)
    const bannerRows: Array<{ mesh: string; left: string; right: string }> = [
      { mesh: "███╗   ███╗███████╗███████╗██╗  ██╗", left: "    ▄██ ", right: " ██▄    " },
      { mesh: "████╗ ████║██╔════╝██╔════╝██║  ██║", left: "  ▄██▀  ", right: "  ▀██▄  " },
      { mesh: "██╔████╔██║█████╗  ███████╗███████║", left: "▄██▀    ", right: "    ▀██▄" },
      { mesh: "██║╚██╔╝██║██╔══╝  ╚════██║██╔══██║", left: "▀██▄    ", right: "    ▄██▀" },
      { mesh: "██║ ╚═╝ ██║███████╗███████║██║  ██║", left: "  ▀██▄  ", right: "  ▄██▀  " },
      { mesh: "╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝", left: "    ▀██ ", right: " ██▀    " }
    ];
    const meshGap = "          "; // 10 spaces between MESH text and left bracket
    const bracketGap = "       "; //  7 spaces between left and right bracket

    // Brand accent for the right bracket. Falls back to magenta if not a valid pc key.
    const accentName = (this.config.agent as { accentColor?: string }).accentColor || "magenta";
    const pcMap = pc as unknown as Record<string, (s: string) => string>;
    const accentFn = typeof pcMap[accentName] === "function" ? pcMap[accentName] : pc.magenta;

    const statusRows = [
      `mesh  ${this.config.agent.mode}  ${shortPathLabel(this.config.agent.workspaceRoot)}`,
      `branch: ${this.currentBranch}   model: ${shortModelName(this.currentModelId)}`,
      "commands: /help /status /capsule /model pick /setup /clear /exit",
      "tip: Type / and press TAB for command completion"
    ];

    if (!this.useAnsi) {
      output.write("\n" + hr + "\n");
      output.write(
        bannerRows
          .map((r) => r.mesh + meshGap + r.left + bracketGap + r.right)
          .join("\n") + "\n"
      );
      output.write(statusRows.join("\n") + "\n");
      return;
    }

    output.write("\n" + this.themeColor(hr) + "\n");
    output.write(
      bannerRows
        .map(
          (r) =>
            this.themeColor(pc.bold(r.mesh + meshGap + r.left)) +
            bracketGap +
            accentFn(pc.bold(r.right))
        )
        .join("\n") + "\n"
    );
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
      return `\n${pc.cyan("◈")} ${pc.bold("mesh")} // ${pc.dim(this.currentBranch)} ${pc.cyan("›")} `;
    }
    const width = Math.max(48, Math.min(output.columns || 80, 140));
    const label = ` mesh/${this.currentBranch} `;
    const leftLine = "───";
    const rightLineLen = width - leftLine.length - label.length;
    const rightLine = rightLineLen > 0 ? "─".repeat(rightLineLen) : "";
    
    const top = `${this.themeColor(leftLine)}${pc.white(pc.bold(label))}${this.themeColor(rightLine)}`;
    const bottom = `${this.themeColor("❯")} `;
    
    return `\n${top}\n${bottom}`;
  }


  private async printSync(): Promise<void> {
    const status = await this.backend.callTool("workspace.check_sync", {}) as SyncStatus;
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
    const status = await this.backend.callTool("workspace.get_index_status", {}) as IndexStatus;
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

    try {
      // 1. Default Model
      const modelChoices = MODEL_OPTIONS.map(opt => ({
        name: opt.value,
        message: `${pc.bold(opt.label)} ${pc.dim(opt.note)}`,
        hint: opt.value === current.modelId ? pc.green("(current)") : pc.dim(opt.value)
      }));

      const modelPrompt = new Select({
        name: "modelId",
        message: "Select Default Model",
        choices: modelChoices,
        initial: MODEL_OPTIONS.findIndex(o => o.value === current.modelId),
        stdin: input,
        stdout: output
      });
      const modelId = await modelPrompt.run() as string;
      (rl as any).resume();

      // 2. Cloud Sync
      const cloudPrompt = new Confirm({
        name: "enableCloudCache",
        message: "Enable Cloud (L2) Sync?",
        initial: current.enableCloudCache,
        stdin: input,
        stdout: output
      });
      const enableCloudCache = await cloudPrompt.run() as boolean;
      (rl as any).resume();

      // 3. Theme Color
      const themeChoices = Array.from(ALLOWED_THEMES).map(t => ({
        name: t,
        message: t,
        hint: t === current.themeColor ? pc.green("(current)") : ""
      }));

      const themePrompt = new Select({
        name: "themeColor",
        message: "Select Theme Color",
        choices: themeChoices,
        initial: Array.from(ALLOWED_THEMES).indexOf(current.themeColor),
        stdin: input,
        stdout: output
      });
      const themeColor = await themePrompt.run() as string;
      (rl as any).resume();

      // 4. Custom API Key
      const keyPrompt = new Input({
        name: "customApiKey",
        message: "Custom API Key (Enter to keep current, '-' to clear)",
        initial: "",
        stdin: input,
        stdout: output
      });
      const keyRaw = await keyPrompt.run() as string;
      (rl as any).resume();
      const customApiKey = keyRaw === "" ? current.customApiKey : (keyRaw === "-" ? undefined : keyRaw);

      const newSettings: UserSettings = {
        modelId,
        enableCloudCache,
        themeColor,
        customApiKey
      };

      await saveUserSettings(newSettings);
      
      // Apply changes to runtime state
      this.currentModelId = modelId;
      const colorFn = pc[themeColor as keyof typeof pc];
      if (typeof colorFn === "function") {
        this.themeColor = colorFn as (text: string) => string;
      }
      this.config.agent.enableCloudCache = enableCloudCache;
      this.config.agent.themeColor = themeColor;

      output.write(pc.green("\n✔ Settings saved and applied!\n"));
      
      // Immediate UI refresh with new colors
      output.write(this.useAnsi ? "\x1b[2J\x1b[H" : "\n");
      this.printBanner();
      await this.printStatus();
    } catch {
      output.write(pc.dim("\nSetup cancelled.\n"));
    }
  }
  private async checkInit(): Promise<void> {
    const meshDir = path.join(this.config.agent.workspaceRoot, ".mesh");
    const workspaceMetaPath = path.join(meshDir, "workspace.json");
    const meshDirExists = await fs.access(meshDir).then(() => true).catch(() => false);
    const metaExists = await fs.access(workspaceMetaPath).then(() => true).catch(() => false);

    if (!meshDirExists) {
      await fs.mkdir(meshDir, { recursive: true });
      await fs.mkdir(path.join(meshDir, "index"), { recursive: true });
      await fs.mkdir(path.join(meshDir, "history"), { recursive: true });
      
      const instructions = [
        "# Mesh Project Instructions 🛸",
        "",
        "This file defines the engineering soul of this project.",
        "",
        "## 🧠 System Architecture & Intelligence",
        "*   **Capsule Cache:** All transient file summaries (L1 Cache) are stored outside this repository.",
        "*   **Project Intelligence:** The `.mesh/` folder contains high-level artifacts.",
        "",
        "## 📏 Coding Standards",
        "1.  **DRY & KISS:** Favor simplicity over clever abstractions.",
        "2.  **Type Safety:** Strive for 100% type coverage.",
        "3.  **Mesh Optimization:** Use `patch_file` for small changes.",
        ""
      ].join("\n");
      await fs.writeFile(path.join(meshDir, "instructions.md"), instructions);
      
      await fs.writeFile(path.join(meshDir, "architecture.md"), "# Architecture\n\n*Generated during indexing...*");
      await fs.writeFile(path.join(meshDir, "dependency_graph.md"), "# Dependency Graph\n\n*Generated during indexing...*");
    }

    // Always update/create config.json by merging with existing
    const configPath = path.join(meshDir, "config.json");
    let existingConfig = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existingConfig = JSON.parse(raw);
    } catch {
      // New file or invalid JSON
    }

    const config = {
      ...existingConfig,
      modelId: this.config.bedrock.modelId,
      themeColor: this.config.agent.themeColor,
      enableCloudCache: this.config.agent.enableCloudCache,
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // If meta doesn't exist, it's the first time -> Auto Index
    if (!metaExists) {
      output.write(`${pc.cyan("◈")} ${pc.bold("New workspace detected. Initializing intelligence...")}\n`);
      await this.runIndexing();
      
      const meta = {
        firstIndexedAt: new Date().toISOString(),
        lastIndexedAt: new Date().toISOString(),
        status: "indexed"
      };
      await fs.writeFile(workspaceMetaPath, JSON.stringify(meta, null, 2));
    }
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
    const model = MODEL_OPTIONS.find(
      (o) => this.currentModelId.includes(o.value) || o.value.includes(this.currentModelId)
    );
    const { inputPer1k, outputPer1k } = model?.pricing ?? { inputPer1k: 0.003, outputPer1k: 0.015 };
    const cost = (inT * inputPer1k / 1000) + (outT * outputPer1k / 1000);
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
        const setupResult = await this.handleSetupCommand(args, rl);
        return { wasHandled: true, shouldExit: setupResult.shouldExit };
      case "/clear":
        output.write(this.useAnsi ? "\x1b[2J\x1b[H" : "\n");
        this.printBanner();
        return { wasHandled: true, shouldExit: false };
      case "/model":
        const modelResult = await this.handleModelCommand(args, rl);
        return { wasHandled: true, shouldExit: modelResult.shouldExit };
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

  private async handleModelCommand(args: string[], rl: readline.Interface): Promise<{ shouldExit: boolean }> {
    const parsed = parseCommandArgs(args);
    const nextModel = [...parsed.positionals, parsed.keyValues.model ?? ""].join(" ").trim();
    if (!nextModel || nextModel === "pick" || nextModel === "choose") {
      await this.chooseModelInteractive(rl);
      return { shouldExit: false };
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
      return { shouldExit: false };
    }
    if (nextModel === "current") {
      output.write(`\ncurrent model: ${this.currentModelId}\n`);
      return { shouldExit: false };
    }
    if (nextModel === "save") {
      const current = await loadUserSettings();
      await saveUserSettings({ ...current, modelId: this.currentModelId });
      output.write(`\ndefault model saved: ${this.themeColor(shortModelName(this.currentModelId))}\n`);
      return { shouldExit: false };
    }
    const resolved = resolveModelOption(nextModel);
    if (!resolved && nextModel.startsWith("/")) {
      output.write(`\nInvalid model argument: ${nextModel}\n`);
      return { shouldExit: false };
    }
    this.currentModelId = resolved?.value ?? normalizeModelInput(nextModel);
    output.write(`\nmodel switched: ${this.themeColor(shortModelName(this.currentModelId))}\n`);
    return { shouldExit: false };
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
      
      // Restore CLI state
      (rl as any).resume();
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
      
      // Restore CLI state again
      (rl as any).resume();
      this.setupGhostText(rl, input, output);

      if (shouldSave) {
        const current = await loadUserSettings();
        await saveUserSettings({ ...current, modelId: picked.value });
        output.write(pc.green("Default model saved.\n"));
      }
    } catch {
      (rl as any).resume();
      this.setupGhostText(rl, input, output);
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

  private async handleSetupCommand(args: string[], rl: readline.Interface): Promise<{ shouldExit: boolean }> {
    const parsed = parseCommandArgs(args);
    if (parsed.positionals[0]?.toLowerCase() !== "noninteractive") {
      await this.runSetup(rl);
      return { shouldExit: false };
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
      return { shouldExit: false };
    }

    const resolvedModel = patch.model ? resolveModelOption(String(patch.model)) : null;
    if (patch.model && !resolvedModel && !String(patch.model).includes(".")) {
      output.write(`\nUnknown model alias: ${patch.model}. Use /model list.\n`);
      return { shouldExit: false };
    }
    if (patch.theme && !ALLOWED_THEMES.has(String(patch.theme))) {
      output.write(`\nInvalid theme: ${patch.theme}. Allowed: ${Array.from(ALLOWED_THEMES).join(", ")}\n`);
      return { shouldExit: false };
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
    return { shouldExit: false };
  }

  private async runDoctor(args: string[] = []): Promise<void> {
    const mode = (args[0] || "brief").toLowerCase();
    const indexStatus = await this.backend.callTool("workspace.get_index_status", {}) as IndexStatus;
    const syncStatus = await this.backend.callTool("workspace.check_sync", {}) as SyncStatus;
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
    if (this.localInstructions) {
      sections.push(`\nLocal Project Instructions:\n${this.localInstructions}`);
    }
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
    const tokenThreshold = 80_000;
    if (this.transcript.length < 18 && this.sessionTokens.inputTokens < tokenThreshold) {
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
