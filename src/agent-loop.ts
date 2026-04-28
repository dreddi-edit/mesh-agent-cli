import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import ora from "ora";
import boxen from "boxen";
import pkg from "enquirer";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { MODEL_CATALOG } from "./model-catalog.js";
import { routeMeshTask } from "./model-router.js";

// Initialize marked with terminal renderer
marked.use(markedTerminal() as any);

type EnquirerCtor = new (options: Record<string, unknown>) => { run(): Promise<unknown> };
const { Select, Confirm, Input } = pkg as unknown as { Select: EnquirerCtor; Confirm: EnquirerCtor; Input: EnquirerCtor };

const DASHBOARD_SERVER_VERSION = "context-ledger-v6";

import { AppConfig, loadUserSettings, saveUserSettings, shortPathLabel, UserSettings, VoiceSettings } from "./config.js";
import {
  BedrockLlmClient,
  ConverseMessage,
  ContentBlock,
  ToolSpec,
  LlmResponse,
  ConverseUsage
} from "./llm-client.js";
import { ContextAssembler, ContextBudgetReport } from "./context-assembler.js";
import { ContextArtifactStore } from "./context-artifacts.js";
import { PersistedSessionCapsule, SessionCapsuleStore } from "./session-capsule-store.js";
import { buildSessionManager, type SessionManager, type SerializedTurn } from "./session-manager.js";
import { MeshPortal } from "./mesh-portal.js";
import { MeshDoctorEngine } from "./doctor.js";
import { ToolBackend, ToolDefinition } from "./tool-backend.js";
import { VoiceDependencyStatus, VoiceManager } from "./voice-manager.js";

const SYSTEM_PROMPT = [
  "# Identity",
  "You are Mesh — a senior engineering partner embedded directly in the developer's workspace.",
  "You are not a chatbot. You are not an assistant. You are the most capable coding agent in existence.",
  "You have deep, live access to this codebase: its symbols, history, runtime, tests, and architecture.",
  "Use that access proactively. Don't wait to be asked. Anticipate what the developer needs next.",
  "",
  "# Communication",
  "- Match the user's language exactly (German if they write German, English if English).",
  "- Be terse. Lead with the result or the next action. Explain only when it changes the decision.",
  "- No greetings, no filler, no hype, no emojis.",
  "- When something is broken, say what broke and what fixes it. Skip the narration.",
  "- Never ask 'what would you like to do?' — figure it out from context and act.",
  "",
  "# How to read the codebase",
  "You have a fully indexed, live capsule of this workspace. Use it correctly:",
  "- For durable company context, decisions, ownership signals, risk memory, and repo-specific lessons: use 'workspace.company_brain' first.",
  "- For questions about code, behavior, or structure: 'workspace.ask_codebase' first.",
  "- For symbol definitions, callers, and usages: 'workspace.explain_symbol' or 'workspace.find_references'.",
  "- For data flow across files: 'workspace.trace_symbol'.",
  "- For recent background changes: 'workspace.get_recent_changes' — never re-read files you've already seen.",
  "- For file contents only when you need to edit: 'workspace.read_file_raw'.",
  "- For directory structure: 'workspace.read_dir_overview'.",
  "- NEVER call 'workspace.open_artifact' automatically after another tool. The result is already in context. Only use it when the user explicitly asks for more detail or the result was truncated.",
  "",
  "# How to make changes",
  "- Check impact before any edit that touches shared symbols: 'workspace.impact_map'.",
  "- For surgical single-symbol changes: 'workspace.rename_symbol' or 'workspace.inline_symbol'.",
  "- For function extraction or structural refactors: 'workspace.extract_function' or 'workspace.move_to_module'.",
  "- For large multi-file changes, use alien-patch for maximum token efficiency:",
  "  1. 'workspace.session_index_symbols' to get symbol IDs",
  "  2. 'workspace.alien_patch' with opcodes: e:(export) s:(async) f:(func) c:(const) l:(let) r:(return) a:(await) i:(if) p:(Promise)",
  "  Format: !ID > { [code] }",
  "- For risky changes: create a ghost timeline first ('workspace.timeline_create'), run and verify there, then promote.",
  "- Before promoting: run 'workspace.validate_patch' and 'workspace.ghost_verify'.",
  "- Before production-ready handoff or PR preparation: run 'workspace.production_readiness' with action='gate'. It checks model routing, RAG quality, timelines, runtime learning, visual evidence, memory, and review gates.",
  "",
  "# How to debug",
  "- For a failing test or command: 'runtime.start' → 'runtime.capture_failure' → 'runtime.explain_failure'.",
  "- For deeper root cause: 'runtime.capture_deep_autopsy' or 'workspace.symptom_bisect'.",
  "- For tracing a specific request through the system: 'runtime.trace_request'.",
  "- For reproducing intermittent bugs: 'workspace.schrodingers_ast' or 'workspace.reality_fork'.",
  "- For diagnosing why something broke after a change: 'workspace.causal_autopsy'.",
  "",
  "# How to work on complex tasks",
  "- For issue-to-PR work: use 'workspace.issue_autopilot' to plan, patch in an isolated timeline, verify, review, write a proof bundle, and optionally create the PR.",
  "- For tasks that touch many files or need parallel exploration: spawn sub-agents with 'agent.spawn' or 'agent.spawn_swarm'.",
  "- For competing fix approaches: 'agent.race_fixes' — run both in ghost timelines, compare results, promote the winner.",
  "- For multi-step plans before execution: 'agent.plan' to validate the approach first.",
  "- Always match the user's style using 'workspace.ghost_engineer' memory before writing new code.",
  "",
  "# Proactive behaviors — do these without being asked",
  "- After fixing a bug: check for the same pattern elsewhere with 'workspace.grep_ripgrep' or 'workspace.find_edge_cases'.",
  "- Before a major edit: run 'workspace.predictive_repair' to surface related fragile areas.",
  "- When the user describes a problem: immediately use 'workspace.ask_codebase' or 'workspace.causal_intelligence' to locate the root cause before responding.",
  "- When you see TODOs or known gaps while working: note them or resolve with 'workspace.todo_resolver'.",
  "- When tests are missing for a changed file: proactively offer to generate property tests via 'workspace.generate_properties'.",
  "- For broad production hardening: use 'workspace.model_route' first, then 'workspace.production_readiness' to keep work aligned with the right specialist models and gates.",
  "",
  "# Safety",
  "- Never run destructive shell commands (rm -rf, drop table, git reset --hard, force push) without explicit user confirmation.",
  "- For dangerous operations, always use shadow/timeline execution first: 'workspace.run_in_shadow' or 'workspace.timeline_run'.",
  "- Token budget is finite. Prefer capsule-based reads. Avoid re-reading files already in context.",
].join("\\n");

const VOICE_SYSTEM_PROMPT = [
  "# Voice Mode Active",
  "Respond for spoken conversation, not for markdown reading.",
  "",
  "## Voice Contract",
  "- **Short & Natural**: Use short natural sentences. Reply in plain text only.",
  "- **No Formatting**: Never use emojis, bullet lists, markdown formatting, headings, code fences, or decorative symbols.",
  "- **Conciseness**: Keep answers very short unless the user explicitly asks for more detail.",
  "- **Readability**: Avoid reading punctuation-heavy structures aloud.",
  "- **Code**: If the user asks a coding question, answer briefly first and only give commands or code when truly necessary."
].join("\\n");

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
  /(voice|sprachmodus|stimmmodus)\s*(aus|off|beenden|beendet|stoppen|stoppt)/i,
  /(beende|beendet|beenden|stoppe|stoppen|stopp|verlasse|verlassen)\s*(den\s*)?(voice|sprachmodus|stimmmodus)/i,
  /(stop|exit|quit|disable)\s+(voice)/i,
  /(voice|voice mode|voice chat)\s+(off|stop|exit|quit|disable)/i,
  /stop listening/i,
  /stop recording/i,
  /textmodus\s*(an|zuruck|bitte)/i,
  /zuruck zum text/i
];

interface WireTool {
  wireName: string;
  tool: ToolDefinition;
}

export interface RunHooks {
  onToolStart?: (wireName: string, input: Record<string, unknown>, step: number, maxSteps: number) => void;
  onToolEnd?: (wireName: string, ok: boolean, resultPreview: string) => void;
  askPermission?: (msg: string) => Promise<boolean>;
  onDelta?: (delta: string) => void;
  onCommandChunk?: (chunk: string) => void;
  silent?: boolean;
}

export interface HeadlessTurnResult {
  text: string;
  modelId: string;
  usageDelta: ConverseUsage;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
  };
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

const MODEL_OPTIONS: ModelOption[] = MODEL_CATALOG;
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

