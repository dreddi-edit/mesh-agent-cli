import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DEFAULT_MODEL_ID } from "./model-catalog.js";
import { LocalToolBackend } from "./local-tools.js";
import type { AppConfig } from "./config.js";

const workspaceRoot = path.resolve(process.argv[2] || process.cwd());
const dashboardDir = path.join(workspaceRoot, ".mesh", "dashboard");
const eventsPath = path.join(dashboardDir, "events.json");
const actionsPath = path.join(dashboardDir, "actions.json");
const contextMetricsPath = path.join(dashboardDir, "context-metrics.json");
const artifactIndexPath = path.join(workspaceRoot, ".mesh", "context", "artifacts", "index.json");
const serverInfoPath = path.join(dashboardDir, "server.json");
const DASHBOARD_SERVER_VERSION = "context-ledger-v6";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".mesh", ".next", ".turbo", "coverage", "benchmarks"]);
let stateCache: { at: number; value: Record<string, unknown> } | null = null;
let graphCache: { key: string; value: Record<string, unknown> } | null = null;
let actionBackend: LocalToolBackend | null = null;

class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    } else {
      this.locked = false;
    }
  }
}

const ioMutex = new Mutex();

function dashboardToolConfig(): AppConfig {
  return {
    bedrock: {
      endpointBase: process.env.BEDROCK_ENDPOINT || "",
      bearerToken: process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_BEARER_TOKEN || process.env.BEDROCK_API_KEY || undefined,
      modelId: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
      fallbackModelIds: [],
      temperature: 0,
      maxTokens: 3000
    },
    agent: {
      maxSteps: 8,
      mode: "local",
      workspaceRoot,
      enableCloudCache: false,
      themeColor: "cyan",
      voice: {
        configured: false,
        language: "auto",
        speed: 260,
        voice: "auto",
        microphone: "default",
        transcriptionModel: "small"
      }
    },
    mcp: {
      args: []
    },
    supabase: {},
    telemetry: {
      contribute: false
    }
  };
}

function getActionBackend(): LocalToolBackend {
  if (!actionBackend) {
    actionBackend = new LocalToolBackend(workspaceRoot, dashboardToolConfig());
  }
  return actionBackend;
}

async function main(): Promise<void> {
  await fs.mkdir(dashboardDir, { recursive: true });
  const closeBackend = () => {
    void actionBackend?.close().catch(() => undefined);
  };
  process.once("SIGINT", closeBackend);
  process.once("SIGTERM", closeBackend);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health") {
        return json(res, { ok: true, version: DASHBOARD_SERVER_VERSION });
      }
      if (url.pathname === "/api/state") {
        return json(res, await buildState());
      }
      if (url.pathname === "/api/actions" && req.method === "POST") {
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("application/json")) {
          res.writeHead(415, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, error: "Unsupported Media Type: Must be application/json" }));
        }

        const origin = req.headers["origin"];
        const host = req.headers["host"];
        if (origin) {
          try {
            const originUrl = new URL(origin);
            if (originUrl.host !== host) {
              res.writeHead(403, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "Cross-Origin Request Blocked" }));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "Invalid Origin" }));
          }
        }

        const body = await readRequestJson(req);
        return json(res, await enqueueAction(body));
      }
      if (url.pathname === "/") {
        return html(res, renderHtml());
      }
      res.writeHead(404);
      res.end("Not found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });

  server.listen(0, "127.0.0.1", async () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await fs.writeFile(serverInfoPath, JSON.stringify({ port, pid: process.pid, workspaceRoot, version: DASHBOARD_SERVER_VERSION }, null, 2), "utf8");
  });
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self' 'unsafe-inline'; img-src 'self' data:;"
  });
  res.end(body);
}

function json(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  res.end(JSON.stringify(payload));
}

