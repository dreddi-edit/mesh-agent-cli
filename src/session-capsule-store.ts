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
      const parsed = JSON.parse(raw) as Partial<SessionStateShape>;

      const capsule = parsed?.capsule;
      if (!capsule) {
        return null;
      }

      // Data Contract Validation (data-quality-frameworks)
      const isValidContract =
        typeof capsule.summary === "string" &&
        capsule.summary.length > 0 &&
        typeof capsule.generatedAt === "string" &&
        typeof capsule.sourceMessages === "number" &&
        typeof capsule.retainedMessages === "number" &&
        !isNaN(capsule.sourceMessages) &&
        !isNaN(capsule.retainedMessages);

      if (!isValidContract) {
        console.warn(`[Mesh:DataQuality] Corrupt session state detected at ${this.statePath}. Discarding invalid capsule.`);
        return null;
      }

      return capsule as PersistedSessionCapsule;
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
