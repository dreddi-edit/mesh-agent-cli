import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJson, writeJson } from "./moonshots/common.js";
import { routeMeshTask } from "./model-router.js";

const execFileAsync = promisify(execFile);

type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type DimensionStatus = "pass" | "warn" | "block";

interface DimensionReport {
  id: string;
  title: string;
  status: DimensionStatus;
  score: number;
  evidence: string[];
  nextActions: string[];
}

interface ProductionReadinessReport {
  ok: boolean;
  action: string;
  status: DimensionStatus;
  score: number;
  generatedAt: string;
  intent: string;
  verificationCommand: string;
  dimensions: DimensionReport[];
  blockers: string[];
  nextActions: string[];
  ledgerPath: string;
}

export class ProductionReadinessEngine {
  private readonly ledgerPath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly callTool: ToolCaller
  ) {
    this.ledgerPath = path.join(workspaceRoot, ".mesh", "production-readiness", "latest.json");
  }

  async run(args: Record<string, unknown> = {}): Promise<unknown> {
    const action = String(args.action ?? "audit").trim().toLowerCase();
    if (action === "status") {
      return readJson(this.ledgerPath, {
        ok: true,
        action,
        status: "missing",
        message: "No production readiness ledger exists yet. Run action=audit or action=gate."
      });
    }
    if (!["audit", "gate", "review"].includes(action)) {
      throw new Error("workspace.production_readiness action must be audit|gate|review|status");
    }

    const intent = String(args.intent ?? "production readiness hardening").trim();
    const verificationCommand = String(args.verificationCommand ?? await this.inferVerificationCommand()).trim();
    const url = typeof args.url === "string" ? args.url.trim() : "";

    const dimensions = await Promise.all([
      this.modelOrchestration(intent),
      this.retrievalQuality(intent),
      this.timelineVerification(intent, verificationCommand, action),
      this.runtimeLearning(),
      this.visualLoop(url),
      this.projectMemory(intent),
      this.reviewGate(verificationCommand)
    ]);

    const score = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length);
    const status: DimensionStatus = dimensions.some((item) => item.status === "block")
      ? "block"
      : dimensions.some((item) => item.status === "warn")
        ? "warn"
        : "pass";
    const blockers = dimensions.flatMap((item) =>
      item.status === "block" ? item.nextActions.map((actionItem) => `${item.title}: ${actionItem}`) : []
    );
    const nextActions = unique(dimensions.flatMap((item) => item.nextActions)).slice(0, 12);
    const report: ProductionReadinessReport = {
      ok: status !== "block",
      action,
      status,
      score,
      generatedAt: new Date().toISOString(),
      intent,
      verificationCommand,
      dimensions,
      blockers,
      nextActions,
      ledgerPath: ".mesh/production-readiness/latest.json"
    };

    await writeJson(this.ledgerPath, report);
    return report;
  }

  private async modelOrchestration(intent: string): Promise<DimensionReport> {
    const route = routeMeshTask(intent);
    const hasFallbacks =
      route.retrievalModels.length >= 3 &&
      route.visionModels.length >= 3 &&
      route.safetyModels.length >= 2 &&
      route.piiModels.length >= 1 &&
      (["code", "debug", "review"].includes(route.taskType) ? route.chatFallbacks.length >= 3 : true);
    return {
      id: "model_orchestration",
      title: "Model Orchestration",
      status: hasFallbacks ? "pass" : "warn",
      score: hasFallbacks ? 96 : 72,
      evidence: [
        `task=${route.taskType} confidence=${route.confidence}`,
        `primary=${route.primaryChatModel}`,
        `chatFallbacks=${route.chatFallbacks.join(", ")}`,
        `requiredGates=${route.requiredGates.join(", ")}`
      ],
      nextActions: hasFallbacks ? [] : ["Define full role-specific fallback chains for chat, retrieval, vision, and safety."]
    };
  }

  private async retrievalQuality(intent: string): Promise<DimensionReport> {
    const [status, query] = await Promise.all([
      this.safeTool<any>("workspace.index_status", {}),
      this.safeTool<any>("workspace.ask_codebase", { query: intent, mode: "architecture", limit: 8 })
    ]);
    const percent = Number(status?.percent ?? 0);
    const resultCount = Number(query?.results?.length ?? query?.topMatches?.length ?? 0);
    const score = Math.min(100, Math.round(percent * 0.7 + Math.min(resultCount, 8) * 3.75));
    return {
      id: "retrieval",
      title: "Production RAG",
      status: percent >= 80 && resultCount >= 3 ? "pass" : percent >= 50 ? "warn" : "block",
      score,
      evidence: [
        `indexFresh=${percent}%`,
        `retrievalMatches=${resultCount}`,
        `queryVariants=${Array.isArray(query?.queryVariants) ? query.queryVariants.join(" | ") : intent}`
      ],
      nextActions: percent >= 80 && resultCount >= 3
        ? []
        : ["Run /index and re-run workspace.production_readiness after the code index is fresh."]
    };
  }

  private async timelineVerification(
    intent: string,
    verificationCommand: string,
    action: string
  ): Promise<DimensionReport> {
    const [precrime, timelines, proof] = await Promise.all([
      this.safeTool<any>("workspace.precrime", { action: "status" }),
      this.safeTool<any>("workspace.timeline_list", {}),
      action === "gate" && verificationCommand
        ? this.safeTool<any>("workspace.proof_carrying_change", { action: "verify", intent, verificationCommand, timeoutMs: 240000 })
        : this.safeTool<any>("workspace.proof_carrying_change", { action: "status" })
    ]);
    const proofOk = proof?.ok !== false && !/No proof-carrying/.test(String(proof?.message ?? ""));
    const timelineCount = Array.isArray(timelines?.timelines) ? timelines.timelines.length : Number(timelines?.count ?? 0);
    const precrimeReady = precrime?.ok !== false && !/No precrime ledger/i.test(String(precrime?.message ?? ""));
    const score = (proofOk ? 42 : 12) + (precrimeReady ? 34 : 12) + Math.min(24, timelineCount * 6);
    return {
      id: "timeline_verification",
      title: "Timeline Verification",
      status: proofOk && precrimeReady ? "pass" : verificationCommand ? "warn" : "block",
      score,
      evidence: [
        `proof=${proofOk ? "present" : "missing"}`,
        `precrime=${precrimeReady ? "ready" : "missing"}`,
        `timelines=${timelineCount}`,
        `verification=${verificationCommand || "none"}`
      ],
      nextActions: [
        !precrimeReady ? "Run workspace.precrime action=analyze before promoting risky work." : "",
        !proofOk ? "Generate or verify workspace.proof_carrying_change for the current diff." : "",
        !verificationCommand ? "Configure a production verification command such as npm run typecheck && npm test." : ""
      ].filter(Boolean)
    };
  }

  private async runtimeLearning(): Promise<DimensionReport> {
    const [production, repair, causal] = await Promise.all([
      this.safeTool<any>("workspace.production_status", { action: "status" }),
      this.safeTool<any>("workspace.predictive_repair", { action: "status" }),
      this.safeTool<any>("workspace.causal_autopsy", { action: "status" })
    ]);
    const signals = Number(production?.totalSignals ?? 0);
    const repairQueue = Array.isArray(repair?.queue) ? repair.queue.length : 0;
    const causalReady = causal?.ok !== false && !/No causal/i.test(String(causal?.message ?? ""));
    const score = Math.min(100, 48 + Math.min(signals, 10) * 3 + Math.min(repairQueue, 5) * 4 + (causalReady ? 12 : 0));
    return {
      id: "runtime_learning",
      title: "Runtime Learning Loop",
      status: causalReady || signals > 0 || repairQueue > 0 ? "pass" : "warn",
      score,
      evidence: [
        `productionSignals=${signals}`,
        `repairQueue=${repairQueue}`,
        `causalLedger=${causalReady ? "ready" : "missing"}`
      ],
      nextActions: causalReady || signals > 0
        ? []
        : ["Capture at least one runtime failure or telemetry refresh so Mesh can learn from production signals."]
    };
  }

  private async visualLoop(url: string): Promise<DimensionReport> {
    if (!url) {
      return {
        id: "visual_loop",
        title: "Visual Patch Loop",
        status: "warn",
        score: 72,
        evidence: ["No URL provided; vision loop is installed but not exercised in this audit."],
        nextActions: ["Pass url=<local app URL> to workspace.production_readiness to run a live vision check."]
      };
    }
    const preview = await this.safeTool<any>("frontend.preview", { url, render: false, waitMs: 1200 });
    const ok = preview?.ok === true && typeof preview?.visionAnalysis === "string" && !preview.visionAnalysis.startsWith("vision unavailable");
    return {
      id: "visual_loop",
      title: "Visual Patch Loop",
      status: ok ? "pass" : "warn",
      score: ok ? 94 : 68,
      evidence: [
        `url=${url}`,
        `preview=${preview?.ok === true ? "captured" : "not captured"}`,
        `vision=${ok ? "analyzed" : String(preview?.visionAnalysis ?? preview?.error ?? "missing")}`.slice(0, 260)
      ],
      nextActions: ok ? [] : ["Ensure Chrome is available and NVIDIA_API_KEY is configured for screenshot analysis."]
    };
  }

  private async projectMemory(intent: string): Promise<DimensionReport> {
    const memory = await this.safeTool<any>("workspace.engineering_memory", { action: "read" });
    const rules = Array.isArray(memory?.memory?.rules) ? memory.memory.rules.length : 0;
    const decisions = Array.isArray(memory?.memory?.decisions) ? memory.memory.decisions.length : 0;
    if (rules === 0) {
      await this.safeTool("workspace.engineering_memory", {
        action: "record",
        outcome: "neutral",
        rule: "Production changes must pass model route, RAG, timeline, runtime, visual, memory, and review gates before promotion.",
        note: `Production readiness baseline recorded for: ${intent}`
      });
    }
    return {
      id: "project_memory",
      title: "Decision And Project Memory",
      status: rules > 0 || decisions > 0 ? "pass" : "warn",
      score: Math.min(100, 70 + Math.min(rules, 10) * 2 + Math.min(decisions, 10)),
      evidence: [`rules=${rules}`, `decisions=${decisions}`],
      nextActions: decisions > 0 ? [] : ["Record architecture decisions and rejected patterns in workspace.engineering_memory."]
    };
  }

  private async reviewGate(verificationCommand: string): Promise<DimensionReport> {
    const [status, diff, proof] = await Promise.all([
      this.safeTool<any>("workspace.git_status", {}),
      this.safeTool<any>("workspace.git_diff", {}),
      this.safeTool<any>("workspace.proof_carrying_change", { action: "status" })
    ]);
    const changedLines = String(status?.status ?? "").split(/\r?\n/g).filter(Boolean);
    const diffText = String(diff?.diff ?? "");
    const risks = reviewRisks(diffText, changedLines);
    const proofReady = proof?.ok !== false && !/No proof-carrying/.test(String(proof?.message ?? ""));
    const testTouched = changedLines.some((line) => /(\.test|\.spec|tests?\/)/.test(line));
    const sourceTouched = changedLines.some((line) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line));
    const testGap = sourceTouched && !testTouched;
    const statusValue: DimensionStatus = risks.some((risk) => risk.severity === "high") || !verificationCommand
      ? "block"
      : risks.length > 0 || testGap || !proofReady
        ? "warn"
        : "pass";
    return {
      id: "review_gate",
      title: "PR And Review Gate",
      status: statusValue,
      score: Math.max(0, 100 - risks.length * 14 - (testGap ? 18 : 0) - (proofReady ? 0 : 16) - (verificationCommand ? 0 : 24)),
      evidence: [
        `changedFiles=${changedLines.length}`,
        `proof=${proofReady ? "present" : "missing"}`,
        `testGap=${testGap}`,
        ...risks.slice(0, 6).map((risk) => `${risk.severity}:${risk.message}`)
      ],
      nextActions: [
        ...risks.map((risk) => risk.action),
        testGap ? "Add or update targeted tests for source changes before PR." : "",
        !proofReady ? "Generate a proof-carrying-change bundle for the PR diff." : ""
      ].filter(Boolean)
    };
  }

  private async inferVerificationCommand(): Promise<string> {
    const packagePath = path.join(this.workspaceRoot, "package.json");
    const pkg = await readJson<any | null>(packagePath, null);
    const scripts = pkg?.scripts ?? {};
    if (scripts.typecheck && scripts.test) return "npm run typecheck && npm test";
    if (scripts.test) return "npm test";
    if (scripts.build) return "npm run build";
    if (scripts.typecheck) return "npm run typecheck";
    return "";
  }

  private async safeTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.callTool(name, args) as T;
    } catch {
      return null;
    }
  }
}

