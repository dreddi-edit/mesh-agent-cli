import { IssueProviderConfig, IssueRecord } from "./types.js";

export async function fetchGithubIssues(
  config: IssueProviderConfig,
  fallback: IssueRecord[]
): Promise<IssueRecord[]> {
  if (!config.enabled) return [];
  const repo = config.project?.trim();
  if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) {
    const token = process.env.MESH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const labels = encodeURIComponent(config.labels?.join(",") || "mesh");
      const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&labels=${labels}&per_page=50`, {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        signal: controller.signal
      });
      if (response.ok) {
        const payload = await response.json() as any[];
        return payload
          .filter((item) => !item.pull_request)
          .map((item) => ({
            provider: "github",
            id: String(item.number),
            title: String(item.title ?? `GitHub issue #${item.number}`),
            body: String(item.body ?? ""),
            labels: Array.isArray(item.labels) ? item.labels.map((label: any) => String(label.name ?? label)) : [],
            assignedTo: Array.isArray(item.assignees) && item.assignees[0]?.login ? String(item.assignees[0].login) : undefined,
            url: String(item.html_url ?? `https://github.com/${repo}/issues/${item.number}`)
          }));
      }
    } catch {
      // Fall back to the local snapshot below.
    } finally {
      clearTimeout(timer);
    }
  }
  return fallback.filter((issue) => issue.provider === "github");
}
