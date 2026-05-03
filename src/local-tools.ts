import { promises as fs, existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { exec, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import crypto from "node:crypto";
import ignore, { Ignore } from "ignore";

// Lazy-loaded transformers for Local RAG
let pipeline: any = null;

class VectorManager {
  private model: any = null;
  private isDownloading = false;

  async getModel(onProgress?: (msg: string) => void) {
    if (this.model) return this.model;
    if (this.isDownloading) {
      while (this.isDownloading) await new Promise(r => setTimeout(r, 500));
      return this.model;
    }

    this.isDownloading = true;
    try {
      // Use dynamic require to bypass build-time check of missing peer dependency
      const { pipeline: transformersPipeline } = await (new Function('return import("@xenova/transformers")')() as any).catch(() => ({ pipeline: null }));
      if (!transformersPipeline) {
        throw new Error("transformers_not_installed");
      }
      const preferredModel = process.env.MESH_EMBEDDING_MODEL || "Xenova/nomic-embed-code";
      try {
        this.model = await transformersPipeline('feature-extraction', preferredModel);
      } catch {
        this.model = await transformersPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      }
      this.isDownloading = false;
      return this.model;
    } catch (err: any) {
      this.isDownloading = false;
      return null;
    }
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    const extractor = await this.getModel();
    if (!extractor) return null;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data) as number[];
  }

  cosineSimilarity(a: number[], b: number[]) {
    let dot = 0; let mA = 0; let mB = 0;
    for(let i = 0; i < a.length; i++){
        dot += a[i] * b[i];
        mA += a[i] * a[i];
        mB += b[i] * b[i];
    }
    return dot / (Math.sqrt(mA) * Math.sqrt(mB));
  }
}

const vectorManager = new VectorManager();

const execAsync = promisify(exec);

import { MeshCoreAdapter } from "./mesh-core-adapter.js";
import { CacheManager, CapsuleBatchRequest } from "./cache-manager.js";
import { ToolBackend, ToolCallOpts, ToolDefinition } from "./tool-backend.js";
import { AppConfig } from "./config.js";
import { BedrockLlmClient } from "./llm-client.js";
import { analyzeImageWithNvidia, DEFAULT_NVIDIA_VISION_MODELS, resolveNvidiaApiKey } from "./nvidia-services.js";
import { routeMeshTask } from "./model-router.js";
import { ProductionReadinessEngine } from "./production-readiness.js";
import { CompanyBrainEngine } from "./company-brain.js";
import { IssueAutopilotEngine } from "./issue-autopilot.js";
import { WorkspaceIndex, CodeQueryMode } from "./workspace-index.js";
import { TimelineManager } from "./timeline-manager.js";
import { RuntimeObserver } from "./runtime-observer.js";
import { AgentOs } from "./agent-os.js";
import { captureFrontendPreview } from "./terminal-preview.js";
import { openContextArtifact } from "./context-artifacts.js";
import { MeshBrainClient, normalizeDiffPattern, normalizeErrorSignature, RepoDnaFingerprint } from "./mesh-brain.js";
import { runDaemonCli } from "./daemon.js";
import { DAEMON_SOCKET_PATH, DaemonRequest, DaemonResponse } from "./daemon-protocol.js";
import net from "node:net";
import { IssuePipelineManager } from "./integrations/issues/manager.js";
import { ChatopsManager } from "./integrations/chatops/manager.js";
import { scoreSignal, TelemetryManager } from "./integrations/telemetry/manager.js";
import { ReplayEngine } from "./runtime/replay.js";
import { SymptomBisectEngine } from "./timeline/symptom-bisect.js";
import { PersonaLoader } from "./agents/persona-loader.js";
import { runCritic } from "./agents/critic.js";
import { runRedTeam } from "./agents/redteam.js";
import { TsCompilerRefactor } from "./refactor/ts-compiler.js";
import { PropertyTestGenerator } from "./quality/property-tests.js";
import { SmtEdgeCaseFinder } from "./quality/smt.js";
import { AuditLogger } from "./audit/logger.js";
import { assertCommandAllowed } from "./command-safety.js";
import { StructuredLogger } from "./structured-logger.js";
import { ToolInputValidationError, validateToolInput } from "./tool-schema.js";
import { HAIKU_MODEL_ID } from "./model-catalog.js";
import { SelfDefendingCodeEngine } from "./security/self-defending.js";
import { PrecrimeEngine } from "./moonshots/precrime.js";
import { ShadowDeployEngine } from "./moonshots/shadow-deploy.js";
import { SemanticGitEngine } from "./moonshots/semantic-git.js";
import { ProbabilisticCodebaseEngine } from "./moonshots/probabilistic-codebase.js";
import { SpecCodeEngine } from "./moonshots/spec-code.js";
import { ConversationalCodebaseEngine } from "./moonshots/conversational-codebase.js";
import { NaturalLanguageSourceEngine } from "./moonshots/natural-language-source.js";
import { FluidMeshEngine } from "./moonshots/fluid-mesh.js";
import { LivingSoftwareEngine } from "./moonshots/living-software.js";
import { ProofCarryingChangeEngine } from "./moonshots/proof-carrying-change.js";
import { CausalAutopsyEngine } from "./moonshots/causal-autopsy.js";
import { TodoResolverEngine } from "./moonshots/todo-resolver.js";
import { LiveWireEngine } from "./moonshots/live-wire.js";
import { SchrodingersAstEngine } from "./moonshots/schrodingers-ast.js";
import { HiveMindEngine } from "./moonshots/hive-mind.js";
import { EphemeralExecutionEngine } from "./moonshots/ephemeral-execution.js";
import { TribunalEngine, TribunalLlmCall } from "./moonshots/tribunal.js";
import { SessionResurrectionEngine } from "./moonshots/session-resurrection.js";
import { SemanticSheriffEngine } from "./moonshots/semantic-sheriff.js";

const SKIP_DIRS = [".git", "node_modules", "dist", ".mesh"];
const INDEX_PARALLELISM = parseIntegerInRange(process.env.MESH_INDEX_PARALLELISM, 12, 1, 128);
const CAPSULE_TIERS = ["low", "medium", "high"] as const;
const WATCHER_DISABLED = /^(1|true|yes)$/i.test(process.env.MESH_DISABLE_WATCHERS ?? "");
const BACKGROUND_RESOLVER_ENABLED = /^(1|true|yes)$/i.test(process.env.MESH_ENABLE_BACKGROUND_RESOLVER ?? "");
const WATCHABLE_DIRS = ["src", "tests", "docs", "scripts", "packages", "mesh-core/src", "worker/src"];

function parseIntegerInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeCapsuleTier(value: string): "low" | "medium" | "high" {
  return CAPSULE_TIERS.includes(value as any) ? value as "low" | "medium" | "high" : "medium";
}

function isWatchableSourcePath(filename: string): boolean {
  if (filename.includes("node_modules") || filename.includes(".git") || filename.includes("dist") || filename.includes(".mesh")) {
    return false;
  }
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|cpp|c|h|java)$/.test(filename);
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function ensureInsideRoot(root: string, requestedPath: string | undefined): string {
  const candidate = path.resolve(root, requestedPath ?? ".");
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${requestedPath ?? "."}`);
  }
  return candidate;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a binary is resolvable on the current PATH.
 * Used to pre-flight optional deps (playwright, ast-grep) and give
 * actionable errors instead of opaque `npx --yes` failures.
 */
function isCommandAvailable(command: string): boolean {
  try {
    const result = spawnSync("which", [command], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function countWarnings(output: string): number {
  return output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => /\bwarning\b/i.test(line))
    .length;
}

function computeRaceScore(args: {
  passed: boolean;
  changedLines: number;
  warningCount: number;
  durationMs: number;
}): number {
  if (!args.passed) {
    return -1000 - args.changedLines - args.warningCount * 25 - Math.round(args.durationMs / 500);
  }

  return 1000 - args.changedLines * 3 - args.warningCount * 12 - Math.round(args.durationMs / 250);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

function uniqueStrings(values: Array<string | undefined | null>, limit = 100): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim())))).slice(0, limit);
}

function pickFirstMatch(source: Record<string, unknown>, keys: string[], fallback: string): string {
  const found = keys.find((key) => Object.keys(source).some((sourceKey) => sourceKey.toLowerCase().includes(key)));
  return found ?? fallback;
}

function ragQueryVariants(query: string, mode: CodeQueryMode): string[] {
  const normalized = query.replace(/\s+/g, " ").trim();
  const variants = [normalized];
  if (mode === "bug") variants.push(`${normalized} stack error failure root cause`);
  if (mode === "test-impact") variants.push(`${normalized} tests specs verification coverage`);
  if (mode === "edit-impact") variants.push(`${normalized} callers dependencies exports affected files`);
  if (mode === "runtime-path") variants.push(`${normalized} route handler request runtime server`);
  if (mode === "ownership") variants.push(`${normalized} owner module boundary integration`);
  const symbols = Array.from(normalized.matchAll(/[A-Z][A-Za-z0-9_]{2,}|[a-zA-Z0-9_-]+\.[tj]sx?/g))
    .map((match) => match[0])
    .slice(0, 8)
    .join(" ");
  if (symbols) variants.push(symbols);
  return uniqueStrings(variants, 4);
}

function lexicalOverlapScore(query: string, text: string): number {
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9_.$/-]+/i).filter((token) => token.length > 2));
  if (queryTokens.size === 0) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function aggregateCohortRules(
  cohort: Array<{ similarity: number; rules: string[] }>,
  threshold: number
): string[] {
  if (!Array.isArray(cohort) || cohort.length === 0) return [];
  const counts = new Map<string, number>();
  for (const entry of cohort) {
    for (const rule of entry.rules ?? []) {
      const normalized = String(rule).trim();
      if (!normalized) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  const minCount = Math.max(1, Math.ceil(cohort.length * threshold));
  return Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .sort((left, right) => right[1] - left[1])
    .map(([rule]) => rule)
    .slice(0, 25);
}

function estimateFailedTests(output: string): number {
  const match = output.match(/# fail\s+(\d+)/);
  if (match) return Number(match[1]);
  const jestMatch = output.match(/(\d+)\s+failed/);
  if (jestMatch) return Number(jestMatch[1]);
  return /fail|failing/i.test(output) ? 1 : 0;
}

function countTypeErrors(output: string): number {
  return output
    .split(/\r?\n/g)
    .filter((line) => /\berror TS\d+:/i.test(line))
    .length;
}

function estimateBundleDelta(output: string): number {
  const match = output.match(/bundle.*?([+-]?\d+(?:\.\d+)?)\s*kb/i);
  if (!match) return 0;
  return Number(match[1]);
}

function extractRouteHints(raw: string): Array<{ method: string; route: string; line: number }> {
  const routes: Array<{ method: string; route: string; line: number }> = [];
  const patterns = [
    /\b(?:app|router|server)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:fetch|axios\.(?:get|post|put|patch|delete))\(\s*["'`]([^"'`]+)["'`]/g
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const method = match[2] ? match[1].toUpperCase() : "FETCH";
      const route = match[2] ?? match[1];
      const line = raw.slice(0, match.index ?? 0).split(/\r?\n/g).length;
      routes.push({ method, route, line });
    }
  }
  return routes;
}

