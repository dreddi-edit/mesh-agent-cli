/**
 * RuntimeObserver - Runtime debugging and telemetry engine
 * Captures process execution, crashes, and performance metrics
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  RuntimeStartInput,
  RuntimeCaptureInput,
  RuntimeTraceInput,
  RuntimeTraceResult,
  RuntimeCrashInfo,
  RuntimeMetrics
} from "./types.js";

export interface RuntimeObserverConfig {
  workspaceRoot: string;
  maxCrashDumps?: number;
  tracingEnabled?: boolean;
  metricsInterval?: number; // ms
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

export class RuntimeObserver extends EventEmitter {
  private config: RuntimeObserverConfig;
  private processes: Map<number, ProcessHandle> = new Map();
  private activeProcesses: Map<number, ChildProcessWithoutNullStreams> = new Map();

  constructor(config: RuntimeObserverConfig) {
    super();
    this.config = {
      maxCrashDumps: 10,
      tracingEnabled: true,
      metricsInterval: 1000,
      ...config
    };
  }

  /**
   * Start a command with telemetry
   */
  async start(input: RuntimeStartInput): Promise<ProcessHandle> {
    const { command, args = [], cwd = this.config.workspaceRoot, timeout = 30000 } = input;

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const handle: ProcessHandle = {
        pid: child.pid || 0,
        command: [command, ...args].join(" "),
        startedAt: new Date(),
        stdout: "",
        stderr: "",
        crashed: false
      };

      if (handle.pid > 0) {
        this.activeProcesses.set(handle.pid, child);
        this.processes.set(handle.pid, handle);
      }

      let timedOut = false;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (handle.pid > 0) {
          this.activeProcesses.delete(handle.pid);
        }
        callback();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);

      child.stdout.on("data", (data) => {
        const chunk = data.toString();
        handle.stdout += chunk;
        this.emit("stdout", { pid: handle.pid, data: chunk });
      });

      child.stderr.on("data", (data) => {
        const chunk = data.toString();
        handle.stderr += chunk;
        this.emit("stderr", { pid: handle.pid, data: chunk });
      });

      child.on("exit", (code, signal) => {
        finish(() => {
          handle.endedAt = new Date();
          handle.exitCode = code ?? undefined;

          if (timedOut) {
            handle.stderr = `${handle.stderr}\nCommand timed out after ${timeout}ms`;
          }

          if (code !== 0 || signal || timedOut) {
            handle.crashed = true;
            handle.crashInfo = {
              signal: signal ?? (timedOut ? "SIGTERM" : undefined),
              exitCode: code ?? (timedOut ? 124 : -1),
              stderr: handle.stderr,
              stdout: handle.stdout,
              duration: (handle.endedAt.getTime() - handle.startedAt.getTime()) / 1000
            };
            this.emit("crash", { pid: handle.pid, crashInfo: handle.crashInfo });
          }

          resolve(handle);
        });
      });

      child.on("error", (err) => {
        finish(() => {
          handle.crashed = true;
          handle.endedAt = new Date();
          handle.crashInfo = {
            signal: undefined,
            exitCode: -1,
            stderr: err.message,
            stdout: handle.stdout,
            duration: (handle.endedAt.getTime() - handle.startedAt.getTime()) / 1000
          };
          reject(err);
        });
      });
    });
  }

  /**
   * Capture details from crashed process
   */
  async captureFailure(input: RuntimeCaptureInput): Promise<RuntimeCrashInfo> {
    const { pid } = input;
    const handle = this.processes.get(pid);

    if (!handle) {
      throw new Error(`Process ${pid} not found`);
    }

    if (!handle.crashed) {
      throw new Error(`Process ${pid} did not crash`);
    }

    return handle.crashInfo || {
      signal: undefined,
      exitCode: handle.exitCode || -1,
      stderr: handle.stderr,
      stdout: handle.stdout,
      duration: handle.endedAt ? (handle.endedAt.getTime() - handle.startedAt.getTime()) / 1000 : 0
    };
  }

  /**
   * Get process metrics (memory, CPU approximation)
   */
  async getMetrics(pid: number): Promise<RuntimeMetrics> {
    const handle = this.processes.get(pid);
    if (!handle) {
      throw new Error(`Process ${pid} not found`);
    }

    const duration = (handle.endedAt || new Date()).getTime() - handle.startedAt.getTime();
    const outputSize = (handle.stdout.length + handle.stderr.length) / 1024; // KB

    return {
      pid,
      durationMs: duration,
      outputSizeKb: outputSize,
      lineCount: handle.stdout.split('\n').length + handle.stderr.split('\n').length,
      crashed: handle.crashed
    };
  }

  /**
   * List all captured processes
   */
  listProcesses(): ProcessHandle[] {
    return Array.from(this.processes.values());
  }

  /**
   * Kill active process
   */
  killProcess(pid: number): void {
    const child = this.activeProcesses.get(pid);
    if (child) {
      child.kill("SIGKILL");
      this.activeProcesses.delete(pid);
    }
  }

  /**
   * Clear all records
   */
  clear(): void {
    this.processes.clear();
    this.activeProcesses.forEach((child) => child.kill("SIGKILL"));
    this.activeProcesses.clear();
  }
}
