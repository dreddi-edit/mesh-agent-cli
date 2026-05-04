/**
 * RuntimeObserver - Runtime debugging and telemetry engine
 * Captures process execution, crashes, and performance metrics
 */
import { EventEmitter } from "node:events";
import type { RuntimeStartInput, RuntimeCaptureInput, RuntimeTraceInput, RuntimeTraceResult, RuntimeCrashInfo, RuntimeMetrics } from "./types.js";
export interface RuntimeObserverConfig {
    workspaceRoot: string;
    maxCrashDumps?: number;
    tracingEnabled?: boolean;
    metricsInterval?: number;
}
export interface ProcessHandle {
    pid: number;
    command: string;
    startedAt: Date;
    endedAt?: Date;
    exitCode?: number;
    stdout: string;
    stderr: string;
    crashed: boolean;
    crashInfo?: RuntimeCrashInfo;
    metrics?: RuntimeMetrics;
}
export declare class RuntimeObserver extends EventEmitter {
    private config;
    private processes;
    private activeProcesses;
    constructor(config: RuntimeObserverConfig);
    /**
     * Start a command with telemetry
     */
    start(input: RuntimeStartInput): Promise<ProcessHandle>;
    /**
     * Capture details from crashed process
     */
    captureFailure(input: RuntimeCaptureInput): Promise<RuntimeCrashInfo>;
    /**
     * Get process metrics (memory, CPU approximation)
     */
    getMetrics(pid: number): Promise<RuntimeMetrics>;
    /**
     * List all captured processes
     */
    listProcesses(): ProcessHandle[];
    /**
     * Kill active process
     */
    killProcess(pid: number): void;
    /**
     * Clear all records
     */
    clear(): void;
}
export type { RuntimeTraceInput, RuntimeTraceResult };
