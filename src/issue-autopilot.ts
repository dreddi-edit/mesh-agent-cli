import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readJson, writeJson } from "./moonshots/common.js";
import { CompanyBrainEngine } from "./company-brain.js";
import { runCritic } from "./agents/critic.js";
import { runRedTeam } from "./agents/redteam.js";

const execFileAsync = promisify(execFile);

type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type LlmCaller = (input: { system: string; user: string; temperature?: number; maxTokens?: number }) => Promise<string>;
type AutopilotAction = "status" | "plan" | "run" | "pr";

interface AutopilotIssue {
  provider: "github" | "linear" | "jira" | "manual";
  id: string;
  title: string;
  body: string;
  labels: string[];
  url?: string;
  repository?: string;
}

interface AutopilotPlan {
  issue: AutopilotIssue;
  intent: string;
  verificationCommand: string;
  branchName: string;
  prTitle: string;
  likelyFiles: string[];
  brainCitations: Array<Record<string, unknown>>;
  route: Record<string, unknown> | null;
  contract: Record<string, unknown> | null;
  impact: Record<string, unknown> | null;
  implementationContext: string;
  patchPrompt: string;
}

interface AutopilotRunRecord {
  id: string;
  action: AutopilotAction;
  status: "planned" | "requires_patch" | "patch_failed" | "verified" | "blocked" | "pr_ready" | "pr_created";
  ok: boolean;
  startedAt: string;
  finishedAt?: string;
  plan: AutopilotPlan;
  timeline?: {
    id: string;
    root: string;
    applyAttempts: Array<{ attempt: number; ok: boolean; message: string; stderr?: string }>;
    verification?: Record<string, unknown>;
    comparison?: Record<string, unknown>;
  };
  review?: Record<string, unknown>;
  proof?: Record<string, unknown>;
  pr?: Record<string, unknown>;
  artifacts: {
    runPath: string;
    latestPath: string;
  };
}

