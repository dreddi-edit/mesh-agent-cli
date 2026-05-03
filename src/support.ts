import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SupportInfo {
  timestamp: string;
  meshVersion: string;
  cwd: string;
  platform: string;
  arch: string;
  node: string;
  npm?: string;
  npmPrefix?: string;
  gitBranch?: string;
  gitStatus?: string;
}

export async function collectSupportInfo(meshVersion: string, cwd = process.cwd()): Promise<SupportInfo> {
  const [npmVersion, npmPrefix, gitBranch, gitStatus] = await Promise.all([
    execFileAsync("npm", ["--version"]).then((result) => result.stdout.trim()).catch(() => undefined),
    execFileAsync("npm", ["config", "get", "prefix"]).then((result) => result.stdout.trim()).catch(() => undefined),
    execFileAsync("git", ["branch", "--show-current"], { cwd }).then((result) => result.stdout.trim()).catch(() => undefined),
    execFileAsync("git", ["status", "--short"], { cwd }).then((result) => result.stdout.trim()).catch(() => undefined)
  ]);

  return {
    timestamp: new Date().toISOString(),
    meshVersion,
    cwd,
    platform: `${os.type()} ${os.release()}`,
    arch: `${os.platform()}/${os.arch()}`,
    node: process.version,
    npm: npmVersion,
    npmPrefix,
    gitBranch,
    gitStatus
  };
}

export function formatSupportInfo(info: SupportInfo): string {
  const lines = [
    "Mesh Support Info",
    "",
    `timestamp:   ${info.timestamp}`,
    `mesh:        ${info.meshVersion}`,
    `node:        ${info.node}`,
    `npm:         ${info.npm ?? "unavailable"}`,
    `npm prefix:  ${info.npmPrefix ?? "unavailable"}`,
    `platform:    ${info.platform}`,
    `arch:        ${info.arch}`,
    `cwd:         ${info.cwd}`,
    `repo:        ${info.gitBranch ? `branch ${info.gitBranch}` : "not a git worktree or branch unavailable"}`,
    `git status:  ${info.gitStatus ? info.gitStatus.replace(/\n/g, "\\n") : "clean or unavailable"}`,
    "",
    "For bug reports, also include:",
    "  mesh doctor full",
    "  the exact command or prompt you ran",
    "  the full error text"
  ];

  if (info.npmPrefix) {
    lines.push("", `If global mesh is not found, verify PATH contains: ${path.join(info.npmPrefix, "bin")}`);
  }

  return `${lines.join("\n")}\n`;
}
