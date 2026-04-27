import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { collectWorkspaceFiles, readJson, writeJson } from "./common.js";

const execAsync = promisify(exec);

export interface SemanticSignature {
  exports: string[];
  purpose: string;
  behavioralPatterns: string[];
  invariantKeywords: string[];
  importedConcepts: string[];
  lineCount: number;
}

export interface SemanticContract {
  file: string;
  fingerprint: string;
  lockedAt: string;
  locked: boolean;
  semanticSignature: SemanticSignature;
}

export interface DriftAlert {
  file: string;
  severity: "critical" | "high" | "medium";
  oldFingerprint: string;
  newFingerprint: string;
  changes: {
    addedExports: string[];
    removedExports: string[];
    purposeShift: boolean;
    behavioralShift: boolean;
    invariantShift: string[];
  };
}

export interface SheriffReport {
  ok: boolean;
  action: string;
  generatedAt: string;
  contracts: number;
  lockedContracts: number;
  driftAlerts: DriftAlert[];
  summary: string;
  path: string;
}

export class SemanticSheriffEngine {
  private readonly indexPath: string;
  private readonly driftPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.indexPath = path.join(workspaceRoot, ".mesh", "semantic-contracts", "index.json");
    this.driftPath = path.join(workspaceRoot, ".mesh", "semantic-contracts", "drift.json");
  }

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "verify").trim().toLowerCase();
    switch (action) {
      case "scan":   return this.scan(args);
      case "verify": return this.verify(args) as unknown as Promise<Record<string, unknown>>;
      case "lock":   return this.lock(args);
      case "unlock": return this.unlock(args);
      case "drift":  return this.getDrift();
      case "status": return this.status();
      case "clear":  return this.clear();
      default:
        throw new Error("workspace.semantic_sheriff action must be scan|verify|lock|unlock|drift|status|clear");
    }
  }

  private async scan(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const maxFiles = Math.min(Number(args.maxFiles ?? 400), 2000);
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles });
    const existing = await readJson<Record<string, SemanticContract>>(this.indexPath, {});

    let scanned = 0;
    let updated = 0;

    for (const file of files) {
      const absolutePath = path.join(this.workspaceRoot, file);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
      if (!raw.trim()) continue;

      const sig = extractSignature(file, raw);
      const fp = computeFingerprint(sig);
      const prev = existing[file];

      if (!prev || prev.fingerprint !== fp) {
        existing[file] = {
          file,
          fingerprint: fp,
          lockedAt: prev?.locked ? prev.lockedAt : new Date().toISOString(),
          locked: prev?.locked ?? false,
          semanticSignature: sig
        };
        updated++;
      }
      scanned++;
    }

    await writeJson(this.indexPath, existing);

    return {
      ok: true,
      action: "scan",
      generatedAt: new Date().toISOString(),
      scanned,
      updated,
      totalContracts: Object.keys(existing).length,
      path: ".mesh/semantic-contracts/index.json",
      message: `Scanned ${scanned} files, updated ${updated} contracts.`
    };
  }

  private async verify(args: Record<string, unknown>): Promise<SheriffReport> {
    const contracts = await readJson<Record<string, SemanticContract>>(this.indexPath, {});
    if (Object.keys(contracts).length === 0) {
      return emptySheriffReport("verify", "No contracts found. Run action=scan first.");
    }

    const force = Boolean(args.force);
    const targetFile = String(args.file ?? "").trim();

    let filesToCheck: string[];
    if (targetFile) {
      filesToCheck = [targetFile].filter(f => contracts[f]);
    } else if (force) {
      filesToCheck = Object.keys(contracts);
    } else {
      const changed = await this.changedFiles();
      filesToCheck = changed.length > 0
        ? changed.filter(f => contracts[f])
        : Object.keys(contracts).slice(0, 150);
    }

    const driftAlerts: DriftAlert[] = [];

    for (const file of filesToCheck) {
      const stored = contracts[file];
      if (!stored) continue;

      const absolutePath = path.join(this.workspaceRoot, file);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
      if (raw === null) continue;

      const currentSig = extractSignature(file, raw);
      const currentFp = computeFingerprint(currentSig);

      if (currentFp === stored.fingerprint) continue;

      const alert = buildAlert(file, stored, currentSig, currentFp);
      driftAlerts.push(alert);

      // Auto-update unlocked contracts so future verifications track from here
      if (!stored.locked) {
        contracts[file] = {
          ...stored,
          fingerprint: currentFp,
          semanticSignature: currentSig
        };
      }
    }

    await writeJson(this.indexPath, contracts);

    const criticalCount = driftAlerts.filter(a => a.severity === "critical").length;
    const highCount = driftAlerts.filter(a => a.severity === "high").length;

    const report: SheriffReport = {
      ok: true,
      action: "verify",
      generatedAt: new Date().toISOString(),
      contracts: Object.keys(contracts).length,
      lockedContracts: Object.values(contracts).filter(c => c.locked).length,
      driftAlerts,
      summary: driftAlerts.length === 0
        ? `No semantic drift detected across ${filesToCheck.length} checked file(s).`
        : `SEMANTIC DRIFT: ${driftAlerts.length} file(s) drifted (${criticalCount} critical, ${highCount} high).`,
      path: ".mesh/semantic-contracts/drift.json"
    };

    if (driftAlerts.length > 0) {
      await writeJson(this.driftPath, report);
    }

    return report;
  }

  private async lock(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = String(args.file ?? "").trim();
    if (!file) throw new Error("lock requires file");

    const contracts = await readJson<Record<string, SemanticContract>>(this.indexPath, {});
    if (!contracts[file]) {
      return { ok: false, reason: `No contract for ${file}. Run action=scan first.` };
    }

    contracts[file] = { ...contracts[file], locked: true, lockedAt: new Date().toISOString() };
    await writeJson(this.indexPath, contracts);

    return {
      ok: true,
      action: "lock",
      file,
      fingerprint: contracts[file].fingerprint,
      lockedAt: contracts[file].lockedAt,
      message: `${file} is now locked. Any semantic drift will be flagged as critical.`
    };
  }

  private async unlock(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = String(args.file ?? "").trim();
    if (!file) throw new Error("unlock requires file");

    const contracts = await readJson<Record<string, SemanticContract>>(this.indexPath, {});
    if (!contracts[file]) {
      return { ok: false, reason: `No contract for ${file}.` };
    }

    contracts[file] = { ...contracts[file], locked: false };
    await writeJson(this.indexPath, contracts);
    return { ok: true, action: "unlock", file };
  }

  private async getDrift(): Promise<Record<string, unknown>> {
    return readJson(this.driftPath, {
      ok: true,
      action: "drift",
      message: "No drift report found. Run action=verify to check for semantic drift."
    });
  }

  private async status(): Promise<Record<string, unknown>> {
    const contracts = await readJson<Record<string, SemanticContract>>(this.indexPath, {});
    const total = Object.keys(contracts).length;
    const locked = Object.values(contracts).filter(c => c.locked).length;
    return {
      ok: true,
      action: "status",
      totalContracts: total,
      lockedContracts: locked,
      hasContracts: total > 0,
      path: ".mesh/semantic-contracts/index.json",
      message: total > 0
        ? `${total} contracts tracked (${locked} locked). Run action=verify to check for drift.`
        : "No contracts yet. Run action=scan to fingerprint your codebase."
    };
  }

  private async clear(): Promise<Record<string, unknown>> {
    await fs.unlink(this.indexPath).catch(() => {});
    await fs.unlink(this.driftPath).catch(() => {});
    return { ok: true, action: "clear", message: "All semantic contracts cleared." };
  }

  private async changedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execAsync("git diff HEAD --name-only", { cwd: this.workspaceRoot });
      return stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

