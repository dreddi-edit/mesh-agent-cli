import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { StructuredLogger } from "./structured-logger.js";

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
  autopsyPath?: string;
  inspectorHookPath?: string;
  nodeOptions?: string;
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
  private readonly autopsyHookPath: string;
  private readonly logger: StructuredLogger;

  constructor(private readonly workspaceRoot: string) {
    this.workspaceHash = crypto
      .createHash("sha256")
      .update(path.resolve(workspaceRoot))
      .digest("hex")
      .slice(0, 24);
    const stateRoot = process.env.MESH_STATE_DIR || path.join(os.homedir(), ".config", "mesh");
    this.basePath = path.join(stateRoot, "runtime", this.workspaceHash);
    this.autopsyHookPath = path.join(this.basePath, "autopsy-hook.cjs");
    this.logger = new StructuredLogger(workspaceRoot);
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
    const autopsyPath = path.join(runDir, "autopsy.json");
    const cwd = path.resolve(this.workspaceRoot, profile.cwd || ".");
    const hookPath = await this.ensureAutopsyHook();
    const nodeOptions = mergeNodeOptions(process.env.NODE_OPTIONS, [
      "--enable-source-maps",
      `--require=${hookPath}`
    ]);
    const record: RuntimeRunRecord = {
      id,
      command,
      profile: profileName || undefined,
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      autopsyPath,
      inspectorHookPath: hookPath,
      nodeOptions
    };
    await this.writeRecord(record);
    void this.logger.write("info", "runtime.start", { runId: id, command, cwd, profile: profileName || undefined }).catch(() => undefined);

    const stdoutHandle = await fs.open(stdoutPath, "a");
    const stderrHandle = await fs.open(stderrPath, "a");
    const env = {
      ...process.env,
      ...(profile.env ?? {}),
      NODE_OPTIONS: nodeOptions,
      MESH_RUNTIME_AUTOPSY_PATH: autopsyPath,
      MESH_RUNTIME_RUN_ID: id
    };
    const child = spawn("sh", ["-c", command], {
      cwd,
      env
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

  async close(): Promise<void> {
    for (const child of this.processes.values()) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
    this.processes.clear();
    void this.logger.write("info", "runtime.shutdown", {}).catch(() => undefined);
  }

  async captureDeepAutopsy(args: Record<string, unknown>): Promise<{
    ok: true;
    runId: string;
    reportPath: string;
    capturedAt: string;
    reason: string;
    frames: RuntimeAutopsyFrame[];
    stackWithScope: any[];
    errorSummary: string;
    causalChain: string[];
  }> {
    const runId = String(args.runId ?? "");
    const record = await this.readRecord(runId);
    const reportPath = record.autopsyPath ?? path.join(path.dirname(record.stdoutPath), "autopsy.json");
    const report = await this.readAutopsyReport(reportPath);

    if (report) {
      return {
        ok: true,
        runId,
        reportPath,
        capturedAt: report.capturedAt,
        reason: report.reason,
        frames: report.frames,
        stackWithScope: report.frames.map((frame) => ({
          file: frame.file,
          line: frame.line,
          column: frame.column,
          raw: frame.raw,
          functionName: frame.functionName,
          scopes: frame.scopes
        })),
        errorSummary: report.errorSummary,
        causalChain: report.causalChain
      };
    }

    const stdoutTail = await tail(record.stdoutPath, 5000);
    const stderrTail = await tail(record.stderrPath, 5000);
    const combined = `${stderrTail}\n${stdoutTail}`;
    const frames = extractStackFrames(combined);
    const errorSummary = extractErrorSummary(combined);
    const causalChain = buildCausalChain(errorSummary, frames);

    return {
      ok: true,
      runId,
      reportPath,
      capturedAt: record.finishedAt ?? record.startedAt,
      reason: "log-fallback",
      frames: frames.map((frame) => ({
        ...frame,
        functionName: "(unknown)",
        scopes: []
      })),
      stackWithScope: frames.map((frame) => ({
        ...frame,
        scope: {
          local: { reason: "Inspector report missing; using log fallback", state: "best-effort" },
          closure: {}
        }
      })),
      errorSummary,
      causalChain
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

  private async ensureAutopsyHook(): Promise<string> {
    await fs.mkdir(this.basePath, { recursive: true });
    const current = await fs.readFile(this.autopsyHookPath, "utf8").catch(() => "");
    const next = buildAutopsyHookSource();
    if (current !== next) {
      await fs.writeFile(this.autopsyHookPath, next, "utf8");
    }
    return this.autopsyHookPath;
  }

  private async readAutopsyReport(reportPath: string): Promise<RuntimeAutopsyReport | null> {
    const raw = await fs.readFile(reportPath, "utf8").catch(() => "");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RuntimeAutopsyReport;
    } catch {
      return null;
    }
  }

  private async finishRun(runId: string, status: RuntimeStatus, exitCode: number): Promise<void> {
    const record = await this.readRecord(runId).catch(() => null);
    if (!record || record.status === "timeout") return;
    record.status = status;
    record.exitCode = exitCode;
    record.finishedAt = new Date().toISOString();
    await this.writeRecord(record);
    void this.logger.write("info", "runtime.finish", { runId, status, exitCode }).catch(() => undefined);
  }
}

async function tail(filePath: string, limit = 12000): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (raw.length <= limit) return raw;
  return raw.slice(-limit);
}

interface RuntimeAutopsyFrame {
  functionName: string;
  file: string;
  line: number;
  column?: number;
  raw: string;
  scopes: RuntimeAutopsyScope[];
}

interface RuntimeAutopsyScope {
  type: string;
  properties: Record<string, string>;
}

interface RuntimeAutopsyReport {
  ok: true;
  runId: string;
  capturedAt: string;
  reason: string;
  errorSummary: string;
  causalChain: string[];
  frames: RuntimeAutopsyFrame[];
}

export function mergeNodeOptions(existing: string | undefined, additions: string[]): string {
  const existingParts = tokenizeNodeOptions(existing ?? "");
  const unsafe = existingParts.filter((entry) => !isAllowedInheritedNodeOption(entry));
  if (unsafe.length > 0) {
    throw new Error(`Unsafe NODE_OPTIONS rejected: ${unsafe.join(" ")}`);
  }
  const parts = [...existingParts, ...additions.map((entry) => entry.trim())].filter(Boolean);
  return Array.from(new Set(parts)).join(" ");
}

function tokenizeNodeOptions(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of raw.trim()) {
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isAllowedInheritedNodeOption(option: string): boolean {
  const allowedExact = new Set([
    "--enable-source-maps",
    "--no-warnings",
    "--trace-warnings",
    "--trace-deprecation",
    "--trace-uncaught"
  ]);
  if (allowedExact.has(option)) return true;

  return [
    /^--max-old-space-size=\d+$/,
    /^--stack-trace-limit=\d+$/,
    /^--unhandled-rejections=(strict|throw|warn|none)$/,
    /^--dns-result-order=(ipv4first|verbatim)$/
  ].some((pattern) => pattern.test(option));
}

function buildCausalChain(errorSummary: string, frames: Array<{ file: string; line: number; column?: number; raw: string }>): string[] {
  const chain = [errorSummary || "No explicit error summary captured."];
  for (const frame of frames.slice(0, 5)) {
    chain.push(`${frame.file}:${frame.line}${frame.column ? `:${frame.column}` : ""}`);
  }
  return chain;
}

function buildAutopsyHookSource(): string {
  return `const inspector = require("node:inspector");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.MESH_RUNTIME_AUTOPSY_PATH && !global.__meshRuntimeAutopsyHookInstalled) {
  global.__meshRuntimeAutopsyHookInstalled = true;

  const reportPath = process.env.MESH_RUNTIME_AUTOPSY_PATH;
  const runId = process.env.MESH_RUNTIME_RUN_ID || "unknown";
  const session = new inspector.Session();
  let captured = false;

  function writeFallbackReport(reason, error) {
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        ok: true,
        runId,
        capturedAt: new Date().toISOString(),
        reason,
        errorSummary: error ? String(error.message || error) : "Inspector hook failed before pause capture.",
        causalChain: [reason],
        frames: []
      }, null, 2), "utf8");
    } catch {}
  }

  function serializeRemoteValue(value) {
    if (!value) return "undefined";
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      const raw = value.value;
      if (typeof raw === "string") return raw.length > 140 ? \`\${raw.slice(0, 137)}...\` : raw;
      if (typeof raw === "number" || typeof raw === "boolean" || raw === null) return String(raw);
      if (Array.isArray(raw)) return \`[array(\${raw.length})]\`;
      if (typeof raw === "object") return JSON.stringify(raw).slice(0, 140);
      return String(raw);
    }
    if (value.type) return String(value.type);
    return "unavailable";
  }

  function post(method, params) {
    return new Promise((resolve, reject) => {
      session.post(method, params || {}, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }

  async function collectScope(scope) {
    const objectId = scope && scope.object && scope.object.objectId;
    if (!objectId) {
      return { type: scope.type || "unknown", properties: {} };
    }
    const response = await post("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      accessorPropertiesOnly: false
    }).catch(() => ({ result: [] }));
    const properties = {};
    for (const entry of (response.result || []).slice(0, 8)) {
      if (!entry || entry.name === "__proto__") continue;
      properties[entry.name] = serializeRemoteValue(entry.value);
    }
    return { type: scope.type || "unknown", properties };
  }

  function normalizeFrameUrl(rawUrl) {
    if (!rawUrl) return "unknown";
    try {
      if (String(rawUrl).startsWith("file://")) {
        return path.relative(process.cwd(), new URL(rawUrl).pathname);
      }
      return path.relative(process.cwd(), String(rawUrl));
    } catch {
      return String(rawUrl);
    }
  }

  session.connect();
  Promise.all([
    post("Runtime.enable"),
    post("Debugger.enable"),
    post("Debugger.setPauseOnExceptions", { state: "all" }),
    post("Debugger.setAsyncCallStackDepth", { maxDepth: 8 })
  ]).catch((error) => writeFallbackReport("inspector-init-failed", error));

  session.on("Debugger.paused", async (message) => {
    if (captured) return;
    captured = true;
    try {
      const frames = [];
      for (const frame of (message.params.callFrames || []).slice(0, 12)) {
        const scopes = [];
        for (const scope of (frame.scopeChain || []).slice(0, 4)) {
          scopes.push(await collectScope(scope));
        }
        frames.push({
          functionName: frame.functionName || "(anonymous)",
          file: normalizeFrameUrl(frame.url),
          line: Number(frame.location && frame.location.lineNumber ? frame.location.lineNumber + 1 : 0),
          column: Number(frame.location && frame.location.columnNumber ? frame.location.columnNumber + 1 : 0),
          raw: [frame.functionName || "(anonymous)", frame.url, frame.location && frame.location.lineNumber].filter(Boolean).join(" @ "),
          scopes
        });
      }
      const description = message.params.data && (message.params.data.description || message.params.data.text);
      const reason = message.params.reason || "exception";
      const errorSummary = description || reason;
      const causalChain = [errorSummary].concat(frames.slice(0, 5).map((frame) => \`\${frame.file}:\${frame.line}\${frame.column ? ":" + frame.column : ""}\`));
      fs.writeFileSync(reportPath, JSON.stringify({
        ok: true,
        runId,
        capturedAt: new Date().toISOString(),
        reason,
        errorSummary,
        causalChain,
        frames
      }, null, 2), "utf8");
    } catch (error) {
      writeFallbackReport("inspector-pause-failed", error);
    } finally {
      try {
        await post("Debugger.resume");
      } catch {}
    }
  });
}`;
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