function selectWireToolsForTurn(wireTools: WireTool[], inputText: string): WireTool[] {
  const lower = inputText.toLowerCase();
  const selected = new Set<string>();
  const add = (...names: string[]) => {
    for (const name of names) selected.add(name);
  };

  add(
    "workspace.open_artifact",
    "workspace.ask_codebase",
    "workspace.get_diagnostics",
    "workspace.git_status",
    "workspace.list_files",
    "workspace.list_directory",
    "workspace.search_files",
    "workspace.grep_ripgrep",
    "workspace.read_file",
    "workspace.get_file_graph",
    "workspace.read_dir_overview",
    "agent.plan"
  );

  if (/(fix|edit|change|patch|implement|build|add|remove|refactor|commit|test|run|execute|fehler|beheb|änder|aender|bau|mach)/i.test(lower)) {
    add(
      "workspace.write_file",
      "workspace.patch_file",
      "workspace.patch_surgical",
      "workspace.run_command",
      "workspace.read_file_raw",
      "workspace.read_multiple_files",
      "workspace.validate_patch",
      "workspace.git_diff",
      "workspace.impact_map",
      "workspace.company_brain",
      "workspace.explain_symbol",
      "workspace.list_symbols",
      "workspace.finalize_task"
    );
  }

  if (/(dashboard|ui|frontend|browser|screenshot|inspect|visual|react|css|html)/i.test(lower)) {
    add("web.inspect_ui", "frontend.preview", "workspace.trace_symbol", "workspace.expand_execution_path");
  }

  if (/(runtime|crash|exception|stack|trace|debug|hologram|server|request|autopsy)/i.test(lower)) {
    add(
      "workspace.run_with_telemetry",
      "runtime.start",
      "runtime.capture_failure",
      "runtime.capture_deep_autopsy",
      "runtime.trace_request",
      "runtime.explain_failure",
      "runtime.fix_failure"
    );
  }

  if (/(offene probleme|problem|bug|issue|ticket|pr|pull request|risk|risiko|audit|review|diagnos|causal|lab|repair|twin|ghost|fork|intent|memory|brain|cockpit)/i.test(lower)) {
    add(
      "workspace.digital_twin",
      "workspace.predictive_repair",
      "workspace.engineering_memory",
      "workspace.company_brain",
      "workspace.issue_autopilot",
      "workspace.production_readiness",
      "workspace.model_route",
      "workspace.intent_compile",
      "workspace.cockpit_snapshot",
      "workspace.causal_intelligence",
      "workspace.discovery_lab",
      "workspace.reality_fork",
      "workspace.ghost_engineer"
    );
  }

  if (/(timeline|race|future|fork|parallel|promote|merge|swarm|agent)/i.test(lower)) {
    add(
      "workspace.timeline_create",
      "workspace.timeline_apply_patch",
      "workspace.timeline_run",
      "workspace.timeline_compare",
      "workspace.timeline_promote",
      "workspace.timeline_list",
      "agent.race_fixes",
      "agent.spawn",
      "agent.review",
      "agent.merge_verified",
      "agent.status"
    );
  }

  const filtered = wireTools.filter(({ tool }) => selected.has(tool.name));
  return filtered.length > 0 ? filtered : wireTools.slice(0, 16);
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

function formatTokenCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function clampBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 60))}\n[trimmed ${value.length - maxChars} chars]`;
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

function isStreamingEndpointUnavailable(message: string): boolean {
  return /LLM streaming failed/i.test(message) && /(?:->|status\s*)\s*(404|405)\b/i.test(message);
}

export class AgentLoop {
  private ghostTextListener: ((...args: unknown[]) => void) | null = null;
  private readonly llm: BedrockLlmClient;
  private readonly useAnsi = output.isTTY;
  private readonly sessionStore: SessionCapsuleStore;
  private readonly artifactStore: ContextArtifactStore;
  private readonly contextAssembler = new ContextAssembler();
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
  private pendingPrefetchQueue: string[] = [];
  private currentTurnPreferredTools: string[] = [];
  private dashboardEventWrite: Promise<void> = Promise.resolve();
  private dashboardActionTimer: NodeJS.Timeout | null = null;
  private dashboardActionRunning = false;
  private toolEventsExpanded = false;
  private turnToolCalls = 0;
  private turnToolErrors = 0;
  private turnToolNames = new Map<string, number>();
  private turnArtifactCharsStored = 0;
  private turnArtifactEnvelopeChars = 0;
  private sessionRawSaved = 0;
  private turnContextReports: ContextBudgetReport[] = [];
  private lastContextReport: ContextBudgetReport | null = null;
  private currentTurnRouteContext: string | null = null;
  private entangledWorkspaces: string[] = [];
  private gitStatusContext = "";
  private consecutiveErrors = new Map<string, number>();
  private portal: MeshPortal;
  private headlessInitialized = false;
  private streamingUnavailable = false;
  private sessionManager: SessionManager;

  constructor(
    private readonly config: AppConfig,
    private readonly backend: ToolBackend,
    sessionManager?: SessionManager
  ) {
    this.sessionStore = new SessionCapsuleStore(config.agent.workspaceRoot);
    this.artifactStore = new ContextArtifactStore(config.agent.workspaceRoot);
    this.dynamicMaxSteps = config.agent.maxSteps;
    this.portal = new MeshPortal(config.agent.workspaceRoot);
    this.currentModelId = config.bedrock.modelId;
    this.llm = new BedrockLlmClient({
      endpointBase: config.bedrock.endpointBase,
      modelId: this.currentModelId,
      fallbackModelIds: config.bedrock.fallbackModelIds,
      bearerToken: config.bedrock.bearerToken,
      temperature: config.bedrock.temperature,
      maxTokens: config.bedrock.maxTokens
    });
    this.sessionManager = sessionManager ?? buildSessionManager(config.agent.workspaceRoot);

    const colorStr = config.agent.themeColor || "cyan";
    const colorFn = pc[colorStr as keyof typeof pc];
    if (typeof colorFn === "function") {
      this.themeColor = colorFn as (text: string) => string;
    }

    this.voiceManager = this.buildVoiceManager();
    this.syncVoiceLanguage();
    this.startDashboardActionPump();
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

  private normalizeInspectUrl(raw: string): string {
    const value = raw.trim() || "http://localhost:3000";
    return /^https?:\/\//i.test(value) ? value : `http://${value}`;
  }

  private async isUrlReachable(url: string, timeoutMs = 700): Promise<boolean> {
    return await new Promise((resolve) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        resolve(false);
        return;
      }
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname || "/",
          method: "HEAD",
          timeout: timeoutMs
        },
        (res) => {
          res.resume();
          resolve(Boolean(res.statusCode && res.statusCode < 500));
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private async findReachableDevUrl(preferredUrl: string): Promise<string | null> {
    if (await this.isUrlReachable(preferredUrl)) return preferredUrl;
    const parsed = new URL(preferredUrl);
    const host = parsed.hostname === "0.0.0.0" ? "127.0.0.1" : parsed.hostname;
    const ports = uniqueLimited(
      [
        parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
        "5173",
        "5174",
        "3000",
        "3001",
        "4173",
        "8080"
      ],
      8
    );
    for (const port of ports) {
      const candidate = `${parsed.protocol}//${host}:${port}`;
      if (await this.isUrlReachable(candidate, 450)) return candidate;
    }
    return null;
  }

  private async handleInspect(url: string): Promise<void> {
    let targetUrl = this.normalizeInspectUrl(url);
    let detectedUrl = await this.findReachableDevUrl(targetUrl);

    if (!detectedUrl) {
      output.write(pc.yellow(`\n[Mesh Portal] No dev server detected near ${targetUrl}. Starting the workspace dev script...\n`));
      try {
        const pkgPath = path.join(this.config.agent.workspaceRoot, "package.json");
        let pkg: Record<string, any> = {};
        try {
          pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
        } catch {
          // package.json missing or malformed — devScript will be undefined, handled below
        }
        const devScript = (pkg.scripts as Record<string, string> | undefined)?.dev || (pkg.scripts as Record<string, string> | undefined)?.start;

        if (devScript) {
          const { spawn } = await import("node:child_process");
          const serverProc = spawn("npm", ["run", pkg.scripts?.dev ? "dev" : "start"], {
            cwd: this.config.agent.workspaceRoot,
            stdio: "ignore",
            detached: true
          });
          serverProc.unref();
          output.write(pc.green("[Mesh Portal] Dev server launched in background. Probing common local ports...\n"));

          for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 1000));
            detectedUrl = await this.findReachableDevUrl(targetUrl);
            if (detectedUrl) break;
          }
        } else {
          throw new Error("No 'dev' or 'start' script found in package.json");
        }
      } catch (e) {
        output.write(pc.red(`[Mesh Portal] Could not start server: ${(e as Error).message}\n`));
      }
    }

    if (detectedUrl) {
      targetUrl = detectedUrl;
    }

    const spinner = ora({ text: `Connecting visual inspector to ${targetUrl}...`, color: "cyan" }).start();
    try {
      await this.portal.start(targetUrl, async (event) => {
        if (event.name === "meshEmit") {
          await this.handlePortalMutation(event.payload);
        }
      });

      // Inject the overlay script
      const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), "mesh-canvas-overlay.js");
      const scriptContent = await fs.readFile(scriptPath, "utf8");
      await this.portal.evaluate(scriptContent);

      spinner.succeed(pc.green(`Visual inspector active on ${targetUrl}. Alt+Click an element to describe a UI change.`));
    } catch (e) {
      spinner.fail(pc.red(`Visual inspector failed: ${(e as Error).message}`));
      output.write(pc.dim(`Tip: run your app manually, then use /inspect http://localhost:<port> or /preview ${targetUrl}.\n`));
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
                try {
                  const styles = JSON.parse(match[1]);
                  await this.portal.applyGhostStyles(styles);
                } catch {
                  output.write(pc.red("[Mesh] Error: Ghost styles parse failed — skipping live preview update.\n"));
                }
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
    this.llm.logEndpoint();

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
      const localAnswer = await this.tryLocalIntentAnswer(initialPrompt);
      if (localAnswer) {
        await this.renderLocalQuickAnswer(localAnswer);
        return;
      }
      const result = await this.runSingleTurn(initialPrompt);
      output.write(`${result}\n`);
      return;
    }

    this.printBanner();
    await this.printStatus();

    // Resume interrupted session if one exists
    if (this.sessionManager.hasInterruptedSession()) {
      const interrupted = this.sessionManager.getInterruptedSession();
      if (interrupted && interrupted.length > 0) {
        output.write(pc.yellow("\n[Session] Found interrupted session from previous run.\n"));
        const resumeConfirm = new Confirm({
          name: "resume",
          message: "Resume previous session?",
          initial: true,
          stdin: input,
          stdout: output
        });
        const shouldResume = await resumeConfirm.run() as boolean;
        if (shouldResume) {
          for (const turn of interrupted) {
            if (turn.role === "user") {
              this.transcript.push({ role: "user", content: [{ text: turn.content }] });
            } else {
              const content: ContentBlock[] = [{ text: turn.content }];
              if (turn.toolCalls?.length) {
                for (const tc of turn.toolCalls) {
                  content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.input } });
                }
              }
              this.transcript.push({ role: "assistant", content });
            }
          }
          output.write(pc.green(`[Session] Resumed ${interrupted.length} turns.\n`));
        }
        this.sessionManager.clearInterruptedSession();
      }
    }

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

      const localAnswer = await this.tryLocalIntentAnswer(userInput);
      if (localAnswer) {
        rl.close();
        await this.renderLocalQuickAnswer(localAnswer);
        continue;
      }

      await this.refreshGitStatus();

      try {
        const spinner = this.useAnsi ? ora({ text: "Thinking...", color: "cyan", stream: output }).start() : undefined;
        let answer: string | undefined;
        const tokensBefore = { ...this.sessionTokens };
        this.resetToolSummary();
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
            this.renderAssistantTurn(spokenAnswer);
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
            } else if (answer) {
              this.renderAssistantTurn(answer);
            }
          }
        } finally {
          if (spinner) {
            spinner.stop();
            spinner.clear();
          }
        }

        this.printToolSummary();

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

  public async runHeadlessTurn(userInput: string, hooks?: RunHooks): Promise<HeadlessTurnResult> {
    await this.initializeHeadlessSession();
    const trimmed = userInput.trim();
    if (!trimmed) {
      throw new Error("Headless turn requires non-empty input");
    }

    const localAnswer = await this.tryLocalIntentAnswer(trimmed);
    if (localAnswer) {
      return {
        text: localAnswer,
        modelId: this.currentModelId,
        usageDelta: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        totalUsage: { ...this.sessionTokens }
      };
    }

    await this.refreshGitStatus();
    this.resetToolSummary();
    const before = { ...this.sessionTokens };
    const answer = await this.runSingleTurn(trimmed, {
      ...hooks,
      silent: false,
      askPermission: hooks?.askPermission ?? (async () => false)
    });

    return {
      text: answer,
      modelId: this.currentModelId,
      usageDelta: {
        inputTokens: this.sessionTokens.inputTokens - before.inputTokens,
        outputTokens: this.sessionTokens.outputTokens - before.outputTokens,
        totalTokens:
          this.sessionTokens.inputTokens -
          before.inputTokens +
          this.sessionTokens.outputTokens -
          before.outputTokens
      },
      totalUsage: { ...this.sessionTokens }
    };
  }

  private async initializeHeadlessSession(): Promise<void> {
    if (this.headlessInitialized) {
      return;
    }
    await this.checkInit();
    this.sessionCapsule = await this.sessionStore.load();
    try {
      const instrPath = path.join(this.config.agent.workspaceRoot, ".mesh", "instructions.md");
      this.localInstructions = await fs.readFile(instrPath, "utf-8");
    } catch {
      this.localInstructions = "";
    }
    this.headlessInitialized = true;
  }

  private async runSingleTurn(userInput: string, hooks?: RunHooks): Promise<string> {
    const silent = hooks?.silent;
    const autoCompactMessage = await this.autoCompactIfNeeded();
    if (autoCompactMessage && !silent) {
      this.renderSystemMessage(autoCompactMessage);
    }

    if (this.pendingPrefetchQueue.length > 0) {
      this.prefetchQueue.push(...this.pendingPrefetchQueue.splice(0));
    }

    const tools = await this.backend.listTools();
    const allWireTools = toWireTools(tools);
    const preferredWireTools = selectWireToolsForTurn(allWireTools, userInput);
    this.currentTurnPreferredTools = preferredWireTools.map((item) => item.tool.name);
    const toolSpecs = toToolSpecs(allWireTools);
    const wireTools = allWireTools;
    const wireToolMap = new Map(wireTools.map((item) => [item.wireName, item]));

    const preTurnLength = this.transcript.length;
    this.currentTurnRouteContext = await this.buildTurnRouteContext(userInput).catch(() => null);
    this.transcript.push({ role: "user", content: [{ text: userInput }] });
    this.sessionManager.addMessage("user", userInput);

    let lastAssistantText = "";
    this.abortController = new AbortController();
    const maxSteps = this.maxStepsForInput(userInput);
    const toolBudget = this.toolBudgetForInput(userInput);
    const maxTokensOverride = this.maxTokensForInput(userInput);
    let scheduledToolCalls = 0;
    const seenToolSignatures = new Set<string>();
    const toolFamilyCounts = new Map<string, number>();

    const spinner = (this.useAnsi && !silent && !hooks) ? ora({ text: "Thinking...", color: "cyan", stream: output }).start() : undefined;

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        let response: LlmResponse;

        if (hooks?.onDelta && !this.streamingUnavailable) {
          let accumulatedText = "";
          const streamedToolUses: any[] = [];
          try {
            const prepared = this.prepareModelInput(preTurnLength, toolSpecs);
            const stream = this.llm.converseStream(
              prepared.messages,
              prepared.tools,
              prepared.systemPromptArray,
              this.currentModelId,
              this.abortController.signal,
              maxTokensOverride
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
            if (!isStreamingEndpointUnavailable(message)) {
              throw error;
            }
            this.streamingUnavailable = true;

            const prepared = this.prepareModelInput(preTurnLength, toolSpecs);
            response = await this.llm.converse(
              prepared.messages,
              prepared.tools,
              prepared.systemPromptArray,
              this.currentModelId,
              this.abortController.signal,
              maxTokensOverride
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
          const prepared = this.prepareModelInput(preTurnLength, toolSpecs);
          response = await this.llm.converse(
            prepared.messages,
            prepared.tools,
            prepared.systemPromptArray,
            this.currentModelId,
            this.abortController.signal,
            maxTokensOverride
          );

          if (response.usage) {
            this.sessionTokens.inputTokens += response.usage.inputTokens ?? 0;
            this.sessionTokens.outputTokens += response.usage.outputTokens ?? 0;
          }

          if (hooks?.onDelta && response.text) {
            hooks.onDelta(response.text);
          }
        }

        if (response.kind === "text") {
          this.transcript.push({ role: "assistant", content: [{ text: response.text }] });
          this.sessionManager.addMessage("assistant", response.text || "");
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
        this.sessionManager.addMessage(
          "assistant",
          response.text || "",
          response.toolUses.map((tu) => ({ id: tu.toolUseId, name: tu.name, input: tu.input }))
        );

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
        const scheduledToolUses = response.toolUses.map((tu) => {
          const allowed = scheduledToolCalls < toolBudget;
          scheduledToolCalls += 1;
          return { tu, allowed };
        });

        const toolResults = await Promise.all(scheduledToolUses.map(async ({ tu, allowed }) => {
          const sel = wireToolMap.get(tu.name);
          const toolSignature = `${tu.name}:${JSON.stringify(tu.input)}`;
          const family = this.toolFamilyFor(tu.name);

          if (!allowed) {
            return {
              toolUseId: tu.toolUseId,
              status: "error" as const,
              text: "Tool budget reached for this turn. Stop using tools and answer with the evidence already gathered."
            };
          }
          if (seenToolSignatures.has(toolSignature)) {
            return {
              toolUseId: tu.toolUseId,
              status: "error" as const,
              text: "Duplicate tool call blocked by Mesh Stop-Law. Use existing evidence or ask for a narrower artifact slice."
            };
          }
          seenToolSignatures.add(toolSignature);
          const familyCount = toolFamilyCounts.get(family) ?? 0;
          const familyLimit = family === "read" ? 4 : family === "search" ? 3 : 2;
          if (familyCount >= familyLimit && tu.name !== "workspace_open_artifact") {
            return {
              toolUseId: tu.toolUseId,
              status: "error" as const,
              text: `Repeated ${family} tools blocked by Mesh Stop-Law. Stop tool use and answer from gathered evidence.`
            };
          }
          toolFamilyCounts.set(family, familyCount + 1);
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
              const stepLabel = `[${step + 1}/${maxSteps}]`;
              spinner.text = `${pc.dim(stepLabel)} ${pc.cyan(tu.name)} ${pc.dim(formatArgsPreview(tu.input))}`;
            }
            hooks?.onToolStart?.(tu.name, tu.input, step, maxSteps);
          }

          try {
            // 5. Fact Verification Pre-flight (RecallMax)
            if ((sel.tool.name === "workspace.write_file" || sel.tool.name === "workspace.patch_file" || sel.tool.name === "workspace.alien_patch") && this.transcript.length >= 10) {
              const preflightPrompt = `CRITICAL PRE-FLIGHT CHECK: You are about to modify a file (${tu.input.path || 'unknown'}). Based on the long context history, is there any contradictory fact or limitation that makes this edit unsafe or incorrect? Reply with ONLY 'SAFE' or 'UNSAFE: [reason]'.`;
              try {
                const checkRes = await this.llm.converse([{ role: "user", content: [{ text: preflightPrompt }] }], [], "You are a Fact Verification Module.");
                const checkText = checkRes.kind === "text" ? checkRes.text.trim().toUpperCase() : "";
                if (checkText.startsWith("UNSAFE")) {
                  if (!silent && spinner) {
                     spinner.fail(pc.red(`Fact Verification Blocked Edit: ${checkText}`));
                     // We intentionally throw so the tool fails cleanly
                  }
                  return { toolUseId: tu.toolUseId, status: "error" as const, text: `Fact Verification Pre-flight failed: ${checkText}` };
                }
              } catch (e) { /* Ignore pre-flight timeout/error */ }
            }

            const raw = await this.backend.callTool(sel.tool.name, tu.input, { onProgress: silent ? undefined : hooks?.onCommandChunk });

            // Neural Path Prefetching
            if (sel.tool.name === "workspace.read_file" || sel.tool.name === "workspace.expand_execution_path") {
              const filePath = String(tu.input.path ?? "");
              if (filePath) {
                void (async () => {
                  const graph: any = await this.backend.callTool("workspace.get_file_graph", { path: filePath }).catch(() => null);
                  if (graph?.ok && graph.dependencies) {
                    await Promise.all(
                      graph.dependencies.slice(0, 2).map(async (dep: string) => {
                        const capsule: any = await this.backend.callTool("workspace.read_file", { path: dep, tier: "low" }).catch(() => null);
                        const content = capsule?.capsule ?? capsule?.content;
                        if (content) {
                          this.pendingPrefetchQueue.push(`File: ${dep}\n${content}`);
                        }
                      })
                    );
                    if (this.pendingPrefetchQueue.length > 6) {
                      this.pendingPrefetchQueue = this.pendingPrefetchQueue.slice(-6);
                    }
                  }
                })().catch(() => {});
              }
            }

            const resultText = sel.tool.name === "workspace.open_artifact"
              ? this.clampToolResultText(sel.tool.name, [
                  `Tool called: ${sel.tool.name}`,
                  `Arguments: ${JSON.stringify(tu.input)}`,
                  `Result: ${JSON.stringify(raw)}`
                ].join("\n"))
              : await this.buildToolEnvelopeText(sel.tool.name, tu.input, raw);
            if (!silent) hooks?.onToolEnd?.(tu.name, true, this.normalizeCapsuleLine(resultText, 120));
            // Success: clear errors for this signature
            this.consecutiveErrors.delete(toolSignature);
            return { toolUseId: tu.toolUseId, status: "success" as const, text: resultText };
          } catch (error) {
            const errorMsg = (error as Error).message;
            const errorKey = `${toolSignature} -> ${errorMsg}`;
            const errorCount = (this.consecutiveErrors.get(errorKey) || 0) + 1;
            this.consecutiveErrors.set(errorKey, errorCount);

            const toolName = sel.tool.name;
            let hint = "Try /doctor to diagnose.";
            if (errorMsg.includes("ENOENT") || errorMsg.includes("no such file")) {
              hint = "Check that the file path exists, or run /index to rebuild workspace state.";
            } else if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
              hint = "Check file permissions with your OS.";
            } else if (errorMsg.includes("timed out") || errorMsg.includes("AbortError")) {
              hint = "The operation timed out — try /compact to reduce context.";
            }
            let resultText = `[Mesh] Error: ${toolName} failed — ${errorMsg.slice(0, 200)}. ${hint}`;
            if (errorCount >= 2) {
              resultText += "\n\n[MESH SYSTEM WARNING] This exact error has occurred multiple times. DO NOT retry the same action. Either try a different approach or stop and ask the user for clarification.";
            }

            if (!silent) hooks?.onToolEnd?.(tu.name, false, this.normalizeCapsuleLine(resultText, 120));
            return { toolUseId: tu.toolUseId, status: "error" as const, text: this.clampToolResultText(sel.tool.name, resultText) };
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
      if (spinner) {
        spinner.stop();
        spinner.clear();
      }
      this.abortController = null;
      this.currentTurnRouteContext = null;
      this.currentTurnPreferredTools = [];
    }

    return await this.forceFinalAnswer(lastAssistantText, preTurnLength, toolSpecs);
  }

  private prepareModelInput(currentTurnStart: number, toolSpecs: ToolSpec[]): {
    messages: ConverseMessage[];
    tools: ToolSpec[];
    systemPromptArray: Array<{ text: string; cache_control?: any }>;
    report: ContextBudgetReport;
  } {
    const systemPrompt = SYSTEM_PROMPT;
    const dynamicRuntimeContext = [
      this.buildDynamicRuntimeContext(),
      this.currentTurnRouteContext
    ].filter(Boolean).join("\n\n");
    const assembled = this.contextAssembler.assemble({
      transcript: this.transcript,
      currentTurnStart,
      tools: toolSpecs,
      systemPrompt,
      sessionSummary: this.sessionCapsule?.summary ?? null,
      runtimeContext: dynamicRuntimeContext
    });
    this.lastContextReport = assembled.report;
    this.turnContextReports.push(assembled.report);
    if (assembled.report.totalTokens > assembled.report.maxInputTokens) {
      throw new Error(
        `Context firewall blocked oversized request (${assembled.report.totalTokens}/${assembled.report.maxInputTokens} estimated tokens). Narrow the request or run /clear.`
      );
    }
    return {
      messages: assembled.messages,
      tools: assembled.tools,
      systemPromptArray: assembled.systemPromptArray,
      report: assembled.report
    };
  }

  private async forceFinalAnswer(lastAssistantText: string, currentTurnStart: number, toolSpecs: ToolSpec[]): Promise<string> {
    const prompt = [
      "Stop using tools now.",
      "Answer the user with the evidence already gathered.",
      "Be concise. If evidence is incomplete, say what is missing in one sentence."
    ].join(" ");
    this.transcript.push({ role: "user", content: [{ text: prompt }] });
    const prepared = this.prepareModelInput(currentTurnStart, toolSpecs);
    const response = await this.llm.converse(
      prepared.messages,
      prepared.tools,
      prepared.systemPromptArray,
      this.currentModelId,
      this.abortController?.signal
    );
    if (response.usage) {
      this.sessionTokens.inputTokens += response.usage.inputTokens ?? 0;
      this.sessionTokens.outputTokens += response.usage.outputTokens ?? 0;
    }
    const text = response.text || lastAssistantText || "Kein belastbarer Befund.";
    this.transcript.push({ role: "assistant", content: [{ text }] });
    return text;
  }

  private maxStepsForInput(inputText: string): number {
    const lower = inputText.toLowerCase();
    if (this.isSimpleLocalCandidate(inputText)) return 1;
    if (/(fix|edit|change|patch|implement|build|add|remove|refactor|commit|test|run|execute|beheb|änder|aender|bau|mach)/i.test(lower)) {
      return Math.min(this.dynamicMaxSteps, 4);
    }
    if (/(runtime|crash|exception|stack|trace|debug|server|request|diagnos)/i.test(lower)) {
      return Math.min(this.dynamicMaxSteps, 3);
    }
    if (/(offene probleme|problem.*code|bug|bugs|issue|issues|diagnos|risiko|risk|audit|review|siehst du|findest du)/i.test(lower)) {
      return Math.min(this.dynamicMaxSteps, 2);
    }
    return Math.min(this.dynamicMaxSteps, 2);
  }

  private toolBudgetForInput(inputText: string): number {
    const lower = inputText.toLowerCase();
    if (this.isSimpleLocalCandidate(inputText)) return 0;
    if (/(fix|edit|change|patch|implement|build|add|remove|refactor|commit|test|run|execute|beheb|änder|aender|bau|mach)/i.test(lower)) {
      return 10;
    }
    if (/(runtime|crash|exception|stack|trace|debug|server|request|diagnos)/i.test(lower)) {
      return 6;
    }
    if (/(offene probleme|problem.*code|bug|bugs|issue|issues|diagnos|risiko|risk|audit|review|siehst du|findest du)/i.test(lower)) {
      return 5;
    }
    return 3;
  }

  private maxTokensForInput(inputText: string): number {
    const lower = inputText.toLowerCase();
    if (/(fix|edit|change|patch|implement|build|add|remove|refactor|write|commit|beheb|änder|aender|bau|mach)/i.test(lower)) {
      return 4096;
    }
    if (/(list|read|grep|search|find|show|status|explain|summarize|zeige|lies|suche|liste)/i.test(lower)) {
      return 800;
    }
    return this.config.bedrock.maxTokens;
  }

  private toolFamilyFor(wireName: string): string {
    const name = wireName.replace(/_/g, ".");
    if (/read|open.artifact|expand/.test(name)) return "read";
    if (/search|grep|ask.codebase|list/.test(name)) return "search";
    if (/diagnostic|repair|causal|lab|twin|ghost|cockpit/.test(name)) return "analysis";
    if (/write|patch|move|delete|run|timeline|agent/.test(name)) return "action";
    return "other";
  }

  private clampToolResultText(toolName: string, text: string): string {
    const limit = /read_file_raw|read_multiple_files|grep|ask_codebase|causal|discovery/i.test(toolName) ? 5000 : 3500;
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars; answer from available evidence or request a narrower read]`;
  }

  private async buildToolEnvelopeText(toolName: string, input: Record<string, unknown>, raw: unknown): Promise<string> {
    const record = await this.artifactStore.saveToolResult(toolName, input, raw);
    const envelopeText = this.artifactStore.buildEnvelopeText(record, raw);
    this.turnArtifactCharsStored += record.originalChars;
    this.turnArtifactEnvelopeChars += envelopeText.length;
    return this.clampToolResultText(toolName, envelopeText);
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

  private isSimpleLocalCandidate(inputText: string): boolean {
    const normalized = inputText.trim().toLowerCase().replace(/[!?.\s]+$/g, "");
    return /^(hi|hello|hey|hallo|servus|moin|guten morgen|guten tag|guten abend|wie gehts|wie geht es dir|alles gut|na wie gehts|how are you|how is it going|bist du da|da|online|ready|bereit|danke|thx|thanks|merci|dankeschoen|dankeschön|ok|okay|alles klar|passt|verstanden|got it|was kannst du|help|hilfe)$/.test(normalized);
  }

  private async tryLocalIntentAnswer(inputText: string): Promise<string | null> {
    const quick = this.getLocalQuickAnswer(inputText);
    if (quick) return quick;

    const normalized = inputText.trim().toLowerCase().replace(/[!?.\s]+$/g, "");
    if (/^(status|repo status|git status|wie ist der status|was ist der status)$/.test(normalized)) {
      const [git, index] = await Promise.allSettled([
        this.backend.callTool("workspace.git_status", {}),
        this.backend.callTool("workspace.get_index_status", {})
      ]);
      const gitValue = git.status === "fulfilled" ? git.value as any : null;
      const indexValue = index.status === "fulfilled" ? index.value as any : null;
      const branch = gitValue?.branch ? `branch ${gitValue.branch}` : "branch unbekannt";
      const dirty = gitValue?.status ? String(gitValue.status).split(/\r?\n/g).filter(Boolean).length : 0;
      const cache = indexValue?.cachedFiles != null && indexValue?.totalFiles != null
        ? `index ${indexValue.cachedFiles}/${indexValue.totalFiles}`
        : "index unbekannt";
      return `${branch}. ${dirty ? `${dirty} offene Dateiänderungen` : "Working tree sauber"}. ${cache}.`;
    }

    if (/^(welcher branch|branch|git branch)$/.test(normalized)) {
      const git = await this.backend.callTool("workspace.git_status", {}).catch(() => null) as any;
      return git?.branch ? `Branch: ${git.branch}.` : "Branch unbekannt.";
    }

    if (/^(token status|tokens|kosten|cost|context status|context)$/.test(normalized)) {
      const report = this.peakContextReport();
      if (!report) return "Noch kein Modell-Call in diesem Turn.";
      return `Letzter Kontext: ca. ${formatTokenCount(report.totalTokens)}/${formatTokenCount(report.maxInputTokens)} Tokens, Tools ${report.toolsOut}/${report.toolsIn}, Messages ${report.messagesOut}/${report.messagesIn}.`;
    }

    return null;
  }

  private async buildTurnRouteContext(inputText: string): Promise<string | null> {
    if (!this.shouldAttachRepoRouteContext(inputText)) return null;
    const mode = this.inferIndexMode(inputText);
    const [indexResult, gitResult] = await Promise.allSettled([
      this.backend.callTool("workspace.ask_codebase", { query: inputText, mode, limit: 5 }),
      this.backend.callTool("workspace.git_status", {})
    ]);
    const lines: string[] = [
      "Purpose: pre-routed local index context. Prefer these refs before more search tools.",
      `Query mode: ${mode}`
    ];
    const route = routeMeshTask(inputText);
    lines.push(
      `Model route: ${route.taskType} confidence=${route.confidence} primary=${route.primaryChatModel}`,
      `Required gates: ${route.requiredGates.join(", ")}`
    );
    if (indexResult.status === "fulfilled") {
      const value = indexResult.value as any;
      const matches = Array.isArray(value?.topMatches) ? value.topMatches : [];
      if (matches.length > 0) {
        lines.push("Likely relevant files:");
        for (const match of matches.slice(0, 5)) {
          lines.push(`- ${match.path} :: ${previewText(String(match.snippet ?? ""), 160)}`);
        }
      }
      if (value?.indexStatus) {
        lines.push(`Index: ${value.indexStatus.cachedFiles}/${value.indexStatus.totalFiles} fresh (${value.indexStatus.percent}%)`);
      }
    }
    if (gitResult.status === "fulfilled") {
      const git = gitResult.value as any;
      if (git?.branch) lines.push(`Git branch: ${git.branch}`);
      if (git?.status) lines.push(`Dirty files: ${String(git.status).split(/\r?\n/g).filter(Boolean).slice(0, 8).join("; ")}`);
    }
    return lines.length > 2 ? lines.join("\n") : null;
  }

  private shouldAttachRepoRouteContext(inputText: string): boolean {
    if (this.isSimpleLocalCandidate(inputText)) return false;
    return /(code|file|datei|src\/|test|bug|fix|edit|patch|implement|build|dashboard|graph|crash|fehler|problem|repo|commit|push|package|json|ts|js|css|html|api|tool|token|context|performance|diagnos|review|audit)/i.test(inputText);
  }

  private inferIndexMode(inputText: string): string {
    if (/(bug|fehler|crash|exception|diagnos|risk|risiko|problem)/i.test(inputText)) return "bug";
    if (/(test|spec|coverage|verify|prüf|pruef)/i.test(inputText)) return "test-impact";
    if (/(edit|patch|change|änder|aender|refactor|implement|mach|fix)/i.test(inputText)) return "edit-impact";
    if (/(route|request|server|runtime|api)/i.test(inputText)) return "runtime-path";
    if (/(commit|history|changed|dirty|recent)/i.test(inputText)) return "recent-change";
    return "architecture";
  }

  private getLocalQuickAnswer(inputText: string): string | null {
    const normalized = inputText.trim().toLowerCase().replace(/[!?.\s]+$/g, "");
    if (/^(hi|hello|hey|hallo|servus|moin|guten morgen|guten tag|guten abend)$/.test(normalized)) {
      return "Bin da.";
    }
    if (/^(wie gehts|wie geht es dir|alles gut|na wie gehts|how are you|how is it going)$/.test(normalized)) {
      return "Läuft.";
    }
    if (/^(bist du da|da|online|ready|bereit)$/.test(normalized)) {
      return "Ja.";
    }
    if (/^(danke|thx|thanks|merci|dankeschoen|dankeschön)$/.test(normalized)) {
      return "Gerne.";
    }
    if (/^(ok|okay|alles klar|passt|verstanden|got it)$/.test(normalized)) {
      return "Ok.";
    }
    if (/^(was kannst du|help|hilfe)$/.test(normalized)) {
      return "Kurz: Code lesen, ändern, testen, Git/Dashboard/Diagnose lokal steuern. Frag direkt nach der Aufgabe.";
    }
    return null;
  }

  private async renderLocalQuickAnswer(answer: string): Promise<void> {
    const spinner = this.useAnsi ? ora({ text: "Thinking...", color: "cyan", stream: output }).start() : null;
    await new Promise((resolve) => setTimeout(resolve, 260 + Math.floor(Math.random() * 180)));
    if (spinner) {
      spinner.stop();
      spinner.clear();
    }
    this.renderAssistantTurn(answer);
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
      "commands: /help for groups, /dashboard for local repo UI, /exit to quit",
      "tip: Ask normal questions directly; slash commands are shortcuts"
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
        `${pc.dim("commands:")} ${pc.magenta("/help")} ${pc.dim("for groups")}  ${pc.magenta("/dashboard")} ${pc.dim("for local repo UI")}  ${pc.magenta("/exit")}`,
        `${pc.dim("tip:")} ${pc.dim("Ask normal questions directly; slash commands are shortcuts")}`
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

    const statsLine = this.buildSessionStatsLine();
    return `\n${top}\n${statsLine}${bottom}`;
  }

  private buildSessionStatsLine(): string {
    const inT = this.sessionTokens.inputTokens;
    const outT = this.sessionTokens.outputTokens;
    if (inT === 0 && outT === 0) return "";
    const model = MODEL_OPTIONS.find((o) => this.currentModelId.includes(o.value) || o.value.includes(this.currentModelId));
    const { inputPer1k, outputPer1k } = model?.pricing ?? { inputPer1k: 0.003, outputPer1k: 0.015 };
    const cost = (inT * inputPer1k / 1000) + (outT * outputPer1k / 1000);
    const report = this.lastContextReport;
    const ctxPart = report ? ` · ctx ${formatTokenCount(report.totalTokens)}/${formatTokenCount(report.maxInputTokens)}` : "";
    const savedPart = this.sessionRawSaved > 0 ? ` · saved ~${formatTokenCount(Math.ceil(this.sessionRawSaved / 4))}` : "";
    return pc.dim(`↑${formatTokenCount(inT)} ↓${formatTokenCount(outT)} · $${cost.toFixed(4)}${ctxPart}${savedPart}\n`);
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
    const event = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      path,
      msg,
      at: new Date().toISOString()
    };
    this.dashboardEventWrite = this.dashboardEventWrite
      .then(() => this.appendDashboardEvent(event))
      .catch(() => undefined);
  }

  private startDashboardActionPump(): void {
    if (this.dashboardActionTimer) return;
    this.dashboardActionTimer = setInterval(() => {
      void this.processDashboardActions();
    }, 900);
    this.dashboardActionTimer.unref();
  }

  private getDashboardActionsPath(): string {
    return path.join(this.getDashboardDir(), "actions.json");
  }

  private async processDashboardActions(): Promise<void> {
    if (this.dashboardActionRunning) return;
    this.dashboardActionRunning = true;
    try {
      const actions = await this.readDashboardActions();
      const pendingIndex = actions.map((action) => action.status).lastIndexOf("pending");
      if (pendingIndex < 0) return;

      const action = { ...actions[pendingIndex], status: "running", startedAt: new Date().toISOString() };
      actions[pendingIndex] = action;
      await this.writeDashboardActions(actions);
      await this.appendDashboardEvent({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "dashboard_action",
        msg: `running ${action.action}`,
        at: new Date().toISOString()
      });

      try {
        const result = await this.executeDashboardAction(String(action.action));
        actions[pendingIndex] = {
          ...action,
          status: "done",
          finishedAt: new Date().toISOString(),
          result
        };
        await this.appendDashboardEvent({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "dashboard_action",
          msg: `done ${action.action}`,
          at: new Date().toISOString()
        });
      } catch (error) {
        actions[pendingIndex] = {
          ...action,
          status: "error",
          finishedAt: new Date().toISOString(),
          error: (error as Error).message
        };
        await this.appendDashboardEvent({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "dashboard_action",
          msg: `failed ${action.action}`,
          at: new Date().toISOString()
        });
      }
      await this.writeDashboardActions(actions.slice(0, 100));
    } finally {
      this.dashboardActionRunning = false;
    }
  }

  private async executeDashboardAction(action: string): Promise<Record<string, unknown>> {
    switch (action) {
      case "repair":
        return await this.backend.callTool("workspace.predictive_repair", { action: "analyze" }) as Record<string, unknown>;
      case "causal":
        return await this.backend.callTool("workspace.causal_intelligence", { action: "build" }) as Record<string, unknown>;
      case "lab":
        return await this.backend.callTool("workspace.discovery_lab", { action: "run" }) as Record<string, unknown>;
      case "twin":
        return await this.backend.callTool("workspace.digital_twin", { action: "build" }) as Record<string, unknown>;
      case "ghost_learn":
        return await this.backend.callTool("workspace.ghost_engineer", { action: "learn" }) as Record<string, unknown>;
      default:
        throw new Error(`Unsupported dashboard action: ${action}`);
    }
  }

  private async readDashboardActions(): Promise<any[]> {
    const raw = await fs.readFile(this.getDashboardActionsPath(), "utf8").catch(() => "");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeDashboardActions(actions: any[]): Promise<void> {
    const actionsPath = this.getDashboardActionsPath();
    await fs.mkdir(path.dirname(actionsPath), { recursive: true });
    await fs.writeFile(actionsPath, JSON.stringify(actions, null, 2), "utf8");
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
    const spinner = ora({ text: "Distilling Session into Project Brain...", color: "magenta" }).start();
    try {
      const transcriptDump = this.transcript.map(t => `${t.role}: ${JSON.stringify(t.content)}`).join('\n').slice(-24000);
      
      const res = await this.llm.converse([
        { 
          role: "user", 
          content: [{ text: `Analyze this recent conversation and extract any clear architectural decisions, learned project rules, or strict user preferences (e.g. "use Vanilla CSS", "always use functional components", "use path aliases"). Ignore normal code edits or bug fixes. Output ONLY a valid JSON array of strings, each string being a concise, imperative rule. If absolutely nothing was decided, output [].\n\n<conversation>\n${transcriptDump}\n</conversation>` }] 
        }
      ], [], "You are a specialized JSON-only extractor.", this.currentModelId);
      
      let newRules: string[] = [];
      try {
        const jsonMatch = (res.text || "").match(/\[.*\]/s);
        newRules = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      } catch {
        throw new Error("Model did not return a valid JSON array.");
      }

      if (Array.isArray(newRules) && newRules.length > 0) {
        for (const rule of newRules) {
           await this.backend.callTool("workspace.engineering_memory", { 
             action: "record", 
             outcome: "positive",
             rule: rule, 
             note: "Distilled automatically from session conversation." 
           });
        }
        spinner.succeed(pc.magenta(`Distilled ${newRules.length} new rules into Engineering Memory.`));
      } else {
        spinner.info(pc.dim("No clear new project-wide rules found to distill in this session."));
      }
    } catch (e) {
      spinner.fail(pc.red(`Distillation failed: ${(e as Error).message}`));
    }
  }

  private async runSynthesize(): Promise<void> {
    const intentPath = path.join(this.config.agent.workspaceRoot, ".mesh", "latest_intent.json");
    try {
      const intentRaw = await fs.readFile(intentPath, "utf8");
      let intent: Record<string, any>;
      try {
        intent = JSON.parse(intentRaw);
      } catch {
        output.write(pc.red("\n[Mesh] Error: Intent file is corrupted. Try /index first to rebuild workspace state.\n"));
        return;
      }

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

  private async runSlashCommandSafe(
    label: string,
    fn: (spinner: ReturnType<typeof ora>) => Promise<void>
  ): Promise<void> {
    const spinner = ora({ text: `${label}...`, color: "cyan" }).start();
    try {
      await fn(spinner);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Classify into user-friendly category (D-01, D-02)
      let userMsg: string;
      let hint: string;
      if (msg.includes("429") || msg.includes("rate_limit") || msg.includes("ThrottlingException")) {
        userMsg = "LLM rate limit hit";
        hint = "Wait a moment, then try again. Run /doctor to check connectivity.";
      } else if (msg.includes("LLM request failed") || msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
        userMsg = "LLM backend unavailable";
        hint = "Run /doctor to diagnose. Check network connectivity.";
      } else if (msg.includes("Context") && msg.includes("firewall")) {
        userMsg = "Context too large for this operation";
        hint = "Run /compact first to reduce context size.";
      } else if (msg.includes("ENOENT") || msg.includes("no such file")) {
        userMsg = "Required file not found";
        hint = "Run /index first to initialize workspace state.";
      } else if (msg.includes("AbortError") || msg.includes("aborted") || msg.includes("timed out")) {
        userMsg = "Operation timed out after 60 seconds";
        hint = "Try /compact to reduce context, then retry.";
      } else {
        userMsg = msg.slice(0, 200);
        hint = "Run /doctor to diagnose or try /reset if the session is corrupted.";
      }
      // Track in consecutiveErrors Map (D-15)
      const cmdKey = `${label} -> ${msg.slice(0, 80)}`;
      const cmdErrorCount = (this.consecutiveErrors.get(cmdKey) || 0) + 1;
      this.consecutiveErrors.set(cmdKey, cmdErrorCount);

      spinner.fail(pc.red(`[Mesh] Error: ${label} failed — ${userMsg}. Try: ${hint}`));
    }
    // Note: ora.fail() and ora.succeed() both stop the spinner — no finally needed
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

  private async runDaemon(args: string[]): Promise<void> {
    const action = (args[0] || "status").toLowerCase();
    const spinner = ora({ text: `Daemon ${action}...`, color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.daemon", { action });
      spinner.succeed(pc.cyan(`Daemon ${action} complete.`));
      output.write([
        "",
        `${pc.dim("ok:")} ${result.ok ? pc.green("yes") : pc.red("no")}`,
        ...(result.message ? [`${pc.dim("message:")} ${result.message}`] : []),
        ...(result.digest ? [`${pc.dim("digest:")} ${result.digest}`] : []),
        ...(result.state ? [`${pc.dim("state:")} ${JSON.stringify(result.state, null, 2)}`] : []),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Daemon command failed: ${(error as Error).message}`));
    }
  }

  private async runIssuePipeline(args: string[]): Promise<void> {
    const action = (args[0] || "scan").toLowerCase();
    const provider = args[1]?.toLowerCase();
    if (["plan", "run", "pr", "create-pr"].includes(action)) {
      await this.runIssueAutopilot(args);
      return;
    }
    const spinner = ora({ text: `Issue pipeline ${action}...`, color: "yellow" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.issue_pipeline", { action, provider });
      spinner.succeed(pc.yellow(`Issue pipeline ${action} complete.`));
      output.write([
        "",
        `${pc.dim("queued:")} ${result.queued ?? 0}`,
        `${pc.dim("processed:")} ${(result.processed ?? []).length}`,
        ...((result.processed ?? []).slice(0, 5).map((item: any) =>
          `${pc.yellow("•")} ${item.provider}:${item.issueId} -> ${item.prTitle}`
        )),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Issue pipeline failed: ${(error as Error).message}`));
    }
  }

  private async runIssueAutopilot(args: string[]): Promise<void> {
    const action = (args[0] || "status").toLowerCase().replace("-", "_");
    const rest = args.slice(1);
    const target = rest.join(" ").trim();
    const payload: Record<string, unknown> = {
      action: action === "create_pr" ? "pr" : action
    };
    if (/^https?:\/\//i.test(rest[0] ?? "")) {
      payload.issueUrl = rest[0];
    } else if (target) {
      payload.title = target;
      payload.body = target;
    }
    const spinner = ora({ text: `Issue Autopilot ${payload.action}...`, color: "yellow" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.issue_autopilot", payload);
      spinner.succeed(pc.yellow(`Issue Autopilot ${result.status ?? result.action} complete.`));
      output.write([
        "",
        `${pc.dim("ok:")} ${result.ok ? pc.green("yes") : pc.red("no")}`,
        ...(result.runId ? [`${pc.dim("run:")} ${result.runId}`] : []),
        ...(result.issue ? [`${pc.dim("issue:")} ${result.issue.provider}:${result.issue.id} ${result.issue.title}`] : []),
        ...(result.plan?.branchName ? [`${pc.dim("branch:")} ${result.plan.branchName}`] : []),
        ...(result.plan?.verificationCommand ? [`${pc.dim("verify:")} ${result.plan.verificationCommand}`] : []),
        ...(result.timeline?.id ? [`${pc.dim("timeline:")} ${result.timeline.id}`] : []),
        ...(result.proof?.verdict ? [`${pc.dim("proof:")} ${result.proof.verdict} ${result.proof.proofId ?? ""}`] : []),
        ...(result.pr?.url ? [`${pc.dim("pr:")} ${result.pr.url}`] : []),
        ...((result.plan?.likelyFiles ?? []).slice(0, 8).map((file: string) => `${pc.yellow("•")} ${file}`)),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Issue Autopilot failed: ${(error as Error).message}`));
    }
  }

  private async runChatops(args: string[]): Promise<void> {
    const action = (args[0] || "investigate").toLowerCase();
    const platform = (args[1] || "slack").toLowerCase();
    const message = args.slice(2).join(" ").trim();
    const spinner = ora({ text: `ChatOps ${action}...`, color: "magenta" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.chatops", {
        action,
        platform,
        channel: "general",
        message
      });
      spinner.succeed(pc.magenta(`ChatOps ${action} complete.`));
      output.write([
        "",
        `${pc.dim("ok:")} ${result.ok ? pc.green("yes") : pc.red("no")}`,
        ...(result.threadId ? [`${pc.dim("thread:")} ${result.threadId}`] : []),
        ...(result.status ? [`${pc.dim("status:")} ${result.status}`] : []),
        ...((result.updates ?? []).slice(0, 4).map((line: string) => `${pc.magenta("•")} ${line}`)),
        ...(result.prDraft ? [`${pc.dim("pr draft:")}\n${result.prDraft}`] : []),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`ChatOps failed: ${(error as Error).message}`));
    }
  }

  private async runProductionStatus(args: string[]): Promise<void> {
    const action = (args[0] || "status").toLowerCase();
    if (["audit", "gate", "review", "readiness"].includes(action)) {
      const intent = args.slice(1).join(" ").trim() || "production readiness";
      const spinner = ora({ text: `Production readiness ${action}...`, color: "red" }).start();
      try {
        const result: any = await this.backend.callTool("workspace.production_readiness", {
          action: action === "readiness" ? "audit" : action,
          intent
        });
        spinner.succeed(pc.red(`Production readiness ${result.status}.`));
        output.write([
          "",
          `${pc.dim("score:")} ${result.score}/100`,
          `${pc.dim("ledger:")} ${result.ledgerPath}`,
          ...((result.dimensions ?? []).map((entry: any) =>
            `${entry.status === "pass" ? pc.green("•") : entry.status === "warn" ? pc.yellow("•") : pc.red("•")} ${entry.title}: ${entry.score}/100`
          )),
          ...((result.blockers ?? []).slice(0, 5).map((entry: string) => `${pc.red("blocker:")} ${entry}`)),
          ""
        ].join("\n"));
      } catch (error) {
        spinner.fail(pc.red(`Production readiness failed: ${(error as Error).message}`));
      }
      return;
    }
    const spinner = ora({ text: `Production ${action}...`, color: "red" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.production_status", { action });
      spinner.succeed(pc.red(`Production ${action} complete.`));
      output.write([
        "",
        `${pc.dim("updated:")} ${result.updatedAt ?? "never"}`,
        `${pc.dim("signals:")} ${result.totalSignals ?? 0}`,
        ...((result.topErrors ?? []).slice(0, 8).map((entry: any) =>
          `${pc.red("•")} ${entry.file} req=${entry.requestVolume} err=${entry.errorRate} p99=${entry.p99Ms}ms impact=$${entry.revenueImpactDaily}/day`
        )),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Production telemetry failed: ${(error as Error).message}`));
    }
  }

  private async runReplayTrace(args: string[]): Promise<void> {
    const traceId = args[0];
    const commitRange = args[1];
    if (!traceId) {
      output.write(pc.yellow("Usage: /replay <traceId|sentryEventId> [commitRange]\n"));
      return;
    }
    const spinner = ora({ text: "Replaying production trace...", color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("runtime.replay_trace", {
        traceId,
        commitRange
      });
      spinner.succeed(pc.cyan("Trace replay complete."));
      output.write([
        "",
        `${pc.dim("trace:")} ${result.traceId}`,
        `${pc.dim("path:")} ${result.reconstructedRequest?.method} ${result.reconstructedRequest?.path}`,
        ...(result.divergence
          ? [`${pc.dim("divergence:")} ${result.divergence.span} ${result.divergence.file ?? ""}:${result.divergence.line ?? ""}`]
          : []),
        ...(result.commitAnalysis
          ? [`${pc.dim("likely introduced by:")} ${result.commitAnalysis.likelyIntroducedBy}`]
          : []),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Trace replay failed: ${(error as Error).message}`));
    }
  }

  private async runSymptomBisect(args: string[]): Promise<void> {
    const symptom = args.join(" ").trim();
    if (!symptom) {
      output.write(pc.yellow("Usage: /bisect <symptom> [verificationCommand]\n"));
      return;
    }
    const spinner = ora({ text: "Running symptom bisect...", color: "yellow" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.symptom_bisect", { symptom });
      spinner.succeed(pc.yellow("Symptom bisect complete."));
      output.write([
        "",
        `${pc.dim("symptom:")} ${result.symptom}`,
        `${pc.dim("verification:")} ${result.verificationCommand ?? "n/a"}`,
        `${pc.dim("culprit:")} ${result.culpritCommit ?? "undetermined"}`,
        ...(result.authorHint ? [`${pc.dim("author:")} ${result.authorHint}`] : []),
        ...(result.message ? [result.message] : []),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Symptom bisect failed: ${(error as Error).message}`));
    }
  }

  private async runWhatIf(args: string[]): Promise<void> {
    const hypothesis = args.join(" ").trim();
    if (!hypothesis) {
      output.write(pc.yellow("Usage: /whatif <hypothesis>\n"));
      return;
    }
    const spinner = ora({ text: "Running what-if analysis...", color: "magenta" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.what_if", { hypothesis });
      spinner.succeed(pc.magenta("What-if report generated."));
      output.write([
        "",
        `${pc.dim("hypothesis:")} ${result.hypothesis}`,
        `${pc.dim("verdict:")} ${result.verdict}`,
        `${pc.dim("timeline:")} ${result.timelineId}`,
        `${pc.dim("changed files:")} ${(result.changedFiles ?? []).length}`,
        `${pc.dim("changed lines:")} ${result.changedLineCount ?? 0}`,
        `${pc.dim("type errors:")} ${result.typeErrorsEstimate ?? 0}`,
        `${pc.dim("tests broken:")} ${result.testsBrokenEstimate ?? 0}`,
        `${pc.dim("bundle delta:")} ${result.bundleSizeDeltaKb ?? 0} KB`,
        `${pc.dim("note:")} ${result.note ?? ""}`,
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`What-if failed: ${(error as Error).message}`));
    }
  }

  private async runAudit(args: string[]): Promise<void> {
    const action = (args[0] || "verify").toLowerCase();
    const spinner = ora({ text: `Audit ${action}...`, color: "yellow" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.audit", { action });
      spinner.succeed(pc.yellow(`Audit ${action} complete.`));
      if (action === "replay") {
        output.write([
          "",
          `${pc.dim("entries:")} ${(result.entries ?? []).length}`,
          ...((result.entries ?? []).slice(0, 5).map((entry: any) => `${pc.yellow("•")} ${entry.ts} ${entry.tool}`)),
          ""
        ].join("\n"));
        return;
      }
      output.write([
        "",
        `${pc.dim("ok:")} ${result.ok ? pc.green("yes") : pc.red("no")}`,
        `${pc.dim("total:")} ${result.total ?? 0}`,
        `${pc.dim("invalid:")} ${result.invalid ?? 0}`,
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Audit command failed: ${(error as Error).message}`));
    }
  }

  private async runMeshBrain(args: string[]): Promise<void> {
    const action = (args[0] || "stats").replace("-", "_");
    const spinner = ora({ text: `Mesh Brain ${action}...`, color: "blue" }).start();
    try {
      if (action === "query") {
        const error = args.slice(1).join(" ").trim();
        if (!error) {
          spinner.stop();
          output.write(pc.yellow("Usage: /brain query <error signature>\n"));
          return;
        }
        const result: any = await this.backend.callTool("workspace.brain", { action, error, limit: 5 });
        spinner.succeed(pc.blue("Mesh Brain query complete."));
        output.write([
          "",
          `${pc.dim("source:")} ${result.source ?? "unknown"}`,
          `${pc.dim("patterns:")} ${(result.patterns ?? []).length}`,
          ...((result.patterns ?? []).slice(0, 5).map((pattern: any) =>
            `${pc.blue("•")} score=${Number(pattern.score ?? 0).toFixed(2)} usage=${pattern.usageCount ?? 0} ${pattern.fixSummary ?? "Pattern match"}`
          )),
          ""
        ].join("\n"));
        return;
      }

      if (action === "opt_out") {
        await this.backend.callTool("workspace.brain", { action });
        spinner.succeed(pc.blue("Mesh Brain contributions disabled."));
        output.write(pc.dim("You can still query global patterns; local contributions are now off.\n"));
        return;
      }

      const result: any = await this.backend.callTool("workspace.brain", { action: "stats" });
      spinner.succeed(pc.blue("Mesh Brain stats loaded."));
      output.write([
        "",
        `${pc.dim("contribute:")} ${result.telemetryContribute ? pc.green("enabled") : pc.red("disabled")}`,
        `${pc.dim("endpoint:")} ${result.endpoint ?? "local-only"}`,
        `${pc.dim("contributions:")} ${result.contributions ?? 0}`,
        `${pc.dim("last contribution:")} ${result.lastContributionAt ?? "never"}`,
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Mesh Brain failed: ${(error as Error).message}`));
    }
  }

  private async runCompanyBrain(args: string[]): Promise<void> {
    const action = (args[0] || "status").toLowerCase().replace("-", "_");
    const rest = args.slice(1).join(" ").trim();
    const payload: Record<string, unknown> = { action };
    if (["query", "ask", "search"].includes(action)) payload.query = rest;
    if (["record", "ingest"].includes(action)) {
      payload.kind = action === "ingest" ? "lesson" : "decision";
      payload.title = rest.slice(0, 160);
      payload.body = rest;
    }
    const spinner = ora({ text: `Company Brain ${action}...`, color: "blue" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.company_brain", payload);
      spinner.succeed(pc.blue(`Company Brain ${result.status ?? result.action} complete.`));
      if (result.citations) {
        output.write([
          "",
          `${pc.dim("query:")} ${result.query}`,
          `${pc.dim("answer:")} ${result.answer}`,
          ...((result.citations ?? []).slice(0, 8).map((item: any) =>
            `${pc.blue("•")} ${item.file ?? item.title} ${item.lineStart ? `L${item.lineStart}` : ""} score=${item.score}`
          )),
          ""
        ].join("\n"));
        return;
      }
      output.write([
        "",
        `${pc.dim("path:")} ${result.path ?? result.summaryPath ?? "n/a"}`,
        ...(result.summaryPath ? [`${pc.dim("summary:")} ${result.summaryPath}`] : []),
        ...(result.files !== undefined ? [`${pc.dim("files:")} ${result.files}`] : []),
        ...(result.documents !== undefined ? [`${pc.dim("documents:")} ${result.documents}`] : []),
        ...(result.rules !== undefined ? [`${pc.dim("rules:")} ${result.rules}`] : []),
        ...(result.decisions !== undefined ? [`${pc.dim("decisions:")} ${result.decisions}`] : []),
        ...((result.domains ?? []).slice(0, 8).map((entry: any) => `${pc.blue("•")} ${entry.name}: ${entry.files} files, ${entry.risks} risks`)),
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Company Brain failed: ${(error as Error).message}`));
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

  private async runTribunal(args: string[]): Promise<void> {
    const problem = args.join(" ").trim();
    if (!problem) {
      output.write(pc.yellow("Usage: /tribunal <problem or engineering decision to adjudicate>\n"));
      return;
    }
    const spinner = ora({ text: "Convening tribunal (3 panelists deliberating in parallel)...", color: "magenta" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.tribunal", { action: "convene", problem });
      if (!result.ok) {
        spinner.fail(pc.red(`Tribunal failed: ${result.reason ?? "unknown error"}`));
        return;
      }
      spinner.succeed(pc.magenta(`Tribunal complete — verdict: ${result.synthesis?.verdict ?? "n/a"}`));
      const s = result.synthesis;
      output.write([
        "",
        `${pc.dim("winner:")}   ${s.winningPanelistId} (score ${s.scores?.[s.winningPanelistId] ?? "?"})`,
        `${pc.dim("verdict:")}  ${s.verdict}`,
        "",
        `${pc.magenta("▶ Dominant Solution:")}`,
        s.dominantSolution,
        "",
        `${pc.dim("rationale:")} ${s.rationale}`,
        ...(s.incorporated?.length > 0 ? [`${pc.dim("incorporated:")} ${s.incorporated.slice(0, 3).join(" | ")}`] : []),
        ...(s.dissent ? [`${pc.dim("dissent:")} ${s.dissent}`] : []),
        `${pc.dim("artifact:")} ${result.decisionArtifactPath}`,
        ""
      ].join("\n"));
    } catch (error) {
      spinner.fail(pc.red(`Tribunal failed: ${(error as Error).message}`));
    }
  }

  private async runSessionResurrection(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase() ?? "resurrect";
    const rest = args.slice(1);

    if (sub === "capture") {
      output.write(pc.cyan(
        "\nTo capture your session state, ask the agent:\n" +
        '  "capture my session state" or use workspace.session_resurrection directly\n' +
        "  The agent will extract your intent, open questions, and next actions.\n\n"
      ));
      output.write(pc.dim("Tip: The agent uses workspace.session_resurrection action=capture with your context.\n\n"));
      return;
    }

    if (sub === "checkpoint") {
      const note = rest.join(" ").trim();
      if (!note) {
        output.write(pc.yellow("Usage: /resurrect checkpoint <note>\n"));
        return;
      }
      const spinner = ora({ text: "Saving checkpoint...", color: "cyan" }).start();
      try {
        const result: any = await this.backend.callTool("workspace.session_resurrection", { action: "checkpoint", note });
        spinner.succeed(pc.cyan(`Checkpoint saved (${result.totalCheckpoints} total)`));
      } catch (error) {
        spinner.fail(pc.red(`Checkpoint failed: ${(error as Error).message}`));
      }
      return;
    }

    if (sub === "status") {
      const spinner = ora({ text: "Reading session state...", color: "cyan" }).start();
      try {
        const result: any = await this.backend.callTool("workspace.session_resurrection", { action: "status" });
        spinner.succeed(pc.cyan("Session resurrection status"));
        if (!result.exists) {
          output.write(pc.dim("\nNo captured session.\n\n"));
        } else {
          output.write([
            "",
            `${pc.dim("session:")}  ${result.sessionId}`,
            `${pc.dim("captured:")} ${result.capturedAt} (${result.age} ago)`,
            `${pc.dim("intent:")}   ${result.intent}`,
            `${pc.dim("questions:")} ${result.openQuestionsCount}  ${pc.dim("next-actions:")} ${result.nextActionsCount}  ${pc.dim("checkpoints:")} ${result.checkpointsCount}`,
            ""
          ].join("\n"));
        }
      } catch (error) {
        spinner.fail(pc.red(`Status failed: ${(error as Error).message}`));
      }
      return;
    }

    if (sub === "clear") {
      const spinner = ora({ text: "Clearing session state...", color: "cyan" }).start();
      try {
        await this.backend.callTool("workspace.session_resurrection", { action: "clear" });
        spinner.succeed(pc.cyan("Session resurrection state cleared."));
      } catch (error) {
        spinner.fail(pc.red(`Clear failed: ${(error as Error).message}`));
      }
      return;
    }

    // Default: resurrect
    const spinner = ora({ text: "Reconstructing session state...", color: "cyan" }).start();
    try {
      const result: any = await this.backend.callTool("workspace.session_resurrection", { action: "resurrect" });
      spinner.succeed(pc.cyan("Session resurrected."));
      if (!result.exists && !result.snapshot) {
        output.write(pc.dim("\nNo previous session to resurrect. Work on something then run /resurrect capture.\n\n"));
      } else {
        output.write("\n" + result.brief + "\n\n");
      }
    } catch (error) {
      spinner.fail(pc.red(`Resurrection failed: ${(error as Error).message}`));
    }
  }

  private async runSemanticSheriff(args: string[]): Promise<void> {
    const actions = new Set(["scan", "verify", "lock", "unlock", "drift", "status", "clear"]);
    const first = args[0]?.toLowerCase() ?? "verify";
    const action = actions.has(first) ? first : "verify";
    const fileArg = (action === "lock" || action === "unlock" || action === "verify") ? args[1]?.trim() : undefined;

    if ((action === "lock" || action === "unlock") && !fileArg) {
      output.write(pc.yellow(`Usage: /sheriff ${action} <file>\n`));
      return;
    }

    const label = action === "scan" ? "Scanning and fingerprinting codebase..."
      : action === "verify" ? "Verifying semantic contracts..."
      : action === "lock" ? `Locking contract for ${fileArg}...`
      : action === "drift" ? "Loading drift report..."
      : `Sheriff ${action}...`;

    const spinner = ora({ text: label, color: "yellow" }).start();
    try {
      const toolArgs: Record<string, unknown> = { action };
      if (fileArg) toolArgs.file = fileArg;

      const result: any = await this.backend.callTool("workspace.semantic_sheriff", toolArgs);
      spinner.succeed(pc.yellow(`Sheriff ${action} complete.`));

      if (action === "scan") {
        output.write([
          "",
          `${pc.dim("scanned:")}  ${result.scanned}  ${pc.dim("updated:")} ${result.updated}  ${pc.dim("total:")} ${result.totalContracts}`,
          `${pc.dim("path:")}     ${result.path}`,
          ""
        ].join("\n"));
        return;
      }

      if (action === "verify" || action === "drift") {
        const alerts: any[] = result.driftAlerts ?? [];
        output.write([
          "",
          `${pc.dim("contracts:")} ${result.contracts}  ${pc.dim("locked:")} ${result.lockedContracts}`,
          `${pc.dim("summary:")}  ${result.summary}`,
          ...alerts.slice(0, 8).map((a: any) => {
            const color = a.severity === "critical" ? pc.red : a.severity === "high" ? pc.yellow : pc.dim;
            const changes = [
              ...(a.changes.removedExports.length > 0 ? [`-exports: ${a.changes.removedExports.join(", ")}`] : []),
              ...(a.changes.addedExports.length > 0 ? [`+exports: ${a.changes.addedExports.join(", ")}`] : []),
              ...(a.changes.purposeShift ? ["purpose shifted"] : []),
              ...(a.changes.behavioralShift ? ["behavioral patterns changed"] : [])
            ].join("; ");
            return color(`  ${a.severity.toUpperCase()} ${a.file} — ${changes}`);
          }),
          ""
        ].join("\n"));
        return;
      }

      if (action === "lock") {
        output.write([
          "",
          `${pc.yellow("⬡")} ${result.file} locked`,
          `${pc.dim("fingerprint:")} ${result.fingerprint}`,
          `${pc.dim("message:")} ${result.message}`,
          ""
        ].join("\n"));
        return;
      }

      output.write(`\n${pc.dim(result.message ?? JSON.stringify(result))}\n\n`);
    } catch (error) {
      spinner.fail(pc.red(`Sheriff ${action} failed: ${(error as Error).message}`));
    }
  }

  private async launchDashboard(): Promise<void> {
    const spinner = ora({ text: "Starting dashboard...", color: "cyan" }).start();
    try {
      const dashboardDir = this.getDashboardDir();
      await fs.mkdir(dashboardDir, { recursive: true });
      await this.appendDashboardEvent({
        id: `${Date.now()}-dashboard-open`,
        type: "dashboard",
        msg: "Dashboard opened",
        at: new Date().toISOString()
      });

      const existing = await this.readDashboardServerInfo();
      let port = existing?.port;
      if (!port || existing?.version !== DASHBOARD_SERVER_VERSION || !await this.isDashboardReachable(port)) {
        port = await this.startDashboardServer(dashboardDir);
      }

      const url = `http://127.0.0.1:${port}`;
      this.openDashboardUrl(url);
      spinner.succeed(pc.green(`Dashboard live at ${url}`));
    } catch (e) {
      spinner.fail(pc.red(`Interface initialization failed: ${(e as Error).message}`));
    }
  }

  private getDashboardDir(): string {
    return path.join(this.config.agent.workspaceRoot, ".mesh", "dashboard");
  }

  private getDashboardEventsPath(): string {
    return path.join(this.getDashboardDir(), "events.json");
  }

  private getDashboardContextMetricsPath(): string {
    return path.join(this.getDashboardDir(), "context-metrics.json");
  }

  private getDashboardServerInfoPath(): string {
    return path.join(this.getDashboardDir(), "server.json");
  }

  private async writeContextMetrics(report: ContextBudgetReport, rawCharsSaved: number): Promise<void> {
    const metricsPath = this.getDashboardContextMetricsPath();
    const payload = {
      updatedAt: new Date().toISOString(),
      report,
      rawCharsStored: this.turnArtifactCharsStored,
      envelopeCharsSent: this.turnArtifactEnvelopeChars,
      rawCharsSaved,
      rawTokensSavedEstimate: Math.ceil(Math.max(0, rawCharsSaved) / 4),
      toolCalls: this.turnToolCalls,
      toolErrors: this.turnToolErrors
    };
    await fs.mkdir(path.dirname(metricsPath), { recursive: true });
    await fs.writeFile(metricsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async appendDashboardEvent(event: Record<string, unknown>): Promise<void> {
    const eventsPath = this.getDashboardEventsPath();
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    const existing = await fs.readFile(eventsPath, "utf8").catch(() => "[]");
    let events: any[] = [];
    try {
      events = JSON.parse(existing);
    } catch {
      events = [];
    }
    events.unshift(event);
    await fs.writeFile(eventsPath, JSON.stringify(events.slice(0, 200), null, 2), "utf8");
  }

  private async readDashboardServerInfo(): Promise<{ port: number; pid?: number; version?: string } | null> {
    const raw = await fs.readFile(this.getDashboardServerInfoPath(), "utf8").catch(() => "");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { port?: number; pid?: number; version?: string };
      return Number.isFinite(parsed.port) ? { port: Number(parsed.port), pid: parsed.pid, version: parsed.version } : null;
    } catch {
      return null;
    }
  }

  private async isDashboardReachable(port: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 700 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async startDashboardServer(dashboardDir: string): Promise<number> {
    const child = spawn(
      process.execPath,
      [path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard-server.js"), this.config.agent.workspaceRoot],
      { detached: true, stdio: "ignore" }
    );
    child.unref();

    const infoPath = this.getDashboardServerInfoPath();
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const info = await this.readDashboardServerInfo();
      if (info?.port && await this.isDashboardReachable(info.port)) {
        return info.port;
      }
    }
    throw new Error(`Dashboard server did not start. Expected info at ${path.join(dashboardDir, "server.json")}`);
  }

  private openDashboardUrl(url: string): void {
    const command = process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] };
    const opener = spawn(command.bin, command.args, { detached: true, stdio: "ignore" });
    opener.unref();
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
      if (key.ctrl && key.name === "o") {
        this.toolEventsExpanded = !this.toolEventsExpanded;
        output.write(pc.dim(`\ntool output: ${this.toolEventsExpanded ? "expanded" : "collapsed"}\n`));
        return;
      }
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

  private renderAssistantTurn(text: string): void {
    const cleaned = this.sanitizeLlmOutput(text);
    const rendered = marked.parse(cleaned) as string;
    if (this.useAnsi) {
      output.write("\n" + this.themeColor(pc.bold("assistant")) + pc.dim(" › ") + "\n" + rendered + "\n");
      return;
    }
    output.write(`\nassistant> ${cleaned}\n`);
  }

  private sanitizeLlmOutput(text: string): string {
    let clean = text
      // Strip <thinking>...</thinking> blocks completely (content included) — D-10
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
      // Strip <thought>...</thought> blocks completely — D-10
      // (system prompt at line 77 explicitly instructs model to emit these)
      .replace(/<thought>[\s\S]*?<\/thought>/g, "")
      // Strip <reflection>...</reflection> and <scratchpad>...</scratchpad> blocks
      .replace(/<reflection>[\s\S]*?<\/reflection>/g, "")
      .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/g, "")
      // Remove XML artifact wrapper TAGS but preserve their text content — D-11
      .replace(/<\/?(artifact|result|answer)[^>]*>/g, "")
      // Remove orphaned open/close thinking-variant tags (incomplete blocks)
      .replace(/<\/?(thinking|thought|reflection|scratchpad)[^>]*>/g, "")
      // Normalize literal \n escape sequences from raw LLM output — D-12
      .replace(/\\n/g, "\n")
      // Collapse excessive blank lines (4+ newlines → 2)
      .replace(/\n{4,}/g, "\n\n")
      .trim();
    // Close unclosed code fences — D-12 (RESEARCH.md Pattern 3)
    // Count ``` fence markers; odd count means one was never closed
    const fenceCount = (clean.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) clean += "\n```";
    // Repair broken table rows: remove lines that are only pipe characters and whitespace
    // (orphaned | lines that appear when a table is cut mid-row) — D-12
    clean = clean.replace(/^\s*\|\s*$/gm, "");
    return clean;
  }

  private renderSystemMessage(text: string): void {
    const prefix = this.useAnsi ? pc.yellow("system>") : "system>";
    output.write(`\n${prefix} ${text}\n`);
  }

  private renderToolEvent(kind: "start" | "success" | "error", wireName: string, detail: string): void {
    this.lastToolEventAt = new Date().toISOString();
    if (kind === "start") {
      this.turnToolCalls += 1;
      this.turnToolNames.set(wireName, (this.turnToolNames.get(wireName) ?? 0) + 1);
    } else if (kind === "error") {
      this.turnToolErrors += 1;
    }
    if (!this.toolEventsExpanded && kind !== "error") {
      return;
    }
    const label =
      kind === "start"
        ? pc.dim("tool>")
        : kind === "success"
          ? pc.green("tool<")
          : pc.red("tool<");
    output.write(`\n${label} ${pc.cyan(wireName)}${detail ? ` ${pc.dim(detail)}` : ""}\n`);
  }

  private resetToolSummary(): void {
    this.turnToolCalls = 0;
    this.turnToolErrors = 0;
    this.turnToolNames.clear();
    this.turnArtifactCharsStored = 0;
    this.turnArtifactEnvelopeChars = 0;
    this.turnContextReports = [];
    this.lastContextReport = null;
  }

  private printToolSummary(): void {
    if (this.turnToolCalls > 0) {
      const names = Array.from(this.turnToolNames.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
        .join(", ");
      const suffix = this.toolEventsExpanded ? "expanded" : "collapsed";
      const errors = this.turnToolErrors > 0 ? ` · ${this.turnToolErrors} errors` : "";
      output.write(pc.dim(`\ntools: ${this.turnToolCalls} calls · ${names}${errors} · ${suffix} (Ctrl+O)`));
    }
    const report = this.peakContextReport();
    if (report) {
      const turnSaved = Math.max(0, this.turnArtifactCharsStored - this.turnArtifactEnvelopeChars);
      this.sessionRawSaved += turnSaved;
      void this.writeContextMetrics(report, turnSaved);
    }
    if (this.turnToolCalls > 0 || report) output.write("\n");
  }

  private peakContextReport(): ContextBudgetReport | null {
    if (this.turnContextReports.length === 0) return this.lastContextReport;
    return [...this.turnContextReports].sort((left, right) => right.totalTokens - left.totalTokens)[0] ?? null;
  }

  private printHelp(args: string[] = []): void {
    const commands = this.getSlashCommands();
    const requested = args[0]?.toLowerCase().replace(/^([^/])/, "/$1");
    if (requested) {
      const command = commands.find((item) => item.name === requested || item.aliases?.includes(requested));
      if (!command) {
        output.write(pc.yellow(`\nNo command named ${requested}. Run /help for the command groups.\n`));
        return;
      }
      const examples = this.commandExamples(command.name);
      output.write(
        [
          "",
          `${pc.magenta(pc.bold(command.name))}${command.aliases?.length ? pc.dim(` (${command.aliases.join(", ")})`) : ""}`,
          `${pc.dim("what:")}  ${command.description}`,
          `${pc.dim("usage:")} ${command.usage}`,
          ...(examples.length ? [`${pc.dim("examples:")}`, ...examples.map((example) => `  ${example}`)] : []),
          ""
        ].join("\n")
      );
      return;
    }

    const groups: Array<{ title: string; names: string[] }> = [
      { title: "Start Here", names: ["/status", "/index", "/doctor", "/dashboard"] },
      { title: "Ask About This Repo", names: ["/company", "/twin", "/repair", "/causal", "/lab", "/learn"] },
      { title: "Build And Change", names: ["/autopilot", "/intent", "/fork", "/ghost", "/fix", "/sheriff"] },
      { title: "UI And Browser", names: ["/inspect", "/stop-inspect", "/preview"] },
      { title: "Session And Settings", names: ["/model", "/capsule", "/compact", "/approvals", "/steps", "/setup", "/cost", "/undo", "/clear", "/exit"] },
      { title: "Integrations And Advanced", names: ["/distill", "/synthesize", "/issues", "/chatops", "/production", "/replay", "/bisect", "/whatif", "/audit", "/brain", "/daemon", "/tribunal", "/resurrect", "/hologram", "/entangle", "/sync", "/voice"] }
    ];
    const byName = new Map(commands.map((command) => [command.name, command]));
    output.write(
      [
        "",
        `${this.themeColor(pc.bold("Mesh Commands"))}`,
        `${pc.dim("Run /help <command> for examples. Most commands are local analysis helpers; normal questions do not need a slash command.")}`,
        "",
        ...groups.flatMap((group) => [
          this.themeColor(pc.bold(group.title)),
          ...group.names
            .map((name) => byName.get(name))
            .filter((command): command is SlashCommand => Boolean(command))
            .map((command) => `${pc.magenta(command.name.padEnd(15, " "))}${command.description}  ${pc.dim(command.usage)}`),
          ""
        ])
      ].join("\n") + "\n"
    );
  }

  private commandExamples(commandName: string): string[] {
    const examples: Record<string, string[]> = {
      "/status": ["/status"],
      "/index": ["/index"],
      "/dashboard": ["/dashboard"],
      "/twin": ["/twin", "/twin status"],
      "/repair": ["/repair", "/repair status", "/repair clear"],
      "/company": ["/company build", "/company query auth flow", "/company record API clients must validate env tokens"],
      "/autopilot": ["/autopilot plan https://github.com/org/repo/issues/123", "/autopilot run fix the failing auth test", "/autopilot pr https://github.com/org/repo/issues/123"],
      "/causal": ["/causal", "/causal query why is auth risky?"],
      "/lab": ["/lab", "/lab status"],
      "/inspect": ["/inspect", "/inspect http://localhost:5173"],
      "/preview": ["/preview http://localhost:5173 1280x800"],
      "/model": ["/model list", "/model sonnet4.6", "/model save"],
      "/capsule": ["/capsule show", "/capsule stats", "/capsule clear"],
      "/ghost": ["/ghost learn", "/ghost predict add billing settings"],
      "/fork": ["/fork plan migrate dashboard to React"],
      "/sheriff": ["/sheriff scan", "/sheriff verify"],
      "/doctor": ["/doctor", "/doctor full", "/doctor voice"]
    };
    return examples[commandName] ?? [this.getSlashCommands().find((command) => command.name === commandName)?.usage ?? commandName];
  }

  private getSlashCommands(): SlashCommand[] {
    return [
      { name: "/help", aliases: ["/commands"], usage: "/help [command]", description: "show practical command groups and examples" },
      { name: "/status", usage: "/status", description: "show runtime, session, and index state" },
      { name: "/capsule", aliases: ["/memory"], usage: "/capsule [show|compact|clear|export [path]|stats|path]", description: "inspect or manage session capsule" },
      { name: "/index", usage: "/index", description: "re-index workspace and generate file capsules" },
      { name: "/distill", usage: "/distill", description: "analyze workspace and update the project brain context" },
      { name: "/synthesize", usage: "/synthesize", description: "auto-generate structural changes based on background heuristics" },
      { name: "/company", aliases: ["/company-brain"], usage: "/company [build|status|query <question>|record <decision>]", description: "build or query the durable Company Codebase Brain" },
      { name: "/twin", usage: "/twin [build|read|status]", description: "build or inspect the Codebase Digital Twin" },
      { name: "/repair", usage: "/repair [analyze|status|clear]", description: "inspect the Predictive Repair Daemon queue" },
      { name: "/daemon", usage: "/daemon [start|status|digest|stop]", description: "control Mesh background daemon mode" },
      { name: "/issues", usage: "/issues [scan|status] [provider]", description: "run issue-to-PR pipeline for GitHub/Linear/Jira tickets" },
      { name: "/autopilot", usage: "/autopilot [status|plan|run|pr] <issueUrl|manual title>", description: "turn an issue into a verified timeline patch, proof bundle, and optional PR" },
      { name: "/chatops", usage: "/chatops [investigate|approve|status] [platform] [message|threadId]", description: "run Slack/Discord co-engineer investigation and approval flow" },
      { name: "/production", usage: "/production [refresh|status|audit|gate|review] [intent]", description: "show telemetry or run the production readiness gate" },
      { name: "/replay", usage: "/replay <traceId|sentryEventId> [commitRange]", description: "replay a production trace and detect divergence/introducing commit" },
      { name: "/bisect", usage: "/bisect <symptom> [verificationCommand]", description: "autonomous symptom bisect over commit history" },
      { name: "/whatif", usage: "/whatif <hypothesis>", description: "run a counterfactual migration analysis in isolated timeline" },
      { name: "/audit", usage: "/audit [verify|replay]", description: "verify or replay enterprise audit trail entries" },
      { name: "/brain", usage: "/brain [stats|query <error>|opt-out]", description: "query Mesh Brain global fix patterns and telemetry contribution status" },
      { name: "/learn", usage: "/learn [read|learn]", description: "read or refresh Engineering Memory" },
      { name: "/intent", usage: "/intent <product intent>", description: "compile intent into an implementation contract" },
      { name: "/causal", usage: "/causal [build|read|status|query <question>]", description: "build or query Causal Software Intelligence" },
      { name: "/lab", usage: "/lab [run|status|clear]", description: "run the Autonomous Discovery Lab" },
      { name: "/fork", usage: "/fork [plan|fork|status|clear] <intent>", description: "plan or materialize alternate implementation realities" },
      { name: "/ghost", usage: "/ghost [learn|profile|predict|divergence|patch] <input>", description: "learn and replay the local engineer's implementation style" },
      { name: "/fix", usage: "/fix", description: "apply a background-resolved fix for a current linter/compiler error" },
      { name: "/hologram", usage: "/hologram start <cmd>", description: "run command with V8 telemetry injection for live memory debugging" },
      { name: "/entangle", usage: "/entangle <path>", description: "quantum-link a second repository to sync AST mutations in real-time" },
      { name: "/inspect", usage: "/inspect [url]", description: "attach visual browser inspector to a local UI" },
      { name: "/stop-inspect", usage: "/stop-inspect", description: "detach visual browser inspector" },
      { name: "/preview", usage: "/preview <url> [widthxheight] [protocol=auto|kitty|iterm2|sixel|none]", description: "show real frontend screenshot in terminal via Chrome CDP" },

      { name: "/dashboard", usage: "/dashboard", description: "open the local repo operations dashboard" },
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
      { name: "/exit", aliases: ["/quit"], usage: "/exit", description: "quit" },
      { name: "/tribunal", usage: "/tribunal <problem>", description: "convene a 3-panelist AI tribunal — Correctness vs Performance vs Resilience — to debate and synthesize the dominant solution" },
      { name: "/resurrect", usage: "/resurrect [capture|checkpoint <note>|status|clear]", description: "capture current session intent/state and resurrect full mental model in future sessions" },
      { name: "/sheriff", usage: "/sheriff [scan|verify|lock <file>|drift|status|clear]", description: "fingerprint module semantics and alert when refactoring silently changes what code means" }
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
      "/doctor", "/exit", "/quit", "/reset", "/debug", "/commands", "/voice", "/distill", "/synthesize", "/company", "/company-brain", "/twin", "/repair", "/daemon", "/issues", "/autopilot", "/chatops", "/production", "/replay", "/bisect", "/whatif", "/audit", "/brain", "/learn", "/intent", "/causal", "/lab", "/fork", "/ghost", "/hologram", "/entangle", "/inspect", "/stop-inspect", "/preview", "/fix",
      "/tribunal", "/resurrect", "/sheriff"
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

    try {
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
        this.printHelp(args);
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
      case "/company":
      case "/company-brain":
        await this.runCompanyBrain(args);
        return { wasHandled: true, shouldExit: false };
      case "/twin":
        await this.runDigitalTwin(args);
        return { wasHandled: true, shouldExit: false };
      case "/repair":
        await this.runPredictiveRepair(args);
        return { wasHandled: true, shouldExit: false };
      case "/daemon":
        await this.runDaemon(args);
        return { wasHandled: true, shouldExit: false };
      case "/issues":
        await this.runIssuePipeline(args);
        return { wasHandled: true, shouldExit: false };
      case "/autopilot":
        await this.runIssueAutopilot(args);
        return { wasHandled: true, shouldExit: false };
      case "/chatops":
        await this.runChatops(args);
        return { wasHandled: true, shouldExit: false };
      case "/production":
        await this.runProductionStatus(args);
        return { wasHandled: true, shouldExit: false };
      case "/replay":
        await this.runReplayTrace(args);
        return { wasHandled: true, shouldExit: false };
      case "/bisect":
        await this.runSymptomBisect(args);
        return { wasHandled: true, shouldExit: false };
      case "/whatif":
        await this.runWhatIf(args);
        return { wasHandled: true, shouldExit: false };
      case "/audit":
        await this.runAudit(args);
        return { wasHandled: true, shouldExit: false };
      case "/brain":
        await this.runMeshBrain(args);
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
      case "/tribunal":
        await this.runTribunal(args);
        return { wasHandled: true, shouldExit: false };
      case "/resurrect":
        await this.runSessionResurrection(args);
        return { wasHandled: true, shouldExit: false };
      case "/sheriff":
        await this.runSemanticSheriff(args);
        return { wasHandled: true, shouldExit: false };
      case "/hologram":
        await this.runHologram(args);
        return { wasHandled: true, shouldExit: false };
      case "/entangle":
        await this.runEntangle(args);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.write(pc.red(`\n[Mesh] Error: Command "${command}" failed — ${msg.slice(0, 200)}. Try /doctor to diagnose.\n`));
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
        const required = dep.required !== false;
        const icon = dep.ok ? pc.green("✔") : required ? pc.red("✘") : pc.yellow("•");
        const status = dep.ok ? pc.green("Available") : required ? pc.red("Missing") : pc.yellow("Optional");
        output.write(`${icon} ${dep.name.padEnd(15)} ${status}\n`);
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
    output.write(this.themeColor(`\n${pc.bold("Mesh System Diagnostics")}\n`));
    const spinner = ora({ text: "Running doctor checks...", color: "cyan" }).start();
    
    try {
      const doctor = new MeshDoctorEngine(this.config);
      const report = await doctor.run();
      spinner.stop();

      for (const check of report.checks) {
        const icon = check.status === "pass" ? pc.green("✔") : check.status === "warn" ? pc.yellow("⚠") : pc.red("✘");
        const titleColor = check.status === "pass" ? pc.white : check.status === "warn" ? pc.yellow : pc.red;
        
        output.write(`${icon} ${pc.bold(titleColor(check.title.padEnd(25)))} ${check.message}\n`);
        if (check.details && check.details.length > 0) {
          for (const detail of check.details) {
            output.write(`   ${pc.dim(detail)}\n`);
          }
        }
        output.write("\n");
      }

      if (report.ok) {
        output.write(pc.green(pc.bold("All systems operational. Mesh is ready for duty.\n")));
      } else {
        output.write(pc.red(pc.bold("Some systems are failing. Check the warnings above to restore full functionality.\n")));
      }

      const indexStatus = await this.backend.callTool("workspace.get_index_status", {}) as any;
      output.write(`\n${pc.dim("Workspace index: ")} ${indexStatus?.percent ?? 0}% (${indexStatus?.indexedFiles ?? 0} files)\n\n`);

    } catch (err) {
      spinner.fail(pc.red(`Doctor failed unexpectedly: ${(err as Error).message}`));
    }
  }

  private async ensureVoiceCoreDependencies(
    existingDeps?: VoiceDependencyStatus[]
  ): Promise<VoiceDependencyStatus[]> {
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

    const spinner = this.useAnsi
      ? ora({
          text: `Installing voice dependencies (${missingCore.join(", ")})...`,
          color: "cyan",
          stream: output
        }).start()
      : undefined;
    if (!spinner) {
      output.write(this.themeColor(`\nInstalling voice dependencies (${missingCore.join(", ")})...\n`));
    }
    try {
      await this.voiceManager.installCoreDependencies(missingCore, { quiet: true });
      const updatedDeps = await this.voiceManager.checkDependencies();
      if (spinner) {
        spinner.succeed(`Voice dependencies installed: ${missingCore.join(", ")}`);
      } else {
        output.write(pc.green("\nVoice dependency installation complete.\n"));
      }
      for (const dep of updatedDeps.filter((dep) => dep.required !== false)) {
        const icon = dep.ok ? pc.green("✔") : pc.red("✘");
        output.write(`${icon} ${dep.name.padEnd(15)} ${dep.ok ? pc.green("Available") : pc.red("Missing")}\n`);
      }
      return updatedDeps;
    } catch (error) {
      if (spinner) {
        spinner.fail("Voice dependency installation failed.");
      }
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
      message: `Download Whisper ${modelInfo.name} model? (${modelInfo.sizeLabel})`,
      initial: true
    });
    const confirmed = Boolean(await confirmPrompt.run().catch(() => false));
    if (!confirmed) {
      output.write(pc.dim("\nWhisper model download cancelled.\n"));
      return false;
    }

    const spinner = this.useAnsi
      ? ora({
          text: `Downloading Whisper ${modelInfo.name} model (${modelInfo.sizeLabel})...`,
          color: "cyan",
          stream: output
        }).start()
      : undefined;
    if (!spinner) {
      output.write(this.themeColor(`\nDownloading Whisper ${modelInfo.name} model (${modelInfo.sizeLabel})...\n`));
    }
    try {
      await this.voiceManager.installWhisperModel();
      if (spinner) {
        spinner.succeed(`Whisper ${modelInfo.name} model downloaded.`);
      } else {
        output.write(pc.green("\nWhisper model download complete.\n"));
      }
      if (targetPath) {
        output.write(`${pc.dim("model:")} ${pc.dim(path.basename(targetPath))}\n`);
      }
      return true;
    } catch (error) {
      if (spinner) {
        spinner.fail("Whisper model download failed.");
      }
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

  private buildDynamicRuntimeContext(): string {
    const sections: string[] = [];

    if (this.currentTurnPreferredTools.length > 0) {
      sections.push(`[TOOL ROUTING]\nFor this turn, prefer these tools when useful: ${this.currentTurnPreferredTools.slice(0, 24).join(", ")}`);
    }

    if (this.gitStatusContext) {
      sections.push(`\n[GIT REPOSITORY STATUS]\nCurrent branch: ${clampBlock(this.gitStatusContext, 1_200)}`);
    }

    // Inject Prefetched Capsules (predicted next files)
    if (this.prefetchQueue.length > 0) {
      sections.push("\n[PREDICTIVE CONTEXT PREFETCH]\nThe following file capsules were pre-loaded because they are highly likely to be relevant to your current task:");
      // Limit to 3 capsules to save tokens
      sections.push(...this.prefetchQueue.slice(0, 2).map((entry) => clampBlock(entry, 1_200)));
      this.prefetchQueue = []; // Clear after injection
    }

    try {
      const brainPath = path.join(this.config.agent.workspaceRoot, ".mesh", "project-brain.md");
      const brain = readFileSync(brainPath, "utf8");
      if (brain) {
        sections.push(`\n[FRACTAL PROJECT CONTEXT (Project Brain)]\nAdhere to these distilled architectural rules and conventions specific to this project:\n${clampBlock(brain, 2_400)}`);
      }
    } catch {
      // No project brain exists yet
    }

    try {
      const companyBrainPath = path.join(this.config.agent.workspaceRoot, ".mesh", "company-brain", "summary.md");
      const companyBrain = readFileSync(companyBrainPath, "utf8");
      if (companyBrain) {
        sections.push(`\n[COMPANY CODEBASE BRAIN]\nUse these durable repo facts, rules, risks, and decisions before proposing changes:\n${clampBlock(companyBrain, 3_200)}`);
      }
    } catch {
      // No company brain exists yet
    }

    try {
      const memoryPath = path.join(this.config.agent.workspaceRoot, ".mesh", "engineering-memory.json");
      const memoryRaw = readFileSync(memoryPath, "utf8");
      const memory = JSON.parse(memoryRaw);
      if (memory && (memory.rules?.length || memory.decisions?.length)) {
        const lines = [
          "Rules:", ...(memory.rules || []).map((r: any) => `- ${r.rule || r}`),
          "Decisions:", ...(memory.decisions || memory.acceptedPatterns || []).map((d: any) => `- ${d.pattern || d}`)
        ].join("\n");
        sections.push(`\n[ENGINEERING MEMORY (Session Distiller)]\nApply these distilled project decisions and rules learned from previous sessions:\n${clampBlock(lines, 2_400)}`);
      }
    } catch {
      // No engineering memory exists yet
    }

    if (this.voiceMode) {
      sections.push(`\nVoice Instructions:\n${VOICE_SYSTEM_PROMPT}`);
      sections.push(`Voice Language:\n${this.buildVoiceLanguageInstruction()}`);
    }
    if (this.localInstructions) {
      sections.push(`\nLocal Project Instructions:\n${clampBlock(this.localInstructions, 2_400)}`);
    }
    if (this.workspaceContext) {
      sections.push(clampBlock(this.workspaceContext, 1_200));
    }
    return sections.join("\n\n");
  }

  private async autoCompactIfNeeded(): Promise<string | null> {
    const transcriptCharThreshold = 220_000;
    if (this.transcript.length < 30 && this.estimateTranscriptChars() < transcriptCharThreshold) {
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
    const summary = await this.buildSessionCapsuleSummary(older, retained);

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

  private async buildSessionCapsuleSummary(older: ConverseMessage[], retained: ConverseMessage[]): Promise<string> {
    const baseSummary = this.buildHeuristicSessionCapsuleSummary(older, retained);

    const prompt = `You are a memory compression module for an autonomous AI agent.
Your task is to refine the following raw heuristic session summary into a highly condensed, intent-preserving "Session Capsule".
CRITICAL RULES:
1. Preserve Tone, User Intent, Key Decisions, and Emotional Register.
2. Maintain the structure: Summary, Decisions, Open Threads, Next Actions, Files Touched.
3. Keep it terse and under 800 words.
4. Output ONLY the refined capsule text. Do not add conversational filler.

Raw Heuristic Summary:
${baseSummary}`;

    try {
      const response = await this.llm.converse([{ role: "user", content: [{ text: prompt }] }], [], "You are a memory compression module.");
      if (response.kind === "text" && response.text.trim()) {
        return response.text;
      }
    } catch (err) {
      // Fallback
    }
    return baseSummary;
  }

  private buildHeuristicSessionCapsuleSummary(older: ConverseMessage[], retained: ConverseMessage[]): string {
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
        20
      ),
      openThreads: uniqueLimited(
        [
          ...(previous?.openThreads ?? []),
          ...userRequests.slice(-5),
          ...toolResults.filter((entry) => /error|failed|denied|omitted|unknown/i.test(entry))
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        20
      ),
      nextActions: uniqueLimited(
        [
          ...(previous?.nextActions ?? []),
          ...assistantReplies.filter((entry) => /next|should|can|recommend|suggest/i.test(entry)),
          retained.length ? `Continue from ${retained.length} preserved recent messages.` : ""
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        15
      ),
      filesTouched: uniqueLimited(
        [
          ...(previous?.filesTouched ?? []),
          ...filesTouched
        ].map((entry) => this.normalizeCapsuleLine(entry, 120)),
        50
      ),
      toolActivity: uniqueLimited(
        [
          ...(previous?.toolActivity ?? []),
          ...toolCalls.slice(-8),
          ...toolResults.slice(-4)
        ].map((entry) => this.normalizeCapsuleLine(entry, 160)),
        20
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

// Export sanitizeLlmOutput as a standalone function for unit testing.
// This allows tests/error-and-sanitization.test.mjs to import it without
// instantiating AgentLoop (which requires heavy config setup).
// The logic is identical to the private method above — keep them in sync.
export function sanitizeLlmOutput(text: string): string {
  let clean = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/<reflection>[\s\S]*?<\/reflection>/g, "")
    .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/g, "")
    .replace(/<\/?(artifact|result|answer)[^>]*>/g, "")
    .replace(/<\/?(thinking|thought|reflection|scratchpad)[^>]*>/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
  // Close unclosed code fences — D-12
  const fenceCount = (clean.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) clean += "\n```";
  // Repair broken table rows — D-12
  clean = clean.replace(/^\s*\|\s*$/gm, "");
  return clean;
}
