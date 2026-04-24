import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn, spawnSync, ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TerminalImageProtocol = "kitty" | "iterm2" | "sixel" | "external" | "none";

export interface FrontendPreviewOptions {
  url: string;
  width?: number;
  height?: number;
  waitMs?: number;
  render?: boolean;
  protocol?: TerminalImageProtocol | "auto";
  outputPath?: string;
  onProgress?: (chunk: string) => void;
}

export interface FrontendPreviewResult {
  ok: true;
  url: string;
  screenshotPath: string;
  width: number;
  height: number;
  protocol: TerminalImageProtocol;
  rendered: boolean;
  chromeExecutable: string;
}

interface ChromeSession {
  child: ChildProcess;
  port: number;
  userDataDir: string;
  executable: string;
}

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export async function captureFrontendPreview(options: FrontendPreviewOptions): Promise<FrontendPreviewResult> {
  const url = normalizePreviewUrl(options.url);
  const width = clampInt(options.width, 320, 3840, 1280);
  const height = clampInt(options.height, 240, 2400, 800);
  const waitMs = clampInt(options.waitMs, 0, 15000, 1200);
  const outputPath = options.outputPath || path.join(os.tmpdir(), `mesh-preview-${Date.now()}.png`);

  const chrome = await launchChrome();
  let cdp: CdpClient | null = null;
  try {
    const target = await createPageTarget(chrome.port);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await cdp.send("Page.navigate", { url });
    await sleep(waitMs);
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    const png = Buffer.from(String(screenshot.data ?? ""), "base64");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, png);

    let protocol = pickTerminalImageProtocol(options.protocol ?? "auto");
    let rendered = false;
    if (options.render !== false) {
      const renderResult = renderImageInTerminal(outputPath, protocol, options.onProgress);
      rendered = renderResult.rendered;
      protocol = renderResult.protocol;
    }

    return {
      ok: true,
      url,
      screenshotPath: outputPath,
      width,
      height,
      protocol,
      rendered,
      chromeExecutable: chrome.executable
    };
  } finally {
    cdp?.close();
    await stopChrome(chrome.child);
    await fs.rm(chrome.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function pickTerminalImageProtocol(raw: TerminalImageProtocol | "auto" = "auto"): TerminalImageProtocol {
  if (raw !== "auto") return raw;
  if (process.env.KITTY_WINDOW_ID || /kitty/i.test(process.env.TERM || "")) return "kitty";
  if (/iTerm\.app/i.test(process.env.TERM_PROGRAM || "")) return "iterm2";
  if (/WezTerm/i.test(process.env.TERM_PROGRAM || "")) return "iterm2";
  if (hasCommand("img2sixel") || hasCommand("chafa")) return "sixel";
  return "none";
}

function renderImageInTerminal(
  imagePath: string,
  preferred: TerminalImageProtocol,
  onProgress?: (chunk: string) => void
): { rendered: boolean; protocol: TerminalImageProtocol } {
  if (preferred === "kitty") {
    const raw = existsSync(imagePath) ? readFileSync(imagePath).toString("base64") : "";
    if (!raw) return { rendered: false, protocol: "none" };
    const chunks = raw.match(/.{1,4096}/g) ?? [];
    for (let index = 0; index < chunks.length; index += 1) {
      const more = index === chunks.length - 1 ? 0 : 1;
      const prefix = index === 0 ? `\x1b_Ga=T,f=100,m=${more};` : `\x1b_Gm=${more};`;
      onProgress?.(`${prefix}${chunks[index]}\x1b\\`);
    }
    onProgress?.("\n");
    return { rendered: true, protocol: "kitty" };
  }

  if (preferred === "iterm2") {
    const raw = existsSync(imagePath) ? readFileSync(imagePath).toString("base64") : "";
    if (!raw) return { rendered: false, protocol: "none" };
    onProgress?.(`\x1b]1337;File=inline=1;preserveAspectRatio=1:${raw}\x07\n`);
    return { rendered: true, protocol: "iterm2" };
  }

  if (preferred === "sixel") {
    if (hasCommand("img2sixel")) {
      const result = spawnSync("img2sixel", [imagePath], { encoding: "utf8" });
      if (result.status === 0 && result.stdout) {
        onProgress?.(result.stdout + "\n");
        return { rendered: true, protocol: "sixel" };
      }
    }
    if (hasCommand("chafa")) {
      const result = spawnSync("chafa", ["-f", "sixels", imagePath], { encoding: "utf8" });
      if (result.status === 0 && result.stdout) {
        onProgress?.(result.stdout + "\n");
        return { rendered: true, protocol: "sixel" };
      }
    }
  }

  return { rendered: false, protocol: preferred === "external" ? "external" : "none" };
}

async function launchChrome(): Promise<ChromeSession> {
  const executable = await findChromeExecutable();
  const port = await findFreePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-chrome-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ];

  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.unref();
  await waitForChrome(port, child);
  return { child, port, userDataDir, executable };
}

async function findChromeExecutable(): Promise<string> {
  const candidates = [
    process.env.MESH_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    await which("google-chrome"),
    await which("google-chrome-stable"),
    await which("chromium"),
    await which("chromium-browser"),
    await which("microsoft-edge")
  ].filter((candidate): candidate is string => Boolean(candidate));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Chrome/Chromium not found. Set MESH_CHROME_PATH to a Chromium-compatible executable.");
  }
  return found;
}

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a local CDP port."));
      });
    });
    server.on("error", reject);
  });
}

