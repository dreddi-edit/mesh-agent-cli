import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendJsonl, clampNumber, collectWorkspaceFiles, lineNumberAt, toPosix, writeJson } from "../moonshots/common.js";

export interface SelfDefenseFinding {
  id: string;
  file: string;
  line: number;
  pattern: string;
  flags: string;
  score: number;
  status: "suspicious" | "confirmed" | "timeout" | "safe";
  evidence: string[];
  exploitInputPreview?: string;
  measuredMs?: number;
  recommendation: string;
}

export class SelfDefendingCodeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "scan").trim().toLowerCase();
    if (action === "status") {
      return this.status();
    }
    if (!["scan", "probe"].includes(action)) {
      throw new Error("workspace.self_defend action must be scan|probe|status");
    }

    const maxFiles = clampNumber(args.maxFiles, 500, 1, 5000);
    const confirm = action === "probe" || args.confirm === true;
    const files = typeof args.path === "string" && args.path.trim()
      ? [toPosix(args.path.trim())]
      : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles });
    const findings: SelfDefenseFinding[] = [];

    for (const file of files) {
      const absolute = path.resolve(this.workspaceRoot, file);
      if (!absolute.startsWith(path.resolve(this.workspaceRoot))) continue;
      const raw = await fs.readFile(absolute, "utf8").catch(() => "");
      if (!raw) continue;
      for (const candidate of extractRegexCandidates(raw, file)) {
        const score = redosRiskScore(candidate.pattern);
        if (score < 35) continue;
        const finding: SelfDefenseFinding = {
          id: `${file}:${candidate.line}:${hashTiny(candidate.pattern)}`,
          file,
          line: candidate.line,
          pattern: candidate.pattern,
          flags: candidate.flags,
          score,
          status: "suspicious",
          evidence: explainRedosRisk(candidate.pattern),
          recommendation: buildRecommendation(candidate.pattern)
        };
        if (confirm) {
          const confirmation = await confirmRedos(candidate.pattern, candidate.flags);
          finding.status = confirmation.timedOut ? "timeout" : confirmation.vulnerable ? "confirmed" : "suspicious";
          finding.measuredMs = confirmation.maxMs;
          finding.exploitInputPreview = confirmation.input.slice(0, 120);
          finding.evidence.push(...confirmation.evidence);
        }
        findings.push(finding);
      }
    }

    findings.sort((left, right) => right.score - left.score);
    const result = {
      ok: true,
      action,
      scannedFiles: files.length,
      confirmed: findings.filter((item) => item.status === "confirmed" || item.status === "timeout").length,
      suspicious: findings.length,
      findings,
      policyPath: ".mesh/security/policy.yaml",
      logPath: ".mesh/security/log.jsonl",
      nextActions: [
        "Run workspace.self_defend with action=probe to confirm suspicious regexes.",
        "Patch confirmed findings in a timeline and verify benign behavior before promotion.",
        "Mark sensitive paths in .mesh/security/sensitive.yaml before enabling auto-merge."
      ]
    };
    await this.persist(result);
    return result;
  }

  private async status(): Promise<Record<string, unknown>> {
    await this.ensureDefaults();
    return {
      ok: true,
      action: "status",
      policyPath: ".mesh/security/policy.yaml",
      sensitivePath: ".mesh/security/sensitive.yaml",
      logPath: ".mesh/security/log.jsonl",
      supportedProbeClasses: ["redos"],
      autoMergeDefault: false
    };
  }

  private async persist(result: Record<string, unknown>): Promise<void> {
    await this.ensureDefaults();
    await writeJson(path.join(this.workspaceRoot, ".mesh", "security", "last-self-defense.json"), result);
    await appendJsonl(path.join(this.workspaceRoot, ".mesh", "security", "log.jsonl"), {
      at: new Date().toISOString(),
      kind: "self_defense_scan",
      result
    });
  }

  private async ensureDefaults(): Promise<void> {
    const securityDir = path.join(this.workspaceRoot, ".mesh", "security");
    await fs.mkdir(securityDir, { recursive: true });
    const policyPath = path.join(securityDir, "policy.yaml");
    const sensitivePath = path.join(securityDir, "sensitive.yaml");
    if (!(await exists(policyPath))) {
      await fs.writeFile(policyPath, [
        "autoMerge: false",
        "maxPatchLines: 20",
        "requiredPrecision: 0.95",
        "probeBudgetPerRun: 50",
        ""
      ].join("\n"), "utf8");
    }
    if (!(await exists(sensitivePath))) {
      await fs.writeFile(sensitivePath, [
        "# Paths here always require manual review.",
        "paths:",
        "  - src/auth",
        "  - src/security",
        "  - .env",
        ""
      ].join("\n"), "utf8");
    }
  }
}