export class IssueAutopilotEngine {
  private readonly companyBrain: CompanyBrainEngine;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: {
      callTool: ToolCaller;
      callLlm?: LlmCaller;
    }
  ) {
    this.companyBrain = new CompanyBrainEngine(workspaceRoot, options.callTool);
  }

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = normalizeAction(String(args.action ?? "status"));
    if (action === "status") return this.status();
    const issue = await this.resolveIssue(args);
    const plan = await this.buildPlan(issue, args);
    if (action === "plan") {
      const record = this.emptyRecord(action, "planned", true, plan);
      await this.writeRun(record);
      return {
        ok: true,
        action,
        status: record.status,
        runId: record.id,
        plan: publicPlan(plan),
        artifacts: record.artifacts
      };
    }
    return this.execute(action, plan, args);
  }

  private async execute(
    action: "run" | "pr",
    plan: AutopilotPlan,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const record = this.emptyRecord(action, "requires_patch", false, plan);
    const maxAttempts = clampNumber(args.maxAttempts, 2, 1, 4);
    const timelineCreated: any = await this.options.callTool("workspace.timeline_create", {
      name: `autopilot-${plan.issue.provider}-${plan.issue.id}`,
      baseRef: typeof args.baseRef === "string" ? args.baseRef : undefined
    });
    const timeline = timelineCreated?.timeline;
    if (!timeline?.id || !timeline?.root) {
      throw new Error("Issue Autopilot could not create a verification timeline");
    }
    record.timeline = { id: timeline.id, root: timeline.root, applyAttempts: [] };

    let patch = String(args.patch ?? "").trim();
    let lastApplyError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!patch) {
        patch = await this.generatePatch(plan, attempt, lastApplyError);
      }
      if (!patch.trim()) {
        record.status = "requires_patch";
        record.proof = {
          verdict: "manual_patch_required",
          patchPrompt: plan.patchPrompt,
          reason: "No patch was supplied and no LLM patch generator is configured."
        };
        await this.finishAndWrite(record);
        return this.publicRun(record);
      }
      const sanitized = sanitizePatch(patch);
      const applied: any = await this.options.callTool("workspace.timeline_apply_patch", {
        timelineId: timeline.id,
        patch: sanitized
      });
      record.timeline.applyAttempts.push({
        attempt,
        ok: Boolean(applied?.ok),
        message: String(applied?.message ?? (applied?.ok ? "Patch applied." : "Patch rejected.")),
        stderr: applied?.stderr ? String(applied.stderr).slice(0, 4000) : undefined
      });
      if (applied?.ok) {
        patch = sanitized;
        break;
      }
      patch = "";
      lastApplyError = String(applied?.stderr ?? applied?.message ?? "patch apply failed");
    }

    const appliedOk = record.timeline.applyAttempts.some((item) => item.ok);
    if (!appliedOk) {
      record.status = "patch_failed";
      record.proof = { verdict: "patch_failed", attempts: record.timeline.applyAttempts };
      await this.finishAndWrite(record);
      return this.publicRun(record);
    }

    const verification: any = await this.options.callTool("workspace.timeline_run", {
      timelineId: timeline.id,
      command: plan.verificationCommand,
      timeoutMs: clampNumber(args.timeoutMs, 240_000, 5_000, 900_000)
    });
    record.timeline.verification = verification;

    const compare: any = await this.options.callTool("workspace.timeline_compare", {
      timelineIds: [timeline.id]
    });
    const comparison = Array.isArray(compare?.comparisons) ? compare.comparisons[0] : null;
    record.timeline.comparison = comparison ?? {};
    const diffPreview = String(comparison?.diffPreview ?? patch);
    record.review = reviewDiff(diffPreview, Boolean(verification?.ok), plan);
    record.proof = buildProof(record, diffPreview);

    const ready = Boolean(verification?.ok) && record.review?.ok !== false && record.proof?.verdict === "pass";
    record.ok = ready;
    record.status = ready ? (action === "pr" ? "pr_ready" : "verified") : "blocked";

    if (ready && (action === "pr" || args.submitPr === true)) {
      record.pr = await this.createPullRequest(plan, timeline.root, comparison, args).catch((error) => ({
        ok: false,
        error: (error as Error).message
      }));
      if (record.pr?.ok) {
        record.status = "pr_created";
      }
    }

    await this.companyBrain.ingest({
      source: "autopilot",
      title: `${plan.issue.provider}:${plan.issue.id} ${record.status}`,
      body: `${plan.issue.title}\nverdict=${record.proof?.verdict ?? "unknown"}\nverification=${verification?.ok ? "pass" : "fail"}`,
      files: Array.isArray(comparison?.changedFiles) ? comparison.changedFiles : plan.likelyFiles
    }).catch(() => undefined);

    await this.finishAndWrite(record);
    return this.publicRun(record);
  }

  private async buildPlan(issue: AutopilotIssue, args: Record<string, unknown>): Promise<AutopilotPlan> {
    const intent = `${issue.title}\n\n${issue.body}`.trim();
    const verificationCommand = String(args.verificationCommand ?? await inferVerificationCommand(this.workspaceRoot)).trim();
    await this.companyBrain.build({ maxFiles: args.maxBrainFiles ?? 1200 }).catch(() => null);
    const [brain, contractResult, impact, route] = await Promise.all([
      this.companyBrain.query({ query: intent, limit: 10 }).catch((error) => ({ ok: false, error: (error as Error).message, citations: [], recommendedFiles: [] })),
      this.safeTool<any>("workspace.intent_compile", { intent, verificationCommand }),
      this.safeTool<any>("workspace.impact_map", { symbol: issue.title }),
      this.safeTool<any>("workspace.model_route", { task: intent })
    ]);
    const contract = contractResult?.contract ?? contractResult ?? null;
    const likelyFiles = unique([
      ...arrayStrings(contract?.likelyFiles),
      ...arrayStrings((brain as any)?.recommendedFiles),
      ...arrayStrings((impact?.ranked ?? []).map((entry: any) => entry.file ?? entry.path))
    ], 14);
    const implementationContext = await this.loadImplementationContext(likelyFiles);
    const branchName = sanitizeBranchName(String(args.branchName ?? `mesh/${issue.provider}-${issue.id}-${issue.title}`));
    const prTitle = String(args.prTitle ?? `[mesh] ${issue.title}`).slice(0, 240);
    const plan: AutopilotPlan = {
      issue,
      intent,
      verificationCommand,
      branchName,
      prTitle,
      likelyFiles,
      brainCitations: Array.isArray((brain as any)?.citations) ? (brain as any).citations.slice(0, 10) : [],
      route: route?.route ?? route ?? null,
      contract,
      impact: impact ?? null,
      implementationContext,
      patchPrompt: ""
    };
    plan.patchPrompt = buildPatchPrompt(plan);
    return plan;
  }

  private async generatePatch(plan: AutopilotPlan, attempt: number, previousError: string): Promise<string> {
    if (!this.options.callLlm) return "";
    const system = [
      "You are Mesh Issue Autopilot.",
      "Return only a raw git patch in unified diff format.",
      "Do not include markdown fences, explanations, summaries, or commands.",
      "Make the smallest production-quality change that satisfies the issue.",
      "Update tests when behavior changes."
    ].join("\n");
    const user = attempt === 1
      ? plan.patchPrompt
      : [
          plan.patchPrompt,
          "",
          "The previous patch failed to apply. Produce a corrected raw git patch.",
          `Apply error:\n${previousError.slice(0, 4000)}`
        ].join("\n");
    return this.options.callLlm({ system, user, temperature: 0.1, maxTokens: 8192 });
  }

  private async loadImplementationContext(files: string[]): Promise<string> {
    const chunks: string[] = [];
    for (const file of files.slice(0, 8)) {
      const absolute = ensureInsideRoot(this.workspaceRoot, file);
      const raw = await fs.readFile(absolute, "utf8").catch(() => "");
      if (!raw) continue;
      chunks.push([
        `--- ${file} ---`,
        raw.split(/\r?\n/g).slice(0, 260).map((line, index) => `${index + 1}: ${line}`).join("\n")
      ].join("\n"));
    }
    return chunks.join("\n\n").slice(0, 55_000);
  }

  private async createPullRequest(
    plan: AutopilotPlan,
    timelineRoot: string,
    comparison: any,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const branchName = plan.branchName;
    await git(timelineRoot, ["checkout", "-B", branchName]);
    await git(timelineRoot, ["add", "-A"]);
    const staged = await gitQuiet(timelineRoot, ["diff", "--cached", "--quiet"]);
    if (staged) {
      return { ok: false, branchName, error: "No staged changes to commit." };
    }
    await git(timelineRoot, ["commit", "-m", plan.prTitle, "-m", this.prBody(plan, comparison)]);
    const push = args.push !== false;
    if (push) {
      await git(timelineRoot, ["push", "-u", "origin", `HEAD:${branchName}`]);
    }

    const remote = await gitOutput(timelineRoot, ["config", "--get", "remote.origin.url"]);
    const repo = parseGitRemote(remote);
    const base = String(args.baseBranch ?? await inferBaseBranch(timelineRoot));
    if (!push) {
      return {
        ok: true,
        branchName,
        pushed: false,
        message: "Branch committed in timeline. Push is disabled, so PR creation was skipped.",
        timelineRoot
      };
    }
    if (!repo) {
      return {
        ok: true,
        branchName,
        pushed: true,
        message: "Branch pushed, but remote repository could not be parsed for PR creation."
      };
    }
    const created = await createGithubPr(repo, {
      title: plan.prTitle,
      body: this.prBody(plan, comparison),
      head: branchName,
      base
    });
    return { ok: true, branchName, pushed: true, provider: "github", ...created };
  }

  private prBody(plan: AutopilotPlan, comparison: any): string {
    return [
      "## Source Issue",
      `- ${plan.issue.provider}:${plan.issue.id} ${plan.issue.title}`,
      plan.issue.url ? `- ${plan.issue.url}` : "",
      "",
      "## Mesh Autopilot Proof",
      `- Verification: ${plan.verificationCommand}`,
      `- Changed files: ${Array.isArray(comparison?.changedFiles) ? comparison.changedFiles.join(", ") : "n/a"}`,
      `- Changed lines: ${comparison?.changedLineCount ?? "n/a"}`,
      "",
      "## Company Brain Context",
      ...plan.brainCitations.slice(0, 8).map((citation: any) => `- ${citation.file ?? citation.title ?? citation.id}`),
      "",
      "## Review Gates",
      "- Timeline verification completed before PR creation.",
      "- Diff review and red-team heuristics evaluated.",
      "- Proof bundle stored in .mesh/autopilot/."
    ].filter(Boolean).join("\n");
  }

  private async resolveIssue(args: Record<string, unknown>): Promise<AutopilotIssue> {
    const title = String(args.title ?? "").trim();
    const body = String(args.body ?? args.description ?? "").trim();
    if (title) {
      return {
        provider: "manual",
        id: sanitizeIssueId(String(args.issueId ?? Date.now().toString(36))),
        title,
        body,
        labels: arrayStrings(args.labels),
        url: typeof args.issueUrl === "string" ? args.issueUrl : undefined
      };
    }
    const issueUrl = String(args.issueUrl ?? args.url ?? "").trim();
    if (issueUrl) {
      const github = parseGithubIssueUrl(issueUrl);
      if (github) {
        return fetchGithubIssue(github).catch(() => ({
          provider: "github" as const,
          id: String(github.number),
          title: `GitHub issue ${github.owner}/${github.repo}#${github.number}`,
          body: `Fetch failed for ${issueUrl}. Provide title/body or configure network/token access.`,
          labels: [],
          url: issueUrl,
          repository: `${github.owner}/${github.repo}`
        }));
      }
    }
    const snapshot = await readJson<any[]>(path.join(this.workspaceRoot, ".mesh", "issues-snapshot.json"), []);
    const issueId = String(args.issueId ?? "").trim();
    const provider = String(args.provider ?? "").trim().toLowerCase();
    const found = snapshot.find((issue) =>
      (!issueId || String(issue.id) === issueId) &&
      (!provider || String(issue.provider).toLowerCase() === provider)
    );
    if (found) {
      return {
        provider: ["github", "linear", "jira"].includes(found.provider) ? found.provider : "manual",
        id: String(found.id),
        title: String(found.title),
        body: String(found.body ?? ""),
        labels: arrayStrings(found.labels),
        url: found.url ? String(found.url) : undefined
      };
    }
    throw new Error("Issue Autopilot requires title/body, issueUrl, or an issueId present in .mesh/issues-snapshot.json");
  }

  private async safeTool<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.options.callTool(name, args) as T;
    } catch {
      return null;
    }
  }

  private emptyRecord(action: AutopilotAction, status: AutopilotRunRecord["status"], ok: boolean, plan: AutopilotPlan): AutopilotRunRecord {
    const id = `auto-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    return {
      id,
      action,
      status,
      ok,
      startedAt: new Date().toISOString(),
      plan,
      artifacts: {
        runPath: `.mesh/autopilot/runs/${id}.json`,
        latestPath: ".mesh/autopilot/latest.json"
      }
    };
  }

  private async finishAndWrite(record: AutopilotRunRecord): Promise<void> {
    record.finishedAt = new Date().toISOString();
    await this.writeRun(record);
  }

  private async writeRun(record: AutopilotRunRecord): Promise<void> {
    const runPath = path.join(this.workspaceRoot, record.artifacts.runPath);
    const latestPath = path.join(this.workspaceRoot, record.artifacts.latestPath);
    await writeJson(runPath, record);
    await writeJson(latestPath, record);
  }

  private async status(): Promise<Record<string, unknown>> {
    const latest = await readJson<AutopilotRunRecord | null>(path.join(this.workspaceRoot, ".mesh", "autopilot", "latest.json"), null);
    if (!latest) {
      return {
        ok: true,
        action: "status",
        status: "missing",
        message: "No Issue Autopilot run exists yet. Run workspace.issue_autopilot action=plan or action=run."
      };
    }
    return {
      ok: true,
      action: "status",
      status: latest.status,
      runId: latest.id,
      issue: latest.plan.issue,
      lastRunOk: latest.ok,
      startedAt: latest.startedAt,
      finishedAt: latest.finishedAt,
      artifacts: latest.artifacts
    };
  }

  private publicRun(record: AutopilotRunRecord): Record<string, unknown> {
    return {
      ok: record.ok,
      action: record.action,
      status: record.status,
      runId: record.id,
      issue: record.plan.issue,
      plan: publicPlan(record.plan),
      timeline: record.timeline ? {
        id: record.timeline.id,
        applyAttempts: record.timeline.applyAttempts,
        verification: record.timeline.verification,
        comparison: record.timeline.comparison
      } : undefined,
      review: record.review,
      proof: record.proof,
      pr: record.pr,
      artifacts: record.artifacts
    };
  }
}

function publicPlan(plan: AutopilotPlan): Record<string, unknown> {
  return {
    issue: plan.issue,
    verificationCommand: plan.verificationCommand,
    branchName: plan.branchName,
    prTitle: plan.prTitle,
    likelyFiles: plan.likelyFiles,
    brainCitations: plan.brainCitations.slice(0, 8),
    route: plan.route,
    patchPrompt: plan.patchPrompt
  };
}

function buildPatchPrompt(plan: AutopilotPlan): string {
  return [
    "Implement this issue as a raw git patch.",
    "",
    "Issue:",
    `${plan.issue.provider}:${plan.issue.id} ${plan.issue.title}`,
    plan.issue.body,
    "",
    "Verification command:",
    plan.verificationCommand,
    "",
    "Likely files:",
    plan.likelyFiles.map((file) => `- ${file}`).join("\n") || "- none",
    "",
    "Company Brain citations:",
    plan.brainCitations.map((citation: any) => `- ${citation.file ?? citation.title ?? citation.id}: ${String(citation.snippet ?? "").slice(0, 240)}`).join("\n") || "- none",
    "",
    "Implementation context:",
    plan.implementationContext || "No source context available.",
    "",
    "Return only a raw git patch."
  ].join("\n");
}

function reviewDiff(diffPreview: string, verificationOk: boolean, plan: AutopilotPlan): Record<string, unknown> {
  const critic = runCritic({ diffPreview, verificationOk });
  const redTeam = runRedTeam({ diffPreview });
  const findings = [...critic.findings];
  const changedFiles = Array.from(diffPreview.matchAll(/^diff --git a\/(.+?) b\//gm)).map((match) => match[1]);
  const sourceChanged = changedFiles.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !/(\.test|\.spec)\./.test(file));
  const testChanged = changedFiles.some((file) => /(\.test|\.spec)\.|(^|\/)(test|tests|__tests__)\//.test(file));
  if (sourceChanged && !testChanged) {
    findings.push({
      severity: "medium",
      reason: "Source changed without an obvious test update.",
      evidence: changedFiles.join(", ")
    });
  }
  if (/\b(nvapi-|sk-|gh[pousr]_)/.test(diffPreview)) {
    findings.push({
      severity: "high",
      reason: "Diff appears to introduce a secret token.",
      evidence: "secret-like token pattern in diff"
    });
  }
  if (/child_process|exec\(|spawn\(|eval\(|new Function/.test(diffPreview) && !/command-safety|assertCommandAllowed/.test(diffPreview)) {
    findings.push({
      severity: "high",
      reason: "Diff touches command execution without an obvious safety gate.",
      evidence: "command execution token detected"
    });
  }
  const ok = verificationOk && critic.ok && redTeam.ok && findings.every((finding) => finding.severity !== "high");
  return {
    ok,
    issue: `${plan.issue.provider}:${plan.issue.id}`,
    changedFiles,
    critic,
    redTeam,
    findings
  };
}

function buildProof(record: AutopilotRunRecord, diffPreview: string): Record<string, unknown> {
  const verificationOk = Boolean(record.timeline?.verification?.ok);
  const reviewOk = record.review?.ok !== false;
  const applyOk = Boolean(record.timeline?.applyAttempts.some((attempt) => attempt.ok));
  const verdict = applyOk && verificationOk && reviewOk ? "pass" : "fail";
  const proofId = crypto.createHash("sha256").update(JSON.stringify({
    issue: record.plan.issue,
    timeline: record.timeline?.id,
    verificationOk,
    reviewOk,
    diffHash: crypto.createHash("sha1").update(diffPreview).digest("hex")
  })).digest("hex").slice(0, 16);
  return {
    proofId,
    verdict,
    generatedAt: new Date().toISOString(),
    gates: [
      { name: "timeline_patch_apply", ok: applyOk },
      { name: "timeline_verification", ok: verificationOk, command: record.plan.verificationCommand },
      { name: "diff_review", ok: reviewOk },
      { name: "company_brain_context", ok: record.plan.brainCitations.length > 0 }
    ],
    issue: record.plan.issue,
    changedFiles: record.timeline?.comparison?.changedFiles ?? [],
    changedLineCount: record.timeline?.comparison?.changedLineCount ?? 0,
    rollback: "Close the PR branch or discard the timeline. Main workspace is untouched unless timeline promotion is explicitly run.",
    artifacts: record.artifacts
  };
}

function normalizeAction(value: string): AutopilotAction {
  const normalized = value.trim().toLowerCase().replace("-", "_");
  if (normalized === "create_pr" || normalized === "submit_pr") return "pr";
  if (["status", "plan", "run", "pr"].includes(normalized)) return normalized as AutopilotAction;
  return "status";
}

function sanitizePatch(value: string): string {
  let text = value.trim();
  text = text.replace(/^```(?:diff|patch)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const diffIndex = text.indexOf("diff --git ");
  if (diffIndex > 0) text = text.slice(diffIndex);
  return text;
}

