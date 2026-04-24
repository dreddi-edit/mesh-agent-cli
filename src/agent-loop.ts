import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";
import ora from "ora";
import boxen from "boxen";
import pkg from "enquirer";
import os from "node:os";
import http from "node:http";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// Initialize marked with terminal renderer
marked.use(markedTerminal() as any);

type EnquirerCtor = new (options: Record<string, unknown>) => { run(): Promise<unknown> };
const { Select, Confirm, Input } = pkg as unknown as { Select: EnquirerCtor; Confirm: EnquirerCtor; Input: EnquirerCtor };

import { AppConfig, loadUserSettings, saveUserSettings, shortPathLabel, UserSettings, VoiceSettings } from "./config.js";
import {
  BedrockLlmClient,
  ConverseMessage,
  ContentBlock,
  ToolSpec,
  LlmResponse,
  ConverseUsage
} from "./llm-client.js";
import { buildLlmSafeMeshContext } from "./mesh-gateway.js";
import { PersistedSessionCapsule, SessionCapsuleStore } from "./session-capsule-store.js";
import { MeshPortal } from "./mesh-portal.js";
import { ToolBackend, ToolDefinition } from "./tool-backend.js";
import { VoiceManager } from "./voice-manager.js";

const SYSTEM_PROMPT = [
  "You are Mesh, a high-performance terminal AI coding agent designed by edgarelmo.",
  "Your purpose is to assist developers with complex engineering tasks directly within their workspace.",
  "Core Principles:",
  "1. Efficiency: Follow the CAPSULE-FIRST hierarchy: Prefer 'workspace.ask_codebase' with the right mode, then 'workspace.read_file', 'workspace.read_dir_overview', and exact raw reads only when needed.",
  "2. Local Code Intelligence: 'workspace.ask_codebase' uses the persistent local index and returns citations. Use modes: architecture, bug, edit-impact, test-impact, ownership, recent-change, runtime-path.",
  "2a. Symbol and Impact Tools: Use 'workspace.explain_symbol' for definitions/callers and 'workspace.impact_map' before risky edits.",
  "3. Void-Protocol (MAX COMPRESSION): Use 'workspace.generate_lexicon' to get a dictionary of project terms. Then use #ID in 'workspace.alien_patch' (e.g. !1 > { #A = a: #B() }) for near-zero token edits.",
  "3. Ghost Timeline Lifecycle: When proposing a critical fix, use 'agent.race_fixes' to try multiple parallel strategies. Compare results and promote the best one. For single manual fixes, use 'workspace.timeline_create', apply a patch, run verification, and promote.",
  "4. Predictive Pathing: You will sometimes see [PREDICTIVE CONTEXT] in your prompt. This is Mesh pre-loading likely relevant dependencies based on your last actions.",
  "5. Time-Travel AST Diffing: Use 'workspace.get_recent_changes' to see background modifications without re-reading files.",
  "6. Symbolic Trace Routing: Use 'workspace.trace_symbol' to trace data flow deterministically.",
  "7. Multi-Agent OS: For broad work, create role-scoped workers with 'agent.spawn' using .mesh/agents definitions, review timelines with 'agent.review', and merge with 'agent.merge_verified'.",
  "8. Micro-Edits: For simple renames, use 'workspace.rename_symbol'.",
  "9. Parallelism: ALWAYS batch your tool calls.",
  "10. Runtime Cognition: Use 'runtime.start', 'runtime.capture_failure', and 'runtime.explain_failure' for live command/test debugging. Use 'frontend.preview' for real terminal screenshots via Chrome CDP; use 'web.inspect_ui' only when Playwright-style inspection is needed.",
  "11. Moonshot OS: Use 'workspace.digital_twin' before major work, 'workspace.intent_compile' for product asks, 'workspace.predictive_repair' for failing diagnostics, 'workspace.engineering_memory' for repo-specific rules, and 'workspace.cockpit_snapshot' for operational status.",
  "12. Legendary Moonshots: Use 'workspace.causal_intelligence' for causal repo reasoning, 'workspace.discovery_lab' for autonomous improvement experiments, and 'workspace.reality_fork' to compare alternate implementation realities before risky work.",
  "12a. Ghost Engineer Replay: Use 'workspace.ghost_engineer' to learn the user's repo-specific engineering style, predict how they would implement a goal, check divergence, and materialize a style-conformant timeline plan.",
  "13. Plan-First & Finalization: Use 'agent.plan'.",
  "14. Action-Oriented: Focus on solving the user's problem. Give concise, direct final answers.",
  "15. Adaptability: Match the language of the user (German or English).",
  "16. Mesh-Alien-OS (MAX EFFICIENCY): To save 90% tokens, use 'workspace.session_index_symbols' first to get IDs for file symbols. Then use 'workspace.alien_patch' with Symbolic Opcodes:",
  "    Opcode Rosetta Stone: e: (export) | s: (async) | f: (function) | c: (const) | l: (let) | r: (return) | a: (await) | i: (if) | p: (Promise) | cn: (console.log) | th: (throw new Error)",
  "    Patch Format: !ID > { [ALIENT_CODE] }",
  "Operating Environment: You run as a CLI tool on the user's machine. Minimize I/O and token usage by leveraging the Mesh-Compression cache aggressively. If you feel you lack context, suggest the user run '/index' to pre-cache the entire workspace."
].join("\n");

const VOICE_SYSTEM_PROMPT = [
  "Voice mode is active.",
  "Respond for spoken conversation, not for markdown reading.",
  "Use short natural sentences.",
  "Reply in plain text only.",
  "Never use emojis, bullet lists, markdown formatting, headings, code fences, or decorative symbols.",
  "Keep answers very short unless the user explicitly asks for more detail.",
  "Avoid reading punctuation-heavy structures aloud.",
  "If the user asks a coding question, answer briefly first and only give commands or code when truly necessary."
].join("\n");

const VOICE_LANGUAGE_CHOICES = [
  { name: "auto", message: "Auto-detect", hint: "Use Whisper language detection" },
  { name: "de", message: "Deutsch", hint: "de" },
  { name: "en", message: "English", hint: "en" },
  { name: "ar", message: "Arabic", hint: "ar" },
  { name: "es", message: "Spanish", hint: "es" },
  { name: "fr", message: "French", hint: "fr" },
  { name: "it", message: "Italian", hint: "it" },
  { name: "ja", message: "Japanese", hint: "ja" },
  { name: "pt", message: "Portuguese", hint: "pt" }
];

const VOICE_TRANSCRIPTION_MODEL_CHOICES = [
  { name: "base", message: "Base", hint: "fastest, lower accuracy, ~141 MB" },
  { name: "small", message: "Small", hint: "recommended, better accuracy, ~466 MB" },
  { name: "medium", message: "Medium", hint: "best accuracy, slowest, ~1.5 GB" }
];

const VOICE_LANGUAGE_LABELS: Record<string, string> = {
  ar: "Arabic",
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  ja: "Japanese",
  pt: "Portuguese"
};

const RECOMMENDED_SYSTEM_VOICE_BY_LANGUAGE: Record<string, string> = {
  de: "Anna",
  en: "Daniel",
  es: "Mónica",
  fr: "Jacques",
  it: "Alice",
  ja: "Kyoko",
  pt: "Luciana"
};

const VOICE_EXIT_PATTERNS = [
  /^\/voice off$/,
  /^(voice|voice mode|voice chat)\s+(off|stop|exit|quit|disable)(\s+(please|now))?$/,
  /^(stop|exit|quit|disable)\s+(voice|voice mode|voice chat)(\s+(please|now))?$/,
  /^(stop listening|stop recording)$/,
  /^(voice|sprachmodus|stimmmodus)\s+(aus|off)(\s+bitte)?$/,
  /^(beende|beenden|stoppe|stopp)\s+(voice|sprachmodus|stimmmodus)(\s+bitte)?$/,
  /^(zuruck|zuruck zum text|zuruck zum textmodus)$/,
  /^(zurück|zurück zum text|zurück zum textmodus)$/,
  /^(textmodus|text modus)\s+(an|zuruck)$/,
  /^(textmodus|text)\s+bitte$/
];

interface WireTool {
  wireName: string;
  tool: ToolDefinition;
}

