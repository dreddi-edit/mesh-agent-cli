/**
 * Shared Wave 1 & Wave 2 Feature Types
 * Used by CLI, IDE, and MCP
 */

export type RAGMode =
  | "architecture"
  | "bug"
  | "edit-impact"
  | "test-impact"
  | "ownership"
  | "recent-change"
  | "runtime-path";

export interface RAGQuery {
  query: string;
  mode?: RAGMode;
  limit?: number;
  includeRationale?: boolean;
}

export interface RAGMatch {
  path: string;
  lineStart: number;
  lineEnd: number;
  preview: string;
  confidence: number;
  rationale?: string;
  matchType: "symbol" | "text" | "semantic";
}

export interface RAGResult {
  query: string;
  mode: RAGMode;
  matches: RAGMatch[];
  totalMatches: number;
  executionTimeMs: number;
}

export interface ImpactAnalysisQuery {
  symbols: string[];
  files?: string[];
  depth?: number;
}

export interface ImpactItem {
  path: string;
  symbol?: string;
  type: "definition" | "usage" | "test" | "dependent";
  severity: "critical" | "high" | "medium" | "low";
  reason: string;
}

export interface ImpactAnalysisResult {
  symbols: string[];
  impacts: ImpactItem[];
  affectedFiles: Set<string>;
  riskLevel: "safe" | "caution" | "danger";
  executionTimeMs: number;
}

export interface TimelineCreateInput {
  name: string;
  baseBranch?: string;
  description?: string;
}

export interface TimelineInfo {
  id: string;
  name: string;
  baseBranch: string;
  createdAt: Date;
  workTreePath: string;
  status: "active" | "merged" | "abandoned";
}

export interface TimelinePatchInput {
  timelineId: string;
  patches: Array<{
    path: string;
    operation: "create" | "update" | "delete";
    content?: string;
  }>;
}

export interface TimelineRunInput {
  timelineId: string;
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface TimelineRunResult {
  timelineId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface TimelineCompareResult {
  timelineId: string;
  baseBranch: string;
  diffSummary: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  fileChanges: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    additions: number;
    deletions: number;
  }>;
}

export interface FeatureError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface WorkspaceIndexHealth {
  indexed: boolean;
  totalFiles: number;
  indexedFiles: number;
  lastIndexedAt: Date | null;
  staleFiles: number;
  estimatedSizeKb: number;
}

// ═════════════════════════════════════════════════════════════
// Wave 2 Types: Runtime Debugging, Capsules, Basic Tools
// ═════════════════════════════════════════════════════════════

export type CapsuleTier = "low" | "medium" | "high";

export interface CapsuleMetadata {
  filePath: string;
  tier: CapsuleTier;
  createdAt: Date;
  contentHash: string;
  originalSize: number;
  compressedSize: number;
}

export interface CapsuleContent {
  tier: CapsuleTier;
  content: string;
  tokenCount: number;
  metadata: CapsuleMetadata;
}

export interface RuntimeStartInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
}

export interface RuntimeCrashInfo {
  signal?: string;
  exitCode: number;
  stderr: string;
  stdout: string;
  duration: number;
}

export interface RuntimeMetrics {
  pid: number;
  durationMs: number;
  outputSizeKb: number;
  lineCount: number;
  crashed: boolean;
}

export interface RuntimeCaptureInput {
  pid: number;
}

export interface RuntimeTraceInput {
  pid: number;
  traceType?: "cpu" | "memory" | "io";
}

export interface RuntimeTraceResult {
  pid: number;
  traceType: string;
  events: Array<{
    timestamp: number;
    type: string;
    data: Record<string, any>;
  }>;
}

// Workspace Tools (Tier 1)

export interface DirectoryListing {
  directories: string[];
  files: Array<{
    path: string;
    size: number;
    modified: Date;
  }>;
}

export interface FileInfo {
  path: string;
  size: number;
  modified: Date;
  isDirectory: boolean;
  permissions?: string;
}

export interface GitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitDiff {
  base: string;
  head: string;
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  diffText: string;
  fileStats: Record<string, { additions: number; deletions: number }>;
}

export interface WorkspaceToolsConfig {
  workspaceRoot: string;
}