async function buildState(): Promise<Record<string, unknown>> {
  if (stateCache && Date.now() - stateCache.at < 1_500) {
    return stateCache.value;
  }
  const [files, digitalTwin, repair, memory, causal, discovery, realityFork, ghost, events, actions, contextMetrics, artifacts] = await Promise.all([
    collectFiles(workspaceRoot, 500),
    readJson(path.join(workspaceRoot, ".mesh", "digital-twin.json"), null),
    readJson(path.join(workspaceRoot, ".mesh", "predictive-repair.json"), null),
    readJson(path.join(workspaceRoot, ".mesh", "engineering-memory.json"), null),
    readJson(path.join(workspaceRoot, ".mesh", "causal-intelligence.json"), null),
    readJson(path.join(workspaceRoot, ".mesh", "discovery-lab.json"), null),
    readJson(path.join(workspaceRoot, ".mesh", "reality-forks", "latest.json"), null),
    readJson(path.join(workspaceRoot, ".mesh", "ghost-engineer", "profile.json"), null),
    readJson(eventsPath, []),
    readJson(actionsPath, []),
    readJson(contextMetricsPath, null),
    readJson(artifactIndexPath, [])
  ]);

  const groupedFiles = groupFiles(files);
  const dependencyGraph = await buildDependencyGraphCached(files);
  const hotFiles = Array.isArray(digitalTwin?.riskHotspots)
    ? digitalTwin.riskHotspots.slice(0, 10).map((entry: any) => ({
        file: entry.file,
        risks: entry.risks || [],
        score: entry.score ?? null
      }))
    : [];
  const repairQueue = Array.isArray(repair?.queue) ? repair.queue.slice(0, 8) : [];
  const discoveries = Array.isArray(discovery?.discoveries) ? discovery.discoveries.slice(0, 6) : [];
  const actionQueue = normalizeActionQueue(Array.isArray(actions) ? actions : []);

  const summary = {
    workspace: path.basename(workspaceRoot),
    fileCount: files.length,
    sourceCount: groupedFiles.source.length,
    testCount: groupedFiles.tests.length,
    docsCount: groupedFiles.docs.length,
    configCount: groupedFiles.config.length,
    repairs: repairQueue.length,
    riskHotspots: hotFiles.length,
    rules: Array.isArray(memory?.rules) ? memory.rules.length : 0,
    insights: Array.isArray(causal?.insights) ? causal.insights.length : 0,
    discoveries: discoveries.length,
    forks: Array.isArray(realityFork?.proposals) ? realityFork.proposals.length : 0,
    ghostConfidence: typeof ghost?.confidence === "number" ? Math.round(ghost.confidence * 100) : null
  };

  const healthScore = Math.max(
    0,
    100
      - repairQueue.length * 8
      - hotFiles.length * 4
      - Math.max(0, (Array.isArray(causal?.insights) ? causal.insights.length : 0) - 5) * 2
  );

  const state = {
    workspaceRoot,
    summary,
    health: {
      score: healthScore,
      status: healthScore >= 85 ? "healthy" : healthScore >= 65 ? "watch" : "attention"
    },
    actions: [
      { label: "/repair", detail: "Find compiler/test-risk repair candidates", action: "repair" },
      { label: "/causal", detail: "Rebuild the file/risk/test graph", action: "causal" },
      { label: "/lab", detail: "Suggest high-impact repo improvements", action: "lab" },
      { label: "/twin", detail: "Refresh files, routes, symbols, risks", action: "twin" },
      { label: "/ghost learn", detail: "Learn local implementation style", action: "ghost_learn" }
    ],
    groupedFiles,
    dependencyGraph,
    hotFiles,
    repairQueue,
    discoveries,
    contextMetrics,
    artifacts: Array.isArray(artifacts) ? artifacts.slice(0, 20) : [],
    ghost,
    memoryRules: Array.isArray(memory?.rules) ? memory.rules.slice(0, 8) : [],
    events: Array.isArray(events) ? events.slice(0, 30) : [],
    actionQueue,
    liveUpdatedAt: new Date().toISOString()
  };
  stateCache = { at: Date.now(), value: state };
  return state;
}

function normalizeActionQueue(actions: any[]): any[] {
  const now = Date.now();
  return actions.slice(0, 20).map((action) => {
    if (action?.status !== "pending") return action;
    const createdAt = Date.parse(String(action.createdAt || ""));
    if (Number.isFinite(createdAt) && now - createdAt < 120_000) return action;
    return {
      ...action,
      status: "stale",
      summary: "Queued by an older dashboard session. Run it again."
    };
  });
}

async function readRequestJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buf.length;
    if (length > 1024 * 1024) {
      req.destroy();
      throw new Error("Payload too large (OOM Protection)");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function enqueueAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const allowed = new Set(["repair", "causal", "lab", "twin", "ghost_learn"]);
  const action = String(body.action || "").trim();
  if (!allowed.has(action)) {
    return { ok: false, error: "unsupported action" };
  }
  await ioMutex.acquire();
  let request: Record<string, unknown>;
  try {
    const existing = await readJson(actionsPath, []);
    const queue = Array.isArray(existing) ? existing : [];
    request = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      status: "running",
      createdAt: new Date().toISOString()
    };
    queue.unshift(request);
    await fs.mkdir(path.dirname(actionsPath), { recursive: true });
    await fs.writeFile(actionsPath, JSON.stringify(queue.slice(0, 100), null, 2), "utf8");
  } finally {
    ioMutex.release();
  }
  await appendEvent({ type: "dashboard_action", msg: `running ${action}`, at: new Date().toISOString() });

  try {
    const result = await executeDashboardAction(action);
    const completed = {
      ...request,
      status: "done",
      finishedAt: new Date().toISOString(),
      summary: summarizeActionResult(action, result),
      result
    };
    await updateActionRecord(String(request.id), completed);
    await appendEvent({ type: "dashboard_action", msg: `done ${action}`, at: new Date().toISOString() });
    stateCache = null;
    graphCache = null;
    return { ok: true, request: completed };
  } catch (error) {
    const failed = {
      ...request,
      status: "error",
      finishedAt: new Date().toISOString(),
      error: (error as Error).message
    };
    await updateActionRecord(String(request.id), failed);
    await appendEvent({ type: "dashboard_action", msg: `failed ${action}`, at: new Date().toISOString() });
    stateCache = null;
    return { ok: false, request: failed, error: (error as Error).message };
  }
}

async function executeDashboardAction(action: string): Promise<Record<string, unknown>> {
  const backend = getActionBackend();
  switch (action) {
    case "repair":
      return await backend.callTool("workspace.predictive_repair", { action: "analyze" }) as Record<string, unknown>;
    case "causal":
      return await backend.callTool("workspace.causal_intelligence", { action: "build" }) as Record<string, unknown>;
    case "lab":
      return await backend.callTool("workspace.discovery_lab", { action: "run" }) as Record<string, unknown>;
    case "twin":
      return await backend.callTool("workspace.digital_twin", { action: "build" }) as Record<string, unknown>;
    case "ghost_learn":
      return await backend.callTool("workspace.ghost_engineer", { action: "learn" }) as Record<string, unknown>;
    default:
      throw new Error(`Unsupported dashboard action: ${action}`);
  }
}

