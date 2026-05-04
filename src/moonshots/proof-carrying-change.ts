import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAllowedCommand } from "../command-safety.js";
import { clampNumber, collectWorkspaceFiles, readJson, writeJson } from "./common.js";

const execFileAsync = promisify(execFile);

interface ChangedFile {
  file: string;
  status: string;
  additions: number;
  deletions: number;
  source: "git" | "workspace-fallback";
}

interface VerificationRun {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export class ProofCarryingChangeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "generate").trim().toLowerCase();
    if (action === "status") return this.status();
    if (!["generate", "verify"].includes(action)) {
      throw new Error("workspace.proof_carrying_change action must be generate|verify|status");
    }

    const intent = String(args.intent ?? "").trim();
    const timeoutMs = clampNumber(args.timeoutMs, 120_000, 1_000, 600_000);
    const verificationCommand = String(args.verificationCommand ?? "").trim();
    let verificationRun: VerificationRun | null = null;
    if (action === "verify") {
      if (!verificationCommand) throw new Error("workspace.proof_carrying_change verify requires verificationCommand");
      verificationRun = await this.runVerification(verificationCommand, timeoutMs);
    }

    const evidence = await this.collectEvidence();
    const proof = buildProof({
      action,
      intent,
      evidence,
      verificationRun
    });
    await writeJson(this.ledgerPath(), proof);
    return proof;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(this.ledgerPath(), {
      ok: true,
      action: "status",
      message: "No proof-carrying change bundle exists yet. Run action=generate or action=verify."
    });
  }

  private async collectEvidence(): Promise<Record<string, any>> {
    const git = await this.gitEvidence();
    const ledgers = await this.ledgerEvidence();
    const packageScripts = await readPackageScripts(this.workspaceRoot);
    const changedFiles = git.changedFiles.length > 0
      ? git.changedFiles
      : await this.workspaceFallbackFiles(git.gitAvailable);
    return {
      git,
      changedFiles,
      packageScripts,
      ledgers
    };
  }

  private async gitEvidence(): Promise<{
    gitAvailable: boolean;
    status: string;
    diffStat: string;
    changedFiles: ChangedFile[];
    recentCommit: string;
  }> {
    const status = await gitOutput(this.workspaceRoot, ["status", "--porcelain"]);
    const diffStat = await gitOutput(this.workspaceRoot, ["diff", "--stat", "HEAD"]);
    const recentCommit = await gitOutput(this.workspaceRoot, ["log", "-1", "--oneline"]);
    const gitAvailable = status.ok || diffStat.ok || recentCommit.ok;
    const changedFiles = parseGitStatus(status.stdout);
    const numstat = parseNumstat((await gitOutput(this.workspaceRoot, ["diff", "--numstat", "HEAD"])).stdout);
    return {
      gitAvailable,
      status: status.stdout.trim(),
      diffStat: diffStat.stdout.trim(),
      changedFiles: changedFiles.map((item) => ({
        ...item,
        additions: numstat.get(item.file)?.additions ?? 0,
        deletions: numstat.get(item.file)?.deletions ?? 0
      })),
      recentCommit: recentCommit.stdout.trim()
    };
  }

  private async workspaceFallbackFiles(gitAvailable: boolean): Promise<ChangedFile[]> {
    if (gitAvailable) return [];
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 80 });
    return files.map((file) => ({
      file,
      status: "observed",
      additions: 0,
      deletions: 0,
      source: "workspace-fallback" as const
    }));
  }

  private async ledgerEvidence(): Promise<Record<string, any>> {
    return {
      selfDefense: await readJson(path.join(this.workspaceRoot, ".mesh", "security", "last-self-defense.json"), null),
      precrime: await readJson(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), null),
      shadowDeploy: await readJson(path.join(this.workspaceRoot, ".mesh", "shadow-deploy", "last-ledger.json"), null),
      semanticGit: await readJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-analysis.json"), null),
      probabilistic: await readJson(path.join(this.workspaceRoot, ".mesh", "probabilistic", "experiments.json"), null),
      specCode: await readJson(path.join(this.workspaceRoot, ".mesh", "spec-code", "contracts.json"), null),
      conversations: await readJson(path.join(this.workspaceRoot, ".mesh", "conversations", "symbol-memory.json"), null),
      fluidMesh: await readJson(path.join(this.workspaceRoot, ".mesh", "fluid-mesh", "capabilities.json"), null),
      naturalLanguage: await readJson(path.join(this.workspaceRoot, ".mesh", "natural-language-source", "last-compile.json"), null),
      livingSoftware: await readJson(path.join(this.workspaceRoot, ".mesh", "living-software", "pulse.json"), null)
    };
  }

  private async runVerification(command: string, timeoutMs: number): Promise<VerificationRun> {
    const parsedCommand = parseAllowedCommand(command);
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(parsedCommand.command, parsedCommand.args, {
        cwd: this.workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });
      return {
        command,
        ok: true,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        stdout: trim(stdout),
        stderr: trim(stderr)
      };
    } catch (error: any) {
      return {
        command,
        ok: false,
        exitCode: typeof error.code === "number" ? error.code : 1,
        durationMs: Date.now() - startedAt,
        stdout: trim(String(error.stdout ?? "")),
        stderr: trim(String(error.stderr ?? error.message ?? ""))
      };
    }
  }

  private ledgerPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "proof-carrying-change", "proof.json");
  }
}

