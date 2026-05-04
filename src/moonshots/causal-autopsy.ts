import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAllowedCommand } from "../command-safety.js";
import { clampNumber, collectWorkspaceFiles, readJson, writeJson } from "./common.js";

const execFileAsync = promisify(execFile);

interface StackFrame {
  file: string;
  line: number;
  column?: number;
  raw: string;
}

interface AutopsyEvidence {
  kind: "runtime-run" | "command-run" | "none";
  runId?: string;
  command?: string;
  ok?: boolean;
  exitCode?: number;
  status?: string;
  errorSummary: string;
  stackFrames: StackFrame[];
  causalChain: string[];
  stdout?: string;
  stderr?: string;
}

interface Suspect {
  file: string;
  score: number;
  confidence: number;
  reasons: string[];
}

export class CausalAutopsyEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "investigate").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "investigate") throw new Error("workspace.causal_autopsy action must be investigate|status");

    const symptom = String(args.symptom ?? "").trim();
    const runId = String(args.runId ?? "").trim();
    const failingCommand = String(args.failingCommand ?? "").trim();
    const timeoutMs = clampNumber(args.timeoutMs, 120_000, 1_000, 600_000);
    const evidence = await this.collectEvidence({ symptom, runId, failingCommand, timeoutMs });
    const suspects = rankSuspects(evidence);
    const graph = buildCausalGraph(symptom, evidence, suspects);
    const result = {
      ok: true,
      action,
      generatedAt: new Date().toISOString(),
      incident: {
        symptom: symptom || evidence.runtime.errorSummary || "No explicit symptom supplied.",
        runId: runId || undefined,
        failingCommand: failingCommand || undefined
      },
      runtimeEvidence: evidence.runtime,
      causalChain: buildCausalChain(symptom, evidence, suspects),
      suspects,
      graph,
      configDeltas: evidence.configDeltas,
      dependencyDeltas: evidence.dependencyDeltas,
      missingInvariants: missingInvariants(evidence, suspects),
      nextActions: nextActions(evidence, suspects),
      autopsyPath: ".mesh/causal-autopsy/last-autopsy.json"
    };
    await writeJson(this.ledgerPath(), result);
    return result;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(this.ledgerPath(), {
      ok: true,
      action: "status",
      message: "No causal autopsy exists yet. Run action=investigate."
    });
  }

  private async collectEvidence(args: {
    symptom: string;
    runId: string;
    failingCommand: string;
    timeoutMs: number;
  }): Promise<Record<string, any>> {
    const runtime = args.failingCommand
      ? await this.runFailingCommand(args.failingCommand, args.timeoutMs)
      : args.runId
        ? await this.readRuntimeRun(args.runId)
        : noRuntimeEvidence();
    const git = await this.gitEvidence();
    const ledgers = await this.ledgerEvidence();
    const symptomMatches = await this.symptomMatches(args.symptom);
    const changedFiles = git.changedFiles;
    return {
      runtime,
      git,
      ledgers,
      symptomMatches,
      changedFiles,
      configDeltas: changedFiles.filter((file: string) => isConfigFile(file)),
      dependencyDeltas: changedFiles.filter((file: string) => isDependencyFile(file))
    };
  }

  private async runFailingCommand(command: string, timeoutMs: number): Promise<AutopsyEvidence> {
    const parsedCommand = parseAllowedCommand(command);
    try {
      const { stdout, stderr } = await execFileAsync(parsedCommand.command, parsedCommand.args, {
        cwd: this.workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });
      const combined = `${stderr}\n${stdout}`;
      return {
        kind: "command-run",
        command,
        ok: true,
        exitCode: 0,
        errorSummary: extractErrorSummary(combined),
        stackFrames: extractStackFrames(combined, this.workspaceRoot),
        causalChain: ["Command completed successfully; autopsy should be used to explain non-crash symptoms."],
        stdout: trim(stdout),
        stderr: trim(stderr)
      };
    } catch (error: any) {
      const stdout = String(error.stdout ?? "");
      const stderr = String(error.stderr ?? error.message ?? "");
      const combined = `${stderr}\n${stdout}`;
      return {
        kind: "command-run",
        command,
        ok: false,
        exitCode: typeof error.code === "number" ? error.code : 1,
        errorSummary: extractErrorSummary(combined),
        stackFrames: extractStackFrames(combined, this.workspaceRoot),
        causalChain: [`Command failed with exit code ${typeof error.code === "number" ? error.code : 1}.`],
        stdout: trim(stdout),
        stderr: trim(stderr)
      };
    }
  }

  private async readRuntimeRun(runId: string): Promise<AutopsyEvidence> {
    const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "");
    if (!safe) return noRuntimeEvidence();
    const runDir = path.join(runtimeBasePath(this.workspaceRoot), safe);
    const record = await readJson<Record<string, any> | null>(path.join(runDir, "run.json"), null);
    if (!record) return noRuntimeEvidence(`Runtime run ${safe} was not found.`);
    const autopsy = await readJson<Record<string, any> | null>(record.autopsyPath ?? path.join(runDir, "autopsy.json"), null);
    const stdout = await fs.readFile(record.stdoutPath, "utf8").catch(() => "");
    const stderr = await fs.readFile(record.stderrPath, "utf8").catch(() => "");
    if (autopsy) {
      return {
        kind: "runtime-run",
        runId: safe,
        command: record.command,
        ok: record.status === "exited",
        exitCode: record.exitCode,
        status: record.status,
        errorSummary: String(autopsy.errorSummary ?? extractErrorSummary(`${stderr}\n${stdout}`)),
        stackFrames: normalizeAutopsyFrames(autopsy.frames ?? [], this.workspaceRoot),
        causalChain: Array.isArray(autopsy.causalChain) ? autopsy.causalChain.map(String) : [],
        stdout: trim(stdout),
        stderr: trim(stderr)
      };
    }
    const combined = `${stderr}\n${stdout}`;
    return {
      kind: "runtime-run",
      runId: safe,
      command: record.command,
      ok: record.status === "exited",
      exitCode: record.exitCode,
      status: record.status,
      errorSummary: extractErrorSummary(combined),
      stackFrames: extractStackFrames(combined, this.workspaceRoot),
      causalChain: ["Runtime autopsy report was missing; using captured logs."],
      stdout: trim(stdout),
      stderr: trim(stderr)
    };
  }

  private async gitEvidence(): Promise<Record<string, any>> {
    const status = await gitOutput(this.workspaceRoot, ["status", "--porcelain"]);
    const diffStat = await gitOutput(this.workspaceRoot, ["diff", "--stat", "HEAD"]);
    const recentCommits = await gitOutput(this.workspaceRoot, ["log", "--oneline", "--max-count=8"]);
    return {
      gitAvailable: status.ok || diffStat.ok || recentCommits.ok,
      status: status.stdout.trim(),
      diffStat: diffStat.stdout.trim(),
      recentCommits: recentCommits.stdout.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean),
      changedFiles: parseGitStatus(status.stdout)
    };
  }

  private async ledgerEvidence(): Promise<Record<string, any>> {
    return {
      proof: await readJson(path.join(this.workspaceRoot, ".mesh", "proof-carrying-change", "proof.json"), null),
      selfDefense: await readJson(path.join(this.workspaceRoot, ".mesh", "security", "last-self-defense.json"), null),
      precrime: await readJson(path.join(this.workspaceRoot, ".mesh", "precrime", "predictions.json"), null),
      shadowDeploy: await readJson(path.join(this.workspaceRoot, ".mesh", "shadow-deploy", "last-ledger.json"), null),
      specCode: await readJson(path.join(this.workspaceRoot, ".mesh", "spec-code", "contracts.json"), null),
      fluidMesh: await readJson(path.join(this.workspaceRoot, ".mesh", "fluid-mesh", "capabilities.json"), null),
      livingSoftware: await readJson(path.join(this.workspaceRoot, ".mesh", "living-software", "pulse.json"), null)
    };
  }

  private async symptomMatches(symptom: string): Promise<Array<{ file: string; matches: string[] }>> {
    const tokens = symptomTokens(symptom);
    if (tokens.length === 0) return [];
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 1000 });
    const matches: Array<{ file: string; matches: string[] }> = [];
    for (const file of files) {
      const haystack = `${file}\n${await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "")}`.toLowerCase();
      const hits = tokens.filter((token) => haystack.includes(token));
      if (hits.length > 0) matches.push({ file, matches: hits });
    }
    return matches.slice(0, 50);
  }

  private ledgerPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "causal-autopsy", "last-autopsy.json");
  }
}

