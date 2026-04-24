import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type TimelineKind = "git-worktree" | "copy";
type TimelineStatus = "created" | "patched" | "running" | "passed" | "failed" | "promoted";

export interface TimelineCommandRecord {
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  ok: boolean;
  stdoutPath: string;
  stderrPath: string;
}

export interface TimelineRecord {
  id: string;
  name: string;
  kind: TimelineKind;
  root: string;
  baseRef: string;
  status: TimelineStatus;
  createdAt: string;
  updatedAt: string;
  patches: Array<{ path: string; appliedAt: string; bytes: number }>;
  commands: TimelineCommandRecord[];
  verdict?: "pass" | "fail" | "unknown";
  promotedAt?: string;
}

interface TimelineCreateArgs {
  name?: string;
  baseRef?: string;
}

interface TimelineApplyPatchArgs {
  timelineId: string;
  patch: string;
}

interface TimelineRunArgs {
  timelineId: string;
  command: string;
  timeoutMs?: number;
}

interface TimelineCompareArgs {
  timelineIds: string[];
}

interface TimelinePromoteArgs {
  timelineId: string;
}

export class TimelineManager {
  public readonly workspaceHash: string;
  public readonly basePath: string;

  constructor(private readonly workspaceRoot: string) {
    this.workspaceHash = crypto
      .createHash("sha256")
      .update(path.resolve(workspaceRoot))
      .digest("hex")
      .slice(0, 24);
    this.basePath = path.join(os.homedir(), ".config", "mesh", "timelines", this.workspaceHash);
  }

