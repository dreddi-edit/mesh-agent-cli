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
}

export class CacheManager {
  private readonly l1BasePath: string;
  private readonly supabase: SupabaseClient | null = null;
  private readonly workspaceHash: string;

  constructor(config: AppConfig) {
    this.workspaceHash = crypto.createHash("md5").update(config.agent.workspaceRoot).digest("hex");
    
    // Check for local .mesh directory in workspace root
    const root = path.resolve(config.agent.workspaceRoot);
    this.l1BasePath = path.join(root, ".mesh", "index");

    if (config.agent.enableCloudCache && config.supabase?.url && config.supabase?.key) {
      this.supabase = createClient(config.supabase.url, config.supabase.key);
    }
  }

  private getL1Path(filePath: string, tier: string): string {
    return path.join(this.l1BasePath, filePath, `${tier}.json`);
  }

  public async getCapsule(filePath: string, tier: string, mtimeMs: number): Promise<CacheEntry | null> {
    const l1Path = this.getL1Path(filePath, tier);

    // 1. Try L1 Cache
    try {
      const raw = await fs.readFile(l1Path, "utf-8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.mtimeMs === mtimeMs) {
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
          .select("content, mtime")
          .eq("workspace_hash", this.workspaceHash)
          .eq("file_path", filePath)
          .eq("tier", tier)
          .maybeSingle();

        if (data && !error && Number(data.mtime) === mtimeMs) {
          const entry: CacheEntry = {
            content: data.content,
            capsuleTier: tier,
            mtimeMs
          };
          // Hydrate L1 from L2
          await this.writeL1(filePath, tier, entry);
          return entry;
        }
      } catch {
        // Supabase query failed, silently fallback
      }
    }

    return null;
  }

  public async setCapsule(filePath: string, tier: string, content: string, mtimeMs: number): Promise<void> {
    const entry: CacheEntry = { content, capsuleTier: tier, mtimeMs };

    // Write to L1
    await this.writeL1(filePath, tier, entry);

    // Write to L2
    if (this.supabase) {
      try {
        await this.supabase
          .from("capsules")
          .delete()
          .eq("workspace_hash", this.workspaceHash)
          .eq("file_path", filePath)
          .eq("tier", tier);
          
        await this.supabase
          .from("capsules")
          .insert({
            workspace_hash: this.workspaceHash,
            file_path: filePath,
            tier,
            content,
            mtime: mtimeMs
          });
      } catch {
        // Silently fail on L2 writes
      }
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
}
