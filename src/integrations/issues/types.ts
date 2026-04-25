export type IssueProvider = "github" | "linear" | "jira";

export interface IssueRecord {
  provider: IssueProvider;
  id: string;
  title: string;
  body: string;
  labels: string[];
  assignedTo?: string;
  url?: string;
}

export interface IssueProviderConfig {
  provider: IssueProvider;
  enabled: boolean;
  tokenKeychainService?: string;
  project?: string;
}

export interface IssuePipelineResult {
  ok: boolean;
  provider: IssueProvider;
  issueId: string;
  title: string;
  prTitle: string;
  prBody: string;
  timelineHints: string[];
}
