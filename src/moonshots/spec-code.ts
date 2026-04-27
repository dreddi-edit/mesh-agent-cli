import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendJsonl, collectWorkspaceFiles, lineNumberAt, readJson, writeJson } from "./common.js";

type ContractKind = "route" | "exported-function" | "test" | "declared-spec";
type ContractSource = "code" | "test" | "human-spec";
type DriftSeverity = "critical" | "high" | "medium" | "low";

interface BehaviorContract {
  id: string;
  version: number;
  file: string;
  line: number;
  kind: ContractKind;
  source: ContractSource;
  subject: string;
  behavior: string;
  evidence: string;
  fingerprint: string;
  locked: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  invariants: string[];
  tests: string[];
  implementationStatus: "implemented" | "missing" | "drifted";
}

interface SpecLedger {
  schemaVersion: 2;
  generatedAt: string;
  contracts: BehaviorContract[];
  declaredSpecs: BehaviorContract[];
  lastDrift: SpecDrift[];
}

interface SpecDrift {
  id: string;
  severity: DriftSeverity;
  kind: "removed-behavior" | "new-behavior" | "behavior-changed" | "missing-implementation" | "test-coverage-missing";
  contract: BehaviorContract;
  previous?: BehaviorContract;
  current?: BehaviorContract;
  reason: string;
  gate: "pass" | "warn" | "block";
}

