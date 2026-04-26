import { promises as fs } from "node:fs";
import path from "node:path";

const SKIP_DIR_RE = /(^|\/)(\.git|node_modules|dist|coverage|\.next|\.turbo|\.cache|\.mesh)(\/|$)/;

export async function collectWorkspaceFiles(
  workspaceRoot: string,
  options: { extensions?: string[]; maxFiles?: number } = {}
): Promise<string[]> {
  const extensions = new Set(options.extensions ?? [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 500, 5000));
  const files: string[] = [];
  await walk(workspaceRoot, workspaceRoot, files, extensions, maxFiles);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(value) + "\n", "utf8");
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function lineNumberAt(raw: string, index: number): number {
  return raw.slice(0, Math.max(0, index)).split(/\r?\n/g).length;
}

async function walk(
  root: string,
  current: string,
  files: string[],
  extensions: Set<string>,
  maxFiles: number
): Promise<void> {
  if (files.length >= maxFiles) return;
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    const absolute = path.join(current, entry.name);
    const relative = toPosix(path.relative(root, absolute));
    if (SKIP_DIR_RE.test(relative)) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, files, extensions, maxFiles);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(relative);
    }
  }
}
