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
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Mesh</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#f7f8fa;
  --surface:#ffffff;
  --surface2:#f2f4f7;
  --surface3:#eaecf0;
  --border:#e2e6eb;
  --border2:#cdd3db;
  --text:#111827;
  --text2:#374151;
  --muted:#6b7a8d;
  --dim:#9aa5b4;
  --accent:#0d9488;
  --accent2:#0f766e;
  --accent3:#134e4a;
  --accent-bg:#f0fdfa;
  --accent-border:#99f6e4;
  --warn:#d97706;
  --warn-bg:#fffbeb;
  --warn-border:#fcd34d;
  --danger:#dc2626;
  --danger-bg:#fff1f1;
  --danger-border:#fca5a5;
  --ok:#059669;
  --ok-bg:#f0fdf4;
  --ok-border:#6ee7b7;
  --sans:'Figtree',system-ui,sans-serif;
  --mono:'JetBrains Mono',monospace;
  --shadow-xs:0 1px 2px rgba(17,24,39,0.05);
  --shadow-sm:0 1px 3px rgba(17,24,39,0.08),0 1px 2px rgba(17,24,39,0.04);
  --shadow-md:0 4px 6px -1px rgba(17,24,39,0.07),0 2px 4px -1px rgba(17,24,39,0.04);
  --r:7px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{font:13px/1.5 var(--sans);color:var(--text);background:var(--bg);}

/* ── LAYOUT ─────────────────────────────── */
#app{height:100vh;display:grid;grid-template-rows:52px 76px minmax(0,1fr)}

/* ── HEADER ─────────────────────────────── */
#header{display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:var(--surface);border-bottom:1px solid var(--border);box-shadow:var(--shadow-xs)}
.brand{font-family:var(--sans);font-size:16px;font-weight:700;color:var(--text);letter-spacing:-0.01em}
.brand-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent);margin-left:2px;vertical-align:middle;position:relative;top:-1px}
.header-center{flex:1;display:flex;justify-content:center}
#ws-path{font:12px var(--mono);color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:3px 10px;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-right{display:flex;align-items:center;gap:12px}
.live-badge{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);font-weight:500}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 2px var(--ok-bg);animation:pulse 2.5s ease infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 2px var(--ok-bg)}50%{box-shadow:0 0 0 4px var(--ok-border)}}
#refresh-clock{font:12px var(--mono);color:var(--dim)}

/* ── METRICS BAR ────────────────────────── */
#metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;border-bottom:1px solid var(--border);background:var(--surface)}
.metric{padding:12px 20px;border-right:1px solid var(--border);cursor:default;transition:background 120ms;position:relative}
.metric:last-child{border-right:none}
.metric:hover{background:var(--surface2)}
.metric-label{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.07em}
.metric-value{font-size:24px;font-weight:700;color:var(--text);line-height:1.1;margin-top:2px;font-variant-numeric:tabular-nums;font-family:var(--sans);letter-spacing:-0.02em;transition:color 300ms}
.metric-value.flash{color:var(--accent)}
.metric-sub{font-size:11px;color:var(--muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.metric.health-ok .metric-value{color:var(--ok)}
.metric.health-ok::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--ok)}
.metric.health-warn .metric-value{color:var(--warn)}
.metric.health-warn::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--warn)}
.metric.health-bad .metric-value{color:var(--danger)}
.metric.health-bad::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--danger)}

/* ── MAIN GRID ──────────────────────────── */
#main{display:grid;grid-template-columns:264px minmax(0,1fr) 272px;background:var(--bg);overflow:hidden;min-height:0}
.col{overflow:hidden;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--surface);min-height:0}
.col:last-child{border-right:none}
#graph-col{background:var(--surface);min-height:0}

/* ── PANELS ─────────────────────────────── */
.panel{border-bottom:1px solid var(--border);padding:14px 16px}
.panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.panel-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em}
.panel-scroll{overflow-y:auto;flex:1;min-height:0}
.panel-scroll::-webkit-scrollbar{width:4px}
.panel-scroll::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}

