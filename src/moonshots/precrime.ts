import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendJsonl, clampNumber, collectWorkspaceFiles, readJson, writeJson } from "./common.js";

const execFileAsync = promisify(execFile);

type PrecrimeSeverity = "critical" | "high" | "medium" | "low";
type PrecrimeGate = "pass" | "warn" | "require_timeline_verification" | "block_extended_verification";

interface PrecrimePrediction {
  id: string;
  file: string;
  probability: number;
  confidence: number;
  horizonDays: number;
  severity: PrecrimeSeverity;
  gate: PrecrimeGate;
  reasons: string[];
  preventiveActions: string[];
  riskTags: string[];
  matchedHistoricalCases: number;
  historicalIncidentRate: number;
  globalPatternMatches: Array<{ id: string; probability: number; description: string; sampleSize: number }>;
  futureScenario: string;
}

interface PrecrimeOutcome {
  at: string;
  file: string;
  incident: boolean;
  severity: PrecrimeSeverity;
  tags: string[];
  verificationCommand?: string;
  notes?: string;
}

interface GlobalPattern {
  id: string;
  tags: string[];
  probability: number;
  description: string;
  sampleSize: number;
}

export class PrecrimeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "analyze").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action === "record_outcome") return this.recordOutcome(args);
    if (action === "gate") return this.gate(args);
    if (action !== "analyze") throw new Error("workspace.precrime action must be analyze|gate|record_outcome|status");
    return this.analyze(args, "analyze");
  }

  private async analyze(args: Record<string, unknown>, action: "analyze" | "gate"): Promise<Record<string, unknown>> {
    const maxFiles = clampNumber(args.maxFiles, 250, 1, 1000);
    const changedFiles = await this.changedFiles();
    const files = typeof args.path === "string" && args.path.trim()
      ? [normalizePath(args.path)]
      : changedFiles.length > 0
        ? changedFiles
        : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles });
    const telemetry = await readJson<{ signals?: Array<any> }>(path.join(this.workspaceRoot, ".mesh", "production-signals.json"), { signals: [] });
    const outcomes = await readJsonl<PrecrimeOutcome>(path.join(this.workspaceRoot, ".mesh", "precrime", "outcomes.jsonl"));
    const globalPatterns = await readJson<{ patterns?: GlobalPattern[] }>(path.join(this.workspaceRoot, ".mesh", "precrime", "global-patterns.json"), { patterns: [] });
    const testFiles = await collectWorkspaceFiles(this.workspaceRoot, { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], maxFiles: 1000 })
      .then((items) => items.filter((item) => /\.(test|spec)\./.test(item)));
    const auditSummary = await this.auditSummary();

    const predictions: PrecrimePrediction[] = [];
    for (const file of files.slice(0, maxFiles)) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw) continue;
      const prediction = scoreFile({
        file,
        raw,
        testFiles,
        signals: telemetry.signals ?? [],
        changed: changedFiles.includes(file),
        outcomes,
        globalPatterns: globalPatterns.patterns ?? [],
        auditSummary
      });
      if (prediction.probability >= 0.18) predictions.push(prediction);
    }

    predictions.sort((left, right) => right.probability - left.probability);
    const top = predictions.slice(0, 25);
    const result = {
      ok: true,
      action,
      generatedAt: new Date().toISOString(),
      horizonDays: 14,
      changedFiles,
      telemetrySignals: telemetry.signals?.length ?? 0,
      historicalOutcomes: outcomes.length,
      auditSignals: auditSummary,
      predictions: top,
      summary: summarize(top),
      gate: overallGate(top),
      ledgerPath: ".mesh/precrime/predictions.json",
      outcomePath: ".mesh/precrime/outcomes.jsonl",
      modelPath: ".mesh/precrime/model.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), result);
    await writeJson(path.join(this.workspaceRoot, ".mesh", "precrime", "model.json"), buildModel(outcomes));
    return result;
  }

  private async gate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.analyze(args, "gate");
    const predictions = (result.predictions ?? []) as PrecrimePrediction[];
    return {
      ...result,
      blocked: result.gate === "block_extended_verification",
      requiredVerification: buildRequiredVerification(predictions),
      decision: decisionText(result.gate as PrecrimeGate, predictions)
    };
  }

  private async recordOutcome(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = normalizePath(String(args.file ?? ""));
    if (!file) throw new Error("workspace.precrime record_outcome requires file");
    const incident = args.incident === true || String(args.outcome ?? "").toLowerCase() === "incident";
    const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
    const tags = Array.from(new Set([
      ...deriveRiskTags(file, raw, [], false),
      ...normalizeTags(args.tags)
    ]));
    const outcome: PrecrimeOutcome = {
      at: new Date().toISOString(),
      file,
      incident,
      severity: normalizeSeverity(args.severity, incident ? "high" : "low"),
      tags,
      verificationCommand: typeof args.verificationCommand === "string" ? args.verificationCommand : undefined,
      notes: typeof args.notes === "string" ? args.notes : undefined
    };
    await appendJsonl(path.join(this.workspaceRoot, ".mesh", "precrime", "outcomes.jsonl"), outcome);
    const outcomes = await readJsonl<PrecrimeOutcome>(path.join(this.workspaceRoot, ".mesh", "precrime", "outcomes.jsonl"));
    const model = buildModel(outcomes);
    await writeJson(path.join(this.workspaceRoot, ".mesh", "precrime", "model.json"), model);
    return {
      ok: true,
      action: "record_outcome",
      outcome,
      model,
      outcomePath: ".mesh/precrime/outcomes.jsonl"
    };
  }

  private async status(): Promise<Record<string, unknown>> {
    const predictions = await readJson<{ predictions?: PrecrimePrediction[] } | null>(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), null);
    const outcomes = await readJsonl<PrecrimeOutcome>(path.join(this.workspaceRoot, ".mesh", "precrime", "outcomes.jsonl"));
    return {
      ok: true,
      action: "status",
      predictions: predictions?.predictions ?? [],
      latest: predictions,
      model: buildModel(outcomes),
      message: predictions ? undefined : "No precrime ledger exists yet. Run action=analyze."
    };
  }

  private async changedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: this.workspaceRoot });
      return stdout.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async auditSummary(): Promise<{ recentToolCalls: number; riskyToolCalls: number }> {
    const dir = path.join(this.workspaceRoot, ".mesh", "audit");
    const files = await fs.readdir(dir).catch(() => []);
    let recentToolCalls = 0;
    let riskyToolCalls = 0;
    for (const file of files.filter((item) => item.endsWith(".jsonl")).sort().slice(-7)) {
      const rows = await readJsonl<{ tool?: string }>(path.join(dir, file));
      recentToolCalls += rows.length;
      riskyToolCalls += rows.filter((row) => /run_command|patch|write|delete|move|timeline_promote/.test(String(row.tool ?? ""))).length;
    }
    return { recentToolCalls, riskyToolCalls };
  }
}