export class SpecCodeEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "synthesize").trim().toLowerCase();
    switch (action) {
      case "synthesize": return this.synthesize("synthesize");
      case "check": return this.synthesize("check");
      case "assert": return this.assertSpec(args);
      case "lock": return this.setLock(args, true);
      case "unlock": return this.setLock(args, false);
      case "materialize": return this.materialize(args);
      case "status": return this.status();
      default:
        throw new Error("workspace.spec_code action must be synthesize|check|assert|lock|unlock|materialize|status");
    }
  }

  private async synthesize(action: "synthesize" | "check"): Promise<Record<string, unknown>> {
    const previous = await this.readLedger();
    const now = new Date().toISOString();
    const codeContracts = await this.extractWorkspaceContracts(now);
    const merged = mergeContracts(previous.contracts, codeContracts, now);
    const declaredSpecs = previous.declaredSpecs.map((spec) => reconcileDeclaredSpec(spec, merged, now));
    const drift = action === "check" ? detectSpecDrift(previous.contracts, merged, declaredSpecs) : [];
    const ledger: SpecLedger = {
      schemaVersion: 2,
      generatedAt: now,
      contracts: merged,
      declaredSpecs,
      lastDrift: drift
    };
    await this.writeLedger(ledger);
    await this.writeSpecMarkdown(ledger);

    return {
      ok: true,
      action,
      generatedAt: now,
      contracts: merged,
      declaredSpecs,
      drift,
      gate: drift.some((item) => item.gate === "block") ? "block" : drift.some((item) => item.gate === "warn") ? "warn" : "pass",
      summary: summarize(merged, declaredSpecs, drift),
      ledgerPath: ".mesh/spec-code/contracts.json",
      specPath: ".mesh/spec-code/SPEC.md",
      eventLogPath: ".mesh/spec-code/events.jsonl"
    };
  }

  private async assertSpec(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const subject = String(args.subject ?? "").trim();
    const behavior = String(args.behavior ?? "").trim();
    if (!subject || !behavior) {
      throw new Error("workspace.spec_code assert requires subject and behavior");
    }

    const file = normalizePath(String(args.file ?? inferFileFromSubject(subject)));
    const now = new Date().toISOString();
    const ledger = await this.readLedger();
    const existing = ledger.declaredSpecs.find((item) => item.subject === subject && item.file === file);
    const spec = buildContract({
      file,
      line: 1,
      kind: "declared-spec",
      source: "human-spec",
      subject,
      behavior,
      evidence: behavior,
      now,
      locked: true,
      tests: [],
      implementationStatus: "missing"
    });
    if (existing) {
      spec.version = existing.version + (existing.fingerprint === spec.fingerprint ? 0 : 1);
      spec.firstSeenAt = existing.firstSeenAt;
      spec.locked = existing.locked;
    }

    ledger.declaredSpecs = [
      ...ledger.declaredSpecs.filter((item) => !(item.subject === subject && item.file === file)),
      reconcileDeclaredSpec(spec, ledger.contracts, now)
    ].sort((left, right) => left.subject.localeCompare(right.subject));
    ledger.generatedAt = now;
    await this.writeLedger(ledger);
    await this.appendEvent("assert", { subject, file, behavior });

    return {
      ok: true,
      action: "assert",
      contract: ledger.declaredSpecs.find((item) => item.subject === subject && item.file === file),
      ledgerPath: ".mesh/spec-code/contracts.json"
    };
  }

  private async setLock(args: Record<string, unknown>, locked: boolean): Promise<Record<string, unknown>> {
    const id = String(args.id ?? "").trim();
    const subject = String(args.subject ?? "").trim();
    if (!id && !subject) throw new Error(`workspace.spec_code ${locked ? "lock" : "unlock"} requires id or subject`);

    const ledger = await this.readLedger();
    let changed = 0;
    const update = (contract: BehaviorContract): BehaviorContract => {
      if ((id && contract.id === id) || (subject && contract.subject === subject)) {
        changed += 1;
        return { ...contract, locked };
      }
      return contract;
    };
    ledger.contracts = ledger.contracts.map(update);
    ledger.declaredSpecs = ledger.declaredSpecs.map(update);
    ledger.generatedAt = new Date().toISOString();
    await this.writeLedger(ledger);
    await this.appendEvent(locked ? "lock" : "unlock", { id, subject, changed });
    return { ok: true, action: locked ? "lock" : "unlock", changed, ledgerPath: ".mesh/spec-code/contracts.json" };
  }

  private async materialize(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ledger = await this.readLedger();
    const subject = String(args.subject ?? "").trim();
    const specs = ledger.declaredSpecs.filter((spec) => {
      if (subject) return spec.subject === subject || spec.id === subject;
      return spec.implementationStatus !== "implemented";
    });
    const patches = specs.map((spec) => buildMaterializationPatch(spec)).filter(Boolean) as Array<Record<string, unknown>>;
    const result = {
      ok: true,
      action: "materialize",
      patches,
      applyMode: "manual",
      note: "Materialization emits reviewable patch plans. Apply through a timeline and run workspace.spec_code check before promotion.",
      ledgerPath: ".mesh/spec-code/contracts.json"
    };
    await writeJson(path.join(this.workspaceRoot, ".mesh", "spec-code", "materialization-plan.json"), result);
    await this.appendEvent("materialize", { subject, patchCount: patches.length });
    return result;
  }

  private async status(): Promise<Record<string, unknown>> {
    const ledger = await this.readLedger();
    return {
      ok: true,
      action: "status",
      generatedAt: ledger.generatedAt,
      contracts: ledger.contracts,
      declaredSpecs: ledger.declaredSpecs,
      drift: ledger.lastDrift,
      summary: summarize(ledger.contracts, ledger.declaredSpecs, ledger.lastDrift),
      ledgerPath: ".mesh/spec-code/contracts.json"
    };
  }

  private async extractWorkspaceContracts(now: string): Promise<BehaviorContract[]> {
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 2000 });
    const testSubjects = new Map<string, string[]>();
    const contracts: BehaviorContract[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      if (!raw) continue;
      const extracted = extractContracts(file, raw, now);
      for (const contract of extracted) {
        if (contract.kind === "test") {
          for (const token of tokenizeSubject(contract.subject)) {
            const list = testSubjects.get(token) ?? [];
            list.push(contract.subject);
            testSubjects.set(token, list);
          }
        }
        contracts.push(contract);
      }
    }
    return contracts.map((contract) => ({
      ...contract,
      tests: contract.kind === "test" ? contract.tests : testSubjects.get(contract.subject) ?? [],
      implementationStatus: "implemented"
    }));
  }

  private async readLedger(): Promise<SpecLedger> {
    const raw = await readJson<Partial<SpecLedger>>(this.ledgerPath(), {});
    return {
      schemaVersion: 2,
      generatedAt: raw.generatedAt ?? new Date(0).toISOString(),
      contracts: Array.isArray(raw.contracts) ? raw.contracts as BehaviorContract[] : [],
      declaredSpecs: Array.isArray(raw.declaredSpecs) ? raw.declaredSpecs as BehaviorContract[] : [],
      lastDrift: Array.isArray(raw.lastDrift) ? raw.lastDrift as SpecDrift[] : []
    };
  }

  private async writeLedger(ledger: SpecLedger): Promise<void> {
    await writeJson(this.ledgerPath(), ledger);
  }

  private async writeSpecMarkdown(ledger: SpecLedger): Promise<void> {
    const lines = [
      "# Mesh Generated Behavior Spec",
      "",
      `Generated: ${ledger.generatedAt}`,
      "",
      "## Declared Specs",
      ...ledger.declaredSpecs.map((contract) => `- [${contract.implementationStatus}] ${contract.subject} (${contract.file}) - ${contract.behavior}`),
      "",
      "## Code-Derived Contracts",
      ...ledger.contracts.map((contract) => `- ${contract.kind}: ${contract.subject} (${contract.file}:${contract.line}) - ${contract.behavior}`),
      ""
    ];
    await fs.mkdir(path.dirname(this.specPath()), { recursive: true });
    await fs.writeFile(this.specPath(), lines.join("\n"), "utf8");
  }

  private async appendEvent(kind: string, data: Record<string, unknown>): Promise<void> {
    await appendJsonl(path.join(this.workspaceRoot, ".mesh", "spec-code", "events.jsonl"), {
      at: new Date().toISOString(),
      kind,
      data
    });
  }

  private ledgerPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "spec-code", "contracts.json");
  }

  private specPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "spec-code", "SPEC.md");
  }
}

