import { promises as fs } from "node:fs";
import path from "node:path";
import { TimelineManager } from "../timeline-manager.js";
import { collectWorkspaceFiles, writeJson } from "./common.js";

interface ConflictHunk {
  file: string;
  startLine: number;
  oursLines: number;
  theirsLines: number;
  oursContent: string;
  theirsContent: string;
  classification: "auto_resolvable" | "needs_review";
  reason: string;
  startIndex: number;
  endIndex: number;
}

export class SemanticGitEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly timelines?: TimelineManager
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "analyze").trim().toLowerCase();
    if (!["analyze", "resolve"].includes(action)) {
      throw new Error("workspace.semantic_git action must be analyze or resolve");
    }
    const files = typeof args.path === "string" && args.path.trim()
      ? [args.path.trim()]
      : await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 1500 });
    const conflicts: ConflictHunk[] = [];
    const fileRawMap = new Map<string, string>();
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw.includes("<<<<<<<")) continue;
      fileRawMap.set(file, raw);
      conflicts.push(...extractConflicts(file, raw));
    }

    if (action === "resolve") {
      if (!this.timelines) throw new Error("TimelineManager is required for resolve action");
      
      const autoResolvable = conflicts.filter(c => c.classification === "auto_resolvable");
      if (autoResolvable.length === 0) {
        return { ok: false, reason: "No auto-resolvable conflicts found." };
      }

      // Group conflicts by file and apply them from bottom to top to avoid offset shifting
      const grouped = new Map<string, ConflictHunk[]>();
      for (const c of autoResolvable) {
        const list = grouped.get(c.file) ?? [];
        list.push(c);
        grouped.set(c.file, list);
      }

      const timeline = await this.timelines.create({ name: `semantic-merge-${Date.now().toString(36)}` });
      const ghostRoot = path.join(this.workspaceRoot, timeline.timeline.dir);

      for (const [file, hunks] of grouped.entries()) {
        const raw = fileRawMap.get(file)!;
        const lines = raw.split(/\r?\n/g);
        
        // Sort hunks by startIndex descending
        hunks.sort((a, b) => b.startIndex - a.startIndex);
        
        for (const hunk of hunks) {
          // Splice in ours + theirs sequentially
          const combined = [hunk.oursContent, hunk.theirsContent].filter(Boolean).join("\n");
          lines.splice(hunk.startIndex, hunk.endIndex - hunk.startIndex + 1, combined);
        }

        const newContent = lines.join("\n");
        await fs.writeFile(path.join(ghostRoot, file), newContent, "utf8");
      }

      const run = await this.timelines.run({
        timelineId: timeline.timeline.id,
        command: "npm run typecheck", // Or a configurable verification command
        timeoutMs: 60000
      });

      if (run.ok) {
        await this.timelines.promote({ timelineId: timeline.timeline.id, mergeStrategy: "squash" });
      }

      return {
        ok: run.ok,
        action,
        resolvedCount: autoResolvable.length,
        verification: run.ok ? "pass" : "fail",
        stdout: run.stdout,
        stderr: run.stderr
      };
    }

    const result = {
      ok: true,
      action,
      conflicts: conflicts.map(({ startIndex, endIndex, ...rest }) => rest),
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
      oursContent: ours,
      theirsContent: theirs,
      classification,
      reason: classification === "auto_resolvable"
        ? "Both sides touch distinct exported/local symbols; concatenate then verify."
        : "Both sides touch the same symbol or one side is structurally ambiguous.",
      startIndex: start,
      endIndex: end
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
