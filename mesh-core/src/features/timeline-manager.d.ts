/**
 * Shared Timeline Manager - Wave 1 Feature
 * Git worktree-based isolated execution for safe testing
 *
 * Used by: CLI, IDE (REST API), MCP (tools)
 */
import type { TimelineCreateInput, TimelineInfo, TimelinePatchInput, TimelineRunInput, TimelineRunResult, TimelineCompareResult } from "./types.js";
export interface TimelineManagerOptions {
    workspaceRoot: string;
    timelinesDir?: string;
    gitExecutable?: string;
}
export declare class TimelineManager {
    private workspaceRoot;
    private timelinesDir;
    private gitExecutable;
    private timelines;
    constructor(options: TimelineManagerOptions);
    /**
     * Create a new timeline (isolated git worktree)
     */
    createTimeline(input: TimelineCreateInput): Promise<TimelineInfo>;
    /**
     * Apply patches to a timeline
     */
    applyPatches(input: TimelinePatchInput): Promise<void>;
    /**
     * Run a command in a timeline
     */
    runInTimeline(input: TimelineRunInput): Promise<TimelineRunResult>;
    /**
     * Compare timeline against base branch
     */
    compareTimeline(timelineId: string): Promise<TimelineCompareResult>;
    /**
     * Promote timeline changes back to base branch
     */
    promoteTimeline(timelineId: string): Promise<void>;
    /**
     * Clean up a timeline
     */
    abandonTimeline(timelineId: string): Promise<void>;
    /**
     * List all active timelines
     */
    listTimelines(): Promise<TimelineInfo[]>;
    private runGit;
    private saveMetadata;
    private loadMetadata;
    private metadataToInfo;
}
