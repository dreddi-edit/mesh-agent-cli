import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export interface ContextArtifactRecord {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
  storagePath: string;
  originalChars: number;
  summary: string;
  hints: string[];
}

export interface ToolResultEnvelope {
  type: "mesh.tool_result.v2";
  tool: string;
  ok: boolean | null;
  artifact: {
    id: string;
    charsStored: number;
    open: string;
  };
  summary: string;
  refs: string[];
  facts: Record<string, unknown>;
  nextSuggestedTools: string[];
  tokensSavedEstimate: number;
}

export class ContextArtifactStore {
  private readonly basePath: string;
  private readonly indexPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.basePath = path.join(workspaceRoot, ".mesh", "context", "artifacts");
    this.indexPath = path.join(this.basePath, "index.json");
  }

  async saveToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown
  ): Promise<ContextArtifactRecord> {
    await fs.mkdir(this.basePath, { recursive: true });
    const serialized = JSON.stringify(result, null, 2);
    const id = this.createId(toolName, serialized);
    const storagePath = path.join(this.basePath, `${id}.json`);
    const record: ContextArtifactRecord = {
      id,
      toolName,
      args,
      createdAt: new Date().toISOString(),
      storagePath,
      originalChars: serialized.length,
      summary: summarizeToolResult(result),
      hints: buildArtifactHints(result)
    };
    await fs.writeFile(storagePath, JSON.stringify({ record, result }, null, 2), "utf8");
    await this.upsertIndex(record);
    return record;
  }

  buildCard(record: ContextArtifactRecord): string {
    const argsPreview = JSON.stringify(record.args);
    return [
      `Artifact ${record.id}`,
      `tool: ${record.toolName}`,
      `args: ${argsPreview.length > 500 ? `${argsPreview.slice(0, 500)}...` : argsPreview}`,
      `size: ${record.originalChars.toLocaleString()} chars stored locally`,
      `summary: ${record.summary}`,
      record.hints.length > 0 ? `hints: ${record.hints.join("; ")}` : "hints: none",
      `open: workspace.open_artifact({ "id": "${record.id}", "query": "...", "maxChars": 4000 })`
    ].join("\n");
  }

  buildEnvelope(record: ContextArtifactRecord, result: unknown): ToolResultEnvelope {
    return {
      type: "mesh.tool_result.v2",
      tool: record.toolName,
      ok: inferOk(result),
      artifact: {
        id: record.id,
        charsStored: record.originalChars,
        open: `workspace.open_artifact({ "id": "${record.id}", "query": "...", "maxChars": 4000 })`
      },
      summary: record.summary,
      refs: record.hints,
      facts: extractFacts(result),
      nextSuggestedTools: suggestNextTools(record.toolName, result),
      tokensSavedEstimate: Math.max(0, Math.ceil(record.originalChars / 4) - 220)
    };
  }

  buildEnvelopeText(record: ContextArtifactRecord, result: unknown): string {
    return JSON.stringify(this.buildEnvelope(record, result));
  }

  private createId(toolName: string, serialized: string): string {
    const slug = toolName.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const hash = crypto.createHash("sha1").update(`${toolName}\n${serialized}\n${Date.now()}`).digest("hex").slice(0, 10);
    return `${slug}-${hash}`;
  }

  private async upsertIndex(record: ContextArtifactRecord): Promise<void> {
    const index = await this.readIndex();
    const next = [record, ...index.filter((entry) => entry.id !== record.id)].slice(0, 200);
    await fs.writeFile(this.indexPath, JSON.stringify(next, null, 2), "utf8");
  }

  private async readIndex(): Promise<ContextArtifactRecord[]> {
    const raw = await fs.readFile(this.indexPath, "utf8").catch(() => "[]");
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

export async function readContextArtifactIndex(workspaceRoot: string, limit = 20): Promise<ContextArtifactRecord[]> {
  const indexPath = path.join(workspaceRoot, ".mesh", "context", "artifacts", "index.json");
  const raw = await fs.readFile(indexPath, "utf8").catch(() => "[]");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, Math.max(0, limit)) : [];
  } catch {
    return [];
  }
}

