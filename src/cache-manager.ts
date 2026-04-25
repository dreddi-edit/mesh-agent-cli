import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { AppConfig } from "./config.js";

export interface CacheEntry {
  content: string;
  capsuleTier: string;
  mtimeMs: number;
  contentHash: string;
}

export interface RagCacheEntry {
  queryVector: number[];
  results: any[];
}

export interface CapsuleBatchRequest {
  filePath: string;
  tier: string;
  mtimeMs: number;
  contentHash?: string;
}

export class CacheManager {
  private readonly l1BasePath: string;
  private readonly supabase: SupabaseClient | null = null;
  private readonly workspaceHash: string;
  private readonly pendingL2Writes = new Map<string, {
    workspace_hash: string;
    file_path: string;
    tier: string;
    content: string;
    mtime: number;
    content_hash: string;
  }>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig) {
    this.workspaceHash = crypto.createHash("md5").update(config.agent.workspaceRoot).digest("hex");
    this.l1BasePath = path.join(os.tmpdir(), "mesh-agent-cache", this.workspaceHash);

    if (config.agent.enableCloudCache && config.supabase?.url && config.supabase?.key) {
      this.supabase = createClient(config.supabase.url, config.supabase.key);
    }
  }

  private getL1Path(filePath: string, tier: string): string {
    return path.join(this.l1BasePath, filePath, `${tier}.json`);
  }

  public async getCapsule(filePath: string, tier: string, mtimeMs: number, contentHash?: string): Promise<CacheEntry | null> {
    const l1Path = this.getL1Path(filePath, tier);

    // 1. Try L1 Cache
    try {
      const raw = await fs.readFile(l1Path, "utf-8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (contentHash && entry.contentHash === contentHash) {
        return entry; // Hash matches exactly, valid regardless of mtime
      }
      if (!contentHash && entry.mtimeMs === mtimeMs) {
        return entry;
      }
    } catch {
      // Not in L1 or invalid
    }

    // 2. Try L2 Cache
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from("capsules")
          .select("content, mtime, content_hash")
          .eq("workspace_hash", this.workspaceHash)
          .eq("file_path", filePath)
          .eq("tier", tier)
          .maybeSingle();

        if (data && !error) {
          const l2HashMatch = contentHash && data.content_hash === contentHash;
          const l2MtimeMatch = !contentHash && Number(data.mtime) === mtimeMs;

          if (l2HashMatch || l2MtimeMatch) {
            const entry: CacheEntry = {
              content: data.content,
              capsuleTier: tier,
              mtimeMs,
              contentHash: data.content_hash || contentHash || ""
            };
            // Hydrate L1 from L2
            await this.writeL1(filePath, tier, entry);
            return entry;
          }
        }

        if (contentHash) {
          const { data: sharedData, error: sharedError } = await this.supabase
            .from("capsules")
            .select("content, mtime, content_hash")
            .eq("content_hash", contentHash)
            .eq("tier", tier)
            .limit(1)
            .maybeSingle();

          if (sharedData && !sharedError) {
            const entry: CacheEntry = {
              content: sharedData.content,
              capsuleTier: tier,
              mtimeMs,
              contentHash
            };
            await this.writeL1(filePath, tier, entry);
            return entry;
          }
        }
      } catch {
        // Supabase query failed, silently fallback
      }
    }

    return null;
  }

  public async setCapsule(filePath: string, tier: string, content: string, mtimeMs: number, contentHash?: string): Promise<void> {
    const entry: CacheEntry = { content, capsuleTier: tier, mtimeMs, contentHash: contentHash || "" };

    // Write to L1
    await this.writeL1(filePath, tier, entry);

    // Write to L2
    if (this.supabase) {
      this.queueL2Write({
        workspace_hash: this.workspaceHash,
        file_path: filePath,
        tier,
        content,
        mtime: mtimeMs,
        content_hash: contentHash || ""
      });
    }
  }

  public async getCapsuleBatch(entries: CapsuleBatchRequest[]): Promise<Map<string, CacheEntry>> {
    const results = new Map<string, CacheEntry>();
    const misses: CapsuleBatchRequest[] = [];

    for (const entry of entries) {
      const key = this.batchKey(entry.filePath, entry.tier);
      const l1Path = this.getL1Path(entry.filePath, entry.tier);
      try {
        const raw = await fs.readFile(l1Path, "utf-8");
        const cached = JSON.parse(raw) as CacheEntry;
        const hashMatch = entry.contentHash && cached.contentHash === entry.contentHash;
        const mtimeMatch = !entry.contentHash && cached.mtimeMs === entry.mtimeMs;
        if (hashMatch || mtimeMatch) {
          results.set(key, cached);
          continue;
        }
      } catch {
        // Not in L1 or invalid
      }
      misses.push(entry);
    }

    if (!this.supabase || misses.length === 0) {
      return results;
    }

    for (let i = 0; i < misses.length; i += 100) {
      const batch = misses.slice(i, i + 100);
      const paths = Array.from(new Set(batch.map((entry) => entry.filePath)));
      const tiers = Array.from(new Set(batch.map((entry) => entry.tier)));
      try {
        const { data, error } = await this.supabase
          .from("capsules")
          .select("file_path, tier, content, mtime, content_hash")
          .eq("workspace_hash", this.workspaceHash)
          .in("file_path", paths)
          .in("tier", tiers);

        if (error || !Array.isArray(data)) {
          continue;
        }

        const wanted = new Map(batch.map((entry) => [this.batchKey(entry.filePath, entry.tier), entry]));
        for (const row of data) {
          const key = this.batchKey(row.file_path, row.tier);
          const request = wanted.get(key);
          if (!request) continue;
          const hashMatch = request.contentHash && row.content_hash === request.contentHash;
          const mtimeMatch = !request.contentHash && Number(row.mtime) === request.mtimeMs;
          if (!hashMatch && !mtimeMatch) continue;

          const cacheEntry: CacheEntry = {
            content: row.content,
            capsuleTier: row.tier,
            mtimeMs: request.mtimeMs,
            contentHash: row.content_hash || request.contentHash || ""
          };
          results.set(key, cacheEntry);
          await this.writeL1(request.filePath, request.tier, cacheEntry);
        }
      } catch {
        // Supabase query failed, silently fallback
      }
    }

    return results;
  }

  public async flushCache(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.supabase || this.pendingL2Writes.size === 0) {
      return;
    }
    const rows = Array.from(this.pendingL2Writes.values());
    this.pendingL2Writes.clear();
    try {
      await this.supabase
        .from("capsules")
        .upsert(rows, { onConflict: "workspace_hash,file_path,tier" });
    } catch {
      // Silently fail on L2 writes
    }
  }

  public async deleteCapsule(filePath: string, tier: string): Promise<void> {
    // 1. Remove from L1
    const l1Path = this.getL1Path(filePath, tier);
    try {
      await fs.unlink(l1Path);
    } catch {
      // Ignore if not exists
    }

    // 2. Remove from L2
    if (this.supabase) {
      try {
        await this.supabase
          .from("capsules")
          .delete()
          .eq("workspace_hash", this.workspaceHash)
          .eq("file_path", filePath)
          .eq("tier", tier);
      } catch {
        // Silently fail on L2 deletes
      }
    }
  }

  public async getSyncStatus(): Promise<{ l2Count: number; l2Enabled: boolean }> {
    if (!this.supabase) return { l2Count: 0, l2Enabled: false };
    try {
      const { count, error } = await this.supabase
        .from("capsules")
        .select("*", { count: "exact", head: true })
        .eq("workspace_hash", this.workspaceHash);
      return { l2Count: count || 0, l2Enabled: true };
    } catch {
      return { l2Count: 0, l2Enabled: true };
    }
  }

  private async writeL1(filePath: string, tier: string, entry: CacheEntry): Promise<void> {
    try {
      const l1Path = this.getL1Path(filePath, tier);
      await fs.mkdir(path.dirname(l1Path), { recursive: true });
      await fs.writeFile(l1Path, JSON.stringify(entry), "utf-8");
    } catch {
      // Ignore L1 write errors
    }
  }

  private queueL2Write(row: {
    workspace_hash: string;
    file_path: string;
    tier: string;
    content: string;
    mtime: number;
    content_hash: string;
  }): void {
    this.pendingL2Writes.set(this.batchKey(row.file_path, row.tier), row);
    if (this.pendingL2Writes.size >= 50) {
      void this.flushCache();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flushCache();
      }, 500);
      this.flushTimer.unref?.();
    }
  }

  private batchKey(filePath: string, tier: string): string {
    return `${filePath}\u0000${tier}`;
  }

  public async getSimilarRagQuery(queryVector: number[], threshold: number = 0.95): Promise<any[] | null> {
    const l1Path = path.join(this.l1BasePath, 'rag_queries.json');
    try {
      const raw = await fs.readFile(l1Path, "utf-8");
      const entries: RagCacheEntry[] = JSON.parse(raw);
      for (const entry of entries) {
        if (this.cosine(queryVector, entry.queryVector) >= threshold) {
          return entry.results;
        }
      }
    } catch {
      // no cache
    }
    return null;
  }

  public async setRagQuery(queryVector: number[], results: any[]): Promise<void> {
    const l1Path = path.join(this.l1BasePath, 'rag_queries.json');
    let entries: RagCacheEntry[] = [];
    try {
      const raw = await fs.readFile(l1Path, "utf-8");
      entries = JSON.parse(raw);
    } catch { }
    entries.push({ queryVector, results });
    if (entries.length > 50) entries.shift(); // keep last 50 queries
    await fs.mkdir(path.dirname(l1Path), { recursive: true });
    await fs.writeFile(l1Path, JSON.stringify(entries), "utf-8");
  }

  private cosine(left: number[], right: number[]): number {
    if (!left || !right || left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
    let dot = 0;
    for (let i = 0; i < left.length; i++) {
      dot += left[i] * right[i];
    }
    return dot;
  }
}
