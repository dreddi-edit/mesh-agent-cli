export type HealthStatus = "healthy" | "watch" | "attention";
export type FileGroup = "source" | "tests" | "docs" | "config" | "other";
export type DashboardActionName = "repair" | "causal" | "lab" | "twin" | "ghost_learn";

export interface DashboardAction {
  label: string;
  detail: string;
  action: DashboardActionName;
}

export interface ActionRecord {
  id?: string;
  action?: DashboardActionName;
  status?: "pending" | "running" | "done" | "error" | "stale";
  createdAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
}

export interface DashboardEvent {
  id?: string;
  type?: string;
  msg?: string;
  path?: string;
  at?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  group: FileGroup;
  dependencies: number;
  dependents: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
}

export interface GraphDetails {
  dependencies: string[];
  dependents: string[];
  externalImports: string[];
}

export interface DependencyGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  details: Record<string, GraphDetails>;
  externalPackages: Array<{ name: string; count: number }>;
}

export interface HotFile {
  file: string;
  risks: string[];
  score: number | null;
}

export interface DashboardState {
  workspaceRoot: string;
  summary: {
    workspace: string;
    fileCount: number;
    sourceCount: number;
    testCount: number;
    docsCount: number;
    configCount: number;
    repairs: number;
    riskHotspots: number;
    rules: number;
    insights: number;
    discoveries: number;
    forks: number;
    ghostConfidence: number | null;
  };
  health: {
    score: number;
    status: HealthStatus;
  };
  actions: DashboardAction[];
  groupedFiles: Record<FileGroup, string[]>;
  dependencyGraph: DependencyGraph;
  hotFiles: HotFile[];
  repairQueue: Array<Record<string, unknown>>;
  discoveries: Array<Record<string, unknown>>;
  contextMetrics: {
    rawTokensSavedEstimate?: number;
    report?: Record<string, number | string>;
  } | null;
  artifacts: Array<{
    id?: string;
    toolName?: string;
    summary?: string;
  }>;
  ghost: Record<string, unknown> | null;
  memoryRules: string[];
  events: DashboardEvent[];
  actionQueue: ActionRecord[];
  liveUpdatedAt: string;
}

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "error" | "closed";

export type DashboardServerMessage =
  | { type: "auth.ok"; version: string }
  | { type: "state.snapshot"; reason?: string; state: DashboardState }
  | { type: "event.append"; event: DashboardEvent }
  | { type: "action.update"; request?: ActionRecord; result?: unknown }
  | { type: "error"; error: string }
  | { type: "pong"; at: string };