function reviewRisks(diffText: string, changedLines: string[]): Array<{ severity: "high" | "medium" | "low"; message: string; action: string }> {
  const risks: Array<{ severity: "high" | "medium" | "low"; message: string; action: string }> = [];
  if (/(SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|nvapi-|sk-[A-Za-z0-9])/i.test(diffText)) {
    risks.push({ severity: "high", message: "Diff appears to include secrets or credential-shaped values.", action: "Remove secrets from the diff and rotate any exposed credential." });
  }
  if (/\b(exec|spawn|eval|Function)\s*\(/.test(diffText)) {
    risks.push({ severity: "high", message: "Diff touches process execution or dynamic evaluation.", action: "Run command-safety review and add input validation tests." });
  }
  if (changedLines.some((line) => /(package\.json|package-lock\.json|tsconfig\.json|Dockerfile|cloudbuild|wrangler|helm\/)/.test(line))) {
    risks.push({ severity: "medium", message: "Diff changes dependency, build, deploy, or infrastructure configuration.", action: "Run build plus deployment-specific verification before merge." });
  }
  if (changedLines.some((line) => /(auth|security|runtime|llm-client|local-tools|agent-loop)/i.test(line))) {
    risks.push({ severity: "medium", message: "Diff touches high-leverage runtime, auth, security, or agent files.", action: "Require timeline verification and a focused code review." });
  }
  return risks;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