function buildProof(args: {
  action: string;
  intent: string;
  evidence: Record<string, any>;
  verificationRun: VerificationRun | null;
}): Record<string, unknown> {
  const changedFiles = args.evidence.changedFiles as ChangedFile[];
  const ledgers = args.evidence.ledgers ?? {};
  const affectedContracts = filterByChangedFiles(ledgers.specCode?.contracts ?? [], changedFiles);
  const touchedCapabilities = filterByChangedFiles(ledgers.fluidMesh?.capabilities ?? [], changedFiles);
  const riskModel = buildRiskModel(changedFiles, ledgers);
  const gates = buildGates(args.intent, changedFiles, ledgers, args.verificationRun);
  const verdict = proofVerdict(gates, riskModel);
  const proofId = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      intent: args.intent,
      changedFiles: changedFiles.map((item) => item.file),
      riskLevel: riskModel.level,
      gates
    }))
    .digest("hex")
    .slice(0, 16);

  return {
    ok: true,
    action: args.action,
    proofId,
    generatedAt: new Date().toISOString(),
    verdict,
    intent: args.intent || inferIntent(ledgers),
    changeSet: {
      gitAvailable: args.evidence.git.gitAvailable,
      changedFiles,
      diffStat: args.evidence.git.diffStat,
      recentCommit: args.evidence.git.recentCommit
    },
    touchedCapabilities,
    affectedContracts,
    riskModel,
    gates,
    verification: {
      executed: Boolean(args.verificationRun),
      run: args.verificationRun,
      shadowDeploy: summarizeShadowDeploy(ledgers.shadowDeploy),
      availableScripts: args.evidence.packageScripts
    },
    rollbackPath: buildRollbackPath(changedFiles),
    unresolvedAssumptions: unresolvedAssumptions(args.intent, changedFiles, ledgers, args.verificationRun),
    sourceLedgers: sourceLedgerPresence(ledgers),
    proofPath: ".mesh/proof-carrying-change/proof.json"
  };
}

function filterByChangedFiles(items: Array<Record<string, any>>, changedFiles: ChangedFile[]): Array<Record<string, any>> {
  const changed = new Set(changedFiles.map((item) => item.file));
  return items.filter((item) => changed.has(String(item.file ?? ""))).slice(0, 50);
}

