import path from "node:path";
import { readJson, writeJson } from "./common.js";

export class NaturalLanguageSourceEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "compile").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "compile") throw new Error("workspace.natural_language_source action must be compile|status");
    const intent = String(args.intent ?? args.source ?? "").trim();
    if (!intent) throw new Error("workspace.natural_language_source compile requires intent or source");
    const ir = compileIntent(intent);
    const result = {
      ok: true,
      action,
      source: intent,
      ir,
      patchPlan: buildPatchPlan(ir),
      verificationPlan: buildVerificationPlan(ir),
      ledgerPath: ".mesh/natural-language-source/last-compile.json"
    };
    await writeJson(this.ledgerPath(), result);
    return result;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(this.ledgerPath(), {
      ok: true,
      action: "status",
      message: "No natural-language compile ledger exists yet. Run action=compile."
    });
  }

  private ledgerPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "natural-language-source", "last-compile.json");
  }
}

function compileIntent(intent: string): Record<string, unknown> {
  const lower = intent.toLowerCase();
  const operations: string[] = [];
  if (/\b(add|create|introduce)\b/.test(lower)) operations.push("add");
  if (/\b(remove|delete|drop)\b/.test(lower)) operations.push("remove");
  if (/\b(rename)\b/.test(lower)) operations.push("rename");
  if (/\b(validat(?:e|es|ed|ing|ion)|guard|guards|guarded|reject|rejects|rejected|sanitize|sanitizes|sanitized|sanitizing)\b/.test(lower)) {
    operations.push("validate");
  }
  if (/\b(cache|memoize|performance|latency|fast)\b/.test(lower)) operations.push("optimize");
  if (operations.length === 0) operations.push("modify");

  const files = Array.from(intent.matchAll(/(?:src|tests|worker|scripts)\/[A-Za-z0-9_./-]+/g)).map((match) => match[0]);
  const tests = /\b(test|spec|verify|assert)\b/i.test(intent);
  const risk = /\b(auth|token|payment|delete|database|security|production)\b/i.test(intent) ? "high" : "normal";
  return {
    operations: Array.from(new Set(operations)),
    targetFiles: Array.from(new Set(files)),
    requiresTests: tests,
    risk,
    acceptance: extractAcceptance(intent)
  };
}

function extractAcceptance(intent: string): string[] {
  const clauses = intent
    .split(/(?:;|\n|\.|\bthen\b|\band\b)/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 8);
  return clauses.slice(0, 8);
}

function buildPatchPlan(ir: Record<string, any>): string[] {
  const files = ir.targetFiles?.length ? ir.targetFiles : ["repo-grounded target files from workspace.ask_codebase"];
  return [
    `Locate target behavior in ${files.join(", ")}.`,
    `Apply operations: ${(ir.operations ?? []).join(", ")}.`,
    ir.risk === "high" ? "Use a timeline and require manual promotion because the intent touches a high-risk boundary." : "Use a timeline for verification before promotion."
  ];
}

function buildVerificationPlan(ir: Record<string, any>): string[] {
  const plan = ["Run typecheck if available.", "Run the closest test suite for changed files."];
  if (ir.requiresTests) plan.unshift("Add or update tests matching the acceptance clauses.");
  if (ir.risk === "high") plan.push("Run security/safety checks and inspect the verification ledger before promotion.");
  return plan;
}