/* ── COMMAND CENTER ─────────────────────── */
.cmd-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 11px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:6px;background:var(--surface);transition:border-color 140ms,box-shadow 140ms}
.cmd-item:hover{border-color:var(--border2);box-shadow:var(--shadow-xs)}
.cmd-item:last-child{margin-bottom:0}
.cmd-label{font-size:12px;font-weight:700;color:var(--accent2);font-family:var(--mono)}
.cmd-detail{font-size:11px;color:var(--muted);margin-top:1px;line-height:1.4}
.cmd-result{font-size:11px;color:var(--text2);margin-top:3px;font-style:italic}
.run-btn{flex-shrink:0;background:var(--surface);border:1px solid var(--border2);color:var(--text2);padding:5px 12px;border-radius:5px;font:600 11px var(--sans);cursor:pointer;letter-spacing:0;transition:all 120ms;white-space:nowrap}
.run-btn:hover:not(:disabled){background:var(--accent);border-color:var(--accent);color:#fff;box-shadow:var(--shadow-sm)}
.run-btn:disabled{opacity:0.4;cursor:default}
.run-btn.spinning{color:var(--warn);border-color:var(--warn-border)}
@keyframes spin-text{0%,100%{opacity:1}50%{opacity:0.35}}
.run-btn.spinning{animation:spin-text 0.9s ease infinite}

/* ── SIGNALS ────────────────────────────── */
.sig-item{padding:8px 10px;border:1px solid var(--border);border-left:3px solid var(--border2);margin-bottom:6px;background:var(--surface);border-radius:0 var(--r) var(--r) 0;transition:box-shadow 120ms}
.sig-item:hover{box-shadow:var(--shadow-xs)}
.sig-item.ok{border-left-color:var(--ok);background:var(--ok-bg)}
.sig-item.warn{border-left-color:var(--warn);background:var(--warn-bg)}
.sig-item.danger{border-left-color:var(--danger);background:var(--danger-bg)}
.sig-item:last-child{margin-bottom:0}
.sig-title{font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sig-sub{font-size:11px;color:var(--muted);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}

/* ── GRAPH ──────────────────────────────── */
#graph-col{flex:1;min-height:0;display:flex;flex-direction:column}
#graph-toolbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}
#graph-meta{font:11px var(--mono);color:var(--dim)}
.seg{display:flex;border:1px solid var(--border2);border-radius:5px;overflow:hidden;background:var(--surface2)}
.seg button{background:transparent;border:none;padding:4px 11px;font:600 11px var(--sans);color:var(--muted);cursor:pointer;transition:background 100ms,color 100ms}
.seg button.active{background:var(--surface);color:var(--accent2);box-shadow:var(--shadow-xs)}
#graph-wrap{flex:1;min-height:0;position:relative;overflow:hidden;cursor:grab;background:var(--surface)}
#graph-wrap:active{cursor:grabbing}
#graph-wrap::before{content:'';position:absolute;inset:0;background-image:radial-gradient(circle,var(--border) 1px,transparent 1px);background-size:20px 20px;opacity:0.5;pointer-events:none}
#graph-wrap.zoom-hint::after{content:'scroll to zoom · drag to pan';position:absolute;bottom:10px;right:14px;font:11px var(--sans);color:var(--dim);pointer-events:none}
#graph-svg{width:100%;height:100%;display:block;position:relative;z-index:1}
.g-link{stroke:var(--border2);stroke-width:1.5;opacity:0.7}
.g-link.lit{stroke:var(--accent);opacity:1;stroke-width:2}
.g-node{cursor:pointer}
.g-node circle{transition:r 180ms}
.g-node:hover circle{opacity:0.85}
.g-node.active circle{stroke-width:2.5}
.g-node.dim{opacity:0.2}
.g-node text{font:11px var(--sans);fill:var(--muted);paint-order:stroke;stroke:#fff;stroke-width:4px}
.g-node.active text,.g-node:hover text{fill:var(--text);font-weight:600}
.g-col-label{font:600 10px var(--sans);fill:var(--dim);text-transform:uppercase;letter-spacing:0.07em}
#graph-files-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);border-top:1px solid var(--border);flex-shrink:0;height:220px;min-height:180px}
#file-col{background:var(--surface);display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--border)}
#file-toolbar{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
#file-search{flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:5px 9px;font:12px var(--sans);color:var(--text);outline:none;transition:border-color 120ms,box-shadow 120ms}
#file-search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(13,148,136,0.12)}
#file-search::placeholder{color:var(--dim)}
#file-group{background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:5px 7px;font:12px var(--sans);color:var(--muted);outline:none;cursor:pointer}
#file-count{font:11px var(--sans);color:var(--dim);padding:4px 12px;flex-shrink:0}
#file-list{overflow-y:auto;flex:1;padding:4px 8px 8px}
#file-list::-webkit-scrollbar{width:4px}
#file-list::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
.file-row{padding:5px 8px;border-radius:5px;cursor:pointer;font:12px var(--sans);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background 80ms,color 80ms}
.file-row:hover{background:var(--surface2);color:var(--text)}
.file-row.active{background:var(--accent-bg);color:var(--accent2);font-weight:600}
.file-row .fgroup{font-size:10px;color:var(--dim);margin-left:5px;font-family:var(--mono)}
#detail-col{background:var(--surface2);overflow-y:auto;padding:12px 14px}
#detail-col::-webkit-scrollbar{width:4px}
#detail-col::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
.detail-title{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:8px}
.detail-path{font:12px var(--mono);color:var(--accent2);word-break:break-all;margin-bottom:12px;line-height:1.5}
.detail-section{margin-bottom:10px}
.detail-section-head{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:5px}
.detail-pill{display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font:11px var(--mono);color:var(--text2);margin:2px 2px 2px 0}
.detail-pill.pkg{border-color:var(--warn-border);color:var(--warn);background:var(--warn-bg)}
.detail-pill.risk{border-color:var(--danger-border);color:var(--danger);background:var(--danger-bg)}
.detail-empty{font-size:12px;color:var(--dim)}

/* ── RIGHT COLUMN ───────────────────────── */
#right-col{display:flex;flex-direction:column;overflow:hidden;background:var(--surface)}
.rpanel{flex-shrink:0;padding:14px 16px;border-bottom:1px solid var(--border)}
.rpanel-title{font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px}
.rpanel-scroll{overflow-y:auto;max-height:160px}
.rpanel-scroll::-webkit-scrollbar{width:3px}
.rpanel-scroll::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}

/* ── CONTEXT BUDGET ─────────────────────── */
.budget-bar-wrap{margin:6px 0 10px}
.budget-bar-label{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:5px}
.budget-bar-label span:last-child{font-family:var(--mono);font-size:11px}
.budget-bar{height:5px;background:var(--surface3);border-radius:3px;overflow:hidden}
.budget-bar-fill{height:100%;border-radius:3px;background:var(--accent);transition:width 700ms ease}
.budget-bar-fill.warn{background:var(--warn)}
.budget-bar-fill.danger{background:var(--danger)}
.budget-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px}
.budget-row:last-child{border-bottom:none}
.budget-row-label{color:var(--muted)}
.budget-row-val{color:var(--text);font-weight:600;font-family:var(--mono);font-size:11px}

/* ── EVENTS ─────────────────────────────── */
.ev-item{padding:6px 0;border-bottom:1px solid var(--border);font-size:12px}
.ev-item:last-child{border-bottom:none}
.ev-msg{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ev-meta{font:11px var(--mono);color:var(--dim);margin-top:1px}
.ev-item.new .ev-msg{color:var(--accent2)}

/* ── ARTIFACTS ──────────────────────────── */
.art-item{padding:7px 9px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);margin-bottom:5px}
.art-item:last-child{margin-bottom:0}
.art-name{font:600 12px var(--sans);color:var(--accent2)}
.art-id{font:11px var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.art-sum{font-size:11px;color:var(--muted);margin-top:3px}

/* ── RULES ──────────────────────────────── */
.rule-item{padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2);line-height:1.4}
.rule-item:last-child{border-bottom:none}

/* ── PACKAGES ───────────────────────────── */
#pkg-row{display:flex;flex-wrap:wrap;gap:5px;padding:8px 16px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface2)}
.pkg-tag{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font:11px var(--mono);color:var(--muted);cursor:default;transition:border-color 120ms,color 120ms}
.pkg-tag:hover{border-color:var(--accent-border);color:var(--accent2)}
.pkg-tag b{font-weight:700;color:var(--text2)}

/* ── BADGES ─────────────────────────────── */
.badge{display:inline-flex;align-items:center;border-radius:4px;padding:2px 7px;font:600 10px var(--sans);letter-spacing:0.02em}
.badge.ok{background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok-border)}
.badge.warn{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-border)}
.badge.danger{background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger-border)}
.badge.info{background:var(--accent-bg);color:var(--accent2);border:1px solid var(--accent-border)}
.badge.neutral{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}