function extractContracts(file: string, raw: string, now: string): BehaviorContract[] {
  const contracts: BehaviorContract[] = [];
  const routeRe = /\b(?:app|router|server)\.(get|post|put|patch|delete|all)\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of raw.matchAll(routeRe)) {
    const method = match[1].toUpperCase();
    const routePath = match[3];
    contracts.push(buildContract({
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "route",
      source: "code",
      subject: `${method} ${routePath}`,
      behavior: `Expose ${method} ${routePath} and preserve its response contract.`,
      evidence: match[0],
      now,
      locked: false,
      tests: [],
      implementationStatus: "implemented"
    }));
  }

  const exportRe = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)(?:\s*:\s*([^{\n]+))?/g;
  for (const match of raw.matchAll(exportRe)) {
    const subject = match[1];
    contracts.push(buildContract({
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "exported-function",
      source: "code",
      subject,
      behavior: `Function ${subject} accepts (${match[2].trim()})${match[3] ? ` and returns ${match[3].trim()}` : ""}; behavior must remain equivalent for documented inputs.`,
      evidence: match[0],
      now,
      locked: false,
      tests: [],
      implementationStatus: "implemented"
    }));
  }

  const testRe = /\b(?:test|it)\(\s*(["'`])([^"'`]+)\1/g;
  for (const match of raw.matchAll(testRe)) {
    contracts.push(buildContract({
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "test",
      source: "test",
      subject: match[2],
      behavior: `Preserve tested behavior: ${match[2]}.`,
      evidence: match[0],
      now,
      locked: false,
      tests: [match[2]],
      implementationStatus: "implemented"
    }));
  }
  return contracts;
}

function buildContract(args: {
  file: string;
  line: number;
  kind: ContractKind;
  source: ContractSource;
  subject: string;
  behavior: string;
  evidence: string;
  now: string;
  locked: boolean;
  tests: string[];
  implementationStatus: "implemented" | "missing" | "drifted";
}): BehaviorContract {
  const invariants = inferInvariants(args.behavior, args.evidence);
  const fingerprint = fingerprintContract({
    kind: args.kind,
    subject: args.subject,
    behavior: args.behavior,
    invariants
  });
  return {
    id: slug(`${args.file}:${args.kind}:${args.subject}`),
    version: 1,
    file: args.file,
    line: args.line,
    kind: args.kind,
    source: args.source,
    subject: args.subject,
    behavior: args.behavior,
    evidence: args.evidence,
    fingerprint,
    locked: args.locked,
    firstSeenAt: args.now,
    lastSeenAt: args.now,
    invariants,
    tests: args.tests,
    implementationStatus: args.implementationStatus
  };
}

function mergeContracts(previous: BehaviorContract[], current: BehaviorContract[], now: string): BehaviorContract[] {
  const previousById = new Map(previous.map((contract) => [contract.id, contract]));
  return current.map((contract) => {
    const old = previousById.get(contract.id);
    if (!old) return contract;
    return {
      ...contract,
      version: old.fingerprint === contract.fingerprint ? old.version : old.version + 1,
      locked: old.locked,
      firstSeenAt: old.firstSeenAt,
      lastSeenAt: now
    };
  }).sort((left, right) => left.file.localeCompare(right.file) || left.subject.localeCompare(right.subject));
}

function reconcileDeclaredSpec(spec: BehaviorContract, implemented: BehaviorContract[], now: string): BehaviorContract {
  const match = implemented.find((contract) => contract.subject === spec.subject || contract.id === spec.id);
  if (!match) return { ...spec, lastSeenAt: now, implementationStatus: "missing" };
  const drifted = spec.invariants.some((invariant) => !match.invariants.includes(invariant)) && spec.invariants.length > 0;
  return {
    ...spec,
    file: spec.file || match.file,
    line: spec.line || match.line,
    lastSeenAt: now,
    tests: match.tests,
    implementationStatus: drifted ? "drifted" : "implemented"
  };
}

function detectSpecDrift(previous: BehaviorContract[], current: BehaviorContract[], declaredSpecs: BehaviorContract[]): SpecDrift[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const drift: SpecDrift[] = [];

  for (const oldContract of previous) {
    const next = currentById.get(oldContract.id);
    if (!next) {
      drift.push({
        id: oldContract.id,
        severity: oldContract.locked ? "critical" : "medium",
        kind: "removed-behavior",
        contract: oldContract,
        previous: oldContract,
        reason: `${oldContract.subject} existed in the previous contract ledger and is now absent.`,
        gate: oldContract.locked ? "block" : "warn"
      });
    } else if (oldContract.fingerprint !== next.fingerprint) {
      drift.push({
        id: next.id,
        severity: oldContract.locked ? "critical" : "high",
        kind: "behavior-changed",
        contract: next,
        previous: oldContract,
        current: next,
        reason: `${next.subject} changed semantic fingerprint from ${oldContract.fingerprint} to ${next.fingerprint}.`,
        gate: oldContract.locked ? "block" : "warn"
      });
    }
  }

  for (const contract of current) {
    if (!previousById.has(contract.id)) {
      drift.push({
        id: contract.id,
        severity: "low",
        kind: "new-behavior",
        contract,
        current: contract,
        reason: `${contract.subject} is new behavior and should be accepted into spec if intentional.`,
        gate: "warn"
      });
    }
    if (contract.kind !== "test" && contract.tests.length === 0) {
      drift.push({
        id: `${contract.id}:coverage`,
        severity: contract.locked ? "high" : "medium",
        kind: "test-coverage-missing",
        contract,
        current: contract,
        reason: `${contract.subject} has no obvious adjacent test contract.`,
        gate: contract.locked ? "block" : "warn"
      });
    }
  }

  for (const spec of declaredSpecs) {
    if (spec.implementationStatus !== "implemented") {
      drift.push({
        id: `${spec.id}:implementation`,
        severity: spec.locked ? "critical" : "high",
        kind: "missing-implementation",
        contract: spec,
        reason: `${spec.subject} is declared in spec but not implemented by code-derived contracts.`,
        gate: spec.locked ? "block" : "warn"
      });
    }
  }
  return drift.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function buildMaterializationPatch(spec: BehaviorContract): Record<string, unknown> | null {
  if (spec.implementationStatus === "implemented") return null;
  const subject = spec.subject.replace(/[^A-Za-z0-9_$]/g, "");
  if (!subject) return null;
  const target = spec.file || `src/${subject}.ts`;
  const implementation = [
    `export function ${subject}(...args: unknown[]): unknown {`,
    `  throw new Error(${JSON.stringify(`Spec '${spec.subject}' is declared but not implemented yet.`)});`,
    "}",
    ""
  ].join("\n");
  return {
    contractId: spec.id,
    file: target,
    subject: spec.subject,
    behavior: spec.behavior,
    patch: [
      `diff --git a/${target} b/${target}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${target}`,
      "@@ -0,0 +1,4 @@",
      ...implementation.split("\n").filter(Boolean).map((line) => `+${line}`),
      ""
    ].join("\n"),
    verification: "Apply in a timeline, implement behavior, then run workspace.spec_code check and project tests."
  };
}

function inferInvariants(behavior: string, evidence: string): string[] {
  const text = `${behavior}\n${evidence}`.toLowerCase();
  const invariants: string[] = [];
  if (/auth|session|token|jwt/.test(text)) invariants.push("auth-boundary");
  if (/throw|error|reject|invalid/.test(text)) invariants.push("error-contract");
  if (/route|http|get|post|put|patch|delete/.test(text)) invariants.push("http-contract");
  if (/deterministic|same input|equivalent/.test(text)) invariants.push("determinism");
  if (/database|sql|query|persist/.test(text)) invariants.push("persistence-contract");
  return Array.from(new Set(invariants));
}

function tokenizeSubject(subject: string): string[] {
  return subject.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
}

function fingerprintContract(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function summarize(contracts: BehaviorContract[], declaredSpecs: BehaviorContract[], drift: SpecDrift[]): Record<string, unknown> {
  return {
    routes: contracts.filter((item) => item.kind === "route").length,
    exportedFunctions: contracts.filter((item) => item.kind === "exported-function").length,
    tests: contracts.filter((item) => item.kind === "test").length,
    declaredSpecs: declaredSpecs.length,
    missingImplementations: declaredSpecs.filter((item) => item.implementationStatus !== "implemented").length,
    locked: [...contracts, ...declaredSpecs].filter((item) => item.locked).length,
    driftItems: drift.length,
    blockingDrift: drift.filter((item) => item.gate === "block").length
  };
}

function inferFileFromSubject(subject: string): string {
  const safe = subject.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `src/${safe || "declared-spec"}.ts`;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140);
}

function severityRank(severity: DriftSeverity): number {
  return severity === "critical" ? 4 : severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}
