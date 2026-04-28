#!/usr/bin/env node
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import { setPriority } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { LocalToolBackend } from "./local-tools.js";
import {
  DAEMON_DIR,
  DAEMON_PID_PATH,
  DAEMON_SOCKET_PATH,
  DAEMON_STATE_PATH,
  DaemonRequest,
  DaemonResponse
} from "./daemon-protocol.js";

const DAEMON_REQUEST = {
  status: { action: "status" as const },
  digest: { action: "digest" as const },
  stop: { action: "stop" as const },
  ping: { action: "ping" as const }
};

interface DaemonState {
  startedAt: string;
  updatedAt: string;
  workspaceRoot: string;
  status: "idle" | "running" | "paused";
  runs: number;
  lastError?: string;
  lastDigest?: string;
  lastTasks: string[];
}

export async function runDaemonCli(argv: string[]): Promise<number> {
  const cmd = (argv[0] || "status").toLowerCase();
  if (cmd === "run") {
    await runDaemonServer();
    return 0;
  }
  if (cmd === "start") {
    return startDaemon();
  }
  if (cmd === "status" || cmd === "digest" || cmd === "stop") {
    return callDaemon({ action: cmd }).then((response) => {
      process.stdout.write(JSON.stringify(response, null, 2) + "\n");
      return response.ok ? 0 : 1;
    });
  }
  process.stderr.write("Usage: mesh-daemon [start|status|digest|stop]\n");
  return 1;
}

async function startDaemon(): Promise<number> {
  const ping = await callDaemon(DAEMON_REQUEST.ping).catch(() => null);
  if (ping?.ok) {
    process.stdout.write("Mesh daemon already running.\n");
    return 0;
  }
  await fs.mkdir(DAEMON_DIR, { recursive: true });
  const script = new URL("./daemon.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [script, "run"], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  process.stdout.write("Mesh daemon start requested.\n");
  return 0;
}

async function runDaemonServer(): Promise<void> {
  await fs.mkdir(DAEMON_DIR, { recursive: true });
  await fs.rm(DAEMON_SOCKET_PATH, { force: true }).catch(() => undefined);
  await fs.writeFile(DAEMON_PID_PATH, String(process.pid), "utf8");
  setPriority(0, 10);
  const config = await loadConfig();
  const backend = new LocalToolBackend(config.agent.workspaceRoot, config);
  const state: DaemonState = {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceRoot: config.agent.workspaceRoot,
    status: "idle",
    runs: 0,
    lastTasks: []
  };
  await writeState(state);

  const tick = async () => {
    if (!canRunHeavyTasks()) {
      state.status = "paused";
      state.updatedAt = new Date().toISOString();
      await writeState(state);
      return;
    }
    state.status = "running";
    state.updatedAt = new Date().toISOString();
    const tasks: string[] = [];
    try {
      await backend.callTool("workspace.predictive_repair", { action: "analyze" });
      tasks.push("predictive_repair");
      await backend.callTool("workspace.digital_twin", { action: "build" });
      tasks.push("digital_twin");
      await backend.callTool("workspace.engineering_memory", { action: "learn" });
      tasks.push("engineering_memory");
      state.runs += 1;
      state.lastTasks = tasks;
      state.lastDigest = `While you were away: refreshed ${tasks.join(", ")} at ${new Date().toLocaleString()}.`;
      state.lastError = undefined;
    } catch (error) {
      state.lastError = (error as Error).message;
    } finally {
      state.status = "idle";
      state.updatedAt = new Date().toISOString();
      await writeState(state);
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 15 * 60 * 1000);

  // Restrict socket to owner only — prevents other local processes from sending stop/status
  await fs.chmod(DAEMON_SOCKET_PATH, 0o700).catch(() => undefined);

  const server = net.createServer((socket) => {
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk.toString();
    });
    socket.on("end", async () => {
      const request = safeParseRequest(body);
      const response = await handleRequest(request, state);
      socket.write(JSON.stringify(response));
      socket.end();
      if (request?.action === "stop") {
        clearInterval(timer);
        server.close();
        await backend.close();
        await fs.rm(DAEMON_SOCKET_PATH, { force: true }).catch(() => undefined);
        process.exit(0);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(DAEMON_SOCKET_PATH, () => resolve());
  });
}

async function callDaemon(request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(DAEMON_SOCKET_PATH, () => {
      socket.write(JSON.stringify(request));
      socket.end();
    });
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(body) as DaemonResponse);
      } catch {
        resolve({ ok: false, action: request.action, message: "Invalid daemon response." });
      }
    });
  });
}

async function handleRequest(request: DaemonRequest | null, state: DaemonState): Promise<DaemonResponse> {
  if (!request) {
    return { ok: false, action: "ping", message: "Invalid request payload." };
  }
  if (request.action === "ping") {
    return { ok: true, action: "ping", message: "alive" };
  }
  if (request.action === "status") {
    return { ok: true, action: "status", state: state as unknown as Record<string, unknown> };
  }
  if (request.action === "digest") {
    return {
      ok: true,
      action: "digest",
      digest:
        state.lastDigest ||
        `While you were away: daemon is active, ${state.runs} maintenance run(s) completed.`
    };
  }
  if (request.action === "stop") {
    return { ok: true, action: "stop", message: "Stopping daemon." };
  }
  return { ok: false, action: request.action, message: "Unsupported action." };
}

function safeParseRequest(raw: string): DaemonRequest | null {
  try {
    const parsed = JSON.parse(raw) as DaemonRequest;
    if (!parsed?.action) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(state: DaemonState): Promise<void> {
  await fs.writeFile(DAEMON_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function canRunHeavyTasks(): boolean {
  const maxLoad = os.cpus().length * 0.25;
  const [load1] = os.loadavg();
  if (load1 > maxLoad) return false;
  if (process.platform !== "darwin") return true;
  const battery = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" });
  const output = `${battery.stdout ?? ""}`;
  return !/Battery Power/i.test(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDaemonCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`mesh-daemon fatal: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
