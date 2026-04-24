import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: unknown;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class McpClient {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readBuffer = Buffer.alloc(0);

  constructor(command: string, args: string[]) {
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        process.stderr.write(`[mesh-mcp] ${text}\n`);
      }
    });

    this.process.on("exit", (code, signal) => {
      const reason = `MCP process exited (code=${code}, signal=${signal})`;
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(reason));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: {
        name: "mesh-agent-cli",
        version: "0.1.0"
      },
      capabilities: {}
    });

    this.sendNotification("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.sendRequest("tools/list", {});
    const tools = (result as { tools?: McpTool[] }).tools ?? [];
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, _opts?: { onProgress?: (chunk: string) => void }): Promise<unknown> {
    return this.sendRequest("tools/call", {
      name,
      arguments: args
    });
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    if (!this.process.killed) {
      this.process.kill();
    }
    await once(this.process, "exit").catch(() => undefined);
  }

  private sendNotification(method: string, params?: unknown): void {
    const message = {
      jsonrpc: "2.0",
      method,
      params
    };
    this.writeMessage(message);
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeMessage(request);
    });
  }

  private writeMessage(message: object): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
    this.process.stdin.write(Buffer.concat([header, payload]));
  }

  private onData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (true) {
      const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = this.readBuffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        throw new Error(`Invalid MCP header: ${header}`);
      }

      const contentLength = Number(contentLengthMatch[1]);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.readBuffer.length < totalLength) {
        return;
      }

      const jsonPayload = this.readBuffer
        .slice(headerEnd + 4, totalLength)
        .toString("utf8");
      this.readBuffer = this.readBuffer.slice(totalLength);

      const message = JSON.parse(jsonPayload) as JsonRpcResponse;
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") {
      return;
    }

    const waiter = this.pending.get(message.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(message.id);

    if (message.error) {
      waiter.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
      return;
    }

    waiter.resolve(message.result);
  }
}