/* ── ZOOM RESET BTN ─────────────────────── */
#zoom-reset{background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:4px 10px;font:11px var(--sans);color:var(--muted);cursor:pointer;transition:all 120ms}
#zoom-reset:hover{border-color:var(--border2);color:var(--text)}

/* ── TOAST ──────────────────────────────── */
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%) translateY(8px);background:var(--text);color:#fff;padding:9px 16px;border-radius:var(--r);font:500 12px var(--sans);box-shadow:var(--shadow-md);opacity:0;pointer-events:none;transition:opacity 150ms,transform 150ms;z-index:100;white-space:nowrap}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.err{background:var(--danger)}

/* ── EMPTY ──────────────────────────────── */
.empty{font-size:12px;color:var(--dim);padding:6px 0}

/* ── SCROLLBARS ─────────────────────────── */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
::-webkit-scrollbar-track{background:transparent}

/* ── RESPONSIVE ─────────────────────────── */
@media(max-width:1200px){
  #metrics{grid-template-columns:repeat(3,minmax(0,1fr))}
  #main{grid-template-columns:240px minmax(0,1fr) 248px}
}
@media(max-width:900px){
  body{overflow:auto}
  #app{height:auto;grid-template-rows:52px 76px auto}
  #main{grid-template-columns:1fr}
  #graph-files-row{max-height:none;grid-template-columns:1fr}
  #right-col{display:none}
}
</style>
</head>
<body>
<div id="app">

<header id="header">
  <div class="brand">mesh<span class="brand-dot"></span></div>
  <div class="header-center">
    <div id="ws-path"></div>
  </div>
  <div class="header-right">
    <div class="live-badge"><span class="live-dot"></span><span>live</span></div>
    <div id="refresh-clock">--:--:--</div>
  </div>
</header>

