import { promises as fs } from "node:fs";
import path from "node:path";
import { TimelineManager } from "../timeline-manager.js";

interface ReplayTraceArgs {
  traceId?: string;
  sentryEventId?: string;
  commitRange?: string;
}

interface TraceFixture {
  id: string;
  source: "otel" | "sentry";
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  spans: Array<{ name: string; file?: string; line?: number; error?: string }>;
  dbMocks?: Array<{ query: string; result: unknown }>;
  apiMocks?: Array<{ endpoint: string; response: unknown }>;
}

export class ReplayEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly timelines: TimelineManager
  ) {}

  async replayTrace(args: ReplayTraceArgs): Promise<Record<string, unknown>> {
    const traceId = String(args.traceId ?? args.sentryEventId ?? "").trim();
    if (!traceId) throw new Error("runtime.replay_trace requires traceId or sentryEventId");
    const trace = await this.loadTrace(traceId);
    if (!trace) {
      return { ok: false, traceId, message: "Trace fixture not found in .mesh/telemetry-traces.json" };
    }

    const checkpoints = trace.spans.map((span, index) => ({
      index,
      span: span.name,
      file: span.file ?? null,
      line: span.line ?? null,
      error: span.error ?? null
    }));

    const divergence = checkpoints.find((checkpoint) => checkpoint.error) ?? checkpoints.at(-1) ?? null;
    const commitAnalysis = args.commitRange
      ? await this.analyzeCommitRange(args.commitRange, trace)
      : null;

    return {
      ok: true,
      traceId,
      source: trace.source,
      reconstructedRequest: {
        method: trace.method,
        path: trace.path,
        headers: trace.headers,
        body: trace.body ?? null
      },
      mockedDependencies: {
        externalApis: trace.apiMocks ?? [],
        databaseQueries: trace.dbMocks ?? []
      },
      checkpoints,
      divergence,
      commitAnalysis
    };
  }

  private async analyzeCommitRange(commitRange: string, trace: TraceFixture): Promise<Record<string, unknown>> {
    const [start = "", end = "HEAD"] = commitRange.split("..");
    const sampleCommit = start || "HEAD~20";
    const timeline = await this.timelines.create({ name: `replay-${trace.id}`, baseRef: sampleCommit });
    const verification = await this.timelines.run({
      timelineId: timeline.timeline.id,
      command: "npm test",
      timeoutMs: 120_000
    });
    return {
      range: commitRange,
      sampledCommit: sampleCommit,
      sampledTimelineId: timeline.timeline.id,
      sampledExitCode: verification.exitCode,
      likelyIntroducedBy: verification.ok ? end : sampleCommit
    };
  }

  private async loadTrace(traceId: string): Promise<TraceFixture | null> {
    const target = path.join(this.workspaceRoot, ".mesh", "telemetry-traces.json");
    try {
      const raw = await fs.readFile(target, "utf8");
      const traces = JSON.parse(raw) as TraceFixture[];
      return traces.find((entry) => entry.id === traceId) ?? null;
    } catch {
      return null;
    }
  }
}
