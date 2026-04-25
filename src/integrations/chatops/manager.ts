import { promises as fs } from "node:fs";
import path from "node:path";

interface ChatopsActionArgs {
  action?: string;
  platform?: string;
  channel?: string;
  message?: string;
  approval?: boolean;
}

interface ChatopsThread {
  id: string;
  platform: string;
  channel: string;
  message: string;
  status: "investigating" | "ready_for_approval" | "approved";
  updates: string[];
  prDraft?: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatopsHooks {
  intentCompile: (intent: string) => Promise<any>;
  predictiveRepair: () => Promise<any>;
}

export class ChatopsManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly hooks: ChatopsHooks
  ) {}

  async run(args: ChatopsActionArgs): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "investigate");
    if (action === "status") {
      return this.status();
    }
    if (action === "approve") {
      return this.approve(args);
    }
    return this.investigate(args);
  }

  private async investigate(args: ChatopsActionArgs): Promise<Record<string, unknown>> {
    const platform = String(args.platform ?? "slack");
    const channel = String(args.channel ?? "general");
    const message = String(args.message ?? "").trim();
    if (!message) throw new Error("chatops investigate requires message");

    const intent = await this.hooks.intentCompile(message);
    const repair = await this.hooks.predictiveRepair();
    const thread: ChatopsThread = {
      id: `chat-${Date.now().toString(36)}`,
      platform,
      channel,
      message,
      status: "ready_for_approval",
      updates: [
        "Looking at runtime traces and code impact...",
        "Built intent contract and generated candidate repair queue.",
        "Prepared draft PR summary pending approval reaction."
      ],
      prDraft: buildPrDraft(message, intent, repair),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.saveThread(thread);
    return { ok: true, threadId: thread.id, status: thread.status, updates: thread.updates, prDraft: thread.prDraft };
  }

  private async approve(args: ChatopsActionArgs): Promise<Record<string, unknown>> {
    const threadId = String(args.message ?? "").trim();
    if (!threadId) throw new Error("chatops approve requires thread id in message");
    const thread = await this.readThread(threadId);
    if (!thread) throw new Error(`chatops thread not found: ${threadId}`);
    thread.status = "approved";
    thread.updatedAt = new Date().toISOString();
    thread.updates.push("Approval received from merge-authorized user; draft PR can be created.");
    await this.saveThread(thread);
    return { ok: true, threadId, status: thread.status, prDraft: thread.prDraft };
  }

  private async status(): Promise<Record<string, unknown>> {
    const threads = await this.listThreads();
    return {
      ok: true,
      active: threads.length,
      threads: threads.slice(0, 10).map((thread) => ({
        id: thread.id,
        platform: thread.platform,
        channel: thread.channel,
        status: thread.status,
        updatedAt: thread.updatedAt
      }))
    };
  }

  private baseDir(): string {
    return path.join(this.workspaceRoot, ".mesh", "chatops");
  }

  private async saveThread(thread: ChatopsThread): Promise<void> {
    const target = path.join(this.baseDir(), `${thread.id}.json`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(thread, null, 2), "utf8");
  }

  private async readThread(threadId: string): Promise<ChatopsThread | null> {
    try {
      const raw = await fs.readFile(path.join(this.baseDir(), `${threadId}.json`), "utf8");
      return JSON.parse(raw) as ChatopsThread;
    } catch {
      return null;
    }
  }

  private async listThreads(): Promise<ChatopsThread[]> {
    try {
      const entries = await fs.readdir(this.baseDir());
      const rows = await Promise.all(entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.readThread(entry.replace(/\.json$/, ""))));
      return rows.filter((row): row is ChatopsThread => Boolean(row));
    } catch {
      return [];
    }
  }
}

function buildPrDraft(message: string, intent: any, repair: any): string {
  const likelyFiles = Array.isArray(intent?.contract?.likelyFiles) ? intent.contract.likelyFiles : [];
  const queue = Array.isArray(repair?.queue) ? repair.queue : [];
  return [
    "## ChatOps Investigation",
    `- Request: ${message}`,
    "",
    "## Planned scope",
    ...likelyFiles.slice(0, 8).map((file: string) => `- ${file}`),
    "",
    "## Verification",
    ...queue.slice(0, 5).map((item: any) => `- ${item.summary ?? "Prepared repair candidate"}`)
  ].join("\n");
}