<div id="metrics">
  <div class="metric" id="m-health"><div class="metric-label">Health</div><div class="metric-value" id="mv-health">--</div><div class="metric-sub" id="ms-health"></div></div>
  <div class="metric" id="m-files"><div class="metric-label">Files</div><div class="metric-value" id="mv-files">--</div><div class="metric-sub" id="ms-files"></div></div>
  <div class="metric" id="m-repairs"><div class="metric-label">Repairs</div><div class="metric-value" id="mv-repairs">--</div><div class="metric-sub" id="ms-repairs"></div></div>
  <div class="metric" id="m-rules"><div class="metric-label">Rules</div><div class="metric-value" id="mv-rules">--</div><div class="metric-sub" id="ms-rules"></div></div>
  <div class="metric" id="m-disco"><div class="metric-label">Discoveries</div><div class="metric-value" id="mv-disco">--</div><div class="metric-sub" id="ms-disco"></div></div>
  <div class="metric" id="m-ghost"><div class="metric-label">Ghost</div><div class="metric-value" id="mv-ghost">--</div><div class="metric-sub" id="ms-ghost">Repo style</div></div>
</div>

<div id="main">

  <!-- LEFT -->
  <div class="col">
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Commands</span><span class="badge neutral" id="cmd-mode">local</span></div>
      <div id="actions"></div>
    </div>
    <div class="panel" style="flex:1;min-height:0;overflow-y:auto">
      <div class="panel-head"><span class="panel-title">Signals</span></div>
      <div id="signals"></div>
    </div>
  </div>

  <!-- CENTER -->
  <div class="col" id="graph-col">
    <div id="graph-toolbar">
      <div id="graph-meta"></div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="seg" id="graph-mode-seg">
          <button data-mode="focus" class="active">Focus</button>
          <button data-mode="full">Full</button>
        </div>
        <button id="zoom-reset">Reset</button>
      </div>
    </div>
    <div id="graph-wrap" class="zoom-hint">
      <svg id="graph-svg" role="img" aria-label="Dependency graph"></svg>
    </div>
    <div id="pkg-row"></div>
    <div id="graph-files-row">
      <div id="file-col">
        <div id="file-toolbar">
          <input id="file-search" type="search" placeholder="Search files…"/>
          <select id="file-group">
            <option value="all">All</option>
            <option value="source">Source</option>
            <option value="tests">Tests</option>
            <option value="docs">Docs</option>
            <option value="config">Config</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div id="file-count"></div>
        <div id="file-list"></div>
      </div>
      <div id="detail-col">
        <div class="detail-title">File Details</div>
        <div id="file-detail" class="detail-empty">Select a file</div>
      </div>
    </div>
  </div>

  <!-- RIGHT -->
  <div class="col" id="right-col">
    <div class="rpanel">
      <div class="rpanel-title">Context Budget</div>
      <div id="context-budget"></div>
    </div>
    <div class="rpanel">
      <div class="panel-head"><span class="rpanel-title" style="margin-bottom:0">Artifacts</span><span id="art-count" class="badge neutral">0</span></div>
      <div class="rpanel-scroll" id="artifacts"></div>
    </div>
    <div class="rpanel" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column">
      <div class="rpanel-title" style="flex-shrink:0">Activity</div>
      <div class="rpanel-scroll" style="flex:1;min-height:0;overflow-y:auto;max-height:none" id="events"></div>
    </div>
    <div class="rpanel">
      <div class="rpanel-title">Repo Rules</div>
      <div class="rpanel-scroll" id="rules"></div>
    </div>
  </div>

</div>
</div>
<div id="toast"></div>

<script>
(function(){
'use strict';

// ── state ──────────────────────────────────────────
let state=null, selFile=null, graphMode='focus';
let graphPan={x:0,y:0}, graphZoom=1, dragging=false, dragStart={x:0,y:0,px:0,py:0};
let toastTimer=null, evSeenIds=new Set();

const GRP_COLOR={source:'#0d9488',tests:'#059669',docs:'#7c3aed',config:'#6b7a8d',other:'#d97706'};

// ── utils ───────────────────────────────────────────
function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function $(id){return document.getElementById(id);}
function compact(n){n=Number(n||0);return n>=1e6?(n/1e6).toFixed(1)+'m':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);}
function pct(a,b){return b>0?Math.round(a/b*100):0;}

function toast(msg,err){
  var el=$('toast'); if(!el)return;
  el.textContent=msg; el.className='show'+(err?' err':'');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){el.className='';},2800);
}

// ── metric flash ────────────────────────────────────
function setMetric(id,val,sub,cls){
  var mv=$('mv-'+id), ms=$('ms-'+id), mc=$('m-'+id);
  var v=String(val);
  if(mv && mv.textContent!==v){
    mv.textContent=v;
    mv.classList.add('flash');
    setTimeout(function(){mv.classList.remove('flash');},600);
  }
  if(ms && sub!=null) ms.textContent=sub;
  if(mc && cls){mc.className='metric '+cls;}
}

// ── render metrics bar ───────────────────────────────
function renderMetrics(){
  if(!state)return;
  var h=state.health, s=state.summary;
  var hcls=h.status==='healthy'?'health-ok':h.status==='watch'?'health-warn':'health-bad';
  setMetric('health',h.score,h.status,hcls);
  setMetric('files',compact(s.fileCount),s.sourceCount+' src / '+s.testCount+' tests');
  setMetric('repairs',s.repairs,s.riskHotspots+' hotspots');
  setMetric('rules',s.rules,s.insights+' causal insights');
  setMetric('disco',s.discoveries,s.forks+' forks');
  setMetric('ghost',s.ghostConfidence==null?'n/a':s.ghostConfidence+'%');
}

