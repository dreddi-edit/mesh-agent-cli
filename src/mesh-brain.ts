import { promises as fs } from "node:fs";
import path from "node:path";

export interface MeshBrainClientOptions {
  workspaceRoot: string;
  endpoint?: string;
  telemetryContribute: boolean;
}

export interface BrainPattern {
  id: string;
  score: number;
  errorSignature: string;
  diffPattern: string;
  fixSummary: string;
  successRate: number;
  usageCount: number;
  verification?: Record<string, unknown>;
}

export interface BrainContribution {
  workspaceFingerprint: string;
  errorSignature: string;
  diffPattern: string;
  verificationResult: {
    verdict: "pass" | "fail" | "unknown";
    command?: string;
    exitCode?: number;
    tsc?: "pass" | "fail" | "unknown";
    lint?: "pass" | "fail" | "unknown";
  };
}

interface BrainConfig {
  telemetryContribute: boolean;
  endpoint?: string;
}

export function normalizeErrorSignature(raw: string): string {
  const trimmed = raw.slice(0, 8000);
  const normalized = trimmed
    .replace(/[A-Za-z_$][\w$]*/g, "$ID")
    .replace(/\d+/g, "$N")
    .replace(/(["'`]).*?\1/g, "$STR")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 3000) || "unknown-error";
}

export function normalizeDiffPattern(diff: string): string {
  return diff
    .split(/\r?\n/g)
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .map((line) => line
      .replace(/[A-Za-z_$][\w$]*/g, "$V")
      .replace(/\d+/g, "$N")
      .replace(/(["'`]).*?\1/g, "$STR"))
    .join("\n")
    .slice(0, 6000) || "empty-diff";
}

export class MeshBrainClient {
  private readonly telemetryPath: string;
  private endpoint?: string;
  private telemetryContribute: boolean;

  constructor(options: MeshBrainClientOptions) {
    this.telemetryPath = path.join(options.workspaceRoot, ".mesh", "brain.json");
    this.endpoint = options.endpoint?.trim() || undefined;
    this.telemetryContribute = options.telemetryContribute;
  }

  async status(): Promise<{ telemetryContribute: boolean; endpoint?: string; contributions: number; lastContributionAt: string | null }> {
    const state = await this.readState();
    return {
      telemetryContribute: state.telemetryContribute,
      endpoint: state.endpoint,
      contributions: state.contributions.length,
      lastContributionAt: state.contributions[0]?.at ?? null
    };
  }

  async optOut(): Promise<void> {
    const state = await this.readState();
    state.telemetryContribute = false;
    this.telemetryContribute = false;
    await this.writeState(state);
  }

  async query(args: { errorSignature: string; limit?: number }): Promise<{ ok: boolean; patterns: BrainPattern[]; source: "remote" | "local-fallback" }> {
    const limit = Math.max(1, Math.min(args.limit ?? 5, 20));
    if (this.endpoint) {
      try {
        const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/brain/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ errorSignature: args.errorSignature, limit })
        });
        if (response.ok) {
          const payload = await response.json() as { patterns?: BrainPattern[] };
          return { ok: true, patterns: (payload.patterns ?? []).slice(0, limit), source: "remote" };
        }
      } catch {
        // fall through to local fallback
      }
    }

    const state = await this.readState();
    const local = state.contributions
      .map((entry, index) => ({
        id: `local-${index + 1}`,
        score: similarity(entry.errorSignature, args.errorSignature),
        errorSignature: entry.errorSignature,
        diffPattern: entry.diffPattern,
        fixSummary: "Historical local timeline promotion",
        successRate: entry.verificationResult.verdict === "pass" ? 1 : 0,
        usageCount: 1,
        verification: entry.verificationResult
      }))
      .filter((pattern) => pattern.score > 0.15)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    return { ok: true, patterns: local, source: "local-fallback" };
  }

  async contribute(payload: BrainContribution): Promise<{ ok: boolean; contributed: boolean; reason?: string }> {
    const state = await this.readState();
    if (!state.telemetryContribute || !this.telemetryContribute) {
      return { ok: true, contributed: false, reason: "telemetry_opted_out" };
    }

    const item = { ...payload, at: new Date().toISOString() };
    state.contributions.unshift(item);
    state.contributions = state.contributions.slice(0, 250);
    await this.writeState(state);

    if (!this.endpoint) {
      return { ok: true, contributed: true, reason: "saved_locally_no_endpoint" };
    }

    try {
      const response = await fetch(`${this.endpoint.replace(/\/$/, "")}/brain/contribute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item)
      });
      if (!response.ok) {
        return { ok: false, contributed: true, reason: `remote_error_${response.status}` };
      }
      return { ok: true, contributed: true };
    } catch {
      return { ok: false, contributed: true, reason: "remote_unreachable" };
    }
  }

  private async readState(): Promise<{
    telemetryContribute: boolean;
    endpoint?: string;
    contributions: Array<BrainContribution & { at: string }>;
  }> {
    try {
      const raw = await fs.readFile(this.telemetryPath, "utf8");
      const parsed = JSON.parse(raw) as {
        telemetryContribute?: boolean;
        endpoint?: string;
        contributions?: Array<BrainContribution & { at: string }>;
      };
      return {
        telemetryContribute: parsed.telemetryContribute ?? this.telemetryContribute,
        endpoint: parsed.endpoint || this.endpoint,
        contributions: Array.isArray(parsed.contributions) ? parsed.contributions : []
      };
    } catch {
      return {
        telemetryContribute: this.telemetryContribute,
        endpoint: this.endpoint,
        contributions: []
      };
    }
  }

  private async writeState(state: {
    telemetryContribute: boolean;
    endpoint?: string;
    contributions: Array<BrainContribution & { at: string }>;
  }): Promise<void> {
    await fs.mkdir(path.dirname(this.telemetryPath), { recursive: true });
    await fs.writeFile(this.telemetryPath, JSON.stringify(state, null, 2), "utf8");
  }
}

function similarity(left: string, right: string): number {
  const a = new Set(left.split(/\s+/g).filter(Boolean));
  const b = new Set(right.split(/\s+/g).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const token of a) {
    if (b.has(token)) intersect += 1;
  }
  return intersect / Math.sqrt(a.size * b.size);
}
