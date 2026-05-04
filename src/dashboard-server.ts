import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
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
const DASHBOARD_SERVER_VERSION = "react-live-dashboard-v1";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".mesh", ".next", ".turbo", "coverage", "benchmarks"]);
const DASHBOARD_ACTIONS = new Set(["repair", "causal", "lab", "twin", "ghost_learn"]);

let stateCache: { at: number; value: Record<string, unknown> } | null = null;
let graphCache: { key: string; value: Record<string, unknown> } | null = null;
let actionBackend: LocalToolBackend | null = null;
let broadcastDashboardMessage: (message: Record<string, unknown>) => void = () => undefined;
let requestDashboardStateBroadcast: (reason?: string) => void = () => undefined;

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

type DashboardClientMessage =
  | { type: "auth"; token?: unknown }
  | { type: "state.request" }
  | { type: "action.run"; action?: unknown }
  | { type: "ping" };

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

  const sessionToken = resolveDashboardToken();
  const clients = new Set<WebSocket>();
  const assetDir = await resolveDashboardAssetDir();
  const wss = new WebSocketServer({ noServer: true });
  let stateBroadcastTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const sendMessage = (socket: WebSocket, message: Record<string, unknown>): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const sendStateSnapshot = async (socket: WebSocket, reason = "snapshot"): Promise<void> => {
    sendMessage(socket, { type: "state.snapshot", reason, state: await buildState() });
  };

  broadcastDashboardMessage = (message: Record<string, unknown>) => {
    const serialized = JSON.stringify(message);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(serialized);
      }
    }
  };

  const broadcastStateSnapshot = async (reason = "change"): Promise<void> => {
    if (clients.size === 0) return;
    const state = await buildState();
    broadcastDashboardMessage({ type: "state.snapshot", reason, state });
  };

  requestDashboardStateBroadcast = (reason = "change") => {
    stateCache = null;
    if (stateBroadcastTimer) return;
    stateBroadcastTimer = setTimeout(() => {
      stateBroadcastTimer = null;
      void broadcastStateSnapshot(reason).catch((error) => {
        broadcastDashboardMessage({ type: "error", error: (error as Error).message });
      });
    }, 120);
    stateBroadcastTimer.unref();
  };

  wss.on("connection", (socket) => {
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, "Authentication timeout"), 5_000);
    authTimer.unref();

    socket.on("message", (raw) => {
      void (async () => {
        const message = parseClientMessage(raw);
        if (!message) {
          return sendMessage(socket, { type: "error", error: "Invalid WebSocket message" });
        }

        if (!authenticated) {
          if (message.type === "auth" && typeof message.token === "string" && tokenMatches(message.token, sessionToken)) {
            authenticated = true;
            clearTimeout(authTimer);
            clients.add(socket);
            sendMessage(socket, { type: "auth.ok", version: DASHBOARD_SERVER_VERSION });
            await sendStateSnapshot(socket, "auth");
            return;
          }
          socket.close(1008, "Unauthorized");
          return;
        }

        if (message.type === "state.request") {
          await sendStateSnapshot(socket, "client.request");
          return;
        }

        if (message.type === "action.run") {
          const result = await enqueueAction({ action: message.action });
          sendMessage(socket, { type: "action.update", result });
          return;
        }

        if (message.type === "ping") {
          sendMessage(socket, { type: "pong", at: new Date().toISOString() });
        }
      })().catch((error) => {
        sendMessage(socket, { type: "error", error: (error as Error).message });
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      clients.delete(socket);
    });
  });

  const server = http.createServer(async (req, res) => {
    try {
      await serveHttpRequest(req, res, assetDir);
    } catch (error) {
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
      });
      res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !isSameOriginUpgrade(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  const watchers = await watchDashboardSources(() => requestDashboardStateBroadcast("file.change"));

  const scheduleHeartbeat = (): void => {
    heartbeatTimer = setTimeout(() => {
      for (const socket of clients) {
        if (socket.readyState === socket.OPEN) {
          socket.ping();
        }
      }
      scheduleHeartbeat();
    }, 30_000);
    heartbeatTimer.unref();
  };
  scheduleHeartbeat();

  const closeBackend = () => {
    for (const watcher of watchers) watcher.close();
    if (stateBroadcastTimer) clearTimeout(stateBroadcastTimer);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    wss.close();
    server.close();
    void actionBackend?.close().catch(() => undefined);
  };
  process.once("SIGINT", closeBackend);
  process.once("SIGTERM", closeBackend);

  server.listen(0, "127.0.0.1", async () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await fs.writeFile(
      serverInfoPath,
      JSON.stringify({ port, pid: process.pid, workspaceRoot, version: DASHBOARD_SERVER_VERSION }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
  });
}

function resolveDashboardToken(): string {
  const raw = process.env.MESH_DASHBOARD_TOKEN || process.argv[3] || "";
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return raw;
  }
  return crypto.randomBytes(32).toString("hex");
}

function tokenMatches(provided: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(provided) || !/^[a-f0-9]{64}$/i.test(expected)) {
    return false;
  }
  const left = Buffer.from(provided, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseClientMessage(raw: WebSocket.RawData): DashboardClientMessage | null {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    const parsed = JSON.parse(text) as DashboardClientMessage;
    return parsed && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function isSameOriginUpgrade(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function serveHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, assetDir: string | null): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (url.pathname === "/health") {
    return json(res, { ok: true, version: DASHBOARD_SERVER_VERSION });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, securityHeaders({ Allow: "GET, HEAD" }));
    res.end("Method not allowed");
    return;
  }

  if (!assetDir) {
    res.writeHead(503, securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Dashboard assets are missing. Run npm run build to create dist/dashboard.");
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = safeJoin(assetDir, requested);
  if (!filePath) {
    res.writeHead(404, securityHeaders());
    res.end("Not found");
    return;
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    res.writeHead(404, securityHeaders());
    res.end("Not found");
    return;
  }

  const body = await fs.readFile(filePath);
  res.writeHead(200, securityHeaders({
    "Content-Type": contentType(filePath),
    "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable"
  }));
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

function json(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  res.end(JSON.stringify(payload));
}

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*;",
    ...extra
  };
}

async function resolveDashboardAssetDir(): Promise<string | null> {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(runtimeDir, "dashboard"),
    path.resolve(process.cwd(), "dist", "dashboard"),
    path.resolve(workspaceRoot, "dist", "dashboard")
  ];
  for (const candidate of candidates) {
    const indexPath = path.join(candidate, "index.html");
    const stat = await fs.stat(indexPath).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return null;
}

function safeJoin(root: string, requestPath: string): string | null {
  const normalized = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const joined = path.resolve(root, `.${path.sep}${normalized}`);
  const relative = path.relative(root, joined);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return joined;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".map") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function watchDashboardSources(onChange: () => void): Promise<FSWatcher[]> {
  const dirs = [
    dashboardDir,
    path.join(workspaceRoot, ".mesh"),
    path.join(workspaceRoot, ".mesh", "context", "artifacts"),
    path.join(workspaceRoot, ".mesh", "reality-forks"),
    path.join(workspaceRoot, ".mesh", "ghost-engineer")
  ];
  const watchers: FSWatcher[] = [];
  for (const dir of dirs) {
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    try {
      watchers.push(watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename || String(filename).endsWith(".json")) {
          graphCache = null;
          onChange();
        }
      }));
    } catch {
      // File watching is opportunistic; clients can still request snapshots.
    }
  }
  return watchers;
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
      { label: "/repair", detail: "Find compiler and test-risk repair candidates", action: "repair" },
      { label: "/causal", detail: "Rebuild the file, risk, and test graph", action: "causal" },
      { label: "/lab", detail: "Suggest high-impact repo improvements", action: "lab" },
      { label: "/twin", detail: "Refresh files, routes, symbols, and risks", action: "twin" },
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

async function enqueueAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(body.action || "").trim();
  if (!DASHBOARD_ACTIONS.has(action)) {
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
  broadcastDashboardMessage({ type: "action.update", request });
  requestDashboardStateBroadcast("action.running");

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
    broadcastDashboardMessage({ type: "action.update", request: completed });
    requestDashboardStateBroadcast("action.done");
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
    broadcastDashboardMessage({ type: "action.update", request: failed });
    requestDashboardStateBroadcast("action.error");
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
    const saved = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...event };
    events.unshift(saved);
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.writeFile(eventsPath, JSON.stringify(events.slice(0, 200), null, 2), "utf8");
    broadcastDashboardMessage({ type: "event.append", event: saved });
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

main().catch((error) => {
  process.stderr.write(`dashboard-server failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
