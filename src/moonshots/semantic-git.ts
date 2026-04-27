import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runCritic } from "../agents/critic.js";
import { TimelineManager } from "../timeline-manager.js";
import { appendJsonl, collectWorkspaceFiles, readJson, writeJson } from "./common.js";

type ConflictClassification = "auto_resolvable" | "needs_review" | "dangerous";
type ResolveStrategy = "concat_distinct_symbols" | "take_ours" | "take_theirs" | "manual";

interface ConflictHunk {
  id: string;
  file: string;
  startLine: number;
  oursLines: number;
  theirsLines: number;
  oursContent: string;
  theirsContent: string;
  oursSymbols: string[];
  theirsSymbols: string[];
  classification: ConflictClassification;
  strategy: ResolveStrategy;
  confidence: number;
  reason: string;
  startIndex: number;
  endIndex: number;
  semanticFingerprint: string;
}

interface SemanticGitLedger {
  schemaVersion: 2;
  generatedAt: string;
  conflicts: Array<Omit<ConflictHunk, "startIndex" | "endIndex">>;
  autoResolvable: number;
  needsReview: number;
  dangerous: number;
  semanticMergeReady: boolean;
  lastResolution?: Record<string, unknown>;
}

export class SemanticGitEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly timelines?: TimelineManager
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "analyze").trim().toLowerCase();
    switch (action) {
      case "analyze": return this.analyze(args);
      case "plan": return this.plan(args);
      case "resolve": return this.resolve(args);
      case "verify": return this.verify(args);
      case "status": return this.status();
      default:
        throw new Error("workspace.semantic_git action must be analyze|plan|resolve|verify|status");
    }
  }

  private async analyze(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { conflicts } = await this.loadConflicts(args);
    const ledger = buildLedger(conflicts);
    await this.writeLedger(ledger);
    await this.appendEvent("analyze", { conflicts: conflicts.length, autoResolvable: ledger.autoResolvable });
    return {
      ok: true,
      action: "analyze",
      ...ledger,
      ledgerPath: ".mesh/semantic-git/last-analysis.json"
    };
  }

  private async plan(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const loaded = await this.loadConflicts(args);
    const patches = buildResolutionPatches(loaded.rawByFile, loaded.conflicts);
    const plan = {
      ok: true,
      action: "plan",
      conflicts: loaded.conflicts.map(stripInternalIndexes),
      patches,
      canAutoResolve: loaded.conflicts.length > 0 && loaded.conflicts.every((conflict) => conflict.classification === "auto_resolvable"),
      manualReview: loaded.conflicts.filter((conflict) => conflict.classification !== "auto_resolvable").map(stripInternalIndexes),
      ledgerPath: ".mesh/semantic-git/last-plan.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-plan.json"), plan);
    return plan;
  }

  private async resolve(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.timelines) throw new Error("TimelineManager is required for resolve action");
    const loaded = await this.loadConflicts(args);
    const autoResolvable = loaded.conflicts.filter((conflict) => conflict.classification === "auto_resolvable");
    if (autoResolvable.length === 0) {
      return { ok: false, action: "resolve", reason: "No auto-resolvable conflicts found.", ledgerPath: ".mesh/semantic-git/last-analysis.json" };
    }

    const patches = buildResolutionPatches(loaded.rawByFile, autoResolvable);
    const timeline = await this.timelines.create({ name: `semantic-merge-${Date.now().toString(36)}` });
    for (const patch of patches) {
      const targetPath = path.join(timeline.timeline.root, patch.file);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, patch.content, "utf8");
    }

    const verificationCommand = String(args.verificationCommand ?? await inferVerificationCommand(this.workspaceRoot)).trim();
    const run = verificationCommand
      ? await this.timelines.run({
          timelineId: timeline.timeline.id,
          command: verificationCommand,
          timeoutMs: normalizeTimeout(args.timeoutMs)
        })
      : null;
    const diffPreview = patches.map((patch) => patch.diffPreview).join("\n");
    const critic = runCritic({
      diffPreview,
      verificationOk: run?.ok === true
    });
    const promote = args.promote === true;
    const canPromote = promote && run?.ok === true && critic.ok && autoResolvable.length === loaded.conflicts.length;
    const promotion = canPromote ? await this.timelines.promote({ timelineId: timeline.timeline.id }) : null;
    const result = {
      ok: run?.ok === true && critic.ok,
      action: "resolve",
      timelineId: timeline.timeline.id,
      resolvedCount: autoResolvable.length,
      remainingReview: loaded.conflicts.length - autoResolvable.length,
      verification: run
        ? { command: verificationCommand, verdict: run.ok ? "pass" : "fail", exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }
        : { verdict: "not_run", reason: "No verification command inferred or provided." },
      critic,
      promoted: Boolean(promotion && (promotion as any).ok !== false),
      promotion,
      patches: patches.map(({ content, ...patch }) => patch),
      ledgerPath: ".mesh/semantic-git/last-resolution.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-resolution.json"), result);
    await this.appendEvent("resolve", { timelineId: timeline.timeline.id, resolvedCount: autoResolvable.length, promoted: result.promoted });
    return result;
  }

  private async verify(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const analysis = await this.analyze(args);
    const conflicts = (analysis.conflicts ?? []) as Array<{ classification: ConflictClassification }>;
    const gate = conflicts.some((conflict) => conflict.classification === "dangerous")
      ? "block"
      : conflicts.some((conflict) => conflict.classification === "needs_review")
        ? "review"
        : "pass";
    return {
      ...analysis,
      action: "verify",
      gate,
      ok: gate !== "block",
      recommendation: gate === "pass"
        ? "All conflicts are semantic auto-resolve candidates. Run action=resolve in a timeline."
        : gate === "review"
          ? "At least one conflict touches overlapping behavior; require manual review."
          : "Dangerous conflict marker state detected; block promotion."
    };
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-analysis.json"), {
      ok: true,
      action: "status",
      message: "No semantic-git analysis exists yet. Run action=analyze."
    });
  }

  private async loadConflicts(args: Record<string, unknown>): Promise<{ conflicts: ConflictHunk[]; rawByFile: Map<string, string> }> {
    const files = typeof args.path === "string" && args.path.trim()
      ? [normalizePath(args.path)]
      : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 2000 });
    const conflicts: ConflictHunk[] = [];
    const rawByFile = new Map<string, string>();
    for (const file of files) {
      const raw = await fs.readFile(safeJoin(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw.includes("<<<<<<<")) continue;
      rawByFile.set(file, raw);
      conflicts.push(...extractConflicts(file, raw));
    }
    conflicts.sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
    return { conflicts, rawByFile };
  }

  private async writeLedger(ledger: SemanticGitLedger): Promise<void> {
    await writeJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-analysis.json"), ledger);
  }

  private async appendEvent(kind: string, data: Record<string, unknown>): Promise<void> {
    await appendJsonl(path.join(this.workspaceRoot, ".mesh", "semantic-git", "events.jsonl"), {
      at: new Date().toISOString(),
      kind,
      data
    });
  }
}

