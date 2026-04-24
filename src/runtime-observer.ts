import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

type RuntimeStatus = "running" | "exited" | "failed" | "timeout";

interface RuntimeRunRecord {
  id: string;
  command: string;
  profile?: string;
  cwd: string;
  status: RuntimeStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  stdoutPath: string;
  stderrPath: string;
}

interface RunProfile {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class RuntimeObserver {
  public readonly workspaceHash: string;
  public readonly basePath: string;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly workspaceRoot: string) {
    this.workspaceHash = crypto
      .createHash("sha256")
      .update(path.resolve(workspaceRoot))
      .digest("hex")
      .slice(0, 24);
    this.basePath = path.join(os.homedir(), ".config", "mesh", "runtime", this.workspaceHash);
  }

  async start(args: Record<string, unknown>): Promise<{
    ok: true;
    runId: string;
    status: RuntimeStatus;
    command: string;
    stdoutPath: string;
    stderrPath: string;
    note: string;
  }> {
    const profileName = typeof args.profile === "string" ? args.profile.trim() : "";
    const profile = profileName ? await this.loadProfile(profileName) : {};
    const command = String(args.command ?? profile.command ?? "").trim();
    if (!command) throw new Error("runtime.start requires command or a runbook profile with command");

    const id = `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const runDir = path.join(this.basePath, id);
    await fs.mkdir(runDir, { recursive: true });
    const stdoutPath = path.join(runDir, "stdout.log");
    const stderrPath = path.join(runDir, "stderr.log");
    const cwd = path.resolve(this.workspaceRoot, profile.cwd || ".");
    const record: RuntimeRunRecord = {
      id,
      command,
      profile: profileName || undefined,
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath
    };
    await this.writeRecord(record);

    const stdoutHandle = await fs.open(stdoutPath, "a");
    const stderrHandle = await fs.open(stderrPath, "a");
    const child = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env, ...(profile.env ?? {}) }
    });
    this.processes.set(id, child);
    const timeoutMs = Number(args.timeoutMs ?? profile.timeoutMs ?? 0);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill("SIGTERM");
          void this.finishRun(id, "timeout", 124);
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      void stdoutHandle.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      void stderrHandle.write(chunk);
    });
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      this.processes.delete(id);
      void stdoutHandle.close();
      void stderrHandle.close();
      void this.finishRun(id, "failed", 1);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      this.processes.delete(id);
      void stdoutHandle.close();
      void stderrHandle.close();
      void this.finishRun(id, code === 0 ? "exited" : "failed", code ?? 0);
    });

    child.unref();
    return {
      ok: true,
      runId: id,
      status: "running",
      command,
      stdoutPath,
      stderrPath,
      note: "Runtime observer started. Use runtime.capture_failure or runtime.explain_failure with this runId."
    };
  }

  async captureFailure(args: Record<string, unknown>): Promise<{
    ok: true;
    runId: string;
    status: RuntimeStatus;
    exitCode?: number;
    errorSummary: string;
    stackFrames: Array<{ file: string; line: number; column?: number; raw: string }>;
    stdoutTail: string;
    stderrTail: string;
  }> {
    const record = await this.readRecord(String(args.runId ?? ""));
    const stdoutTail = await tail(record.stdoutPath);
    const stderrTail = await tail(record.stderrPath);
    const combined = `${stderrTail}\n${stdoutTail}`;
    const stackFrames = extractStackFrames(combined);
    const errorSummary = extractErrorSummary(combined);
    return {
      ok: true,
      runId: record.id,
      status: record.status,
      exitCode: record.exitCode,
      errorSummary,
      stackFrames,
      stdoutTail,
      stderrTail
    };
  }

  async explainFailure(args: Record<string, unknown>): Promise<{
    ok: true;
    runId: string;
    explanation: string;
    likelySourceFiles: string[];
    stackFrames: Array<{ file: string; line: number; column?: number; raw: string }>;
    nextActions: string[];
  }> {
    const failure = await this.captureFailure(args);
    const likelySourceFiles = Array.from(new Set(failure.stackFrames.map((frame) => frame.file))).slice(0, 10);
    const explanation =
      failure.errorSummary === "No explicit error found in captured output."
        ? `Run ${failure.runId} is ${failure.status}; no explicit stack trace was captured.`
        : `${failure.errorSummary} in run ${failure.runId}.`;
    return {
      ok: true,
      runId: failure.runId,
      explanation,
      likelySourceFiles,
      stackFrames: failure.stackFrames,
      nextActions: [
        "Use workspace.impact_map with the top stack frame file.",
        "Create a timeline and test a candidate fix before promoting it.",
        "Re-run the same command in the timeline to verify the failure is gone."
      ]
    };
  }

  async traceRequest(args: Record<string, unknown>): Promise<{
    ok: true;
    query: string;
    hints: string[];
  }> {
    const query = String(args.url ?? args.testName ?? args.stackFrame ?? "").trim();
    if (!query) throw new Error("runtime.trace_request requires url, testName, or stackFrame");
    const normalized = query.replace(/^https?:\/\/[^/]+/, "");
    const hints = [
      `Search routes for ${normalized}`,
      `Use workspace.ask_codebase with mode runtime-path and query "${normalized}"`,
      "If a stack frame is known, use workspace.impact_map on that file."
    ];
    return { ok: true, query, hints };
  }

  async fixFailure(args: Record<string, unknown>): Promise<{
    ok: true;
    runId: string;
    task: string;
    recommendedTools: string[];
  }> {
    const failure = await this.explainFailure(args);
    return {
      ok: true,
      runId: failure.runId,
      task: [
        `Fix runtime failure ${failure.runId}.`,
        failure.explanation,
        failure.likelySourceFiles.length > 0 ? `Likely files: ${failure.likelySourceFiles.join(", ")}` : "No source file identified yet."
      ].join("\n"),
      recommendedTools: [
        "workspace.timeline_create",
        "workspace.timeline_apply_patch",
        "workspace.timeline_run",
        "workspace.timeline_promote"
      ]
    };
  }

  async writeDefaultRunbooks(): Promise<void> {
    const runbooksDir = path.join(this.workspaceRoot, ".mesh", "runbooks");
    await fs.mkdir(runbooksDir, { recursive: true });
    const nodeRunbook = path.join(runbooksDir, "node.json");
    const exists = await fs.access(nodeRunbook).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(
        nodeRunbook,
        JSON.stringify(
          {
            command: "npm run dev",
            cwd: ".",
            timeoutMs: 60000,
            env: {
              NODE_ENV: "development"
            }
          },
          null,
          2
        ),
        "utf8"
      );
    }
  }

  private async loadProfile(profileName: string): Promise<RunProfile> {
    const safe = profileName.replace(/[^a-zA-Z0-9._-]+/g, "");
    const profilePath = path.join(this.workspaceRoot, ".mesh", "runbooks", `${safe}.json`);
    const raw = await fs.readFile(profilePath, "utf8");
    return JSON.parse(raw) as RunProfile;
  }

  private async readRecord(runId: string): Promise<RuntimeRunRecord> {
    const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "");
    if (!safe) throw new Error("runtime runId is required");
    const raw = await fs.readFile(path.join(this.basePath, safe, "run.json"), "utf8");
    return JSON.parse(raw) as RuntimeRunRecord;
  }

  private async writeRecord(record: RuntimeRunRecord): Promise<void> {
    await fs.mkdir(path.join(this.basePath, record.id), { recursive: true });
    await fs.writeFile(path.join(this.basePath, record.id, "run.json"), JSON.stringify(record, null, 2), "utf8");
  }

  private async finishRun(runId: string, status: RuntimeStatus, exitCode: number): Promise<void> {
    const record = await this.readRecord(runId).catch(() => null);
    if (!record || record.status === "timeout") return;
    record.status = status;
    record.exitCode = exitCode;
    record.finishedAt = new Date().toISOString();
    await this.writeRecord(record);
  }
}

async function tail(filePath: string, limit = 12000): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (raw.length <= limit) return raw;
  return raw.slice(-limit);
}

function extractErrorSummary(output: string): string {
  const lines = output.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  const explicit = lines.find((line) => /(?:error|exception|failed|fatal):/i.test(line));
  if (explicit) return explicit.slice(0, 500);
  const nodeError = lines.find((line) => /^[A-Z][A-Za-z]+Error\b/.test(line));
  return nodeError?.slice(0, 500) ?? "No explicit error found in captured output.";
}

function extractStackFrames(output: string): Array<{ file: string; line: number; column?: number; raw: string }> {
  const frames: Array<{ file: string; line: number; column?: number; raw: string }> = [];
  const patterns = [
    /\(?([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+)\)?/g,
    /at\s+([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):(\d+)/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const file = match[1].replace(process.cwd(), "").replace(/^\/+/, "");
      frames.push({
        file,
        line: Number(match[2]),
        column: Number(match[3]),
        raw: match[0]
      });
    }
  }
  return Array.from(new Map(frames.map((frame) => [`${frame.file}:${frame.line}:${frame.column}`, frame])).values()).slice(0, 20);
}