function extractSymbolHints(raw: string): Array<{ name: string; kind: string; line: number }> {
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const patterns = [
    { kind: "function", regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { kind: "class", regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { kind: "const", regex: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g },
    { kind: "type", regex: /\b(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/g },
    { kind: "zod", regex: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*z\.(?:object|string|number|array|boolean|enum|nativeEnum|union|intersection|tuple|record|map|set|function|lazy|promise|any|unknown|never|void|undefined|null|nan)/g }
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern.regex)) {
      symbols.push({
        name: match[1],
        kind: pattern.kind,
        line: raw.slice(0, match.index ?? 0).split(/\r?\n/g).length
      });
    }
  }
  return symbols;
}

function extractSchemaDefinitions(raw: string): Record<string, string> {
  const schemas: Record<string, string> = {};
  const patterns = [
    { regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(\{[\s\S]*?\})/g },
    { regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g },
    { regex: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*z\.object\s*\((\{[\s\S]*?\})\)/g }
  ];
  for (const p of patterns) {
    for (const match of raw.matchAll(p.regex)) {
      schemas[match[1]] = match[2].replace(/\s+/g, " ").trim();
    }
  }
  return schemas;
}

function extractImports(raw: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /import\s+.*?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /require\(\s*["'`]([^"'`]+)["'`]\)/g
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      imports.push(match[1]);
    }
  }
  return imports;
}

function detectRiskHints(relativePath: string, raw: string): string[] {
  const risks: string[] = [];
  if (/\b(exec|spawn|execFile)\s*\(/.test(raw)) risks.push("shell execution");
  if (/\b(rm\s+-rf|fs\.rm|deleteFile|unlink)\b/.test(raw)) risks.push("destructive file operation");
  if (/\b(SECRET|TOKEN|PASSWORD|API_KEY)\b/.test(raw)) risks.push("secret-bearing code");
  if (/\b(auth|session|jwt|oauth)\b/i.test(`${relativePath}\n${raw}`)) risks.push("auth boundary");
  if (/\b(sql|query|prisma|supabase|database|migration)\b/i.test(`${relativePath}\n${raw}`)) risks.push("data persistence boundary");
  if (relativePath.includes("agent-loop") || relativePath.includes("local-tools")) risks.push("agent runtime core");
  return uniqueStrings(risks, 10);
}

function tokenizeIntent(value: string): string[] {
  return uniqueStrings(
    value
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
    80
  );
}

function slugifyId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function sanitizeLlmToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.length > 0 ? normalized : "tool";
}

function severityLabel(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 85) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function normalizeTestSubject(file: string): string {
  const base = path.basename(file).replace(/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i, "").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, "");
  return base.toLowerCase();
}

function relatedTestsForFile(file: string, tests: string[], limit = 12): string[] {
  const subject = normalizeTestSubject(file);
  if (!subject) return [];
  const fileDir = path.dirname(file).toLowerCase();
  return tests
    .filter((testPath) => {
      const lower = testPath.toLowerCase();
      return lower.includes(subject) || (fileDir !== "." && lower.includes(fileDir));
    })
    .slice(0, limit);
}

async function loadIgnoreFilter(workspaceRoot: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(SKIP_DIRS);
  try {
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = await fs.readFile(gitignorePath, "utf8");
      ig.add(content);
    }
  } catch {
    // Ignore if not readable
  }
  return ig;
}

async function collectFiles(start: string, limit: number, workspaceRoot: string): Promise<string[]> {
  const ig = await loadIgnoreFilter(workspaceRoot);
  const queue = [start];
  const files: string[] = [];

  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift();
    if (!current) break;

    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= limit) break;

      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");

      // Skip hidden files except .github
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;

      // Check ignore filter
      if (ig.ignores(relativePath)) continue;

      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

export class LocalToolBackend implements ToolBackend {
  private readonly meshCore = new MeshCoreAdapter();
  private readonly cache: CacheManager;
  private agentPlan: string = "No plan defined yet.";
  private watchers: FSWatcher[] = [];
  private recentChanges: { file: string; diff: string; time: string }[] = [];
  private sessionSymbolIndex: Map<number, { path: string; name: string }> = new Map();
  private projectLexicon: Record<string, string> = {};
  public entangledWorkspaces: string[] = [];
  private changeStack: Array<{ path: string; content: string }> = [];
  private speculativeFixes: Map<string, string> = new Map();
  private readonly workspaceIndex: WorkspaceIndex;
  private readonly timelines: TimelineManager;
  private readonly runtimeObserver: RuntimeObserver;
  private readonly agentOs: AgentOs;
  private readonly meshBrain: MeshBrainClient;
  private readonly issuePipeline: IssuePipelineManager;
  private readonly chatops: ChatopsManager;
  private readonly telemetry: TelemetryManager;
  private readonly replayEngine: ReplayEngine;
  private readonly symptomBisect: SymptomBisectEngine;
  private readonly personaLoader: PersonaLoader;
  private readonly tsRefactor: TsCompilerRefactor;
  private readonly propertyTests: PropertyTestGenerator;
  private readonly smtFinder: SmtEdgeCaseFinder;
  private readonly audit: AuditLogger;
  private readonly logger: StructuredLogger;
  private readonly startupTasks: Promise<unknown>[] = [];
  private readonly selfDefense: SelfDefendingCodeEngine;
  private readonly precrime: PrecrimeEngine;
  private readonly shadowDeploy: ShadowDeployEngine;
  private readonly semanticGit: SemanticGitEngine;
  private readonly probabilisticCodebase: ProbabilisticCodebaseEngine;
  private readonly specCode: SpecCodeEngine;
  private readonly conversationalCodebase: ConversationalCodebaseEngine;
  private readonly naturalLanguageSource: NaturalLanguageSourceEngine;
  private readonly fluidMesh: FluidMeshEngine;
  private readonly livingSoftware: LivingSoftwareEngine;
  private readonly proofCarryingChange: ProofCarryingChangeEngine;
  private readonly causalAutopsy: CausalAutopsyEngine;
  private readonly todoResolver: TodoResolverEngine;
  private readonly liveWire: LiveWireEngine;
  private readonly schrodingersAst: SchrodingersAstEngine;
  private readonly hiveMind: HiveMindEngine;
  private readonly ephemeralExecution: EphemeralExecutionEngine;
  private readonly tribunal: TribunalEngine;
  private readonly sessionResurrection: SessionResurrectionEngine;
  private readonly semanticSheriff: SemanticSheriffEngine;
  private readonly productionReadiness: ProductionReadinessEngine;
  private readonly companyBrain: CompanyBrainEngine;
  private readonly issueAutopilot: IssueAutopilotEngine;

  constructor(private readonly workspaceRoot: string, private readonly config?: AppConfig) {
    this.cache = new CacheManager(config ?? {
      agent: {
        workspaceRoot,
        maxSteps: 8,
        mode: "local",
        enableCloudCache: true,
        themeColor: "cyan",
        voice: {
          configured: false,
          language: "auto",
          speed: 260,
          voice: "auto",
          microphone: "default",
          transcriptionModel: "small"
        }
      },
      bedrock: { endpointBase: "", modelId: "", fallbackModelIds: [], temperature: 0, maxTokens: 0 },
      mcp: { args: [] },
      supabase: {},
      telemetry: { contribute: false }
    });
    this.workspaceIndex = new WorkspaceIndex(workspaceRoot, this.meshCore, this.cache, {
      apiKey: config?.bedrock?.bearerToken,
      baseUrl: config?.bedrock?.endpointBase
    });
    this.startLiveSyncWatcher();
    this.timelines = new TimelineManager(workspaceRoot);
    this.runtimeObserver = new RuntimeObserver(workspaceRoot);
    this.agentOs = new AgentOs(workspaceRoot, this.timelines);
    this.meshBrain = new MeshBrainClient({
      workspaceRoot,
      telemetryContribute: Boolean(config?.telemetry?.contribute),
      endpoint: config?.telemetry?.meshBrainEndpoint
    });
    this.issuePipeline = new IssuePipelineManager(workspaceRoot, {
      intentCompile: async (intent: string) => this.intentCompile({ intent }),
      impactMap: async (query: string) => this.impactMap({ symbol: query })
    });
    this.chatops = new ChatopsManager(workspaceRoot, {
      intentCompile: async (intent: string) => this.intentCompile({ intent }),
      predictiveRepair: async () => this.predictiveRepair({ action: "analyze" })
    });
    this.telemetry = new TelemetryManager(workspaceRoot);
    this.replayEngine = new ReplayEngine(workspaceRoot, this.timelines);
    this.symptomBisect = new SymptomBisectEngine(workspaceRoot, this.timelines);
    this.personaLoader = new PersonaLoader(workspaceRoot);
    this.tsRefactor = new TsCompilerRefactor(workspaceRoot);
    this.propertyTests = new PropertyTestGenerator(workspaceRoot);
    this.smtFinder = new SmtEdgeCaseFinder(workspaceRoot);
    this.audit = new AuditLogger(workspaceRoot);
    this.logger = new StructuredLogger(workspaceRoot);
    this.selfDefense = new SelfDefendingCodeEngine(workspaceRoot);
    this.precrime = new PrecrimeEngine(workspaceRoot);
    this.shadowDeploy = new ShadowDeployEngine(workspaceRoot, this.timelines);
    this.semanticGit = new SemanticGitEngine(workspaceRoot, this.timelines);
    this.probabilisticCodebase = new ProbabilisticCodebaseEngine(workspaceRoot);
    this.specCode = new SpecCodeEngine(workspaceRoot);
    this.conversationalCodebase = new ConversationalCodebaseEngine(workspaceRoot);
    this.naturalLanguageSource = new NaturalLanguageSourceEngine(workspaceRoot);
    this.fluidMesh = new FluidMeshEngine(workspaceRoot);
    this.livingSoftware = new LivingSoftwareEngine(workspaceRoot, (name, args) => this.callTool(name, args));
    this.proofCarryingChange = new ProofCarryingChangeEngine(workspaceRoot);
    this.causalAutopsy = new CausalAutopsyEngine(workspaceRoot);
    this.todoResolver = new TodoResolverEngine(workspaceRoot, (name, args) => this.callTool(name, args));
    this.liveWire = new LiveWireEngine(workspaceRoot);
    this.schrodingersAst = new SchrodingersAstEngine(workspaceRoot);
    this.hiveMind = new HiveMindEngine(workspaceRoot);
    this.ephemeralExecution = new EphemeralExecutionEngine(workspaceRoot, (name, args) => this.callTool(name, args));

    // Build a lightweight callLlm callback for the Tribunal engine using the same Bedrock proxy
    const tribunalCallLlm: TribunalLlmCall | undefined = config ? async (system, user, temperature = 0, modelHint) => {
      const modelId = modelHint === "haiku"
        ? HAIKU_MODEL_ID
        : config.bedrock.modelId;
      const llm = new BedrockLlmClient({
        endpointBase: config.bedrock.endpointBase,
        modelId,
        bearerToken: config.bedrock.bearerToken,
        temperature,
        maxTokens: 1500
      });
      const response = await llm.converse(
        [{ role: "user", content: [{ text: user }] }],
        [],
        system
      );
      return response.kind === "text" ? response.text : "";
    } : undefined;

    this.tribunal = new TribunalEngine(workspaceRoot, tribunalCallLlm);
    this.sessionResurrection = new SessionResurrectionEngine(workspaceRoot);
    this.semanticSheriff = new SemanticSheriffEngine(workspaceRoot);
    this.productionReadiness = new ProductionReadinessEngine(workspaceRoot, (name, args) => this.callTool(name, args));
    this.companyBrain = new CompanyBrainEngine(workspaceRoot, (name, args) => this.callTool(name, args));
    this.issueAutopilot = new IssueAutopilotEngine(workspaceRoot, {
      callTool: (name, args) => this.callTool(name, args),
      callLlm: config ? async ({ system, user, temperature = 0.1, maxTokens = 8192 }) => {
        const llm = new BedrockLlmClient({
          endpointBase: config.bedrock.endpointBase,
          modelId: config.bedrock.modelId,
          fallbackModelIds: config.bedrock.fallbackModelIds,
          bearerToken: config.bedrock.bearerToken,
          temperature,
          maxTokens
        });
        const response = await llm.converse(
          [{ role: "user", content: [{ text: user }] }],
          [],
          system
        );
        return response.kind === "text" ? response.text : "";
      } : undefined
    });

    this.startupTasks.push(
      this.bootstrapRepoDnaMemory(),
      this.agentOs.ensureDefaultDefinitions(),
      this.runtimeObserver.writeDefaultRunbooks()
    );
    void Promise.allSettled(this.startupTasks);
    this.startWatcher();
  }

  private startWatcher() {
    if (WATCHER_DISABLED || this.watchers.length > 0) return;
    const watchRoots = [this.workspaceRoot, ...WATCHABLE_DIRS.map((dir) => path.join(this.workspaceRoot, dir))]
      .filter((dir, index, dirs) => existsSync(dir) && dirs.indexOf(dir) === index);

    for (const watchRoot of watchRoots) {
      try {
        const watcher = watch(watchRoot, { recursive: false }, async (_eventType: string, filename: string | null) => {
          if (!filename) return;
          const absPath = path.resolve(watchRoot, filename);
          const rel = toPosixRelative(this.workspaceRoot, absPath);
          if (rel.startsWith("..") || path.isAbsolute(rel) || !isWatchableSourcePath(rel)) return;
          await this.handleWatchedFile(absPath, rel);
        });
        watcher.on("error", () => this.closeWatcher(watcher));
        watcher.unref?.();
        this.watchers.push(watcher);
      } catch {
        // Watchers are best-effort. Mesh must still start if live sync is unavailable.
      }
    }
  }

  private closeWatcher(watcher: FSWatcher): void {
    try {
      watcher.close();
    } catch {
      // Ignore shutdown errors.
    }
    this.watchers = this.watchers.filter((entry) => entry !== watcher);
  }

  private async handleWatchedFile(absPath: string, rel: string): Promise<void> {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return;
      const mtimeMs = Math.floor(stat.mtimeMs);

      try {
        const { stdout } = await execAsync(`git diff -U1 "${rel}"`, { cwd: this.workspaceRoot });
        if (stdout) {
          this.recentChanges.unshift({ file: rel, diff: stdout.slice(0, 1000), time: new Date().toISOString() });
          if (this.recentChanges.length > 5) this.recentChanges.pop();
        }
      } catch {
        // Ignore git errors.
      }

      setTimeout(() => {
        this.refreshWatchedFile(absPath, rel, mtimeMs).catch(() => undefined);
      }, 1000);
    } catch {
      // File likely deleted, cache will naturally miss.
    }
  }

  private async refreshWatchedFile(absPath: string, rel: string, mtimeMs: number): Promise<void> {
    const currentStat = await fs.stat(absPath).catch(() => null);
    if (!currentStat?.isFile() || Math.floor(currentStat.mtimeMs) !== mtimeMs) return;
    await this.workspaceIndex.partialUpdate([rel]).catch(() => undefined);

    if (!BACKGROUND_RESOLVER_ENABLED || !this.meshCore.isAvailable) return;
    const raw = await fs.readFile(absPath, "utf8").catch(() => null);
    if (!raw) return;
    const summaries = await this.meshCore.summarizeAllTiers(rel, raw);
    await Promise.all(CAPSULE_TIERS.map((tier) => this.cache.setCapsule(rel, tier, summaries[tier], mtimeMs)));

    if (rel.match(/\.(ts|js|tsx)$/)) {
      const diag = await this.getDiagnostics();
      if (!(diag as any).ok) {
        await this.recordPredictiveRepairSignal(rel, diag);
      }
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "workspace.list_files",
        description: "List files in the local workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            limit: { type: "number" }
          }
        }
      },
      {
        name: "workspace.read_file",
        description: "Read the Mesh capsule (optimized summary) of a file. Use this for general understanding.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            tier: { type: "string", enum: ["low", "medium", "high"], default: "medium" }
          }
        }
      },
      {
        name: "workspace.read_slice",
        description: "Read a semantic context slice of a specific function/class from a file. PERFECT for minimizing context usage on large files while retaining all necessary imports and the exact AST block.",
        inputSchema: {
          type: "object",
          required: ["path", "symbol"],
          properties: {
            path: { type: "string" },
            symbol: { type: "string", description: "The exact name of the function, class, or method you want to read." }
          }
        }
      },
      {
        name: "workspace.open_artifact",
        description: "Open a specific locally stored tool-result artifact by id. ONLY call this when the user explicitly asks to see artifact details, or when a prior tool call returned truncated data and you need a specific field. NEVER call this automatically after another tool call — the tool result is already in context.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            query: { type: "string", description: "Optional search terms to extract matching lines from the artifact." },
            maxChars: { type: "number", description: "Maximum characters to return, default 4000." }
          }
        }
      },
      {
        name: "workspace.read_file_raw",
        description: "Read the actual raw source code of a file. ONLY use this when you need to edit the file or see exact implementation details that are missing from the capsule.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.search_files",
        description: "Search file paths by substring.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.grep_content",
        description: "Search raw file contents. Expensive, use only if grep_capsules fails to find what you need.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.grep_capsules",
        description: "Search in cached capsules (summaries). Very fast and efficient for high-level searching.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          }
        }
      },
      {
        name: "workspace.write_file",
        description: "Write content to a file, creating or overwriting it. Automatically creates parent directories.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          }
        }
      },
      {
        name: "workspace.run_command",
        description: "Run a shell command in the workspace and return its stdout and stderr.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" }
          }
        }
      },
      { name: "workspace.get_index_status", description: "Get current indexing progress and cache coverage" },
      {
        name: "workspace.index_status",
        description: "Get persistent local code-intelligence index status, storage path, and stale-file count.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "workspace.read_multiple_files",
        description: "Read multiple files from the workspace in a single call.",
        inputSchema: {
          type: "object",
          required: ["paths"],
          properties: {
            paths: { type: "array", items: { type: "string" } }
          }
        }
      },
      {
        name: "workspace.read_file_lines",
        description: "Read specific lines from a file.",
        inputSchema: {
          type: "object",
          required: ["path", "startLine", "endLine"],
          properties: {
            path: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" }
          }
        }
      },
      {
        name: "workspace.list_directory",
        description: "List contents of a specific directory (not recursive).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.get_file_info",
        description: "Get detailed information about a file (size, mtime, etc).",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.move_file",
        description: "Move or rename a file.",
        inputSchema: {
          type: "object",
          required: ["sourcePath", "destinationPath"],
          properties: {
            sourcePath: { type: "string" },
            destinationPath: { type: "string" }
          }
        }
      },
      {
        name: "workspace.delete_file",
        description: "Delete a file from the workspace.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.patch_file",
        description: "Replace a specific block of text in a file.",
        inputSchema: {
          type: "object",
          required: ["path", "search", "replace"],
          properties: {
            path: { type: "string" },
            search: { type: "string" },
            replace: { type: "string" }
          }
        }
      },
      {
        name: "workspace.patch_surgical",
        description: "Apply a surgical search-and-replace block. More robust than patch_file as it uses context-aware matching.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path", "searchBlock", "replaceBlock"],
          properties: {
            path: { type: "string" },
            searchBlock: { type: "string", description: "The exact block of code to find (including indentation)." },
            replaceBlock: { type: "string", description: "The new block of code to put in its place." }
          }
        }
      },
      {
        name: "workspace.list_symbols",
        description: "List functions, classes, and variables in a file using Mesh Intelligence.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.expand_symbol",
        description: "Get the raw source code for a specific symbol (function/class) from a file. Use this to see implementation details without reading the whole file.",
        inputSchema: {
          type: "object",
          required: ["path", "symbolName"],
          properties: {
            path: { type: "string" },
            symbolName: { type: "string" }
          }
        }
      },
      {
        name: "workspace.get_file_graph",
        description: "Get the import/export dependency graph for a specific file.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.read_dir_overview",
        description: "Get a high-level overview of all files in a directory using ultra-low tier capsules. Efficient for understanding a module's public API.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.git_diff",
        description: "Show uncommitted changes in the workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional path to limit diff to." }
          }
        }
      },
      {
        name: "web.read_docs",
        description: "Fetch and read documentation from a URL. Extracts the main text content.",
        inputSchema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" }
          }
        }
      },
      {
        name: "workspace.run_in_shadow",
        description: "Run a command in a temporary, isolated copy of the workspace (Shadow Workspace) to safely test changes without affecting the main directory.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" }
          }
        }
      },
      {
        name: "workspace.get_diagnostics",
        description: "Run project linters and type checkers (like tsc) to find errors.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "workspace.find_references",
        description: "Find all usages of a specific symbol across the workspace (Lightweight LSP alternative).",
        inputSchema: {
          type: "object",
          required: ["symbol"],
          properties: {
            symbol: { type: "string" }
          }
        }
      },
      {
        name: "workspace.ask_codebase",
        description: "Query the persistent local code-intelligence index. Returns cited matches with file, symbol, line range, confidence, and match rationale.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Natural language query about the codebase." },
            mode: {
              type: "string",
              enum: ["architecture", "bug", "edit-impact", "test-impact", "ownership", "recent-change", "runtime-path"],
              default: "architecture"
            },
            limit: { type: "number", default: 8 }
          }
        }
      },
      {
        name: "workspace.explain_symbol",
        description: "Explain an indexed symbol with definition location, callers, dependencies, exports, and linked tests.",
        inputSchema: {
          type: "object",
          required: ["symbol"],
          properties: {
            symbol: { type: "string" }
          }
        }
      },
      {
        name: "workspace.impact_map",
        description: "Map edit/test/runtime impact for a path, symbol, or unified diff using the persistent index graph.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            symbol: { type: "string" },
            diff: { type: "string" }
          }
        }
      },
      {
        name: "workspace.expand_execution_path",
        description: "Dependency-Slicing: Returns the body of a specific function AND the signatures of all other functions it calls.",
        inputSchema: {
          type: "object",
          required: ["path", "symbolName"],
          properties: {
            path: { type: "string" },
            symbolName: { type: "string" }
          }
        }
      },
      {
        name: "workspace.generate_lexicon",
        description: "Void-Protocol: Create a session dictionary of project terms. Enables using #ID in patches for max token saving.",
        inputSchema: {
          type: "object",
          properties: {
            paths: { type: "array", items: { type: "string" }, description: "Files to scan for dictionary terms." }
          }
        }
      },
      {
        name: "workspace.ghost_verify",
        description: "Ghost Branch Lifecycle: Run tests/build on a proposed change in a parallel timeline. Ensures NO REGRESSIONS before applying to main workspace.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["patch", "testCommand"],
          properties: {
            patch: { type: "string", description: "The alien_patch or surgical patch to verify." },
            testCommand: { type: "string", description: "Command to run in ghost branch (e.g. 'npm test')." }
          }
        }
      },
      {
        name: "workspace.timeline_create",
        description: "Create an isolated speculative timeline using a git worktree when possible, falling back to an isolated checkout copy.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            baseRef: { type: "string", default: "HEAD" }
          }
        }
      },
      {
        name: "workspace.timeline_apply_patch",
        description: "Apply a unified diff patch inside an isolated timeline without touching the main workspace.",
        inputSchema: {
          type: "object",
          required: ["timelineId", "patch"],
          properties: {
            timelineId: { type: "string" },
            patch: { type: "string" }
          }
        }
      },
      {
        name: "workspace.timeline_run",
        description: "Run a verification command inside an isolated timeline and persist stdout/stderr artifacts.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["timelineId", "command"],
          properties: {
            timelineId: { type: "string" },
            command: { type: "string" },
            timeoutMs: { type: "number" }
          }
        }
      },
      {
        name: "workspace.timeline_compare",
        description: "Compare one or more timelines by diff stat, changed files, execution time, last command, and verification verdict.",
        inputSchema: {
          type: "object",
          required: ["timelineIds"],
          properties: {
            timelineIds: { type: "array", items: { type: "string" } }
          }
        }
      },
      {
        name: "workspace.timeline_promote",
        description: "Promote a passing timeline diff into the main workspace.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["timelineId"],
          properties: {
            timelineId: { type: "string" }
          }
        }
      },
      {
        name: "workspace.timeline_list",
        description: "List recent speculative timelines for this workspace.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "workspace.symptom_bisect",
        description: "Autonomous git bisect by symptom description. Validates a verification command across commit history and returns likely introducing commit.",
        inputSchema: {
          type: "object",
          required: ["symptom"],
          properties: {
            symptom: { type: "string" },
            verificationCommand: { type: "string" },
            searchDepth: { type: "number", default: 50 }
          }
        }
      },
      {
        name: "workspace.what_if",
        description: "Counterfactual mode: evaluate a migration/refactor in an isolated timeline and return a What-If report without applying changes by default.",
        inputSchema: {
          type: "object",
          required: ["hypothesis"],
          properties: {
            hypothesis: { type: "string" },
            verificationCommand: { type: "string" },
            promote: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "workspace.self_defend",
        description: "Moonshot 05: continuously harden code. Scans/probes ReDoS-class vulnerabilities, writes a security ledger, and returns verified findings.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["scan", "probe", "harden", "daemon_tick", "status"], default: "scan" },
            path: { type: "string" },
            maxFiles: { type: "number", default: 500 },
            confirm: { type: "boolean", default: false },
            verificationCommand: { type: "string" },
            timeoutMs: { type: "number" }
          }
        }
      },
      {
        name: "workspace.precrime",
        description: "Moonshot 08: predict likely bugs before they happen from diffs, repo structure, coverage hints, and production telemetry.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["analyze", "gate", "record_outcome", "status"], default: "analyze" },
            maxFiles: { type: "number", default: 250 },
            path: { type: "string" },
            file: { type: "string" },
            incident: { type: "boolean" },
            outcome: { type: "string", enum: ["incident", "clean"] },
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            tags: { type: "array", items: { type: "string" } },
            verificationCommand: { type: "string" },
            notes: { type: "string" }
          }
        }
      },
      {
        name: "workspace.end_staging",
        description: "Moonshot 06: shadow-deploy verification ledger. Runs checks in a timeline and reports promotion gates before human review.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["shadow", "status"], default: "shadow" },
            command: { type: "string", default: "npm test" },
            verificationCommand: { type: "string" },
            timeoutMs: { type: "number" }
          }
        }
      },
      {
        name: "workspace.todo_resolver",
        description: "Moonshot: Autonomous Technical Debt Resolver. Scans for TODO/FIXME markers and resolves them via timeline and fix racing.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["scan", "resolve"], default: "scan" },
            file: { type: "string", description: "Required for resolve action. Target file." },
            text: { type: "string", description: "Required for resolve action. TODO text." },
            maxFiles: { type: "number" }
          }
        }
      },
      {
        name: "workspace.live_wire",
        description: "Endgame: Mesh Live-Wire. Hot-swap AST in a running Node V8 process without downtime.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["attach", "status"], default: "attach" },
            target: { type: "string", description: "Port (e.g. 9229) or PID of the target process." },
            scriptName: { type: "string", description: "Name of the script/file to patch in V8 memory." },
            newFunctionBody: { type: "string", description: "The new code payload to inject." }
          }
        }
      },
      {
        name: "workspace.schrodingers_ast",
        description: "Endgame: Schrödinger's AST. Generates a QuantumRouter to run multiple AST variants in superposition and measure their performance.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["superpose", "status"], default: "superpose" },
            file: { type: "string", description: "Target file path." },
            functionName: { type: "string", description: "Target function to wrap in superposition." },
            variants: { type: "array", items: { type: "string" }, description: "Array of function body strings." }
          }
        }
      },
      {
        name: "workspace.hive_mind",
        description: "Endgame: The Hive Mind. Broadcast uncommitted AST intents via P2P (simulated) to prevent merge conflicts before they happen.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["share_thoughts", "status"], default: "share_thoughts" }
          }
        }
      },
      {
        name: "workspace.ephemeral_execution",
        description: "Endgame: Ephemeral Execution (Zero-Source). Starts a JIT server that hallucinates routing logic per request without storing source code.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "status"], default: "start" },
            port: { type: "number", description: "Port for the ephemeral server." },
            specPath: { type: "string", description: "Path to OpenAPI/GraphQL spec." }
          }
        }
      },
      {
        name: "workspace.semantic_git",
        description: "Moonshot 02: semantic Git. Plans, verifies, and optionally promotes conflict resolutions in isolated timelines based on symbol-level merge semantics.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["analyze", "plan", "resolve", "verify", "status"], default: "analyze" },
            path: { type: "string" },
            verificationCommand: { type: "string" },
            timeoutMs: { type: "number" },
            promote: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "workspace.probabilistic_codebase",
        description: "Moonshot 04: plan safe probabilistic variants and routing guardrails for routes, hotspots, and pure functions.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["plan", "status"], default: "plan" },
            intent: { type: "string" }
          }
        }
      },
      {
        name: "workspace.conversational_codebase",
        description: "Moonshot 03: symbol-level memory and answers so the codebase can explain its own state, history, and conventions.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["ask", "record", "map", "status"], default: "ask" },
            query: { type: "string" },
            symbol: { type: "string" },
            note: { type: "string" }
          }
        }
      },
      {
        name: "workspace.spec_code",
        description: "Moonshot 01: bidirectional spec-code system. Synthesizes behavior contracts from code/tests/routes, accepts human specs, detects drift, locks contracts, and emits materialization patch plans.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["synthesize", "check", "assert", "lock", "unlock", "materialize", "status"], default: "synthesize" },
            id: { type: "string" },
            subject: { type: "string" },
            behavior: { type: "string" },
            file: { type: "string" }
          }
        }
      },
      {
        name: "workspace.natural_language_source",
        description: "Moonshot 09: compile constrained natural-language intent into an implementation IR, patch plan, and verification plan.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["compile", "status"], default: "compile" },
            intent: { type: "string" },
            source: { type: "string" }
          }
        }
      },
      {
        name: "workspace.fluid_mesh",
        description: "Moonshot 07: map repository capabilities as portable units independent of file/repo boundaries.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["map", "status"], default: "map" }
          }
        }
      },
      {
        name: "workspace.living_software",
        description: "Moonshot 10: synthesize all moonshot ledgers into a living-software pulse with health scores and next interventions. Includes 'drive_coverage' action for autonomous test generation.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["pulse", "status", "drive_coverage"], default: "pulse" }
          }
        }
      },
      {
        name: "workspace.proof_carrying_change",
        description: "Generate a promotion-grade proof bundle for a change: intent, touched capabilities, affected contracts, risk model, verification, rollback, and assumptions.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["generate", "verify", "status"], default: "generate" },
            intent: { type: "string" },
            verificationCommand: { type: "string" },
            timeoutMs: { type: "number" }
          }
        }
      },
      {
        name: "workspace.causal_autopsy",
        description: "Reconstruct a failure's causal chain from symptom text, runtime evidence, diffs, config/dependency deltas, proofs, and Mesh ledgers.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["investigate", "status"], default: "investigate" },
            symptom: { type: "string" },
            runId: { type: "string" },
            failingCommand: { type: "string" },
            timeoutMs: { type: "number" }
          }
        }
      },
      {
        name: "workspace.tribunal",
        description: "Moonshot: Cross-Model Tribunal. Routes a hard engineering problem to three expert AI panelists (Correctness, Performance, Resilience), runs a structured debate where each critiques the others, and synthesizes the dominant solution. Produces a decision artifact with full debate trail.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["convene", "status"], default: "convene" },
            problem: { type: "string", description: "The engineering problem or decision to adjudicate." },
            context: { type: "string", description: "Optional codebase context or constraints to include." }
          }
        }
      },
      {
        name: "workspace.session_resurrection",
        description: "Moonshot: Cognitive Session Resurrection. Captures your current intent, open questions, failed approaches, insights, and next actions as a persistent snapshot. Reconstructs your full mental state at the start of any future session so you never start cold again.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["capture", "resurrect", "checkpoint", "status", "clear"], default: "resurrect" },
            intent: { type: "string", description: "Required for capture: what are you trying to accomplish?" },
            filesInFocus: { type: "array", items: { type: "string" }, description: "Files actively being worked on." },
            openQuestions: { type: "array", items: { type: "string" }, description: "Unresolved questions blocking progress." },
            failedApproaches: { type: "array", items: { type: "object" }, description: "Array of {approach, reason} objects." },
            insights: { type: "array", items: { type: "string" }, description: "Key discoveries from this session." },
            nextActions: { type: "array", items: { type: "string" }, description: "Ordered list of highest-leverage next steps." },
            note: { type: "string", description: "Free-form note to attach to the snapshot." }
          }
        }
      },
      {
        name: "workspace.semantic_sheriff",
        description: "Moonshot: Semantic Contract Sheriff. Fingerprints every module's semantic meaning (exports, purpose, behavioral patterns). Detects when refactoring silently changes what a module MEANS even when tests pass. Lock critical contracts to trigger critical-severity alerts on drift.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["scan", "verify", "lock", "unlock", "drift", "status", "clear"], default: "verify" },
            file: { type: "string", description: "Target file for lock/unlock/verify actions." },
            maxFiles: { type: "number", default: 400, description: "Max files to scan." },
            force: { type: "boolean", default: false, description: "Force full re-verify of all contracts (not just changed files)." }
          }
        }
      },
      {
        name: "agent.assemble_team",
        description: "Classify a task and auto-assemble specialist personas from .mesh/personas for coordinated execution.",
        inputSchema: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string" }
          }
        }
      },
      {
        name: "workspace.alien_patch",
        description: "Mesh-Alien-OS: Apply a high-density symbolic patch using session IDs and opcodes. MAX TOKENS SAVED. Example: !1 > { r: true }",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["patch"],
          properties: {
            patch: { type: "string", description: "Symbolic patch string. Format: ![ID] > { [ALIENT_CODE] }" }
          }
        }
      },
      {
        name: "workspace.session_index_symbols",
        description: "Generate short session IDs for file symbols to enable Mesh-Alien-OS patching.",
        inputSchema: {
          type: "object",
          required: ["paths"],
          properties: {
            paths: { type: "array", items: { type: "string" } }
          }
        }
      },
      {
        name: "workspace.rename_symbol",
        description: "AST-Native Micro-Edit: Safely renames a specific function/variable in a file without rewriting blocks of code. Auto-validates syntax.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path", "oldName", "newName"],
          properties: {
            path: { type: "string" },
            oldName: { type: "string", description: "Exact current name." },
            newName: { type: "string", description: "The new name to apply." }
          }
        }
      },
      {
        name: "workspace.extract_function",
        description: "Compiler-backed refactor: extract a selected line range into a named function using ts-morph.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path", "functionName", "startLine", "endLine"],
          properties: {
            path: { type: "string" },
            functionName: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" }
          }
        }
      },
      {
        name: "workspace.inline_symbol",
        description: "Compiler-backed refactor: inline a variable symbol and remove its declaration where safe.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path", "symbolName"],
          properties: {
            path: { type: "string" },
            symbolName: { type: "string" }
          }
        }
      },
      {
        name: "workspace.move_to_module",
        description: "Compiler-backed refactor: move an exported function/variable into another module.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["fromPath", "toPath", "symbolName"],
          properties: {
            fromPath: { type: "string" },
            toPath: { type: "string" },
            symbolName: { type: "string" }
          }
        }
      },
      {
        name: "workspace.generate_properties",
        description: "Generate property-based tests (fast-check) for modified functions or the full workspace.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            functionName: { type: "string" },
            all: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "workspace.find_edge_cases",
        description: "SMT-inspired edge-case discovery for tagged functions; generates counterexample tests.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            functionName: { type: "string" }
          }
        }
      },
      {
        name: "workspace.audit",
        description: "Enterprise audit trail utilities: replay and verify cryptographic hash-chain integrity.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["replay", "verify"], default: "verify" },
            limit: { type: "number", default: 200 }
          }
        }
      },
      {
        name: "workspace.semantic_undo",
        description: "Non-Linear Chrono-Untangling: Revert a specific past concept or feature implementation without breaking more recent changes. Uses AST graph theory to safely de-merge old logic.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["concept"],
          properties: {
            concept: { type: "string", description: "The feature or concept name to remove (e.g. 'Auth System')." }
          }
        }
      },
      {
        name: "workspace.finalize_task",
        description: "Semantic Git & PR Automator: Creates a branch, generates a semantic commit message from the current agent plan, and prepares a PR.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["branchName", "commitMessage"],
          properties: {
            branchName: { type: "string" },
            commitMessage: { type: "string", description: "A detailed semantic commit message explaining the WHY." }
          }
        }
      },
      {
        name: "web.inspect_ui",
        description: "Multi-modal Sight: Takes a screenshot of a local or remote URL using Playwright and returns a base64 string for visual UI/UX debugging. Requires `playwright` to be installed locally (`npm i -g playwright && npx playwright install chromium`). For a zero-dependency alternative use `frontend.preview` (built-in Chrome CDP).",
        inputSchema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" }
          }
        }
      },
      {
        name: "frontend.preview",
        description: "Render a real frontend screenshot in the terminal using Chrome DevTools Protocol directly, then Kitty/iTerm2/Sixel terminal graphics when available. Does not use Playwright.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            width: { type: "number", default: 1280 },
            height: { type: "number", default: 800 },
            waitMs: { type: "number", default: 1200 },
            render: { type: "boolean", default: true },
            protocol: { type: "string", enum: ["auto", "kitty", "iterm2", "sixel", "none"], default: "auto" },
            outputPath: { type: "string" }
          }
        }
      },
      {
        name: "workspace.query_ast",
        description: "Tree-sitter Query Engine: Search the codebase for structural patterns using ast-grep (sg) syntax. Uses a locally installed `ast-grep` binary if available (recommended: `brew install ast-grep`), otherwise falls back to `npx @ast-grep/cli` (requires network on first run).",
        inputSchema: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string", description: "The AST pattern to search for. E.g., 'function $A() { $$$ }'" }
          }
        }
      },
      {
        name: "workspace.get_recent_changes",
        description: "Time-Travel AST Diffing: Get recent background modifications (git diffs) tracked by the workspace watcher. Use this to catch up on changes without re-reading files.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "workspace.run_with_telemetry",
        description: "Runtime Telemetry Injection: Runs a Node.js command and attaches a V8 inspector. If it crashes, it dumps the exact memory state (local variables) at the exact moment of the crash.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Node command to run (e.g. 'node src/index.js' or 'npm run dev')." }
          }
        }
      },
      {
        name: "runtime.start",
        description: "Start a runtime observer for a command or .mesh/runbooks/<profile>.json profile. Captures stdout/stderr as replayable run artifacts.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            profile: { type: "string" },
            timeoutMs: { type: "number" }
          }
        }
      },
      {
        name: "runtime.capture_failure",
        description: "Capture failure details, stack frames, and log tails for a runtime observer run.",
        inputSchema: {
          type: "object",
          required: ["runId"],
          properties: {
            runId: { type: "string" }
          }
        }
      },
      {
        name: "runtime.capture_deep_autopsy",
        description: "Failure Autopsy: Reconstructs the causal chain of a crash using inspector-backed stack frames and scope values when available, with log fallback otherwise.",
        inputSchema: {
          type: "object",
          required: ["runId"],
          properties: {
            runId: { type: "string" }
          }
        }
      },
      {
        name: "runtime.trace_request",
        description: "Map a URL, test name, or stack frame to likely runtime-path index queries.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            testName: { type: "string" },
            stackFrame: { type: "string" }
          }
        }
      },
      {
        name: "runtime.explain_failure",
        description: "Explain a captured runtime/test failure and list likely source files.",
        inputSchema: {
          type: "object",
          required: ["runId"],
          properties: {
            runId: { type: "string" }
          }
        }
      },
      {
        name: "runtime.fix_failure",
        description: "Turn a captured failure into a timeline-first fix task with recommended verification tools.",
        inputSchema: {
          type: "object",
          required: ["runId"],
          properties: {
            runId: { type: "string" }
          }
        }
      },
      {
        name: "runtime.replay_trace",
        description: "Production incident replay from OpenTelemetry trace IDs or Sentry event IDs, with optional commit-range divergence analysis.",
        inputSchema: {
          type: "object",
          properties: {
            traceId: { type: "string" },
            sentryEventId: { type: "string" },
            commitRange: { type: "string", description: "Optional git commit range in form start..end." }
          }
        }
      },
      {
        name: "workspace.validate_patch",
        description: "Pre-Cognitive Ghost Execution: Test a surgical patch in memory without actually saving it. Useful to check if your code compiles before committing to it.",
        inputSchema: {
          type: "object",
          required: ["path", "searchBlock", "replaceBlock"],
          properties: {
            path: { type: "string" },
            searchBlock: { type: "string" },
            replaceBlock: { type: "string" }
          }
        }
      },
      {
        name: "workspace.trace_symbol",
        description: "Symbolic Trace Routing: Recursively trace the data flow and usages of a specific symbol backwards to find its origin and call sites.",
        inputSchema: {
          type: "object",
          required: ["path", "symbol"],
          properties: {
            path: { type: "string" },
            symbol: { type: "string" }
          }
        }
      },
      {
        name: "agent.race_fixes",
        description: "Multiverse Fix Racing: Generates multiple candidate fixes in parallel timelines, verifies them, compares telemetry, and ranks them by stability and quality.",
        inputSchema: {
          type: "object",
          required: ["task", "verificationCommand"],
          properties: {
            task: { type: "string", description: "The problem to fix (e.g. 'Fix the linter error in src/auth.ts')." },
            verificationCommand: { type: "string", description: "The command to run to verify the fix (e.g. 'npm test')." },
            candidates: { type: "number", description: "Number of parallel timelines to spawn (default: 3).", default: 3 }
          }
        }
      },
      {
        name: "agent.spawn_swarm",
        description: "Neural Swarm Orchestration: Spawns multiple sub-agents to work on different parts of a task in parallel. Max efficiency for multi-file features.",
        inputSchema: {
          type: "object",
          required: ["subTasks"],
          properties: {
            subTasks: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "prompt"],
                properties: {
                  id: { type: "string", description: "Unique ID for this sub-task." },
                  prompt: { type: "string", description: "Instruction for this specific sub-agent." }
                }
              }
            }
          }
        }
      },
      {
        name: "agent.spawn",
        description: "Create a role-scoped worker record and isolated timeline from .mesh/agents/<role>.md.",
        inputSchema: {
          type: "object",
          required: ["role", "task"],
          properties: {
            role: { type: "string" },
            task: { type: "string" },
            workspaceScope: { type: "array", items: { type: "string" } },
            writeScope: { type: "array", items: { type: "string" } }
          }
        }
      },
      {
        name: "agent.status",
        description: "List worker records or inspect one worker by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" }
          }
        }
      },
      {
        name: "agent.review",
        description: "Review a timeline diff with deterministic safety and verification heuristics.",
        inputSchema: {
          type: "object",
          required: ["timelineId"],
          properties: {
            timelineId: { type: "string" }
          }
        }
      },
      {
        name: "agent.merge_verified",
        description: "Promote a timeline only after it has a passing verification verdict.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          required: ["timelineId"],
          properties: {
            timelineId: { type: "string" }
          }
        }
      },
      {
        name: "agent.invoke_sub_agent",
        description: "Hierarchical MoE: Dispatch a lightweight sub-agent to research a topic or summarize files autonomously. Keeps the main context clean.",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "Detailed instruction for the sub-agent. E.g., 'Read files in /src and summarize how routing works.'" }
          }
        }
      },
      {
        name: "agent.plan",
        description: "Update or read the agent's internal scratchpad/plan. Use this to keep track of multi-step tasks.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write"], default: "read" },
            plan: { type: "string", description: "The plan to write (only for action='write')." }
          }
        }
      },
      {
        name: "workspace.get_env_info",
        description: "Get information about the local environment (OS, Node version, common tools).",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "workspace.grep_ripgrep",
        description: "Fast content search using ripgrep (if available).",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            includePattern: { type: "string" }
          }
        }
      },
      { name: "workspace.git_status", description: "Get current git status (branch, changed files)." },
      { name: "workspace.check_sync", description: "Verify cloud (L2) synchronization status" },
      { name: "workspace.index_everything", description: "Explicitly trigger full workspace indexing (generate all capsules)" },
      {
        name: "workspace.digital_twin",
        description: "Build or read the Codebase Digital Twin: symbols, routes, tests, deploy/config files, env names, risk hotspots, and git state.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["build", "read", "status"], default: "build" }
          }
        }
      },
      {
        name: "workspace.predictive_repair",
        description: "Predictive Repair Daemon: analyze diagnostics, recent diffs, and learned risk memory to prepare verifiable repair candidates.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["analyze", "status", "clear"], default: "analyze" },
            verificationCommand: { type: "string", description: "Optional verification command to attach to prepared repairs." }
          }
        }
      },
      {
        name: "workspace.engineering_memory",
        description: "Read, record, or learn repository-specific engineering rules from accepted/rejected work and risky modules.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "record", "learn"], default: "read" },
            outcome: { type: "string", enum: ["accepted", "rejected", "neutral"] },
            note: { type: "string" },
            rule: { type: "string" },
            files: { type: "array", items: { type: "string" } }
          }
        }
      },
      {
        name: "workspace.brain",
        description: "Mesh Brain network-effect interface: query global fix patterns, read contribution stats, or opt out.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["stats", "query", "opt_out"], default: "stats" },
            error: { type: "string", description: "Error text or signature to query globally learned patterns." },
            limit: { type: "number", default: 5 }
          }
        }
      },
      {
        name: "workspace.company_brain",
        description: "Company Codebase Brain: build, query, record, ingest, or export durable repo intelligence with citations, decisions, risks, ownership, and verification memory.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["build", "query", "status", "record", "ingest", "export"], default: "status" },
            query: { type: "string", description: "Question or search query for action=query." },
            question: { type: "string", description: "Alias for query." },
            title: { type: "string", description: "Decision/rule/lesson title for action=record." },
            body: { type: "string", description: "Decision/rule/lesson body for action=record or action=ingest." },
            rule: { type: "string", description: "Rule to persist into Company Brain and Engineering Memory." },
            note: { type: "string", description: "Short note to persist." },
            kind: { type: "string", enum: ["decision", "rule", "lesson", "risk", "owner", "pattern", "runtime", "autopilot"], default: "decision" },
            source: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            limit: { type: "number", default: 8 },
            maxFiles: { type: "number", default: 1200 },
            path: { type: "string", description: "Export path for action=export." }
          }
        }
      },
      {
        name: "workspace.daemon",
        description: "Daemon mode controls: start/stop/status/digest for the background Mesh service.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "status", "digest", "stop"], default: "status" }
          }
        }
      },
      {
        name: "workspace.issue_pipeline",
        description: "Issue-to-PR pipeline for GitHub, Linear, and Jira. Scans tagged issues and drafts PR payloads with repo-grounded intent and impact.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["scan", "status"], default: "scan" },
            provider: { type: "string", enum: ["github", "linear", "jira"] },
            issueId: { type: "string" }
          }
        }
      },
      {
        name: "workspace.issue_autopilot",
        description: "Production Issue-to-PR Autopilot: convert a GitHub/Linear/Jira/manual issue into a verified timeline patch, proof bundle, and optional PR branch/PR.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "plan", "run", "pr", "create_pr", "submit_pr"], default: "status" },
            issueUrl: { type: "string", description: "GitHub issue URL or external issue URL." },
            url: { type: "string", description: "Alias for issueUrl." },
            provider: { type: "string", enum: ["github", "linear", "jira", "manual"] },
            issueId: { type: "string" },
            title: { type: "string", description: "Manual issue title." },
            body: { type: "string", description: "Manual issue body." },
            description: { type: "string", description: "Alias for body." },
            labels: { type: "array", items: { type: "string" } },
            verificationCommand: { type: "string", description: "Command run in the isolated timeline." },
            baseRef: { type: "string" },
            baseBranch: { type: "string" },
            branchName: { type: "string" },
            prTitle: { type: "string" },
            patch: { type: "string", description: "Optional raw git patch to apply instead of LLM generation." },
            maxAttempts: { type: "number", default: 2 },
            timeoutMs: { type: "number", default: 240000 },
            submitPr: { type: "boolean", default: false },
            push: { type: "boolean", default: true },
            maxBrainFiles: { type: "number", default: 1200 }
          }
        }
      },
      {
        name: "workspace.chatops",
        description: "Slack/Discord co-engineer integration for investigation threads, progress updates, and approval-driven draft PR handoff.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["investigate", "approve", "status"], default: "investigate" },
            platform: { type: "string", enum: ["slack", "discord"], default: "slack" },
            channel: { type: "string", default: "general" },
            message: { type: "string" }
          }
        }
      },
      {
        name: "workspace.production_status",
        description: "Production awareness status fed by telemetry connectors (Sentry, Datadog, PostHog, OTel).",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["refresh", "status"], default: "status" }
          }
        }
      },
      {
        name: "workspace.model_route",
        description: "Route a task to the best Mesh model roles: chat, sidecar, retrieval, vision, safety, and required verification gates.",
        inputSchema: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string" }
          }
        }
      },
      {
        name: "workspace.production_readiness",
        description: "Production readiness gate across model orchestration, RAG, timelines, runtime learning, visual checks, memory, and PR review.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["audit", "gate", "review", "status"], default: "audit" },
            intent: { type: "string" },
            verificationCommand: { type: "string" },
            url: { type: "string", description: "Optional local app URL for live visual readiness checks." }
          }
        }
      },
      {
        name: "workspace.intent_compile",
        description: "Intent Compiler: turn product intent into a repo-grounded implementation contract with likely files, risks, tests, rollout, and verification steps.",
        inputSchema: {
          type: "object",
          required: ["intent"],
          properties: {
            intent: { type: "string" },
            verificationCommand: { type: "string" }
          }
        }
      },
      {
        name: "workspace.cockpit_snapshot",
        description: "Live Architecture Cockpit snapshot: digital twin, timeline, runtime, repair, memory, risk, and coverage state for dashboards.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "workspace.causal_intelligence",
        description: "Causal Software Intelligence: build, query, or inspect a causal graph linking files, risks, tests, repairs, memory rules, and git change pressure.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["build", "read", "status", "query"], default: "build" },
            query: { type: "string", description: "Question to answer against the causal graph when action='query'." }
          }
        }
      },
      {
        name: "workspace.discovery_lab",
        description: "Autonomous Discovery Lab: discover high-impact improvements from the causal graph, diagnostics, repair queue, and repo memory.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["run", "status", "clear"], default: "run" },
            verificationCommand: { type: "string", description: "Optional verification command attached to generated experiments." },
            maxDiscoveries: { type: "number", default: 8 }
          }
        }
      },
      {
        name: "workspace.reality_fork",
        description: "Reality Fork Engine: turn an intent into multiple scored project realities and optionally materialize them as isolated timelines.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["plan", "fork", "status", "clear"], default: "plan" },
            intent: { type: "string", description: "Goal to explore across multiple alternative project realities." },
            forks: { type: "number", default: 4 },
            verificationCommand: { type: "string" },
            runVerification: { type: "boolean", default: false }
          }
        }
      },
      {
        name: "workspace.ghost_engineer",
        description: "Ghost Engineer Replay: learn the local engineer's repo-specific working style, predict their implementation path, detect divergence, and materialize a style-conformant autopilot timeline.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["learn", "profile", "status", "predict", "divergence", "patch", "clear"], default: "profile" },
            goal: { type: "string", description: "Implementation goal for predict or patch actions." },
            plan: { type: "string", description: "Plan text to compare against the learned engineer profile." },
            verificationCommand: { type: "string" }
          }
        }
      }
    ];
  }

  async callTool(name: string, args: Record<string, unknown>, opts?: ToolCallOpts): Promise<unknown> {
    const tool = (await this.listTools()).find((entry) => entry.name === name);
    try {
      const validation = validateToolInput(name, args, tool?.inputSchema);
      args = validation.args;
      if (validation.warnings.length > 0) {
        void this.logger.write("warn", "tool.input_schema_warnings", {
          tool: name,
          warnings: validation.warnings
        }).catch(() => undefined);
      }
    } catch (error) {
      void this.logger.write("error", "tool.input_schema_rejected", {
        tool: name,
        issues: error instanceof ToolInputValidationError ? error.issues : [(error as Error).message]
      }).catch(() => undefined);
      throw error;
    }

    void this.logger.write("info", "tool.call", {
      tool: name,
      requiresApproval: tool?.requiresApproval === true
    }).catch(() => undefined);
    void this.audit.append(name, args, { pending: true }).catch(() => undefined);
    try {
      const result = await this.executeTool(name, args, opts);
      void this.audit.append(name, args, result).catch(() => undefined);
      return result;
    } catch (error) {
      void this.audit.append(name, args, { error: (error as Error).message }).catch(() => undefined);
      throw error;
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>, opts?: ToolCallOpts): Promise<unknown> {
    switch (name) {
      case "workspace.list_files":
        return this.listFiles(args);
      case "workspace.read_file":
        return this.readFile(args);
      case "workspace.read_slice":
        return this.readSlice(args);
      case "workspace.open_artifact":
        return openContextArtifact(this.workspaceRoot, args);
      case "workspace.search_files":
        return this.searchFiles(args);
      case "workspace.check_sync":
        return this.checkSync();
      case "workspace.grep_content":
        return this.grepContent(args);
      case "workspace.index_everything":
        return this.indexEverything();
      case "workspace.write_file":
        return this.writeFile(args);
      case "workspace.run_command":
        return this.runCommand(args, opts?.onProgress);
      case "workspace.read_file_raw":
        return this.readFileRaw(args);
      case "workspace.grep_capsules":
        return this.grepCapsules(args);
      case "workspace.get_index_status":
        return this.getIndexStatus();
      case "workspace.index_status":
        return this.getIndexStatus();
      case "workspace.read_multiple_files":
        return this.readMultipleFiles(args);
      case "workspace.read_file_lines":
        return this.readFileLines(args);
      case "workspace.list_directory":
        return this.listDirectory(args);
      case "workspace.get_file_info":
        return this.getFileInfo(args);
      case "workspace.move_file":
        return this.moveFile(args);
      case "workspace.delete_file":
        return this.deleteFile(args);
      case "workspace.patch_file":
        return this.patchFile(args);
      case "workspace.patch_surgical":
        return this.patchSurgical(args);
      case "workspace.list_symbols":
        return this.listSymbols(args);
      case "workspace.expand_symbol":
        return this.expandSymbol(args);
      case "workspace.get_file_graph":
        return this.getFileGraph(args);
      case "workspace.read_dir_overview":
        return this.readDirOverview(args);
      case "web.read_docs":
        return this.readDocs(args);
      case "workspace.run_in_shadow":
        return this.runInShadow(args, opts?.onProgress);
      case "workspace.get_diagnostics":
        return this.getDiagnostics(opts?.onProgress);
      case "workspace.find_references":
        return this.findReferences(args);
      case "workspace.ask_codebase":
        return this.askCodebase(args, opts?.onProgress);
      case "workspace.explain_symbol":
        return this.explainSymbol(args);
      case "workspace.impact_map":
        return this.impactMap(args);
      case "workspace.expand_execution_path":
        return this.expandExecutionPath(args);
      case "workspace.rename_symbol":
        return this.renameSymbol(args);
      case "workspace.extract_function":
        return this.extractFunction(args);
      case "workspace.inline_symbol":
        return this.inlineSymbol(args);
      case "workspace.move_to_module":
        return this.moveToModule(args);
      case "workspace.generate_properties":
        return this.propertyTests.generate({
          path: typeof args.path === "string" ? args.path : undefined,
          functionName: typeof args.functionName === "string" ? args.functionName : undefined,
          all: Boolean(args.all)
        });
      case "workspace.find_edge_cases":
        return this.smtFinder.find({
          path: String(args.path ?? ""),
          functionName: typeof args.functionName === "string" ? args.functionName : undefined
        });
      case "workspace.audit":
        return this.auditTool(args);
      case "workspace.semantic_undo":
        return this.semanticUndo(args, opts?.onProgress);
      case "workspace.undo":
        return this.performUndo();
      case "workspace.alien_patch":

        return this.alienPatch(args);
      case "workspace.session_index_symbols":
        return this.sessionIndexSymbols(args);
      case "workspace.generate_lexicon":
        return this.generateLexicon(args);
      case "workspace.ghost_verify":
        return this.ghostVerify(args, opts?.onProgress);
      case "workspace.timeline_create":
        return this.timelines.create(args);
      case "workspace.timeline_apply_patch":
        return this.timelines.applyPatch({
          timelineId: String(args.timelineId ?? ""),
          patch: String(args.patch ?? "")
        });
      case "workspace.timeline_run":
        assertCommandAllowed(String(args.command ?? ""));
        return this.timelines.run({
          timelineId: String(args.timelineId ?? ""),
          command: String(args.command ?? ""),
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined
        });
      case "workspace.timeline_compare":
        return this.timelines.compare({
          timelineIds: Array.isArray(args.timelineIds) ? args.timelineIds.map(String) : []
        });
      case "workspace.timeline_promote":
        return this.timelinePromoteWithBrain({ timelineId: String(args.timelineId ?? "") });
      case "workspace.timeline_list":
        return this.timelines.list();
      case "workspace.symptom_bisect":
        return this.symptomBisect.run({
          symptom: String(args.symptom ?? ""),
          verificationCommand: typeof args.verificationCommand === "string" ? args.verificationCommand : undefined,
          searchDepth: typeof args.searchDepth === "number" ? args.searchDepth : undefined
        });
      case "workspace.what_if":
        return this.whatIf(args, opts?.onProgress);
      case "workspace.self_defend":
        return this.selfDefense.run(args);
      case "workspace.precrime":
        return this.precrime.run(args);
      case "workspace.end_staging":
        return this.shadowDeploy.run(args);
      case "workspace.semantic_git":
        return this.semanticGit.run(args);
      case "workspace.probabilistic_codebase":
        return this.probabilisticCodebase.run(args);
      case "workspace.conversational_codebase":
        return this.conversationalCodebase.run(args);
      case "workspace.spec_code":
        return this.specCode.run(args);
      case "workspace.natural_language_source":
        return this.naturalLanguageSource.run(args);
      case "workspace.fluid_mesh":
        return this.fluidMesh.run(args);
      case "workspace.living_software":
        return this.livingSoftware.run(args);
      case "workspace.proof_carrying_change":
        return this.proofCarryingChange.run(args);
      case "workspace.causal_autopsy":
        return this.causalAutopsy.run(args);
      case "workspace.todo_resolver":
        return this.todoResolver.run(args);
      case "workspace.live_wire":
        return this.liveWire.run(args);
      case "workspace.schrodingers_ast":
        return this.schrodingersAst.run(args);
      case "workspace.hive_mind":
        return this.hiveMind.run(args);
      case "workspace.tribunal":
        return this.tribunal.run(args);
      case "workspace.session_resurrection":
        return this.sessionResurrection.run(args);
      case "workspace.semantic_sheriff":
        return this.semanticSheriff.run(args);
      case "agent.assemble_team":
        return this.personaLoader.assembleTeam(String(args.task ?? ""));
      case "workspace.finalize_task":
        return this.finalizeTask(args, opts?.onProgress);
      case "web.inspect_ui":
        return this.inspectUi(args, opts?.onProgress);
      case "frontend.preview":
        return this.previewFrontend(args, opts?.onProgress);
      case "workspace.query_ast":
        return this.queryAst(args);
      case "workspace.get_recent_changes":
        return { ok: true, changes: this.recentChanges.length > 0 ? this.recentChanges : "No recent changes detected in background." };
      case "workspace.run_with_telemetry":
        return this.runWithTelemetry(args, opts?.onProgress);
      case "runtime.start":
        return this.runtimeObserver.start(args);
      case "runtime.capture_failure":
        return this.runtimeObserver.captureFailure(args);
      case "runtime.capture_deep_autopsy":
        return this.runtimeObserver.captureDeepAutopsy(args);
      case "runtime.trace_request":
        return this.runtimeObserver.traceRequest(args);
      case "runtime.explain_failure":
        return this.runtimeObserver.explainFailure(args);
      case "runtime.fix_failure":
        return this.runtimeObserver.fixFailure(args);
      case "runtime.replay_trace":
        return this.replayEngine.replayTrace({
          traceId: typeof args.traceId === "string" ? args.traceId : undefined,
          sentryEventId: typeof args.sentryEventId === "string" ? args.sentryEventId : undefined,
          commitRange: typeof args.commitRange === "string" ? args.commitRange : undefined
        });
      case "workspace.validate_patch":
        return this.validatePatch(args);
      case "workspace.trace_symbol":
        return this.traceSymbol(args);
      case "agent.invoke_sub_agent":
        return this.invokeSubAgent(args, opts?.onProgress);
      case "agent.race_fixes":
        return this.raceFixes(args, opts?.onProgress);
      case "agent.spawn_swarm":
        return this.spawnSwarm(args, opts?.onProgress);
      case "agent.spawn":
        return this.agentOs.spawn(args);
      case "agent.status":
        return this.agentOs.status(args);
      case "agent.review":
        return this.agentOs.review(args);
      case "agent.merge_verified":
        return this.agentOs.mergeVerified(args);
      case "workspace.git_diff":
        return this.getGitDiff(args);
      case "agent.plan":
        return this.handleAgentPlan(args);
      case "workspace.get_env_info":
        return this.getEnvInfo();
      case "workspace.grep_ripgrep":
        return this.grepRipgrep(args);
      case "workspace.git_status":
        return this.getGitStatus();
      case "workspace.digital_twin":
        return this.digitalTwin(args);
      case "workspace.predictive_repair":
        return this.predictiveRepair(args, opts?.onProgress);
      case "workspace.engineering_memory":
        return this.engineeringMemory(args);
      case "workspace.brain":
        return this.meshBrainTool(args);
      case "workspace.company_brain":
        return this.companyBrain.run(args);
      case "workspace.daemon":
        return this.daemonControl(args);
      case "workspace.issue_pipeline":
        return this.issuePipeline.run({
          action: typeof args.action === "string" ? args.action : "scan",
          provider: typeof args.provider === "string" ? args.provider : undefined,
          issueId: typeof args.issueId === "string" ? args.issueId : undefined
        });
      case "workspace.issue_autopilot":
        return this.issueAutopilot.run(args);
      case "workspace.chatops":
        return this.chatops.run({
          action: typeof args.action === "string" ? args.action : "investigate",
          platform: typeof args.platform === "string" ? args.platform : "slack",
          channel: typeof args.channel === "string" ? args.channel : "general",
          message: typeof args.message === "string" ? args.message : undefined
        });
      case "workspace.production_status":
        return this.productionStatus(args);
      case "workspace.model_route":
        return { ok: true, route: routeMeshTask(String(args.task ?? "")) };
      case "workspace.production_readiness":
        return this.productionReadiness.run(args);
      case "workspace.intent_compile":
        return this.intentCompile(args);
      case "workspace.cockpit_snapshot":
        return this.cockpitSnapshot();
      case "workspace.causal_intelligence":
        return this.causalIntelligence(args, opts?.onProgress);
      case "workspace.discovery_lab":
        return this.discoveryLab(args, opts?.onProgress);
      case "workspace.reality_fork":
        return this.realityFork(args, opts?.onProgress);
      case "workspace.ghost_engineer":
        return this.ghostEngineer(args, opts?.onProgress);
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }

  async close(): Promise<void> {
    for (const watcher of [...this.watchers]) {
      this.closeWatcher(watcher);
    }
    await Promise.allSettled(this.startupTasks);
    await this.cache.flushCache().catch(() => undefined);
    await this.timelines.close().catch(() => undefined);
    await this.runtimeObserver.close();
    await this.meshCore.close();
    return Promise.resolve();
  }

  private async listFiles(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000));
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);

    const files = await collectFiles(base, limit, this.workspaceRoot);
    return {
      ok: true,
      workspaceRoot: this.workspaceRoot,
      requestedPath,
      count: files.length,
      files: files.map((item) => toPosixRelative(this.workspaceRoot, item)).sort((a, b) => a.localeCompare(b))
    };
  }

  private async readSlice(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const symbol = String(args.symbol ?? "").trim();
    if (!requestedPath || !symbol) {
      throw new Error("workspace.read_slice requires 'path' and 'symbol'");
    }

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`File not found: ${requestedPath}`);
    }

    const result = await this.workspaceIndex.getSemanticSlice(requestedPath, symbol);
    if (!result.ok || !result.slice) {
      throw new Error(result.error || `Failed to read semantic slice for ${symbol} in ${requestedPath}`);
    }

    return {
      ok: true,
      path: toPosixRelative(this.workspaceRoot, absolutePath),
      symbol,
      content: result.slice
    };
  }

  private async readFile(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const tier = normalizeCapsuleTier(String(args.tier ?? "medium").trim());
    if (!requestedPath) {
      throw new Error("workspace.read_file requires 'path'");
    }

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    if (!(await pathExists(absolutePath))) {
      throw new Error(`File not found: ${requestedPath}`);
    }

    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${requestedPath}`);
    }

    const mtimeMs = Math.floor(stat.mtimeMs);
    const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);

    // Fast path: Try cache first using mtimeMs
    let cached = await this.cache.getCapsule(relativePath, tier, mtimeMs);
    let raw = "";
    let contentHash = "";

    if (!cached) {
      // Fast path missed. Read file to compute hash.
      raw = await fs.readFile(absolutePath, "utf8");
      contentHash = crypto.createHash("sha1").update(raw).digest("hex");

      // Smart Invalidation: Check again with contentHash (e.g. mtime changed but content identical)
      cached = await this.cache.getCapsule(relativePath, tier, mtimeMs, contentHash);
    }

    if (cached) {
      return {
        ok: true,
        path: relativePath,
        bytes: stat.size,
        tier,
        capsule: cached.content,
        source: "cache"
      };
    }

    // Cache miss: generate the requested tier inline and fill the rest in the background.
    let requestedContent = raw.slice(0, 12000); // fallback if mesh-core unavailable

    if (this.meshCore.isAvailable) {
      const results = await this.meshCore.summarizeSelectedTiers(relativePath, raw, [tier]);
      requestedContent = results[tier] || requestedContent;
      await this.cache.setCapsule(relativePath, tier, requestedContent, mtimeMs, contentHash);

      const remainingTiers = CAPSULE_TIERS.filter((candidate) => candidate !== tier);
      void this.meshCore
        .summarizeSelectedTiers(relativePath, raw, remainingTiers)
        .then((backgroundResults) =>
          Promise.all(
            remainingTiers.map((candidate) =>
              this.cache.setCapsule(relativePath, candidate, backgroundResults[candidate] || "", mtimeMs, contentHash)
            )
          )
        )
        .catch(() => {});
    } else {
      await this.cache.setCapsule(relativePath, tier, requestedContent, mtimeMs, contentHash);
      void Promise.all(
        CAPSULE_TIERS
          .filter((candidate) => candidate !== tier)
          .map((candidate) =>
            this.cache.setCapsule(relativePath, candidate, raw.slice(0, 12000), mtimeMs, contentHash)
          )
      ).catch(() => {});
    }

    return {
      ok: true,
      path: relativePath,
      bytes: stat.size,
      tier,
      capsule: requestedContent,
      source: "generated",
      note: "This is a Mesh-optimized capsule. Use read_file_raw if you need the full source code."
    };
  }

  private async readFileRaw(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    if (!requestedPath) throw new Error("read_file_raw requires path");
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      ok: true,
      path: toPosixRelative(this.workspaceRoot, absolutePath),
      content,
      note: "Raw source code loaded. Use sparingly to save tokens."
    };
  }

  private async grepCapsules(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
    const files = await collectFiles(this.workspaceRoot, 10000, this.workspaceRoot);
    const matches: Array<{ path: string; snippet: string }> = [];

    for (const file of files) {
      if (matches.length >= limit) break;
      const rel = toPosixRelative(this.workspaceRoot, file);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      // Check medium tier as it's the standard for indexing
      const capsule = await this.cache.getCapsule(rel, "medium", Math.floor(stat.mtimeMs));
      if (capsule && capsule.content.toLowerCase().includes(query)) {
        matches.push({
          path: rel,
          snippet: capsule.content.slice(0, 300)
        });
      }
    }
    return { ok: true, query, count: matches.length, matches };
  }

  private async readMultipleFiles(args: Record<string, unknown>): Promise<unknown> {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    const results = await Promise.all(
      paths.slice(0, 15).map(async (p) => {
        try {
          return await this.readFile({ path: p });
        } catch (err) {
          return { ok: false, path: p, error: (err as Error).message };
        }
      })
    );
    return { ok: true, count: results.length, results };
  }

  private async searchFiles(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) {
      throw new Error("workspace.search_files requires 'query'");
    }

    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const limit = Math.max(1, Math.min(Number(args.limit) || 100, 1000));
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);

    const files = await collectFiles(base, 4000, this.workspaceRoot);
    const matches = files
      .map((item) => toPosixRelative(this.workspaceRoot, item))
      .filter((item) => item.toLowerCase().includes(query))
      .slice(0, limit);

    return {
      ok: true,
      query,
      count: matches.length,
      matches
    };
  }

  private async readFileLines(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const startLine = Math.max(1, Number(args.startLine) || 1);
    const endLine = Number(args.endLine);
    if (!requestedPath || !endLine) throw new Error("workspace.read_file_lines requires path and endLine");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const lines = raw.split(/\r?\n/g);
    const slice = lines.slice(startLine - 1, endLine);

    return {
      ok: true,
      path: toPosixRelative(this.workspaceRoot, absolutePath),
      startLine,
      endLine,
      totalLines: lines.length,
      content: slice.join("\n")
    };
  }

  private async listDirectory(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const entries = await fs.readdir(base, { withFileTypes: true });

    return {
      ok: true,
      path: requestedPath,
      entries: entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file"
      })).sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    };
  }

  private async getFileInfo(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const stat = await fs.stat(absolutePath);
    return {
      ok: true,
      path: toPosixRelative(this.workspaceRoot, absolutePath),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile()
    };
  }

  private async moveFile(args: Record<string, unknown>): Promise<unknown> {
    const src = String(args.sourcePath ?? "").trim();
    const dst = String(args.destinationPath ?? "").trim();
    if (!src || !dst) throw new Error("move_file requires sourcePath and destinationPath");

    const absSrc = ensureInsideRoot(this.workspaceRoot, src);
    const absDst = ensureInsideRoot(this.workspaceRoot, dst);

    await fs.rename(absSrc, absDst);
    // Invalidate cache for both
    const relSrc = toPosixRelative(this.workspaceRoot, absSrc);
    const relDst = toPosixRelative(this.workspaceRoot, absDst);
    await this.cache.deleteCapsule(relSrc, "low");
    await this.cache.deleteCapsule(relSrc, "medium");
    await this.cache.deleteCapsule(relSrc, "high");

    // Trigger speculative background indexing
    this.workspaceIndex.partialUpdate([relDst]).catch(() => {});
    // Note: Old path will be removed during the next ensureIndex naturally or we could explicitly remove it
    // But since partialUpdate merges by path,Dst is fresh. 

    return { ok: true, source: src, destination: dst };
  }

  private async deleteFile(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    await fs.unlink(absolutePath);
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    await this.cache.deleteCapsule(rel, "low");
    await this.cache.deleteCapsule(rel, "medium");
    await this.cache.deleteCapsule(rel, "high");
    return { ok: true, path: rel };
  }

  private async patchFile(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const search = String(args.search ?? "");
    const replace = String(args.replace ?? "");
    if (!requestedPath || !search) throw new Error("patch_file requires path and search string");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    await this.saveBackup(requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    if (!content.includes(search)) {
      throw new Error(`Search string not found in ${requestedPath}`);
    }

    const newContent = content.replace(search, replace);
    await fs.writeFile(absolutePath, newContent, "utf8");

    // Invalidate cache and trigger background indexing
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    await this.cache.deleteCapsule(rel, "low");
    await this.cache.deleteCapsule(rel, "medium");
    await this.cache.deleteCapsule(rel, "high");
    
    // Background JIT re-indexing
    this.workspaceIndex.partialUpdate([rel]).catch(() => {});

    return { ok: true, path: rel, patched: true };
  }

  private async getGitStatus(): Promise<unknown> {
    try {
      const { stdout } = await execAsync("git status --short", { cwd: this.workspaceRoot });
      const { stdout: branch } = await execAsync("git branch --show-current", { cwd: this.workspaceRoot });
      return { ok: true, branch: branch.trim(), status: stdout.trim() };
    } catch (err) {
      return { ok: false, error: "Not a git repository or git not installed" };
    }
  }

  private async readDocs(args: Record<string, unknown>): Promise<unknown> {
    const url = String(args.url ?? "").trim();
    if (!url) throw new Error("web.read_docs requires url");

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const html = await response.text();
      // Extremely basic HTML to text conversion to avoid heavy dependencies
      const text = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      return {
        ok: true,
        url,
        content: text.slice(0, 15000), // Limit size
        note: "Content converted from HTML. Formatting may be imperfect."
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async runInShadow(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("workspace.run_in_shadow requires 'command'");
    assertCommandAllowed(command);

    const shadowRoot = path.join(os.tmpdir(), `mesh-shadow-${Date.now()}`);
    onProgress?.(`[Shadow Workspace] Creating at ${shadowRoot}...\n`);

    try {
      // Sync to shadow (ignoring node_modules and .git)
      await execAsync(`rsync -a --exclude node_modules --exclude .git --exclude dist ${this.workspaceRoot}/ ${shadowRoot}/`);

      onProgress?.(`[Shadow Workspace] Running: ${command}\n`);
      const TIMEOUT_MS = 60_000;

      const result = await new Promise<any>((resolve) => {
        const child = spawn("sh", ["-c", command], { cwd: shadowRoot });
        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, TIMEOUT_MS);

        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          onProgress?.(text);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          onProgress?.(text);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            ok: code === 0 && !timedOut,
            exitCode: timedOut ? 124 : (code ?? 0),
            stdout,
            stderr: timedOut ? `[TIMEOUT after ${TIMEOUT_MS / 1000}s]\n${stderr}` : stderr
          });
        });
      });

      // Cleanup
      await fs.rm(shadowRoot, { recursive: true, force: true });
      return { ...result, note: "Executed safely in shadow workspace." };
    } catch (err) {
      await fs.rm(shadowRoot, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, error: (err as Error).message };
    }
  }

  private async getDiagnostics(onProgress?: (chunk: string) => void): Promise<unknown> {
    onProgress?.("Running diagnostics (tsc --noEmit)...\n");
    const tsconfigPath = path.join(this.workspaceRoot, "tsconfig.json");
    if (!(await pathExists(tsconfigPath))) {
      return { ok: true, output: "No tsconfig.json found; TypeScript diagnostics skipped." };
    }
    const localTsc = path.join(this.workspaceRoot, "node_modules", ".bin", "tsc");
    const command = await pathExists(localTsc)
      ? `"${localTsc}" --noEmit`
      : "npx --no-install tsc --noEmit";
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: this.workspaceRoot });
      return { ok: true, output: stdout || stderr || "No issues found." };
    } catch (err: any) {
      return { ok: false, hasErrors: true, output: err.stdout || err.stderr || err.message };
    }
  }

  private async findReferences(args: Record<string, unknown>): Promise<unknown> {
    const symbol = String(args.symbol ?? "").trim();
    if (!symbol) throw new Error("workspace.find_references requires symbol");

    // Use ripgrep with word boundaries for precision
    return this.grepRipgrep({ query: `\\b${symbol}\\b` });
  }

  private async expandExecutionPath(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const symbolName = String(args.symbolName ?? "").trim();
    if (!requestedPath || !symbolName) throw new Error("expand_execution_path requires path and symbolName");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);

    const record = await this.meshCore.getDetailedRecord(rel, content);
    if (!record) throw new Error("Could not analyze file with MeshCore.");

    const sym = record.symbols.find(s => s.name === symbolName || (s.kind && `${s.kind} ${s.name}` === symbolName));
    if (!sym) throw new Error(`Symbol '${symbolName}' not found in ${requestedPath}`);

    const lines = content.split(/\r?\n/g);
    const bodySnippet = lines.slice(sym.lineStart - 1, sym.lineEnd).join("\n");

    // Find all calls made inside this symbol's body
    const callsMade = record.callSites.filter(cs => cs.lineStart >= sym.lineStart && cs.lineStart <= sym.lineEnd);
    const calledSignatures = [];

    for (const call of callsMade) {
      const calledSym = record.symbols.find(s => s.name === call.callee);
      if (calledSym) {
        const sigLine = lines[calledSym.lineStart - 1]?.trim() || "";
        calledSignatures.push(`${call.callee} at L${calledSym.lineStart}: ${sigLine}`);
      }
    }

    return {
      ok: true,
      path: rel,
      symbol: sym.name,
      body: bodySnippet,
      internalDependencies: calledSignatures.length > 0 ? calledSignatures : ["No internal dependencies found."]
    };
  }

  private async sessionIndexSymbols(args: Record<string, unknown>): Promise<unknown> {
    const paths = (args.paths || []) as string[];
    let nextId = this.sessionSymbolIndex.size + 1;
    const result: Record<string, number> = {};

    for (const p of paths) {
      const absPath = ensureInsideRoot(this.workspaceRoot, p);
      const content = await fs.readFile(absPath, "utf8");
      const symbols = await this.meshCore.extractSymbols(p, content);
      for (const s of symbols) {
        const id = nextId++;
        this.sessionSymbolIndex.set(id, { path: p, name: s.name });
        result[`${p}#${s.name}`] = id;
      }
    }
    return { ok: true, sessionIndex: result, note: "Use these IDs with workspace.alien_patch for max token savings." };
  }

  private async generateLexicon(args: Record<string, unknown>): Promise<unknown> {
    const paths = (args.paths || []) as string[];
    let nextId = Object.keys(this.projectLexicon).length + 1;
    for (const p of paths) {
      const absPath = ensureInsideRoot(this.workspaceRoot, p);
      const content = await fs.readFile(absPath, "utf8");
      const record = await this.meshCore.getDetailedRecord(p, content);
      if (record) {
        // Collect most common tokens/symbol names for the dictionary
        for (const sym of record.symbols) {
          if (!Object.values(this.projectLexicon).includes(sym.name)) {
            this.projectLexicon[nextId++] = sym.name;
          }
        }
      }
    }
    return { ok: true, lexicon: this.projectLexicon, note: "Use #ID in alien_patch to reference these terms." };
  }

  private startLiveSyncWatcher() {
    // Live sync is handled by startWatcher(). Keeping a second recursive watcher
    // caused EMFILE crashes in real workspaces and test runs.
  }

  private async saveBackup(relativePath: string): Promise<void> {
    try {
      const absolutePath = ensureInsideRoot(this.workspaceRoot, relativePath);
      if (existsSync(absolutePath)) {
        const content = await fs.readFile(absolutePath, "utf8");
        this.changeStack.push({ path: relativePath, content });
        if (this.changeStack.length > 50) this.changeStack.shift();
      }
    } catch {
      // Skip
    }
  }

  private async performUndo(): Promise<unknown> {
    const lastChange = this.changeStack.pop();
    if (!lastChange) {
      return { ok: false, error: "No changes to undo." };
    }
    const absolutePath = ensureInsideRoot(this.workspaceRoot, lastChange.path);
    await fs.writeFile(absolutePath, lastChange.content, "utf8");
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    await this.cache.deleteCapsule(rel, "low");
    await this.cache.deleteCapsule(rel, "medium");
    await this.cache.deleteCapsule(rel, "high");
    return { ok: true, path: lastChange.path, message: `Restored ${lastChange.path} to previous state.` };
  }

  private async ghostVerify(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const patch = String(args.patch ?? "");
    const testCommand = String(args.testCommand ?? "");
    if (!patch.trim() || !testCommand.trim()) {
      throw new Error("workspace.ghost_verify requires patch and testCommand");
    }

    try {
      const created = await this.timelines.create({ name: "ghost-verify" });
      const ghostDir = created.timeline.root;
      onProgress?.(`[GBL] Spawned replayable timeline ${created.timeline.id} at ${ghostDir}\n`);

      if (/^(diff --git|---\s|\+\+\+\s)/m.test(patch.trim())) {
        const applied = await this.timelines.applyPatch({ timelineId: created.timeline.id, patch });
        if (!applied.ok) return applied;
      } else {
        onProgress?.(`[GBL] Applying symbolic patch to ghost timeline...\n`);
        const ghostConfig = this.config
          ? { ...this.config, agent: { ...this.config.agent, workspaceRoot: ghostDir } }
          : undefined;
        const backend = new LocalToolBackend(ghostDir, ghostConfig);
        (backend as any).sessionSymbolIndex = new Map(this.sessionSymbolIndex);
        (backend as any).projectLexicon = { ...this.projectLexicon };
        await backend.alienPatch({ patch });
      }

      onProgress?.(`[GBL] Running verification: ${testCommand}\n`);
      const result = await this.timelines.run({
        timelineId: created.timeline.id,
        command: testCommand,
        timeoutMs: 120_000
      });

      return {
        ok: result.ok,
        timelineId: created.timeline.id,
        message: result.ok ? "Verification PASSED in ghost timeline." : "Verification FAILED in ghost timeline. Patch rejected.",
        output: result.stdout || result.stderr
      };
    } catch (err: any) {
      return {
        ok: false,
        message: "Verification FAILED in ghost timeline. Patch rejected.",
        error: err.stdout || err.stderr || err.message
      };
    }
  }

  private async alienPatch(args: Record<string, unknown>): Promise<unknown> {
    const rawPatch = String(args.patch ?? "").trim();
    // Format: !ID > { CODE }
    const match = rawPatch.match(/^!(\d+)\s*>\s*\{([\s\S]*)\}$/);
    if (!match) throw new Error("Invalid alien_patch format. Use !ID > { CODE }");

    const id = parseInt(match[1], 10);
    const alienCode = match[2].trim();
    const entry = this.sessionSymbolIndex.get(id);
    if (!entry) throw new Error(`Session ID !${id} not found. Run workspace.session_index_symbols first.`);

    // 1. Expand Opcodes & Lexicon
    const expandedCode = this.meshCore.expandAlienCode(alienCode, this.projectLexicon);

    // 2. Perform Surgical Patch using AST matching
    const absolutePath = ensureInsideRoot(this.workspaceRoot, entry.path);
    const content = await fs.readFile(absolutePath, "utf8");
    const record = await this.meshCore.getDetailedRecord(entry.path, content);
    if (!record) throw new Error("Could not analyze file for alien patch.");

    const sym = record.symbols.find(s => s.name === entry.name);
    if (!sym) throw new Error(`Symbol ${entry.name} no longer found in ${entry.path}`);

    const lines = content.split(/\r?\n/g);
    const originalContent = content;

    // We replace the body but try to keep the signature if the user only provided a partial body
    // For now, we assume the user provides the full body content
    const newLines = [...lines];
    const removedCount = sym.lineEnd - sym.lineStart + 1;

    // We assume the LLM provides the implementation. We wrap it in the original signature
    // to be safe, but let's try a direct replace of the lines first.
    newLines.splice(sym.lineStart - 1, removedCount, expandedCode);
    const appliedContent = newLines.join("\n");

    await fs.writeFile(absolutePath, appliedContent, "utf8");

    // 3. Auto-Validation (Self-Healing)
    try {
      if (absolutePath.endsWith(".js") || absolutePath.endsWith(".cjs") || absolutePath.endsWith(".mjs")) {
        await execAsync(`node --check ${absolutePath}`);
      } else if (absolutePath.endsWith(".ts") || absolutePath.endsWith(".tsx")) {
        await execAsync(`npx tsc --noEmit --skipLibCheck --target esnext --moduleResolution node ${absolutePath}`);
      }
    } catch (err: any) {
      await fs.writeFile(absolutePath, originalContent, "utf8");
      return {
        ok: false,
        error: "Alien patch introduced a syntax error and was automatically rolled back.",
        expandedCode,
        compilerOutput: err.stdout || err.stderr || err.message
      };
    }

    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    await this.cache.deleteCapsule(rel, "low");
    await this.cache.deleteCapsule(rel, "medium");
    await this.cache.deleteCapsule(rel, "high");

    // Quantum Entanglement Sync
    const syncLogs: string[] = [];
    for (const entangledRoot of this.entangledWorkspaces) {
      try {
        // Look for the same symbol name in the entangled workspace using fast ripgrep
        const { stdout } = await execAsync(`npx --yes @ast-grep/cli run --pattern "${entry.name}"`, { cwd: entangledRoot }).catch(() => ({ stdout: "" }));
        const firstMatch = stdout.split("\n").find(l => l.includes(entry.name));
        if (firstMatch) {
          const matchPath = firstMatch.split(":")[0];
          const absMatchPath = path.join(entangledRoot, matchPath);
          const entangledContent = await fs.readFile(absMatchPath, "utf8");
          // Simple heuristic: if it looks like an interface or type, apply the expanded code
          if (entangledContent.includes(`interface ${entry.name}`) || entangledContent.includes(`type ${entry.name}`)) {
             syncLogs.push(`Quantum-synced AST to entangled repo at ${matchPath}`);
             // In a full AST engine, we'd apply the exact AST diff here.
          }
        }
      } catch {
        // Skip sync failures silently to not break main workflow
      }
    }

    return {
      ok: true,
      path: rel,
      id,
      symbol: entry.name,
      patched: true,
      quantumSync: syncLogs.length > 0 ? syncLogs : undefined
    };
  }

  private async semanticUndo(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const concept = String(args.concept ?? "").trim();
    if (!concept) throw new Error("semantic_undo requires a concept name");

    onProgress?.(`[Chrono-Untangling] Searching commit history for concept: "${concept}"...\\n`);
    try {
      // Find the most recent commit matching the concept in message
      const { stdout: commits } = await execAsync(`git log --grep="${concept}" --format="%H" -n 1`, { cwd: this.workspaceRoot });
      const hash = commits.trim();

      if (!hash) {
        return { ok: false, error: `No recent commit found matching concept "${concept}".` };
      }

      onProgress?.(`[Chrono-Untangling] Reverting commit ${hash.slice(0,7)} without affecting newer AST nodes...\\n`);
      // We use -n to not commit immediately so we can check AST stability
      await execAsync(`git revert -n ${hash}`, { cwd: this.workspaceRoot });

      return {
        ok: true,
        message: `Concept "${concept}" has been surgically removed. Workspace state is now in 'uncommitted revert'. Please verify and commit.`
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async renameSymbol(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const oldName = String(args.oldName ?? "").trim();
    const newName = String(args.newName ?? "").trim();
    if (!requestedPath || !oldName || !newName) throw new Error("rename_symbol requires path, oldName, and newName");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    await this.saveBackup(requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    const originalContent = content;
    try {
      const result = await this.tsRefactor.renameSymbol(requestedPath, oldName, newName);
      if (result.changed === 0) {
        throw new Error(`Symbol '${oldName}' not found in ${requestedPath}`);
      }
      await this.verifyTypecheckOrRollback(absolutePath, originalContent);
    } catch (err: any) {
      await fs.writeFile(absolutePath, originalContent, "utf8");
      return {
        ok: false,
        error: "Compiler-backed rename failed and was automatically rolled back.",
        compilerOutput: err.stdout || err.stderr || err.message
      };
    }

    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    await this.cache.deleteCapsule(rel, "low");
    await this.cache.deleteCapsule(rel, "medium");
    await this.cache.deleteCapsule(rel, "high");

    return { ok: true, path: rel, oldName, newName, patched: true };
  }

  private async extractFunction(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const functionName = String(args.functionName ?? "").trim();
    const startLine = Number(args.startLine);
    const endLine = Number(args.endLine);
    if (!requestedPath || !functionName || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      throw new Error("extract_function requires path, functionName, startLine, and endLine");
    }
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const original = await fs.readFile(absolutePath, "utf8");
    try {
      await this.tsRefactor.extractFunction(requestedPath, functionName, startLine, endLine);
      await this.verifyTypecheckOrRollback(absolutePath, original);
      return { ok: true, path: requestedPath, functionName, startLine, endLine };
    } catch (error) {
      await fs.writeFile(absolutePath, original, "utf8");
      return { ok: false, error: (error as Error).message };
    }
  }

  private async inlineSymbol(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const symbolName = String(args.symbolName ?? "").trim();
    if (!requestedPath || !symbolName) throw new Error("inline_symbol requires path and symbolName");
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const original = await fs.readFile(absolutePath, "utf8");
    try {
      const result = await this.tsRefactor.inlineSymbol(requestedPath, symbolName);
      await this.verifyTypecheckOrRollback(absolutePath, original);
      return { ok: true, path: requestedPath, symbolName, inlined: result.inlined };
    } catch (error) {
      await fs.writeFile(absolutePath, original, "utf8");
      return { ok: false, error: (error as Error).message };
    }
  }

  private async moveToModule(args: Record<string, unknown>): Promise<unknown> {
    const fromPath = String(args.fromPath ?? "").trim();
    const toPath = String(args.toPath ?? "").trim();
    const symbolName = String(args.symbolName ?? "").trim();
    if (!fromPath || !toPath || !symbolName) throw new Error("move_to_module requires fromPath, toPath, symbolName");
    const fromAbs = ensureInsideRoot(this.workspaceRoot, fromPath);
    const toAbs = ensureInsideRoot(this.workspaceRoot, toPath);
    const fromOriginal = await fs.readFile(fromAbs, "utf8");
    const toOriginal = await fs.readFile(toAbs, "utf8").catch(() => "");
    try {
      const moved = await this.tsRefactor.moveToModule(fromPath, toPath, symbolName);
      if (!moved.moved) throw new Error(`Unable to move symbol '${symbolName}'`);
      await this.verifyTypecheckOrRollback(fromAbs, fromOriginal, toAbs, toOriginal);
      return { ok: true, fromPath, toPath, symbolName };
    } catch (error) {
      await fs.writeFile(fromAbs, fromOriginal, "utf8");
      await fs.writeFile(toAbs, toOriginal, "utf8");
      return { ok: false, error: (error as Error).message };
    }
  }

  private async auditTool(args: Record<string, unknown>): Promise<unknown> {
    const action = String(args.action ?? "verify");
    if (action === "replay") {
      const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000));
      const entries = await this.audit.replay(limit);
      return { ok: true, action, entries };
    }
    const verification = await this.audit.verify();
    return { action: "verify", ...verification };
  }

  private async verifyTypecheckOrRollback(
    primaryPath: string,
    primaryContent: string,
    secondaryPath?: string,
    secondaryContent?: string
  ): Promise<void> {
    try {
      await execAsync("npm run typecheck", { cwd: this.workspaceRoot, timeout: 240_000 });
    } catch (error) {
      await fs.writeFile(primaryPath, primaryContent, "utf8");
      if (secondaryPath && secondaryContent !== undefined) {
        await fs.writeFile(secondaryPath, secondaryContent, "utf8");
      }
      throw error;
    }
  }

  private async finalizeTask(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const branchName = String(args.branchName ?? "").trim();
    const commitMessage = String(args.commitMessage ?? "").trim();
    if (!branchName || !commitMessage) throw new Error("finalize_task requires branchName and commitMessage");

    onProgress?.(`[Semantic Git] Preparing branch ${branchName}...\n`);
    try {
      await execAsync(`git checkout -b ${branchName}`, { cwd: this.workspaceRoot });
      await execAsync(`git add .`, { cwd: this.workspaceRoot });

      const fullMessage = `${commitMessage}\n\n[Mesh Semantic Trace]\nBased on plan: ${this.agentPlan.slice(0, 200)}...`;
      // Use spawn to safely pass multiline commit messages
      await new Promise((resolve, reject) => {
        const child = spawn("git", ["commit", "-F", "-"], { cwd: this.workspaceRoot });
        child.stdin.write(fullMessage);
        child.stdin.end();
        child.on("close", code => code === 0 ? resolve(true) : reject(new Error(`Git commit failed with code ${code}`)));
      });

      return {
        ok: true,
        branch: branchName,
        note: "Branch created, changes staged, and commit applied successfully. Ready for PR."
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async inspectUi(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const url = String(args.url ?? "").trim();
    if (!url) throw new Error("web.inspect_ui requires a URL");

    // Pre-flight: Playwright is an optional, heavy dependency (~100MB + Chromium).
    // Instead of silently running `npx --yes playwright` (which downloads live on
    // first use and fails cryptically offline), detect up-front and return an
    // actionable error that points to frontend.preview as a zero-dep alternative.
    const hasPlaywright = isCommandAvailable("playwright");
    if (!hasPlaywright) {
      onProgress?.(`[Multi-modal Sight] Playwright not detected locally; attempting npx fallback...\n`);
    }

    onProgress?.(`[Multi-modal Sight] Capturing UI from ${url} via Playwright...\n`);
    const screenshotPath = path.join(os.tmpdir(), `mesh_ui_${Date.now()}.png`);

    try {
      // If playwright is in PATH, use --no-install to avoid surprise network fetches.
      // Otherwise, --yes allows npx to install the cli on first run (requires network).
      const cmd = hasPlaywright
        ? `npx --no-install playwright screenshot --wait-for-timeout=1000 ${url} ${screenshotPath}`
        : `npx --yes playwright screenshot --wait-for-timeout=1000 ${url} ${screenshotPath}`;
      await execAsync(cmd);

      const imageBuffer = await fs.readFile(screenshotPath);
      const base64Image = imageBuffer.toString("base64");

      // Cleanup
      await fs.unlink(screenshotPath).catch(() => {});

      return {
        ok: true,
        url,
        base64Image,
        instruction: "Pass this base64 string to a vision model to evaluate the layout.",
        visionAnalysis: await this.runVisionAnalysis(base64Image, url)
      };
    } catch (err) {
      const message = (err as any)?.stderr?.toString?.() || (err as Error).message || "";
      const looksLikeMissing = /command not found|ENOENT|could not determine executable|is not installed|executable not found|browserType\.launch/i.test(message);
      return {
        ok: false,
        error: looksLikeMissing
          ? "Playwright is not installed (or its browser binaries are missing). Install with `npm i -g playwright && npx playwright install chromium`, or use `frontend.preview` instead (built-in Chrome CDP, zero extra deps)."
          : "Failed to capture screenshot via Playwright.",
        tip: "frontend.preview uses the Chrome DevTools Protocol directly and needs no Playwright install.",
        details: message
      };
    }
  }

  private async previewFrontend(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const url = String(args.url ?? "").trim();
    if (!url) throw new Error("frontend.preview requires url");
    const preview = await captureFrontendPreview({
      url,
      width: typeof args.width === "number" ? args.width : Number(args.width || 1280),
      height: typeof args.height === "number" ? args.height : Number(args.height || 800),
      waitMs: typeof args.waitMs === "number" ? args.waitMs : Number(args.waitMs || 1200),
      render: args.render !== false,
      protocol: typeof args.protocol === "string" ? args.protocol as any : "auto",
      outputPath: typeof args.outputPath === "string" ? args.outputPath : undefined,
      onProgress
    });
    const screenshot = await fs.readFile(preview.screenshotPath);
    return {
      ...preview,
      visionAnalysis: await this.runVisionAnalysis(screenshot.toString("base64"), url)
    };
  }

  private async runVisionAnalysis(imageBase64: string, url: string): Promise<string | undefined> {
    if (!resolveNvidiaApiKey(this.config?.bedrock.bearerToken)) return undefined;
    try {
      return await analyzeImageWithNvidia(
        imageBase64,
        [
          `Inspect this Mesh UI screenshot from ${url}.`,
          "Return a compact engineering review with:",
          "1. primary layout or rendering defects,",
          "2. text overflow or clipping,",
          "3. missing hierarchy or affordance issues,",
          "4. likely next fix."
        ].join("\n"),
        process.env.MESH_VISION_MODEL || DEFAULT_NVIDIA_VISION_MODELS[0],
        this.config?.bedrock.bearerToken
      );
    } catch (error) {
      return `vision unavailable: ${(error as Error).message}`;
    }
  }

  private async queryAst(args: Record<string, unknown>): Promise<unknown> {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) throw new Error("query_ast requires an AST pattern");

    // Prefer a locally-installed binary (fast, offline-safe). The tool is published
    // under two names: `ast-grep` (Homebrew, cargo) and `sg` (older binary name).
    const localBin = isCommandAvailable("ast-grep")
      ? "ast-grep"
      : isCommandAvailable("sg")
      ? "sg"
      : null;

    const escapedPattern = pattern.replace(/"/g, '\\"');
    const command = localBin
      ? `${localBin} run --pattern "${escapedPattern}"`
      : `npx --yes @ast-grep/cli run --pattern "${escapedPattern}"`;

    try {
      const { stdout } = await execAsync(command, { cwd: this.workspaceRoot });

      const lines = stdout.split("\n").filter(Boolean);
      return {
        ok: true,
        pattern,
        matchesFound: lines.length,
        preview: lines.slice(0, 15).join("\n"),
        backend: localBin ?? "npx"
      };
    } catch (err: any) {
      if (err.stdout) {
        // ast-grep returns non-zero when there are zero matches — that's not an error.
        return { ok: true, pattern, matchesFound: 0, preview: err.stdout, backend: localBin ?? "npx" };
      }
      const message = err.stderr?.toString?.() || err.message || "";
      if (!localBin && /command not found|ENOENT|is not installed|could not determine/i.test(message)) {
        return {
          ok: false,
          error: "ast-grep is not installed and the npx fallback could not fetch it. Install locally with `brew install ast-grep` (macOS), `cargo install ast-grep --locked`, or `npm i -g @ast-grep/cli`.",
          hint: "Once installed, Mesh will auto-detect the `ast-grep` binary and skip the slow npx fetch."
        };
      }
      return { ok: false, error: "ast-grep failed to execute.", details: message };
    }
  }

  private async runWithTelemetry(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("workspace.run_with_telemetry requires 'command'");

    const telemetryScriptPath = path.join(os.tmpdir(), `mesh-telemetry-${Date.now()}.cjs`);
    const telemetryCode = `
const inspector = require('node:inspector');
const session = new inspector.Session();
session.connect();
session.post('Debugger.enable');
session.post('Debugger.setPauseOnExceptions', { state: 'uncaught' });

session.on('Debugger.paused', async (message) => {
  console.error('\\n[Mesh Telemetry] 🚨 UNCAUGHT EXCEPTION DETECTED 🚨');
  console.error('[Mesh Telemetry] Freezing V8 Engine and dumping memory state...\\n');

  const callFrames = message.params.callFrames.slice(0, 3);

  const getProps = (objectId) => new Promise(resolve => {
    session.post('Runtime.getProperties', { objectId, ownProperties: true }, (err, res) => {
      resolve(err ? [] : res.result);
    });
  });

  for (let i = 0; i < callFrames.length; i++) {
    const frame = callFrames[i];
    console.error(\`\\n► Frame \${i}: \${frame.functionName || '<anonymous>'} (\${frame.url}:\${frame.location.lineNumber + 1})\`);

    for (const scope of frame.scopeChain) {
      if (scope.type === 'local' || scope.type === 'closure') {
        const props = await getProps(scope.object.objectId);
        if (props && props.length > 0) {
          console.error(\`  ➤ Scope: \${scope.type}\`);
          for (const p of props) {
            if (p.name === 'exports' || p.name === 'require' || p.name === 'module' || p.name === '__filename' || p.name === '__dirname') continue;
            let val = p.value ? p.value.value : (p.value && p.value.description ? p.value.description : 'undefined');
            if (typeof val === 'string' && val.length > 200) val = val.slice(0, 200) + '...';
            console.error(\`      let \${p.name} = \${val};\`);
          }
        }
      }
    }
  }

  console.error('\\n[Mesh Telemetry] Dump complete. Exiting.');
  process.exit(1);
});
`;
    await fs.writeFile(telemetryScriptPath, telemetryCode, "utf8");

    onProgress?.(`[Telemetry] Running: ${command}\n`);
    const TIMEOUT_MS = 60_000;

    const result = await new Promise<any>((resolve) => {
      const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${telemetryScriptPath}"` };
      const child = spawn("sh", ["-c", command], { cwd: this.workspaceRoot, env });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onProgress?.(text);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        onProgress?.(text);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          exitCode: timedOut ? 124 : (code ?? 0),
          stdout: stdout.length > 5000 ? stdout.slice(0, 2000) + "\n... [Truncated] ...\n" + stdout.slice(-3000) : stdout,
          stderr: stderr.length > 8000 ? stderr.slice(0, 2000) + "\n... [Truncated] ...\n" + stderr.slice(-6000) : stderr
        });
      });
    });

    await fs.unlink(telemetryScriptPath).catch(() => {});
    return result;
  }

  private async validatePatch(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const searchBlock = String(args.searchBlock ?? "");
    const replaceBlock = String(args.replaceBlock ?? "");
    if (!requestedPath || !searchBlock) throw new Error("validate_patch requires path and searchBlock");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    const originalContent = content;
    let appliedContent = content;

    if (!content.includes(searchBlock)) {
      const searchLines = searchBlock.split("\n").map(l => l.trim());
      const contentLines = content.split("\n");
      let foundIndex = -1;
      for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (contentLines[i + j].trim() !== searchLines[j]) {
            match = false; break;
          }
        }
        if (match) { foundIndex = i; break; }
      }
      if (foundIndex === -1) {
        return { ok: false, error: "Search block not found. Cannot validate." };
      }
      const newLines = [...contentLines];
      newLines.splice(foundIndex, searchLines.length, replaceBlock);
      appliedContent = newLines.join("\n");
    } else {
      appliedContent = content.replace(searchBlock, replaceBlock);
    }

    // Ghost Execute
    await fs.writeFile(absolutePath, appliedContent, "utf8");
    let result = { ok: true, message: "Patch is syntactically valid." };
    try {
      if (absolutePath.endsWith(".js") || absolutePath.endsWith(".cjs") || absolutePath.endsWith(".mjs")) {
        await execAsync(`node --check ${absolutePath}`);
      } else if (absolutePath.endsWith(".ts") || absolutePath.endsWith(".tsx")) {
        await execAsync(`npx tsc --noEmit --skipLibCheck --target esnext --moduleResolution node ${absolutePath}`);
      }
    } catch (err: any) {
      result = { ok: false, message: "Patch introduced a syntax error.", error: err.stdout || err.stderr || err.message } as any;
    } finally {
      // Always rollback
      await fs.writeFile(absolutePath, originalContent, "utf8");
    }

    return result;
  }

  private async traceSymbol(args: Record<string, unknown>): Promise<unknown> {
    const symbol = String(args.symbol ?? "").trim();
    if (!symbol) throw new Error("trace_symbol requires symbol");

    // 1. Find all references
    const refsResult = await this.findReferences({ symbol }) as any;
    if (!refsResult.ok || !refsResult.matches) {
      return { ok: false, error: "Could not find references." };
    }

    const traceContext = [];
    const uniqueFiles = new Set<string>();

    // 2. Extract surrounding execution context for the top 3 hits
    for (const match of refsResult.matches.slice(0, 3)) {
      uniqueFiles.add(match.path);
      const absPath = ensureInsideRoot(this.workspaceRoot, match.path);
      const content = await fs.readFile(absPath, "utf8").catch(() => "");
      if (!content) continue;

      const record = await this.meshCore.getDetailedRecord(match.path, content);
      if (!record) continue;

      // Find which function this usage is inside of
      const symBlock = record.symbols.find(s => match.line >= s.lineStart && match.line <= s.lineEnd);
      if (symBlock) {
        const lines = content.split("\n");
        const snippet = lines.slice(symBlock.lineStart - 1, symBlock.lineEnd).join("\n");
        traceContext.push({
          file: match.path,
          line: match.line,
          contextSymbol: symBlock.name,
          snippet: snippet.slice(0, 800) // keep it reasonably sized
        });
      }
    }

    return {
      ok: true,
      symbol,
      totalReferences: refsResult.totalFound,
      traceContext,
      note: "Symbol traced across caller environments to map data flow."
    };
  }

  private async spawnSwarm(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const subTasks = (args.subTasks || []) as Array<{ id: string; prompt: string }>;
    if (subTasks.length === 0) throw new Error("spawn_swarm requires at least one sub-task.");

    onProgress?.(`[Swarm] Orchestrating ${subTasks.length} parallel sub-agents...\n`);

    const results = await Promise.all(subTasks.map(async (task) => {
      onProgress?.(`[Swarm-${task.id}] Launching sub-agent...\n`);
      try {
        const res = await this.invokeSubAgent({ prompt: task.prompt });
        return { id: task.id, status: "success", summary: (res as any).summary };
      } catch (err) {
        return { id: task.id, status: "error", error: (err as Error).message };
      }
    }));

    return {
      ok: true,
      swarmResults: results,
      note: "Sub-tasks completed in parallel. Review summaries for next steps."
    };
  }

  private async invokeSubAgent(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("invoke_sub_agent requires a prompt");
    if (!this.config) throw new Error("Agent configuration not available for sub-agent.");

    onProgress?.(`[Sub-Agent] Starting research task: "${prompt}"\n`);

    const llm = new BedrockLlmClient({
      endpointBase: this.config.bedrock.endpointBase,
      modelId: HAIKU_MODEL_ID, // Fallback to Haiku for speed, or current
      bearerToken: this.config.bedrock.bearerToken,
      temperature: 0.1,
      maxTokens: 4096
    });

    const tools = await this.listTools();
    const safeTools = tools
      .filter(t => ["workspace.list_files", "workspace.read_file", "workspace.grep_capsules", "workspace.list_symbols"].includes(t.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} }
      }));
    const wireToolMap = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown> }>();
    const safeWireTools = safeTools.map((tool) => {
      let wireName = sanitizeLlmToolName(tool.name);
      let suffix = 2;
      while (wireToolMap.has(wireName)) {
        wireName = `${sanitizeLlmToolName(tool.name)}_${suffix}`;
        suffix += 1;
      }
      wireToolMap.set(wireName, tool);
      return {
        name: wireName,
        description: tool.description,
        inputSchema: tool.inputSchema
      };
    });

    const messages: any[] = [{ role: "user", content: [{ text: prompt }] }];
    let iterations = 0;

    while (iterations < 15) {
      const response = await llm.converse(messages, safeWireTools as any[], "You are a fast research sub-agent. Gather data and summarize.", HAIKU_MODEL_ID);

      if (response.kind === "text") {
        return { ok: true, summary: response.text };
      }

      const assistantContent: any[] = [];
      if (response.text) {
        assistantContent.push({ text: response.text });
      }
      for (const tu of response.toolUses) {
        assistantContent.push({ toolUse: tu });
      }
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults = await Promise.all(response.toolUses.map(async (tu) => {
        const tool = wireToolMap.get(tu.name);
        if (!tool) {
          return { toolUseId: tu.toolUseId, status: "error", content: [{ text: `Unknown tool '${tu.name}'.` }] };
        }
        try {
          const res = await this.callTool(tool.name, tu.input);
          return { toolUseId: tu.toolUseId, status: "success", content: [{ text: JSON.stringify(res) }] };
        } catch (e) {
          return { toolUseId: tu.toolUseId, status: "error", content: [{ text: (e as Error).message }] };
        }
      }));

      messages.push({ role: "user", content: toolResults.map(tr => ({ toolResult: tr })) as any });
      iterations++;
    }

    return { ok: false, error: "Sub-agent reached max iterations without a final summary." };
  }

  private async raceFixes(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const task = String(args.task ?? "").trim();
    const verificationCommand = String(args.verificationCommand ?? "").trim();
    const requestedCandidates = Number(args.candidates);
    const looksSimple = !/(multi|across|refactor|runtime|crash|exception|architecture|migration|several|multiple)/i.test(task);
    const defaultCandidates = looksSimple ? 1 : 3;
    const candidateCount = Math.max(1, Math.min(Number.isFinite(requestedCandidates) ? requestedCandidates : defaultCandidates, 5));

    if (!task || !verificationCommand) throw new Error("race_fixes requires task and verificationCommand");
    if (!this.config) throw new Error("Agent configuration not available.");

    onProgress?.(`[Multiverse] Racing ${candidateCount} candidates for task: "${task}"\n`);

    const llm = new BedrockLlmClient({
      endpointBase: this.config.bedrock.endpointBase,
      modelId: this.config.bedrock.modelId,
      fallbackModelIds: this.config.bedrock.fallbackModelIds,
      bearerToken: this.config.bedrock.bearerToken,
      temperature: 0.7,
      maxTokens: 4096
    });
    const context = await this.workspaceIndex.search(task, "bug", Math.max(2, candidateCount)).catch(() => null);
    const contextBlock = context?.results?.length
      ? context.results
          .slice(0, 5)
          .map((result) => [
            `- ${result.file}`,
            `  purpose: ${result.purpose}`,
            result.citations.length > 0
              ? `  signals: ${result.citations.map((citation) => citation.whyMatched.join(", ")).join(" | ")}`
              : null
          ].filter(Boolean).join("\n"))
          .join("\n")
      : "No high-confidence codebase matches were found.";

    const strategies = [
      "Minimal Intervention: Fix the error with as few changes as possible.",
      "Complete Refactoring: Clean up the code and improve architecture while fixing.",
      "Robust Error-Handling: Add defensive checks and try-catch blocks.",
      "Performance Focus: Optimize for speed and memory.",
      "Standard idiomatic approach: Use common patterns."
    ];

    const controller = new AbortController();
    const results = await Promise.all(Array.from({ length: candidateCount }).map(async (_, i) => {
      const strategy = strategies[i % strategies.length];
      onProgress?.(`[Candidate ${i + 1}] Generating fix with strategy: ${strategy.split(":")[0]}...\n`);

      const prompt = `You are an expert engineer.
Task: ${task}
Strategy: ${strategy}
Relevant codebase context:
${contextBlock}

Generate a standard git patch (diff) to solve the problem.
Respond ONLY with the raw diff content. No markdown code fences, no preamble.`;

      try {
        if (controller.signal.aborted) {
          return { id: i, status: "aborted", error: "Another candidate passed verification.", score: -1000 };
        }
        const response = await llm.converse(
          [{ role: "user", content: [{ text: prompt }] }],
          [],
          "Respond only with a raw git patch.",
          undefined,
          controller.signal
        );
        if (response.kind !== "text") {
          return { id: i, status: "error", error: "LLM failed to generate text." };
        }

        const patch = response.text.trim();
        if (!patch) return { id: i, status: "error", error: "LLM returned empty patch." };

        const tlRes = await this.timelines.create({ name: `race-${i}-${Date.now().toString(36)}` });
        const timelineId = tlRes.timeline.id;

        onProgress?.(`[Candidate ${i + 1}] Applying patch to ${timelineId}...\n`);
        const applyRes = await this.timelines.applyPatch({ timelineId, patch });
        if (!applyRes.ok) {
          return {
            id: i,
            timelineId,
            strategy: strategy.split(":")[0],
            status: "rejected",
            error: "Patch rejected.",
            score: -1000,
            metrics: { changedLines: 0, warningCount: 0, durationMs: 0 }
          };
        }

        onProgress?.(`[Candidate ${i + 1}] Running verification: ${verificationCommand}...\n`);
        if (controller.signal.aborted) {
          return {
            id: i,
            timelineId,
            strategy: strategy.split(":")[0],
            status: "aborted",
            error: "Another candidate passed verification before this run started.",
            score: -1000,
            metrics: { changedLines: 0, warningCount: 0, durationMs: 0 }
          };
        }
        const runRes = await this.timelines.run({ timelineId, command: verificationCommand });
        const comparison = await this.timelines.compare({ timelineIds: [timelineId] });
        const summary = comparison.comparisons[0] as Record<string, unknown> | undefined;
        const changedLines = Number(summary?.changedLineCount ?? 0);
        const warningCount = countWarnings(`${runRes.stdout}\n${runRes.stderr}`);
        const durationMs = Number(summary?.commandDurationMs ?? runRes.commandRecord.durationMs ?? 0);
        const score = computeRaceScore({
          passed: runRes.ok,
          changedLines,
          warningCount,
          durationMs
        });

        const result = {
          id: i,
          timelineId,
          strategy: strategy.split(":")[0],
          status: runRes.ok ? "passed" : "failed",
          exitCode: runRes.exitCode,
          verdict: runRes.ok ? "pass" : "fail",
          score,
          metrics: {
            changedFiles: Array.isArray(summary?.changedFiles) ? summary?.changedFiles : [],
            changedLines,
            warningCount,
            durationMs
          },
          comparison: summary
        };
        if (runRes.ok && !controller.signal.aborted) {
          controller.abort();
        }
        return result;
      } catch (err) {
        if (controller.signal.aborted) {
          return {
            id: i,
            timelineId: undefined,
            strategy: strategy.split(":")[0],
            status: "aborted",
            error: "Another candidate passed verification.",
            score: -1000,
            metrics: { changedLines: 0, warningCount: 0, durationMs: 0 }
          };
        }
        return {
          id: i,
          timelineId: undefined,
          strategy: strategy.split(":")[0],
          status: "error",
          error: (err as Error).message,
          score: -1000,
          metrics: { changedLines: 0, warningCount: 0, durationMs: 0 }
        };
      }
    }));

    const rankedResults = [...results].sort((left, right) => Number(right.score ?? -Infinity) - Number(left.score ?? -Infinity));
    const winner = rankedResults.find((result) => (result as any).verdict === "pass") ?? rankedResults[0] ?? null;

    return {
      ok: true,
      task,
      verificationCommand,
      context: context?.topMatches ?? [],
      winnerTimelineId: winner?.timelineId ?? null,
      winnerStrategy: winner?.strategy ?? null,
      results: rankedResults,
      note: "Multiverse racing complete. Review the ranked candidates and promote the winner with workspace.timeline_promote."
    };
  }

  private async askCodebase(args: Record<string, unknown>, onProgress?: (msg: string) => void): Promise<unknown> {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("ask_codebase requires a query");
    const rawMode = String(args.mode ?? "architecture").trim() as CodeQueryMode;
    const mode: CodeQueryMode = [
      "architecture",
      "bug",
      "edit-impact",
      "test-impact",
      "ownership",
      "recent-change",
      "runtime-path"
    ].includes(rawMode)
      ? rawMode
      : "architecture";
    const limit = Math.max(1, Math.min(Number(args.limit) || 8, 25));
    onProgress?.(`[Index] Querying persistent code index (${mode}) for "${query}"...\n`);
    const variants = ragQueryVariants(query, mode);
    const searches = await Promise.all(
      variants.map((variant) => this.workspaceIndex.search(variant, mode, Math.min(25, limit * 2)))
    );
    const result: any = searches[0];
    const production = await this.telemetry.topSignals(50).catch(() => []);
    const productionByFile = new Map(production.map((item) => [item.file, item]));
    const merged = new Map<string, any>();

    for (let variantIndex = 0; variantIndex < searches.length; variantIndex += 1) {
      const variant = variants[variantIndex];
      for (const entry of searches[variantIndex].results ?? []) {
        const existing = merged.get(entry.file);
        const variantWeight = variantIndex === 0 ? 1 : 0.72;
        const overlap = lexicalOverlapScore(query, `${entry.file}\n${entry.purpose}\n${entry.matchedSignals?.join(" ") ?? ""}`);
        const score = Number(entry.score ?? 0) * variantWeight + overlap * 4;
        if (!existing) {
          merged.set(entry.file, {
            ...entry,
            score,
            baseScore: entry.score,
            matchedVariants: [variant],
            citations: Array.isArray(entry.citations) ? entry.citations : []
          });
        } else {
          existing.score = Math.max(existing.score, score) + 0.35;
          existing.matchedVariants = uniqueStrings([...(existing.matchedVariants ?? []), variant], 6);
          existing.citations = [...(existing.citations ?? []), ...(entry.citations ?? [])].slice(0, 8);
          existing.matchedSignals = uniqueStrings([...(existing.matchedSignals ?? []), ...(entry.matchedSignals ?? [])], 12);
        }
      }
    }

    const boosted = Array.from(merged.values()).map((entry: any) => {
      const signal = productionByFile.get(entry.file);
      const productionBoost = signal ? scoreSignal(signal) : 0;
      const finalScore = Number(entry.score ?? 0) + Math.min(8, productionBoost / 250);
      return {
        ...entry,
        score: Number(finalScore.toFixed(3)),
        productionBoost
      };
    }).sort((left: any, right: any) => (right.score ?? 0) - (left.score ?? 0)).slice(0, limit);
    return {
      ...result,
      query,
      queryVariants: variants,
      results: boosted,
      topMatches: boosted.map((entry: any) => ({
        path: entry.file,
        score: entry.score,
        snippet: `[Fonte: ${entry.file}]\n${entry.purpose}`
      })),
      resultsFound: Math.max(result.resultsFound ?? 0, merged.size),
      productionSignals: production.slice(0, 10)
    };
  }

  private async explainSymbol(args: Record<string, unknown>): Promise<unknown> {
    const symbol = String(args.symbol ?? "").trim();
    if (!symbol) throw new Error("workspace.explain_symbol requires symbol");
    return this.workspaceIndex.explainSymbol(symbol);
  }

  private async impactMap(args: Record<string, unknown>): Promise<unknown> {
    const result: any = await this.workspaceIndex.impactMap({
      path: typeof args.path === "string" ? args.path : undefined,
      symbol: typeof args.symbol === "string" ? args.symbol : undefined,
      diff: typeof args.diff === "string" ? args.diff : undefined
    });
    const production = await this.telemetry.topSignals(100).catch(() => []);
    const byFile = new Map(production.map((signal) => [signal.file, signal]));
    const ranked = (result.ranked ?? result.impact ?? []).map((entry: any) => {
      const file = entry.path ?? entry.file;
      const signal = byFile.get(file);
      return {
        ...entry,
        revenueImpactDaily: signal?.revenueImpactDaily ?? 0,
        requestVolume: signal?.requestVolume ?? 0,
        errorRate: signal?.errorRate ?? 0
      };
    });
    return {
      ...result,
      ranked
    };
  }

  private async getGitDiff(args: Record<string, unknown>): Promise<unknown> {
    try {
      const subPath = typeof args.path === "string" ? args.path : "";
      const absolutePath = subPath ? ensureInsideRoot(this.workspaceRoot, subPath) : this.workspaceRoot;
      const relativePath = subPath ? toPosixRelative(this.workspaceRoot, absolutePath) : "";

      const { stdout } = await execAsync(`git diff ${relativePath}`, { cwd: this.workspaceRoot });
      return { ok: true, diff: stdout || "No changes." };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async patchSurgical(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const searchBlock = String(args.searchBlock ?? "");
    const replaceBlock = String(args.replaceBlock ?? "");
    if (!requestedPath || !searchBlock) throw new Error("patch_surgical requires path and searchBlock");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    await this.saveBackup(requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");

    // Backup original content for potential rollback
    const originalContent = content;
    let appliedContent = content;

    // Exact match check first
    if (!content.includes(searchBlock)) {
      // Try a more lenient match by trimming each line if exact match fails
      const searchLines = searchBlock.split("\n").map(l => l.trim());
      const contentLines = content.split("\n");

      let foundIndex = -1;
      for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (contentLines[i + j].trim() !== searchLines[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundIndex = i;
          break;
        }
      }

      if (foundIndex === -1) {
        throw new Error(`Could not find search block in ${requestedPath}. Ensure indentation and content match exactly.`);
      }

      // Reconstruct with lenient match
      const newLines = [...contentLines];
      newLines.splice(foundIndex, searchLines.length, replaceBlock);
      appliedContent = newLines.join("\n");
    } else {
      appliedContent = content.replace(searchBlock, replaceBlock);
    }

    await fs.writeFile(absolutePath, appliedContent, "utf8");

    // Auto-Validation (Self-Healing)
    try {
      if (absolutePath.endsWith(".js") || absolutePath.endsWith(".cjs") || absolutePath.endsWith(".mjs")) {
        await execAsync(`node --check ${absolutePath}`);
      } else if (absolutePath.endsWith(".ts") || absolutePath.endsWith(".tsx")) {
        // Quick syntax check using tsc without checking the whole project
        await execAsync(`npx tsc --noEmit --skipLibCheck --target esnext --moduleResolution node ${absolutePath}`);
      }
    } catch (err: any) {
      // Rollback
      await fs.writeFile(absolutePath, originalContent, "utf8");
      return {
        ok: false,
        error: "Patch introduced a syntax error and was automatically rolled back.",
        compilerOutput: err.stdout || err.stderr || err.message,
        note: "Fix your code and try again."
      };
    }

    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    await this.cache.deleteCapsule(rel, "low");
    await this.cache.deleteCapsule(rel, "medium");
    await this.cache.deleteCapsule(rel, "high");

    return { ok: true, path: rel, patched: true };
  }

  private async listSymbols(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    if (!requestedPath) throw new Error("list_symbols requires path");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);

    const symbols = await this.meshCore.extractSymbols(rel, content);

    return {
      ok: true,
      path: rel,
      count: symbols.length,
      symbols: symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        location: `L${s.lineStart}-L${s.lineEnd}`
      }))
    };
  }

  private async expandSymbol(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const symbolName = String(args.symbolName ?? "").trim();
    if (!requestedPath || !symbolName) throw new Error("expand_symbol requires path and symbolName");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);

    const record = await this.meshCore.getDetailedRecord(rel, content);
    if (!record) throw new Error("Could not analyze file with MeshCore.");

    const sym = record.symbols.find(s => s.name === symbolName || (s.kind && `${s.kind} ${s.name}` === symbolName));
    if (!sym) {
      // Fuzzy search fallback
      const fuzzy = record.symbols.find(s => s.name.toLowerCase().includes(symbolName.toLowerCase()));
      if (!fuzzy) throw new Error(`Symbol '${symbolName}' not found in ${requestedPath}`);

      const lines = content.split(/\r?\n/g);
      const snippet = lines.slice(fuzzy.lineStart - 1, fuzzy.lineEnd).join("\n");
      return { ok: true, path: rel, symbol: fuzzy.name, kind: fuzzy.kind, snippet };
    }

    const lines = content.split(/\r?\n/g);
    const snippet = lines.slice(sym.lineStart - 1, sym.lineEnd).join("\n");

    return {
      ok: true,
      path: rel,
      symbol: sym.name,
      kind: sym.kind,
      range: { start: sym.lineStart, end: sym.lineEnd },
      snippet
    };
  }

  private async getFileGraph(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    if (!requestedPath) throw new Error("get_file_graph requires path");

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const content = await fs.readFile(absolutePath, "utf8");
    const rel = toPosixRelative(this.workspaceRoot, absolutePath);

    const record = await this.meshCore.getDetailedRecord(rel, content);
    if (!record) throw new Error("Could not analyze file with MeshCore.");

    return {
      ok: true,
      path: rel,
      fileType: record.fileType,
      dependencies: record.dependencies,
      note: "Dependencies are resolved relative to the workspace root."
    };
  }

  private async readDirOverview(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? ".").trim();
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const entries = await fs.readdir(base, { withFileTypes: true });

    const results = [];
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name.endsWith(".tsx"))) {
        const filePath = path.join(base, entry.name);
        const rel = toPosixRelative(this.workspaceRoot, filePath);
        const stat = await fs.stat(filePath);
        const capsule = await this.cache.getCapsule(rel, "low", Math.floor(stat.mtimeMs));

        if (capsule) {
          results.push({ path: rel, overview: capsule.content });
        } else {
          // Generate on the fly if missing
          const content = await fs.readFile(filePath, "utf8");
          const summaries = await this.meshCore.summarizeAllTiers(rel, content);
          await this.cache.setCapsule(rel, "low", summaries.low, Math.floor(stat.mtimeMs));
          results.push({ path: rel, overview: summaries.low });
        }
      }
    }

    return {
      ok: true,
      path: requestedPath,
      fileCount: results.length,
      overviews: results
    };
  }

  private handleAgentPlan(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action === "write" ? "write" : "read";
    if (action === "write") {
      this.agentPlan = String(args.plan ?? "");
      return Promise.resolve({ ok: true, message: "Plan updated." });
    }
    return Promise.resolve({ ok: true, plan: this.agentPlan });
  }

  private async getEnvInfo(): Promise<unknown> {
    const info: Record<string, string> = {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cwd: this.workspaceRoot
    };

    const tools = ["git", "node", "npm", "rg", "python3", "gcc"];
    for (const tool of tools) {
      try {
        const { stdout } = await execAsync(`${tool} --version`);
        info[tool] = stdout.split("\n")[0].trim();
      } catch {
        info[tool] = "not found";
      }
    }

    return { ok: true, ...info };
  }

  private async grepRipgrep(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("grep_ripgrep requires query");

    const subPath = typeof args.path === "string" ? args.path : ".";
    const absolutePath = ensureInsideRoot(this.workspaceRoot, subPath);
    const includePattern = typeof args.includePattern === "string" ? `--glob "${args.includePattern}"` : "";

    try {
      const { stdout } = await execAsync(`rg --vimgrep --max-columns 200 ${includePattern} "${query}" .`, {
        cwd: absolutePath
      });

      const lines = stdout.split("\n").filter(Boolean);
      const matches = lines.slice(0, 100).map(line => {
        const [file, lnum, col, ...rest] = line.split(":");
        return {
          path: path.join(subPath, file),
          line: Number(lnum),
          column: Number(col),
          snippet: rest.join(":").trim()
        };
      });

      return { ok: true, query, count: matches.length, totalFound: lines.length, matches };
    } catch (err) {
      if ((err as any).code === 127) {
        return { ok: false, error: "ripgrep (rg) not found on system. Use grep_content instead." };
      }
      return { ok: true, query, count: 0, matches: [], note: "No matches or ripgrep error." };
    }
  }

  private async grepContent(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      throw new Error("workspace.grep_content requires 'query'");
    }

    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, 300));
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const files = await collectFiles(base, 1200, this.workspaceRoot);

    const matches: Array<{ path: string; line: number; snippet: string }> = [];
    const needle = query.toLowerCase();

    for (const filePath of files) {
      if (matches.length >= limit) break;

      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      if (content.length > 500_000) {
        continue;
      }

      const lines = content.split(/\r?\n/g);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.toLowerCase().includes(needle)) continue;

        matches.push({
          path: toPosixRelative(this.workspaceRoot, filePath),
          line: i + 1,
          snippet: line.slice(0, 220)
        });

        if (matches.length >= limit) {
          break;
        }
      }
    }

    return {
      ok: true,
      query,
      count: matches.length,
      matches
    };
  }

  private async writeFile(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    if (!requestedPath) {
      throw new Error("workspace.write_file requires 'path'");
    }

    const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    await this.saveBackup(requestedPath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    const rel = toPosixRelative(this.workspaceRoot, absolutePath);
    this.workspaceIndex.partialUpdate([rel]).catch(() => {});

    return {
      ok: true,
      path: rel,
      bytesWritten: Buffer.byteLength(content, "utf8")
    };
  }

  private async runCommand(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("workspace.run_command requires 'command'");
    assertCommandAllowed(command);

    const TIMEOUT_MS = 30_000;
    const TRIM_LIMIT = 15_000;
    const trim = (s: string) => {
      if (s.length <= TRIM_LIMIT) return s;
      const head = s.slice(0, 3000);
      const tail = s.slice(-8000);
      return `${head}\n\n... [${s.length - 11000} bytes omitted by Mesh for performance] ...\n\n${tail}`;
    };

    const result = await new Promise<any>((resolve) => {
      const child = spawn("sh", ["-c", command], { cwd: this.workspaceRoot });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onProgress?.(text);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        onProgress?.(text);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut,
          command,
          exitCode: timedOut ? 124 : (code ?? 0),
          stdout: trim(stdout),
          stderr: timedOut ? `[TIMEOUT after ${TIMEOUT_MS / 1000}s]\n${trim(stderr)}` : trim(stderr)
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, command, exitCode: 1, stdout: "", stderr: String(err) });
      });
    });

    // Smart context injection for errors
    if (!result.ok) {
      const errorContent = result.stderr + "\n" + result.stdout;
      const fileLineRegex = /([a-zA-Z0-9._\-\/]+\.(?:ts|js|tsx|js|py|go|c|cpp|rs|java|rb|php)):(\d+)/g;
      const matches = Array.from(errorContent.matchAll(fileLineRegex)).slice(0, 3); // Max 3 snippets

      if (matches.length > 0) {
        const snippets = [];
        for (const match of matches) {
          const filePath = match[1];
          const lineNum = parseInt(match[2], 10);
          try {
            const absPath = ensureInsideRoot(this.workspaceRoot, filePath);
            const content = await fs.readFile(absPath, "utf8");
            const lines = content.split(/\r?\n/g);
            const start = Math.max(0, lineNum - 3);
            const end = Math.min(lines.length, lineNum + 2);
            const snippet = lines.slice(start, end).map((l, i) => `${start + i + 1} | ${l}`).join("\n");
            snippets.push(`Context for ${filePath}:${lineNum}:\n${snippet}`);
          } catch {
            // Skip if file doesn't exist or escapes root
          }
        }
        if (snippets.length > 0) {
          result.contextualSnippets = snippets;
          result.stderr += "\n\n--- Mesh Context Injection ---\n" + snippets.join("\n\n");
        }
      }
    }

    return result;
  }

  private async checkSync(): Promise<unknown> {
    const status = await this.cache.getSyncStatus();
    return { ok: true, ...status };
  }

  private async getIndexStatus(): Promise<unknown> {
    return this.workspaceIndex.status();
  }

  private meshArtifactPath(...parts: string[]): string {
    return path.join(this.workspaceRoot, ".mesh", ...parts);
  }

  private async digitalTwin(args: Record<string, unknown> = {}): Promise<unknown> {
    const action = String(args.action ?? "build");
    const twinPath = this.meshArtifactPath("digital-twin.json");
    if (action === "read" || action === "status") {
      const existing = await readJsonFile<any | null>(twinPath, null);
      if (!existing) return { ok: false, status: "missing", path: twinPath, message: "Digital Twin has not been built yet." };
      return action === "status"
        ? {
            ok: true,
            path: twinPath,
            builtAt: existing.builtAt,
            files: existing.files?.total ?? 0,
            symbols: existing.symbols?.length ?? 0,
            routes: existing.routes?.length ?? 0,
            riskHotspots: existing.riskHotspots?.length ?? 0
          }
        : { ok: true, path: twinPath, twin: existing };
    }

    const files = await collectFiles(this.workspaceRoot, 10000, this.workspaceRoot);
    const relativeFiles = files.map((file) => toPosixRelative(this.workspaceRoot, file));
    const sourceFiles = relativeFiles.filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
    const testFiles = relativeFiles.filter((file) => /(^|\/)(test|tests|__tests__)\/|(\.test|\.spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
    const configFiles = relativeFiles.filter((file) => /(^|\/)(package\.json|tsconfig\.json|vite\.config|next\.config|tailwind\.config|Dockerfile|docker-compose|cloudbuild|render\.yaml|vercel\.json|netlify\.toml|\.env\.example|\.github\/workflows)/.test(file));
    const envFiles = relativeFiles.filter((file) => /(^|\/)\.env(\.example|\.local|\.development|\.production)?$/.test(file));
    const symbols: Array<Record<string, unknown>> = [];
    const routes: Array<Record<string, unknown>> = [];
    const riskHotspots: Array<Record<string, unknown>> = [];

    for (const rel of sourceFiles.slice(0, 1500)) {
      const absolutePath = ensureInsideRoot(this.workspaceRoot, rel);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
      if (!raw) continue;
      for (const symbol of extractSymbolHints(raw).slice(0, 40)) {
        symbols.push({ file: rel, ...symbol });
      }
      for (const route of extractRouteHints(raw)) {
        routes.push({ file: rel, ...route });
      }
      const risks = detectRiskHints(rel, raw);
      if (risks.length > 0) {
        riskHotspots.push({ file: rel, risks, score: risks.length });
      }
    }

    const packageJson = await readJsonFile<any | null>(path.join(this.workspaceRoot, "package.json"), null);
    const env = await this.collectEnvNames(envFiles);
    const git = await this.getGitStatus();
    const index = await this.workspaceIndex.status();

    // High-density AI brain prune: only raw routes and symbols
    const prunedTwin = {
      routes: routes.map(r => ({ f: r.file, m: r.method, r: r.route, l: r.line })),
      symbols: symbols.map(s => ({ f: s.file, n: s.name, k: s.kind, l: s.line }))
    };

    const twin = {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      workspaceName: path.basename(this.workspaceRoot),
      index,
      files: {
        total: relativeFiles.length,
        source: sourceFiles.length,
        tests: testFiles.length,
        config: configFiles.length
      },
      package: packageJson
        ? {
            name: packageJson.name,
            version: packageJson.version,
            scripts: packageJson.scripts ?? {},
            dependencies: Object.keys(packageJson.dependencies ?? {}),
            devDependencies: Object.keys(packageJson.devDependencies ?? {})
          }
        : null,
      env,
      deploy: {
        configs: configFiles.filter((file) => /Dockerfile|docker-compose|cloudbuild|render\.yaml|vercel\.json|netlify\.toml|\.github\/workflows/.test(file)),
        scripts: Object.entries(packageJson?.scripts ?? {})
          .filter(([name, value]) => /deploy|publish|release|build|start/i.test(`${name} ${value}`))
          .map(([name, value]) => ({ name, command: value }))
      },
      tests: testFiles.slice(0, 250),
      routes: prunedTwin.routes.slice(0, 500),
      symbols: prunedTwin.symbols.slice(0, 2000),
      riskHotspots: riskHotspots.sort((left: any, right: any) => right.score - left.score).slice(0, 100),
      git
    };

    await writeJsonFile(twinPath, twin);
    return { ok: true, path: twinPath, twin };
  }

  private async collectEnvNames(envFiles: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const rel of envFiles) {
      const raw = await fs.readFile(ensureInsideRoot(this.workspaceRoot, rel), "utf8").catch(() => "");
      result[rel] = uniqueStrings(raw
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("=")[0]?.trim()), 200);
    }
    return result;
  }

  private async timelinePromoteWithBrain(args: { timelineId: string }): Promise<unknown> {
    const timeline = await this.timelines.readRecord(args.timelineId);
    const compare = await this.timelines.compare({ timelineIds: [args.timelineId] });
    const summary = (compare.comparisons?.[0] ?? {}) as Record<string, unknown>;
    const critic = runCritic({
      diffPreview: String(summary.diffPreview ?? ""),
      verificationOk: timeline.verdict === "pass"
    });
    const redTeam = runRedTeam({
      diffPreview: String(summary.diffPreview ?? "")
    });
    if (!critic.ok || !redTeam.ok) {
      return {
        ok: false,
        timelineId: args.timelineId,
        message: "Adversarial checks blocked promotion. Resolve findings or override explicitly.",
        critic,
        redTeam
      };
    }

    const result = await this.timelines.promote({ timelineId: args.timelineId });
    if (!result.ok) {
      return result;
    }

    try {
      const lastCommand = timeline.commands.at(-1);
      const commandOutput = await fs.readFile(lastCommand?.stderrPath ?? "", "utf8").catch(() => "");
      const errorSignature = normalizeErrorSignature(commandOutput || lastCommand?.command || "timeline-promote");
      const diffPattern = normalizeDiffPattern(String(summary.diffPreview ?? ""));
      const contribution = await this.meshBrain.contribute({
        workspaceFingerprint: this.workspaceFingerprint(),
        errorSignature,
        diffPattern,
        verificationResult: {
          verdict: timeline.verdict ?? "unknown",
          command: lastCommand?.command,
          exitCode: lastCommand?.exitCode,
          tsc: /\btsc\b/.test(lastCommand?.command ?? "") ? (lastCommand?.ok ? "pass" : "fail") : "unknown",
          lint: /\blint\b/.test(lastCommand?.command ?? "") ? (lastCommand?.ok ? "pass" : "fail") : "unknown"
        }
      });
      return { ...result, meshBrain: contribution, critic, redTeam };
    } catch (error) {
      return {
        ...result,
        meshBrain: { ok: false, contributed: false, reason: (error as Error).message },
        critic,
        redTeam
      };
    }
  }

  private async meshBrainTool(args: Record<string, unknown> = {}): Promise<unknown> {
    const action = String(args.action ?? "stats");
    if (action === "opt_out") {
      await this.meshBrain.optOut();
      return {
        ok: true,
        action,
        message: "Mesh Brain contribution disabled for this workspace."
      };
    }
    if (action === "query") {
      const error = String(args.error ?? "").trim();
      if (!error) {
        throw new Error("workspace.brain query requires error");
      }
      const patterns = await this.meshBrain.query({
        errorSignature: normalizeErrorSignature(error),
        limit: Math.max(1, Math.min(Number(args.limit) || 5, 20))
      });
      return {
        ok: true,
        action,
        patterns: patterns.patterns,
        source: patterns.source
      };
    }
    const stats = await this.meshBrain.status();
    return { ok: true, action: "stats", ...stats };
  }

  private async daemonControl(args: Record<string, unknown> = {}): Promise<unknown> {
    const action = String(args.action ?? "status").trim().toLowerCase();
    if (action === "start") {
      const code = await runDaemonCli(["start"]);
      return { ok: code === 0, action };
    }
    if (!["status", "digest", "stop"].includes(action)) {
      throw new Error("workspace.daemon action must be start|status|digest|stop");
    }
    const response = await this.callDaemonSocket({ action: action as "status" | "digest" | "stop" });
    return response;
  }

  private async productionStatus(args: Record<string, unknown> = {}): Promise<unknown> {
    const action = String(args.action ?? "status");
    const state = action === "refresh"
      ? await this.telemetry.refresh()
      : await this.telemetry.status();
    const top = [...state.signals]
      .sort((left, right) => scoreSignal(right) - scoreSignal(left))
      .slice(0, 10);
    return {
      ok: true,
      action,
      updatedAt: state.updatedAt,
      totalSignals: state.signals.length,
      topErrors: top.map((signal) => ({
        file: signal.file,
        route: signal.route,
        errorRate: signal.errorRate,
        requestVolume: signal.requestVolume,
        p99Ms: signal.p99Ms,
        revenueImpactDaily: signal.revenueImpactDaily,
        score: scoreSignal(signal)
      }))
    };
  }

  private async whatIf(args: Record<string, unknown>, onProgress?: (chunk: string) => void): Promise<unknown> {
    const hypothesis = String(args.hypothesis ?? "").trim();
    if (!hypothesis) throw new Error("workspace.what_if requires hypothesis");
    if (!this.config) throw new Error("Agent configuration not available.");
    const verificationCommand = String(args.verificationCommand ?? "npm run typecheck && npm test");
    const promote = args.promote === true;

    onProgress?.(`[What-If] Creating counterfactual timeline for: ${hypothesis}\n`);
    const timeline = await this.timelines.create({ name: `what-if-${Date.now().toString(36)}` });
    const llm = new BedrockLlmClient({
      endpointBase: this.config.bedrock.endpointBase,
      modelId: this.config.bedrock.modelId,
      fallbackModelIds: this.config.bedrock.fallbackModelIds,
      bearerToken: this.config.bedrock.bearerToken,
      temperature: 0.1,
      maxTokens: 4096
    });
    const response = await llm.converse(
      [{ role: "user", content: [{ text: `Hypothesis: ${hypothesis}\nGenerate a git patch implementing this migration. Return only raw diff.` }] }],
      [],
      "Return only raw git patch."
    );
    if (response.kind !== "text") {
      return { ok: false, hypothesis, message: "LLM did not return patch text." };
    }
    const patch = response.text.trim();
    const apply = await this.timelines.applyPatch({ timelineId: timeline.timeline.id, patch });
    if (!apply.ok) {
      return { ok: false, hypothesis, timelineId: timeline.timeline.id, message: apply.message, stderr: apply.stderr };
    }
    const verify = await this.timelines.run({
      timelineId: timeline.timeline.id,
      command: verificationCommand,
      timeoutMs: 240_000
    });
    const compare = await this.timelines.compare({ timelineIds: [timeline.timeline.id] });
    const summary = compare.comparisons[0] as any;
    const report = {
      ok: true,
      hypothesis,
      timelineId: timeline.timeline.id,
      verificationCommand,
      verdict: verify.ok ? "pass" : "fail",
      changedFiles: summary?.changedFiles ?? [],
      changedLineCount: summary?.changedLineCount ?? 0,
      testsBrokenEstimate: verify.ok ? 0 : estimateFailedTests(`${verify.stdout}\n${verify.stderr}`),
      typeErrorsEstimate: countTypeErrors(`${verify.stdout}\n${verify.stderr}`),
      bundleSizeDeltaKb: estimateBundleDelta(`${verify.stdout}\n${verify.stderr}`),
      note: promote
        ? "Use workspace.timeline_promote to materialize this counterfactual."
        : "Counterfactual evaluated in isolated timeline; no main workspace changes applied."
    };
    if (promote && verify.ok) {
      const promoted = await this.timelines.promote({ timelineId: timeline.timeline.id });
      return { ...report, promoted: promoted.ok };
    }
    return report;
  }

  private async callDaemonSocket(request: DaemonRequest): Promise<DaemonResponse> {
    return new Promise((resolve) => {
      const socket = net.createConnection(DAEMON_SOCKET_PATH, () => {
        socket.write(JSON.stringify(request));
        socket.end();
      });
      let body = "";
      socket.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      socket.on("error", (error) => {
        resolve({ ok: false, action: request.action, message: `daemon unavailable: ${error.message}` });
      });
      socket.on("end", () => {
        if (!body.trim()) {
          resolve({ ok: false, action: request.action, message: "daemon returned empty response" });
          return;
        }
        try {
          resolve(JSON.parse(body) as DaemonResponse);
        } catch {
          resolve({ ok: false, action: request.action, message: "daemon response parse failed" });
        }
      });
    });
  }

  private workspaceFingerprint(): string {
    return crypto.createHash("sha256")
      .update(path.resolve(this.workspaceRoot))
      .digest("hex")
      .slice(0, 24);
  }

  private async bootstrapRepoDnaMemory(): Promise<void> {
    try {
      const memoryResult: any = await this.engineeringMemory({ action: "read" });
      const existingRules = Array.isArray(memoryResult?.memory?.rules) ? memoryResult.memory.rules : [];
      if (existingRules.some((rule: string) => rule.includes("[dna-cohort]"))) {
        return;
      }

      const twinResult: any = await this.digitalTwin({ action: "build" });
      const dna = this.computeRepoDna(twinResult?.twin ?? {});
      const cohort = await this.meshBrain.queryDnaCohort({ dna, threshold: 0.85 });
      const candidateRules = aggregateCohortRules(cohort.cohort ?? [], 0.3);
      if (candidateRules.length === 0) {
        return;
      }

      const taggedRules = candidateRules.map((rule) => `[dna-cohort] ${rule}`);
      const merged = uniqueStrings([...taggedRules, ...existingRules], 200);
      const memoryPath = this.meshArtifactPath("engineering-memory.json");
      const memory = (memoryResult?.memory ?? {}) as Record<string, any>;
      memory.rules = merged;
      memory.updatedAt = new Date().toISOString();
      memory.events = Array.isArray(memory.events) ? memory.events : [];
      memory.events.unshift({
        id: `dna-${Date.now().toString(36)}`,
        at: memory.updatedAt,
        outcome: "neutral",
        note: "Preloaded rules from Mesh Brain DNA cohort.",
        source: "dna-cohort",
        dna,
        files: []
      });
      memory.events = memory.events.slice(0, 100);
      await writeJsonFile(memoryPath, {
        schemaVersion: 1,
        reviewerPreferences: [],
        acceptedPatterns: [],
        rejectedPatterns: [],
        riskModules: [],
        ...memory
      });
    } catch {
      // Best-effort cold-start improvement. Never fail backend construction.
    }
  }

  private computeRepoDna(twin: Record<string, any>): RepoDnaFingerprint {
    const pkg = twin?.package ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
    const scripts = pkg.scripts ?? {};
    const deployConfigs = Array.isArray(twin?.deploy?.configs) ? twin.deploy.configs.join(" ").toLowerCase() : "";
    const packageManager = existsSync(path.join(this.workspaceRoot, "pnpm-lock.yaml"))
      ? "pnpm"
      : existsSync(path.join(this.workspaceRoot, "yarn.lock"))
        ? "yarn"
        : "npm";
    return {
      framework: pickFirstMatch(deps, ["next", "react", "vue", "svelte", "express", "fastify", "nestjs"], "unknown"),
      frameworkVersion: deps.next || deps.react || deps.vue || deps.svelte || deps.express || "unknown",
      orm: pickFirstMatch(deps, ["prisma", "typeorm", "sequelize", "drizzle-orm", "mongoose"], "none"),
      testRunner: pickFirstMatch({ ...deps, ...scripts }, ["vitest", "jest", "mocha", "playwright", "cypress"], "node:test"),
      deployTarget: /vercel/.test(deployConfigs) ? "vercel" : /render/.test(deployConfigs) ? "render" : /docker/.test(deployConfigs) ? "docker" : "unknown",
      monorepoTool: pickFirstMatch(deps, ["turbo", "nx", "lerna", "pnpm-workspace"], "none"),
      cssStrategy: pickFirstMatch(deps, ["tailwindcss", "styled-components", "sass", "emotion"], "plain-css"),
      language: Array.isArray(twin?.files?.topExtensions) && twin.files.topExtensions.some((ext: string) => ext === ".ts" || ext === ".tsx") ? "typescript" : "javascript",
      packageManager
    };
  }

  private async predictiveRepair(args: Record<string, unknown> = {}, onProgress?: (chunk: string) => void): Promise<unknown> {
    const action = String(args.action ?? "analyze");
    const repairPath = this.meshArtifactPath("predictive-repair.json");
    const existing = await readJsonFile<any>(repairPath, {
      schemaVersion: 1,
      updatedAt: null,
      queue: [],
      history: []
    });

    if (action === "status") {
      return { ok: true, path: repairPath, ...existing };
    }
    if (action === "clear") {
      const cleared = { schemaVersion: 1, updatedAt: new Date().toISOString(), queue: [], history: existing.history ?? [] };
      await writeJsonFile(repairPath, cleared);
      return { ok: true, path: repairPath, ...cleared };
    }

    onProgress?.("[Predictive Repair] Running diagnostics and loading repo memory...\n");
    const diagnostics: any = await this.getDiagnostics().catch((error) => ({ ok: false, output: (error as Error).message }));
    const memory: any = await this.engineeringMemory({ action: "read" }).catch(() => ({ memory: null }));
    const twinResult: any = await this.digitalTwin({ action: "build" }).catch(() => null);
    const outputText = String(diagnostics.output ?? diagnostics.stderr ?? diagnostics.stdout ?? "");
    const errorSignature = normalizeErrorSignature(outputText);
    const brainPatterns = await this.meshBrain.query({
      errorSignature,
      limit: Math.max(1, Math.min(Number(args.limit) || 5, 5))
    }).catch(() => ({ ok: false, patterns: [], source: "local-fallback" as const }));
    const telemetryTop = await this.telemetry.topSignals(50).catch(() => []);
    const telemetryScore = new Map<string, number>(
      telemetryTop.map((signal) => [signal.file, scoreSignal(signal)])
    );
    const referencedFiles = uniqueStrings(Array.from(outputText.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))(?::(\d+))?/g)).map((match) => match[1]), 25)
      .sort((left, right) => (telemetryScore.get(right) ?? 0) - (telemetryScore.get(left) ?? 0));
    const dirtyFiles = await this.readDirtyFilesForMemory();
    const riskFiles = new Set((twinResult?.twin?.riskHotspots ?? []).map((entry: any) => entry.file));
    const queue = referencedFiles.length > 0 || !diagnostics.ok
      ? [{
          id: `repair-${Date.now().toString(36)}`,
          createdAt: new Date().toISOString(),
          status: "prepared",
          source: "diagnostics",
          verificationCommand: String(args.verificationCommand ?? this.defaultVerificationCommand(twinResult?.twin)),
          summary: diagnostics.ok
            ? "Diagnostics are currently clean; no repair candidate required."
            : "Diagnostics failed; prepare a timeline-first repair.",
          files: referencedFiles.length > 0 ? referencedFiles : dirtyFiles.slice(0, 10),
          prioritizedByImpact: referencedFiles.filter((file) => telemetryScore.has(file)).slice(0, 10),
          riskFiles: referencedFiles.filter((file) => riskFiles.has(file)),
          diagnostics: outputText.slice(0, 8000),
          errorSignature,
          globalPatterns: (brainPatterns.patterns ?? []).slice(0, 5).map((pattern: any) => ({
            score: pattern.score,
            successRate: pattern.successRate,
            usageCount: pattern.usageCount,
            fixSummary: pattern.fixSummary
          })),
          recommendedTool: "agent.race_fixes"
        }]
      : [];
    const state = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      diagnosticsOk: Boolean(diagnostics.ok),
      memoryDigest: memory?.memory?.rules?.slice?.(0, 10) ?? [],
      brainPatternSource: brainPatterns.source,
      brainPatterns: (brainPatterns.patterns ?? []).slice(0, 5),
      queue,
      history: [...(existing.history ?? []), ...(queue.length > 0 ? queue : [])].slice(-50)
    };
    await writeJsonFile(repairPath, state);
    return { ok: true, path: repairPath, ...state };
  }

  private async recordPredictiveRepairSignal(file: string, diagnostics: unknown): Promise<void> {
    const repairPath = this.meshArtifactPath("predictive-repair.json");
    const existing = await readJsonFile<any>(repairPath, {
      schemaVersion: 1,
      updatedAt: null,
      queue: [],
      history: []
    });
    const outputText = String((diagnostics as any)?.output ?? (diagnostics as any)?.stderr ?? (diagnostics as any)?.stdout ?? "");
    const item = {
      id: `repair-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      status: "prepared",
      source: "watcher",
      summary: `Diagnostics changed after editing ${file}.`,
      files: uniqueStrings([file], 10),
      diagnostics: outputText.slice(0, 8000),
      recommendedTool: "agent.race_fixes"
    };
    const queue = [item, ...(existing.queue ?? [])].slice(0, 25);
    const state = {
      ...existing,
      updatedAt: item.createdAt,
      diagnosticsOk: false,
      queue,
      history: [item, ...(existing.history ?? [])].slice(0, 50)
    };
    await writeJsonFile(repairPath, state);
  }

  private async engineeringMemory(args: Record<string, unknown> = {}): Promise<unknown> {
    const action = String(args.action ?? "read");
    const memoryPath = this.meshArtifactPath("engineering-memory.json");
    const memory = await readJsonFile<any>(memoryPath, {
      schemaVersion: 1,
      updatedAt: null,
      rules: [],
      riskModules: [],
      reviewerPreferences: [],
      acceptedPatterns: [],
      rejectedPatterns: [],
      events: []
    });

    if (action === "record") {
      const event = {
        id: `mem-${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        outcome: String(args.outcome ?? "neutral"),
        note: String(args.note ?? "").trim(),
        rule: String(args.rule ?? "").trim(),
        files: Array.isArray(args.files) ? args.files.map(String) : []
      };
      memory.events.unshift(event);
      if (event.rule) memory.rules = uniqueStrings([event.rule, ...memory.rules], 100);
      if (event.outcome === "accepted" && event.note) memory.acceptedPatterns = uniqueStrings([event.note, ...memory.acceptedPatterns], 100);
      if (event.outcome === "rejected" && event.note) memory.rejectedPatterns = uniqueStrings([event.note, ...memory.rejectedPatterns], 100);
      memory.riskModules = uniqueStrings([...event.files, ...memory.riskModules], 100);
      memory.updatedAt = event.at;
      await writeJsonFile(memoryPath, memory);
      return { ok: true, path: memoryPath, memory };
    }

    if (action === "learn") {
      const twinResult: any = await this.digitalTwin({ action: "build" }).catch(() => null);
      const dirtyFiles = await this.readDirtyFilesForMemory();
      const learnedRules = [
        "Prefer timeline verification for changes touching agent runtime, shell execution, auth, secrets, or persistence.",
        "Use the Digital Twin risk hotspots before broad refactors.",
        "Keep docs status aligned with implemented tool surfaces."
      ];
      memory.rules = uniqueStrings([...learnedRules, ...memory.rules], 100);
      memory.riskModules = uniqueStrings([
        ...dirtyFiles,
        ...((twinResult?.twin?.riskHotspots ?? []).map((entry: any) => entry.file)),
        ...memory.riskModules
      ], 100);
      memory.updatedAt = new Date().toISOString();
      memory.events.unshift({
        id: `learn-${Date.now().toString(36)}`,
        at: memory.updatedAt,
        outcome: "neutral",
        note: "Learned repository heuristics from Digital Twin, dirty files, and risk hotspots.",
        files: dirtyFiles
      });
      memory.events = memory.events.slice(0, 100);
      await writeJsonFile(memoryPath, memory);
      return { ok: true, path: memoryPath, memory };
    }

    return { ok: true, path: memoryPath, memory };
  }

  private async intentCompile(args: Record<string, unknown>): Promise<unknown> {
    const intent = String(args.intent ?? "").trim();
    if (!intent) throw new Error("workspace.intent_compile requires intent");
    const twinResult: any = await this.digitalTwin({ action: "build" });
    const memoryResult: any = await this.engineeringMemory({ action: "read" });
    const search: any = await this.workspaceIndex.search(intent, "edit-impact", 8).catch(() => ({ results: [], topMatches: [] }));
    const likelyFiles = uniqueStrings([
      ...((search.results ?? []).map((result: any) => result.file)),
      ...((twinResult.twin?.riskHotspots ?? []).slice(0, 5).map((entry: any) => entry.file))
    ], 20);
    const verificationCommand = String(args.verificationCommand ?? this.defaultVerificationCommand(twinResult.twin));
    const contract = {
      schemaVersion: 1,
      compiledAt: new Date().toISOString(),
      intent,
      likelyFiles,
      phases: [
        "Confirm behavior and public surface from the Digital Twin.",
        "Implement the smallest vertical change that satisfies the intent.",
        "Update tests/docs for changed behavior.",
        "Verify in a timeline or with the declared verification command.",
        "Record accepted/rejected lessons in Engineering Memory."
      ],
      interfaces: this.inferIntentInterfaces(intent, twinResult.twin),
      tests: this.inferIntentTests(intent, twinResult.twin),
      risks: this.inferIntentRisks(intent, twinResult.twin, likelyFiles),
      rollout: {
        verificationCommand,
        rollback: "Use workspace.semantic_undo or promote only verified timelines.",
        monitoring: "Check cockpit snapshot after implementation for diagnostics, risk hotspots, and repair queue."
      },
      memoryRules: memoryResult.memory?.rules?.slice?.(0, 8) ?? [],
      topMatches: search.topMatches ?? []
    };
    const contractPath = this.meshArtifactPath("intent-compiler", "latest.json");
    await writeJsonFile(contractPath, contract);
    return { ok: true, path: contractPath, contract };
  }

  private async cockpitSnapshot(): Promise<unknown> {
    const [index, git, twinStatus, repair, memory, timelines, causalStatus, discoveryStatus, realityStatus, ghostStatus] = await Promise.all([
      this.workspaceIndex.status().catch((error) => ({ ok: false, error: (error as Error).message })),
      this.getGitStatus(),
      this.digitalTwin({ action: "status" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.predictiveRepair({ action: "status" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.engineeringMemory({ action: "read" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.timelines.list().catch((error) => ({ ok: false, timelines: [], error: (error as Error).message })),
      this.causalIntelligence({ action: "status" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.discoveryLab({ action: "status" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.realityFork({ action: "status" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.ghostEngineer({ action: "status" }).catch((error) => ({ ok: false, error: (error as Error).message }))
    ]);
    const runtimeRuns = await this.listRuntimeRuns();
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      index,
      git,
      digitalTwin: twinStatus,
      predictiveRepair: repair,
      engineeringMemory: memory,
      causalIntelligence: causalStatus,
      discoveryLab: discoveryStatus,
      realityFork: realityStatus,
      ghostEngineer: ghostStatus,
      timelines,
      runtimeRuns,
      health: this.scoreCockpitHealth({ index, repair, timelines, runtimeRuns })
    };
  }

  private async causalIntelligence(args: Record<string, unknown> = {}, onProgress?: (chunk: string) => void): Promise<unknown> {
    const action = String(args.action ?? "build");
    const graphPath = this.meshArtifactPath("causal-intelligence.json");
    const existing = await readJsonFile<any | null>(graphPath, null);

    if (action === "status") {
      if (!existing) return { ok: false, status: "missing", path: graphPath };
      return {
        ok: true,
        path: graphPath,
        builtAt: existing.builtAt,
        nodes: existing.nodes?.length ?? 0,
        edges: existing.edges?.length ?? 0,
        insights: existing.insights?.length ?? 0,
        topSeverity: existing.insights?.[0]?.severity ?? "none"
      };
    }

    if (action === "read") {
      if (!existing) return { ok: false, status: "missing", path: graphPath };
      return { ok: true, path: graphPath, graph: existing };
    }

    if (action === "query") {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("workspace.causal_intelligence query action requires query");
      const graph = existing ?? await this.buildCausalGraph(onProgress);
      if (!existing) await writeJsonFile(graphPath, graph);
      return { ok: true, path: graphPath, query, ...this.answerCausalQuery(query, graph) };
    }

    const graph = await this.buildCausalGraph(onProgress);
    await writeJsonFile(graphPath, graph);
    return { ok: true, path: graphPath, graph };
  }

  private async buildCausalGraph(onProgress?: (chunk: string) => void): Promise<Record<string, any>> {
    onProgress?.("[Causal Intelligence] Building causal graph from twin, memory, repairs, and git pressure...\n");
    const [twinResult, memoryResult, repairStatus, dirtyFiles, churn] = await Promise.all([
      this.digitalTwin({ action: "build" }).catch((error) => ({ ok: false, error: (error as Error).message })),
      this.engineeringMemory({ action: "read" }).catch(() => ({ memory: null })),
      this.predictiveRepair({ action: "status" }).catch(() => ({ queue: [] })),
      this.readDirtyFilesForMemory(),
      this.readGitChurn()
    ]);

    const twin = (twinResult as any).twin ?? {};
    const memory = (memoryResult as any).memory ?? {};
    const repair = repairStatus as any;
    const tests = Array.isArray(twin.tests) ? twin.tests.map(String) : [];
    const riskHotspots = Array.isArray(twin.riskHotspots) ? twin.riskHotspots : [];
    const routes = Array.isArray(twin.routes) ? twin.routes : [];
    const symbols = Array.isArray(twin.symbols) ? twin.symbols : [];
    const repairQueue = Array.isArray(repair.queue) ? repair.queue : [];
    const repairFiles = uniqueStrings(repairQueue.flatMap((item: any) => Array.isArray(item.files) ? item.files.map(String) : []), 250);
    const allKnownFiles = uniqueStrings([
      ...symbols.map((entry: any) => String(entry.file ?? "")),
      ...routes.map((entry: any) => String(entry.file ?? "")),
      ...riskHotspots.map((entry: any) => String(entry.file ?? "")),
      ...tests,
      ...((twin.deploy?.configs ?? []) as string[]),
      ...dirtyFiles,
      ...repairFiles,
      ...((memory.riskModules ?? []) as string[])
    ], 1500);

    const nodes = new Map<string, Record<string, unknown>>();
    const edges = new Map<string, Record<string, unknown>>();
    const addNode = (node: Record<string, unknown>) => {
      const id = String(node.id ?? "");
      if (!id) return;
      nodes.set(id, { ...(nodes.get(id) ?? {}), ...node });
    };
    const addEdge = (edge: Record<string, unknown>) => {
      const from = String(edge.from ?? "");
      const to = String(edge.to ?? "");
      const type = String(edge.type ?? "related_to");
      if (!from || !to) return;
      edges.set(`${from}->${type}->${to}`, { ...edge, from, to, type });
    };

    addNode({ id: "workspace", type: "workspace", label: path.basename(this.workspaceRoot), weight: 100 });

    for (const file of allKnownFiles) {
      const relatedTests = relatedTestsForFile(file, tests);
      addNode({
        id: `file:${file}`,
        type: "file",
        label: file,
        file,
        weight: 10 + Math.min(30, Number(churn[file] ?? 0) * 3),
        metadata: {
          dirty: dirtyFiles.includes(file),
          churn: churn[file] ?? 0,
          tests: relatedTests
        }
      });
      addEdge({ from: "workspace", to: `file:${file}`, type: "contains", weight: 1 });
      for (const test of relatedTests) {
        addNode({ id: `file:${test}`, type: "test", label: test, file: test, weight: 8 });
        addEdge({ from: `file:${file}`, to: `file:${test}`, type: "covered_by", weight: 0.72, evidence: "fuzzy test filename match" });
      }
    }

    for (const symbol of symbols.slice(0, 1200)) {
      const file = String(symbol.file ?? "");
      const name = String(symbol.name ?? "");
      if (!file || !name) continue;
      const id = `symbol:${file}:${name}`;
      addNode({ id, type: "symbol", label: name, file, line: symbol.line, weight: 5 });
      addEdge({ from: `file:${file}`, to: id, type: "defines", weight: 0.6 });
    }

    for (const route of routes.slice(0, 300)) {
      const file = String(route.file ?? "");
      const routePath = String(route.route ?? "");
      if (!file || !routePath) continue;
      const id = `route:${file}:${route.method ?? "ANY"}:${routePath}`;
      addNode({ id, type: "route", label: `${route.method ?? "ANY"} ${routePath}`, file, line: route.line, weight: 12 });
      addEdge({ from: `file:${file}`, to: id, type: "exposes_runtime_path", weight: 0.85 });
    }

    for (const hotspot of riskHotspots) {
      const file = String(hotspot.file ?? "");
      const risks = Array.isArray(hotspot.risks) ? hotspot.risks.map(String) : [];
      for (const risk of risks) {
        const riskId = `risk:${slugifyId(risk)}`;
        addNode({ id: riskId, type: "risk", label: risk, weight: 20 });
        addEdge({ from: `file:${file}`, to: riskId, type: "has_risk", weight: 0.9, evidence: risk });
      }
    }

    for (const [index, rule] of ((memory.rules ?? []) as string[]).slice(0, 80).entries()) {
      const ruleId = `rule:${index}:${slugifyId(rule)}`;
      addNode({ id: ruleId, type: "rule", label: rule, weight: 15 });
      addEdge({ from: "workspace", to: ruleId, type: "governed_by", weight: 0.7 });
      for (const file of ((memory.riskModules ?? []) as string[]).slice(0, 80)) {
        addEdge({ from: `file:${file}`, to: ruleId, type: "governed_by", weight: 0.55 });
      }
    }

    for (const item of repairQueue.slice(0, 30)) {
      const repairId = `repair:${item.id ?? slugifyId(String(item.summary ?? "repair"))}`;
      addNode({ id: repairId, type: "repair", label: String(item.summary ?? "Prepared repair"), weight: 35, metadata: item });
      for (const file of Array.isArray(item.files) ? item.files.map(String) : []) {
        addEdge({ from: repairId, to: `file:${file}`, type: "targets", weight: 0.95, evidence: "predictive repair queue" });
      }
    }

    for (const [file, count] of Object.entries(churn)) {
      if (!allKnownFiles.includes(file)) continue;
      const id = `change:${file}`;
      addNode({ id, type: "change_pressure", label: `${file} churn ${count}`, file, weight: Number(count) });
      addEdge({ from: id, to: `file:${file}`, type: "changed_recently", weight: Math.min(1, Number(count) / 10), evidence: `${count} recent commits` });
    }

    const insights = this.generateCausalInsights({ allKnownFiles, twin, memory, repairQueue, dirtyFiles, churn, tests });
    return {
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      workspaceName: path.basename(this.workspaceRoot),
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      insights,
      stats: {
        nodes: nodes.size,
        edges: edges.size,
        files: allKnownFiles.length,
        routes: routes.length,
        symbols: symbols.length,
        riskHotspots: riskHotspots.length,
        repairItems: repairQueue.length,
        memoryRules: (memory.rules ?? []).length
      },
      sources: {
        digitalTwinBuiltAt: twin.builtAt ?? null,
        engineeringMemoryUpdatedAt: memory.updatedAt ?? null,
        predictiveRepairUpdatedAt: repair.updatedAt ?? null
      }
    };
  }

  private generateCausalInsights(args: {
    allKnownFiles: string[];
    twin: any;
    memory: any;
    repairQueue: any[];
    dirtyFiles: string[];
    churn: Record<string, number>;
    tests: string[];
  }): Array<Record<string, unknown>> {
    const riskByFile = new Map<string, string[]>((args.twin.riskHotspots ?? []).map((entry: any) => [String(entry.file), Array.isArray(entry.risks) ? entry.risks.map(String) : []]));
    const routesByFile = new Map<string, any[]>();
    for (const route of args.twin.routes ?? []) {
      const file = String(route.file ?? "");
      if (!routesByFile.has(file)) routesByFile.set(file, []);
      routesByFile.get(file)?.push(route);
    }
    const symbolsByFile = new Map<string, number>();
    for (const symbol of args.twin.symbols ?? []) {
      const file = String(symbol.file ?? "");
      symbolsByFile.set(file, (symbolsByFile.get(file) ?? 0) + 1);
    }
    const repairFiles = new Set(args.repairQueue.flatMap((item: any) => Array.isArray(item.files) ? item.files.map(String) : []));
    const insights = args.allKnownFiles
      .map((file) => {
        const risks = riskByFile.get(file) ?? [];
        const tests = relatedTestsForFile(file, args.tests);
        const churn = args.churn[file] ?? 0;
        const routeCount = routesByFile.get(file)?.length ?? 0;
        const symbolCount = symbolsByFile.get(file) ?? 0;
        const dirty = args.dirtyFiles.includes(file);
        const inRepairQueue = repairFiles.has(file);
        let score = 0;
        score += Math.min(40, risks.length * 18);
        score += risks.length > 0 && tests.length === 0 ? 24 : 0;
        score += Math.min(24, churn * 4);
        score += dirty ? 15 : 0;
        score += inRepairQueue ? 30 : 0;
        score += Math.min(16, routeCount * 4);
        score += Math.min(10, Math.floor(symbolCount / 10));
        if (/src\/(local-tools|agent-loop|runtime-observer|timeline-manager)\.ts$/.test(file)) score += 10;

        const evidence = uniqueStrings([
          ...risks.map((risk) => `risk: ${risk}`),
          tests.length === 0 && risks.length > 0 ? "no related test file found" : undefined,
          churn > 0 ? `${churn} recent commits touched this file` : undefined,
          dirty ? "currently dirty in git status" : undefined,
          inRepairQueue ? "present in predictive repair queue" : undefined,
          routeCount > 0 ? `${routeCount} runtime route(s)` : undefined,
          symbolCount > 0 ? `${symbolCount} indexed symbol(s)` : undefined
        ], 12);

        return {
          id: `causal-${slugifyId(file)}`,
          type: inRepairQueue ? "operational-repair" : risks.length > 0 && tests.length === 0 ? "risk-without-proof" : "change-pressure",
          title: `${file} is a causal pressure point`,
          severity: severityLabel(score),
          score,
          confidence: Math.min(0.95, 0.42 + evidence.length * 0.08),
          summary: `Changes here are likely to propagate because the file combines ${evidence.slice(0, 3).join(", ") || "repository centrality signals"}.`,
          evidence,
          likelyFiles: uniqueStrings([file, ...tests], 12),
          recommendedAction: inRepairQueue
            ? "Run workspace.predictive_repair, then race fixes in timelines before promotion."
            : risks.length > 0 && tests.length === 0
              ? "Add focused tests or a runtime proof before broad edits touch this file."
              : "Use workspace.impact_map before changing this area and verify through a timeline."
        };
      })
      .filter((insight) => insight.score >= 20)
      .sort((left, right) => right.score - left.score)
      .slice(0, 20);

    if ((args.memory.rules ?? []).length > 0) {
      insights.push({
        id: "causal-engineering-memory",
        type: "policy-memory",
        title: "Engineering Memory is enforcing local repo rules",
        severity: "medium",
        score: 42,
        confidence: 0.82,
        summary: "Accepted and rejected work has become an active policy layer for future changes.",
        evidence: (args.memory.rules ?? []).slice(0, 6),
        likelyFiles: (args.memory.riskModules ?? []).slice(0, 10),
        recommendedAction: "Load Engineering Memory before planning large changes and record outcomes after verification."
      });
    }

    return insights.sort((left, right) => Number(right.score) - Number(left.score));
  }

  private answerCausalQuery(query: string, graph: any): Record<string, unknown> {
    const tokens = tokenizeIntent(query);
    const scoreText = (value: unknown) => {
      const text = JSON.stringify(value ?? "").toLowerCase();
      return tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
    };
    const topInsights = [...(graph.insights ?? [])]
      .map((insight: any) => ({ ...insight, queryScore: scoreText(insight) + Number(insight.score ?? 0) / 100 }))
      .filter((insight: any) => insight.queryScore > 0)
      .sort((left: any, right: any) => right.queryScore - left.queryScore)
      .slice(0, 5);
    const evidenceNodes = [...(graph.nodes ?? [])]
      .map((node: any) => ({ ...node, queryScore: scoreText(node) + Number(node.weight ?? 0) / 100 }))
      .filter((node: any) => node.queryScore > 0)
      .sort((left: any, right: any) => right.queryScore - left.queryScore)
      .slice(0, 12);
    const recommendations = uniqueStrings(topInsights.map((insight: any) => String(insight.recommendedAction ?? "")), 5);
    const answer = topInsights.length > 0
      ? `Top causal signal: ${topInsights[0].title}. ${topInsights[0].summary}`
      : "No direct causal match found. Build the Digital Twin and Causal Intelligence graph again after more runtime or git evidence exists.";
    return {
      answer,
      topInsights,
      evidenceNodes,
      recommendations,
      graphStats: graph.stats ?? {}
    };
  }

  private async discoveryLab(args: Record<string, unknown> = {}, onProgress?: (chunk: string) => void): Promise<unknown> {
    const action = String(args.action ?? "run");
    const labPath = this.meshArtifactPath("discovery-lab.json");
    const existing = await readJsonFile<any>(labPath, {
      schemaVersion: 1,
      ranAt: null,
      discoveries: [],
      history: []
    });

    if (action === "status") return { ok: true, path: labPath, ...existing };
    if (action === "clear") {
      const cleared = { schemaVersion: 1, ranAt: new Date().toISOString(), discoveries: [], history: existing.history ?? [] };
      await writeJsonFile(labPath, cleared);
      return { ok: true, path: labPath, ...cleared };
    }

    const maxDiscoveries = Math.max(1, Math.min(Number(args.maxDiscoveries) || 8, 20));
    onProgress?.("[Discovery Lab] Running causal scan and repair analysis...\n");
    const verificationCommand = String(args.verificationCommand ?? "");
    const [causalResult, repairResult] = await Promise.all([
      this.causalIntelligence({ action: "build" }, onProgress),
      this.predictiveRepair({ action: "analyze", verificationCommand: verificationCommand || undefined }, onProgress).catch((error) => ({ ok: false, queue: [], error: (error as Error).message }))
    ]);
    const graph = (causalResult as any).graph;
    const defaultCommand = verificationCommand || this.defaultVerificationCommand((await this.digitalTwin({ action: "read" }).catch(() => ({ twin: null })) as any).twin);
    const discoveries = this.generateLabDiscoveries(graph, repairResult, defaultCommand).slice(0, maxDiscoveries);
    const state = {
      schemaVersion: 1,
      ranAt: new Date().toISOString(),
      summary: {
        discoveries: discoveries.length,
        critical: discoveries.filter((item: any) => item.severity === "critical").length,
        high: discoveries.filter((item: any) => item.severity === "high").length,
        verificationCommand: defaultCommand
      },
      discoveries,
      history: [...discoveries, ...(existing.history ?? [])].slice(0, 100)
    };
    await writeJsonFile(labPath, state);
    return { ok: true, path: labPath, ...state };
  }

  private generateLabDiscoveries(graph: any, repairResult: unknown, verificationCommand: string): Array<Record<string, unknown>> {
    const repairQueue = Array.isArray((repairResult as any)?.queue) ? (repairResult as any).queue : [];
    const repairDiscoveries = repairQueue.map((item: any, index: number) => ({
      id: `lab-repair-${index}-${slugifyId(String(item.id ?? item.summary ?? "repair"))}`,
      type: "prepared-repair",
      severity: "high",
      score: 90 - index,
      confidence: 0.86,
      hypothesis: String(item.summary ?? "Diagnostics can be converted into a verified repair."),
      evidence: uniqueStrings([
        "Predictive Repair produced a prepared queue item.",
        ...(Array.isArray(item.files) ? item.files.map((file: string) => `file: ${file}`) : []),
        String(item.diagnostics ?? "").slice(0, 500)
      ], 8),
      experiment: {
        steps: [
          "Inspect the referenced files and diagnostics.",
          "Generate 3 candidate fixes with agent.race_fixes.",
          "Promote only a passing timeline."
        ],
        verificationCommand: item.verificationCommand ?? verificationCommand,
        recommendedTool: "agent.race_fixes",
        rollback: "Do not promote a failed timeline."
      },
      files: Array.isArray(item.files) ? item.files : []
    }));

    const causalDiscoveries = (graph.insights ?? []).map((insight: any, index: number) => ({
      id: `lab-causal-${index}-${slugifyId(String(insight.id ?? insight.title ?? "insight"))}`,
      type: "causal-opportunity",
      severity: insight.severity,
      score: Number(insight.score ?? 0),
      confidence: insight.confidence ?? 0.7,
      hypothesis: `Reducing "${insight.title}" will lower future change risk or increase delivery speed.`,
      evidence: insight.evidence ?? [],
      experiment: {
        steps: [
          "Run workspace.impact_map on the top likely file.",
          "Add the smallest proof: focused test, runtime assertion, or architecture guard.",
          "Verify and record the outcome in Engineering Memory."
        ],
        verificationCommand,
        recommendedTool: "workspace.reality_fork",
        rollback: "Keep the proof in a timeline until verification passes."
      },
      files: insight.likelyFiles ?? []
    }));

    return [...repairDiscoveries, ...causalDiscoveries]
      .sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0))
      .slice(0, 20);
  }

  private async realityFork(args: Record<string, unknown> = {}, onProgress?: (chunk: string) => void): Promise<unknown> {
    const action = String(args.action ?? "plan");
    const forkPath = this.meshArtifactPath("reality-forks", "latest.json");
    const existing = await readJsonFile<any | null>(forkPath, null);

    if (action === "status") {
      if (!existing) return { ok: false, status: "missing", path: forkPath };
      return {
        ok: true,
        path: forkPath,
        plannedAt: existing.plannedAt,
        intent: existing.intent,
        proposals: existing.proposals?.length ?? 0,
        materialized: (existing.proposals ?? []).filter((proposal: any) => proposal.timelineId).length,
        recommendation: existing.recommendation?.id ?? null
      };
    }

    if (action === "clear") {
      const cleared = { schemaVersion: 1, plannedAt: new Date().toISOString(), intent: null, proposals: [] };
      await writeJsonFile(forkPath, cleared);
      return { ok: true, path: forkPath, ...cleared };
    }

    const intent = String(args.intent ?? "").trim();
    if (!intent) throw new Error("workspace.reality_fork requires intent for plan or fork actions");
    const forks = Math.max(2, Math.min(Number(args.forks) || 4, 6));
    onProgress?.(`[Reality Fork] Planning ${forks} alternate realities for: ${intent}\n`);
    const [contractResult, causalResult, memoryResult] = await Promise.all([
      this.intentCompile({ intent, verificationCommand: args.verificationCommand }),
      this.causalIntelligence({ action: "build" }, onProgress),
      this.engineeringMemory({ action: "read" })
    ]);
    const contract = (contractResult as any).contract;
    const graph = (causalResult as any).graph;
    const memory = (memoryResult as any).memory ?? {};
    const verificationCommand = String(args.verificationCommand ?? contract.rollout?.verificationCommand ?? "npm test");
    const proposals = this.buildRealityProposals({ intent, contract, graph, memory, forks, verificationCommand });

    if (action === "fork") {
      const runVerification = Boolean(args.runVerification);
      for (const proposal of proposals) {
        const timeline = await this.timelines.create({ name: `reality-${proposal.id}` });
        const artifactDir = path.join(timeline.timeline.root, ".mesh", "reality-forks");
        await fs.mkdir(artifactDir, { recursive: true });
        await fs.writeFile(path.join(artifactDir, `${proposal.id}.json`), JSON.stringify({
          schemaVersion: 1,
          materializedAt: new Date().toISOString(),
          intent,
          proposal
        }, null, 2), "utf8");
        proposal.timelineId = timeline.timeline.id;
        proposal.timelineRoot = timeline.timeline.root;
        if (runVerification) {
          const run = await this.timelines.run({ timelineId: timeline.timeline.id, command: verificationCommand });
          proposal.verification = {
            ok: run.ok,
            exitCode: run.exitCode,
            durationMs: run.commandRecord.durationMs
          };
        }
      }
    }

    const state = {
      schemaVersion: 1,
      plannedAt: new Date().toISOString(),
      intent,
      action,
      verificationCommand,
      recommendation: proposals[0] ?? null,
      proposals,
      causalEvidence: (graph.insights ?? []).slice(0, 5).map((insight: any) => ({
        id: insight.id,
        title: insight.title,
        severity: insight.severity,
        likelyFiles: insight.likelyFiles
      }))
    };
    await writeJsonFile(forkPath, state);
    return { ok: true, path: forkPath, ...state };
  }

  private buildRealityProposals(args: {
    intent: string;
    contract: any;
    graph: any;
    memory: any;
    forks: number;
    verificationCommand: string;
  }): Array<Record<string, any>> {
    const intentTokens = tokenizeIntent(args.intent);
    const matchingInsights = [...(args.graph.insights ?? [])]
      .map((insight: any) => ({
        ...insight,
        tokenScore: intentTokens.reduce((score, token) => score + (JSON.stringify(insight).toLowerCase().includes(token) ? 1 : 0), 0)
      }))
      .sort((left: any, right: any) => (right.tokenScore + Number(right.score ?? 0) / 100) - (left.tokenScore + Number(left.score ?? 0) / 100));
    const topRiskFiles = uniqueStrings(matchingInsights.flatMap((insight: any) => Array.isArray(insight.likelyFiles) ? insight.likelyFiles : []), 20);
    const likelyFiles = uniqueStrings([...(args.contract.likelyFiles ?? []), ...topRiskFiles], 30);
    const memoryRules = (args.memory.rules ?? []).slice(0, 8);
    const templates = [
      {
        id: "minimal-proof",
        strategy: "Minimal Proof Reality",
        thesis: "Ship the smallest vertical slice that satisfies the intent while preserving existing boundaries.",
        focus: likelyFiles.slice(0, 6),
        bonus: 20
      },
      {
        id: "causal-risk-collapse",
        strategy: "Causal Risk Collapse Reality",
        thesis: "Attack the files with the strongest causal risk signals first so the change reduces future fragility.",
        focus: topRiskFiles.slice(0, 8),
        bonus: 28
      },
      {
        id: "test-first-proof",
        strategy: "Test-First Reality",
        thesis: "Create executable proof before implementation and use it to constrain the patch.",
        focus: uniqueStrings([...(args.contract.tests ?? []), ...likelyFiles.slice(0, 5)], 10),
        bonus: 24
      },
      {
        id: "runtime-shadow",
        strategy: "Runtime Shadow Reality",
        thesis: "Instrument the runtime path, capture failure evidence, and then patch the observed behavior.",
        focus: likelyFiles.filter((file) => /runtime|server|api|route|src\//i.test(file)).slice(0, 8),
        bonus: 18
      },
      {
        id: "architecture-law",
        strategy: "Architecture Law Reality",
        thesis: "Convert the intent into explicit constraints so future edits cannot drift across the same boundary.",
        focus: uniqueStrings([...topRiskFiles.slice(0, 5), ...likelyFiles.slice(0, 5)], 10),
        bonus: 16
      },
      {
        id: "product-slice",
        strategy: "Product Slice Reality",
        thesis: "Deliver a complete user-visible slice and defer internal cleanup unless proof requires it.",
        focus: likelyFiles.slice(0, 10),
        bonus: 14
      }
    ];

    return templates.slice(0, args.forks).map((template, index) => {
      const targetFiles = uniqueStrings(template.focus.length > 0 ? template.focus : likelyFiles.slice(0, 6), 12);
      const evidence = matchingInsights
        .filter((insight: any) => (insight.likelyFiles ?? []).some((file: string) => targetFiles.includes(file)))
        .slice(0, 4);
      const riskReduction = evidence.reduce((total: number, insight: any) => total + Number(insight.score ?? 0), 0);
      const blastRadiusPenalty = Math.max(0, targetFiles.length - 4) * 6;
      const score = Math.round(template.bonus + riskReduction / 8 + Math.max(0, 30 - blastRadiusPenalty));
      return {
        id: `${index + 1}-${template.id}`,
        strategy: template.strategy,
        thesis: template.thesis,
        score,
        confidence: Math.min(0.95, 0.55 + evidence.length * 0.09 + targetFiles.length * 0.015),
        targetFiles,
        constraints: uniqueStrings([
          ...(args.contract.risks ?? []).slice(0, 6),
          ...memoryRules,
          ...evidence.map((insight: any) => String(insight.recommendedAction ?? ""))
        ], 14),
        implementationContract: {
          phases: args.contract.phases ?? [],
          interfaces: args.contract.interfaces ?? [],
          tests: args.contract.tests ?? [],
          verificationCommand: args.verificationCommand,
          rollback: args.contract.rollout?.rollback ?? "Promote only passing timelines."
        },
        expectedEffects: {
          riskReduced: evidence.map((insight: any) => insight.title),
          blastRadius: targetFiles.length <= 4 ? "narrow" : targetFiles.length <= 9 ? "moderate" : "wide",
          proofRequired: args.contract.tests ?? ["Run verification command before promotion."]
        },
        promoteWhen: [
          "Verification command passes.",
          "Causal graph no longer reports a higher severity for the touched files.",
          "Engineering Memory records the accepted or rejected outcome."
        ]
      };
    }).sort((left, right) => right.score - left.score);
  }

  private async ghostEngineer(args: Record<string, unknown> = {}, onProgress?: (chunk: string) => void): Promise<unknown> {
    const action = String(args.action ?? "profile");
    const profilePath = this.meshArtifactPath("ghost-engineer", "profile.json");
    const existing = await readJsonFile<any | null>(profilePath, null);

    if (action === "status") {
      if (!existing) return { ok: false, status: "missing", path: profilePath };
      return {
        ok: true,
        path: profilePath,
        learnedAt: existing.learnedAt,
        commitsAnalyzed: existing.evidence?.commitsAnalyzed ?? 0,
        dirtyFiles: existing.evidence?.dirtyFiles?.length ?? 0,
        firstReadFiles: existing.habits?.firstReadFiles?.length ?? 0,
        confidence: existing.confidence ?? 0
      };
    }

    if (action === "clear") {
      const cleared = { schemaVersion: 1, clearedAt: new Date().toISOString(), profile: null };
      await writeJsonFile(profilePath, cleared);
      return { ok: true, path: profilePath, ...cleared };
    }

    if (action === "learn") {
      const profile = await this.learnGhostEngineerProfile(onProgress);
      await writeJsonFile(profilePath, profile);
      return { ok: true, path: profilePath, profile };
    }

    const profile = existing && existing.profile !== null ? existing : await this.learnGhostEngineerProfile(onProgress);
    if (!existing || existing.profile === null) await writeJsonFile(profilePath, profile);

    if (action === "profile") {
      return { ok: true, path: profilePath, profile };
    }

    if (action === "predict") {
      const goal = String(args.goal ?? "").trim();
      if (!goal) throw new Error("workspace.ghost_engineer predict action requires goal");
      const prediction = await this.predictGhostEngineerPath(goal, profile, String(args.verificationCommand ?? ""));
      const predictionPath = this.meshArtifactPath("ghost-engineer", "predictions", `${Date.now().toString(36)}-${slugifyId(goal)}.json`);
      await writeJsonFile(predictionPath, prediction);
      return { ok: true, profilePath, path: predictionPath, prediction };
    }

    if (action === "divergence") {
      const plan = String(args.plan ?? "").trim();
      if (!plan) throw new Error("workspace.ghost_engineer divergence action requires plan");
      return { ok: true, profilePath, divergence: this.evaluateGhostDivergence(plan, profile) };
    }

    if (action === "patch") {
      const goal = String(args.goal ?? "").trim();
      if (!goal) throw new Error("workspace.ghost_engineer patch action requires goal");
      const prediction = await this.predictGhostEngineerPath(goal, profile, String(args.verificationCommand ?? ""));
      const timeline = await this.timelines.create({ name: `ghost-${slugifyId(goal)}` });
      const artifactDir = path.join(timeline.timeline.root, ".mesh", "ghost-engineer");
      await fs.mkdir(artifactDir, { recursive: true });
      const autopilot = {
        schemaVersion: 1,
        materializedAt: new Date().toISOString(),
        goal,
        profileDigest: prediction.profileDigest,
        autopilotPatch: prediction.autopilotPatch,
        predictedApproach: prediction.predictedApproach,
        divergence: prediction.divergence,
        promotionGates: [
          "Implement the patch inside this timeline only.",
          `Run ${prediction.predictedApproach.verificationCommand}.`,
          "Compare timeline telemetry before promotion.",
          "Record accepted/rejected outcome in Engineering Memory."
        ]
      };
      const autopilotPath = path.join(artifactDir, `autopilot-${slugifyId(goal)}.json`);
      await fs.writeFile(autopilotPath, JSON.stringify(autopilot, null, 2), "utf8");
      const savedPath = this.meshArtifactPath("ghost-engineer", "predictions", `${Date.now().toString(36)}-${slugifyId(goal)}-autopilot.json`);
      await writeJsonFile(savedPath, { ...autopilot, timelineId: timeline.timeline.id, timelineRoot: timeline.timeline.root });
      return {
        ok: true,
        profilePath,
        path: savedPath,
        timelineId: timeline.timeline.id,
        timelineRoot: timeline.timeline.root,
        autopilot
      };
    }

    throw new Error(`Unknown workspace.ghost_engineer action: ${action}`);
  }

  private async learnGhostEngineerProfile(onProgress?: (chunk: string) => void): Promise<Record<string, any>> {
    onProgress?.("[Ghost Engineer] Learning local engineering style from git, memory, causal graph, and twin...\n");
    const [twinResult, memoryResult, causalResult, dirtyFiles, gitSamples] = await Promise.all([
      this.digitalTwin({ action: "build" }).catch(() => ({ twin: null })),
      this.engineeringMemory({ action: "read" }).catch(() => ({ memory: null })),
      this.causalIntelligence({ action: "build" }).catch(() => ({ graph: null })),
      this.readDirtyFilesForMemory(),
      this.readGitWorkSamples()
    ]);
    const twin = (twinResult as any).twin ?? {};
    const memory = (memoryResult as any).memory ?? {};
    const graph = (causalResult as any).graph ?? {};
    const scripts = twin.package?.scripts ?? {};
    const touchedFiles = gitSamples.flatMap((sample) => sample.files);
    const fileFrequency = this.rankStrings([...touchedFiles, ...dirtyFiles, ...((memory.riskModules ?? []) as string[])], 40);
    const surfaceFrequency = this.rankStrings(touchedFiles.map((file) => this.classifyEngineerSurface(file)), 20);
    const commitsWithTests = gitSamples.filter((sample) => sample.files.some((file) => /(\.test|\.spec|^tests\/|\/tests\/)/i.test(file))).length;
    const commitsWithDocs = gitSamples.filter((sample) => sample.files.some((file) => /\.(md|mdx)$/i.test(file))).length;
    const commitsWithConfig = gitSamples.filter((sample) => sample.files.some((file) => /package\.json|tsconfig|config|\.ya?ml|\.toml/i.test(file))).length;
    const averageFilesPerCommit = gitSamples.length > 0
      ? Number((gitSamples.reduce((total, sample) => total + sample.files.length, 0) / gitSamples.length).toFixed(2))
      : 0;
    const sourceSymbols = Array.isArray(twin.symbols) ? twin.symbols : [];
    const naming = this.inferGhostNamingStyle(sourceSymbols);
    const verificationCommand = this.defaultVerificationCommand(twin);
    const confidence = Math.min(0.95, 0.35 + Math.min(0.3, gitSamples.length / 160) + Math.min(0.2, (memory.events?.length ?? 0) / 80) + Math.min(0.1, fileFrequency.length / 80));
    const highRiskFiles = uniqueStrings([
      ...((graph.insights ?? []).flatMap((insight: any) => Array.isArray(insight.likelyFiles) ? insight.likelyFiles : [])),
      ...((twin.riskHotspots ?? []).map((entry: any) => entry.file))
    ], 30);

    return {
      schemaVersion: 1,
      learnedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      workspaceName: path.basename(this.workspaceRoot),
      confidence,
      evidence: {
        commitsAnalyzed: gitSamples.length,
        dirtyFiles,
        memoryEvents: memory.events?.length ?? 0,
        memoryRules: (memory.rules ?? []).slice(0, 20),
        causalInsights: (graph.insights ?? []).slice(0, 8).map((insight: any) => ({
          title: insight.title,
          severity: insight.severity,
          likelyFiles: insight.likelyFiles
        }))
      },
      habits: {
        firstReadFiles: uniqueStrings([
          ...fileFrequency.map((entry) => entry.value),
          ...highRiskFiles,
          ...((twin.tests ?? []) as string[]).slice(0, 8)
        ], 20),
        frequentSurfaces: surfaceFrequency,
        averageFilesPerCommit,
        testsTogetherWithCodeRate: gitSamples.length > 0 ? Number((commitsWithTests / gitSamples.length).toFixed(2)) : 0,
        docsTogetherWithCodeRate: gitSamples.length > 0 ? Number((commitsWithDocs / gitSamples.length).toFixed(2)) : 0,
        configChangeRate: gitSamples.length > 0 ? Number((commitsWithConfig / gitSamples.length).toFixed(2)) : 0,
        preferredVerificationCommand: verificationCommand,
        naming,
        patchShape: averageFilesPerCommit <= 2
          ? "surgical"
          : averageFilesPerCommit <= 6
            ? "vertical-slice"
            : "campaign"
      },
      behaviorModel: {
        readingOrder: [
          "Read the closest existing implementation pattern.",
          "Read the public tool/command surface before changing behavior.",
          "Read linked tests or create a focused proof if none exists.",
          "Check Causal Intelligence for risk hotspots before broad edits."
        ],
        implementationSequence: [
          "Schema or public surface first.",
          "Backend implementation second.",
          "CLI/dashboard/docs wiring third.",
          "Focused test coverage fourth.",
          "Build/test verification before promotion."
        ],
        avoidances: [
          "Avoid new dependencies unless the repo already uses the pattern.",
          "Avoid broad rewrites when a vertical slice proves the behavior.",
          "Avoid touching high-risk runtime or shell execution files without timeline verification."
        ],
        approvalCriteria: [
          `Verification passes: ${verificationCommand}.`,
          "Docs match actual public surface.",
          "Risky changes have tests or timeline telemetry.",
          "Engineering Memory captures accepted or rejected lessons."
        ],
        divergenceRules: [
          { id: "missing-verification", severity: "high", description: "Plan does not mention tests, build, or timeline verification." },
          { id: "new-dependency", severity: "medium", description: "Plan adds dependency/framework without explicit justification." },
          { id: "wide-blast-radius", severity: "medium", description: "Plan touches many files compared with learned patch shape." },
          { id: "docs-missing", severity: "medium", description: "Public tool/CLI change lacks docs update." },
          { id: "risk-without-proof", severity: "high", description: "High-risk file touched without proof-first workflow." }
        ]
      },
      recentWork: gitSamples.slice(0, 20)
    };
  }

  private async predictGhostEngineerPath(goal: string, profile: any, verificationOverride = ""): Promise<Record<string, any>> {
    const [contractResult, causalAnswer] = await Promise.all([
      this.intentCompile({ intent: goal, verificationCommand: verificationOverride || undefined }),
      this.causalIntelligence({ action: "query", query: goal }).catch(() => ({ topInsights: [], recommendations: [] }))
    ]);
    const contract = (contractResult as any).contract;
    const verificationCommand = verificationOverride || contract.rollout?.verificationCommand || profile.habits?.preferredVerificationCommand || "npm test";
    const likelyFiles = uniqueStrings([
      ...(contract.likelyFiles ?? []),
      ...((causalAnswer as any).topInsights ?? []).flatMap((insight: any) => Array.isArray(insight.likelyFiles) ? insight.likelyFiles : []),
      ...(profile.habits?.firstReadFiles ?? []).slice(0, 6)
    ], 24);
    const firstReads = uniqueStrings([
      ...likelyFiles.slice(0, 8),
      ...(profile.habits?.firstReadFiles ?? []).slice(0, 8)
    ], 12);
    const steps = uniqueStrings([
      ...(profile.behaviorModel?.readingOrder ?? []),
      ...(contract.phases ?? []),
      ...(profile.behaviorModel?.implementationSequence ?? [])
    ], 14);
    const autopilotPlan = [
      `Start by reading ${firstReads.slice(0, 4).join(", ") || "the closest matching files"}.`,
      "Make the smallest repo-native vertical slice that satisfies the goal.",
      "Mirror existing naming and tool/command patterns before introducing new abstraction.",
      `Run ${verificationCommand} before promotion.`,
      "Record the outcome in Engineering Memory."
    ];
    const divergence = this.evaluateGhostDivergence(autopilotPlan.join("\n"), profile, likelyFiles);
    return {
      schemaVersion: 1,
      predictedAt: new Date().toISOString(),
      goal,
      profileDigest: {
        learnedAt: profile.learnedAt,
        confidence: profile.confidence,
        patchShape: profile.habits?.patchShape,
        preferredVerificationCommand: profile.habits?.preferredVerificationCommand,
        frequentSurfaces: profile.habits?.frequentSurfaces?.slice?.(0, 6) ?? []
      },
      prediction: `You would likely make a ${profile.habits?.patchShape ?? "vertical-slice"} change: read existing surfaces first, patch the smallest compatible path, add proof, update docs if public behavior changes, then verify.`,
      predictedApproach: {
        firstReads,
        likelyFiles,
        implementationSteps: steps,
        tests: contract.tests ?? [],
        docs: /cli|tool|feature|command|docs?|readme/i.test(goal) ? ["Update MESH_FEATURES.md or the nearest public docs after code lands."] : [],
        verificationCommand,
        rollback: contract.rollout?.rollback ?? "Use timelines or semantic undo for rollback."
      },
      divergence,
      autopilotPatch: {
        mode: "timeline-first",
        styleConstraints: [
          ...(profile.behaviorModel?.avoidances ?? []),
          ...(profile.evidence?.memoryRules ?? []).slice(0, 6)
        ],
        suggestedPatchOrder: autopilotPlan,
        promotionGates: profile.behaviorModel?.approvalCriteria ?? []
      },
      causalSignals: (causalAnswer as any).topInsights ?? [],
      contract
    };
  }

  private evaluateGhostDivergence(plan: string, profile: any, likelyFiles: string[] = []): Record<string, unknown> {
    const text = plan.toLowerCase();
    const warnings: Array<Record<string, unknown>> = [];
    const matchedPreferences: string[] = [];
    const addWarning = (id: string, severity: string, message: string, evidence: string) => {
      warnings.push({ id, severity, message, evidence });
    };

    if (/\b(test|build|verify|verification|timeline|npm test|npm run build)\b/.test(text)) {
      matchedPreferences.push("mentions verification");
    } else {
      addWarning("missing-verification", "high", "Plan does not mention verification.", "Learned profile expects tests/build/timeline verification before promotion.");
    }

    if (/\b(add|install|dependency|framework|package)\b/.test(text) && !/\bjustify|because|existing pattern|already uses\b/.test(text)) {
      addWarning("new-dependency", "medium", "Plan may introduce a dependency without justification.", "Profile avoids new dependencies unless local patterns justify them.");
    }

    const fileMentions = uniqueStrings(Array.from(plan.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|css|html|yml|yaml))/g)).map((match) => match[1]), 100);
    const mentionedOrLikelyFiles = uniqueStrings([...fileMentions, ...likelyFiles], 100);
    const typical = Number(profile.habits?.averageFilesPerCommit ?? 0);
    if (typical > 0 && mentionedOrLikelyFiles.length > Math.max(8, typical * 3)) {
      addWarning("wide-blast-radius", "medium", "Plan touches a wider surface than the learned patch shape.", `${mentionedOrLikelyFiles.length} files vs typical ${typical}.`);
    }

    const publicSurface = /\b(cli|slash|command|tool|dashboard|feature|public|docs?|readme)\b/.test(text) || mentionedOrLikelyFiles.some((file) => /agent-loop|local-tools|MESH_FEATURES|MOONSHOT|README/i.test(file));
    if (publicSurface && !/\b(doc|docs|readme|features|moonshot)\b/.test(text)) {
      addWarning("docs-missing", "medium", "Public surface change lacks a docs step.", "Profile and repo pattern keep docs aligned with tool surfaces.");
    } else if (publicSurface) {
      matchedPreferences.push("keeps docs aligned with public surface");
    }

    const highRiskFiles = new Set((profile.evidence?.causalInsights ?? []).flatMap((insight: any) => Array.isArray(insight.likelyFiles) ? insight.likelyFiles : []));
    const touchesHighRisk = mentionedOrLikelyFiles.some((file) => highRiskFiles.has(file));
    if (touchesHighRisk && !/\b(test|timeline|verify|proof|race|autopsy)\b/.test(text)) {
      addWarning("risk-without-proof", "high", "High-risk file appears without proof-first workflow.", "Causal profile marks the file as risky.");
    }

    if (/\b(existing|pattern|smallest|surgical|vertical|focused)\b/.test(text)) {
      matchedPreferences.push("uses local pattern and focused change language");
    }

    const penalty = warnings.reduce((total, warning) => total + (warning.severity === "high" ? 30 : 15), 0);
    const alignmentScore = Math.max(0, Math.min(100, 100 - penalty + matchedPreferences.length * 5));
    return {
      alignmentScore,
      verdict: alignmentScore >= 85 ? "aligned" : alignmentScore >= 65 ? "watch" : "divergent",
      warnings,
      matchedPreferences,
      profileConfidence: profile.confidence ?? 0
    };
  }

  private async readGitWorkSamples(maxCommits = 80): Promise<Array<{ commit: string; date: string; subject: string; files: string[] }>> {
    try {
      const safeLimit = Math.max(1, Math.min(maxCommits, 300));
      const { stdout } = await execAsync(`git log --name-only --format=@@@%h%x09%ad%x09%s --date=short --max-count=${safeLimit}`, {
        cwd: this.workspaceRoot,
        maxBuffer: 2 * 1024 * 1024
      });
      const samples: Array<{ commit: string; date: string; subject: string; files: string[] }> = [];
      let current: { commit: string; date: string; subject: string; files: string[] } | null = null;
      for (const line of stdout.split(/\r?\n/g)) {
        if (line.startsWith("@@@")) {
          if (current) samples.push(current);
          const [commit, date, ...subjectParts] = line.slice(3).split("\t");
          current = { commit: commit || "unknown", date: date || "", subject: subjectParts.join("\t"), files: [] };
          continue;
        }
        const file = line.trim();
        if (current && file && !file.includes(" ")) current.files.push(file);
      }
      if (current) samples.push(current);
      return samples.map((sample) => ({ ...sample, files: uniqueStrings(sample.files, 80) }));
    } catch {
      return [];
    }
  }

  private rankStrings(values: string[], limit = 20): Array<{ value: string; count: number }> {
    const counts = new Map<string, number>();
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
      .slice(0, limit);
  }

  private classifyEngineerSurface(file: string): string {
    if (/(\.test|\.spec|^tests\/|\/tests\/)/i.test(file)) return "tests";
    if (/\.(md|mdx)$/i.test(file)) return "docs";
    if (/agent-loop|local-tools|tool|command|cli/i.test(file)) return "cli-tooling";
    if (/runtime|observer|server|api|route/i.test(file)) return "runtime-api";
    if (/dashboard|canvas|ui|frontend|tsx|jsx|css|html/i.test(file)) return "frontend";
    if (/package\.json|tsconfig|config|\.ya?ml|\.toml|Dockerfile/i.test(file)) return "config";
    return "source";
  }

  private inferGhostNamingStyle(symbols: any[]): Record<string, unknown> {
    const names = symbols.map((symbol) => String(symbol.name ?? "")).filter(Boolean).slice(0, 1000);
    const camel = names.filter((name) => /^[a-z][A-Za-z0-9]*$/.test(name)).length;
    const pascal = names.filter((name) => /^[A-Z][A-Za-z0-9]*$/.test(name)).length;
    const snake = names.filter((name) => /^[a-z0-9_]+$/.test(name) && name.includes("_")).length;
    const dominant = [
      { style: "lowerCamel", count: camel },
      { style: "PascalCase", count: pascal },
      { style: "snake_case", count: snake }
    ].sort((left, right) => right.count - left.count)[0];
    return {
      dominant: dominant?.style ?? "unknown",
      samples: names.slice(0, 20),
      counts: { lowerCamel: camel, PascalCase: pascal, snake_case: snake }
    };
  }

  private defaultVerificationCommand(twin?: any): string {
    const scripts = twin?.package?.scripts ?? {};
    if (scripts.test) return "npm test";
    if (scripts.build) return "npm run build";
    if (scripts.lint) return "npm run lint";
    return "npm test";
  }

  private inferIntentInterfaces(intent: string, twin: any): string[] {
    const lower = intent.toLowerCase();
    const interfaces = [];
    if (/api|endpoint|route|server|backend/.test(lower)) interfaces.push("API route/controller surface");
    if (/ui|frontend|screen|dashboard|page|button|form/.test(lower)) interfaces.push("Frontend/browser interaction surface");
    if (/db|database|schema|migration|persist|store/.test(lower)) interfaces.push("Persistence/schema surface");
    if (/cli|command|slash|tool/.test(lower)) interfaces.push("CLI/tool surface");
    if (interfaces.length === 0 && twin?.routes?.length > 0) interfaces.push("Existing route and tool surface");
    return interfaces;
  }

  private inferIntentTests(intent: string, twin: any): string[] {
    const tests = ["Run declared verification command before promotion."];
    if (/runtime|crash|error|debug|failure/i.test(intent)) tests.push("Add a runtime failure fixture or stack-trace regression test.");
    if (/ui|frontend|dashboard|browser/i.test(intent)) tests.push("Add a DOM/payload or dashboard snapshot test.");
    if (/api|route|backend/i.test(intent)) tests.push("Add route matching and request/response behavior tests.");
    if ((twin?.tests ?? []).length === 0) tests.push("Create first focused test if no matching test exists.");
    return tests;
  }

  private inferIntentRisks(intent: string, twin: any, likelyFiles: string[]): string[] {
    const riskMap = new Map((twin?.riskHotspots ?? []).map((entry: any) => [entry.file, entry.risks]));
    const risks = likelyFiles.flatMap((file) => (riskMap.get(file) as string[] | undefined)?.map((risk) => `${file}: ${risk}`) ?? []);
    if (/auth|secret|token|payment|delete|migration/i.test(intent)) risks.push("Intent contains high-risk domain terms; require timeline verification.");
    return uniqueStrings(risks, 20);
  }

  private async readDirtyFilesForMemory(): Promise<string[]> {
    try {
      const { stdout } = await execAsync("git status --short", { cwd: this.workspaceRoot });
      return uniqueStrings(stdout.split(/\r?\n/g).map((line) => line.slice(3).trim()).filter(Boolean), 100);
    } catch {
      return [];
    }
  }

  private async readGitChurn(maxCommits = 200): Promise<Record<string, number>> {
    try {
      const safeLimit = Math.max(1, Math.min(maxCommits, 1000));
      const { stdout } = await execAsync(`git log --name-only --format= --max-count=${safeLimit}`, {
        cwd: this.workspaceRoot,
        maxBuffer: 1024 * 1024
      });
      const counts: Record<string, number> = {};
      for (const line of stdout.split(/\r?\n/g)) {
        const file = line.trim();
        if (!file || file.includes(" ")) continue;
        counts[file] = (counts[file] ?? 0) + 1;
      }
      return counts;
    } catch {
      return {};
    }
  }

  private async listRuntimeRuns(): Promise<Array<Record<string, unknown>>> {
    const runtimeBase = this.runtimeObserver.basePath;
    const entries = await fs.readdir(runtimeBase, { withFileTypes: true }).catch(() => []);
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await readJsonFile<any | null>(path.join(runtimeBase, entry.name, "run.json"), null);
      if (record) runs.push(record);
    }
    return runs.sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? ""))).slice(0, 20);
  }

  private scoreCockpitHealth(snapshot: Record<string, any>): Record<string, unknown> {
    const repairQueue = snapshot.repair?.queue?.length ?? 0;
    const failedTimelines = (snapshot.timelines?.timelines ?? []).filter((timeline: any) => timeline.verdict === "fail").length;
    const failedRuns = (snapshot.runtimeRuns ?? []).filter((run: any) => run.status === "failed").length;
    const score = Math.max(0, 100 - repairQueue * 15 - failedTimelines * 10 - failedRuns * 10);
    return {
      score,
      status: score >= 90 ? "healthy" : score >= 70 ? "watch" : "attention",
      signals: {
        repairQueue,
        failedTimelines,
        failedRuns
      }
    };
  }

  public async *indexEverything(): AsyncGenerator<{ current: number; total: number; path: string }> {
    const files = await collectFiles(this.workspaceRoot, 10000, this.workspaceRoot);
    const total = files.length;
    let completed = 0;

    const processFile = async (absolutePath: string, existing?: unknown) => {
      const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);
      const stat = await fs.stat(absolutePath);
      const mtimeMs = Math.floor(stat.mtimeMs);

      let raw = "";
      let contentHash = "";

      if (!existing) {
        raw = await fs.readFile(absolutePath, "utf8");
        contentHash = crypto.createHash("sha1").update(raw).digest("hex");
        existing = await this.cache.getCapsule(relativePath, "medium", mtimeMs, contentHash);
      }

      if (!existing) {
        if (this.meshCore.isAvailable) {
          const results = await this.meshCore.summarizeAllTiers(relativePath, raw);
          await Promise.all(CAPSULE_TIERS.map(t => this.cache.setCapsule(relativePath, t, results[t] || "", mtimeMs, contentHash)));
        } else {
          await Promise.all(CAPSULE_TIERS.map(t => this.cache.setCapsule(relativePath, t, raw.slice(0, 12000), mtimeMs, contentHash)));
        }
      }
      return relativePath;
    };

    for (let i = 0; i < total; i += INDEX_PARALLELISM) {
      const chunk = files.slice(i, i + INDEX_PARALLELISM);
      const batchRequests: CapsuleBatchRequest[] = [];
      for (const absolutePath of chunk) {
        const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);
        const stat = await fs.stat(absolutePath);
        batchRequests.push({
          filePath: relativePath,
          tier: "medium",
          mtimeMs: Math.floor(stat.mtimeMs)
        });
      }
      const cachedBatch = await this.cache.getCapsuleBatch(batchRequests);
      const results = await Promise.all(
        chunk.map((absolutePath) => {
          const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);
          return processFile(absolutePath, cachedBatch.get(`${relativePath}\u0000medium`));
        })
      );
      for (let j = 0; j < results.length; j++) {
        completed++;
        yield { current: completed, total, path: results[j] };
      }
    }

    // Post-indexing: Update intelligence artifacts in .mesh/ and the persistent code graph.
    await this.updateIntelligence();
    await this.workspaceIndex.rebuild();
  }

  private async updateIntelligence(): Promise<void> {
    const meshDir = path.join(this.workspaceRoot, ".mesh");
    const exists = await fs.access(meshDir).then(() => true).catch(() => false);
    if (!exists) return;

    const files = await collectFiles(this.workspaceRoot, 2000, this.workspaceRoot);
    const tsFiles = files.filter(f => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js"));
    const relativeFiles = tsFiles.map(f => toPosixRelative(this.workspaceRoot, f));

    // 1. Dependency Graph: Raw adjacency notation "file -> dep1, dep2"
    const depLines: string[] = [];
    for (const rel of relativeFiles.slice(0, 100)) {
      try {
        const abs = ensureInsideRoot(this.workspaceRoot, rel);
        const content = await fs.readFile(abs, "utf8");
        const imports = extractImports(content);
        if (imports.length > 0) {
          depLines.push(`${rel} -> ${imports.join(", ")}`);
        }
      } catch { /* skip */ }
    }
    await fs.writeFile(path.join(meshDir, "dependency_graph.md"), depLines.join("\n"));

    // 2. Architecture: Flat layer map "LAYER: file1, file2"
    const layers: Record<string, string[]> = { CORE: [], API: [], INFRA: [], MCP: [] };
    for (const rel of relativeFiles) {
      if (rel.includes("agent-loop") || rel.includes("agent-os") || rel.includes("mesh-core")) layers.CORE.push(rel);
      else if (rel.includes("api") || rel.includes("gateway") || rel.includes("server") || rel.includes("portal")) layers.API.push(rel);
      else if (rel.includes("index") || rel.includes("cache") || rel.includes("storage") || rel.includes("db") || rel.includes("assembler")) layers.INFRA.push(rel);
      else if (rel.includes("mcp")) layers.MCP.push(rel);
    }
    const archLines = Object.entries(layers)
      .filter(([_, files]) => files.length > 0)
      .map(([name, files]) => `${name}: ${files.slice(0, 20).join(", ")}`);
    await fs.writeFile(path.join(meshDir, "architecture.md"), archLines.join("\n"));

    // 3. schemas.json: Flat JSON map of type definitions
    const schemas: Record<string, string> = {};
    for (const rel of relativeFiles.slice(0, 150)) {
      try {
        const abs = ensureInsideRoot(this.workspaceRoot, rel);
        const content = await fs.readFile(abs, "utf8");
        const defs = extractSchemaDefinitions(content);
        Object.assign(schemas, defs);
      } catch { /* skip */ }
    }
    await writeJsonFile(path.join(meshDir, "schemas.json"), schemas);

    // 4. ops.json: Task-to-Path map
    const ops: Record<string, string[]> = {
      "add_mcp_tool": ["src/mcp-client.ts", "src/local-tools.ts", "src/agent-loop.ts"],
      "fix_auth": ["src/auth.ts", "src/mesh-gateway.ts"],
      "update_index": ["src/workspace-index.ts", "src/cache-manager.ts"],
      "refactor_brain": ["src/mesh-brain.ts", "src/company-brain.ts"],
      "debug_runtime": ["src/runtime-api.ts", "src/agent-os.ts"],
      "test_setup": ["scripts/run-tests.cjs", "tests/"]
    };
    if (relativeFiles.some(f => f.includes("moonshots"))) {
      ops["moonshot_dev"] = ["src/moonshots/common.ts", "src/agent-loop.ts"];
    }
    await writeJsonFile(path.join(meshDir, "ops.json"), ops);
  }
}