// ─── Signature Extraction ────────────────────────────────────────────────────

function extractSignature(file: string, raw: string): SemanticSignature {
  // Named exports (functions, classes, consts, types, interfaces, enums)
  const exportedNames = new Set<string>();
  for (const m of raw.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)([A-Za-z_$][\w$]*)/g)) {
    exportedNames.add(m[1]);
  }
  // Re-exports: export { Foo, Bar as Baz }
  for (const m of raw.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name);
    }
  }
  // Default export expression
  if (/\bexport\s+default\b/.test(raw)) exportedNames.add("default");

  const exports = Array.from(exportedNames).sort();

  // Purpose: first JSDoc block → file basename fallback
  const jsdoc = raw.match(/^\/\*\*([\s\S]*?)\*\//m);
  const jsdocText = jsdoc
    ? jsdoc[1].replace(/\s*\*\s?/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
    : "";
  const basename = path.basename(file, path.extname(file));
  const purpose = jsdocText || inferPurpose(basename);

  // Behavioral patterns (structural fingerprints)
  const behavioralPatterns: string[] = [];
  if (/\basync\b.*\bfunction\b|\bawait\b|\bPromise[.<]/.test(raw)) behavioralPatterns.push("async");
  if (/(?:app|router)\.(get|post|put|delete|patch|use)\s*\(|@(?:Get|Post|Put|Delete|Patch)\b|Route\b|Controller\b/.test(raw)) behavioralPatterns.push("http-handler");
  if (/\bEventEmitter\b|\.on\s*\(|\.emit\s*\(|\.addEventListener\b/.test(raw)) behavioralPatterns.push("event-driven");
  if (/static\s+(?:readonly\s+)?instance\b|private\s+static\b.*\binstance\b|getInstance\s*\(\)/.test(raw)) behavioralPatterns.push("singleton");
  if (/\bReadable\b|\bWritable\b|\bTransform\b|\bStream\b|\.pipe\s*\(/.test(raw)) behavioralPatterns.push("streaming");
  if (/\bprocess\.env\b|dotenv|loadConfig\b|AppConfig\b|getConfig\b/.test(raw)) behavioralPatterns.push("configuration");
  if (/\bprisma\b|\bknex\b|\bsequelize\b|\bmongoose\b|\.query\s*\(|SELECT\s+\w|INSERT\s+INTO/.test(raw)) behavioralPatterns.push("database");
  if (/\bfs\b.*\breadFile\b|\breadFileSync\b|\bwriteFile\b|\bmkdir\b/.test(raw)) behavioralPatterns.push("filesystem");
  if (/\bworker_threads\b|\bnew Worker\b|\bWorkerThread\b/.test(raw)) behavioralPatterns.push("worker");
  if (/\bsetInterval\b|\bsetTimeout\b|\bDebounce\b|\bThrottle\b|\bcron\b/i.test(raw)) behavioralPatterns.push("scheduled");

  // Invariant keywords: semantic nouns from identifiers (split camelCase)
  const kwSet = new Set<string>();
  for (const m of raw.matchAll(/(?:function|class|const|let|var|interface|type)\s+([A-Z][a-zA-Z]{3,})/g)) {
    for (const token of splitCamel(m[1])) kwSet.add(token);
  }

  // Imported concepts: external packages + local module names
  const conceptSet = new Set<string>();
  for (const m of raw.matchAll(/from\s+["']([^"']+)["']/g)) {
    const imp = m[1];
    if (!imp.startsWith(".")) {
      conceptSet.add(imp.split("/")[0].replace(/^@[^/]+\//, ""));
    } else {
      conceptSet.add(path.basename(imp, path.extname(imp)));
    }
  }

  return {
    exports,
    purpose,
    behavioralPatterns,
    invariantKeywords: Array.from(kwSet).slice(0, 30).sort(),
    importedConcepts: Array.from(conceptSet).sort(),
    lineCount: raw.split("\n").length
  };
}

function inferPurpose(basename: string): string {
  return basename
    .replace(/([A-Z])/g, " $1")
    .replace(/[-_.]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function splitCamel(s: string): string[] {
  return s
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

function computeFingerprint(sig: SemanticSignature): string {
  const canonical = JSON.stringify({
    exports: sig.exports,
    purpose: sig.purpose,
    behavioralPatterns: [...sig.behavioralPatterns].sort()
    // Intentionally exclude lineCount and importedConcepts — we fingerprint semantics, not layout
  });
  return crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 16);
}

// ─── Drift Analysis ──────────────────────────────────────────────────────────

function buildAlert(
  file: string,
  stored: SemanticContract,
  currentSig: SemanticSignature,
  currentFp: string
): DriftAlert {
  const storedExports = new Set(stored.semanticSignature.exports);
  const currentExports = new Set(currentSig.exports);

  const addedExports = currentSig.exports.filter(e => !storedExports.has(e));
  const removedExports = stored.semanticSignature.exports.filter(e => !currentExports.has(e));
  const purposeShift = stored.semanticSignature.purpose !== currentSig.purpose;
  const behavioralShift = fingerprint1d(stored.semanticSignature.behavioralPatterns) !==
                          fingerprint1d(currentSig.behavioralPatterns);

  const storedKw = new Set(stored.semanticSignature.invariantKeywords);
  const currentKw = new Set(currentSig.invariantKeywords);
  const invariantShift = [
    ...stored.semanticSignature.invariantKeywords.filter(k => !currentKw.has(k)).map(k => `-${k}`),
    ...currentSig.invariantKeywords.filter(k => !storedKw.has(k)).map(k => `+${k}`)
  ].slice(0, 12);

  const severity: DriftAlert["severity"] =
    stored.locked && (removedExports.length > 0 || purposeShift || behavioralShift)
      ? "critical"
    : removedExports.length > 0 || behavioralShift
      ? "high"
      : "medium";

  return {
    file,
    severity,
    oldFingerprint: stored.fingerprint,
    newFingerprint: currentFp,
    changes: { addedExports, removedExports, purposeShift, behavioralShift, invariantShift }
  };
}

function fingerprint1d(arr: string[]): string {
  return [...arr].sort().join(",");
}

function emptySheriffReport(action: string, message: string): SheriffReport {
  return {
    ok: true,
    action,
    generatedAt: new Date().toISOString(),
    contracts: 0,
    lockedContracts: 0,
    driftAlerts: [],
    summary: message,
    path: ".mesh/semantic-contracts/drift.json"
  };
}