  async create(args: TimelineCreateArgs = {}): Promise<{ ok: true; timeline: TimelineRecord }> {
    const id = `tl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const name = sanitizeName(args.name || id);
    const root = path.join(this.basePath, id, "workspace");
    const baseRef = args.baseRef?.trim() || "HEAD";
    await fs.mkdir(path.dirname(root), { recursive: true });

    let kind: TimelineKind = "copy";
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.workspaceRoot });
      await execFileAsync("git", ["worktree", "add", "--detach", root, baseRef], {
        cwd: this.workspaceRoot,
        maxBuffer: 1024 * 1024
      });
      kind = "git-worktree";
    } catch {
      await copyWorkspace(this.workspaceRoot, root);
    }

    const timeline: TimelineRecord = {
      id,
      name,
      kind,
      root,
      baseRef,
      status: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      patches: [],
      commands: [],
      verdict: "unknown"
    };
    await this.writeRecord(timeline);
    return { ok: true, timeline };
  }

  async list(): Promise<{ ok: true; timelines: TimelineRecord[] }> {
    await fs.mkdir(this.basePath, { recursive: true });
    const entries = await fs.readdir(this.basePath, { withFileTypes: true }).catch(() => []);
    const timelines: TimelineRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await this.readRecord(entry.name).catch(() => null);
      if (record) timelines.push(record);
    }
    timelines.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { ok: true, timelines };
  }

  async applyPatch(args: TimelineApplyPatchArgs): Promise<{ ok: boolean; timelineId: string; message: string; stderr?: string }> {
    const timeline = await this.readRecord(args.timelineId);
    const patch = args.patch ?? "";
    if (!patch.trim()) throw new Error("workspace.timeline_apply_patch requires patch");

    const patchPath = path.join(this.basePath, timeline.id, "patches", `${Date.now()}.patch`);
    await fs.mkdir(path.dirname(patchPath), { recursive: true });
    await fs.writeFile(patchPath, patch, "utf8");

    const applied = await runWithInput("git", ["apply", "--whitespace=nowarn", "-"], patch, timeline.root);
    if (!applied.ok) {
      return {
        ok: false,
        timelineId: timeline.id,
        message: "Patch rejected by git apply.",
        stderr: applied.stderr
      };
    }

    timeline.status = "patched";
    timeline.updatedAt = new Date().toISOString();
    timeline.patches.push({
      path: patchPath,
      appliedAt: timeline.updatedAt,
      bytes: Buffer.byteLength(patch, "utf8")
    });
    await this.writeRecord(timeline);
    return { ok: true, timelineId: timeline.id, message: "Patch applied in isolated timeline." };
  }

  async run(args: TimelineRunArgs): Promise<{
    ok: boolean;
    timelineId: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    commandRecord: TimelineCommandRecord;
  }> {
    const timeline = await this.readRecord(args.timelineId);
    const command = args.command?.trim();
    if (!command) throw new Error("workspace.timeline_run requires command");

    timeline.status = "running";
    timeline.updatedAt = new Date().toISOString();
    await this.writeRecord(timeline);

    const runDir = path.join(this.basePath, timeline.id, "runs", Date.now().toString());
    await fs.mkdir(runDir, { recursive: true });
    const stdoutPath = path.join(runDir, "stdout.log");
    const stderrPath = path.join(runDir, "stderr.log");
    const startedAt = new Date().toISOString();
    const result = await runShell(command, timeline.root, args.timeoutMs ?? 120_000);
    await fs.writeFile(stdoutPath, result.stdout, "utf8");
    await fs.writeFile(stderrPath, result.stderr, "utf8");

    const commandRecord: TimelineCommandRecord = {
      command,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      ok: result.ok,
      stdoutPath,
      stderrPath
    };
    timeline.commands.push(commandRecord);
    timeline.status = result.ok ? "passed" : "failed";
    timeline.verdict = result.ok ? "pass" : "fail";
    timeline.updatedAt = commandRecord.finishedAt;
    await this.writeRecord(timeline);

    return {
      ok: result.ok,
      timelineId: timeline.id,
      exitCode: result.exitCode,
      stdout: trimLog(result.stdout),
      stderr: trimLog(result.stderr),
      commandRecord
    };
  }

  async compare(args: TimelineCompareArgs): Promise<{ ok: true; comparisons: Array<Record<string, unknown>> }> {
    const ids = Array.isArray(args.timelineIds) ? args.timelineIds : [];
    if (ids.length === 0) throw new Error("workspace.timeline_compare requires timelineIds");

    const comparisons = [];
    for (const id of ids) {
      const timeline = await this.readRecord(id);
      const diffStat = await gitOutput(["diff", "--stat"], timeline.root);
      const diffPreview = await gitOutput(["diff", "--", "."], timeline.root);
      const lastCommand = timeline.commands.at(-1);
      comparisons.push({
        id: timeline.id,
        name: timeline.name,
        kind: timeline.kind,
        status: timeline.status,
        verdict: timeline.verdict ?? "unknown",
        root: timeline.root,
        diffStat: diffStat || "No tracked diff.",
        diffPreview: trimLog(diffPreview, 8000),
        lastCommand
      });
    }
    return { ok: true, comparisons };
  }

  async promote(args: TimelinePromoteArgs): Promise<{ ok: boolean; timelineId: string; message: string; stderr?: string }> {
    const timeline = await this.readRecord(args.timelineId);
    if (timeline.verdict !== "pass") {
      return {
        ok: false,
        timelineId: timeline.id,
        message: "Timeline has not passed verification. Run workspace.timeline_run first or review the failed verdict."
      };
    }

    const diff = await gitOutput(["diff", "--binary"], timeline.root);
    if (!diff.trim()) {
      return { ok: true, timelineId: timeline.id, message: "No tracked diff to promote." };
    }

    const applied = await runWithInput("git", ["apply", "--whitespace=nowarn", "-"], diff, this.workspaceRoot);
    if (!applied.ok) {
      return {
        ok: false,
        timelineId: timeline.id,
        message: "Promotion failed while applying timeline diff to main workspace.",
        stderr: applied.stderr
      };
    }

    timeline.status = "promoted";
    timeline.promotedAt = new Date().toISOString();
    timeline.updatedAt = timeline.promotedAt;
    await this.writeRecord(timeline);
    return { ok: true, timelineId: timeline.id, message: "Timeline diff promoted to the main workspace." };
  }

  async readRecord(id: string): Promise<TimelineRecord> {
    const safeId = sanitizeId(id);
    const raw = await fs.readFile(path.join(this.basePath, safeId, "timeline.json"), "utf8");
    return JSON.parse(raw) as TimelineRecord;
  }

  private async writeRecord(record: TimelineRecord): Promise<void> {
    await fs.mkdir(path.join(this.basePath, record.id), { recursive: true });
    await fs.writeFile(path.join(this.basePath, record.id, "timeline.json"), JSON.stringify(record, null, 2), "utf8");
  }
}

async function copyWorkspace(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const rel = path.relative(source, sourcePath).split(path.sep).join("/");
      if (!rel) return true;
      return !/(^|\/)(\.git|node_modules|dist|coverage|\.next|\.turbo|\.cache)(\/|$)/.test(rel);
    }
  });
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : code ?? 0;
      resolve({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr: timedOut ? `[TIMEOUT after ${Math.round(timeoutMs / 1000)}s]\n${stderr}` : stderr
      });
    });
  });
}

async function runWithInput(command: string, args: string[], input: string, cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 5 * 1024 * 1024 });
    return stdout;
  } catch (error: any) {
    return error.stdout || "";
  }
}

function trimLog(value: string, limit = 12000): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, Math.floor(limit * 0.35));
  const tail = value.slice(-Math.floor(limit * 0.55));
  return `${head}\n\n... [${value.length - head.length - tail.length} bytes omitted] ...\n\n${tail}`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "timeline";
}

function sanitizeId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "");
  if (!safe) throw new Error("Invalid timeline id");
  return safe;
}