interface RunHooks {
  onToolStart?: (wireName: string, input: Record<string, unknown>, step: number, maxSteps: number) => void;
  onToolEnd?: (wireName: string, ok: boolean, resultPreview: string) => void;
  askPermission?: (msg: string) => Promise<boolean>;
  onDelta?: (delta: string) => void;
  onCommandChunk?: (chunk: string) => void;
  silent?: boolean;
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
  private dynamicMaxSteps: number;
  private themeColor: (text: string) => string = pc.cyan;
  private persistentHistory: string[] = [];
  private readonly historyPath = path.join(os.homedir(), ".mesh_history");
  private voiceManager: VoiceManager;
  private voiceMode = false;
  private voiceLanguage = "en";
  private prefetchQueue: string[] = [];
  private dashboardSocket: any = null;
  private entangledWorkspaces: string[] = [];
  private gitStatusContext = "";
  private consecutiveErrors = new Map<string, number>();
  private portal: MeshPortal;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend
  ) {
    this.sessionStore = new SessionCapsuleStore(config.agent.workspaceRoot);
    this.dynamicMaxSteps = config.agent.maxSteps;
    this.portal = new MeshPortal(config.agent.workspaceRoot);
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

    this.voiceManager = this.buildVoiceManager();
    this.syncVoiceLanguage();
  }

  private buildVoiceManager(): VoiceManager {
    return new VoiceManager({
      whisperModel: path.join(
        this.config.agent.workspaceRoot,
        ".mesh",
        "models",
        `ggml-${this.config.agent.voice.transcriptionModel}.bin`
      ),
      piperModel: path.join(this.config.agent.workspaceRoot, ".mesh", "models", "en_US-lessac-medium.onnx"),
      voiceLanguage: this.config.agent.voice.language,
      voiceSpeed: this.config.agent.voice.speed,
      voiceName: this.config.agent.voice.voice,
      voiceInput: this.config.agent.voice.microphone,
      transcriptionModel: this.config.agent.voice.transcriptionModel
    });
  }

  private applyVoiceSettings(voice: VoiceSettings): void {
    this.config.agent.voice = { ...voice };
    this.voiceManager.updateConfig({
      voiceLanguage: voice.language,
      voiceSpeed: voice.speed,
      voiceName: voice.voice,
      voiceInput: voice.microphone,
      transcriptionModel: voice.transcriptionModel,
      whisperModel: path.join(
        this.config.agent.workspaceRoot,
        ".mesh",
        "models",
        `ggml-${voice.transcriptionModel}.bin`
      )
    });
    this.syncVoiceLanguage(voice.language);
  }

  private normalizeLanguageCode(language?: string): string {
    return String(language || "auto")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");
  }

  private getConfiguredVoiceLanguage(): string {
    return this.normalizeLanguageCode(this.config.agent.voice.language);
  }

  private syncVoiceLanguage(detectedLanguage?: string): void {
    const configured = this.getConfiguredVoiceLanguage();
    this.voiceLanguage =
      configured === "auto"
        ? this.normalizeLanguageCode(detectedLanguage || this.voiceLanguage || "en")
        : configured;
  }

  private getVoiceReplyLanguage(): string {
    const configured = this.getConfiguredVoiceLanguage();
    return configured === "auto"
      ? this.normalizeLanguageCode(this.voiceLanguage || "en")
      : configured;
  }

  private buildVoiceLanguageInstruction(): string {
    const replyLanguage = this.getVoiceReplyLanguage();
    const label = VOICE_LANGUAGE_LABELS[replyLanguage.split("-")[0]] || replyLanguage;
    if (this.getConfiguredVoiceLanguage() === "auto") {
      return `Reply in the same language as the user's last spoken message. Current detected language: ${label}.`;
    }
    return `Always reply in ${label} unless the user explicitly asks to switch languages.`;
  }

  private sanitizeVoiceAssistantText(text: string): string {
    const cleaned = text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s+/gm, "")
      .replace(/^\s*[-*•]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[•▪◦●○◆◇★☆]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned || text.replace(/\s+/g, " ").trim();
  }

  private pickRecommendedSystemVoice(language: string, availableVoices: Array<{ name: string }>): string {
    const normalized = this.normalizeLanguageCode(language).split("-")[0];
    const preferred = RECOMMENDED_SYSTEM_VOICE_BY_LANGUAGE[normalized];
    if (preferred && availableVoices.some((voice) => voice.name === preferred)) {
      return preferred;
    }
    return availableVoices[0]?.name || "auto";
  }

  private sortSystemVoices(language: string, voices: Array<{ name: string; locale: string; sample: string }>) {
    const preferred = this.pickRecommendedSystemVoice(language, voices);
    return [...voices].sort((left, right) => {
      const leftScore = left.name === preferred ? 0 : 1;
      const rightScore = right.name === preferred ? 0 : 1;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return left.name.localeCompare(right.name);
    });
  }

  private normalizeVoiceCommand(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^\p{L}\p{N}\/\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isVoiceExitCommand(text: string): boolean {
    const normalized = this.normalizeVoiceCommand(text);
    if (!normalized) {
      return false;
    }
    return VOICE_EXIT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  private getVoiceExitHint(): string {
    const language = this.getVoiceReplyLanguage().split("-")[0];
    if (language === "de") {
      return 'Sage "Voice aus" oder "beende Sprachmodus", um Voice zu verlassen.';
    }
    if (language === "en") {
      return 'Say "voice off" or "stop voice mode" to leave voice mode.';
    }
    return 'Say "voice off" or "Voice aus" to leave voice mode.';
  }

  private async refreshGitStatus(): Promise<void> {
    try {
      const res = await this.backend.callTool("workspace.git_status", {}) as any;
      if (res.ok) {
        this.gitStatusContext = `${res.branch}\nFiles:\n${res.status || "Clean (no uncommitted changes)"}`;
      }
    } catch {
      this.gitStatusContext = "";
    }
  }

  private async handleInspect(url: string): Promise<void> {
    const port = new URL(url).port || "3000";
    
    // 1. Check if server is already running
    const isRunning = await new Promise(resolve => {
      const socket = new http.ClientRequest({ port: Number(port), method: 'HEAD', timeout: 500 });
      socket.on('response', () => resolve(true));
      socket.on('error', () => resolve(false));
      socket.end();
    });

    if (!isRunning) {
      output.write(pc.yellow(`\n[Mesh Portal] No server detected on port ${port}. Attempting to start dev server...\n`));
      try {
        const pkgPath = path.join(this.config.agent.workspaceRoot, "package.json");
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
        const devScript = pkg.scripts?.dev || pkg.scripts?.start;
        
        if (devScript) {
          const { spawn } = await import("node:child_process");
          const serverProc = spawn("npm", ["run", pkg.scripts?.dev ? "dev" : "start"], {
            cwd: this.config.agent.workspaceRoot,
            stdio: "ignore",
            detached: true
          });
          serverProc.unref();
          output.write(pc.green(`[Mesh Portal] Dev server launched in background. Waiting for port ${port}...\n`));
          
          // Wait for port to open
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await new Promise(res => {
              const s = new http.ClientRequest({ port: Number(port), method: 'HEAD', timeout: 200 });
              s.on('response', () => res(true));
              s.on('error', () => res(false));
              s.end();
            })) break;
          }
        } else {
          throw new Error("No 'dev' or 'start' script found in package.json");
        }
      } catch (e) {
        output.write(pc.red(`[Mesh Portal] Could not start server: ${(e as Error).message}\n`));
      }
    }

    const spinner = ora({ text: `Connecting to Neuro-Kinetic Portal at ${url}...`, color: "cyan" }).start();
    try {
      await this.portal.start(url, async (event) => {
        if (event.name === "meshEmit") {
          await this.handlePortalMutation(event.payload);
        }
      });

      // Inject the overlay script
      const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "mesh-canvas-overlay.js");
      const scriptContent = await fs.readFile(scriptPath, "utf8");
      await this.portal.evaluate(scriptContent);

      spinner.succeed(pc.green(`Visual Portal active on ${url}. Use Alt+Click to edit UI.`));
    } catch (e) {
      spinner.fail(pc.red(`Portal connection failed: ${(e as Error).message}`));
    }
  }

  private async handlePortalMutation(payloadStr: string): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(payloadStr);
    } catch { return; }

    const { type, file, line, prompt, context, xray } = payload;
    const sourceFile = xray?.source?.fileName || file;
    const sourceLine = xray?.source?.lineNumber || line;
    if (!sourceFile || sourceFile === "unknown") return;

    const relPath = path.relative(this.config.agent.workspaceRoot, sourceFile);
    const componentName = xray?.component || this.extractComponentName(context?.tag, context?.classes) || "Anonymous";
    const requests = Array.isArray(xray?.requests) ? xray.requests.slice(0, 5) : [];
    const requestSummaries = await Promise.all(requests.map(async (request: any) => {
      const query = `${String(request.method || "GET").toUpperCase()} ${request.route || request.url || ""}`.trim();
      if (!query) return null;
      const result = await this.backend.callTool("workspace.ask_codebase", {
        query,
        mode: "runtime-path",
        limit: 2
      }).catch(() => null) as any;
      const matches = Array.isArray(result?.results)
        ? result.results.slice(0, 2).map((match: any) => ({
            file: match.file,
            purpose: match.purpose,
            citations: Array.isArray(match.citations)
              ? match.citations.slice(0, 2).map((citation: any) => ({
                  file: citation.file,
                  symbol: citation.symbol,
                  lines: citation.lines,
                  whyMatched: citation.whyMatched
                }))
              : []
          }))
        : [];
      return { request, matches };
    }));
    const tracedSymbol: any = componentName && componentName !== "Anonymous"
      ? await this.backend.callTool("workspace.trace_symbol", { path: relPath, symbol: componentName }).catch(() => null)
      : null;
    const populatedRequestSummaries = requestSummaries.filter(Boolean);
    
    if (type === "PROMPT") {
      process.stdout.write(pc.cyan(`\n[Visual AI] Designing for ${pc.bold(relPath)}:${sourceLine || line || 0}...\n`));
      process.stdout.write(pc.dim(`  " ${prompt} "\n`));

      // Detect Styling Paradigm
      const hasTailwind = await fs.access(path.join(this.config.agent.workspaceRoot, "tailwind.config.js")).then(() => true).catch(() => 
                          fs.access(path.join(this.config.agent.workspaceRoot, "tailwind.config.ts")).then(() => true).catch(() => false));

      const evidenceLines = [
        `Source: ${relPath}:${sourceLine || 0}`,
        `Component: ${componentName}`,
        requests.length > 0 ? `Requests:\n${requests.map((request: any) => `- ${String(request.method || "GET").toUpperCase()} ${request.route || request.url} -> ${request.status}${request.durationMs ? ` (${request.durationMs}ms)` : ""}`).join("\n")}` : "Requests: none captured",
        populatedRequestSummaries.length > 0
          ? `Route matches:\n${populatedRequestSummaries.map((entry: any) => {
              const lines = entry.matches.length > 0
                ? entry.matches.map((match: any) => `- ${match.file}: ${match.purpose}`).join("\n")
                : "- no strong matches";
              return `${entry.request.method} ${entry.request.route || entry.request.url}\n${lines}`;
            }).join("\n")}`
          : "Route matches: none",
        tracedSymbol && tracedSymbol.ok
          ? `Symbol trace:\n${JSON.stringify(tracedSymbol, null, 2)}`
          : "Symbol trace: unavailable",
        `DOM:\n${context.html}`,
        `Parent DOM:\n${context.parentHtml}`
      ].join("\n\n");

      const mutationPrompt = `The user clicked an element in the browser and provided a visual instruction.
Evidence:
${evidenceLines}

User Instruction: "${prompt}"
Styling Paradigm: ${hasTailwind ? "TAILWIND CSS (Use utility classes, avoid inline styles)" : "STANDARD CSS/INLINE"}

Your mission is a two-step process:
1. IMMEDIATELY output a JSON block labeled 'PREVIEW_STYLE' with CSS properties for instant preview.
2. Then, proceed to apply the PERMANENT code patch to the file using your tools.

Ensure the final code is clean, idiomatic, and adheres to the styling paradigm. Finalize once done.`;
      // Intercept the LLM delta stream to catch the PREVIEW_STYLE block
      let previewSent = false;
      const interceptHooks: RunHooks = {
        onDelta: async (delta) => {
          if (!previewSent && delta.includes("PREVIEW_STYLE")) {
            try {
              const match = delta.match(/PREVIEW_STYLE\s*(\{.*?\})/);
              if (match) {
                const styles = JSON.parse(match[1]);
                await this.portal.applyGhostStyles(styles);
                previewSent = true;
                process.stdout.write(pc.green("\n[Ghost Sync] Live preview applied. Capturing for Vision check...\n"));
                
                // Vision Verification Step
                await new Promise(r => setTimeout(r, 300)); // Wait for render
                const base64 = await this.portal.captureElementScreenshot();
                if (base64) {
                  this.transcript.push({
                    role: "user",
                    content: [
                      { text: "Here is a live screenshot of the element after your PREVIEW_STYLE was applied. Visual check: Does this match the user intent? If yes, finalize the code patch. If not, output a corrected PREVIEW_STYLE or adjust your patch." },
                      { image: { format: "png", source: { bytes: base64 } } }
                    ]
                  });
                  process.stdout.write(pc.cyan("[Vision] Screenshot sent to Agent for verification.\n"));
                }
              }
            } catch (e) {
              // Silently fail if JSON is incomplete yet
            }
          }
          process.stdout.write(delta);
        }
      };

      try {
        await this.runSingleTurn(mutationPrompt, interceptHooks);
      } catch (e) {
        process.stdout.write(pc.red(`\n[Visual AI] Error: ${(e as Error).message}\n`));
      }
    } else {
      // Legacy CSS Mutation logic
      // ...
    }
  }

  private extractComponentName(tag?: string, classes?: string): string {
    if (!tag) return "Anonymous";
    const trimmed = String(classes || "").trim();
    const firstClass = trimmed ? trimmed.split(/\s+/)[0] : "";
    return firstClass ? `${tag}.${firstClass}` : tag;
  }

  public async runCli(initialPrompt?: string): Promise<void> {

    await this.checkInit();
    this.sessionCapsule = await this.sessionStore.load();
    
    // Load persistent history
    try {
      const historyRaw = await fs.readFile(this.historyPath, "utf-8");
      this.persistentHistory = historyRaw.split("\n").filter(Boolean).reverse(); // readline expects newest first? No, readline history is old to new. 
      // Actually readline history is [older, ..., newer]
      this.persistentHistory = historyRaw.split("\n").filter(Boolean);
    } catch {
      this.persistentHistory = [];
    }

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
        completer: (line) => this.completeInput(line),
        history: [...this.persistentHistory]
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
        if (this.voiceMode) {
          output.write(this.themeColor(pc.bold("\n[LISTENING]")) + pc.dim(" (Speak for 5s...)\n"));
          try {
            const audioFile = await this.voiceManager.record(5);
            output.write(pc.dim("Transcribing...\n"));
            const transcription = await this.voiceManager.transcribe(audioFile);
            userInput = transcription.text;
            this.syncVoiceLanguage(transcription.language);
            output.write(pc.bold(`❯ ${userInput}\n`));
          } catch (err) {
            output.write(pc.red(`Voice error: ${(err as Error).message}\n`));
            this.voiceMode = false;
            rl.close();
            continue;
          }
        } else {
          userInput = (await rl.question(prompt)).trim();
        }
        // Update persistent history
        if (userInput && !userInput.startsWith("/") && userInput !== this.persistentHistory[this.persistentHistory.length - 1]) {
          this.persistentHistory.push(userInput);
          if (this.persistentHistory.length > 1000) this.persistentHistory.shift();
          await fs.writeFile(this.historyPath, this.persistentHistory.join("\n"), "utf-8");
        }
      } catch (err) {
        rl.close();
        break;
      }

      if (!userInput) {
        rl.close();
        continue;
      }

      if (this.voiceMode && this.isVoiceExitCommand(userInput)) {
        this.voiceMode = false;
        this.renderSystemMessage(pc.green("Voice mode disabled. Back to text input."));
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

      await this.refreshGitStatus();

      try {
        const spinner = this.useAnsi ? ora({ text: "Thinking...", color: "cyan", stream: output }).start() : undefined;
        let answer: string | undefined;
        const tokensBefore = { ...this.sessionTokens };
        try {
          const sharedHooks: RunHooks = {
            onToolStart: (wireName, args, step, maxSteps) => {
              if (spinner) {
                const stepLabel = `[${step + 1}/${maxSteps}]`;
                spinner.text = `${pc.dim(stepLabel)} ${pc.cyan(wireName)} ${pc.dim(formatArgsPreview(args))}`;
              }
              this.renderToolEvent("start", wireName, formatArgsPreview(args));
            },
            onToolEnd: (wireName, ok, resultPreview) => {
              if (spinner) {
                spinner.text = ok ? `done ${pc.cyan(wireName)}` : `failed ${pc.cyan(wireName)}`;
              }
              this.renderToolEvent(ok ? "success" : "error", wireName, resultPreview);
            },
            onCommandChunk: (chunk) => {
              if (spinner) { spinner.stop(); spinner.clear(); }
              output.write(chunk);
            },
            askPermission: async (msg) => {
              if (spinner) spinner.stop();
              const p = this.useAnsi ? pc.yellow(`\n[Action Required]\n${msg}\n[y/N/A]: `) : `\n[Action Required]\n${msg}\n[y/N/A]: `;
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
          };

          if (this.voiceMode) {
            answer = await this.runSingleTurn(userInput, sharedHooks);
            const spokenAnswer = this.sanitizeVoiceAssistantText(answer);
            if (spinner) {
              spinner.stop();
              spinner.clear();
            }
            this.renderAssistantTurn(spokenAnswer, { plainText: true });
            await this.voiceManager.speak(spokenAnswer, this.getVoiceReplyLanguage()).catch((error) => {
              this.renderSystemMessage(pc.red(`Voice output failed: ${(error as Error).message}`));
            });
          } else {
            let hasStartedStreaming = false;
            answer = await this.runSingleTurn(userInput, {
              ...sharedHooks,
              onDelta: (delta) => {
                if (spinner) {
                  spinner.stop();
                  spinner.clear();
                }
                if (!hasStartedStreaming) {
                  hasStartedStreaming = true;
                  output.write("\n" + this.themeColor(pc.bold("assistant")) + pc.dim(" › ") + "\n");
                }
                output.write(delta);
              }
            });
            if (hasStartedStreaming) {
              output.write("\n");
            }
          }
        } finally {
          if (spinner) {
            spinner.stop();
            spinner.clear();
          }
        }

        if (this.useAnsi && !this.voiceMode) {
          const dIn = this.sessionTokens.inputTokens - tokensBefore.inputTokens;
          const dOut = this.sessionTokens.outputTokens - tokensBefore.outputTokens;
          if (dIn > 0 || dOut > 0) {
            const model = MODEL_OPTIONS.find(o => this.currentModelId.includes(o.value) || o.value.includes(this.currentModelId));
            const { inputPer1k, outputPer1k } = model?.pricing ?? { inputPer1k: 0.003, outputPer1k: 0.015 };
            const cost = (dIn * inputPer1k / 1000) + (dOut * outputPer1k / 1000);
            output.write(pc.dim(`\n↑${dIn.toLocaleString()} ↓${dOut.toLocaleString()} tokens · $${cost.toFixed(4)}\n`));
          }
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
    const silent = hooks?.silent;
    const autoCompactMessage = await this.autoCompactIfNeeded();
    if (autoCompactMessage && !silent) {
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

    const spinner = (this.useAnsi && !silent) ? ora({ text: "Thinking...", color: "cyan", stream: output }).start() : undefined;

    try {
      for (let step = 0; step < this.dynamicMaxSteps; step += 1) {
        let response: LlmResponse;

        if (hooks?.onDelta) {
          let accumulatedText = "";
          const streamedToolUses: any[] = [];
          try {
            const stream = this.llm.converseStream(
              this.transcript,
              toolSpecs,
              this.buildRuntimeSystemPrompt(),
              this.currentModelId,
              this.abortController.signal
            );

            for await (const chunk of stream) {
              if (chunk.kind === "text" && chunk.text) {
                accumulatedText += chunk.text;
                if (!silent) hooks.onDelta(chunk.text);
              } else if (chunk.kind === "tool_use") {
                streamedToolUses.push(chunk.toolUse);
              } else if (chunk.kind === "stop") {
                if (chunk.usage) {
                  this.sessionTokens.inputTokens += chunk.usage.inputTokens ?? 0;
                  this.sessionTokens.outputTokens += chunk.usage.outputTokens ?? 0;
                }
              }
            }

            if (streamedToolUses.length > 0) {
              response = {
                kind: "tool_use",
                toolUses: streamedToolUses.map(tu => ({
                  toolUseId: tu.toolUseId,
                  name: tu.name,
                  input: (tu.input ?? {}) as Record<string, unknown>
                })),
                text: accumulatedText || undefined,
                stopReason: "tool_use"
              };
            } else {
              response = {
                kind: "text",
                text: accumulatedText,
                stopReason: "end_turn"
              };
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/LLM streaming failed \((404|405)\)/.test(message)) {
              throw error;
            }

            response = await this.llm.converse(
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

            if (response.text) {
              hooks.onDelta(response.text);
            }
          }
        } else {
          response = await this.llm.converse(
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
        }

        if (response.kind === "text") {
          this.transcript.push({ role: "assistant", content: [{ text: response.text }] });
          return response.text || lastAssistantText || "(no answer)";
        }

        lastAssistantText = response.text ?? lastAssistantText;

        // Record the full assistant turn with all tool uses.
        const assistantContent: ContentBlock[] = [];
        if (response.text) assistantContent.push({ text: response.text });
        for (const tu of response.toolUses) {
          assistantContent.push({ toolUse: { toolUseId: tu.toolUseId, name: tu.name, input: tu.input } });
        }
        this.transcript.push({ role: "assistant", content: assistantContent });

        // Sequential approval pass (TTY prompts can't be parallel).
        const approved = new Map<string, boolean>();
        for (const tu of response.toolUses) {
          const sel = wireToolMap.get(tu.name);
          if (!sel) { approved.set(tu.toolUseId, false); continue; }
          
          if (silent) {
            approved.set(tu.toolUseId, true);
          } else if (sel.tool.requiresApproval && !this.autoApproveTools) {
            const preview = this.buildApprovalPreview(sel.tool.name, tu.input);
            const denied = !hooks?.askPermission || !(await hooks.askPermission(preview));
            approved.set(tu.toolUseId, !denied);
          } else {
            approved.set(tu.toolUseId, true);
          }
        }

        // Parallel execution of all tool calls in this step.
        const toolResults = await Promise.all(response.toolUses.map(async (tu) => {
          const sel = wireToolMap.get(tu.name);
          const toolSignature = `${tu.name}:${JSON.stringify(tu.input)}`;

          if (!sel) {
            return { toolUseId: tu.toolUseId, status: "error" as const, text: `Tool '${tu.name}' is not available.` };
          }
          if (!approved.get(tu.toolUseId)) {
            return {
              toolUseId: tu.toolUseId,
              status: "error" as const,
              text: "Tool requires interactive approval but no TTY is available."
            };
          }
          
          this.emitPulse("tool_start", tu.input.path as string, tu.name);
          if (!silent) {
            if (spinner) {
              const stepLabel = `[${step + 1}/${this.dynamicMaxSteps}]`;
              spinner.text = `${pc.dim(stepLabel)} ${pc.cyan(tu.name)} ${pc.dim(formatArgsPreview(tu.input))}`;
            }
            hooks?.onToolStart?.(tu.name, tu.input, step, this.dynamicMaxSteps);
          }

          try {
            const raw = await this.backend.callTool(sel.tool.name, tu.input, { onProgress: silent ? undefined : hooks?.onCommandChunk });
            
            // Neural Path Prefetching
            if (sel.tool.name === "workspace.read_file" || sel.tool.name === "workspace.expand_execution_path") {
              const filePath = String(tu.input.path ?? "");
              if (filePath) {
                const graph: any = await this.backend.callTool("workspace.get_file_graph", { path: filePath }).catch(() => null);
                if (graph?.ok && graph.dependencies) {
                  for (const dep of graph.dependencies.slice(0, 2)) {
                    const capsule: any = await this.backend.callTool("workspace.read_file", { path: dep, tier: "low" }).catch(() => null);
                    if (capsule?.content) {
                      this.prefetchQueue.push(`File: ${dep}\n${capsule.content}`);
                    }
                  }
                }
              }
            }

            const resultText = await buildLlmSafeMeshContext(sel.tool.name, tu.input, raw);
            if (!silent) hooks?.onToolEnd?.(tu.name, true, this.normalizeCapsuleLine(resultText, 120));
            // Success: clear errors for this signature
            this.consecutiveErrors.delete(toolSignature);
            return { toolUseId: tu.toolUseId, status: "success" as const, text: resultText };
          } catch (error) {
            const errorMsg = (error as Error).message;
            const errorKey = `${toolSignature} -> ${errorMsg}`;
            const errorCount = (this.consecutiveErrors.get(errorKey) || 0) + 1;
            this.consecutiveErrors.set(errorKey, errorCount);

            let resultText = `Tool execution failed: ${errorMsg}`;
            if (errorCount >= 2) {
              resultText += "\n\n[MESH SYSTEM WARNING] This exact error has occurred multiple times. DO NOT retry the same action. Either try a different approach or stop and ask the user for clarification.";
            }
            
            if (!silent) hooks?.onToolEnd?.(tu.name, false, this.normalizeCapsuleLine(resultText, 120));
            return { toolUseId: tu.toolUseId, status: "error" as const, text: resultText };
          }
        }));

        // Push all results as a single user message (required by Bedrock Converse spec).
        this.transcript.push({
          role: "user",
          content: toolResults.map(r => ({
            toolResult: { toolUseId: r.toolUseId, status: r.status, content: [{ text: r.text }] }
          }))
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
      `Stopped after ${this.dynamicMaxSteps} tool steps without final answer.`
    );
  }

  private buildApprovalPreview(toolName: string, input: Record<string, unknown>): string {
    if (toolName === "workspace.write_file") {
      const p = String(input.path ?? "?");
      const preview = String(input.content ?? "").split("\n").slice(0, 10).join("\n");
      return `write_file → ${p}\n${pc.dim("────────────────────")}\n${preview}${String(input.content ?? "").split("\n").length > 10 ? "\n…" : ""}`;
    }
    if (toolName === "workspace.patch_file") {
      const p = String(input.path ?? "?");
      const s = String(input.search ?? "").split("\n").slice(0, 4).join("\n");
      const r = String(input.replace ?? "").split("\n").slice(0, 4).join("\n");
      return `patch_file → ${p}\n${pc.red("--- " + s)}\n${pc.green("+++ " + r)}`;
    }
    if (toolName === "workspace.patch_surgical") {
      const p = String(input.path ?? "?");
      const s = String(input.searchBlock ?? "").split("\n").slice(0, 6).join("\n");
      const r = String(input.replaceBlock ?? "").split("\n").slice(0, 6).join("\n");
      return `patch_surgical → ${p}\n${pc.red("SEARCH:\n" + s)}${String(input.searchBlock ?? "").split("\n").length > 6 ? "\n…" : ""}\n${pc.green("REPLACE:\n" + r)}${String(input.replaceBlock ?? "").split("\n").length > 6 ? "\n…" : ""}`;
    }
    if (toolName === "workspace.run_command") {
      return `run_command\n$ ${pc.bold(String(input.command ?? "?"))}`;
    }
    if (toolName === "workspace.delete_file") {
      return `delete_file → ${pc.red(String(input.path ?? "?"))}`;
    }
    if (toolName === "workspace.move_file") {
      return `move_file  ${String(input.sourcePath ?? "?")} → ${String(input.destinationPath ?? "?")}`;
    }
    return `Allow ${toolName} to run?`;
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
      "commands: /help /status /causal /lab /fork /ghost /dashboard /exit",
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
        `${pc.dim("commands:")} ${pc.magenta("/help")} ${pc.magenta("/status")} ${pc.magenta("/causal")} ${pc.magenta("/lab")} ${pc.magenta("/fork")} ${pc.magenta("/ghost")} ${pc.magenta("/dashboard")} ${pc.magenta("/exit")}`,
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

  private emitPulse(type: string, path?: string, msg?: string) {
    if (this.dashboardSocket) {
      try {
        const payload = JSON.stringify({ type, path, msg });
        const buf = Buffer.from(payload);
        const frame = Buffer.alloc(2 + buf.length);
        frame[0] = 0x81;
        frame[1] = buf.length;
        buf.copy(frame, 2);
        this.dashboardSocket.write(frame);
      } catch {
        this.dashboardSocket = null;
      }
    }
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

      const voice = await this.runVoiceSetupWizard(rl, current.voice);
      if (!voice) {
        output.write(pc.dim("\nSetup cancelled.\n"));
        return;
      }

      const newSettings: UserSettings = {
        modelId,
        enableCloudCache,
        themeColor,
        customApiKey,
        customEndpoint: current.customEndpoint,
        voice
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
      this.applyVoiceSettings(voice);

      output.write(pc.green("\n✔ Settings saved and applied!\n"));
      
      // Immediate UI refresh with new colors
      output.write(this.useAnsi ? "\x1b[2J\x1b[H" : "\n");
      this.printBanner();
      await this.printStatus();
    } catch {
      output.write(pc.dim("\nSetup cancelled.\n"));
    }
  }

  private async runVoiceSetupWizard(
    rl: readline.Interface,
    current: VoiceSettings
  ): Promise<VoiceSettings | null> {
    try {
      const languagePrompt = new Select({
        name: "voiceLanguage",
        message: "Voice language",
        choices: VOICE_LANGUAGE_CHOICES.map((choice) => ({
          name: choice.name,
          message: choice.message,
          hint: choice.name === current.language ? pc.green("(current)") : pc.dim(choice.hint)
        })),
        initial: Math.max(0, VOICE_LANGUAGE_CHOICES.findIndex((choice) => choice.name === current.language)),
        stdin: input,
        stdout: output
      });
      const language = await languagePrompt.run() as string;
      (rl as any).resume();

      const sttPrompt = new Select({
        name: "voiceTranscriptionModel",
        message: "Transcription quality",
        choices: VOICE_TRANSCRIPTION_MODEL_CHOICES.map((choice) => ({
          name: choice.name,
          message: choice.message,
          hint:
            choice.name === current.transcriptionModel
              ? pc.green("(current)")
              : pc.dim(choice.hint)
        })),
        initial: Math.max(
          0,
          VOICE_TRANSCRIPTION_MODEL_CHOICES.findIndex(
            (choice) => choice.name === current.transcriptionModel
          )
        ),
        stdin: input,
        stdout: output
      });
      const transcriptionModel = await sttPrompt.run() as string;
      (rl as any).resume();

      const audioDevices = this.voiceManager.listAudioInputDevices();
      const microphoneChoices = [
        {
          name: "default",
          message: "Default microphone",
          hint: current.microphone === "default" ? pc.green("(current)") : pc.dim("Use macOS default input")
        },
        ...audioDevices.map((device) => ({
          name: device.id,
          message: `${device.name} ${pc.dim(`#${device.id}`)}`,
          hint: device.id === current.microphone ? pc.green("(current)") : pc.dim("Specific audio input")
        }))
      ];
      const microphonePrompt = new Select({
        name: "voiceMicrophone",
        message: "Microphone",
        choices: microphoneChoices,
        initial: Math.max(0, microphoneChoices.findIndex((choice) => choice.name === current.microphone)),
        stdin: input,
        stdout: output
      });
      const microphone = await microphonePrompt.run() as string;
      (rl as any).resume();

      const speedPrompt = new Input({
        name: "voiceSpeed",
        message: "Voice speed (recommended 220-320)",
        initial: String(current.speed),
        stdin: input,
        stdout: output
      });
      const speedRaw = await speedPrompt.run() as string;
      (rl as any).resume();
      const speed = Number(speedRaw);
      if (!Number.isFinite(speed) || speed < 120 || speed > 420) {
        output.write(pc.red("\nInvalid voice speed. Use a value between 120 and 420.\n"));
        return null;
      }

      const availableVoices = this.voiceManager.listSystemVoices();
      const normalizedLanguage = language.toLowerCase();
      const filteredVoices =
        normalizedLanguage === "auto"
          ? availableVoices
          : availableVoices.filter((voice) => voice.locale.toLowerCase().startsWith(`${normalizedLanguage}_`) || voice.locale.toLowerCase().startsWith(`${normalizedLanguage}-`) || voice.locale.toLowerCase() === normalizedLanguage);
      const voicePool = this.sortSystemVoices(language, filteredVoices.length > 0 ? filteredVoices : availableVoices);
      const recommendedVoice = this.pickRecommendedSystemVoice(language, voicePool);
      const voiceChoices = [
        {
          name: "auto",
          message: "Auto choose voice",
          hint:
            language === "auto"
              ? pc.dim("Match detected language")
              : pc.dim(`Default for ${language}: ${recommendedVoice}`)
        },
        ...voicePool.map((voice) => ({
          name: voice.name,
          message: `${voice.name} ${pc.dim(voice.locale)}`,
          hint:
            voice.name === current.voice
              ? pc.green("(current)")
              : voice.name === recommendedVoice
                ? pc.green("(recommended)")
                : pc.dim(voice.sample)
        }))
      ];

      const voicePrompt = new Select({
        name: "voiceName",
        message: "Voice",
        choices: voiceChoices,
        initial: Math.max(
          0,
          voiceChoices.findIndex((choice) =>
            choice.name === current.voice ||
            (current.voice === "auto" && choice.name === "auto")
          )
        ),
        stdin: input,
        stdout: output
      });
      const voiceName = await voicePrompt.run() as string;
      (rl as any).resume();

      this.setupGhostText(rl, input, output);
      return {
        configured: true,
        language,
        speed,
        voice: voiceName,
        microphone,
        transcriptionModel
      };
    } catch {
      (rl as any).resume();
      this.setupGhostText(rl, input, output);
      return null;
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
      voice: this.config.agent.voice,
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

  private async distillProjectBrain(): Promise<void> {
    const spinner = ora({ text: "Distilling Project Brain (analyzing conventions)...", color: "magenta" }).start();
    try {
      const res = await this.backend.callTool("agent.invoke_sub_agent", {
        prompt: "Read the most important files in this workspace (like package.json, config files, and core source files). Analyze the tech stack, naming conventions, state management, and architectural patterns. Write a concise, bullet-point markdown guide (max 15 bullets) that a senior engineer would need to perfectly blend into this codebase. Focus ONLY on conventions, not features."
      });
      
      const summary = (res as any).summary || (res as any).error;
      if (!summary) throw new Error("Sub-agent failed to generate summary.");

      const brainPath = path.join(this.config.agent.workspaceRoot, ".mesh", "project-brain.md");
      await fs.mkdir(path.dirname(brainPath), { recursive: true });
      await fs.writeFile(brainPath, summary, "utf8");

      spinner.succeed(pc.magenta("Project Brain distilled and saved to .mesh/project-brain.md"));
      output.write(pc.dim(summary) + "\n");
    } catch (e) {
      spinner.fail(pc.red(`Distillation failed: ${(e as Error).message}`));
    }
  }

  private async runSynthesize(): Promise<void> {
    const intentPath = path.join(this.config.agent.workspaceRoot, ".mesh", "latest_intent.json");
    try {
      const intentRaw = await fs.readFile(intentPath, "utf8");
      const intent = JSON.parse(intentRaw);
      
      output.write(pc.cyan(`\n[Predictive Synthesis] Analyzing your recent change: ${intent.message}\n`));
      
      const syntheticPrompt = `You are a Predictive Synthesis orchestrator. I recently modified '${intent.file}'. 
The heuristic engine detected this intent: "${intent.message}". 
Here is the git diff:
${intent.diff}

Your task:
1. Understand the broader architectural implications of this change (e.g., if a DB field was added, it likely needs UI, API, and test updates).
2. DO NOT write code manually in your response.
3. Instead, aggressively use 'agent.spawn_swarm' to delegate the updates across the stack in parallel, or use 'workspace.ghost_verify' to implement them safely.
4. Finish by running 'workspace.finalize_task' to wrap these synthesized changes into a new branch.`;

      // Clear the intent file so it doesn't trigger again
      await fs.unlink(intentPath).catch(() => {});
      
      // Inject into the main loop
      await this.runSingleTurn(syntheticPrompt);
    } catch (e) {
      output.write(pc.yellow("\nNo recent structural intent detected by the watcher. Save a file with significant changes first.\n"));
    }
  }

  private async runHologram(args: string[]): Promise<void> {
    if (args[0] !== "start" || !args[1]) {
      output.write(pc.yellow("Usage: /hologram start <command>\nExample: /hologram start npm run dev\n"));
      return;
    }
    const command = args.slice(1).join(" ");
    output.write(pc.cyan(`\n[Live Memory Hologram] Injecting telemetry proxy into '${command}'...\n`));
    
    // Auto-instruct the agent to run the telemetry tool and standby for errors
    await this.runSingleTurn(`Execute the command '${command}' using 'workspace.run_with_telemetry'. If the process crashes and you receive a memory dump of the V8 engine, analyze the exact variable states, find the root cause, and fix it using 'workspace.alien_patch' or 'workspace.patch_surgical'.`);
  }

  private async runEntangle(args: string[]): Promise<void> {
    const target = args[0];
    if (!target) {
      output.write(pc.yellow("Usage: /entangle <relative-path>\nExample: /entangle ../frontend-repo\n"));
      return;
    }
    const absTarget = path.resolve(this.config.agent.workspaceRoot, target);
    try {
      const stat = await fs.stat(absTarget);
      if (!stat.isDirectory()) throw new Error("Not a directory");
      if ((this.backend as any).entangledWorkspaces) {
        (this.backend as any).entangledWorkspaces.push(absTarget);
      }
      this.entangledWorkspaces.push(absTarget);
      output.write(pc.cyan(`\n[Quantum Entanglement] Workspace '${path.basename(absTarget)}' is now entangled. AST mutations will sync automatically.\n`));
    } catch {
      output.write(pc.red(`\nFailed to entangle: Directory '${absTarget}' does not exist.\n`));
    }
  }

  private async runInspect(args: string[]): Promise<void> {
    output.write(pc.cyan("\n[Neuro-Kinetic UI] Please open the /dashboard. Mouse movements on the canvas will now be translated to AST edits via the LLM.\n(Note: This requires an active dashboard session).\n"));
  }

  private async runFrontendPreview(args: string[]): Promise<void> {
    const url = args[0]?.trim();
    if (!url) {
      output.write(pc.yellow("Usage: /preview <url> [widthxheight] [protocol=auto|kitty|iterm2|sixel|none]\n"));
      return;
    }

    const dims = args.find((arg) => /^\d+x\d+$/i.test(arg));
    const [widthRaw, heightRaw] = dims ? dims.toLowerCase().split("x") : ["1280", "800"];
    const protocolArg = args.find((arg) => arg.startsWith("protocol="));
    const protocol = protocolArg?.split("=")[1] || "auto";

    const spinner = this.useAnsi ? ora({ text: "Capturing frontend preview via Chrome CDP...", color: "cyan", stream: output }).start() : undefined;
    try {
      const result: any = await this.backend.callTool(
        "frontend.preview",
        {
          url,
          width: Number(widthRaw),
          height: Number(heightRaw),
          protocol,
          render: true
        },
        {
          onProgress: (chunk) => {
            if (spinner) {
              spinner.stop();
              spinner.clear();
            }
            output.write(chunk);
          }
        }
      );
      if (spinner) spinner.succeed("Frontend preview captured.");
      output.write(
        [
          "",
          `${pc.dim("url:")}        ${result.url}`,
          `${pc.dim("viewport:")}   ${result.width}x${result.height}`,
          `${pc.dim("screenshot:")} ${result.screenshotPath}`,
          `${pc.dim("protocol:")}   ${result.protocol}${result.rendered ? "" : " (not rendered inline)"}`,
          ""
        ].join("\n")
      );
    } catch (error) {
      if (spinner) spinner.fail("Frontend preview failed.");
      output.write(pc.red(`\nPreview failed: ${(error as Error).message}\n`));
    }
  }

  private async runFix(): Promise<void> {
    const backend: any = this.backend;
    if (backend.speculativeFixes && backend.speculativeFixes.size > 0) {
      const entry = backend.speculativeFixes.entries().next().value;
      const file = entry[0];
      const patch = entry[1];
      
      output.write(pc.cyan(`\n[🧠 Mesh Resolving] Applying pre-computed fix for '${file}'...\n`));
      
      const syntheticPrompt = `I have a pre-computed speculative fix for the error in '${file}'. 
Please review this patch and apply it using 'workspace.alien_patch' if it looks correct:
${patch}

Finish by running 'workspace.finalize_task' with the commit message "Fix linter error in ${file} (Auto-Resolved)".`;

      backend.speculativeFixes.delete(file);
      await this.runSingleTurn(syntheticPrompt);
    } else {
      output.write(pc.yellow("\nNo background fixes currently available. Try introducing an error or running /doctor.\n"));
    }
  }

  private async runDigitalTwin(args: string[]): Promise<void> {
    const action = args[0] || "build";
    const spinner = ora({ text: `Digital Twin ${action}...`, color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.digital_twin", { action });
      spinner.succeed(pc.cyan(`Digital Twin ${action} complete.`));
      const twin = result.twin ?? result;
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("files:")} ${twin.files?.total ?? twin.files ?? "n/a"}`,
        `${pc.dim("symbols:")} ${twin.symbols?.length ?? twin.symbols ?? "n/a"}`,
        `${pc.dim("routes:")} ${twin.routes?.length ?? twin.routes ?? "n/a"}`,
        `${pc.dim("risk hotspots:")} ${twin.riskHotspots?.length ?? twin.riskHotspots ?? "n/a"}`,
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Digital Twin failed: ${(error as Error).message}`));
    }
  }

  private async runPredictiveRepair(args: string[]): Promise<void> {
    const action = args[0] || "analyze";
    const spinner = ora({ text: `Predictive Repair ${action}...`, color: "yellow" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.predictive_repair", { action });
      spinner.succeed(pc.yellow(`Predictive Repair ${action} complete.`));
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("diagnostics:")} ${result.diagnosticsOk ? pc.green("clean") : pc.red("attention")}`,
        `${pc.dim("queue:")} ${Array.isArray(result.queue) ? result.queue.length : 0}`,
        ...(Array.isArray(result.queue) ? result.queue.slice(0, 5).map((item: any) => `${pc.yellow("•")} ${item.summary} ${pc.dim((item.files ?? []).join(", "))}`) : []),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Predictive Repair failed: ${(error as Error).message}`));
    }
  }

  private async runEngineeringMemory(args: string[]): Promise<void> {
    const action = args[0] || "read";
    const spinner = ora({ text: `Engineering Memory ${action}...`, color: "magenta" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.engineering_memory", { action });
      spinner.succeed(pc.magenta(`Engineering Memory ${action} complete.`));
      const memory = result.memory ?? {};
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("rules:")} ${(memory.rules ?? []).length}`,
        `${pc.dim("risk modules:")} ${(memory.riskModules ?? []).length}`,
        ...(memory.rules ?? []).slice(0, 6).map((rule: string) => `${pc.magenta("•")} ${rule}`),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Engineering Memory failed: ${(error as Error).message}`));
    }
  }

  private async runIntentCompile(args: string[]): Promise<void> {
    const intent = args.join(" ").trim();
    if (!intent) {
      output.write(pc.yellow("Usage: /intent <product intent>\n"));
      return;
    }
    const spinner = ora({ text: "Compiling intent...", color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.intent_compile", { intent });
      spinner.succeed(pc.cyan("Intent compiled."));
      const contract = result.contract;
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("likely files:")} ${contract.likelyFiles.join(", ") || "none"}`,
        `${pc.dim("verification:")} ${contract.rollout.verificationCommand}`,
        ...contract.phases.map((phase: string, index: number) => `${pc.cyan(`${index + 1}.`)} ${phase}`),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Intent compile failed: ${(error as Error).message}`));
    }
  }

  private async runCausalIntelligence(args: string[]): Promise<void> {
    const action = args[0] || "build";
    const query = action === "query" ? args.slice(1).join(" ").trim() : "";
    if (action === "query" && !query) {
      output.write(pc.yellow("Usage: /causal query <question>\n"));
      return;
    }
    const spinner = ora({ text: `Causal Intelligence ${action}...`, color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.causal_intelligence", { action, query });
      spinner.succeed(pc.cyan(`Causal Intelligence ${action} complete.`));
      if (action === "query") {
        output.write([
          "",
          `${pc.dim("answer:")} ${result.answer}`,
          ...((result.topInsights ?? []).slice(0, 5).map((insight: any) => `${pc.cyan("•")} ${insight.severity} ${insight.title}`)),
          ""
        ].join("\n"));
        return;
      }
      const graph = result.graph ?? result;
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("nodes:")} ${graph.nodes?.length ?? graph.nodes ?? "n/a"}`,
        `${pc.dim("edges:")} ${graph.edges?.length ?? graph.edges ?? "n/a"}`,
        `${pc.dim("insights:")} ${graph.insights?.length ?? graph.insights ?? "n/a"}`,
        ...((graph.insights ?? []).slice(0, 5).map((insight: any) => `${pc.cyan("•")} ${insight.severity} ${insight.title}`)),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Causal Intelligence failed: ${(error as Error).message}`));
    }
  }

  private async runDiscoveryLab(args: string[]): Promise<void> {
    const action = args[0] || "run";
    const spinner = ora({ text: `Discovery Lab ${action}...`, color: "yellow" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.discovery_lab", { action });
      spinner.succeed(pc.yellow(`Discovery Lab ${action} complete.`));
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("discoveries:")} ${Array.isArray(result.discoveries) ? result.discoveries.length : 0}`,
        ...((result.discoveries ?? []).slice(0, 6).map((item: any) => `${pc.yellow("•")} ${item.severity} ${item.hypothesis}`)),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Discovery Lab failed: ${(error as Error).message}`));
    }
  }

  private async runRealityFork(args: string[]): Promise<void> {
    const actions = new Set(["plan", "fork", "status", "clear"]);
    const first = args[0] || "plan";
    const action = actions.has(first) ? first : "plan";
    const intent = actions.has(first) ? args.slice(1).join(" ").trim() : args.join(" ").trim();
    if ((action === "plan" || action === "fork") && !intent) {
      output.write(pc.yellow("Usage: /fork [plan|fork] <intent>\n"));
      return;
    }
    const spinner = ora({ text: `Reality Fork ${action}...`, color: "magenta" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.reality_fork", { action, intent });
      spinner.succeed(pc.magenta(`Reality Fork ${action} complete.`));
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("intent:")} ${result.intent ?? "n/a"}`,
        `${pc.dim("proposals:")} ${Array.isArray(result.proposals) ? result.proposals.length : result.proposals ?? 0}`,
        ...((result.proposals ?? []).slice(0, 5).map((proposal: any) => {
          const timeline = proposal.timelineId ? pc.dim(` timeline=${proposal.timelineId}`) : "";
          return `${pc.magenta("•")} ${proposal.score} ${proposal.strategy}${timeline}`;
        })),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Reality Fork failed: ${(error as Error).message}`));
    }
  }

  private async runGhostEngineer(args: string[]): Promise<void> {
    const actions = new Set(["learn", "profile", "status", "predict", "divergence", "patch", "clear"]);
    const first = args[0] || "profile";
    const action = actions.has(first) ? first : "predict";
    const payload = actions.has(first) ? args.slice(1).join(" ").trim() : args.join(" ").trim();
    if ((action === "predict" || action === "patch") && !payload) {
      output.write(pc.yellow("Usage: /ghost predict <goal> or /ghost patch <goal>\n"));
      return;
    }
    if (action === "divergence" && !payload) {
      output.write(pc.yellow("Usage: /ghost divergence <plan>\n"));
      return;
    }
    const spinner = ora({ text: `Ghost Engineer ${action}...`, color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.ghost_engineer", {
        action,
        goal: action === "predict" || action === "patch" ? payload : undefined,
        plan: action === "divergence" ? payload : undefined
      });
      spinner.succeed(pc.cyan(`Ghost Engineer ${action} complete.`));

      if (action === "predict") {
        const prediction = result.prediction;
        output.write([
          "",
          `${pc.dim("path:")} ${result.path}`,
          `${pc.dim("prediction:")} ${prediction.prediction}`,
          `${pc.dim("verification:")} ${prediction.predictedApproach.verificationCommand}`,
          `${pc.dim("alignment:")} ${prediction.divergence.verdict} / ${prediction.divergence.alignmentScore}`,
          ...prediction.predictedApproach.firstReads.slice(0, 6).map((file: string) => `${pc.cyan("•")} read ${file}`),
          ""
        ].join("\n"));
        return;
      }

      if (action === "divergence") {
        const divergence = result.divergence;
        output.write([
          "",
          `${pc.dim("alignment:")} ${divergence.verdict} / ${divergence.alignmentScore}`,
          ...((divergence.warnings ?? []).map((warning: any) => `${pc.yellow("•")} ${warning.severity} ${warning.message}`)),
          ""
        ].join("\n"));
        return;
      }

      if (action === "patch") {
        output.write([
          "",
          `${pc.dim("path:")} ${result.path}`,
          `${pc.dim("timeline:")} ${result.timelineId}`,
          `${pc.dim("verification:")} ${result.autopilot.predictedApproach.verificationCommand}`,
          ...result.autopilot.autopilotPatch.suggestedPatchOrder.slice(0, 5).map((step: string) => `${pc.cyan("•")} ${step}`),
          ""
        ].join("\n"));
        return;
      }

      const profile = result.profile ?? result;
      output.write([
        "",
        `${pc.dim("path:")} ${result.path}`,
        `${pc.dim("learned:")} ${profile.learnedAt ?? "n/a"}`,
        `${pc.dim("confidence:")} ${profile.confidence ?? "n/a"}`,
        `${pc.dim("patch shape:")} ${profile.habits?.patchShape ?? "n/a"}`,
        ...((profile.habits?.firstReadFiles ?? []).slice(0, 6).map((file: string) => `${pc.cyan("•")} ${file}`)),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Ghost Engineer failed: ${(error as Error).message}`));
    }
  }

  private async launchDashboard(): Promise<void> {
    const spinner = ora({ text: "Initializing Mesh Pulse Neural Interface...", color: "cyan" }).start();
    try {
      // 1. Gather rich structural data
      const filesRes: any = await this.backend.callTool("workspace.list_files", { limit: 500 });
      const cockpit: any = await this.backend.callTool("workspace.cockpit_snapshot", {}).catch(() => null);
      const nodes: any[] = [];
      const links: any[] = [];
      const seenFiles = new Set(filesRes.files);

      // Build basic nodes
      for (const f of filesRes.files) {
        if (f.match(/\.(ts|js|tsx|jsx|css|md|json)$/)) {
          const depth = f.split("/").length;
          nodes.push({ 
            id: f, 
            name: path.basename(f),
            group: f.includes("node_modules") ? 0 : (f.includes("src") ? 1 : 2),
            val: Math.max(2, 10 - depth) 
          });
        }
      }

      // Proactively fetch some links for the initial "WOW" effect
      const sampleFiles = filesRes.files.filter((f: string) => f.endsWith(".ts") || f.endsWith(".js")).slice(0, 20);
      for (const f of sampleFiles) {
        const graph: any = await this.backend.callTool("workspace.get_file_graph", { path: f }).catch(() => null);
        if (graph?.dependencies) {
          for (const dep of graph.dependencies) {
            if (seenFiles.has(dep)) {
              links.push({ source: f, target: dep });
            }
          }
        }
      }

      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MESH // NEURAL PULSE</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    :root {
      --bg: #050505;
      --accent: #00f2ff;
      --node-src: #00f2ff;
      --node-other: #ff00ea;
      --text: #e0e0e0;
      --panel: rgba(10, 10, 10, 0.9);
      --border: #1a1a1a;
    }
    body { margin: 0; background: var(--bg); overflow: hidden; color: var(--text); font-family: 'JetBrains Mono', 'Fira Code', monospace; }
    
    #header { position: absolute; top: 0; left: 0; right: 0; height: 50px; background: var(--panel); border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 20px; z-index: 100; letter-spacing: 2px; }
    #header .brand { color: var(--accent); font-weight: bold; font-size: 18px; text-shadow: 0 0 10px var(--accent); }
    #header .status { margin-left: auto; font-size: 10px; color: #555; }

    #info-panel { position: absolute; top: 70px; left: 20px; width: 300px; background: var(--panel); border: 1px solid var(--border); padding: 15px; z-index: 90; backdrop-filter: blur(10px); }
    #info-panel h2 { margin: 0 0 10px 0; font-size: 14px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 5px; }
    #info-panel .content { font-size: 11px; line-height: 1.4; color: #aaa; }
    #cockpit-panel { position: absolute; top: 70px; right: 20px; width: 360px; background: var(--panel); border: 1px solid var(--border); padding: 12px; z-index: 90; backdrop-filter: blur(10px); }
    #cockpit-panel h2 { margin: 0 0 10px 0; font-size: 12px; color: var(--accent); text-transform: uppercase; }
    .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .metric { border: 1px solid #181818; padding: 8px; min-height: 44px; background: rgba(255,255,255,0.03); }
    .metric .label { font-size: 9px; color: #666; text-transform: uppercase; }
    .metric .value { margin-top: 4px; font-size: 16px; color: #fff; }

    #log-panel { position: absolute; bottom: 20px; right: 20px; width: 400px; height: 250px; background: var(--panel); border: 1px solid var(--border); padding: 10px; z-index: 90; display: flex; flex-direction: column; overflow: hidden; }
    #log-panel h3 { margin: 0 0 5px 0; font-size: 10px; color: #666; text-transform: uppercase; }
    #log-stream { flex: 1; overflow-y: auto; font-size: 10px; color: #888; }
    .log-entry { margin-bottom: 4px; border-left: 2px solid var(--accent); padding-left: 8px; animation: fadeIn 0.3s ease; }
    .log-entry .time { color: #444; margin-right: 5px; }
    .log-entry .tag { color: var(--accent); font-weight: bold; margin-right: 5px; }

    .node { cursor: pointer; }
    .node circle { stroke: #000; stroke-width: 1px; transition: r 0.3s, fill 0.3s, filter 0.3s; }
    .node text { font-size: 8px; fill: #555; pointer-events: none; transition: fill 0.3s, font-size 0.3s; }
    .node:hover circle { filter: brightness(1.5) drop-shadow(0 0 8px var(--accent)); }
    .node:hover text { fill: #fff; font-size: 12px; }
    .link { stroke: #222; stroke-opacity: 0.4; stroke-width: 1px; }

    .pulse { animation: nodePulse 1.5s infinite; }
    @keyframes nodePulse {
      0% { filter: drop-shadow(0 0 2px #fff); }
      50% { filter: drop-shadow(0 0 15px var(--accent)); }
      100% { filter: drop-shadow(0 0 2px #fff); }
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }

    svg { cursor: move; }
  </style>
</head>
<body>
  <div id="header">
    <div class="brand">MESH // NEURAL PULSE v2.0</div>
    <div class="status">SYSTEM.CONNECTED // WORKSPACE: ${path.basename(this.config.agent.workspaceRoot).toUpperCase()}</div>
  </div>

  <div id="info-panel">
    <h2 id="file-name">Select a node</h2>
    <div class="content" id="file-meta">Click a file node to inspect its neural capsule state and dependencies.</div>
  </div>

  <div id="cockpit-panel">
    <h2>Architecture Cockpit</h2>
    <div class="metric-grid" id="cockpit-metrics"></div>
  </div>

  <div id="log-panel">
    <h3>Neural Activity Stream</h3>
    <div id="log-stream"></div>
  </div>

  <svg id="canvas"></svg>

  <script>
    const width = window.innerWidth, height = window.innerHeight;
    const data = { nodes: ${JSON.stringify(nodes)}, links: ${JSON.stringify(links)} };
    const cockpit = ${JSON.stringify(cockpit ?? {})};
    const metrics = [
      ["health", cockpit.health && cockpit.health.status ? cockpit.health.status + " / " + cockpit.health.score : "unknown"],
      ["files", cockpit.digitalTwin && cockpit.digitalTwin.files ? cockpit.digitalTwin.files : "n/a"],
      ["repairs", cockpit.predictiveRepair && cockpit.predictiveRepair.queue ? cockpit.predictiveRepair.queue.length : 0],
      ["timelines", cockpit.timelines && cockpit.timelines.timelines ? cockpit.timelines.timelines.length : 0],
      ["runtime", cockpit.runtimeRuns ? cockpit.runtimeRuns.length : 0],
      ["rules", cockpit.engineeringMemory && cockpit.engineeringMemory.memory ? cockpit.engineeringMemory.memory.rules.length : 0],
      ["causal", cockpit.causalIntelligence && cockpit.causalIntelligence.insights ? cockpit.causalIntelligence.insights : 0],
      ["lab", cockpit.discoveryLab && cockpit.discoveryLab.discoveries ? cockpit.discoveryLab.discoveries.length : 0],
      ["forks", cockpit.realityFork && cockpit.realityFork.proposals ? cockpit.realityFork.proposals : 0],
      ["ghost", cockpit.ghostEngineer && cockpit.ghostEngineer.confidence ? Math.round(cockpit.ghostEngineer.confidence * 100) + "%" : "n/a"]
    ];
    document.getElementById("cockpit-metrics").innerHTML = metrics.map(([label, value]) => \`<div class="metric"><div class="label">\${label}</div><div class="value">\${value}</div></div>\`).join("");

    const svg = d3.select("#canvas")
      .attr("width", width)
      .attr("height", height)
      .call(d3.zoom().on("zoom", (event) => {
        container.attr("transform", event.transform);
      }));

    const container = svg.append("g");

    const simulation = d3.forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.links).id(d => d.id).distance(50))
      .force("charge", d3.forceManyBody().strength(-150))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(30));

    const link = container.append("g")
      .selectAll("line")
      .data(data.links)
      .enter().append("line")
      .attr("class", "link");

    const node = container.append("g")
      .selectAll(".node")
      .data(data.nodes)
      .enter().append("g")
      .attr("class", "node")
      .call(d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended))
      .on("click", (e, d) => {
        document.getElementById("file-name").innerText = d.name;
        document.getElementById("file-meta").innerText = "PATH: " + d.id + "\\n\\nInitializing deep inspection...";
      });

    node.append("circle")
      .attr("r", d => d.val)
      .attr("fill", d => d.group === 1 ? "var(--node-src)" : "var(--node-other)");

    node.append("text")
      .attr("dx", 12)
      .attr("dy", ".35em")
      .text(d => d.name);

    simulation.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
    });

    function dragstarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    }
    function dragged(event, d) {
      d.fx = event.x; d.fy = event.y;
    }
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    }

    // WebSocket Neural Feed
    const ws = new WebSocket("ws://" + location.host);
    const logStream = document.getElementById("log-stream");

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      
      // Update Log
      const entry = document.createElement("div");
      entry.className = "log-entry";
      const time = new Date().toLocaleTimeString();
      entry.innerHTML = \`<span class="time">\${time}</span><span class="tag">\${msg.type.toUpperCase()}</span> \${msg.path || msg.msg}\`;
      logStream.prepend(entry);
      if (logStream.childNodes.length > 50) logStream.lastChild.remove();

      // Pulse the node
      if (msg.path) {
        const targetNode = node.filter(d => d.id === msg.path || d.id.endsWith(msg.path));
        targetNode.select("circle")
          .attr("fill", "#fff")
          .attr("r", 20)
          .transition().duration(2000)
          .attr("fill", d => d.group === 1 ? "var(--node-src)" : "var(--node-other)")
          .attr("r", d => d.val);
        
        targetNode.classed("pulse", true);
        setTimeout(() => targetNode.classed("pulse", false), 3000);
      }
    };
  <\/script>
</body>
</html>`;

      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });

      const crypto = await import("node:crypto");
      server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        const digest = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + digest + '\\r\\n\\r\\n');
        this.dashboardSocket = socket;
      });

      // Listen on random port
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port;
        spinner.succeed(pc.green(`Mesh Pulse active at http://127.0.0.1:${port}`));
        
        const { exec } = require("node:child_process");
        const openCmd = process.platform === "darwin" ? `open http://127.0.0.1:${port}` :
                        process.platform === "win32" ? `start http://127.0.0.1:${port}` :
                        `xdg-open http://127.0.0.1:${port}`;
        exec(openCmd);
        
        // CRITICAL: Unref the server so it doesn't block the Node event loop's exit
        // and allow the AgentLoop to continue immediately.
        server.unref();
      });

    } catch (e) {
      spinner.fail(pc.red(`Interface initialization failed: ${(e as Error).message}`));
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

      // Handle Tab or Right arrow to complete the ghost text
      if (key.name === "tab" || (key.name === "right" && lastGhostText)) {
        if (lastGhostText) {
          // Clear ghost text
          output.write(" ".repeat(lastGhostText.length) + "\u001b[" + lastGhostText.length + "D");
          rl.write(lastGhostText);
          lastGhostText = "";
          return;
        }
      }

      if (key.name === "return" || key.name === "enter") {
        if (lastGhostText) {
          output.write(" ".repeat(lastGhostText.length) + "\u001b[" + lastGhostText.length + "D");
          lastGhostText = "";
        }
      }
      
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

  private renderAssistantTurn(text: string, options?: { plainText?: boolean }): void {
    if (options?.plainText) {
      if (this.useAnsi) {
        output.write("\n" + this.themeColor(pc.bold("assistant")) + pc.dim(" › ") + "\n" + text + "\n");
        return;
      }
      output.write(`\nassistant> ${text}\n`);
      return;
    }
    const rendered = marked.parse(text);
    if (this.useAnsi) {
      output.write("\n" + this.themeColor(pc.bold("assistant")) + pc.dim(" › ") + "\n" + rendered + "\n");
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
      { name: "/distill", usage: "/distill", description: "analyze workspace and update the project brain context" },
      { name: "/synthesize", usage: "/synthesize", description: "auto-generate structural changes based on background heuristics" },
      { name: "/twin", usage: "/twin [build|read|status]", description: "build or inspect the Codebase Digital Twin" },
      { name: "/repair", usage: "/repair [analyze|status|clear]", description: "inspect the Predictive Repair Daemon queue" },
      { name: "/learn", usage: "/learn [read|learn]", description: "read or refresh Engineering Memory" },
      { name: "/intent", usage: "/intent <product intent>", description: "compile intent into an implementation contract" },
      { name: "/causal", usage: "/causal [build|read|status|query <question>]", description: "build or query Causal Software Intelligence" },
      { name: "/lab", usage: "/lab [run|status|clear]", description: "run the Autonomous Discovery Lab" },
      { name: "/fork", usage: "/fork [plan|fork|status|clear] <intent>", description: "plan or materialize alternate implementation realities" },
      { name: "/ghost", usage: "/ghost [learn|profile|predict|divergence|patch] <input>", description: "learn and replay the local engineer's implementation style" },
      { name: "/fix", usage: "/fix", description: "apply a background-resolved fix for a current linter/compiler error" },
      { name: "/hologram", usage: "/hologram start <cmd>", description: "run command with V8 telemetry injection for live memory debugging" },
      { name: "/entangle", usage: "/entangle <path>", description: "quantum-link a second repository to sync AST mutations in real-time" },
      { name: "/inspect", usage: "/inspect [url]", description: "attach visual agent portal for real-time canvas editing" },
      { name: "/stop-inspect", usage: "/stop-inspect", description: "detach visual agent portal" },
      { name: "/preview", usage: "/preview <url> [widthxheight] [protocol=auto|kitty|iterm2|sixel|none]", description: "show real frontend screenshot in terminal via Chrome CDP" },

      { name: "/dashboard", usage: "/dashboard", description: "launch local interactive 3D codebase visualizer" },
      { name: "/sync", usage: "/sync", description: "check cloud (L2) cache synchronization" },
      { name: "/setup", usage: "/setup [noninteractive key=value ...]", description: "interactive or scripted settings" },
      { name: "/model", usage: "/model [pick|list|id|save]", description: "interactive chooser or switch model" },
      { name: "/cost", usage: "/cost", description: "show token usage and estimated cost" },
      { name: "/approvals", usage: "/approvals [status|on|off]", description: "control tool auto-approval mode" },
      { name: "/undo", usage: "/undo", description: "revert the last file change made by the agent" },
      { name: "/steps", usage: "/steps [<n>|reset]", description: "set max tool steps for this session" },

      { name: "/doctor", usage: "/doctor [brief|full|voice [fix]]", description: "show runtime diagnostics" },
      { name: "/compact", usage: "/compact", description: "compress transcript into session capsule" },
      { name: "/clear", usage: "/clear", description: "clear terminal UI" },
      { name: "/voice", usage: "/voice [on|off|setup]", description: "toggle or configure Speech-to-Speech mode" },
      { name: "/exit", aliases: ["/quit"], usage: "/exit", description: "quit" }
    ];
  }

  private async handleSlashCommand(
    rawInput: string,
    rl: readline.Interface
  ): Promise<{ wasHandled: boolean; shouldExit: boolean }> {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith("/")) {
      return { wasHandled: false, shouldExit: false };
    }

    const [rawCmd, ...args] = trimmed.split(/\s+/g);
    const inputCmd = rawCmd.toLowerCase();

    const commandList = [
      "/help", "/status", "/index", "/dashboard", "/sync", "/setup", "/clear",
      "/model", "/cost", "/compact", "/capsule", "/memory", "/approvals", "/steps", "/undo",
      "/doctor", "/exit", "/quit", "/reset", "/debug", "/commands", "/voice", "/distill", "/synthesize", "/twin", "/repair", "/learn", "/intent", "/causal", "/lab", "/fork", "/ghost", "/hologram", "/entangle", "/inspect", "/preview", "/fix"
    ];
    // Priority 1: Exact match
    let command = inputCmd;
    if (commandList.includes(inputCmd)) {
      command = inputCmd;
    } else {
      // Priority 2: Prefix match (use the order from commandList which is prioritized)
      const matches = commandList.filter(c => c.startsWith(inputCmd));
      if (matches.length > 0) {
        command = matches[0];
      }
    }

    switch (command) {
      case "/undo": {
        const spinner = ora({ text: "Undoing last change...", color: "yellow" }).start();
        try {
          const result = await this.backend.callTool("workspace.undo", {}) as any;
          if (result.ok) {
            spinner.succeed(pc.green(result.message));
          } else {
            spinner.fail(pc.red(result.error));
          }
        } catch (e) {
          spinner.fail(pc.red(`Undo failed: ${(e as Error).message}`));
        }
        return { wasHandled: true, shouldExit: false };
      }
      case "/inspect": {
        const url = args[0] || "http://localhost:3000";
        await this.handleInspect(url);
        return { wasHandled: true, shouldExit: false };
      }
      case "/stop-inspect": {
        await this.portal.stop();
        output.write(pc.green("\n[Mesh Portal] Browser detached and overlay removed.\n"));
        return { wasHandled: true, shouldExit: false };
      }
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
      case "/distill":
        await this.distillProjectBrain();
        return { wasHandled: true, shouldExit: false };
      case "/synthesize":
        await this.runSynthesize();
        return { wasHandled: true, shouldExit: false };
      case "/twin":
        await this.runDigitalTwin(args);
        return { wasHandled: true, shouldExit: false };
      case "/repair":
        await this.runPredictiveRepair(args);
        return { wasHandled: true, shouldExit: false };
      case "/learn":
        await this.runEngineeringMemory(args);
        return { wasHandled: true, shouldExit: false };
      case "/intent":
        await this.runIntentCompile(args);
        return { wasHandled: true, shouldExit: false };
      case "/causal":
        await this.runCausalIntelligence(args);
        return { wasHandled: true, shouldExit: false };
      case "/lab":
        await this.runDiscoveryLab(args);
        return { wasHandled: true, shouldExit: false };
      case "/fork":
        await this.runRealityFork(args);
        return { wasHandled: true, shouldExit: false };
      case "/ghost":
        await this.runGhostEngineer(args);
        return { wasHandled: true, shouldExit: false };
      case "/fix":
        await this.runFix();
        return { wasHandled: true, shouldExit: false };
      case "/hologram":
        await this.runHologram(args);
        return { wasHandled: true, shouldExit: false };
      case "/entangle":
        await this.runEntangle(args);
        return { wasHandled: true, shouldExit: false };
      case "/inspect":
        await this.runInspect(args);
        return { wasHandled: true, shouldExit: false };
      case "/preview":
        await this.runFrontendPreview(args);
        return { wasHandled: true, shouldExit: false };
      case "/dashboard":
        await this.launchDashboard();
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
      case "/steps":
        this.handleStepsCommand(args);
        return { wasHandled: true, shouldExit: false };
      case "/doctor":
        await this.runDoctor(args);
        return { wasHandled: true, shouldExit: false };
      case "/exit":
      case "exit":
      case "/quit":
        return { wasHandled: true, shouldExit: true };
      case "/reset":
        this.transcript = [];
        output.write(pc.green("\nTranscript reset.\n"));
        return { wasHandled: true, shouldExit: false };
      case "/voice":
        const subVoice = args[0]?.toLowerCase();
        if (subVoice === "setup") {
          const current = await loadUserSettings();
          const nextVoice = await this.runVoiceSetupWizard(rl, current.voice);
          if (!nextVoice) {
            output.write(pc.dim("\nVoice setup cancelled.\n"));
            return { wasHandled: true, shouldExit: false };
          }
          const nextSettings = { ...current, voice: nextVoice };
          await saveUserSettings(nextSettings);
          this.applyVoiceSettings(nextVoice);
          output.write(
            [
              "",
              pc.green("Voice settings saved."),
              `${pc.dim("language:")} ${nextVoice.language}`,
              `${pc.dim("stt:")}      ${nextVoice.transcriptionModel}`,
              `${pc.dim("mic:")}      ${nextVoice.microphone}`,
              `${pc.dim("speed:")}    ${nextVoice.speed}`,
              `${pc.dim("voice:")}    ${nextVoice.voice}`,
              ""
            ].join("\n")
          );
          return { wasHandled: true, shouldExit: false };
        }

        if (subVoice === "on") this.voiceMode = true;
        else if (subVoice === "off") this.voiceMode = false;
        else this.voiceMode = !this.voiceMode;

        if (this.voiceMode) {
          this.syncVoiceLanguage();
          if (!this.config.agent.voice.configured) {
            const current = await loadUserSettings();
            const nextVoice = await this.runVoiceSetupWizard(rl, current.voice);
            if (!nextVoice) {
              this.voiceMode = false;
              output.write(pc.dim("\nVoice setup cancelled.\n"));
              return { wasHandled: true, shouldExit: false };
            }
            const nextSettings = { ...current, voice: nextVoice };
            await saveUserSettings(nextSettings);
            this.applyVoiceSettings(nextVoice);
          }

          const voiceDeps = await this.voiceManager.checkDependencies();
          const missingCore = voiceDeps.filter((dep) => !dep.ok && (dep.name === "ffmpeg" || dep.name === "whisper-cpp"));
          if (missingCore.length > 0) {
            output.write(pc.yellow("\nVoice dependencies missing.\n"));
            await this.ensureVoiceCoreDependencies(voiceDeps);
            const refreshedDeps = await this.voiceManager.checkDependencies();
            const stillMissing = refreshedDeps.filter((dep) => !dep.ok && (dep.name === "ffmpeg" || dep.name === "whisper-cpp"));
            if (stillMissing.length > 0) {
              this.voiceMode = false;
              output.write(pc.red("Voice mode remains OFF until ffmpeg and whisper-cpp are installed.\n"));
            }
          }

          if (this.voiceMode && !this.voiceManager.hasWhisperModel()) {
            await this.ensureWhisperModel();
            if (!this.voiceManager.hasWhisperModel()) {
              this.voiceMode = false;
              output.write(pc.red("Voice mode remains OFF until a Whisper model is available.\n"));
            }
          }
        }

        output.write(`\nVoice mode: ${this.voiceMode ? pc.green("ON") : pc.red("OFF")}\n`);
        if (this.voiceMode) {
          output.write(`${pc.dim(this.getVoiceExitHint())}\n`);
        }
        return { wasHandled: true, shouldExit: false };
      default:
        output.write(`\nUnknown command: ${inputCmd} (resolved to ${command}). Use /help.\n`);
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
      // If we have matches, return them. If multiple, it might jump, 
      // but ghost text already showed the first one. 
      // To avoid jump, we only return the best match if it's a prefix.
      if (hits.length > 1) {
        return [[hits[0]], cmd];
      }
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
    const doctorChoices = ["brief", "full", "voice", "fix"];
    const setupChoices = ["noninteractive", "model=", "cloud=", "theme=", "key=", "endpoint=", "voice_lang=", "voice_speed=", "voice_voice="];
    const voiceChoices = ["on", "off", "setup"];
    const twinChoices = ["build", "read", "status"];
    const repairChoices = ["analyze", "status", "clear"];
    const learnChoices = ["read", "learn"];
    const causalChoices = ["build", "read", "status", "query"];
    const labChoices = ["run", "status", "clear"];
    const forkChoices = ["plan", "fork", "status", "clear"];
    const ghostChoices = ["learn", "profile", "status", "predict", "divergence", "patch", "clear"];

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
      case "/voice":
        pool = voiceChoices;
        break;
      case "/twin":
        pool = twinChoices;
        break;
      case "/repair":
        pool = repairChoices;
        break;
      case "/learn":
        pool = learnChoices;
        break;
      case "/causal":
        pool = causalChoices;
        break;
      case "/lab":
        pool = labChoices;
        break;
      case "/fork":
        pool = forkChoices;
        break;
      case "/ghost":
        pool = ghostChoices;
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

  private handleStepsCommand(args: string[]): void {
    const arg = (args[0] || "").toLowerCase();
    if (!arg || arg === "status") {
      output.write(`\nMax steps: ${this.dynamicMaxSteps} (default: ${this.config.agent.maxSteps})\n`);
      return;
    }
    if (arg === "reset") {
      this.dynamicMaxSteps = this.config.agent.maxSteps;
      output.write(`\nMax steps reset to ${this.dynamicMaxSteps}.\n`);
      return;
    }
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 1 || n > 100) {
      output.write("\nUsage: /steps <1-100> | reset\n");
      return;
    }
    this.dynamicMaxSteps = n;
    output.write(`\nMax steps set to ${this.dynamicMaxSteps}.\n`);
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
          "Usage: /setup noninteractive model=sonnet4.6 cloud=on theme=cyan key=- endpoint=- voice_lang=auto voice_stt=small voice_mic=default voice_speed=260 voice_voice=auto",
          "Keys: model, cloud, theme, key, endpoint, voice_lang, voice_stt, voice_mic, voice_speed, voice_voice",
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
    if (patch.voice_speed && (!Number.isFinite(Number(patch.voice_speed)) || Number(patch.voice_speed) < 120 || Number(patch.voice_speed) > 420)) {
      output.write(`\nInvalid voice_speed: ${patch.voice_speed}. Use a value between 120 and 420.\n`);
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
            : current.customEndpoint,
      voice: {
        configured:
          current.voice.configured ||
          patch.voice_lang !== undefined ||
          patch.voice_stt !== undefined ||
          patch.voice_mic !== undefined ||
          patch.voice_speed !== undefined ||
          patch.voice_voice !== undefined,
        language: patch.voice_lang ? String(patch.voice_lang) : current.voice.language,
        transcriptionModel: patch.voice_stt ? String(patch.voice_stt) : current.voice.transcriptionModel,
        microphone: patch.voice_mic ? String(patch.voice_mic) : current.voice.microphone,
        speed: patch.voice_speed ? Number(patch.voice_speed) : current.voice.speed,
        voice: patch.voice_voice ? String(patch.voice_voice) : current.voice.voice
      }
    };

    await saveUserSettings(nextSettings);
    this.applyVoiceSettings(nextSettings.voice);
    output.write(
      [
        "",
        `${pc.green("Settings updated.")}`,
        `${pc.dim("model:")} ${shortModelName(nextSettings.modelId)}`,
        `${pc.dim("cloud:")} ${nextSettings.enableCloudCache ? "on" : "off"}`,
        `${pc.dim("theme:")} ${nextSettings.themeColor}`,
        `${pc.dim("voice:")} ${nextSettings.voice.language} / ${nextSettings.voice.transcriptionModel} / ${nextSettings.voice.microphone} / ${nextSettings.voice.speed} / ${nextSettings.voice.voice}`,
        ""
      ].join("\n")
    );
    return { shouldExit: false };
  }

  private async runDoctor(args: string[] = []): Promise<void> {
    const isFull = args.includes("full");
    const isVoice = args.includes("voice");
    const wantsFix = args.includes("fix");

    if (isVoice) {
      let voiceDeps = await this.voiceManager.checkDependencies();
      output.write(this.themeColor(`\n${pc.bold("Voice Diagnostics")}\n`));
      for (const dep of voiceDeps) {
        const icon = dep.ok ? pc.green("✔") : pc.red("✘");
        output.write(`${icon} ${dep.name.padEnd(15)} ${dep.ok ? pc.green("Available") : pc.red("Missing")}\n`);
        if (!dep.ok && dep.hint) {
          output.write(`   ${pc.dim(`Hint: ${dep.hint}`)}\n`);
        }
      }
      output.write(
        `${this.voiceManager.hasWhisperModel() ? pc.green("✔") : pc.red("✘")} ${"whisper model".padEnd(15)} ${
          this.voiceManager.hasWhisperModel() ? pc.green("Available") : pc.red(`Missing (${this.voiceManager.getWhisperModelPath()})`)
        }\n`
      );
      output.write(
        `${pc.yellow("•")} ${"tts voice".padEnd(15)} ${pc.dim("Falls back to macOS say if Piper model is missing")}\n`
      );
      output.write(
        `${pc.yellow("•")} ${"voice config".padEnd(15)} ${pc.dim(`${this.config.agent.voice.language} / ${this.config.agent.voice.transcriptionModel} / ${this.config.agent.voice.microphone} / ${this.config.agent.voice.speed} / ${this.config.agent.voice.voice}`)}\n`
      );

      if (wantsFix) {
        voiceDeps = await this.ensureVoiceCoreDependencies(voiceDeps);
        if (!this.voiceManager.hasWhisperModel()) {
          await this.ensureWhisperModel();
        }
      }
      return;
    }

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

  private async ensureVoiceCoreDependencies(
    existingDeps?: { name: string; ok: boolean; hint?: string }[]
  ): Promise<{ name: string; ok: boolean; hint?: string }[]> {
    const voiceDeps = existingDeps ?? await this.voiceManager.checkDependencies();
    const missingCore = voiceDeps
      .filter((dep) => !dep.ok && (dep.name === "ffmpeg" || dep.name === "whisper-cpp"))
      .map((dep) => dep.name);

    if (missingCore.length === 0) {
      output.write(pc.green("\nCore voice dependencies are already installed.\n"));
      return voiceDeps;
    }

    if (!this.voiceManager.hasHomebrew()) {
      output.write(pc.red("\nHomebrew is not installed. Install it from https://brew.sh and rerun /doctor voice fix.\n"));
      return voiceDeps;
    }

    const confirmPrompt = new Confirm({
      name: "installVoiceDeps",
      message: `Install missing voice dependencies with Homebrew? (${missingCore.join(", ")})`,
      initial: true
    });
    const confirmed = Boolean(await confirmPrompt.run().catch(() => false));
    if (!confirmed) {
      output.write(pc.dim("\nInstallation cancelled.\n"));
      return voiceDeps;
    }

    output.write(this.themeColor(`\nInstalling: ${missingCore.join(", ")}\n`));
    try {
      await this.voiceManager.installCoreDependencies(missingCore);
      const updatedDeps = await this.voiceManager.checkDependencies();
      output.write(pc.green("\nVoice dependency installation complete.\n"));
      for (const dep of updatedDeps) {
        const icon = dep.ok ? pc.green("✔") : pc.red("✘");
        output.write(`${icon} ${dep.name.padEnd(15)} ${dep.ok ? pc.green("Available") : pc.red("Missing")}\n`);
      }
      return updatedDeps;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(pc.red(`\nVoice dependency installation failed: ${message}\n`));
      return voiceDeps;
    }
  }

  private async ensureWhisperModel(): Promise<boolean> {
    if (this.voiceManager.hasWhisperModel()) {
      output.write(pc.green("\nWhisper model is already installed.\n"));
      return true;
    }

    const targetPath = this.voiceManager.getWhisperModelPath();
    const modelInfo = this.voiceManager.getWhisperModelInfo();
    const confirmPrompt = new Confirm({
      name: "installWhisperModel",
      message: `Download Whisper ${modelInfo.name} model to ${targetPath}? (${modelInfo.sizeLabel})`,
      initial: true
    });
    const confirmed = Boolean(await confirmPrompt.run().catch(() => false));
    if (!confirmed) {
      output.write(pc.dim("\nWhisper model download cancelled.\n"));
      return false;
    }

    output.write(this.themeColor(`\nDownloading Whisper ${modelInfo.name} model to ${targetPath}\n`));
    try {
      await this.voiceManager.installWhisperModel();
      output.write(pc.green("\nWhisper model download complete.\n"));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(pc.red(`\nWhisper model download failed: ${message}\n`));
      return false;
    }
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

    if (this.gitStatusContext) {
      sections.push(`\n[GIT REPOSITORY STATUS]\nCurrent branch: ${this.gitStatusContext}`);
    }

    // Inject Prefetched Capsules (predicted next files)
    if (this.prefetchQueue.length > 0) {
      sections.push("\n[PREDICTIVE CONTEXT PREFETCH]\nThe following file capsules were pre-loaded because they are highly likely to be relevant to your current task:");
      // Limit to 3 capsules to save tokens
      sections.push(...this.prefetchQueue.slice(0, 3));
      this.prefetchQueue = []; // Clear after injection
    }

    try {
      const brainPath = path.join(this.config.agent.workspaceRoot, ".mesh", "project-brain.md");
      const brain = require("node:fs").readFileSync(brainPath, "utf8");
      if (brain) {
        sections.push(`\n[FRACTAL PROJECT CONTEXT (Project Brain)]\nAdhere to these distilled architectural rules and conventions specific to this project:\n${brain}`);
      }
    } catch {
      // No project brain exists yet
    }

    if (this.voiceMode) {
      sections.push(`\nVoice Instructions:\n${VOICE_SYSTEM_PROMPT}`);
      sections.push(`Voice Language:\n${this.buildVoiceLanguageInstruction()}`);
    }
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
    const tokenThreshold = 60_000;
    if (this.transcript.length < 15 && this.sessionTokens.inputTokens < tokenThreshold) {
      return null;
    }
    return this.compactTranscript({ reason: "auto" });
  }

  private async compactTranscript(options?: { reason?: "manual" | "auto" }): Promise<string> {
    if (this.transcript.length === 0) {
      return "Transcript already empty. No compaction needed.";
    }

    const sourceMessages = this.transcript.length;
    const retainedMessages = Math.min(12, sourceMessages);
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
