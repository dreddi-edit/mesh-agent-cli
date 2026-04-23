import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import { MeshCoreAdapter } from "./mesh-core-adapter.js";
import { CacheManager } from "./cache-manager.js";
import { ToolBackend, ToolDefinition } from "./tool-backend.js";
import { AppConfig } from "./config.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function ensureInsideRoot(root: string, requestedPath: string | undefined): string {
  const candidate = path.resolve(root, requestedPath ?? ".");
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${requestedPath ?? "."}`);
  }
  return candidate;
}

async function collectFiles(start: string, limit: number): Promise<string[]> {
  const queue = [start];
  const files: string[] = [];

  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift();
    if (!current) break;

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;

      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(nextPath);
      } else if (entry.isFile()) {
        files.push(nextPath);
      }
    }
  }

  return files;
}

export class LocalToolBackend implements ToolBackend {
  private readonly meshCore = new MeshCoreAdapter();
  private readonly cache: CacheManager;

  constructor(private readonly workspaceRoot: string, config?: AppConfig) {
    this.cache = new CacheManager(config ?? { agent: { workspaceRoot, maxSteps: 8, mode: "local" }, bedrock: { endpointBase: "", modelId: "", temperature: 0, maxTokens: 0 }, mcp: { args: [] }, supabase: {} });
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "workspace.list_files",
        description: "List files in the local workspace.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            limit: { type: "number" }
          }
        }
      },
      {
        name: "workspace.read_file",
        description: "Read one file from local workspace and return Mesh summary.",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.search_files",
        description: "Search file paths by substring.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.grep_content",
        description: "Search file contents by substring and return matching snippets.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            path: { type: "string" }
          }
        }
      },
      {
        name: "workspace.write_file",
        description: "Write content to a file, creating or overwriting it. Automatically creates parent directories.",
        inputSchema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          }
        }
      },
      {
        name: "workspace.run_command",
        description: "Run a shell command in the workspace and return its stdout and stderr.",
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" }
          }
        }
      },
      { name: "workspace.get_index_status", description: "Get current indexing progress and cache coverage" },
      { name: "workspace.check_sync", description: "Verify cloud (L2) synchronization status" },
      { name: "workspace.index_everything", description: "Explicitly trigger full workspace indexing (generate all capsules)" }
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "workspace.list_files":
        return this.listFiles(args);
      case "workspace.read_file":
        return this.readFile(args);
      case "workspace.search_files":
        return this.searchFiles(args);
      case "workspace.check_sync":
        return this.checkSync();
      case "workspace.index_everything":
        return this.grepContent(args);
      case "workspace.write_file":
        return this.writeFile(args);
      case "workspace.run_command":
        return this.runCommand(args);
      case "workspace.get_index_status":
        return this.getIndexStatus();
      default:
        throw new Error(`Unknown local tool: ${name}`);
    }
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private async listFiles(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000));
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);

    const files = await collectFiles(base, limit);
    return {
      ok: true,
      workspaceRoot: this.workspaceRoot,
      requestedPath,
      count: files.length,
      files: files.map((item) => toPosixRelative(this.workspaceRoot, item)).sort((a, b) => a.localeCompare(b))
    };
  }

  private async readFile(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    const tier = String(args.tier ?? "medium").trim();
    if (!requestedPath) {
      throw new Error("workspace.read_file requires 'path'");
    }

    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);
    if (!(await pathExists(absolutePath))) {
      throw new Error(`File not found: ${requestedPath}`);
    }

    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${requestedPath}`);
    }

    const mtimeMs = Math.floor(stat.mtimeMs);
    const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);

    // Try cache first for the requested tier
    const cached = await this.cache.getCapsule(relativePath, tier, mtimeMs);
    if (cached) {
      return {
        ok: true,
        path: relativePath,
        bytes: stat.size,
        tier,
        capsule: cached.content,
        source: "cache"
      };
    }

    // Cache miss – read file and generate ALL tiers via mesh-core
    const raw = await fs.readFile(absolutePath, "utf8");
    const TIERS = ["low", "medium", "high"] as const;
    let requestedContent = raw.slice(0, 12000); // fallback if mesh-core unavailable

    if (this.meshCore.isAvailable) {
      const results = await this.meshCore.summarizeAllTiers(relativePath, raw);
      // Persist all tiers to L1 + L2 cache in parallel
      await Promise.all(
        TIERS.map((t) => {
          const content = results[t] ?? "";
          if (t === tier) requestedContent = content;
          return this.cache.setCapsule(relativePath, t, content, mtimeMs);
        })
      );
    } else {
      // mesh-core not available – cache the raw content for all tiers
      await Promise.all(
        TIERS.map((t) =>
          this.cache.setCapsule(relativePath, t, raw.slice(0, 12000), mtimeMs)
        )
      );
    }

    return {
      ok: true,
      path: relativePath,
      bytes: stat.size,
      tier,
      capsule: requestedContent,
      source: "generated"
    };
  }

  private async searchFiles(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) {
      throw new Error("workspace.search_files requires 'query'");
    }

    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const limit = Math.max(1, Math.min(Number(args.limit) || 100, 1000));
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);

    const files = await collectFiles(base, 4000);
    const matches = files
      .map((item) => toPosixRelative(this.workspaceRoot, item))
      .filter((item) => item.toLowerCase().includes(query))
      .slice(0, limit);

    return {
      ok: true,
      query,
      count: matches.length,
      matches
    };
  }

  private async grepContent(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      throw new Error("workspace.grep_content requires 'query'");
    }

    const requestedPath = typeof args.path === "string" ? args.path : ".";
    const limit = Math.max(1, Math.min(Number(args.limit) || 50, 300));
    const base = ensureInsideRoot(this.workspaceRoot, requestedPath);
    const files = await collectFiles(base, 1200);

    const matches: Array<{ path: string; line: number; snippet: string }> = [];
    const needle = query.toLowerCase();

    for (const filePath of files) {
      if (matches.length >= limit) break;

      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      if (content.length > 500_000) {
        continue;
      }

      const lines = content.split(/\r?\n/g);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.toLowerCase().includes(needle)) continue;

        matches.push({
          path: toPosixRelative(this.workspaceRoot, filePath),
          line: i + 1,
          snippet: line.slice(0, 220)
        });

        if (matches.length >= limit) {
          break;
        }
      }
    }

    return {
      ok: true,
      query,
      count: matches.length,
      matches
    };
  }

  private async writeFile(args: Record<string, unknown>): Promise<unknown> {
    const requestedPath = String(args.path ?? "").trim();
    if (!requestedPath) {
      throw new Error("workspace.write_file requires 'path'");
    }

    const content = typeof args.content === "string" ? args.content : String(args.content ?? "");
    const absolutePath = ensureInsideRoot(this.workspaceRoot, requestedPath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    return {
      ok: true,
      path: toPosixRelative(this.workspaceRoot, absolutePath),
      bytesWritten: Buffer.byteLength(content, "utf8")
    };
  }

  private async runCommand(args: Record<string, unknown>): Promise<unknown> {
    const command = String(args.command ?? "").trim();
    if (!command) {
      throw new Error("workspace.run_command requires 'command'");
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workspaceRoot,
        maxBuffer: 5 * 1024 * 1024
      });

      const trimOutput = (str: string) => str.length > 15000 ? str.slice(0, 15000) + "\n...[TRUNCATED]" : str;

      return {
        ok: true,
        command,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      };
    } catch (error: any) {
      const trimOutput = (str: string) => str?.length > 15000 ? str.slice(0, 15000) + "\n...[TRUNCATED]" : str;
      return {
        ok: false,
        command,
        exitCode: error.code ?? 1,
        stdout: trimOutput(error.stdout || ""),
        stderr: trimOutput(error.stderr || String(error))
      };
    }
  }

  private async checkSync(): Promise<unknown> {
    const status = await this.cache.getSyncStatus();
    return { ok: true, ...status };
  }

  private async getIndexStatus(): Promise<unknown> {
    const files = await collectFiles(this.workspaceRoot, 10000);
    let cachedCount = 0;

    for (const file of files) {
      const rel = toPosixRelative(this.workspaceRoot, file);
      const stat = await fs.stat(file);
      const exists = await this.cache.getCapsule(rel, "medium", Math.floor(stat.mtimeMs));
      if (exists) cachedCount++;
    }

    return {
      ok: true,
      totalFiles: files.length,
      cachedFiles: cachedCount,
      percent: files.length > 0 ? Math.round((cachedCount / files.length) * 100) : 100
    };
  }

  public async *indexEverything(): AsyncGenerator<{ current: number; total: number; path: string }> {
    const files = await collectFiles(this.workspaceRoot, 10000);
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const absolutePath = files[i];
      const relativePath = toPosixRelative(this.workspaceRoot, absolutePath);
      const stat = await fs.stat(absolutePath);
      const mtimeMs = Math.floor(stat.mtimeMs);

      const existing = await this.cache.getCapsule(relativePath, "medium", mtimeMs);
      if (!existing) {
        const raw = await fs.readFile(absolutePath, "utf8");
        const TIERS = ["low", "medium", "high"] as const;
        if (this.meshCore.isAvailable) {
          const results = await this.meshCore.summarizeAllTiers(relativePath, raw);
          await Promise.all(TIERS.map(t => this.cache.setCapsule(relativePath, t, results[t] || "", mtimeMs)));
        } else {
          await Promise.all(TIERS.map(t => this.cache.setCapsule(relativePath, t, raw.slice(0, 12000), mtimeMs)));
        }
      }
      yield { current: i + 1, total, path: relativePath };
    }
  }
}