function scoreFile(args: {
  file: string;
  raw: string;
  testFiles: string[];
  signals: Array<any>;
  changed: boolean;
  outcomes: PrecrimeOutcome[];
  globalPatterns: GlobalPattern[];
  auditSummary: { recentToolCalls: number; riskyToolCalls: number };
}): PrecrimePrediction {
  const reasons: string[] = [];
  const preventiveActions: string[] = [];
  const riskTags = deriveRiskTags(args.file, args.raw, args.testFiles, args.changed);
  let score = args.changed ? 0.22 : 0.08;

  if (riskTags.includes("auth")) {
    score += 0.24;
    reasons.push("Touches authentication/session boundary.");
    preventiveActions.push("Run auth-focused regression tests and verify token/session edge cases.");
  }
  if (riskTags.includes("process")) {
    score += 0.18;
    reasons.push("Touches process execution or runtime environment boundary.");
    preventiveActions.push("Run command-safety checks and malicious input cases.");
  }
  if (riskTags.includes("persistence")) {
    score += 0.18;
    reasons.push("Touches persistence/query boundary.");
    preventiveActions.push("Run schema-drift and injection-oriented checks.");
  }
  if (riskTags.includes("external-reachability")) {
    score += 0.12;
    reasons.push("Touches externally reachable request path.");
    preventiveActions.push("Shadow the request path with representative production samples.");
  }
  if (riskTags.includes("missing-tests")) {
    score += 0.12;
    reasons.push("No obvious adjacent test coverage found.");
    preventiveActions.push("Add a targeted regression/property test before promotion.");
  }
  if (args.auditSummary.riskyToolCalls >= 3 && args.changed) {
    score += 0.08;
    reasons.push("Recent tool-call stream contains multiple risky write/execute operations.");
    preventiveActions.push("Require timeline verification because recent edit sequence is risk-heavy.");
  }

  const matchingSignals = args.signals.filter((signal) => signal.file === args.file || signal.route && args.raw.includes(String(signal.route)));
  if (matchingSignals.length > 0) {
    score += Math.min(0.2, matchingSignals.length * 0.08);
    reasons.push("Production telemetry already points at this area.");
    preventiveActions.push("Compare telemetry baseline before/after in shadow deploy.");
  }

  const historical = matchHistorical(args.file, riskTags, args.outcomes);
  if (historical.total > 0) {
    score += Math.min(0.32, historical.incidentRate * Math.min(1, historical.total / 5) * 0.4);
    reasons.push(`Local future-self model matched ${historical.total} prior outcome(s) at ${Math.round(historical.incidentRate * 100)}% incident rate.`);
    preventiveActions.push("Replay the previous failure mode and require explicit outcome recording after verification.");
  }

  const globalMatches = matchGlobalPatterns(riskTags, args.globalPatterns);
  for (const match of globalMatches) {
    score += Math.min(0.18, match.probability * 0.18);
    reasons.push(`Global Mesh-Brain pattern ${match.id} predicts elevated risk: ${match.description}`);
    preventiveActions.push("Run the Mesh-Brain recommended verification pattern before promotion.");
  }

  const probability = Math.min(0.97, Number(score.toFixed(2)));
  const severity = severityFor(probability);
  const gate = gateFor(probability);
  const confidence = Math.min(0.95, Number((0.35 + Math.min(0.35, historical.total * 0.06) + Math.min(0.15, globalMatches.length * 0.08) + (matchingSignals.length > 0 ? 0.1 : 0)).toFixed(2)));
  return {
    id: `${args.file}:${Math.round(probability * 100)}:${hashTiny(riskTags.join("|"))}`,
    file: args.file,
    probability,
    confidence,
    horizonDays: 14,
    severity,
    gate,
    reasons: reasons.length > 0 ? reasons : ["No dominant risk cluster; baseline prediction only."],
    preventiveActions: preventiveActions.length > 0 ? unique(preventiveActions) : ["Run typecheck, tests, and timeline comparison before promotion."],
    riskTags,
    matchedHistoricalCases: historical.total,
    historicalIncidentRate: historical.incidentRate,
    globalPatternMatches: globalMatches,
    futureScenario: buildFutureScenario(args.file, probability, riskTags, historical.total)
  };
}