export async function openContextArtifact(
  workspaceRoot: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const id = String(args.id ?? "").trim();
  if (!/^[a-z0-9-]+$/i.test(id)) {
    throw new Error("workspace.open_artifact requires a valid artifact id");
  }
  const maxChars = Math.max(500, Math.min(12_000, Number(args.maxChars ?? 4000) || 4000));
  const query = String(args.query ?? "").trim().toLowerCase();
  const artifactPath = path.join(workspaceRoot, ".mesh", "context", "artifacts", `${id}.json`);
  const raw = await fs.readFile(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as { record: ContextArtifactRecord; result: unknown };
  const serialized = JSON.stringify(parsed.result, null, 2);
  const content = query ? extractMatchingLines(serialized, query, maxChars) : serialized.slice(0, maxChars);
  return {
    ok: true,
    id,
    toolName: parsed.record.toolName,
    args: parsed.record.args,
    originalChars: parsed.record.originalChars,
    summary: parsed.record.summary,
    query: query || null,
    content,
    truncated: content.length < serialized.length
  };
}

function summarizeToolResult(result: unknown): string {
  if (result == null) return "null result";
  if (typeof result === "string") return summarizeText(result);
  if (Array.isArray(result)) return `array with ${result.length} items: ${summarizeText(JSON.stringify(result.slice(0, 5)))}`;
  if (typeof result !== "object") return String(result);

  const value = result as Record<string, any>;
  const parts: string[] = [];
  if (typeof value.ok === "boolean") parts.push(`ok=${value.ok}`);
  if (value.status) parts.push(`status=${String(value.status)}`);
  if (value.path) parts.push(`path=${String(value.path)}`);
  if (value.error) parts.push(`error=${summarizeText(String(value.error), 180)}`);
  if (value.output) parts.push(`output=${summarizeText(String(value.output), 220)}`);
  if (value.content) parts.push(`content=${summarizeText(String(value.content), 220)}`);

  for (const key of ["files", "entries", "results", "matches", "diagnostics", "queue", "insights"]) {
    if (Array.isArray(value[key])) parts.push(`${key}=${value[key].length}`);
  }
  if (parts.length > 0) return parts.join(", ");
  return summarizeText(JSON.stringify(value), 280);
}

function inferOk(result: unknown): boolean | null {
  if (!result || typeof result !== "object") return null;
  const value = result as Record<string, unknown>;
  return typeof value.ok === "boolean" ? value.ok : null;
}

function extractFacts(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const value = result as Record<string, any>;
  const facts: Record<string, unknown> = {};
  for (const key of ["ok", "status", "path", "branch", "exitCode", "resultsFound", "cachedFiles", "totalFiles", "percent"]) {
    if (value[key] != null && typeof value[key] !== "object") facts[key] = value[key];
  }
  for (const key of ["files", "entries", "results", "matches", "diagnostics", "queue", "insights", "nodes", "links"]) {
    if (Array.isArray(value[key])) facts[`${key}Count`] = value[key].length;
  }
  if (value.summary && typeof value.summary !== "object") facts.summary = summarizeText(String(value.summary), 180);
  if (value.error) facts.error = summarizeText(String(value.error), 180);
  return facts;
}

function suggestNextTools(toolName: string, result: unknown): string[] {
  const tools = new Set<string>();
  if (/ask_codebase|search|grep|list_files|list_directory/i.test(toolName)) {
    tools.add("workspace.read_file");
  }
  if (/read_file|open_artifact/i.test(toolName)) {
    tools.add("workspace.impact_map");
  }
  if (/diagnostics|predictive_repair/i.test(toolName)) {
    tools.add("workspace.read_file");
    tools.add("workspace.impact_map");
  }
  if (inferOk(result) === false) {
    tools.add("answer_or_try_different_tool");
  }
  return Array.from(tools).slice(0, 3);
}

function buildArtifactHints(result: unknown): string[] {
  const hints = new Set<string>();
  const raw = JSON.stringify(result);
  for (const match of raw.matchAll(/"([^"]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html))"/g)) {
    hints.add(match[1]);
    if (hints.size >= 8) break;
  }
  return Array.from(hints);
}

function summarizeText(text: string, limit = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "empty";
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function extractMatchingLines(text: string, query: string, maxChars: number): string {
  const terms = query.split(/\s+/g).filter(Boolean);
  const lines = text.split(/\r?\n/g);
  const matches: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLowerCase();
    if (!terms.every((term) => lower.includes(term))) continue;
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 3);
    matches.push(lines.slice(start, end).join("\n"));
    if (matches.join("\n---\n").length >= maxChars) break;
  }
  const joined = matches.join("\n---\n");
  return joined ? joined.slice(0, maxChars) : text.slice(0, maxChars);
}