function extractRegexCandidates(raw: string, file: string): Array<{ pattern: string; flags: string; line: number }> {
  const candidates: Array<{ pattern: string; flags: string; line: number }> = [];
  const literal = /(?<![A-Za-z0-9_$])\/((?:\\.|[^/\\\r\n])+?)\/([dgimsuvy]*)/g;
  for (const match of raw.matchAll(literal)) {
    candidates.push({ pattern: match[1], flags: match[2] ?? "", line: lineNumberAt(raw, match.index ?? 0) });
  }
  const constructor = /new\s+RegExp\(\s*(["'`])((?:\\.|(?!\1).)+)\1\s*(?:,\s*(["'`])([dgimsuvy]*)\3)?\s*\)/g;
  for (const match of raw.matchAll(constructor)) {
    candidates.push({ pattern: unescapeRegexString(match[2]), flags: match[4] ?? "", line: lineNumberAt(raw, match.index ?? 0) });
  }
  return candidates.filter((item) => item.pattern && !/node_modules/.test(file));
}

function redosRiskScore(pattern: string): number {
  let score = 0;
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) score += 55;
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) score += 25;
  if (/(?:\.\*|\.\+)\)+[+*{]?/.test(pattern)) score += 20;
  if (/\[[^\]]+\][+*]\)+[+*{]?/.test(pattern)) score += 15;
  if (/\{(?:\d+,|\d+,\d+)\}/.test(pattern) && /[+*]/.test(pattern)) score += 10;
  return Math.min(100, score);
}

function explainRedosRisk(pattern: string): string[] {
  const evidence: string[] = [];
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) evidence.push("Nested quantifier can cause catastrophic backtracking.");
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) evidence.push("Alternation under repetition creates ambiguous paths.");
  if (/(?:\.\*|\.\+)\)+[+*{]?/.test(pattern)) evidence.push("Broad wildcard repetition expands the backtracking search space.");
  if (evidence.length === 0) evidence.push("Regex structure is suspicious under repeated adversarial input.");
  return evidence;
}

async function confirmRedos(pattern: string, flags: string): Promise<{ vulnerable: boolean; timedOut: boolean; maxMs: number; input: string; evidence: string[] }> {
  const seed = inferAttackSeed(pattern);
  const sizes = [32, 128, 512, 2048];
  let maxMs = 0;
  let worstInput = "";
  for (const size of sizes) {
    const input = seed.repeat(size) + "!";
    const measured = await measureRegex(pattern, flags, input, 900);
    worstInput = input;
    if (measured.timedOut) {
      return { vulnerable: true, timedOut: true, maxMs: measured.ms, input, evidence: [`Timed out at input length ${input.length}.`] };
    }
    maxMs = Math.max(maxMs, measured.ms);
    if (measured.ms > 250) {
      return { vulnerable: true, timedOut: false, maxMs, input, evidence: [`Execution took ${Math.round(measured.ms)}ms at input length ${input.length}.`] };
    }
  }
  return { vulnerable: false, timedOut: false, maxMs, input: worstInput, evidence: [`Worst measured execution ${Math.round(maxMs)}ms.`] };
}

function measureRegex(pattern: string, flags: string, input: string, timeoutMs: number): Promise<{ ms: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const script = [
      `const start = process.hrtime.bigint();`,
      `new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags.replace(/[gy]/g, ""))}).test(${JSON.stringify(input)});`,
      `const end = process.hrtime.bigint();`,
      `console.log(Number(end - start) / 1e6);`
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ms: timeoutMs, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ ms: Number(stdout.trim()) || 0, timedOut: false });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ms: 0, timedOut: false });
    });
  });
}

function inferAttackSeed(pattern: string): string {
  const charClass = pattern.match(/\[([A-Za-z0-9])-?([A-Za-z0-9])?[^\]]*\][+*]/);
  if (charClass?.[1]) return charClass[1];
  const literal = pattern.match(/([A-Za-z0-9])(?:[+*]|\))/);
  return literal?.[1] ?? "a";
}

function buildRecommendation(pattern: string): string {
  return `Constrain input length before /${pattern}/, replace nested repetition with linear parsing, or use a non-backtracking regex strategy. Verify with the generated adversarial input and benign equivalence cases.`;
}

function unescapeRegexString(value: string): string {
  return value.replace(/\\\\/g, "\\");
}

function hashTiny(value: string): string {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}