function buildRiskModel(changedFiles: ChangedFile[], ledgers: Record<string, any>): Record<string, unknown> {
  const factors: string[] = [];
  let score = changedFiles.length > 0 ? 12 : 4;
  const changedLines = changedFiles.reduce((sum, item) => sum + item.additions + item.deletions, 0);
  if (changedLines > 0) {
    score += Math.min(24, Math.ceil(changedLines / 20));
    factors.push(`${changedLines} changed line(s).`);
  }
  const highRiskFiles = changedFiles.filter((item) => highRiskReason(item.file));
  for (const file of highRiskFiles.slice(0, 8)) {
    score += 10;
    factors.push(`${file.file} touches ${highRiskReason(file.file)}.`);
  }
  const predictions = (ledgers.precrime?.predictions ?? []).filter((prediction: any) =>
    changedFiles.some((file) => file.file === prediction.file)
  );
  if (predictions.length > 0) {
    const maxProbability = Math.max(...predictions.map((item: any) => Number(item.probability ?? 0)));
    score += Math.ceil(maxProbability * 35);
    factors.push(`Precrime predicts risk in ${predictions.length} changed file(s).`);
  }
  const suspicious = Number(ledgers.selfDefense?.suspicious ?? 0);
  const confirmed = Number(ledgers.selfDefense?.confirmed ?? 0);
  if (confirmed > 0) {
    score += 30;
    factors.push(`${confirmed} confirmed self-defense finding(s).`);
  } else if (suspicious > 0) {
    score += 16;
    factors.push(`${suspicious} suspicious self-defense finding(s).`);
  }
  const driftItems = Number(ledgers.specCode?.summary?.driftItems ?? 0);
  if (driftItems > 0) {
    score += Math.min(25, driftItems * 5);
    factors.push(`${driftItems} spec-code drift item(s).`);
  }
  if (ledgers.shadowDeploy?.ok === false) {
    score += 25;
    factors.push("Latest shadow deploy is blocked.");
  } else if (ledgers.shadowDeploy?.ok === true) {
    score -= 8;
    factors.push("Latest shadow deploy passed.");
  }
  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    level: bounded >= 75 ? "critical" : bounded >= 50 ? "high" : bounded >= 25 ? "moderate" : "low",
    factors: factors.length > 0 ? factors : ["No elevated risk factors found from available ledgers."]
  };
}

function buildGates(
  intent: string,
  changedFiles: ChangedFile[],
  ledgers: Record<string, any>,
  verificationRun: VerificationRun | null
): Record<string, string> {
  const selfDefenseConfirmed = Number(ledgers.selfDefense?.confirmed ?? 0);
  const selfDefenseSuspicious = Number(ledgers.selfDefense?.suspicious ?? 0);
  return {
    intent: intent.trim() ? "pass" : "needs_evidence",
    changeSet: changedFiles.length > 0 ? "pass" : "needs_evidence",
    spec: ledgers.specCode?.summary
      ? Number(ledgers.specCode.summary.driftItems ?? 0) > 0 ? "warn" : "pass"
      : "needs_evidence",
    security: selfDefenseConfirmed > 0 ? "fail" : selfDefenseSuspicious > 0 ? "warn" : ledgers.selfDefense ? "pass" : "needs_evidence",
    verification: verificationRun
      ? verificationRun.ok ? "pass" : "fail"
      : ledgers.shadowDeploy?.ok === true ? "pass"
      : ledgers.shadowDeploy?.ok === false ? "fail"
      : "needs_evidence",
    rollback: changedFiles.length > 0 ? "pass" : "needs_evidence"
  };
}

function proofVerdict(gates: Record<string, string>, riskModel: Record<string, any>): string {
  if (Object.values(gates).includes("fail")) return "blocked";
  if (riskModel.level === "critical") return "blocked";
  if (Object.values(gates).includes("needs_evidence")) return "incomplete";
  if (Object.values(gates).includes("warn") || riskModel.level === "high") return "ready_with_review";
  return "ready_to_promote";
}

