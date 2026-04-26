import { promises as fs } from "node:fs";
import path from "node:path";
import { collectWorkspaceFiles, lineNumberAt, readJson, writeJson } from "./common.js";

interface BehaviorContract {
  id: string;
  file: string;
  line: number;
  kind: "route" | "exported-function" | "test";
  subject: string;
  behavior: string;
  evidence: string;
}

export class SpecCodeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "synthesize").trim().toLowerCase();
    if (action === "status") return this.status();
    if (!["synthesize", "check"].includes(action)) {
      throw new Error("workspace.spec_code action must be synthesize|check|status");
    }

    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 1200 });
    const contracts: BehaviorContract[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw) continue;
      contracts.push(...extractContracts(file, raw));
    }

    const existing = await readJson<{ contracts?: BehaviorContract[] }>(this.ledgerPath(), { contracts: [] });
    const drift = action === "check" ? detectSpecDrift(existing.contracts ?? [], contracts) : [];
    const result = {
      ok: true,
      action,
      generatedAt: new Date().toISOString(),
      contracts,
      drift,
      summary: {
        routes: contracts.filter((item) => item.kind === "route").length,
        exportedFunctions: contracts.filter((item) => item.kind === "exported-function").length,
        tests: contracts.filter((item) => item.kind === "test").length,
        driftItems: drift.length
      },
      ledgerPath: ".mesh/spec-code/contracts.json"
    };
    await writeJson(this.ledgerPath(), result);
    return result;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(this.ledgerPath(), {
      ok: true,
      action: "status",
      contracts: [],
      message: "No spec-code ledger exists yet. Run action=synthesize."
    });
  }

  private ledgerPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "spec-code", "contracts.json");
  }
}

function extractContracts(file: string, raw: string): BehaviorContract[] {
  const contracts: BehaviorContract[] = [];
  const routeRe = /\b(?:app|router|server)\.(get|post|put|patch|delete|all)\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of raw.matchAll(routeRe)) {
    contracts.push({
      id: slug(`${file}:route:${match[1]}:${match[3]}`),
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "route",
      subject: `${match[1].toUpperCase()} ${match[3]}`,
      behavior: `Expose ${match[1].toUpperCase()} ${match[3]} and preserve its response contract.`,
      evidence: match[0]
    });
  }

  const exportRe = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const match of raw.matchAll(exportRe)) {
    contracts.push({
      id: slug(`${file}:function:${match[1]}`),
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "exported-function",
      subject: match[1],
      behavior: `Function ${match[1]} accepts (${match[2].trim()}) and must remain deterministic for equivalent inputs unless documented otherwise.`,
      evidence: match[0]
    });
  }

  const testRe = /\b(?:test|it)\(\s*(["'`])([^"'`]+)\1/g;
  for (const match of raw.matchAll(testRe)) {
    contracts.push({
      id: slug(`${file}:test:${match[2]}`),
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "test",
      subject: match[2],
      behavior: `Preserve tested behavior: ${match[2]}.`,
      evidence: match[0]
    });
  }
  return contracts;
}

function detectSpecDrift(previous: BehaviorContract[], current: BehaviorContract[]): Array<Record<string, unknown>> {
  const currentIds = new Set(current.map((item) => item.id));
  const previousIds = new Set(previous.map((item) => item.id));
  const drift: Array<Record<string, unknown>> = [];
  for (const oldContract of previous) {
    if (!currentIds.has(oldContract.id)) {
      drift.push({ kind: "removed-behavior", contract: oldContract });
    }
  }
  for (const newContract of current) {
    if (!previousIds.has(newContract.id)) {
      drift.push({ kind: "new-behavior", contract: newContract });
    }
  }
  return drift;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}
