import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  workspace: string;
  data?: Record<string, unknown>;
}

export class StructuredLogger {
  private readonly logPath: string;

  constructor(private readonly workspaceRoot: string) {
    const stateRoot = process.env.MESH_STATE_DIR || path.join(os.homedir(), ".config", "mesh");
    const date = new Date().toISOString().slice(0, 10);
    this.logPath = path.join(stateRoot, "logs", `${date}.jsonl`);
  }

  async write(level: LogLevel, event: string, data?: Record<string, unknown>): Promise<void> {
    const entry: StructuredLogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      workspace: this.workspaceRoot,
      data: data ? redactSecrets(data) : undefined
    };
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
  }
}

function redactSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|authorization/i.test(key)) {
      result[key] = "[redacted]";
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      result[key] = redactSecrets(item as Record<string, unknown>);
    } else {
      result[key] = item;
    }
  }
  return result;
}