function extractConflicts(file: string, raw: string): ConflictHunk[] {
  const lines = raw.split(/\r?\n/g);
  const hunks: ConflictHunk[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith("<<<<<<<")) continue;
    const start = index;
    const sep = lines.findIndex((line, offset) => offset > start && line.startsWith("======="));
    const end = lines.findIndex((line, offset) => offset > start && line.startsWith(">>>>>>>"));
    if (sep === -1 || end === -1 || sep > end) {
      hunks.push(dangerousHunk(file, start, lines.length - 1, lines.slice(start).join("\n"), "Malformed conflict marker block."));
      break;
    }
    const ours = lines.slice(start + 1, sep).join("\n");
    const theirs = lines.slice(sep + 1, end).join("\n");
    hunks.push(classifyHunk(file, start, sep, end, ours, theirs));
    index = end;
  }
  return hunks;
}

function classifyHunk(file: string, start: number, sep: number, end: number, ours: string, theirs: string): ConflictHunk {
  const oursSymbols = Array.from(symbolSet(ours));
  const theirsSymbols = Array.from(symbolSet(theirs));
  const overlap = oursSymbols.filter((symbol) => theirsSymbols.includes(symbol));
  const oursFingerprint = semanticFingerprint(ours);
  const theirsFingerprint = semanticFingerprint(theirs);
  const bothNonEmpty = Boolean(ours.trim() && theirs.trim());
  const deletesBehavior = !ours.trim() || !theirs.trim();
  const conflictText = `${ours}\n${theirs}`;
  const dangerous = /<<<<<<<|=======|>>>>>>>/.test(conflictText) || /auth|payment|migration|delete|secret|token/i.test(file);

  let classification: ConflictClassification = "needs_review";
  let strategy: ResolveStrategy = "manual";
  let confidence = 0.35;
  let reason = "Conflict needs review because semantic ownership overlaps or behavior is ambiguous.";

  if (dangerous) {
    classification = "dangerous";
    reason = "Conflict touches a high-risk file or contains nested conflict markers.";
    confidence = 0.05;
  } else if (deletesBehavior) {
    classification = "needs_review";
    reason = "One side deletes behavior; require human intent confirmation.";
    confidence = 0.2;
  } else if (bothNonEmpty && overlap.length === 0 && oursSymbols.length > 0 && theirsSymbols.length > 0 && oursFingerprint !== theirsFingerprint) {
    classification = "auto_resolvable";
    strategy = "concat_distinct_symbols";
    confidence = 0.92;
    reason = "Both sides introduce or edit distinct symbols; preserve both and verify in a timeline.";
  }

  return {
    id: hashTiny(`${file}:${start}:${oursFingerprint}:${theirsFingerprint}`),
    file,
    startLine: start + 1,
    oursLines: sep - start - 1,
    theirsLines: end - sep - 1,
    oursContent: ours,
    theirsContent: theirs,
    oursSymbols,
    theirsSymbols,
    classification,
    strategy,
    confidence,
    reason,
    startIndex: start,
    endIndex: end,
    semanticFingerprint: hashTiny(`${oursFingerprint}:${theirsFingerprint}:${strategy}`)
  };
}

