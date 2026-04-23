import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PersistedSessionCapsule {
  summary: string;
  generatedAt: string;
  sourceMessages: number;
  retainedMessages: number;
}

interface SessionStateShape {
  workspaceRoot: string;
  updatedAt: string;
  capsule: PersistedSessionCapsule | null;
}

const STATE_DIR = path.join(os.homedir(), ".config", "mesh", "sessions");

export class SessionCapsuleStore {
  private readonly statePath: string;

  constructor(private readonly workspaceRoot: string) {
    const workspaceHash = crypto.createHash("sha1").update(workspaceRoot).digest("hex");
    this.statePath = path.join(STATE_DIR, `${workspaceHash}.json`);
  }

  async load(): Promise<PersistedSessionCapsule | null> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as SessionStateShape;
      if (!parsed?.capsule?.summary) {
        return null;
      }
      return parsed.capsule;
    } catch {
      return null;
    }
  }

  async save(capsule: PersistedSessionCapsule | null): Promise<void> {
    const payload: SessionStateShape = {
      workspaceRoot: this.workspaceRoot,
      updatedAt: new Date().toISOString(),
      capsule
    };
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(payload, null, 2), "utf8");
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.statePath);
    } catch {
      // Already absent.
    }
  }
}