function deriveRiskTags(file: string, raw: string, testFiles: string[], changed: boolean): string[] {
  const text = `${file}\n${raw}`;
  const tags: string[] = [];
  if (changed) tags.push("changed");
  if (/\b(auth|jwt|session|oauth|token|password)\b/i.test(text)) tags.push("auth");
  if (/\b(exec|spawn|execFile|shell|rm\s+-rf|NODE_OPTIONS)\b/.test(raw)) tags.push("process");
  if (/\b(sql|query|prisma|drizzle|supabase|database|migration)\b/i.test(text)) tags.push("persistence");
  if (/\bfetch\(|axios\.|http\.|https\.|route|router|app\.(get|post|put|patch|delete)\b/i.test(raw)) tags.push("external-reachability");
  if (!hasNearbyTest(file, testFiles)) tags.push("missing-tests");
  const now = new Date();
  const hour = now.getHours();
  if (hour >= 18 || hour < 7) tags.push("after-hours");
  if (now.getDay() === 4 || now.getDay() === 5) tags.push("late-week");
  return unique(tags);
}

function matchHistorical(file: string, tags: string[], outcomes: PrecrimeOutcome[]): { total: number; incidents: number; incidentRate: number } {
  const boundary = primaryBoundary(file, tags);
  const matches = outcomes.filter((outcome) => {
    if (outcome.file === file) return true;
    const overlap = outcome.tags.filter((tag) => tags.includes(tag)).length;
    return primaryBoundary(outcome.file, outcome.tags) === boundary && overlap >= Math.min(2, tags.length);
  });
  const incidents = matches.filter((outcome) => outcome.incident).length;
  return {
    total: matches.length,
    incidents,
    incidentRate: matches.length > 0 ? Number((incidents / matches.length).toFixed(2)) : 0
  };
}

function matchGlobalPatterns(tags: string[], patterns: GlobalPattern[]): Array<{ id: string; probability: number; description: string; sampleSize: number }> {
  return patterns
    .filter((pattern) => pattern.tags.every((tag) => tags.includes(tag)))
    .sort((left, right) => right.probability - left.probability)
    .slice(0, 3)
    .map((pattern) => ({
      id: pattern.id,
      probability: pattern.probability,
      description: pattern.description,
      sampleSize: pattern.sampleSize
    }));
}

function buildRequiredVerification(predictions: PrecrimePrediction[]): string[] {
  const actions = predictions
    .filter((prediction) => prediction.gate !== "pass")
    .flatMap((prediction) => prediction.preventiveActions);
  return unique(actions).slice(0, 8);
}

function decisionText(gate: PrecrimeGate, predictions: PrecrimePrediction[]): string {
  const top = predictions[0];
  if (!top) return "pass: no elevated future-risk prediction found.";
  if (gate === "block_extended_verification") {
    return `block_extended_verification: ${top.file} has ${Math.round(top.probability * 100)}% predicted incident risk over 14 days.`;
  }
  if (gate === "require_timeline_verification") {
    return `require_timeline_verification: ${top.file} needs isolated verification before promotion.`;
  }
  if (gate === "warn") {
    return `warn: ${top.file} has elevated but non-blocking future-risk signals.`;
  }
  return "pass: no blocking future-risk signal found.";
}

function buildModel(outcomes: PrecrimeOutcome[]): Record<string, unknown> {
  const buckets = new Map<string, { total: number; incidents: number }>();
  for (const outcome of outcomes) {
    const key = primaryBoundary(outcome.file, outcome.tags);
    const entry = buckets.get(key) ?? { total: 0, incidents: 0 };
    entry.total += 1;
    if (outcome.incident) entry.incidents += 1;
    buckets.set(key, entry);
  }
  return {
    updatedAt: new Date().toISOString(),
    totalOutcomes: outcomes.length,
    buckets: Array.from(buckets.entries()).map(([key, value]) => ({
      key,
      ...value,
      incidentRate: value.total > 0 ? Number((value.incidents / value.total).toFixed(2)) : 0
    }))
  };
}

function primaryBoundary(file: string, tags: string[]): string {
  if (tags.includes("auth")) return "auth";
  if (tags.includes("persistence")) return "persistence";
  if (tags.includes("process")) return "process";
  if (tags.includes("external-reachability")) return "external-reachability";
  return file.split("/").slice(0, 2).join("/") || file;
}

function buildFutureScenario(file: string, probability: number, tags: string[], historicalCases: number): string {
  const percent = Math.round(probability * 100);
  const cause = tags.includes("auth")
    ? "session/token edge cases"
    : tags.includes("persistence")
      ? "query/schema edge cases"
      : tags.includes("process")
        ? "runtime command/environment edge cases"
        : tags.includes("external-reachability")
          ? "request-path behavior drift"
          : "untested behavior drift";
  const history = historicalCases > 0 ? ` It resembles ${historicalCases} local outcome(s).` : "";
  return `${file} is predicted at ${percent}% 14-day incident risk, primarily from ${cause}.${history}`;
}

function severityFor(probability: number): PrecrimeSeverity {
  return probability >= 0.75 ? "critical" : probability >= 0.55 ? "high" : probability >= 0.35 ? "medium" : "low";
}

function gateFor(probability: number): PrecrimeGate {
  if (probability >= 0.75) return "block_extended_verification";
  if (probability >= 0.55) return "require_timeline_verification";
  if (probability >= 0.35) return "warn";
  return "pass";
}

function overallGate(predictions: PrecrimePrediction[]): PrecrimeGate {
  const order: PrecrimeGate[] = ["pass", "warn", "require_timeline_verification", "block_extended_verification"];
  return predictions.reduce((max, prediction) => {
    return order.indexOf(prediction.gate) > order.indexOf(max) ? prediction.gate : max;
  }, "pass" as PrecrimeGate);
}

function hasNearbyTest(file: string, testFiles: string[]): boolean {
  const base = path.basename(file).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, "").toLowerCase();
  return testFiles.some((test) => test.toLowerCase().includes(base));
}

function summarize(predictions: PrecrimePrediction[]): Record<string, number> {
  return predictions.reduce((acc, item) => {
    acc[item.severity] = (acc[item.severity] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  const rows: T[] = [];
  for (const line of raw.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // ignore malformed historical rows
    }
  }
  return rows;
}

function normalizePath(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeSeverity(value: unknown, fallback: PrecrimeSeverity): PrecrimeSeverity {
  const normalized = String(value ?? "").toLowerCase();
  return ["critical", "high", "medium", "low"].includes(normalized) ? normalized as PrecrimeSeverity : fallback;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function hashTiny(value: string): string {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}