function rankSuspects(evidence: Record<string, any>): Suspect[] {
  const scores = new Map<string, Suspect>();
  const bump = (file: string, amount: number, reason: string) => {
    const normalized = normalizeWorkspacePath(file);
    if (!normalized || normalized.includes("node_modules")) return;
    const current = scores.get(normalized) ?? { file: normalized, score: 0, confidence: 0, reasons: [] };
    current.score += amount;
    if (!current.reasons.includes(reason)) current.reasons.push(reason);
    scores.set(normalized, current);
  };

  for (const frame of evidence.runtime.stackFrames ?? []) bump(frame.file, 70, "Appears in runtime stack evidence.");
  for (const file of evidence.changedFiles ?? []) bump(file, 28, "Changed in the current workspace diff.");
  for (const match of evidence.symptomMatches ?? []) bump(match.file, 12 + match.matches.length * 6, `Matches symptom token(s): ${match.matches.join(", ")}.`);
  for (const prediction of evidence.ledgers.precrime?.predictions ?? []) {
    bump(prediction.file, Math.ceil(Number(prediction.probability ?? 0) * 45), "Precrime flagged this file as likely failure surface.");
  }
  for (const finding of evidence.ledgers.selfDefense?.findings ?? []) {
    bump(finding.file, finding.status === "confirmed" ? 45 : 25, `Self-defense finding: ${finding.status}.`);
  }
  for (const contract of evidence.ledgers.specCode?.drift ?? []) {
    if (contract.contract?.file) bump(contract.contract.file, 22, `Spec-code drift: ${contract.kind}.`);
  }
  for (const file of evidence.configDeltas ?? []) bump(file, 18, "Configuration delta can change runtime behavior.");
  for (const file of evidence.dependencyDeltas ?? []) bump(file, 20, "Dependency delta can change behavior outside source diff.");

  const ranked = Array.from(scores.values())
    .map((item) => ({
      ...item,
      confidence: Math.min(0.98, Number((item.score / 100).toFixed(2)))
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
  return ranked;
}

function buildCausalChain(symptom: string, evidence: Record<string, any>, suspects: Suspect[]): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  chain.push({
    step: "symptom",
    statement: symptom || evidence.runtime.errorSummary || "No explicit symptom supplied.",
    confidence: symptom ? 0.9 : 0.45
  });
  if (evidence.runtime.kind !== "none") {
    chain.push({
      step: "runtime-evidence",
      statement: evidence.runtime.errorSummary,
      confidence: evidence.runtime.stackFrames.length > 0 ? 0.9 : 0.55,
      frames: evidence.runtime.stackFrames.slice(0, 5)
    });
  }
  if (suspects[0]) {
    chain.push({
      step: "likely-source",
      statement: `${suspects[0].file} is the strongest causal suspect.`,
      confidence: suspects[0].confidence,
      reasons: suspects[0].reasons
    });
  }
  if ((evidence.configDeltas ?? []).length > 0 || (evidence.dependencyDeltas ?? []).length > 0) {
    chain.push({
      step: "environment-delta",
      statement: "Config or dependency changes may have altered behavior outside direct source edits.",
      confidence: 0.65,
      configDeltas: evidence.configDeltas,
      dependencyDeltas: evidence.dependencyDeltas
    });
  }
  if (!evidence.ledgers.proof) {
    chain.push({
      step: "missing-proof",
      statement: "No proof-carrying change bundle exists for this incident.",
      confidence: 0.7
    });
  }
  return chain;
}

function buildCausalGraph(symptom: string, evidence: Record<string, any>, suspects: Suspect[]): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = [
    { id: "symptom", type: "symptom", label: symptom || evidence.runtime.errorSummary || "unspecified symptom" }
  ];
  const edges: Array<Record<string, unknown>> = [];
  if (evidence.runtime.kind !== "none") {
    nodes.push({ id: "runtime", type: "runtime", label: evidence.runtime.errorSummary });
    edges.push({ from: "runtime", to: "symptom", type: "observes", confidence: evidence.runtime.stackFrames.length > 0 ? 0.9 : 0.55 });
  }
  for (const suspect of suspects.slice(0, 6)) {
    const id = `file:${suspect.file}`;
    nodes.push({ id, type: "file", label: suspect.file, score: suspect.score, reasons: suspect.reasons });
    edges.push({ from: id, to: evidence.runtime.kind !== "none" ? "runtime" : "symptom", type: "may_cause", confidence: suspect.confidence });
  }
  if (evidence.ledgers.proof) {
    nodes.push({ id: "proof", type: "proof", label: `proof:${evidence.ledgers.proof.proofId ?? "current"}`, verdict: evidence.ledgers.proof.verdict });
    edges.push({ from: "proof", to: "symptom", type: "constrains_debugging", confidence: 0.7 });
  }
  return { nodes, edges };
}

function missingInvariants(evidence: Record<string, any>, suspects: Suspect[]): string[] {
  const invariants: string[] = [];
  const top = suspects[0]?.file;
  if (top) invariants.push(`Add a focused regression that fails before the fix and covers ${top}.`);
  if ((evidence.runtime.stackFrames ?? []).length === 0) invariants.push("Capture runtime stack evidence or a failing command before patching.");
  if (!evidence.ledgers.specCode) invariants.push("Synthesize spec-code contracts so behavior drift is visible.");
  if (!evidence.ledgers.proof) invariants.push("Generate a proof-carrying change bundle before promotion.");
  if (evidence.ledgers.shadowDeploy?.ok !== true) invariants.push("Run a shadow deploy or timeline verification command for the suspected path.");
  return Array.from(new Set(invariants));
}

function nextActions(evidence: Record<string, any>, suspects: Suspect[]): string[] {
  const top = suspects[0]?.file;
  return [
    top ? `Inspect ${top} first; it has the strongest combined evidence.` : "Collect a failing command or runtime runId to improve causal confidence.",
    "Use a timeline for the candidate fix and run the failing command there.",
    "Regenerate workspace.proof_carrying_change after the fix so review has intent, tests, risk, rollback, and ledger evidence."
  ];
}

function noRuntimeEvidence(message = "No runtime run or failing command supplied."): AutopsyEvidence {
  return {
    kind: "none",
    errorSummary: message,
    stackFrames: [],
    causalChain: []
  };
}

function normalizeAutopsyFrames(frames: Array<Record<string, any>>, workspaceRoot: string): StackFrame[] {
  return frames.map((frame) => ({
    file: normalizeFrameFile(String(frame.file ?? ""), workspaceRoot),
    line: Number(frame.line ?? 0),
    column: typeof frame.column === "number" ? frame.column : undefined,
    raw: String(frame.raw ?? "")
  })).filter((frame) => Boolean(frame.file));
}

function extractErrorSummary(output: string): string {
  const lines = output.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /\b(?:error|exception|failed|assertion)\b/i.test(line)) ?? "No explicit error found in captured output.";
}