function summarizeActionResult(action: string, result: Record<string, unknown>): string {
  if (action === "repair") {
    const queue = Array.isArray((result as any).queue) ? (result as any).queue.length : 0;
    return `${queue} repair candidates`;
  }
  if (action === "causal") {
    const graph = (result as any).graph ?? result;
    return `${graph.nodes?.length ?? graph.nodes ?? 0} nodes, ${graph.insights?.length ?? graph.insights ?? 0} insights`;
  }
  if (action === "lab") {
    return `${Array.isArray((result as any).discoveries) ? (result as any).discoveries.length : 0} discoveries`;
  }
  if (action === "twin") {
    const twin = (result as any).twin ?? result;
    return `${twin.files?.total ?? twin.files ?? 0} files mapped`;
  }
  if (action === "ghost_learn") {
    const profile = (result as any).profile ?? result;
    return `confidence ${profile.confidence ?? "n/a"}`;
  }
  return "complete";
}

async function updateActionRecord(id: string, next: Record<string, unknown>): Promise<void> {
  await ioMutex.acquire();
  try {
    const existing = await readJson(actionsPath, []);
    const queue = Array.isArray(existing) ? existing : [];
    const index = queue.findIndex((item: any) => item?.id === id);
    if (index >= 0) {
      queue[index] = next;
    } else {
      queue.unshift(next);
    }
    await fs.mkdir(path.dirname(actionsPath), { recursive: true });
    await fs.writeFile(actionsPath, JSON.stringify(queue.slice(0, 100), null, 2), "utf8");
  } finally {
    ioMutex.release();
  }
}

async function appendEvent(event: Record<string, unknown>): Promise<void> {
  await ioMutex.acquire();
  try {
    const existing = await readJson(eventsPath, []);
    const events = Array.isArray(existing) ? existing : [];
    events.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...event });
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.writeFile(eventsPath, JSON.stringify(events.slice(0, 200), null, 2), "utf8");
  } finally {
    ioMutex.release();
  }
}

async function collectFiles(root: string, limit: number): Promise<string[]> {
  const queue = [root];
  const result: string[] = [];
  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift();
    if (!current) break;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.length >= limit) break;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(root, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|yml|yaml|toml)$/.test(entry.name)) continue;
      result.push(relPath);
    }
  }
  return result;
}

function groupFiles(files: string[]): Record<string, string[]> {
  const groups = { source: [] as string[], tests: [] as string[], docs: [] as string[], config: [] as string[], other: [] as string[] };
  for (const file of files) {
    if (/(\.test|\.spec)\./.test(file) || file.startsWith("tests/")) groups.tests.push(file);
    else if (/\.(md|mdx)$/.test(file) || /readme/i.test(file)) groups.docs.push(file);
    else if (/package\.json|tsconfig|eslint|prettier|vite|vitest|playwright|docker|yaml|yml|toml|json$/i.test(file)) groups.config.push(file);
    else if (file.startsWith("src/")) groups.source.push(file);
    else groups.other.push(file);
  }
  for (const key of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[key] = groups[key].slice(0, 120);
  }
  return groups;
}

async function buildDependencyGraph(files: string[]): Promise<Record<string, unknown>> {
  const candidates = files
    .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    .slice(0, 180);
  const fileSet = new Set(files);
  const nodeSet = new Set<string>();
  const links: Array<{ source: string; target: string; type: string }> = [];
  const details: Record<string, { dependencies: string[]; dependents: string[]; externalImports: string[] }> = {};
  const externalCounts = new Map<string, number>();

  for (const file of candidates) {
    nodeSet.add(file);
    details[file] = details[file] || { dependencies: [], dependents: [], externalImports: [] };
    const raw = await fs.readFile(path.join(workspaceRoot, file), "utf8").catch(() => "");
    if (!raw) continue;
    for (const specifier of extractImportSpecifiers(raw)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const resolved = resolveLocalImport(file, specifier, fileSet);
        if (!resolved) continue;
        nodeSet.add(resolved);
        details[file].dependencies.push(resolved);
        details[resolved] = details[resolved] || { dependencies: [], dependents: [], externalImports: [] };
        details[resolved].dependents.push(file);
        links.push({ source: file, target: resolved, type: "local" });
      } else {
        const packageName = normalizePackageName(specifier);
        details[file].externalImports.push(packageName);
        externalCounts.set(packageName, (externalCounts.get(packageName) || 0) + 1);
      }
    }
  }

  const nodes = Array.from(nodeSet).slice(0, 220).map((file) => ({
    id: file,
    label: path.basename(file),
    group: classifyFile(file),
    dependencies: details[file]?.dependencies.length || 0,
    dependents: details[file]?.dependents.length || 0
  }));
  const allowedNodes = new Set(nodes.map((node) => node.id));

  return {
    nodes,
    links: links
      .filter((link) => allowedNodes.has(link.source) && allowedNodes.has(link.target))
      .slice(0, 420),
    details,
    externalPackages: Array.from(externalCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 16)
  };
}

async function buildDependencyGraphCached(files: string[]): Promise<Record<string, unknown>> {
  const candidates = files
    .filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    .slice(0, 180);
  const stats = await Promise.all(
    candidates.map(async (file) => {
      const stat = await fs.stat(path.join(workspaceRoot, file)).catch(() => null);
      return `${file}:${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`;
    })
  );
  const key = stats.join("|");
  if (graphCache?.key === key) {
    return graphCache.value;
  }
  const value = await buildDependencyGraph(files);
  graphCache = { key, value };
  return value;
}

function extractImportSpecifiers(raw: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return Array.from(specs);
}

function resolveLocalImport(fromFile: string, specifier: string, fileSet: Set<string>): string | null {
  const fromDir = path.dirname(fromFile);
  const base = specifier.startsWith("/")
    ? specifier.slice(1)
    : path.normalize(path.join(fromDir, specifier)).split(path.sep).join("/");
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  for (const ext of extensions) {
    const candidate = `${base}${ext}`;
    if (fileSet.has(candidate)) return candidate;
  }
  for (const ext of extensions.slice(1)) {
    const candidate = `${base}/index${ext}`;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function normalizePackageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return [scope, name].filter(Boolean).join("/");
  }
  return specifier.split("/")[0] || specifier;
}