// ── render command center ────────────────────────────
function renderActions(){
  var el=$('actions'); if(!el||!state)return;
  var latest={};
  (state.actionQueue||[]).forEach(function(item){if(!latest[item.action])latest[item.action]=item;});
  el.innerHTML=state.actions.map(function(a){
    var q=latest[a.action], running=q&&q.status==='running';
    var badge=q?'<span class="badge '+(q.status==='done'?'ok':q.status==='error'?'danger':q.status==='running'?'info':'neutral')+'">'+esc(q.status)+'</span>':'';
    var res=q&&(q.summary||q.error)?'<div class="cmd-result">'+esc(q.summary||q.error)+'</div>':'';
    return '<div class="cmd-item">'
      +'<div><div class="cmd-label">'+esc(a.label)+' '+badge+'</div>'
      +'<div class="cmd-detail">'+esc(a.detail)+'</div>'+res+'</div>'
      +'<button class="run-btn'+(running?' spinning':'')+'" data-action="'+esc(a.action)+'"'+(running?' disabled':'')+'>'+( running?'···':'RUN')+'</button>'
      +'</div>';
  }).join('');
  el.querySelectorAll('[data-action]').forEach(function(btn){
    btn.addEventListener('click',function(){runAction(btn.dataset.action,btn);});
  });
}

// ── render signals ───────────────────────────────────
function renderSignals(){
  var el=$('signals'); if(!el||!state)return;
  var items=[];
  var hcls=state.health.status==='healthy'?'ok':state.health.status==='watch'?'warn':'danger';
  items.push('<div class="sig-item '+hcls+'"><div class="sig-title">Health score: '+state.health.score+'</div><div class="sig-sub">status: '+esc(state.health.status)+'</div></div>');
  (state.repairQueue||[]).forEach(function(item){
    items.push('<div class="sig-item warn"><div class="sig-title">'+esc(item.summary||'Repair candidate')+'</div><div class="sig-sub">'+esc((item.files||[]).join(', ')||'—')+'</div></div>');
  });
  (state.hotFiles||[]).forEach(function(item){
    items.push('<div class="sig-item danger"><div class="sig-title">'+esc(item.file)+'</div><div class="sig-sub">'+esc((item.risks||[]).join(', ')||'risk hotspot')+'</div></div>');
  });
  (state.actionQueue||[]).slice(0,4).forEach(function(item){
    if(item.status==='done'||item.status==='running'){
      var detail=item.summary||item.error||item.createdAt||'';
      items.push('<div class="sig-item '+(item.status==='done'?'ok':'info')+' sig-item"><div class="sig-title">'+esc(item.action)+' · '+esc(item.status)+'</div><div class="sig-sub">'+esc(detail)+'</div></div>');
    }
  });
  el.innerHTML=items.length?items.join(''):'<div class="empty">No signals.</div>';
}

// ── render events ────────────────────────────────────
function renderEvents(){
  var el=$('events'); if(!el||!state)return;
  if(!state.events.length){el.innerHTML='<div class="empty">No activity yet.</div>';return;}
  el.innerHTML=state.events.slice(0,40).map(function(ev){
    var isNew=!evSeenIds.has(ev.id);
    evSeenIds.add(ev.id);
    return '<div class="ev-item'+(isNew?' new':'')+'"><div class="ev-msg">'+esc(ev.msg||ev.type)+'</div>'
      +'<div class="ev-meta">'+esc([ev.path,new Date(ev.at).toLocaleTimeString()].filter(Boolean).join(' · '))+'</div></div>';
  }).join('');
}

// ── render context budget ────────────────────────────
function renderBudget(){
  var el=$('context-budget'); if(!el||!state)return;
  var m=state.contextMetrics;
  if(!m||!m.report){el.innerHTML='<div class="empty">No model call yet.</div>';return;}
  var r=m.report;
  var used=Number(r.totalTokens||0), max=Number(r.maxInputTokens||0);
  var p=pct(used,max), fillCls=p>80?'danger':p>60?'warn':'';
  el.innerHTML='<div class="budget-bar-wrap"><div class="budget-bar-label"><span>tokens used</span><span>'+compact(used)+' / '+compact(max)+'</span></div>'
    +'<div class="budget-bar"><div class="budget-bar-fill '+fillCls+'" style="width:'+Math.min(100,p)+'%"></div></div></div>'
    +'<div class="budget-row"><span class="budget-row-label">Tools</span><span class="budget-row-val">'+esc(r.toolsOut)+'/'+esc(r.toolsIn)+'</span></div>'
    +'<div class="budget-row"><span class="budget-row-label">Messages</span><span class="budget-row-val">'+esc(r.messagesOut)+'/'+esc(r.messagesIn)+'</span></div>'
    +'<div class="budget-row"><span class="budget-row-label">Saved</span><span class="budget-row-val">~'+compact(m.rawTokensSavedEstimate||0)+' tkns</span></div>';
}