async function inferVerificationCommand(workspaceRoot: string): Promise<string> {
  const pkg = await readJson<any | null>(path.join(workspaceRoot, "package.json"), null);
  const scripts = pkg?.scripts ?? {};
  const parts: string[] = [];
  if (scripts.typecheck) parts.push("npm run typecheck");
  if (scripts.test) parts.push("npm test");
  if (parts.length > 0) return parts.join(" && ");
  if (scripts.build) return "npm run build";
  return "node --version";
}

async function inferBaseBranch(cwd: string): Promise<string> {
  const originHead = await gitOutput(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const parsed = originHead.trim().replace(/^origin\//, "");
  if (parsed) return parsed;
  const branch = await gitOutput(cwd, ["branch", "--show-current"]);
  return branch.trim() || "main";
}

function sanitizeBranchName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized.startsWith("mesh/") ? normalized : `mesh/${normalized || Date.now().toString(36)}`;
}

function sanitizeIssueId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "manual";
}

function parseGithubIssueUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

async function fetchGithubIssue(input: { owner: string; repo: string; number: number }): Promise<AutopilotIssue> {
  const token = process.env.MESH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.number}`, {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GitHub issue fetch failed: HTTP ${response.status}`);
    const payload = await response.json() as any;
    return {
      provider: "github",
      id: String(payload.number ?? input.number),
      title: String(payload.title ?? `GitHub issue #${input.number}`),
      body: String(payload.body ?? ""),
      labels: Array.isArray(payload.labels) ? payload.labels.map((label: any) => String(label.name ?? label)).slice(0, 30) : [],
      url: String(payload.html_url ?? `https://github.com/${input.owner}/${input.repo}/issues/${input.number}`),
      repository: `${input.owner}/${input.repo}`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function createGithubPr(repo: { owner: string; repo: string }, input: {
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<Record<string, unknown>> {
  const token = process.env.MESH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`GitHub PR create failed: HTTP ${response.status} ${String((payload as any).message ?? "")}`);
    return {
      url: String((payload as any).html_url ?? ""),
      number: (payload as any).number,
      state: (payload as any).state
    };
  }
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "create", "--repo", `${repo.owner}/${repo.repo}`, "--title", input.title, "--body", input.body, "--base", input.base, "--head", input.head], {
      maxBuffer: 1024 * 1024
    });
    return { url: stdout.trim(), via: "gh" };
  } catch (error: any) {
    throw new Error(`No GitHub token available and gh pr create failed: ${String(error.stderr ?? error.message)}`);
  }
}

function parseGitRemote(remote: string): { owner: string; repo: string } | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 5 * 1024 * 1024 });
  return stdout;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error: any) {
    return String(error.stdout ?? "");
  }
}

async function gitQuiet(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function ensureInsideRoot(root: string, requestedPath: string): string {
  const candidate = path.resolve(root, requestedPath);
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${requestedPath}`);
  }
  return candidate;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

function unique<T>(values: T[], limit = 100): T[] {
  return Array.from(new Set(values)).slice(0, limit);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
