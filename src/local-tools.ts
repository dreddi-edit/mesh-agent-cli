import { promises as fs } from "node:fs";
import path from "node:path";

import { MeshCoreAdapter } from "./mesh-core-adapter.js";
import { ToolBackend, ToolDefinition } from "./tool-backend.js";

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

  constructor(private readonly workspaceRoot: string) {}

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
      }
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
      case "workspace.grep_content":
        return this.grepContent(args);
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

    const raw = await fs.readFile(absolutePath, "utf8");
    const summary = await this.meshCore.summarizeFile(requestedPath, raw);

    return {
      ok: true,
      path: toPosixRelative(this.workspaceRoot, absolutePath),
      bytes: Buffer.byteLength(raw, "utf8"),
      content: raw.slice(0, 12000),
      truncated: raw.length > 12000,
      mesh: summary
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
}
