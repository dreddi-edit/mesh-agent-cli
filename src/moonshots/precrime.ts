import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clampNumber, collectWorkspaceFiles, readJson, writeJson } from "./common.js";

const execFileAsync = promisify(execFile);

interface PrecrimePrediction {
  id: string;
  file: string;
  probability: number;
  severity: "critical" | "high" | "medium" | "low";
  reasons: string[];
  preventiveActions: string[];
}

export class PrecrimeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "analyze").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "analyze") throw new Error("workspace.precrime action must be analyze|status");

    const maxFiles = clampNumber(args.maxFiles, 250, 1, 1000);
    const changedFiles = await this.changedFiles();
    const files = changedFiles.length > 0 ? changedFiles : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles });
    const telemetry = await readJson<{ signals?: Array<any> }>(path.join(this.workspaceRoot, ".mesh", "production-signals.json"), { signals: [] });
    const testFiles = await collectWorkspaceFiles(this.workspaceRoot, { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], maxFiles: 1000 })
      .then((items) => items.filter((item) => /\.(test|spec)\./.test(item)));

    const predictions: PrecrimePrediction[] = [];
    for (const file of files.slice(0, maxFiles)) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw) continue;
      const prediction = scoreFile(file, raw, testFiles, telemetry.signals ?? [], changedFiles.includes(file));
      if (prediction.probability >= 0.18) predictions.push(prediction);
    }

    predictions.sort((left, right) => right.probability - left.probability);
    const result = {
      ok: true,
      action,
      generatedAt: new Date().toISOString(),
      changedFiles,
      telemetrySignals: telemetry.signals?.length ?? 0,
      predictions: predictions.slice(0, 25),
      summary: summarize(predictions),
      ledgerPath: ".mesh/precrime/predictions.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), result);
    return result;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), {
      ok: true,
      action: "status",
      predictions: [],
      message: "No precrime ledger exists yet. Run action=analyze."
    });
  }

  private async changedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: this.workspaceRoot });
      return stdout.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

function scoreFile(file: string, raw: string, testFiles: string[], signals: Array<any>, changed: boolean): PrecrimePrediction {
  const reasons: string[] = [];
  const preventiveActions: string[] = [];
  let score = changed ? 0.22 : 0.08;

  if (/\b(auth|jwt|session|oauth|token|password)\b/i.test(`${file}\n${raw}`)) {
    score += 0.24;
    reasons.push("Touches authentication/session boundary.");
    preventiveActions.push("Run auth-focused regression tests and verify token/session edge cases.");
  }
  if (/\b(exec|spawn|execFile|shell|rm\s+-rf|NODE_OPTIONS)\b/.test(raw)) {
    score += 0.18;
    reasons.push("Touches process execution or runtime environment boundary.");
    preventiveActions.push("Run command-safety checks and exercise malicious input cases.");
  }
  if (/\b(sql|query|prisma|drizzle|supabase|database|migration)\b/i.test(`${file}\n${raw}`)) {
    score += 0.18;
    reasons.push("Touches persistence/query boundary.");
    preventiveActions.push("Run schema-drift and injection-oriented checks.");
  }
  if (/\bfetch\(|axios\.|http\.|https\.|route|router|app\.(get|post|put|patch|delete)\b/i.test(raw)) {
    score += 0.12;
    reasons.push("Touches externally reachable request path.");
    preventiveActions.push("Shadow the request path with representative production samples.");
  }
  if (!hasNearbyTest(file, testFiles)) {
    score += 0.12;
    reasons.push("No obvious adjacent test coverage found.");
    preventiveActions.push("Add a targeted regression/property test before promotion.");
  }
  const matchingSignals = signals.filter((signal) => signal.file === file || signal.route && raw.includes(String(signal.route)));
  if (matchingSignals.length > 0) {
    score += Math.min(0.2, matchingSignals.length * 0.08);
    reasons.push("Production telemetry already points at this area.");
    preventiveActions.push("Compare telemetry baseline before/after in shadow deploy.");
  }

  const probability = Math.min(0.97, Number(score.toFixed(2)));
  return {
    id: `${file}:${Math.round(probability * 100)}`,
    file,
    probability,
    severity: probability >= 0.75 ? "critical" : probability >= 0.55 ? "high" : probability >= 0.35 ? "medium" : "low",
    reasons,
    preventiveActions: preventiveActions.length > 0 ? preventiveActions : ["Run typecheck, tests, and timeline comparison before promotion."]
  };
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
