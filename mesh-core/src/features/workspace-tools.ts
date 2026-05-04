/**
 * Basic Workspace Tools - Tier 1 essentials
 * File I/O, git basics, environment info
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type {
  WorkspaceToolsConfig,
  FileInfo,
  GitStatus,
  GitDiff,
  DirectoryListing
} from "./types.js";

export class WorkspaceTools {
  private config: WorkspaceToolsConfig;

  constructor(config: WorkspaceToolsConfig) {
    this.config = config;
  }

  /**
   * List files in a directory
   */
  listFiles(dirPath: string, recursive: boolean = false, maxDepth: number = 3): DirectoryListing {
    const fullPath = this.resolveWorkspacePath(dirPath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const entries: DirectoryListing = { directories: [], files: [] };
    this.walkDirectory(fullPath, entries, recursive ? maxDepth : 1, 0, '');

    return entries;
  }

  private walkDirectory(dir: string, listing: DirectoryListing, maxDepth: number, currentDepth: number, relativePath: string): void {
    if (currentDepth >= maxDepth) return;

    try {
      const entries = fs.readdirSync(dir);

      entries.forEach(entry => {
        if (entry.startsWith(".")) return;

        const fullPath = path.join(dir, entry);
        const relPath = relativePath ? `${relativePath}/${entry}` : entry;
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          listing.directories.push(relPath);
          if (currentDepth < maxDepth - 1) {
            this.walkDirectory(fullPath, listing, maxDepth, currentDepth + 1, relPath);
          }
        } else {
          listing.files.push({
            path: relPath,
            size: stat.size,
            modified: stat.mtime
          });
        }
      });
    } catch (err) {
      // Skip directories we can't read
    }
  }

  /**
   * Read file content
   */
  readFile(filePath: string, encoding: BufferEncoding = "utf-8"): string {
    const fullPath = this.resolveWorkspacePath(filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    if (fs.statSync(fullPath).isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }

    return fs.readFileSync(fullPath, { encoding });
  }

  /**
   * Write file content
   */
  writeFile(filePath: string, content: string, createDirs: boolean = true): FileInfo {
    const fullPath = this.resolveWorkspacePath(filePath);
    const dir = path.dirname(fullPath);

    if (createDirs && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

      fs.writeFileSync(fullPath, content, "utf-8");
    const stat = fs.statSync(fullPath);

    return {
      path: filePath,
      size: stat.size,
      modified: stat.mtime,
      isDirectory: false
    };
  }

  /**
   * Get file info/metadata
   */
  getFileInfo(filePath: string): FileInfo {
    const fullPath = this.resolveWorkspacePath(filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(fullPath);

    return {
      path: filePath,
      size: stat.size,
      modified: stat.mtime,
      isDirectory: stat.isDirectory(),
      permissions: "0" + (stat.mode & parseInt("777", 8)).toString(8)
    };
  }

  /**
   * Get git status
   */
  gitStatus(): GitStatus {
    try {
      const output = execFileSync("git", ["status", "--porcelain"], {
        cwd: this.config.workspaceRoot,
        encoding: "utf-8"
      });

      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];

      output.split("\n").forEach((line) => {
        if (!line.trim()) return;

        const status = line.slice(0, 2);
        const file = line.slice(3);

        if (status[0] === "M" || status[0] === "A" || status[0] === "D") {
          staged.push(file);
        } else if (status[1] === "M" || status[1] === "D") {
          unstaged.push(file);
        } else if (status === "??") {
          untracked.push(file);
        }
      });

      return { staged, unstaged, untracked };
    } catch (err) {
      throw new Error("Failed to get git status");
    }
  }

  /**
   * Get git diff
   */
  gitDiff(base: string = "HEAD", head: string = "working"): GitDiff {
    try {
      const args = head === "working"
        ? ["diff", base]
        : ["diff", `${base}..${head}`];
      const output = execFileSync("git", args, {
        cwd: this.config.workspaceRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
      });

      const files: Map<string, { additions: number; deletions: number }> = new Map();
      let totalAdditions = 0;
      let totalDeletions = 0;

      const lines = output.split("\n");
      let currentFile = "";

      lines.forEach((line) => {
        if (line.startsWith("diff --git")) {
          const match = line.match(/b\/(.+)$/);
          if (match) {
            currentFile = match[1];
            files.set(currentFile, { additions: 0, deletions: 0 });
          }
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          totalAdditions++;
          if (currentFile && files.has(currentFile)) {
            files.get(currentFile)!.additions++;
          }
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          totalDeletions++;
          if (currentFile && files.has(currentFile)) {
            files.get(currentFile)!.deletions++;
          }
        }
      });

      return {
        base,
        head,
        fileCount: files.size,
        totalAdditions,
        totalDeletions,
        diffText: output,
        fileStats: Object.fromEntries(files)
      };
    } catch (err) {
      throw new Error("Failed to get git diff");
    }
  }

  /**
   * Run a command in workspace
   */
  runCommand(command: string, args: string[] = [], timeout: number = 30000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.config.workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("exit", (code) => {
        finish(() => {
          resolve({
            exitCode: code ?? (timedOut ? 124 : 1),
            stdout,
            stderr: timedOut ? `${stderr}\nCommand timed out after ${timeout}ms` : stderr
          });
        });
      });

      child.on("error", (err) => {
        finish(() => {
          reject(err);
        });
      });
    });
  }

  /**
   * Get environment information
   */
  getEnvInfo(): Record<string, unknown> {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      workspaceRoot: this.config.workspaceRoot,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: `${process.env.PATH?.split(path.delimiter).slice(0, 3).join(", ") || ""}...`,
        HOME: process.env.HOME
      }
    };
  }

  /**
   * Delete a file or directory
   */
  deleteFile(filePath: string): void {
    const fullPath = this.resolveWorkspacePath(filePath);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    if (fs.statSync(fullPath).isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }

  /**
   * Copy file
   */
  copyFile(source: string, destination: string): FileInfo {
    const sourcePath = this.resolveWorkspacePath(source);
    const destPath = this.resolveWorkspacePath(destination);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found: ${source}`);
    }

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.copyFileSync(sourcePath, destPath);
    const stat = fs.statSync(destPath);

    return {
      path: destination,
      size: stat.size,
      modified: stat.mtime,
      isDirectory: false
    };
  }

  private resolveWorkspacePath(targetPath: string): string {
    const resolved = path.resolve(this.config.workspaceRoot, targetPath);
    const relative = path.relative(this.config.workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${targetPath}`);
    }
    return resolved;
  }
}
