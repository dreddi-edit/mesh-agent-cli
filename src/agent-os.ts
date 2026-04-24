import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { TimelineManager } from "./timeline-manager.js";

interface AgentRunRecord {
  id: string;
  role: string;
  task: string;
  workspaceScope?: string[];
  writeScope?: string[];
  timelineId: string;
  status: "ready" | "reviewed" | "merged" | "rejected";
  definitionPath?: string;
  outputContract?: string;
  createdAt: string;
  updatedAt: string;
}

export class AgentOs {
  public readonly workspaceHash: string;
  public readonly basePath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly timelines: TimelineManager
  ) {
    this.workspaceHash = crypto
      .createHash("sha256")
      .update(path.resolve(workspaceRoot))
      .digest("hex")
      .slice(0, 24);
    this.basePath = path.join(os.homedir(), ".config", "mesh", "agents", this.workspaceHash);
  }

  async spawn(args: Record<string, unknown>): Promise<{ ok: true; agent: AgentRunRecord; timelineRoot: string }> {
    const role = String(args.role ?? "").trim();
    const task = String(args.task ?? "").trim();
    if (!role || !task) throw new Error("agent.spawn requires role and task");

    const definition = await this.readDefinition(role);
    const timeline = await this.timelines.create({ name: `${role}-${Date.now().toString(36)}` });
    const id = `agent-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const record: AgentRunRecord = {
      id,
      role,
      task,
      workspaceScope: normalizeStringArray(args.workspaceScope),
      writeScope: normalizeStringArray(args.writeScope),
      timelineId: timeline.timeline.id,
      status: "ready",
      definitionPath: definition.path,
      outputContract: definition.outputContract,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.writeRecord(record);
    return { ok: true, agent: record, timelineRoot: timeline.timeline.root };
  }

  async status(args: Record<string, unknown> = {}): Promise<{ ok: true; agents: AgentRunRecord[] }> {
    const targetId = typeof args.id === "string" ? args.id.trim() : "";
    await fs.mkdir(this.basePath, { recursive: true });
    const entries = await fs.readdir(this.basePath, { withFileTypes: true }).catch(() => []);
    const agents: AgentRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(this.basePath, entry.name), "utf8").catch(() => "");
      if (!raw) continue;
      const record = JSON.parse(raw) as AgentRunRecord;
      if (!targetId || record.id === targetId) agents.push(record);
    }
    agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { ok: true, agents };
  }

  async review(args: Record<string, unknown>): Promise<{
    ok: true;
    timelineId: string;
    verdict: "pass" | "flag";
    findings: Array<{ severity: "high" | "medium" | "low"; message: string }>;
    diffStat: string;
  }> {
    const timelineId = String(args.timelineId ?? "").trim();
    if (!timelineId) throw new Error("agent.review requires timelineId");
    const comparison = await this.timelines.compare({ timelineIds: [timelineId] });
    const first = comparison.comparisons[0] ?? {};
    const diffPreview = String(first.diffPreview ?? "");
    const diffStat = String(first.diffStat ?? "");
    const findings: Array<{ severity: "high" | "medium" | "low"; message: string }> = [];

    if (/exec\(|spawn\(|rm\s+-rf|AWS_|SECRET|TOKEN/i.test(diffPreview)) {
      findings.push({ severity: "high", message: "Diff touches shell execution, destructive operations, or secret-bearing code." });
    }
    if (/package-lock\.json|package\.json|tsconfig\.json/.test(diffStat)) {
      findings.push({ severity: "medium", message: "Diff changes project-level configuration or dependency metadata." });
    }
    if (!/test|spec|verify|npm test|npm run build/i.test(JSON.stringify(first.lastCommand ?? {}))) {
      findings.push({ severity: "low", message: "No targeted verification command is recorded on this timeline." });
    }

    return {
      ok: true,
      timelineId,
      verdict: findings.some((finding) => finding.severity === "high") ? "flag" : "pass",
      findings,
      diffStat
    };
  }

  async mergeVerified(args: Record<string, unknown>): Promise<unknown> {
    const timelineId = String(args.timelineId ?? "").trim();
    if (!timelineId) throw new Error("agent.merge_verified requires timelineId");
    return this.timelines.promote({ timelineId });
  }

  async ensureDefaultDefinitions(): Promise<void> {
    const agentsDir = path.join(this.workspaceRoot, ".mesh", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const defaults: Record<string, string> = {
      "code-reviewer.md": [
        "# code-reviewer",
        "",
        "Role: inspect timeline diffs for correctness, regressions, security issues, and missing tests.",
        "Model: default",
        "Tools: workspace.timeline_compare, workspace.impact_map, workspace.ask_codebase",
        "Budget: medium",
        "Permissions: read-only",
        "Output contract: findings ordered by severity with file/line citations and residual risk."
      ].join("\n"),
      "debugger.md": [
        "# debugger",
        "",
        "Role: connect runtime failures and test failures back to source symbols.",
        "Model: default",
        "Tools: runtime.capture_failure, runtime.explain_failure, workspace.impact_map, workspace.timeline_run",
        "Budget: high",
        "Permissions: timeline writes only",
        "Output contract: root cause, candidate patch plan, verification command, residual risk."
      ].join("\n"),
      "test-runner.md": [
        "# test-runner",
        "",
        "Role: run targeted verification in an isolated timeline and report the exact command output.",
        "Model: default",
        "Tools: workspace.timeline_run, workspace.timeline_compare",
        "Budget: low",
        "Permissions: command execution inside timeline only",
        "Output contract: command, exit code, pass/fail verdict, relevant stdout/stderr excerpts."
      ].join("\n")
    };

    for (const [fileName, content] of Object.entries(defaults)) {
      const filePath = path.join(agentsDir, fileName);
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!exists) {
        await fs.writeFile(filePath, `${content}\n`, "utf8");
      }
    }
  }

  private async readDefinition(role: string): Promise<{ path?: string; outputContract?: string }> {
    const safeRole = role.replace(/[^a-zA-Z0-9._-]+/g, "-");
    const definitionPath = path.join(this.workspaceRoot, ".mesh", "agents", `${safeRole}.md`);
    const raw = await fs.readFile(definitionPath, "utf8").catch(() => "");
    if (!raw) return {};
    const outputContract = raw
      .split(/\r?\n/g)
      .find((line) => line.toLowerCase().startsWith("output contract:"))
      ?.replace(/^output contract:\s*/i, "")
      .trim();
    return { path: definitionPath, outputContract };
  }

  private async writeRecord(record: AgentRunRecord): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    await fs.writeFile(path.join(this.basePath, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}
