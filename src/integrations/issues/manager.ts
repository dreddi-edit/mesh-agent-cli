import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchGithubIssues } from "./github.js";
import { fetchJiraIssues } from "./jira.js";
import { fetchLinearIssues } from "./linear.js";
import { IssuePipelineResult, IssueProviderConfig, IssueRecord } from "./types.js";

interface PipelineHooks {
  intentCompile: (intent: string) => Promise<any>;
  impactMap: (intent: string) => Promise<any>;
}

interface IntegrationsConfig {
  issues?: IssueProviderConfig[];
  meshBotUser?: string;
}

export class IssuePipelineManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly hooks: PipelineHooks
  ) {}

  async run(args: {
    provider?: string;
    issueId?: string;
    action?: string;
  }): Promise<{
    ok: boolean;
    action: string;
    queued: number;
    processed: IssuePipelineResult[];
  }> {
    const action = args.action || "scan";
    const config = await this.readConfig();
    const incoming = await this.loadIssues(config);
    const provider = args.provider?.toLowerCase();
    const filtered = incoming.filter((issue) => {
      if (provider && issue.provider !== provider) return false;
      if (args.issueId && issue.id !== args.issueId) return false;
      if (issue.labels.some((label) => label.toLowerCase() === "mesh")) return true;
      if (config.meshBotUser && issue.assignedTo === config.meshBotUser) return true;
      return false;
    });

    if (action === "status") {
      return { ok: true, action, queued: filtered.length, processed: [] };
    }

    const processed: IssuePipelineResult[] = [];
    for (const issue of filtered.slice(0, 10)) {
      const intent = await this.hooks.intentCompile(`${issue.title}\n\n${issue.body}`);
      const impact = await this.hooks.impactMap(issue.title);
      const likelyFiles = Array.isArray(intent?.contract?.likelyFiles) ? intent.contract.likelyFiles : [];
      const highRisk = Array.isArray(impact?.ranked) ? impact.ranked.slice(0, 3).map((entry: any) => entry.path || entry.file).filter(Boolean) : [];
      const timelineHints = [...new Set([...likelyFiles, ...highRisk])].slice(0, 8);
      processed.push({
        ok: true,
        provider: issue.provider,
        issueId: issue.id,
        title: issue.title,
        prTitle: `[mesh] ${issue.title}`,
        prBody: buildPrBody(issue, intent, impact),
        timelineHints
      });
    }

    await this.writeReport(processed);
    return { ok: true, action, queued: filtered.length, processed };
  }

  private async readConfig(): Promise<IntegrationsConfig> {
    const configPath = path.join(this.workspaceRoot, ".mesh", "integrations.json");
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as IntegrationsConfig;
      return parsed;
    } catch {
      return { issues: [{ provider: "github", enabled: true }, { provider: "linear", enabled: true }, { provider: "jira", enabled: true }] };
    }
  }

  private async loadIssues(config: IntegrationsConfig): Promise<IssueRecord[]> {
    const fallbackPath = path.join(this.workspaceRoot, ".mesh", "issues-snapshot.json");
    let fallback: IssueRecord[] = [];
    try {
      fallback = JSON.parse(await fs.readFile(fallbackPath, "utf8")) as IssueRecord[];
    } catch {
      fallback = [];
    }
    const providers = config.issues ?? [];
    const batches = await Promise.all(providers.map(async (entry) => {
      if (entry.provider === "github") return fetchGithubIssues(entry, fallback);
      if (entry.provider === "linear") return fetchLinearIssues(entry, fallback);
      return fetchJiraIssues(entry, fallback);
    }));
    return batches.flat();
  }

  private async writeReport(rows: IssuePipelineResult[]): Promise<void> {
    const reportPath = path.join(this.workspaceRoot, ".mesh", "issue-pipeline", "latest.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      items: rows
    }, null, 2), "utf8");
  }
}

function buildPrBody(issue: IssueRecord, intent: any, impact: any): string {
  const phases = Array.isArray(intent?.contract?.phases) ? intent.contract.phases : [];
  const risks = Array.isArray(intent?.contract?.risks) ? intent.contract.risks : [];
  const topImpact = Array.isArray(impact?.ranked) ? impact.ranked.slice(0, 5) : [];
  return [
    `## Source Issue`,
    `- ${issue.provider.toUpperCase()} ${issue.id}: ${issue.title}`,
    issue.url ? `- URL: ${issue.url}` : "",
    "",
    "## Intent Contract",
    ...phases.map((phase: string) => `- ${phase}`),
    "",
    "## Risks",
    ...risks.map((risk: any) => `- ${risk.title ?? risk}`),
    "",
    "## Impact Map",
    ...topImpact.map((entry: any) => `- ${entry.path ?? entry.file ?? "unknown"} (${entry.score ?? "n/a"})`)
  ].filter(Boolean).join("\n");
}