function dangerousHunk(file: string, start: number, end: number, raw: string, reason: string): ConflictHunk {
  return {
    id: hashTiny(`${file}:${start}:dangerous`),
    file,
    startLine: start + 1,
    oursLines: raw.split(/\r?\n/g).length,
    theirsLines: 0,
    oursContent: raw,
    theirsContent: "",
    oursSymbols: Array.from(symbolSet(raw)),
    theirsSymbols: [],
    classification: "dangerous",
    strategy: "manual",
    confidence: 0,
    reason,
    startIndex: start,
    endIndex: end,
    semanticFingerprint: hashTiny(raw)
  };
}

function buildResolutionPatches(rawByFile: Map<string, string>, conflicts: ConflictHunk[]): Array<{
  file: string;
  content: string;
  hunkIds: string[];
  diffPreview: string;
}> {
  const grouped = new Map<string, ConflictHunk[]>();
  for (const conflict of conflicts.filter((item) => item.classification === "auto_resolvable")) {
    const list = grouped.get(conflict.file) ?? [];
    list.push(conflict);
    grouped.set(conflict.file, list);
  }

  const patches = [];
  for (const [file, hunks] of grouped.entries()) {
    const raw = rawByFile.get(file) ?? "";
    const lines = raw.split(/\r?\n/g);
    const hunkIds: string[] = [];
    for (const hunk of hunks.sort((left, right) => right.startIndex - left.startIndex)) {
      const replacement = resolveHunk(hunk);
      lines.splice(hunk.startIndex, hunk.endIndex - hunk.startIndex + 1, ...replacement.split(/\r?\n/g));
      hunkIds.push(hunk.id);
    }
    const content = lines.join("\n");
    patches.push({
      file,
      content,
      hunkIds,
      diffPreview: [
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ semantic merge ${hunkIds.join(",")}`,
        ...hunks.flatMap((hunk) => resolveHunk(hunk).split(/\r?\n/g).slice(0, 20).map((line) => `+${line}`))
      ].join("\n")
    });
  }
  return patches;
}

function resolveHunk(hunk: ConflictHunk): string {
  if (hunk.strategy === "concat_distinct_symbols") {
    return [hunk.oursContent.trimEnd(), hunk.theirsContent.trimEnd()].filter(Boolean).join("\n");
  }
  if (hunk.strategy === "take_ours") return hunk.oursContent;
  if (hunk.strategy === "take_theirs") return hunk.theirsContent;
  return [hunk.oursContent, hunk.theirsContent].filter(Boolean).join("\n");
}

function buildLedger(conflicts: ConflictHunk[]): SemanticGitLedger {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    conflicts: conflicts.map(stripInternalIndexes),
    autoResolvable: conflicts.filter((item) => item.classification === "auto_resolvable").length,
    needsReview: conflicts.filter((item) => item.classification === "needs_review").length,
    dangerous: conflicts.filter((item) => item.classification === "dangerous").length,
    semanticMergeReady: conflicts.length > 0 && conflicts.every((item) => item.classification === "auto_resolvable")
  };
}

function stripInternalIndexes(conflict: ConflictHunk): Omit<ConflictHunk, "startIndex" | "endIndex"> {
  const { startIndex, endIndex, ...rest } = conflict;
  void startIndex;
  void endIndex;
  return rest;
}

function symbolSet(raw: string): Set<string> {
  const symbols = new Set<string>();
  const regex = /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of raw.matchAll(regex)) {
    symbols.add(match[1]);
  }
  return symbols;
}

function semanticFingerprint(raw: string): string {
  const normalized = raw
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

async function inferVerificationCommand(workspaceRoot: string): Promise<string> {
  const packageRaw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8").catch(() => "");
  if (!packageRaw) return "";
  try {
    const pkg = JSON.parse(packageRaw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.typecheck) return "npm run typecheck";
    if (pkg.scripts?.test) return "npm test";
    if (pkg.scripts?.build) return "npm run build";
  } catch {
    return "";
  }
  return "";
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function safeJoin(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${relative}`);
  }
  return absolute;
}

function normalizeTimeout(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(5_000, Math.min(600_000, Math.trunc(parsed))) : 60_000;
}

function hashTiny(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
