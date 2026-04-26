import { promises as fs } from "node:fs";
import path from "node:path";
import { collectWorkspaceFiles, writeJson } from "./common.js";

export interface TodoMarker {
  file: string;
  line: number;
  text: string;
  context: string;
}

export class TodoResolverEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly callTool: (name: string, args: any) => Promise<any>
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "scan").trim().toLowerCase();
    
    if (action === "scan") {
      const maxFiles = typeof args.maxFiles === "number" ? args.maxFiles : 1500;
      const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles });
      const todos: TodoMarker[] = [];
      const regex = /\/\/\s*(TODO|FIXME):\s*(.+)$/i;

      for (const file of files) {
        const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
        const lines = raw.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const match = regex.exec(lines[i]);
          if (match) {
            const start = Math.max(0, i - 5);
            const end = Math.min(lines.length, i + 6);
            todos.push({
              file,
              line: i + 1,
              text: match[2].trim(),
              context: lines.slice(start, end).join("\n")
            });
          }
        }
      }

      const ledgerPath = ".mesh/todo-resolver/last-scan.json";
      await writeJson(path.join(this.workspaceRoot, ledgerPath), { todos, scannedAt: new Date().toISOString() });
      return { ok: true, action, todosFound: todos.length, todos, ledgerPath };
    }

    if (action === "resolve") {
      const file = typeof args.file === "string" ? args.file : undefined;
      const text = typeof args.text === "string" ? args.text : undefined;
      
      if (!file || !text) {
        throw new Error("workspace.todo_resolver 'resolve' action requires 'file' and 'text' arguments");
      }

      // Step 1: Compile Intent
      const intentRes = await this.callTool("workspace.intent_compile", {
        intent: `Resolve the TODO in ${file}: ${text}`
      }) as any;

      // Step 2: Reality Fork (Spawn timeline & race fixes)
      // Reality fork takes an intent and creates timelines. Or we can just use timeline_create directly and run an agent.
      // But we can also use agent.spawn to do the work in the timeline.
      // For autonomy, we create a timeline, use agent.spawn to fix the file, run timeline_run for tests, then timeline_promote.
      
      const timelineRes = await this.callTool("workspace.timeline_create", { name: `todo-fix-${Date.now().toString(36)}` }) as any;
      const timelineId = timelineRes.timeline.id;
      
      // We spawn an agent inside the timeline to perform the fix
      const fixRes = await this.callTool("agent.spawn", {
        role: "developer",
        instruction: `In the file ${file}, resolve the following TODO: "${text}". Modify the code accordingly and remove the TODO comment.`,
        timelineId
      }) as any;

      // Step 3: Verification
      const verifyRes = await this.callTool("workspace.timeline_run", {
        timelineId,
        command: "npm run test", // standard fallback
        timeoutMs: 60000
      }) as any;

      if (verifyRes.ok) {
        // Step 4: Promote
        await this.callTool("workspace.timeline_promote", {
          timelineId,
          mergeStrategy: "squash"
        });
        
        return {
          ok: true,
          action,
          status: "promoted",
          verification: "pass",
          details: `Successfully resolved TODO in ${file}`
        };
      } else {
        return {
          ok: false,
          action,
          status: "failed",
          verification: "fail",
          details: `Verification failed after attempting to resolve TODO in ${file}`,
          stdout: verifyRes.stdout,
          stderr: verifyRes.stderr
        };
      }
    }

    throw new Error("workspace.todo_resolver action must be scan or resolve");
  }
}
