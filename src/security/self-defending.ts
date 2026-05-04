import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Node, Project, ScriptKind, SyntaxKind } from "ts-morph";
import { runCritic } from "../agents/critic.js";
import { appendJsonl, clampNumber, collectWorkspaceFiles, lineNumberAt, readJson, toPosix, writeJson } from "../moonshots/common.js";
import {
  classifySafetyWithNvidia,
  DEFAULT_NVIDIA_PII_MODELS,
  DEFAULT_NVIDIA_SAFETY_MODELS,
  detectPiiWithNvidia,
  resolveNvidiaApiKey
} from "../nvidia-services.js";
import { TimelineManager } from "../timeline-manager.js";

type FindingKind = "redos" | "command_injection" | "path_traversal" | "sqli";
type FindingStatus = "suspicious" | "confirmed" | "timeout" | "safe";

export interface SelfDefenseFinding {
  id: string;
  file: string;
  line: number;
  kind: FindingKind;
  pattern: string;
  flags: string;
  score: number;
  status: FindingStatus;
  evidence: string[];
  exploitInputPreview?: string;
  measuredMs?: number;
  recommendation: string;
  aiSafety?: {
    guard?: string;
    secondaryGuard?: string;
    piiReview?: string;
  };
}

interface SelfDefenseCandidate {
  pattern: string;
  flags: string;
  line: number;
  kind: FindingKind;
}

interface AstSecurityCandidates {
  commandInjection: Array<{ pattern: string; flags: string; line: number }>;
  sqli: Array<{ pattern: string; flags: string; line: number }>;
}

