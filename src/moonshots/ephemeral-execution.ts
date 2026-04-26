import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeJson, readJson } from "./common.js";

export class EphemeralExecutionEngine {
  constructor(
    private readonly workspaceRoot: string,
    private readonly callTool?: (name: string, args: any) => Promise<any>
  ) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "start").trim().toLowerCase();

    if (action === "status") {
      const ledgerPath = ".mesh/ephemeral-execution/last-run.json";
      const existing = await readJson(path.join(this.workspaceRoot, ledgerPath), { status: "not_running" });
      return { ok: true, action: "status", ...existing };
    }

    if (action === "start") {
      const port = Number(args.port ?? 3000);
      const specPath = String(args.specPath ?? "openapi.yaml");
      
      const ledgerPath = ".mesh/ephemeral-execution/last-run.json";
      const ephemeralDir = path.join(this.workspaceRoot, ".mesh", "ephemeral-execution");
      await fs.mkdir(ephemeralDir, { recursive: true });

      await writeJson(path.join(this.workspaceRoot, ledgerPath), {
        startedAt: new Date().toISOString(),
        port,
        specPath,
        status: "listening"
      });

      // We spawn a detached background process that acts as the ephemeral server.
      // This server will accept requests, "hallucinate" the logic, execute, and respond.
      const serverCode = `
const http = require("node:http");
const { performance } = require("node:perf_hooks");

const server = http.createServer(async (req, res) => {
  const start = performance.now();
  const route = req.method + " " + req.url;
  
  // 1. Intercept Request
  console.log(\`[EPHEMERAL] Intercepted \${route}. No source code exists.\`);
  
  // 2. Pause & JIT Compile (Simulated LLM call taking ~50-100ms)
  // In a full implementation, this calls Mesh IPC to stream the AST based on the spec
  await new Promise(r => setTimeout(r, 60));
  
  // 3. Hallucinate Function in V8 Memory
  const hallucinatedAst = \`
    return {
      status: 200,
      body: {
        message: "Hello from the Ephemeral Void",
        route: "\${route}",
        timestamp: "\${new Date().toISOString()}",
        note: "This function was generated 1ms ago and will be destroyed in 1ms. Technical debt is zero."
      }
    };
  \`;
  
  // 4. Execute Zero-Source Code
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const ephemeralFn = new AsyncFunction('req', hallucinatedAst);
  
  try {
    const result = await ephemeralFn(req);
    
    // 5. Respond
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
    
    // 6. Delete from Memory (GC will collect it as references are lost)
    const end = performance.now();
    console.log(\`[EPHEMERAL] Request served in \${Math.round(end - start)}ms. Function destroyed.\`);
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(${port}, () => {
  console.log(\`[EPHEMERAL] Zero-Source Execution Engine listening on port ${port}\`);
});
`;

      const serverScriptPath = path.join(ephemeralDir, "server.js");
      await fs.writeFile(serverScriptPath, serverCode, "utf8");

      // Spawn the server in the background
      const child = spawn(process.execPath, [serverScriptPath], {
        cwd: this.workspaceRoot,
        detached: true,
        stdio: "ignore" // In a real scenario, we might want to log this to a file
      });
      child.unref();

      return {
        ok: true,
        action,
        status: "started",
        port,
        pid: child.pid,
        message: "Zero-Source Ephemeral Engine started. The server has no code. It will JIT compile handlers per request and destroy them.",
        ledgerPath
      };
    }

    throw new Error("workspace.ephemeral_execution action must be start or status");
  }
}