function extractStackFrames(output: string, workspaceRoot: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const re = /\bat\s+(?:[^\s(]+\s+\()?(.+?):(\d+):(\d+)\)?/g;
  for (const match of output.matchAll(re)) {
    const file = normalizeFrameFile(match[1], workspaceRoot);
    if (!file) continue;
    frames.push({
      file,
      line: Number(match[2]),
      column: Number(match[3]),
      raw: match[0]
    });
  }
  return frames.slice(0, 25);
}

function normalizeFrameFile(file: string, workspaceRoot: string): string {
  if (!file || file.startsWith("node:") || file.includes("node:internal")) return "";
  const withoutProtocol = file.replace(/^file:\/\//, "");
  if (path.isAbsolute(withoutProtocol)) {
    const relative = path.relative(workspaceRoot, withoutProtocol).split(path.sep).join("/");
    return relative.startsWith("..") ? withoutProtocol : relative;
  }
  return normalizeWorkspacePath(withoutProtocol);
}

function symptomTokens(symptom: string): string[] {
  return Array.from(new Set(symptom
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !["with", "from", "that", "this", "when", "then"].includes(token))))
    .slice(0, 12);
}

function isConfigFile(file: string): boolean {
  return /(^|\/)(\.env|[^/]*(?:config|rc)\.[cm]?[jt]s|tsconfig\.json|vite\.config|next\.config|wrangler\.toml)$/i.test(file);
}

function isDependencyFile(file: string): boolean {
  return /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i.test(file);
}

async function gitOutput(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout };
  } catch (error: any) {
    return { ok: false, stdout: String(error.stdout ?? "") };
  }
}

function parseGitStatus(raw: string): string[] {
  return raw
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawFile = line.slice(3).trim();
      return normalizeWorkspacePath(rawFile.includes(" -> ") ? rawFile.split(" -> ").pop() ?? rawFile : rawFile);
    })
    .filter(Boolean);
}

function runtimeBasePath(workspaceRoot: string): string {
  const workspaceHash = crypto
    .createHash("sha256")
    .update(path.resolve(workspaceRoot))
    .digest("hex")
    .slice(0, 24);
  const stateRoot = process.env.MESH_STATE_DIR || path.join(os.homedir(), ".config", "mesh");
  return path.join(stateRoot, "runtime", workspaceHash);
}

function normalizeWorkspacePath(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\\040/g, " ").split(path.sep).join("/");
}

function trim(value: string, max = 8000): string {
  return value.length > max ? value.slice(-max) : value;
}