const REGEX_PROBE_WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(`
import { parentPort, workerData } from "node:worker_threads";
const start = process.hrtime.bigint();
new RegExp(workerData.pattern, workerData.flags).test(workerData.input);
const end = process.hrtime.bigint();
parentPort?.postMessage({ ms: Number(end - start) / 1e6 });
`)}`);

interface SecurityPolicy {
  autoMerge: boolean;
  maxPatchLines: number;
  requiredPrecision: number;
  probeBudgetPerRun: number;
  redosMaxInputLength: number;
  verificationCommand?: string;
  sensitivePaths: string[];
}

interface PatchAttempt {
  findingId: string;
  file: string;
  kind: FindingKind;
  status: "not_patchable" | "timeline_ready" | "promoted" | "blocked";
  reason?: string;
  strategy?: string;
  timelineId?: string;
  diffLines?: number;
  verification?: {
    executed: boolean;
    command?: string;
    ok: boolean;
    exitCode?: number;
  };
  critic?: ReturnType<typeof runCritic>;
  promotion?: Record<string, unknown>;
}

export class SelfDefendingCodeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "scan").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action === "daemon_tick") return this.daemonTick(args);
    if (action === "harden") return this.harden(args);
    if (!["scan", "probe"].includes(action)) {
      throw new Error("workspace.self_defend action must be scan|probe|harden|daemon_tick|status");
    }

    const maxFiles = clampNumber(args.maxFiles, 500, 1, 5000);
    const confirm = action === "probe" || args.confirm === true;
    const files = await this.targetFiles(args, maxFiles);
    const findings = await this.scanFiles(files, confirm);
    await this.annotateFindings(findings);

    const result = {
      ok: true,
      action,
      scannedFiles: files.length,
      confirmed: findings.filter((item) => item.status === "confirmed" || item.status === "timeout").length,
      suspicious: findings.length,
      findings,
      policyPath: ".mesh/security/policy.yaml",
      logPath: ".mesh/security/log.jsonl",
      companionStatePath: ".mesh/security/companions.json",
      nextActions: [
        "Run workspace.self_defend with action=probe to confirm suspicious findings.",
        "Run workspace.self_defend with action=harden to create verified timeline patches for confirmed deterministic vulnerabilities.",
        "Set autoMerge: true in .mesh/security/policy.yaml only after reviewing sensitive paths and promotion rules."
      ]
    };
    await this.persist("self_defense_scan", result);
    return result;
  }

  private async harden(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const policy = await this.loadPolicy();
    const maxFiles = clampNumber(args.maxFiles, policy.probeBudgetPerRun, 1, 5000);
    const files = await this.targetFiles(args, maxFiles);
    const findings = await this.scanFiles(files, true);
    await this.annotateFindings(findings);
    const attempts: PatchAttempt[] = [];
    const timelineManager = new TimelineManager(this.workspaceRoot);

    try {
      for (const finding of findings) {
        if (finding.status !== "confirmed" && finding.status !== "timeout") continue;
        attempts.push(await this.hardenFinding(finding, policy, args, timelineManager));
      }
    } finally {
      await timelineManager.close();
    }

    const result = {
      ok: true,
      action: "harden",
      scannedFiles: files.length,
      confirmed: findings.filter((item) => item.status === "confirmed" || item.status === "timeout").length,
      patched: attempts.filter((item) => item.status === "timeline_ready" || item.status === "promoted").length,
      promoted: attempts.filter((item) => item.status === "promoted").length,
      findings,
      attempts,
      policy: {
        autoMerge: policy.autoMerge,
        maxPatchLines: policy.maxPatchLines,
        requiredPrecision: policy.requiredPrecision,
        redosMaxInputLength: policy.redosMaxInputLength
      },
      ledgerPath: ".mesh/security/last-self-defense.json",
      notificationPath: ".mesh/security/notifications.jsonl"
    };
    await this.persist("self_defense_harden", result);
    return result;
  }

  private async daemonTick(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const policy = await this.loadPolicy();
    const maxFiles = clampNumber(args.maxFiles, policy.probeBudgetPerRun, 1, 1000);
    const files = await this.targetFiles(args, maxFiles);
    const findings = await this.scanFiles(files, true);
    await this.annotateFindings(findings);
    const statePath = path.join(this.workspaceRoot, ".mesh", "security", "companions.json");
    const previous = await readJson<{ files?: Record<string, unknown> }>(statePath, { files: {} });
    const nextFiles = { ...(previous.files ?? {}) } as Record<string, unknown>;
    const now = new Date().toISOString();

    for (const file of files) {
      const fileFindings = findings.filter((finding) => finding.file === file);
      nextFiles[file] = {
        lastProbedAt: now,
        findingCount: fileFindings.length,
        confirmed: fileFindings.filter((finding) => finding.status === "confirmed" || finding.status === "timeout").length,
        highestScore: fileFindings.reduce((max, finding) => Math.max(max, finding.score), 0)
      };
    }

    const result = {
      ok: true,
      action: "daemon_tick",
      probedFiles: files.length,
      findings,
      nextWakeSeconds: findings.some((finding) => finding.status === "confirmed" || finding.status === "timeout") ? 300 : 3600,
      companionStatePath: ".mesh/security/companions.json"
    };
    await writeJson(statePath, { updatedAt: now, files: nextFiles });
    await this.persist("self_defense_daemon_tick", result);
    return result;
  }

  private async hardenFinding(
    finding: SelfDefenseFinding,
    policy: SecurityPolicy,
    args: Record<string, unknown>,
    timelines: TimelineManager
  ): Promise<PatchAttempt> {
    if (finding.kind !== "redos") {
      const attempt: PatchAttempt = {
        findingId: finding.id,
        file: finding.file,
        kind: finding.kind,
        status: "not_patchable",
        reason: "This vulnerability class is confirmed, but no deterministic auto-patcher is enabled yet."
      };
      await this.notify(attempt);
      return attempt;
    }

    const absolute = safeResolve(this.workspaceRoot, finding.file);
    const raw = await fs.readFile(absolute, "utf8");
    const patch = buildRedosGuardPatch(raw, finding, policy.redosMaxInputLength);
    if (!patch) {
      const attempt: PatchAttempt = {
        findingId: finding.id,
        file: finding.file,
        kind: finding.kind,
        status: "not_patchable",
        reason: "Confirmed ReDoS, but the call site is not a simple guarded .test(identifier) pattern."
      };
      await this.notify(attempt);
      return attempt;
    }

    const sensitive = isSensitivePath(finding.file, policy.sensitivePaths);
    const timeline = await timelines.create({ name: `self-defense-${finding.kind}-${hashTiny(finding.id)}` });
    const timelineFile = path.join(timeline.timeline.root, finding.file);
    await fs.mkdir(path.dirname(timelineFile), { recursive: true });
    await fs.writeFile(timelineFile, patch.content, "utf8");

    const verificationCommand = String(args.verificationCommand ?? policy.verificationCommand ?? await inferVerificationCommand(this.workspaceRoot)).trim();
    let verification: PatchAttempt["verification"] = { executed: false, ok: false };
    if (verificationCommand) {
      const run = await timelines.run({
        timelineId: timeline.timeline.id,
        command: verificationCommand,
        timeoutMs: clampNumber(args.timeoutMs, 120_000, 5_000, 600_000)
      });
      verification = {
        executed: true,
        command: verificationCommand,
        ok: run.ok,
        exitCode: run.exitCode
      };
    }

    const critic = runCritic({
      diffPreview: patch.diffPreview,
      verificationOk: verification.ok
    });
    const promotionAllowed =
      policy.autoMerge &&
      !sensitive &&
      patch.diffLines <= policy.maxPatchLines &&
      verification.ok &&
      critic.ok &&
      finding.score / 100 >= policy.requiredPrecision;

    const attempt: PatchAttempt = {
      findingId: finding.id,
      file: finding.file,
      kind: finding.kind,
      status: promotionAllowed ? "promoted" : verification.ok && critic.ok ? "timeline_ready" : "blocked",
      reason: promotionAllowed
        ? "Auto-promoted by self-defense policy."
        : sensitive
          ? "Timeline patch ready, but sensitive paths require manual review."
          : verification.executed && !verification.ok
            ? "Timeline patch created, but verification failed."
            : !verification.executed
              ? "Timeline patch created, but no verification command was available."
              : critic.ok
                ? "Timeline patch ready for review; autoMerge is disabled or confidence threshold not met."
                : "Timeline patch blocked by critic findings.",
      strategy: patch.strategy,
      timelineId: timeline.timeline.id,
      diffLines: patch.diffLines,
      verification,
      critic
    };

    if (promotionAllowed) {
      attempt.promotion = await timelines.promote({ timelineId: timeline.timeline.id });
    } else {
      await this.notify(attempt);
    }
    return attempt;
  }

  private async annotateFindings(findings: SelfDefenseFinding[]): Promise<void> {
    const apiKey = resolveNvidiaApiKey();
    if (!apiKey || findings.length === 0) return;

    const targets = findings
      .filter((finding) => finding.status === "confirmed" || finding.status === "timeout")
      .slice(0, 8);

    await Promise.all(targets.map(async (finding) => {
      const artifact = [
        `file: ${finding.file}:${finding.line}`,
        `kind: ${finding.kind}`,
        `pattern: ${finding.pattern}`,
        `flags: ${finding.flags}`,
        `evidence: ${finding.evidence.join(" | ")}`,
        finding.exploitInputPreview ? `exploit: ${finding.exploitInputPreview}` : ""
      ].filter(Boolean).join("\n");

      const [guard, secondaryGuard, piiReview] = await Promise.all([
        classifySafetyWithNvidia(artifact, process.env.MESH_SAFETY_MODEL || DEFAULT_NVIDIA_SAFETY_MODELS[0], apiKey).catch(() => undefined),
        classifySafetyWithNvidia(artifact, process.env.MESH_SAFETY_MODEL_SECONDARY || DEFAULT_NVIDIA_SAFETY_MODELS[1], apiKey).catch(() => undefined),
        detectPiiWithNvidia(artifact, process.env.MESH_PII_MODEL || DEFAULT_NVIDIA_PII_MODELS[0], apiKey).catch(() => undefined)
      ]);

      finding.aiSafety = { guard, secondaryGuard, piiReview };
    }));
  }

  private async scanFiles(files: string[], confirm: boolean): Promise<SelfDefenseFinding[]> {
    const findings: SelfDefenseFinding[] = [];
    for (const file of files) {
      const absolute = safeResolve(this.workspaceRoot, file);
      const raw = await fs.readFile(absolute, "utf8").catch(() => "");
      if (!raw) continue;
      const astSecurityCandidates = extractAstSecurityCandidates(raw, file);

      const candidates = [
        ...extractRegexCandidates(raw, file).map((candidate) => ({ ...candidate, kind: "redos" as const })),
        ...astSecurityCandidates.commandInjection.map((candidate) => ({ ...candidate, kind: "command_injection" as const })),
        ...extractPathTraversalCandidates(raw, file).map((candidate) => ({ ...candidate, kind: "path_traversal" as const })),
        ...astSecurityCandidates.sqli.map((candidate) => ({ ...candidate, kind: "sqli" as const }))
      ];

      for (const candidate of candidates) {
        const finding = await buildFinding(candidate, file, confirm);
        if (finding) findings.push(finding);
      }
    }
    findings.sort((left, right) => right.score - left.score);
    return findings;
  }

  private async targetFiles(args: Record<string, unknown>, maxFiles: number): Promise<string[]> {
    return typeof args.path === "string" && args.path.trim()
      ? [toPosix(args.path.trim())]
      : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles });
  }

  private async status(): Promise<Record<string, unknown>> {
    const policy = await this.loadPolicy();
    const last = await readJson(path.join(this.workspaceRoot, ".mesh", "security", "last-self-defense.json"), null);
    return {
      ok: true,
      action: "status",
      policyPath: ".mesh/security/policy.yaml",
      sensitivePath: ".mesh/security/sensitive.yaml",
      logPath: ".mesh/security/log.jsonl",
      companionStatePath: ".mesh/security/companions.json",
      supportedProbeClasses: ["redos", "command_injection", "path_traversal", "sqli"],
      supportedAutoPatchClasses: ["redos"],
      autoMergeDefault: policy.autoMerge,
      last
    };
  }

  private async notify(attempt: PatchAttempt): Promise<void> {
    await appendJsonl(path.join(this.workspaceRoot, ".mesh", "security", "notifications.jsonl"), {
      at: new Date().toISOString(),
      kind: "self_defense_notification",
      attempt
    });
  }

  private async persist(kind: string, result: Record<string, unknown>): Promise<void> {
    await this.ensureDefaults();
    await writeJson(path.join(this.workspaceRoot, ".mesh", "security", "last-self-defense.json"), result);
    await appendJsonl(path.join(this.workspaceRoot, ".mesh", "security", "log.jsonl"), {
      at: new Date().toISOString(),
      kind,
      result
    });
  }

  private async loadPolicy(): Promise<SecurityPolicy> {
    await this.ensureDefaults();
    const securityDir = path.join(this.workspaceRoot, ".mesh", "security");
    const policyRaw = await fs.readFile(path.join(securityDir, "policy.yaml"), "utf8").catch(() => "");
    const sensitiveRaw = await fs.readFile(path.join(securityDir, "sensitive.yaml"), "utf8").catch(() => "");
    return {
      autoMerge: parseBoolean(policyRaw, "autoMerge", false),
      maxPatchLines: parseNumber(policyRaw, "maxPatchLines", 20),
      requiredPrecision: parseNumber(policyRaw, "requiredPrecision", 0.95),
      probeBudgetPerRun: parseNumber(policyRaw, "probeBudgetPerRun", 50),
      redosMaxInputLength: parseNumber(policyRaw, "redosMaxInputLength", 2048),
      verificationCommand: parseString(policyRaw, "verificationCommand"),
      sensitivePaths: parseYamlList(sensitiveRaw, "paths")
    };
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
        "redosMaxInputLength: 2048",
        "# Optional. Example: npm test",
        "verificationCommand: \"\"",
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

async function buildFinding(candidate: SelfDefenseCandidate, file: string, confirm: boolean): Promise<SelfDefenseFinding | null> {
  let score = 0;
  let evidence: string[] = [];
  let recommendation = "";

  if (candidate.kind === "redos") {
    score = redosRiskScore(candidate.pattern);
    if (score < 35) return null;
    evidence = explainRedosRisk(candidate.pattern);
    recommendation = buildRecommendation(candidate.pattern);
  } else if (candidate.kind === "command_injection") {
    score = 80;
    evidence = ["Dynamic shell execution with unescaped interpolation detected."];
    recommendation = "Use structured arguments in spawn/execFile instead of shell interpolation.";
  } else if (candidate.kind === "path_traversal") {
    score = 70;
    evidence = ["Unsanitized interpolation in file system path detected."];
    recommendation = "Use path.basename or strict workspace sandboxing for dynamic file paths.";
  } else if (candidate.kind === "sqli") {
    score = 90;
    evidence = ["Raw SQL query with string interpolation detected."];
    recommendation = "Use parameterized queries or prepared statements.";
  }

  const finding: SelfDefenseFinding = {
    id: `${file}:${candidate.line}:${hashTiny(candidate.pattern)}`,
    file,
    line: candidate.line,
    kind: candidate.kind,
    pattern: candidate.pattern,
    flags: candidate.flags,
    score,
    status: "suspicious",
    evidence,
    recommendation
  };

  if (confirm) {
    if (candidate.kind === "redos") {
      const confirmation = await confirmRedos(candidate.pattern, candidate.flags);
      finding.status = confirmation.timedOut ? "timeout" : confirmation.vulnerable ? "confirmed" : "suspicious";
      finding.measuredMs = confirmation.maxMs;
      finding.exploitInputPreview = confirmation.input.slice(0, 120);
      finding.evidence.push(...confirmation.evidence);
    } else {
      finding.status = "confirmed";
      finding.exploitInputPreview = candidate.kind === "command_injection"
        ? "'; rm -rf / #"
        : candidate.kind === "sqli"
          ? "' OR 1=1 --"
          : "../../../etc/passwd";
      finding.evidence.push(`Confirmed structurally vulnerable to ${candidate.kind} payloads.`);
    }
  }
  return finding;
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

function extractPathTraversalCandidates(raw: string, file: string): Array<{ pattern: string; flags: string; line: number }> {
  if (/node_modules/.test(file)) return [];
  const candidates: Array<{ pattern: string; flags: string; line: number }> = [];
  const regex = /\b(?:fs\.readFile|fs\.writeFile|path\.join|fs\.readFileSync|fs\.writeFileSync)\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g;
  for (const match of raw.matchAll(regex)) {
    candidates.push({ pattern: match[0], flags: "", line: lineNumberAt(raw, match.index ?? 0) });
  }
  return candidates;
}

function extractAstSecurityCandidates(raw: string, file: string): AstSecurityCandidates {
  const result: AstSecurityCandidates = { commandInjection: [], sqli: [] };
  if (/node_modules/.test(file) || !/\.[cm]?[jt]sx?$/.test(file)) return result;

  try {
    const ext = path.extname(file).toLowerCase();
    const scriptKind = ext === ".js" || ext === ".jsx" || ext === ".cjs" || ext === ".mjs"
      ? ScriptKind.JS
      : ScriptKind.TS;
    const project = new Project({
      useInMemoryFileSystem: true,
      skipFileDependencyResolution: true,
      compilerOptions: {
        allowJs: true,
        checkJs: false
      }
    });
    const sourceFile = project.createSourceFile(`/scan${ext || ".ts"}`, raw, { scriptKind, overwrite: true });

    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const args = node.getArguments();
      if (args.length === 0) return;

      const callee = callExpressionName(node.getExpression());
      const dynamicArgs = args.filter((arg) => isDynamicStringExpression(arg));
      if (dynamicArgs.length === 0) return;

      if (isCommandSink(callee)) {
        result.commandInjection.push({
          pattern: node.getText().slice(0, 500),
          flags: "ast",
          line: node.getStartLineNumber()
        });
      }

      const firstArg = args[0];
      if (isSqlSink(callee) && dynamicArgs.includes(firstArg) && looksLikeSql(firstArg.getText())) {
        result.sqli.push({
          pattern: node.getText().slice(0, 500),
          flags: "ast",
          line: node.getStartLineNumber()
        });
      }
    });
  } catch {
    return result;
  }

  return result;
}

function callExpressionName(expression: Node): string {
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  return expression.getText();
}

function isCommandSink(name: string): boolean {
  return /^(exec|execSync|spawn|spawnSync|eval)$/.test(name);
}

function isSqlSink(name: string): boolean {
  return /^(query|execute|exec)$/.test(name);
}

function isDynamicStringExpression(node: Node): boolean {
  if (Node.isTemplateExpression(node)) return true;
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    return containsStringLikeExpression(node.getLeft()) || containsStringLikeExpression(node.getRight());
  }
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
    return isDynamicStringExpression(node.getExpression());
  }
  return false;
}

function containsStringLikeExpression(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node)) return true;
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    return containsStringLikeExpression(node.getLeft()) || containsStringLikeExpression(node.getRight());
  }
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
    return containsStringLikeExpression(node.getExpression());
  }
  return false;
}

function looksLikeSql(text: string): boolean {
  return /\b(?:SELECT|INSERT|UPDATE|DELETE|UPSERT|MERGE|WITH)\b/i.test(text);
}

function buildRedosGuardPatch(
  raw: string,
  finding: SelfDefenseFinding,
  maxInputLength: number
): { content: string; strategy: string; diffLines: number; diffPreview: string } | null {
  const lines = raw.split(/\r?\n/g);
  const start = Math.max(0, finding.line - 1);
  const end = Math.min(lines.length, start + 12);
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/\.test\(\s*([A-Za-z_$][\w$]*)\s*\)/);
    if (!match) continue;
    const inputName = match[1];
    const context = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
    if (new RegExp(`${escapeRegex(inputName)}\\.length\\s*>\\s*\\d+`).test(context)) {
      return null;
    }
    const indent = lines[index].match(/^\s*/)?.[0] ?? "";
    const guard = `${indent}if (typeof ${inputName} === "string" && ${inputName}.length > ${maxInputLength}) return false;`;
    const next = [...lines.slice(0, index), guard, ...lines.slice(index)];
    return {
      content: next.join("\n"),
      strategy: `Inserted ReDoS length guard before ${inputName}-driven regex evaluation.`,
      diffLines: 1,
      diffPreview: [
        `--- ${finding.file}`,
        `+++ ${finding.file}`,
        `@@ line ${index + 1}`,
        `+${guard}`
      ].join("\n")
    };
  }
  return null;
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
    const worker = new Worker(REGEX_PROBE_WORKER_URL, {
      workerData: {
        pattern,
        flags: flags.replace(/[gy]/g, ""),
        input
      }
    });
    let settled = false;
    const done = (result: { ms: number; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => {
      done({ ms: timeoutMs, timedOut: true });
    }, timeoutMs);
    worker.on("message", (message: { ms?: number }) => {
      done({ ms: Number(message.ms) || 0, timedOut: false });
    });
    worker.on("error", () => {
      done({ ms: 0, timedOut: false });
    });
    worker.on("exit", (code) => {
      if (code !== 0) done({ ms: 0, timedOut: false });
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

async function inferVerificationCommand(workspaceRoot: string): Promise<string> {
  const packageRaw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8").catch(() => "");
  if (packageRaw) {
    try {
      const pkg = JSON.parse(packageRaw) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return "npm test";
      if (pkg.scripts?.typecheck) return "npm run typecheck";
      if (pkg.scripts?.build) return "npm run build";
    } catch {
      return "";
    }
  }
  return "";
}

function isSensitivePath(file: string, sensitivePaths: string[]): boolean {
  const normalized = toPosix(file);
  return sensitivePaths.some((entry) => normalized === entry || normalized.startsWith(`${entry.replace(/\/+$/, "")}/`) || normalized.includes(entry));
}

function safeResolve(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${relative}`);
  }
  return absolute;
}

function parseBoolean(raw: string, key: string, fallback: boolean): boolean {
  const value = parseString(raw, key);
  if (value === undefined) return fallback;
  return /^(true|yes|1)$/i.test(value);
}

function parseNumber(raw: string, key: string, fallback: number): number {
  const value = Number(parseString(raw, key));
  return Number.isFinite(value) ? value : fallback;
}

function parseString(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(.*)$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim().replace(/^["']|["']$/g, "");
  return value || undefined;
}

function parseYamlList(raw: string, key: string): string[] {
  const lines = raw.split(/\r?\n/g);
  const values: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (new RegExp(`^\\s*${escapeRegex(key)}\\s*:`).test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^\s*\w[\w-]*\s*:/.test(line)) break;
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (inList && item) values.push(toPosix(item[1].replace(/^["']|["']$/g, "")));
  }
  return values;
}

function unescapeRegexString(value: string): string {
  return value.replace(/\\\\/g, "\\");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashTiny(value: string): string {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}
