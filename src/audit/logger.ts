import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface AuditEntry {
  ts: string;
  user: string;
  model: string;
  tool: string;
  inputHash: string;
  outputHash: string;
  parentHash: string;
  hash: string;
  signature: string;
}

export class AuditLogger {
  private previousHash = "genesis";
  private readonly key: Buffer;

  constructor(private readonly workspaceRoot: string, userHint?: string) {
    const seed = `${userHint || process.env.USER || "mesh-user"}:${this.workspaceRoot}`;
    this.key = crypto.createHash("sha256").update(seed).digest();
  }

  async append(tool: string, input: unknown, output: unknown): Promise<AuditEntry> {
    const ts = new Date().toISOString();
    const user = process.env.USER || "mesh-user";
    const model = process.env.BEDROCK_MODEL_ID || "unknown-model";
    const inputHash = sha256(stableJson(input));
    const outputHash = sha256(stableJson(output));
    const parentHash = this.previousHash;
    const hash = sha256([ts, user, model, tool, inputHash, outputHash, parentHash].join("|"));
    const signature = hmac(this.key, hash);
    const entry: AuditEntry = { ts, user, model, tool, inputHash, outputHash, parentHash, hash, signature };
    this.previousHash = hash;
    const file = this.dayFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  async replay(limit = 200): Promise<AuditEntry[]> {
    const entries = await this.readAllEntries();
    return entries.slice(-limit);
  }

  async verify(): Promise<{ ok: boolean; total: number; invalid: number }> {
    const entries = await this.readAllEntries();
    let parent = "genesis";
    let invalid = 0;
    for (const entry of entries) {
      const hash = sha256([entry.ts, entry.user, entry.model, entry.tool, entry.inputHash, entry.outputHash, parent].join("|"));
      const signature = hmac(this.key, hash);
      if (hash !== entry.hash || signature !== entry.signature) {
        invalid += 1;
      }
      parent = entry.hash;
    }
    return { ok: invalid === 0, total: entries.length, invalid };
  }

  private dayFile(): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(this.workspaceRoot, ".mesh", "audit", `${date}.jsonl`);
  }

  private async readAllEntries(): Promise<AuditEntry[]> {
    const dir = path.join(this.workspaceRoot, ".mesh", "audit");
    const files = await fs.readdir(dir).catch(() => []);
    const rows: AuditEntry[] = [];
    for (const file of files.filter((item) => item.endsWith(".jsonl")).sort()) {
      const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
      for (const line of raw.split(/\r?\n/g).filter(Boolean)) {
        try {
          rows.push(JSON.parse(line) as AuditEntry);
        } catch {
          // ignore malformed lines
        }
      }
    }
    return rows;
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, Object.keys((value as any) ?? {}).sort());
  } catch {
    return String(value);
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}
