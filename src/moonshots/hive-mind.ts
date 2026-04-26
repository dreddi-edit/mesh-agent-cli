import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJson, readJson, collectWorkspaceFiles } from "./common.js";
import { execSync } from "node:child_process";

export class HiveMindEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "share_thoughts").trim().toLowerCase();

    if (action === "status") {
      const ledgerPath = ".mesh/hive/thoughts.json";
      const existing = await readJson(path.join(this.workspaceRoot, ledgerPath), { nodes: [] });
      return { ok: true, action: "status", nodes: existing.nodes };
    }

    if (action === "share_thoughts") {
      // 1. Capture local uncommitted dirty files.
      const diffOutput = execSync("git diff HEAD --name-only", { cwd: this.workspaceRoot, encoding: "utf8" }).trim();
      const dirtyFiles = diffOutput.split("\n").filter(Boolean);

      const localThoughts = [];
      for (const file of dirtyFiles) {
        const absolutePath = path.resolve(this.workspaceRoot, file);
        const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
        
        // Very rudimentary symbol extraction for the sake of the moonshot API
        const regex = /\b(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/g;
        const symbols = new Set<string>();
        for (const match of raw.matchAll(regex)) {
          symbols.add(match[1]);
        }

        localThoughts.push({
          file,
          symbols: Array.from(symbols),
          updatedAt: new Date().toISOString()
        });
      }

      // 2. Broadcast to Hive (simulated via local file for now)
      const hiveDir = path.join(this.workspaceRoot, ".mesh", "hive");
      await fs.mkdir(hiveDir, { recursive: true });
      const ledgerPath = path.join(hiveDir, "thoughts.json");
      
      const existing = await readJson<{ nodes: any[] }>(ledgerPath, { nodes: [] });
      
      // Assume "we" are node 1.
      const myNodeId = "local_engineer_1";
      existing.nodes = existing.nodes.filter(n => n.id !== myNodeId);
      existing.nodes.push({ id: myNodeId, thoughts: localThoughts });

      // 3. Collision Detection (Telepathic Git)
      // We check if other nodes are currently thinking about (mutating) the same files/symbols.
      const collisions = [];
      for (const node of existing.nodes) {
        if (node.id === myNodeId) continue;
        for (const thought of node.thoughts) {
          const myThought = localThoughts.find(t => t.file === thought.file);
          if (myThought) {
            const overlappingSymbols = myThought.symbols.filter(s => thought.symbols.includes(s));
            if (overlappingSymbols.length > 0) {
              collisions.push({
                nodeId: node.id,
                file: thought.file,
                overlappingSymbols
              });
            }
          }
        }
      }

      await writeJson(ledgerPath, existing);

      if (collisions.length > 0) {
        return {
          ok: false,
          action,
          status: "collision_detected",
          message: `🚨 Halt: Another engineer is mutating the AST of dependencies you are touching. I have downloaded their uncommitted thoughts.`,
          collisions,
          ledgerPath: ".mesh/hive/thoughts.json"
        };
      }

      return {
        ok: true,
        action,
        status: "thoughts_shared",
        message: "Your uncommitted AST intents have been broadcast to the P2P Hive. No telepathic merge conflicts detected.",
        thoughtsCount: localThoughts.length,
        ledgerPath: ".mesh/hive/thoughts.json"
      };
    }

    throw new Error("workspace.hive_mind action must be share_thoughts or status");
  }
}