// ── render artifacts ─────────────────────────────────
function renderArtifacts(){
  var el=$('artifacts'),cnt=$('art-count'); if(!el||!state)return;
  var arts=state.artifacts||[];
  cnt.textContent=arts.length;
  el.innerHTML=arts.length?arts.slice(0,8).map(function(a){
    return '<div class="art-item"><div class="art-name">'+esc(a.toolName)+'</div>'
      +'<div class="art-id">'+esc(a.id)+'</div>'
      +(a.summary?'<div class="art-sum">'+esc(a.summary)+'</div>':'')+'</div>';
  }).join(''):'<div class="empty">No artifacts yet.</div>';
}

// ── render rules ─────────────────────────────────────
function renderRules(){
  var el=$('rules'); if(!el||!state)return;
  el.innerHTML=(state.memoryRules||[]).length
    ?(state.memoryRules||[]).map(function(r){return '<div class="rule-item">'+esc(r)+'</div>';}).join('')
    :'<div class="empty">No memory rules yet.</div>';
}

// ── graph ────────────────────────────────────────────
var graphViewW=960, graphViewH=400;
var graphNodes=[], graphLinks=[], graphById={};

function svgEl(tag,attrs){
  var el=document.createElementNS('http://www.w3.org/2000/svg',tag);
  Object.entries(attrs||{}).forEach(function(kv){el.setAttribute(kv[0],kv[1]);});
  return el;
}

function renderGraph(){
  if(!state)return;
  var g=state.dependencyGraph||{nodes:[],links:[],externalPackages:[]};
  var nodes=g.nodes||[], links=g.links||[];
  $('graph-meta').textContent=nodes.length+' files · '+links.length+' links · '+new Date(state.liveUpdatedAt).toLocaleTimeString();
  var pkgRow=$('pkg-row');
  pkgRow.innerHTML=(g.externalPackages||[]).slice(0,14).map(function(p){
    return '<span class="pkg-tag">'+esc(p.name)+' <b>'+p.count+'</b></span>';
  }).join('');

  var byId={};
  nodes.forEach(function(n){byId[n.id]=n;});
  graphById=byId;

  if(graphMode==='focus'&&selFile){buildFocusLayout(g,nodes,links,byId);}
  else{buildFullLayout(nodes,links,byId);}
}

function buildFocusLayout(g,nodes,links,byId){
  var det=(g.details&&g.details[selFile])||{dependencies:[],dependents:[]};
  var left=(det.dependents||[]).filter(function(f){return byId[f];}).slice(0,8);
  var right=(det.dependencies||[]).filter(function(f){return byId[f];}).slice(0,8);
  var center=byId[selFile]||{id:selFile,label:(selFile||'').split('/').pop(),group:'source',dependencies:0,dependents:0};

  function col(list,x){
    var minGap=56, gap=Math.max(minGap,Math.min(80,(graphViewH-100)/Math.max(1,list.length-1)));
    var totalH=gap*(list.length-1);
    var start=Math.max(60,graphViewH/2-totalH/2);
    list.forEach(function(f,i){var n=byId[f];if(n){n.x=x;n.y=start+i*gap;}});
  }
  var lx=Math.round(graphViewW*0.18);
  var rx=Math.round(graphViewW*0.82);
  col(left,lx); col(right,rx);
  center.x=graphViewW/2; center.y=graphViewH/2;

  var focusNodes=[center,...left.map(function(f){return byId[f];}),...right.map(function(f){return byId[f];})].filter(Boolean);
  var focusLinks=[
    ...left.map(function(f){return{source:f,target:selFile};}),
    ...right.map(function(f){return{source:selFile,target:f};})
  ];
  drawGraph(focusNodes,focusLinks,byId,[
    {label:'imported by',x:lx-40},{label:'selected',x:graphViewW/2-30},{label:'imports',x:rx-30}
  ]);
}

function buildFullLayout(nodes,links,byId){
  var grps=['source','tests','config','docs','other'], buckets={};
  grps.forEach(function(g){buckets[g]=[];});
  nodes.forEach(function(n){(buckets[n.group]||buckets.other).push(n);});
  var colW=Math.floor(graphViewW/grps.length);
  grps.forEach(function(g,gi){
    var bkt=buckets[g].sort(function(a,b){return(b.dependents+b.dependencies)-(a.dependents+a.dependencies);}).slice(0,10);
    var cx=colW*gi+colW/2;
    var rowH=Math.max(60,Math.min(90,(graphViewH-80)/Math.max(1,bkt.length-1)));
    var totalH=rowH*(bkt.length-1);
    var startY=Math.max(44,graphViewH/2-totalH/2);
    bkt.forEach(function(n,i){
      n.x=cx+(i%2===1?18:-18);
      n.y=startY+i*rowH;
    });
  });
  var vis=new Set(nodes.filter(function(n){return Number.isFinite(n.x)&&Number.isFinite(n.y);}).map(function(n){return n.id;}));
  drawGraph(
    nodes.filter(function(n){return vis.has(n.id);}),
    links.filter(function(l){return vis.has(l.source)&&vis.has(l.target);}),
    byId,
    grps.map(function(g,i){return{label:g,x:Math.floor(graphViewW/grps.length)*i+8};})
  );
}