function buildRollbackPath(changedFiles: ChangedFile[]): Record<string, unknown> {
  return {
    strategy: "patch-reversal",
    steps: [
      "Save the generated proof bundle with the change review.",
      "Use the current git diff as the rollback patch source.",
      "Reverse only the listed changed files after human review if promotion fails.",
      "Re-run the verification gate recorded in this proof before declaring rollback complete."
    ],
    changedFiles: changedFiles.map((item) => item.file),
    requiresManualReview: changedFiles.some((item) => item.status.includes("?") || item.source === "workspace-fallback")
  };
}

function unresolvedAssumptions(
  intent: string,
  changedFiles: ChangedFile[],
  ledgers: Record<string, any>,
  verificationRun: VerificationRun | null
): string[] {
  const assumptions: string[] = [];
  if (!intent.trim()) assumptions.push("No explicit intent was supplied for this proof bundle.");
  if (changedFiles.length === 0) assumptions.push("No changed files were detected.");
  if (!ledgers.specCode) assumptions.push("Spec-code ledger is missing; affected behavior contracts may be incomplete.");
  if (!ledgers.fluidMesh) assumptions.push("Fluid mesh ledger is missing; touched capabilities may be incomplete.");
  if (!ledgers.selfDefense) assumptions.push("Self-defense ledger is missing; security gate is best-effort.");
  if (!verificationRun && !ledgers.shadowDeploy) assumptions.push("No verification run or shadow deploy ledger is attached.");
  return assumptions;
}

function sourceLedgerPresence(ledgers: Record<string, any>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(ledgers).map(([key, value]) => [key, Boolean(value)]));
}

function inferIntent(ledgers: Record<string, any>): string {
  return ledgers.naturalLanguage?.source
    ?? ledgers.naturalLanguage?.intent
    ?? "No explicit intent supplied; generated from current workspace evidence.";
}

function summarizeShadowDeploy(ledger: Record<string, any> | null): Record<string, unknown> | null {
  if (!ledger) return null;
  return {
    ok: ledger.ok,
    verdict: ledger.verdict,
    command: ledger.command,
    gates: ledger.gates,
    timelineId: ledger.timelineId
  };
}

function highRiskReason(file: string): string | null {
  if (/\b(auth|session|token|secret|security)\b/i.test(file)) return "auth/security boundary";
  if (/\b(runtime|local-tools|agent-loop|command|shell|timeline)\b/i.test(file)) return "agent runtime or command boundary";
  if (/\b(db|sql|migration|schema|supabase|database)\b/i.test(file)) return "data persistence boundary";
  if (/\bpackage(?:-lock)?\.json$|pnpm-lock|yarn\.lock\b/i.test(file)) return "dependency boundary";
  return null;
}

async function readPackageScripts(workspaceRoot: string): Promise<Record<string, string>> {
  const raw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8").catch(() => "");
  if (!raw) return {};
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error: any) {
    return { ok: false, stdout: String(error.stdout ?? "") };
  }
}

function parseGitStatus(raw: string): ChangedFile[] {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "modified";
      const rawFile = line.slice(3).trim();
      const file = normalizeGitPath(rawFile.includes(" -> ") ? rawFile.split(" -> ").pop() ?? rawFile : rawFile);
      return { file, status, additions: 0, deletions: 0, source: "git" as const };
    })
    .filter((item) => Boolean(item.file));
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.split(/\r?\n/g)) {
    const [additions, deletions, file] = line.split(/\t/g);
    if (!file) continue;
    stats.set(normalizeGitPath(file), {
      additions: additions === "-" ? 0 : Number(additions) || 0,
      deletions: deletions === "-" ? 0 : Number(deletions) || 0
    });
  }
  return stats;
}

function normalizeGitPath(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\\040/g, " ");
}

function trim(value: string, max = 8000): string {
  return value.length > max ? value.slice(-max) : value;
}
