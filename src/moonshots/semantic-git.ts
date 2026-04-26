import { promises as fs } from "node:fs";
import path from "node:path";
import { collectWorkspaceFiles, writeJson } from "./common.js";

interface ConflictHunk {
  file: string;
  startLine: number;
  oursLines: number;
  theirsLines: number;
  classification: "auto_resolvable" | "needs_review";
  reason: string;
}

export class SemanticGitEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "analyze").trim().toLowerCase();
    if (action !== "analyze") throw new Error("workspace.semantic_git action must be analyze");
    const files = typeof args.path === "string" && args.path.trim()
      ? [args.path.trim()]
      : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 1500 });
    const conflicts: ConflictHunk[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw.includes("<<<<<<<")) continue;
      conflicts.push(...extractConflicts(file, raw));
    }
    const result = {
      ok: true,
      action,
      conflicts,
      autoResolvable: conflicts.filter((item) => item.classification === "auto_resolvable").length,
      needsReview: conflicts.filter((item) => item.classification === "needs_review").length,
      semanticMergeReady: conflicts.length > 0 && conflicts.every((item) => item.classification === "auto_resolvable"),
      ledgerPath: ".mesh/semantic-git/last-analysis.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "semantic-git", "last-analysis.json"), result);
    return result;
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
    if (sep === -1 || end === -1 || sep > end) continue;
    const ours = lines.slice(start + 1, sep).join("\n");
    const theirs = lines.slice(sep + 1, end).join("\n");
    const oursSymbols = symbolSet(ours);
    const theirsSymbols = symbolSet(theirs);
    const overlap = [...oursSymbols].filter((symbol) => theirsSymbols.has(symbol));
    const classification = overlap.length === 0 && ours.trim() && theirs.trim() ? "auto_resolvable" : "needs_review";
    hunks.push({
      file,
      startLine: start + 1,
      oursLines: sep - start - 1,
      theirsLines: end - sep - 1,
      classification,
      reason: classification === "auto_resolvable"
        ? "Both sides touch distinct exported/local symbols; concatenate then verify."
        : "Both sides touch the same symbol or one side is structurally ambiguous."
    });
    index = end;
  }
  return hunks;
}

function symbolSet(raw: string): Set<string> {
  const symbols = new Set<string>();
  const regex = /\b(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of raw.matchAll(regex)) {
    symbols.add(match[1]);
  }
  return symbols;
}