function classifyFile(file: string): string {
  if (/(\.test|\.spec)\./.test(file) || file.startsWith("tests/")) return "tests";
  if (/\.(md|mdx)$/.test(file) || /readme/i.test(file)) return "docs";
  if (/package\.json|tsconfig|eslint|prettier|vite|vitest|playwright|docker|yaml|yml|toml|json$/i.test(file)) return "config";
  if (file.startsWith("src/")) return "source";
  return "other";
}

async function readJson(filePath: string, fallback: any): Promise<any> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mesh Dashboard</title>
  <style>
    :root {
      --bg: #eef2f5;
      --panel: #ffffff;
      --panel-2: #f8fafb;
      --muted: #687586;
      --text: #111827;
      --border: #d8e0e7;
      --border-strong: #b9c5d0;
      --accent: #0f766e;
      --accent-soft: #d9f4ef;
      --warn: #9a5b10;
      --warn-soft: #fff3d6;
      --danger: #a52828;
      --danger-soft: #ffe1e1;
      --ok: #16723a;
      --ok-soft: #ddf6e7;
      --shadow: 0 1px 2px rgba(17, 24, 39, 0.05);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; font: 13px/1.42 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); overflow: hidden; }
    .app { height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
    header { padding: 14px 20px; background: var(--panel); border-bottom: 1px solid var(--border); display: flex; gap: 18px; align-items: center; justify-content: space-between; min-width: 0; }
    .brand { font-size: 17px; font-weight: 760; letter-spacing: 0; }
    .subtitle { color: var(--muted); font-size: 12px; max-width: min(760px, 62vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
    .summary { padding: 12px 20px; display: grid; grid-template-columns: repeat(6, minmax(128px, 1fr)); gap: 10px; border-bottom: 1px solid var(--border); overflow: auto hidden; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); min-width: 0; }
    .metric { padding: 10px 12px; min-height: 72px; }
    .metric .label { font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 720; }
    .metric .value { margin-top: 4px; font-size: 24px; line-height: 1.05; font-weight: 780; letter-spacing: 0; }
    .metric .meta { margin-top: 4px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    main { min-height: 0; padding: 12px 20px 18px; display: grid; grid-template-columns: 300px minmax(560px, 1fr) 340px; gap: 12px; overflow: hidden; }
    section { padding: 14px; min-width: 0; }
    h2, h3 { margin: 0; font-size: 14px; line-height: 1.2; font-weight: 760; letter-spacing: 0; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .stack { display: grid; gap: 12px; min-height: 0; align-content: start; overflow: auto; padding-right: 2px; }
    .list { display: grid; gap: 8px; min-width: 0; }
    .item { border: 1px solid var(--border); border-radius: 7px; padding: 9px 10px; background: var(--panel-2); min-width: 0; }
    .item strong { display: block; font-size: 13px; margin-bottom: 3px; overflow-wrap: anywhere; }
    .item small { color: var(--muted); overflow-wrap: anywhere; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
    .pill.ok { background: var(--ok-soft); color: var(--ok); }
    .pill.warn { background: var(--warn-soft); color: var(--warn); }
    .pill.danger { background: var(--danger-soft); color: var(--danger); }
    .status-badge { border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px; color: var(--muted); background: #fff; font-size: 11px; font-weight: 700; }
    .status-badge.done { background: var(--ok-soft); color: var(--ok); border-color: #b8e8c9; }
    .status-badge.running { background: var(--accent-soft); color: var(--accent); border-color: #b2ded8; }
    .status-badge.error { background: var(--danger-soft); color: var(--danger); border-color: #ffcaca; }
    .toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 8px; align-items: center; margin-bottom: 10px; }
    .toolbar input, .toolbar select { width: 100%; min-width: 0; border: 1px solid var(--border); border-radius: 7px; padding: 8px 10px; font: inherit; background: #fff; color: var(--text); }
    .file-section { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .detail-grid { min-height: 0; display: grid; grid-template-columns: minmax(230px, 0.92fr) minmax(260px, 1.08fr); gap: 10px; }
    .file-list { min-height: 240px; max-height: 100%; overflow: auto; display: grid; gap: 7px; align-content: start; padding-right: 2px; }
    .file-row { border: 1px solid var(--border); border-radius: 7px; padding: 9px 10px; cursor: pointer; background: #fff; min-width: 0; }
    .file-row:hover, .file-row.active { border-color: var(--accent); background: var(--accent-soft); }
    .file-row .path { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
    .file-row .meta { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .file-detail-panel { border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); padding: 12px; min-height: 240px; overflow: auto; }
    .empty { color: var(--muted); padding: 14px 0; }
    .muted { color: var(--muted); }
    .center-column { min-width: 0; overflow: auto; }
    .graph-card { min-height: 360px; }
    .graph-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .graph-head h2 { margin: 0; }
    .graph-tools { display: flex; align-items: center; gap: 10px; }
    .graph-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .segmented { display: inline-grid; grid-auto-flow: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #fff; }
    .segmented button { border: 0; background: transparent; padding: 7px 10px; font: inherit; font-size: 12px; cursor: pointer; color: var(--muted); }
    .segmented button.active { background: var(--accent); color: #fff; }
    .graph-shell { height: min(380px, 42vh); min-height: 300px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #f9fbfc; }
    .graph-svg { width: 100%; height: 100%; display: block; }
    .graph-link { stroke: #8a9bab; stroke-width: 1.2; opacity: 0.38; }
    .graph-link.active { stroke: var(--accent); opacity: 0.9; stroke-width: 2; }
    .graph-node { cursor: pointer; }
    .graph-node circle { stroke: #fff; stroke-width: 2; }
    .graph-node text { fill: #334155; font-size: 11px; paint-order: stroke; stroke: #f9fbfc; stroke-width: 4px; stroke-linejoin: round; }
    .graph-node.active circle { stroke: var(--accent); stroke-width: 3; }
    .graph-node.dim { opacity: 0.28; }
    .graph-column-label { fill: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; color: var(--muted); font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    .dependency-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .dependency-list .item { min-height: 64px; }
    .package-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .action-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .action-button { min-width: 72px; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 7px; padding: 7px 10px; font: inherit; font-size: 12px; font-weight: 740; cursor: pointer; }
    .action-button:hover { filter: brightness(0.96); }
    .action-button:disabled { opacity: 0.45; cursor: default; }
    .queue-state { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: min(760px, calc(100vw - 32px)); background: #111827; color: white; padding: 9px 12px; border-radius: 7px; box-shadow: 0 12px 28px rgba(17,24,39,0.22); opacity: 0; pointer-events: none; transition: opacity 160ms ease; z-index: 20; }
    .toast.show { opacity: 1; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background: #c6d1dc; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
    @media (max-width: 1400px) {
      .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      main { grid-template-columns: 290px minmax(0, 1fr); }
      .right-column { grid-column: 1 / -1; }
    }
    @media (max-width: 960px) {
      body { overflow: auto; }
      .app { height: auto; min-height: 100vh; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      main { grid-template-columns: 1fr; overflow: visible; }
      .detail-grid { grid-template-columns: 1fr; }
      .status { display: none; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div>
        <div class="brand">Mesh Dashboard</div>
        <div class="subtitle" id="workspace-label">Lade Workspace ...</div>
      </div>
      <div class="status">
        <span class="dot"></span>
        <span>Live-Ansicht aktiv. Mesh im Terminal bleibt benutzbar.</span>
      </div>
    </header>
    <div class="summary" id="summary"></div>
    <main>
      <div class="stack">
        <section class="card">
          <div class="section-head">
            <h2>Command Center</h2>
            <span class="status-badge">local</span>
          </div>
          <div class="list" id="actions"></div>
        </section>
        <section class="card">
          <div class="section-head">
            <h2>Signals</h2>
          </div>
          <div class="list" id="attention"></div>
        </section>
      </div>
      <div class="stack center-column">
        <section class="card graph-card">
          <div class="graph-head">
            <h2>Dependency Graph</h2>
            <div class="graph-tools">
              <div class="segmented" aria-label="Graph mode">
                <button type="button" data-graph-mode="focus" class="active">Focus</button>
                <button type="button" data-graph-mode="full">Full</button>
              </div>
              <div class="graph-meta" id="graph-meta"></div>
            </div>
          </div>
          <div class="graph-shell">
            <svg id="dependency-graph" class="graph-svg" viewBox="0 0 960 360" role="img" aria-label="Dependency graph"></svg>
          </div>
          <div class="legend">
            <span><i class="swatch" style="background:#0f766e"></i>source</span>
            <span><i class="swatch" style="background:#16a34a"></i>tests</span>
            <span><i class="swatch" style="background:#596579"></i>config</span>
            <span><i class="swatch" style="background:#f59e0b"></i>other</span>
          </div>
          <div class="package-grid" id="external-packages"></div>
        </section>
        <section class="card file-section">
          <div class="section-head">
            <h2>Dateien</h2>
            <span class="status-badge" id="file-count-label">0</span>
          </div>
          <div class="toolbar">
            <input id="search" type="search" placeholder="Dateien, Pfade, Komponenten suchen" />
            <select id="group">
              <option value="all">Alle</option>
              <option value="source">Source</option>
              <option value="tests">Tests</option>
              <option value="docs">Docs</option>
              <option value="config">Config</option>
              <option value="other">Sonstiges</option>
            </select>
          </div>
          <div class="detail-grid">
            <div>
              <div class="file-list" id="file-list"></div>
            </div>
            <div class="file-detail-panel">
              <div class="section-head">
                <h3>Dateidetails</h3>
              </div>
              <div id="file-detail" class="empty">Wähle links eine Datei aus.</div>
            </div>
          </div>
        </section>
      </div>
      <div class="stack right-column">
        <section class="card">
          <h2>Context Budget</h2>
          <div class="list" id="context-budget"></div>
        </section>
        <section class="card">
          <h2>Artifacts</h2>
          <div class="list" id="artifacts"></div>
        </section>
        <section class="card">
          <h2>Aktivität</h2>
          <div class="list" id="events"></div>
        </section>
        <section class="card">
          <h2>Repo-Regeln</h2>
          <div class="list" id="rules"></div>
        </section>
      </div>
    </main>
    <div class="toast" id="toast"></div>
  </div>
  <script>
    let currentState = null;
    let selectedFile = null;
    let graphMode = "focus";

    const summaryEl = document.getElementById("summary");
    const actionsEl = document.getElementById("actions");
    const attentionEl = document.getElementById("attention");
    const eventsEl = document.getElementById("events");
    const rulesEl = document.getElementById("rules");
    const contextBudgetEl = document.getElementById("context-budget");
    const artifactsEl = document.getElementById("artifacts");
    const fileListEl = document.getElementById("file-list");
    const fileDetailEl = document.getElementById("file-detail");
    const workspaceLabelEl = document.getElementById("workspace-label");
    const searchEl = document.getElementById("search");
    const groupEl = document.getElementById("group");
    const fileCountLabelEl = document.getElementById("file-count-label");
    const graphEl = document.getElementById("dependency-graph");
    const graphMetaEl = document.getElementById("graph-meta");
    const externalPackagesEl = document.getElementById("external-packages");
    const graphModeButtons = document.querySelectorAll("[data-graph-mode]");
    const toastEl = document.getElementById("toast");

    const groupColors = {
      source: "#0f766e",
      tests: "#16a34a",
      docs: "#7c3aed",
      config: "#596579",
      other: "#f59e0b"
    };

    let toastTimer = null;

    function esc(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function metricCard(label, value, meta) {
      return '<div class="card metric"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="meta">' + meta + '</div></div>';
    }

    function showToast(message) {
      if (!toastEl) return;
      toastEl.textContent = message;
      toastEl.classList.add("show");
      if (toastTimer) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(function() {
        toastEl.classList.remove("show");
      }, 2600);
    }

    function pillClass(status) {
      if (status === "healthy") return "ok";
      if (status === "watch") return "warn";
      return "danger";
    }

    function render() {
      if (!currentState) return;
      workspaceLabelEl.textContent = currentState.workspaceRoot;
      summaryEl.innerHTML = [
        metricCard("Health", currentState.health.score, currentState.health.status),
        metricCard("Files", currentState.summary.fileCount, currentState.summary.sourceCount + ' source / ' + currentState.summary.testCount + ' tests'),
        metricCard("Repairs", currentState.summary.repairs, currentState.summary.riskHotspots + ' Hotspots'),
        metricCard("Rules", currentState.summary.rules, currentState.summary.insights + ' Causal Insights'),
        metricCard("Discoveries", currentState.summary.discoveries, currentState.summary.forks + ' Forks'),
        metricCard("Ghost", currentState.summary.ghostConfidence == null ? 'n/a' : currentState.summary.ghostConfidence + '%', 'Repo-spezifische Arbeitsweise')
      ].join("");

      const latestByAction = new Map();
      (currentState.actionQueue || []).forEach(function(item) {
        if (!latestByAction.has(item.action)) latestByAction.set(item.action, item);
      });
      actionsEl.innerHTML = currentState.actions.map(function(action) {
        const latest = latestByAction.get(action.action);
        const status = latest ? '<span class="status-badge ' + esc(latest.status) + '">' + esc(latest.status) + '</span>' : '';
        const summary = latest && (latest.summary || latest.error) ? '<br>' + esc(latest.summary || latest.error) : '';
        return '<div class="item action-row"><div><strong>' + esc(action.label) + ' ' + status + '</strong><small>' + esc(action.detail) + summary + '</small></div><button class="action-button" data-action="' + esc(action.action) + '">' + (latest && latest.status === 'running' ? 'Running' : 'Run') + '</button></div>';
      }).join("");
      actionsEl.querySelectorAll("[data-action]").forEach(function(button) {
        if (button.textContent === "Running") button.disabled = true;
        button.addEventListener("click", function() {
          triggerAction(button.getAttribute("data-action"), button);
        });
      });

      const attention = [];
      attention.push('<div class="item"><strong>Health</strong><small><span class="pill ' + pillClass(currentState.health.status) + '">' + currentState.health.status + '</span> Score ' + currentState.health.score + '</small></div>');
      (currentState.actionQueue || []).slice(0, 4).forEach(function(action) {
        const detail = action.summary || action.error || action.createdAt || "";
        attention.push('<div class="item"><strong>' + esc(action.action) + ' <span class="status-badge ' + esc(action.status) + '">' + esc(action.status) + '</span></strong><small>' + esc(detail) + '</small></div>');
      });
      currentState.repairQueue.forEach(function(item) {
        attention.push('<div class="item"><strong>' + esc(item.summary || 'Repair candidate') + '</strong><small>' + esc((item.files || []).join(', ') || 'ohne Dateiangabe') + '</small></div>');
      });
      currentState.hotFiles.forEach(function(item) {
        attention.push('<div class="item"><strong>' + esc(item.file) + '</strong><small>' + esc((item.risks || []).join(', ') || 'Risk hotspot') + '</small></div>');
      });
      attentionEl.innerHTML = attention.length ? attention.join("") : '<div class="empty">Keine auffälligen Signale.</div>';

      eventsEl.innerHTML = currentState.events.length
        ? currentState.events.map(function(event) {
            return '<div class="item"><strong>' + esc(event.msg || event.type) + '</strong><small>' + esc([event.path, new Date(event.at).toLocaleTimeString()].filter(Boolean).join(' · ')) + '</small></div>';
          }).join("")
        : '<div class="empty">Noch keine Live-Aktivität.</div>';

      renderContextBudget();
      renderArtifacts();

      rulesEl.innerHTML = currentState.memoryRules.length
        ? currentState.memoryRules.map(function(rule) {
            return '<div class="item"><small>' + esc(rule) + '</small></div>';
          }).join("")
        : '<div class="empty">Noch keine Engineering-Memory-Regeln.</div>';

      renderGraph();
      renderFiles();
      renderDetail();
    }

    function compactNumber(value) {
      value = Number(value || 0);
      return value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k" : String(value);
    }

    function renderContextBudget() {
      const metrics = currentState.contextMetrics;
      if (!metrics || !metrics.report) {
        contextBudgetEl.innerHTML = '<div class="empty">Noch kein Modell-Call.</div>';
        return;
      }
      const report = metrics.report;
      contextBudgetEl.innerHTML = [
        '<div class="item"><strong>Sent estimate</strong><small>' + compactNumber(report.totalTokens) + ' / ' + compactNumber(report.maxInputTokens) + ' tokens</small></div>',
        '<div class="item"><strong>Tool catalog</strong><small>' + esc(report.toolsOut) + ' / ' + esc(report.toolsIn) + ' tools sent</small></div>',
        '<div class="item"><strong>Messages</strong><small>' + esc(report.messagesOut) + ' / ' + esc(report.messagesIn) + ' messages sent</small></div>',
        '<div class="item"><strong>Raw saved</strong><small>~' + compactNumber(metrics.rawTokensSavedEstimate || 0) + ' tokens via artifacts</small></div>'
      ].join("");
    }

    function renderArtifacts() {
      const artifacts = currentState.artifacts || [];
      artifactsEl.innerHTML = artifacts.length
        ? artifacts.slice(0, 6).map(function(artifact) {
            return '<div class="item"><strong>' + esc(artifact.toolName) + '</strong><small>' + esc(artifact.id) + '<br>' + esc(artifact.summary || '') + '</small></div>';
          }).join("")
        : '<div class="empty">Noch keine Tool-Artefakte.</div>';
    }

    function renderGraph() {
      const graph = currentState.dependencyGraph || { nodes: [], links: [], externalPackages: [] };
      const nodes = graph.nodes || [];
      const links = graph.links || [];
      graphMetaEl.textContent = nodes.length + " files / " + links.length + " links / " + new Date(currentState.liveUpdatedAt).toLocaleTimeString();
      externalPackagesEl.innerHTML = (graph.externalPackages || []).slice(0, 10).map(function(pkg) {
        return '<span class="pill warn">' + esc(pkg.name) + ' ' + pkg.count + '</span>';
      }).join("");

      const width = 960;
      const height = 390;
      const byId = new Map(nodes.map(function(node) { return [node.id, node]; }));
      if (graphMode === "focus" && selectedFile) {
        renderFocusGraph(graph, byId, width, height);
        return;
      }
      renderFullGraph(nodes, links, byId, width, height);
    }

    function renderFocusGraph(graph, byId, width, height) {
      const details = (graph.details && graph.details[selectedFile]) || { dependencies: [], dependents: [] };
      const left = (details.dependents || []).filter(function(file) { return byId.has(file); }).slice(0, 12);
      const right = (details.dependencies || []).filter(function(file) { return byId.has(file); }).slice(0, 12);
      const center = byId.get(selectedFile) || { id: selectedFile, label: selectedFile.split("/").pop(), group: "source", dependencies: 0, dependents: 0 };
      const focusNodes = [
        ...left.map(function(file) { return byId.get(file); }),
        center,
        ...right.map(function(file) { return byId.get(file); })
      ].filter(Boolean);

      function placeColumn(list, x) {
        const gap = Math.min(42, Math.max(24, (height - 92) / Math.max(1, list.length - 1)));
        const start = height / 2 - gap * (list.length - 1) / 2;
        list.forEach(function(node, index) {
          node.x = x;
          node.y = start + index * gap;
        });
      }
      const leftNodes = left.map(function(file) { return byId.get(file); }).filter(Boolean);
      const rightNodes = right.map(function(file) { return byId.get(file); }).filter(Boolean);
      placeColumn(leftNodes, 170);
      center.x = width / 2;
      center.y = height / 2;
      placeColumn(rightNodes, width - 230);

      const focusLinks = [
        ...left.map(function(file) { return { source: file, target: selectedFile }; }),
        ...right.map(function(file) { return { source: selectedFile, target: file }; })
      ];
      drawGraph(focusNodes, focusLinks, byId, [
        { label: "Imported by", x: 120 },
        { label: "Selected", x: width / 2 - 26 },
        { label: "Imports", x: width - 266 }
      ]);
    }

    function renderFullGraph(nodes, links, byId, width, height) {
      const groups = ["source", "tests", "config", "docs", "other"];
      const groupBuckets = {};
      groups.forEach(function(group) { groupBuckets[group] = []; });
      nodes.forEach(function(node) {
        (groupBuckets[node.group] || groupBuckets.other).push(node);
      });
      groups.forEach(function(group, groupIndex) {
        const bucket = groupBuckets[group].sort(function(a, b) {
          return (b.dependents + b.dependencies) - (a.dependents + a.dependencies) || a.id.localeCompare(b.id);
        }).slice(0, 36);
        const x = 90 + groupIndex * 195;
        bucket.forEach(function(node, index) {
          const col = index % 2;
          const row = Math.floor(index / 2);
          const rows = Math.max(1, Math.ceil(bucket.length / 2));
          node.x = x + col * 58;
          node.y = 42 + row * ((height - 78) / rows);
        });
      });
      const visible = new Set(nodes.filter(function(node) { return Number.isFinite(node.x) && Number.isFinite(node.y); }).map(function(node) { return node.id; }));
      drawGraph(
        nodes.filter(function(node) { return visible.has(node.id); }),
        links.filter(function(link) { return visible.has(link.source) && visible.has(link.target); }),
        byId,
        groups.map(function(group, index) { return { label: group, x: 62 + index * 195 }; })
      );
    }

    function drawGraph(nodes, links, byId, labels) {
      const activeIds = new Set([selectedFile]);
      links.forEach(function(link) {
        if (link.source === selectedFile) activeIds.add(link.target);
        if (link.target === selectedFile) activeIds.add(link.source);
      });

      const linkMarkup = links.map(function(link) {
        const source = byId.get(link.source);
        const target = byId.get(link.target);
        if (!source || !target) return "";
        const active = link.source === selectedFile || link.target === selectedFile ? " active" : "";
        return '<line class="graph-link' + active + '" x1="' + source.x + '" y1="' + source.y + '" x2="' + target.x + '" y2="' + target.y + '"></line>';
      }).join("");

      const nodeMarkup = nodes.map(function(node) {
        const isActive = node.id === selectedFile;
        const isDim = selectedFile && !activeIds.has(node.id);
        const radius = Math.max(7, Math.min(18, 8 + node.dependents + node.dependencies));
        const label = node.label.length > 22 ? node.label.slice(0, 19) + "..." : node.label;
        return '<g class="graph-node' + (isActive ? ' active' : '') + (isDim ? ' dim' : '') + '" data-file="' + esc(node.id) + '" transform="translate(' + node.x + ',' + node.y + ')">'
          + '<circle r="' + radius + '" fill="' + (groupColors[node.group] || groupColors.other) + '"></circle>'
          + '<text x="' + (radius + 7) + '" y="4">' + esc(label) + '</text>'
          + '</g>';
      }).join("");

      const labelMarkup = (labels || []).map(function(label) {
        return '<text class="graph-column-label" x="' + label.x + '" y="24">' + esc(label.label) + '</text>';
      }).join("");
      graphEl.innerHTML = labelMarkup + linkMarkup + nodeMarkup;
      graphEl.querySelectorAll(".graph-node").forEach(function(node) {
        node.addEventListener("click", function() {
          selectedFile = node.getAttribute("data-file");
          render();
        });
      });
    }

    async function triggerAction(action, button) {
      if (!action) return;
      button.disabled = true;
      button.textContent = "Running";
      showToast("Running " + action + "...");
      const response = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      }).catch(function(error) {
        return { ok: false, json: function() { return Promise.resolve({ ok: false, error: error.message }); } };
      });
      const payload = await response.json().catch(function() { return { ok: false, error: "invalid response" }; });
      if (payload.ok) {
        showToast((payload.request && payload.request.summary) ? payload.request.summary : action + " complete");
      } else {
        showToast(payload.error || action + " failed");
      }
      button.disabled = false;
      button.textContent = "Run";
      await refresh();
    }

    function allFiles() {
      if (!currentState) return [];
      return Object.entries(currentState.groupedFiles).flatMap(function(entry) {
        return entry[1].map(function(file) {
          return { group: entry[0], file: file };
        });
      });
    }

    function renderFiles() {
      const query = searchEl.value.trim().toLowerCase();
      const group = groupEl.value;
      const files = allFiles().filter(function(entry) {
        return (group === 'all' || entry.group === group) && (!query || entry.file.toLowerCase().includes(query));
      }).slice(0, 200);
      fileCountLabelEl.textContent = files.length + " shown";
      fileListEl.innerHTML = files.length
        ? files.map(function(entry) {
            const active = selectedFile === entry.file ? ' active' : '';
            return '<div class="file-row' + active + '" data-file="' + esc(entry.file) + '" data-group="' + esc(entry.group) + '"><div class="path">' + esc(entry.file) + '</div><div class="meta">' + esc(entry.group) + '</div></div>';
          }).join("")
        : '<div class="empty">Keine Dateien für diesen Filter.</div>';
      fileListEl.querySelectorAll(".file-row").forEach(function(node) {
        node.addEventListener("click", function() {
          selectedFile = node.getAttribute("data-file");
          renderFiles();
          renderDetail();
        });
      });
    }

    function renderDetail() {
      if (!currentState || !selectedFile) {
        fileDetailEl.innerHTML = '<div class="empty">Wähle links eine Datei aus.</div>';
        return;
      }
      const hot = currentState.hotFiles.find(function(item) { return item.file === selectedFile; });
      const recentEvent = currentState.events.find(function(event) { return event.path === selectedFile || (event.path || '').endsWith(selectedFile); });
      const graphDetails = (currentState.dependencyGraph && currentState.dependencyGraph.details && currentState.dependencyGraph.details[selectedFile]) || { dependencies: [], dependents: [], externalImports: [] };
      function miniList(title, values) {
        return '<div class="item"><strong>' + esc(title) + '</strong><small>' + (values.length ? values.slice(0, 8).map(esc).join('<br>') : 'none') + '</small></div>';
      }
      fileDetailEl.innerHTML = [
        '<div class="list">',
        '<div class="item"><strong>' + esc(selectedFile) + '</strong><small>Pfad im Workspace</small></div>',
        '<div class="dependency-list">',
        miniList('Imports', graphDetails.dependencies || []),
        miniList('Imported by', graphDetails.dependents || []),
        '</div>',
        miniList('Packages', graphDetails.externalImports || []),
        '<div class="item"><strong>Risk</strong><small>' + esc(hot ? (hot.risks || []).join(', ') || 'markiert' : 'keine aktuellen Signale') + '</small></div>',
        '<div class="item"><strong>Letzte Aktivität</strong><small>' + esc(recentEvent ? ((recentEvent.msg || recentEvent.type) + ' · ' + new Date(recentEvent.at).toLocaleTimeString()) : 'keine Live-Aktivität für diese Datei') + '</small></div>',
        '</div>'
      ].join('');
    }

    async function refresh() {
      const response = await fetch('/api/state', { cache: 'no-store' });
      currentState = await response.json();
      if (!selectedFile) {
        const firstSource = currentState.groupedFiles.source[0] || currentState.groupedFiles.tests[0] || currentState.groupedFiles.docs[0] || null;
        selectedFile = firstSource;
      }
      render();
    }

    searchEl.addEventListener('input', renderFiles);
    groupEl.addEventListener('change', renderFiles);
    graphModeButtons.forEach(function(button) {
      button.addEventListener('click', function() {
        graphMode = button.getAttribute('data-graph-mode') || 'focus';
        graphModeButtons.forEach(function(other) { other.classList.toggle('active', other === button); });
        renderGraph();
      });
    });
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

main().catch((error) => {
  process.stderr.write(`dashboard-server failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