function drawGraph(nodes,links,byId,labels){
  var svg=$('graph-svg');
  var wrap=$('graph-wrap');
  graphViewW=wrap.clientWidth||960;
  graphViewH=wrap.clientHeight||400;
  svg.setAttribute('viewBox','0 0 '+graphViewW+' '+graphViewH);
  svg.setAttribute('width',graphViewW);
  svg.setAttribute('height',graphViewH);

  var actIds=new Set([selFile]);
  links.forEach(function(l){if(l.source===selFile)actIds.add(l.target);if(l.target===selFile)actIds.add(l.source);});

  var g=svgEl('g',{transform:'translate('+graphPan.x+','+graphPan.y+') scale('+graphZoom+')'});

  labels.forEach(function(lb){
    var t=svgEl('text',{class:'g-col-label',x:lb.x,y:20});
    t.textContent=lb.label; g.appendChild(t);
  });

  links.forEach(function(lk){
    var src=byId[lk.source],tgt=byId[lk.target];
    if(!src||!tgt)return;
    var lit=lk.source===selFile||lk.target===selFile;
    var mx=(src.x+tgt.x)/2;
    var d='M'+src.x+','+src.y+' C'+mx+','+src.y+' '+mx+','+tgt.y+' '+tgt.x+','+tgt.y;
    var el=svgEl('path',{class:'g-link'+(lit?' lit':''),d:d,fill:'none'});
    g.appendChild(el);
  });

  nodes.forEach(function(n){
    var isAct=n.id===selFile, isDim=selFile&&!actIds.has(n.id);
    var r=Math.max(6,Math.min(14,7+Math.min(n.dependents,4)+Math.min(n.dependencies,4)));
    var col=GRP_COLOR[n.group]||GRP_COLOR.other;
    var grp=svgEl('g',{class:'g-node'+(isAct?' active':'')+(isDim?' dim':''),'data-file':n.id,transform:'translate('+n.x+','+n.y+')'});
    var circle=svgEl('circle',{r:r,fill:isAct?col:'#fff',stroke:col,'stroke-width':isAct?'0':'2'});
    var label=n.label.length>22?n.label.slice(0,19)+'…':n.label;
    var txt=svgEl('text',{x:r+7,y:4}); txt.textContent=label;
    grp.appendChild(circle); grp.appendChild(txt);
    grp.addEventListener('click',function(e){e.stopPropagation();selFile=n.id;renderGraph();renderFiles();renderDetail();});
    g.appendChild(grp);
  });

  svg.innerHTML=''; svg.appendChild(g);
  graphNodes=nodes; graphLinks=links;
}

// ── graph pan/zoom ───────────────────────────────────
function initGraphInteraction(){
  var wrap=$('graph-wrap');
  wrap.addEventListener('wheel',function(e){
    e.preventDefault();
    var delta=e.deltaY<0?1.04:1/1.04;
    var rect=wrap.getBoundingClientRect();
    var mx=e.clientX-rect.left, my=e.clientY-rect.top;
    graphPan.x=mx-(mx-graphPan.x)*delta;
    graphPan.y=my-(my-graphPan.y)*delta;
    graphZoom=Math.max(0.2,Math.min(6,graphZoom*delta));
    applyTransform();
  },{passive:false});
  wrap.addEventListener('mousedown',function(e){
    if(e.target.closest('.g-node'))return;
    dragging=true; dragStart={x:e.clientX,y:e.clientY,px:graphPan.x,py:graphPan.y};
    wrap.style.cursor='grabbing';
  });
  window.addEventListener('mousemove',function(e){
    if(!dragging)return;
    graphPan.x=dragStart.px+(e.clientX-dragStart.x);
    graphPan.y=dragStart.py+(e.clientY-dragStart.y);
    applyTransform();
  });
  window.addEventListener('mouseup',function(){dragging=false;if($('graph-wrap'))$('graph-wrap').style.cursor='grab';});
  $('zoom-reset').addEventListener('click',function(){graphZoom=1;graphPan={x:0,y:0};renderGraph();});
}

function applyTransform(){
  var svg=$('graph-svg'); if(!svg)return;
  var g=svg.querySelector('g'); if(!g)return;
  g.setAttribute('transform','translate('+graphPan.x+','+graphPan.y+') scale('+graphZoom+')');
}

// ── files ────────────────────────────────────────────
function allFiles(){
  if(!state)return[];
  return Object.entries(state.groupedFiles).flatMap(function(kv){
    return kv[1].map(function(f){return{group:kv[0],file:f};});
  });
}

