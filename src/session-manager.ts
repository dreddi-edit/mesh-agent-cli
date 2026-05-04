import { promises as fs } from "node:fs";
import { existsSync, statSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface SerializedTurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallEntry[];
  timestamp: string;
}

export interface ToolCallEntry {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SessionManager {
  start(): void;
  stop(): Promise<void>;
  addMessage(role: "user" | "assistant", content: string, toolCalls?: ToolCallEntry[]): void;
  getTranscript(): SerializedTurn[];
  hasInterruptedSession(): boolean;
  getInterruptedSession(): SerializedTurn[] | null;
  clearInterruptedSession(): void;
}

const SESSION_DIR = ".mesh/sessions";
const INTERRUPTED_FILE = "interrupted.jsonl";
const AUTO_SAVE_INTERVAL_MS = 30_000;

export class DefaultSessionManager implements SessionManager {
  private readonly sessionPath: string;
  private turns: SerializedTurn[] = [];
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private dirty = false;
  private flushInProgress = false;

  constructor(private readonly workspaceRoot: string) {
    this.sessionPath = path.join(workspaceRoot, SESSION_DIR, INTERRUPTED_FILE);
  }

  start(): void {
    if (this.autoSaveTimer) return;
    const loop = async () => {
      await this.autoSave();
      if (this.stopped) return;
      this.autoSaveTimer = setTimeout(() => {
        void loop();
      }, AUTO_SAVE_INTERVAL_MS);
      this.autoSaveTimer.unref?.();
    };
    this.autoSaveTimer = setTimeout(() => {
      void loop();
    }, AUTO_SAVE_INTERVAL_MS);
    this.autoSaveTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    if (this.dirty) {
      await this.flush();
    }
    // Clear interrupted session on clean exit
    await this.clearInterruptedSession();
  }

  addMessage(role: "user" | "assistant", content: string, toolCalls?: ToolCallEntry[]): void {
    if (this.stopped) return;
    this.turns.push({
      role,
      content,
      toolCalls,
      timestamp: new Date().toISOString()
    });
    this.dirty = true;
  }

  getTranscript(): SerializedTurn[] {
    return [...this.turns];
  }

  hasInterruptedSession(): boolean {
    try {
      const stat = statSync(this.sessionPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  getInterruptedSession(): SerializedTurn[] | null {
    if (!this.hasInterruptedSession()) return null;
    try {
      const raw = readFileSync(this.sessionPath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const turns: SerializedTurn[] = [];
      for (const line of lines) {
        try {
          turns.push(JSON.parse(line) as SerializedTurn);
        } catch {
          // skip malformed lines
        }
      }
      return turns.length > 0 ? turns : null;
    } catch {
      return null;
    }
  }

  clearInterruptedSession(): void {
    try {
      unlinkSync(this.sessionPath);
    } catch {
      // already absent
    }
  }

  private async autoSave(): Promise<void> {
    if (!this.dirty || this.flushInProgress) return;
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.turns.length === 0) return;
    this.flushInProgress = true;
    try {
      await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
      const lines = this.turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
      await fs.writeFile(this.sessionPath, lines, "utf8");
      this.dirty = false;
    } catch (err) {
      // Log but don't crash — session persistence is best-effort
      console.error("[SessionManager] Failed to persist session:", err);
    } finally {
      this.flushInProgress = false;
    }
  }
}

export class NoopSessionManager implements SessionManager {
  start(): void {}
  stop(): Promise<void> { return Promise.resolve(); }
  addMessage(): void {}
  getTranscript(): SerializedTurn[] { return []; }
  hasInterruptedSession(): boolean { return false; }
  getInterruptedSession(): SerializedTurn[] | null { return null; }
  clearInterruptedSession(): void {}
}

export function buildSessionManager(workspaceRoot: string): SessionManager {
  return new DefaultSessionManager(workspaceRoot);
}
