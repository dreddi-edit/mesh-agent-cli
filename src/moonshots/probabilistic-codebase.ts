import { promises as fs } from "node:fs";
import path from "node:path";
import { collectWorkspaceFiles, readJson, writeJson } from "./common.js";

interface ExperimentCandidate {
  id: string;
  file: string;
  kind: "route" | "hotspot" | "pure-function";
  rationale: string;
  routing: { control: number; candidate: number };
  guardrails: string[];
}

export class ProbabilisticCodebaseEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "plan").trim().toLowerCase();
    if (action === "status") {
      return readJson(path.join(this.workspaceRoot, ".mesh", "probabilistic", "experiments.json"), {
        ok: true,
        action: "status",
        experiments: []
      });
    }
    if (action !== "plan") throw new Error("workspace.probabilistic_codebase action must be plan|status");

    const intent = String(args.intent ?? "").trim();
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 800 });
    const candidates: ExperimentCandidate[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw) continue;
      const candidate = classifyCandidate(file, raw, intent);
      if (candidate) candidates.push(candidate);
    }
    candidates.sort((left, right) => priority(right) - priority(left));
    const manifest = {
      ok: true,
      action,
      intent: intent || "continuous optimization",
      generatedAt: new Date().toISOString(),
      experiments: candidates.slice(0, 20),
      rolloutPolicy: {
        defaultControlWeight: 0.95,
        defaultCandidateWeight: 0.05,
        promoteAfter: "1000 successful requests or explicit verification ledger",
        rollbackOn: ["error_rate_regression", "p99_regression", "revenue_signal_regression"]
      },
      manifestPath: ".mesh/probabilistic/experiments.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "probabilistic", "experiments.json"), manifest);
    return manifest;
  }
}

function classifyCandidate(file: string, raw: string, intent: string): ExperimentCandidate | null {
  if (/\b(?:app|router)\.(get|post|put|patch|delete)\(/.test(raw)) {
    return {
      id: slug(`${file}:route`),
      file,
      kind: "route",
      rationale: "Externally reachable route can be shadowed and gradually routed by telemetry.",
      routing: { control: 0.95, candidate: 0.05 },
      guardrails: ["same response schema", "p99 latency non-regression", "error rate non-regression"]
    };
  }
  if (/\b(auth|cache|runtime|timeline|llm|database|query)\b/i.test(`${file}\n${raw}`)) {
    return {
      id: slug(`${file}:hotspot`),
      file,
      kind: "hotspot",
      rationale: intent || "High-leverage subsystem should support verified alternatives before risky rewrites.",
      routing: { control: 0.98, candidate: 0.02 },
      guardrails: ["tests pass in timeline", "no command safety violations", "manual review before promotion"]
    };
  }
  if (/export\s+function\s+[A-Za-z_$][\w$]*\(/.test(raw) && !/\b(fs|process|fetch|spawn|exec)\b/.test(raw)) {
    return {
      id: slug(`${file}:pure`),
      file,
      kind: "pure-function",
      rationale: "Pure exported function can be equivalence-tested against candidate implementations.",
      routing: { control: 0.9, candidate: 0.1 },
      guardrails: ["property equivalence", "determinism", "same thrown-error behavior"]
    };
  }
  return null;
}

function priority(candidate: ExperimentCandidate): number {
  if (candidate.kind === "route") return 3;
  if (candidate.kind === "hotspot") return 2;
  return 1;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}
