import { promises as fs, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, ChildProcess } from "node:child_process";

export interface PortalBindingEvent {
  name: string;
  payload: string;
  executionContextId: number;
}

export class MeshPortal {
  private chromeProcess: ChildProcess | null = null;
  private cdpClient: PortalCdpClient | null = null;
  private userDataDir: string | null = null;
  private port: number = 0;

  constructor(private readonly workspaceRoot: string) {}

  async active(): Promise<boolean> {
    return this.cdpClient !== null;
  }

  async start(url: string, onEvent?: (event: PortalBindingEvent) => void): Promise<void> {
    if (this.cdpClient) return;

    this.port = await this.findFreePort();
    this.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-portal-"));
    
    const executable = await this.findChromeExecutable();
    const args = [
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      url
    ];

    this.chromeProcess = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    
    // Wait for CDP to be ready
    await this.waitForCdp();
    
    const target = await this.createPageTarget();
    this.cdpClient = await PortalCdpClient.connect(target.webSocketDebuggerUrl);
    
    await this.cdpClient.send("Runtime.enable");
    await this.cdpClient.send("Page.enable");
    await this.cdpClient.send("DOM.enable");

    // Setup the bridge binding
    await this.cdpClient.send("Runtime.addBinding", { name: "meshEmit" });
    
    if (onEvent) {
      this.cdpClient.onBindingCalled((data) => {
        onEvent({
          name: "meshEmit",
          payload: data.payload,
          executionContextId: data.executionContextId
        });
      });
    }
  }

  async evaluate(expression: string): Promise<any> {
    return this.cdpClient?.send("Runtime.evaluate", { expression, awaitPromise: true });
  }

  async applyGhostStyles(styles: Record<string, string>): Promise<void> {
    // Pass styles via a binding call rather than string-interpolating into JS,
    // preventing injection if a style value contains quote/script characters.
    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(styles)) {
      // CSS property names: letters, digits, hyphens only
      if (!/^[a-zA-Z0-9-]+$/.test(k)) continue;
      // CSS values: strip anything that could break out of a string context
      sanitized[k] = v.replace(/[\\"'`\r\n<>]/g, "");
    }
    const json = JSON.stringify(sanitized);
    await this.evaluate(`window.__mesh_apply_ghost(${json})`);
  }

  async captureElementScreenshot(): Promise<string> {
    if (!this.cdpClient) throw new Error("Portal not active");

    // 1. Get the bounding box of the selected element via the injected script
    const box = await this.evaluate(`
      (function() {
        const el = document.querySelector(".mesh-highlight");
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, deviceScaleFactor: window.devicePixelRatio };
      })()
    `);

    if (!box || !box.result?.value) return "";
    const { x, y, width, height, deviceScaleFactor } = box.result.value;

    // 2. Capture clipped screenshot
    const screenshot = await this.cdpClient.send("Page.captureScreenshot", {
      format: "png",
      clip: {
        x, y, width, height, scale: 1
      },
      fromSurface: true
    });

    return screenshot.data; // Base64 PNG
  }

  async stop(): Promise<void> {
    this.cdpClient?.close();
    this.cdpClient = null;
    
    if (this.chromeProcess) {
      this.chromeProcess.kill("SIGTERM");
      this.chromeProcess = null;
    }

    if (this.userDataDir) {
      await fs.rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
      this.userDataDir = null;
    }
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
  }

  private async findChromeExecutable(): Promise<string> {
    const candidates = [
      process.env.MESH_CHROME_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "google-chrome",
      "chromium"
    ].filter(Boolean) as string[];

    for (const c of candidates) {
      if (existsSync(c)) return c;
      try {
        const { stdout } = spawnSync("which", [c], { encoding: "utf8" });
        if (stdout.trim()) return stdout.trim();
      } catch {}
    }
    throw new Error("Chrome not found. Please install Google Chrome or set MESH_CHROME_PATH.");
  }

  private async waitForCdp(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (res.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error("Timed out waiting for Chrome CDP.");
  }

  private async createPageTarget(): Promise<{ webSocketDebuggerUrl: string }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    const targets = await res.json() as any[];
    return targets.find(t => t.type === "page") || targets[0];
  }
}

class PortalCdpClient {
  private socket: net.Socket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>();
  private onBindingHandler: ((data: any) => void) | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => this.handleData(chunk));
  }

  static async connect(wsUrl: string): Promise<PortalCdpClient> {
    const url = new URL(wsUrl);
    const socket = net.createConnection(Number(url.port), url.hostname);
    await new Promise((resolve) => socket.once("connect", resolve));

    const key = crypto.randomBytes(16).toString("base64");
    socket.write([
      `GET ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "\r\n"
    ].join("\r\n"));

    await new Promise((resolve) => socket.once("data", resolve));
    return new PortalCdpClient(socket);
  }

  send(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    this.socket.write(this.encodeFrame(message));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onBindingCalled(handler: (data: any) => void) {
    this.onBindingHandler = handler;
  }

  close() {
    this.socket.destroy();
  }

  private handleData(chunk: Buffer) {
    // Basic WebSocket Frame Decoding (simplified for POC)
    try {
      const payload = this.decodeFrame(chunk);
      if (!payload) return;
      const msg = JSON.parse(payload);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg.result);
      } else if (msg.method === "Runtime.bindingCalled") {
        this.onBindingHandler?.(msg.params);
      }
    } catch {}
  }

  private encodeFrame(text: string): Buffer {
    const payload = Buffer.from(text);
    const frame = Buffer.alloc(payload.length + 6);
    frame[0] = 0x81;
    frame[1] = 0x80 | payload.length; // Simplified for small payloads
    const mask = crypto.randomBytes(4);
    mask.copy(frame, 2);
    for (let i = 0; i < payload.length; i++) {
      frame[i + 6] = payload[i] ^ mask[i % 4];
    }
    return frame;
  }

  private decodeFrame(buffer: Buffer): string | null {
    if (buffer.length < 2) return null;
    const length = buffer[1] & 0x7f;
    if (length > 125) return null; // Simplified
    return buffer.slice(2, 2 + length).toString();
  }
}
