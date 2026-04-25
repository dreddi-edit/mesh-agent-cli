import { IssueProviderConfig, IssueRecord } from "./types.js";

export async function fetchJiraIssues(
  config: IssueProviderConfig,
  fallback: IssueRecord[]
): Promise<IssueRecord[]> {
  if (!config.enabled) return [];
  return fallback.filter((issue) => issue.provider === "jira");
}