function renderFiles(){
  var el=$('file-list'),cnt=$('file-count'); if(!el)return;
  var q=($('file-search').value||'').trim().toLowerCase();
  var grp=($('file-group').value||'all');
  var files=allFiles().filter(function(e){
    return(grp==='all'||e.group===grp)&&(!q||e.file.toLowerCase().includes(q));
  }).slice(0,300);
  cnt.textContent=files.length+' files';
  el.innerHTML=files.map(function(e){
    var act=selFile===e.file?' active':'';
    return '<div class="file-row'+act+'" data-file="'+esc(e.file)+'">'+esc(e.file)+'<span class="fgroup">'+esc(e.group)+'</span></div>';
  }).join('');
  el.querySelectorAll('.file-row').forEach(function(row){
    row.addEventListener('click',function(){
      selFile=row.dataset.file;
      renderFiles();renderDetail();renderGraph();
    });
  });
  var active=el.querySelector('.active');
  if(active)active.scrollIntoView({block:'nearest'});
}

function renderDetail(){
  var el=$('file-detail'); if(!el)return;
  if(!state||!selFile){el.innerHTML='<div class="detail-empty">Select a file</div>';return;}
  var gd=(state.dependencyGraph&&state.dependencyGraph.details&&state.dependencyGraph.details[selFile])||{dependencies:[],dependents:[],externalImports:[]};
  var hot=state.hotFiles.find(function(h){return h.file===selFile;});
  var ev=state.events.find(function(e){return e.path===selFile||(e.path||'').endsWith(selFile);});
  var html='<div class="detail-path">'+esc(selFile)+'</div>';
  if(gd.dependencies&&gd.dependencies.length){
    html+='<div class="detail-section"><div class="detail-section-head">imports</div>'
      +gd.dependencies.slice(0,10).map(function(d){return'<span class="detail-pill">'+esc(d.split('/').pop())+'</span>';}).join('')+'</div>';
  }
  if(gd.dependents&&gd.dependents.length){
    html+='<div class="detail-section"><div class="detail-section-head">imported by</div>'
      +gd.dependents.slice(0,10).map(function(d){return'<span class="detail-pill">'+esc(d.split('/').pop())+'</span>';}).join('')+'</div>';
  }
  if(gd.externalImports&&gd.externalImports.length){
    html+='<div class="detail-section"><div class="detail-section-head">packages</div>'
      +gd.externalImports.slice(0,8).map(function(p){return'<span class="detail-pill pkg">'+esc(p)+'</span>';}).join('')+'</div>';
  }
  if(hot){
    html+='<div class="detail-section"><div class="detail-section-head">risks</div>'
      +(hot.risks||['flagged']).map(function(r){return'<span class="detail-pill risk">'+esc(r)+'</span>';}).join('')+'</div>';
  }
  if(ev){html+='<div class="detail-section"><div class="detail-section-head">last activity</div><div class="detail-empty">'+esc((ev.msg||ev.type)+' · '+new Date(ev.at).toLocaleTimeString())+'</div></div>';}
  el.innerHTML=html;
}

// ── actions ──────────────────────────────────────────
async function runAction(action,btn){
  if(!action)return;
  btn.disabled=true; btn.classList.add('spinning'); btn.textContent='···';
  toast('Running '+action+'…');
  try{
    var resp=await fetch('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action})});
    var data=await resp.json();
    if(data.ok){toast((data.request&&data.request.summary)||action+' complete');}
    else{toast(data.error||action+' failed',true);}
  }catch(err){toast(String(err),true);}
  btn.disabled=false; btn.classList.remove('spinning'); btn.textContent='RUN';
  await refresh();
}

// ── keyboard shortcuts ───────────────────────────────
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(e.key==='f'||e.key==='F'){$('file-search').focus();e.preventDefault();}
  if(e.key==='r'||e.key==='R'){refresh();}
  if(e.key==='1'){setGraphMode('focus');}
  if(e.key==='2'){setGraphMode('full');}
  if(e.key==='0'){graphZoom=1;graphPan={x:0,y:0};renderGraph();}
});

function setGraphMode(m){
  graphMode=m;
  document.querySelectorAll('#graph-mode-seg button').forEach(function(b){b.classList.toggle('active',b.dataset.mode===m);});
  renderGraph();
}

// ── main refresh ─────────────────────────────────────
async function refresh(){
  try{
    var resp=await fetch('/api/state',{cache:'no-store'});
    state=await resp.json();
    if(!selFile){selFile=state.groupedFiles.source[0]||state.groupedFiles.tests[0]||null;}
    $('ws-path').textContent=state.workspaceRoot.split('/').filter(Boolean).pop()||state.workspaceRoot;
    $('ws-path').title=state.workspaceRoot;
    renderMetrics();renderActions();renderSignals();renderEvents();
    renderBudget();renderArtifacts();renderRules();
    renderGraph();renderFiles();renderDetail();
    $('refresh-clock').textContent=new Date().toLocaleTimeString();
  }catch(err){toast('Refresh failed: '+String(err),true);}
}

// ── graph mode toggle ────────────────────────────────
document.querySelectorAll('#graph-mode-seg button').forEach(function(btn){
  btn.addEventListener('click',function(){setGraphMode(btn.dataset.mode);});
});
$('file-search').addEventListener('input',renderFiles);
$('file-group').addEventListener('change',renderFiles);

initGraphInteraction();
refresh();
setInterval(refresh,2000);
})();
</script>
</body>
</html>`;
}

main().catch((error) => {
  process.stderr.write(`dashboard-server failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