async function waitForChrome(port: number, child: ChildProcess): Promise<void> {
  let lastError = "";
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became available. exitCode=${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome CDP on port ${port}: ${lastError}`);
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (closed) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function createPageTarget(port: number): Promise<CdpTarget> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (response.ok) {
    const target = await response.json() as CdpTarget;
    if (target.webSocketDebuggerUrl) return target;
  }

  const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResponse.json() as CdpTarget[];
  const target = targets.find((entry) => entry.webSocketDebuggerUrl);
  if (!target) throw new Error("Chrome CDP did not expose a page target.");
  return target;
}

class CdpClient {
  private socket: net.Socket;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private textFragments = "";
  private pending = new Map<number, PendingCall>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (error) => this.rejectAll(error));
    this.socket.on("close", () => this.rejectAll(new Error("CDP socket closed")));
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const parsed = new URL(wsUrl);
    const socket = net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port)
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const key = crypto.randomBytes(16).toString("base64");
    socket.write([
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
      `Host: ${parsed.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      ""
    ].join("\r\n"));

    let handshake = Buffer.alloc(0);
    let leftover = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        handshake = Buffer.concat([handshake, chunk]);
        const marker = handshake.indexOf("\r\n\r\n");
        if (marker === -1) return;
        socket.off("data", onData);
        const head = handshake.slice(0, marker).toString("utf8");
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          reject(new Error(`CDP websocket handshake failed: ${head.split("\r\n")[0]}`));
          return;
        }
        leftover = handshake.slice(marker + 4);
        resolve();
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });

    const client = new CdpClient(socket);
    if (leftover.length > 0) client.onData(leftover);
    return client;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    this.socket.write(encodeClientFrame(payload));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close(): void {
    try {
      this.socket.end();
      this.socket.destroy();
    } catch {
      // ignore
    }
  }

  onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CDP frame too large");
        length = Number(bigLength);
        offset += 8;
      }

      const masked = Boolean(second & 0x80);
      let mask: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = Buffer.from(this.buffer.subarray(offset, offset + 4));
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;

      let payload: Buffer = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.slice(offset + length);
      if (mask) payload = unmask(payload, mask);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode !== 0x1 && opcode !== 0x0) continue;

      this.textFragments += payload.toString("utf8");
      if (fin) {
        const text = this.textFragments;
        this.textFragments = "";
        this.handleMessage(text);
      }
    }
  }

  private handleMessage(text: string): void {
    const message = JSON.parse(text);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function encodeClientFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + 4 + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    maskPayload(payload).copy(frame, 6);
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
    mask.copy(frame, 4);
    maskPayload(payload, mask).copy(frame, 8);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(frame, 10);
    maskPayload(payload, mask).copy(frame, 14);
  }

  function maskPayload(input: Buffer, selectedMask = mask): Buffer {
    const output = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i += 1) {
      output[i] = input[i] ^ selectedMask[i % 4];
    }
    return output;
  }

  return frame;
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const output = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    output[i] = payload[i] ^ mask[i % 4];
  }
  return output;
}

function normalizePreviewUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("frontend.preview requires url");
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(value)) return `http://${value}`;
  return value;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function hasCommand(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
