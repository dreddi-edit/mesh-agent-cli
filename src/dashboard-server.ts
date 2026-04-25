import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const workspaceRoot = path.resolve(process.argv[2] || process.cwd());
const dashboardDir = path.join(workspaceRoot, ".mesh", "dashboard");
const eventsPath = path.join(dashboardDir, "events.json");
const actionsPath = path.join(dashboardDir, "actions.json");
const contextMetricsPath = path.join(dashboardDir, "context-metrics.json");
const artifactIndexPath = path.join(workspaceRoot, ".mesh", "context", "artifacts", "index.json");
const serverInfoPath = path.join(dashboardDir, "server.json");
const DASHBOARD_SERVER_VERSION = "context-ledger-v5";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".mesh", ".next", ".turbo", "coverage", "benchmarks"]);
let stateCache: { at: number; value: Record<string, unknown> } | null = null;
let graphCache: { key: string; value: Record<string, unknown> } | null = null;

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

async function main(): Promise<void> {
  await fs.mkdir(dashboardDir, { recursive: true });
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
      { label: "/repair", detail: "Prepared fixes", action: "repair" },
      { label: "/causal", detail: "Causal graph", action: "causal" },
      { label: "/lab", detail: "Discoveries", action: "lab" },
      { label: "/twin", detail: "Refresh map", action: "twin" },
      { label: "/ghost learn", detail: "Style profile", action: "ghost_learn" }
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
    actionQueue: Array.isArray(actions) ? actions.slice(0, 20) : [],
    liveUpdatedAt: new Date().toISOString()
  };
  stateCache = { at: Date.now(), value: state };
  return state;
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
  let request;
  try {
    const existing = await readJson(actionsPath, []);
    const queue = Array.isArray(existing) ? existing : [];
    request = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    queue.unshift(request);
    await fs.mkdir(path.dirname(actionsPath), { recursive: true });
    await fs.writeFile(actionsPath, JSON.stringify(queue.slice(0, 100), null, 2), "utf8");
  } finally {
    ioMutex.release();
  }
  await appendEvent({ type: "dashboard_action", msg: `queued ${action}`, at: new Date().toISOString() });
  return { ok: true, request };
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
      --bg: #f5f7fb;
      --panel: #ffffff;
      --muted: #64748b;
      --text: #0f172a;
      --border: #dbe3ef;
      --accent: #2563eb;
      --accent-soft: #dbeafe;
      --warn: #b45309;
      --warn-soft: #ffedd5;
      --danger: #b91c1c;
      --danger-soft: #fee2e2;
      --ok: #15803d;
      --ok-soft: #dcfce7;
      --shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }
    header { padding: 18px 24px; background: var(--panel); border-bottom: 1px solid var(--border); display: flex; gap: 16px; align-items: center; justify-content: space-between; }
    .brand { font-size: 18px; font-weight: 700; }
    .subtitle { color: var(--muted); font-size: 13px; }
    .status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: var(--ok); box-shadow: 0 0 0 4px var(--ok-soft); }
    .summary { padding: 16px 24px; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); }
    .metric { padding: 14px; min-height: 88px; }
    .metric .label { font-size: 12px; color: var(--muted); }
    .metric .value { margin-top: 8px; font-size: 28px; font-weight: 700; }
    .metric .meta { margin-top: 4px; color: var(--muted); font-size: 12px; }
    main { padding: 0 24px 24px; display: grid; grid-template-columns: 320px minmax(0, 1fr) 360px; gap: 16px; }
    section { padding: 16px; }
    h2, h3 { margin: 0 0 12px; font-size: 15px; }
    .stack { display: grid; gap: 16px; }
    .list { display: grid; gap: 8px; }
    .item { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: #fbfdff; }
    .item strong { display: block; font-size: 13px; margin-bottom: 4px; }
    .item small { color: var(--muted); }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
    .pill.ok { background: var(--ok-soft); color: var(--ok); }
    .pill.warn { background: var(--warn-soft); color: var(--warn); }
    .pill.danger { background: var(--danger-soft); color: var(--danger); }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .toolbar input, .toolbar select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font: inherit; background: #fff; }
    .file-list { max-height: calc(100vh - 250px); overflow: auto; display: grid; gap: 8px; }
    .file-row { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; cursor: pointer; background: #fff; }
    .file-row:hover, .file-row.active { border-color: var(--accent); background: var(--accent-soft); }
    .file-row .path { font-size: 13px; font-weight: 600; word-break: break-word; }
    .file-row .meta { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .empty { color: var(--muted); padding: 18px 0; }
    .muted { color: var(--muted); }
    .center-column { min-width: 0; }
    .graph-card { min-height: 430px; }
    .graph-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .graph-head h2 { margin: 0; }
    .graph-tools { display: flex; align-items: center; gap: 10px; }
    .graph-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .segmented { display: inline-grid; grid-auto-flow: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #fff; }
    .segmented button { border: 0; background: transparent; padding: 7px 10px; font: inherit; font-size: 12px; cursor: pointer; color: var(--muted); }
    .segmented button.active { background: var(--accent); color: #fff; }
    .graph-shell { height: 390px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #f8fafc; }
    .graph-svg { width: 100%; height: 100%; display: block; }
    .graph-link { stroke: #94a3b8; stroke-width: 1.2; opacity: 0.38; }
    .graph-link.active { stroke: var(--accent); opacity: 0.9; stroke-width: 2; }
    .graph-node { cursor: pointer; }
    .graph-node circle { stroke: #fff; stroke-width: 2; }
    .graph-node text { fill: #334155; font-size: 11px; paint-order: stroke; stroke: #f8fafc; stroke-width: 4px; stroke-linejoin: round; }
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
    .action-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 7px; padding: 7px 10px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    .action-button:disabled { opacity: 0.45; cursor: default; }
    .queue-state { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
    @media (max-width: 1400px) {
      .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      main { grid-template-columns: 300px minmax(0, 1fr); }
      .right-column { grid-column: 1 / -1; }
    }
    @media (max-width: 960px) {
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      main { grid-template-columns: 1fr; }
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
          <h2>Commands</h2>
          <div class="list" id="actions"></div>
        </section>
        <section class="card">
          <h2>Queue</h2>
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
            <span><i class="swatch" style="background:#2563eb"></i>source</span>
            <span><i class="swatch" style="background:#16a34a"></i>tests</span>
            <span><i class="swatch" style="background:#9333ea"></i>config</span>
            <span><i class="swatch" style="background:#f59e0b"></i>other</span>
          </div>
          <div class="package-grid" id="external-packages"></div>
        </section>
        <section class="card">
          <h2>Dateien</h2>
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
            <div>
              <div class="card" style="box-shadow:none">
                <section>
                  <h3>Dateidetails</h3>
                  <div id="file-detail" class="empty">Wähle links eine Datei aus.</div>
                </section>
              </div>
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
    const graphEl = document.getElementById("dependency-graph");
    const graphMetaEl = document.getElementById("graph-meta");
    const externalPackagesEl = document.getElementById("external-packages");
    const graphModeButtons = document.querySelectorAll("[data-graph-mode]");

    const groupColors = {
      source: "#2563eb",
      tests: "#16a34a",
      docs: "#7c3aed",
      config: "#9333ea",
      other: "#f59e0b"
    };

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

      actionsEl.innerHTML = currentState.actions.map(function(action) {
        return '<div class="item action-row"><div><strong>' + esc(action.label) + '</strong><small>' + esc(action.detail) + '</small></div><button class="action-button" data-action="' + esc(action.action) + '">Run</button></div>';
      }).join("");
      actionsEl.querySelectorAll("[data-action]").forEach(function(button) {
        button.addEventListener("click", function() {
          triggerAction(button.getAttribute("data-action"), button);
        });
      });

      const attention = [];
      attention.push('<div class="item"><strong>Health</strong><small><span class="pill ' + pillClass(currentState.health.status) + '">' + currentState.health.status + '</span> Score ' + currentState.health.score + '</small></div>');
      (currentState.actionQueue || []).slice(0, 4).forEach(function(action) {
        attention.push('<div class="item"><strong>' + esc(action.action) + '</strong><small><span class="queue-state">' + esc(action.status) + '</span></small></div>');
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
      button.textContent = "Queued";
      await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      }).catch(function() {});
      setTimeout(function() {
        button.disabled = false;
        button.textContent = "Run";
      }, 1200);
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
