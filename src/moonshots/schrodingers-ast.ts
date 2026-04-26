import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJson, readJson } from "./common.js";

export class SchrodingersAstEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "superpose").trim().toLowerCase();

    if (action === "status") {
      const ledgerPath = ".mesh/schrodingers-ast/active-states.json";
      const existing = await readJson(path.join(this.workspaceRoot, ledgerPath), { states: [] });
      return { ok: true, action: "status", states: existing.states };
    }

    if (action === "superpose") {
      const file = String(args.file ?? "");
      const functionName = String(args.functionName ?? "");
      const variants = args.variants as string[];

      if (!file || !functionName || !Array.isArray(variants) || variants.length < 2) {
        throw new Error("workspace.schrodingers_ast 'superpose' requires 'file', 'functionName', and an array of at least 2 'variants'.");
      }

      // Read target file
      const absolutePath = path.resolve(this.workspaceRoot, file);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
      if (!raw) throw new Error(`File not found or empty: ${file}`);

      // We inject a QuantumRouter that routes traffic and measures perf.
      // This is a simplified structural insertion for the moonshot.
      // A real implementation would parse AST and precisely replace the function body.
      const routerId = `quantum_${Date.now().toString(36)}`;
      
      const routerCode = `
// [MESH QUANTUM ROUTER INJECTED]
// Function: ${functionName}
// Superposition: ${variants.length} variants active.
const ${routerId}_metrics = { runs: 0, variants: ${JSON.stringify(variants.map((_, i) => ({ id: i, time: 0, calls: 0, errors: 0 })))} };
async function ${functionName}(...args) {
  const variantIndex = Math.floor(Math.random() * ${variants.length});
  const start = performance.now();
  try {
    let result;
    switch(variantIndex) {
${variants.map((v, i) => `      case ${i}: result = await (async function() { ${v} })(...args); break;`).join("\n")}
    }
    const end = performance.now();
    ${routerId}_metrics.variants[variantIndex].time += (end - start);
    ${routerId}_metrics.variants[variantIndex].calls++;
    ${routerId}_metrics.runs++;
    // In production, this would collapse after N runs via Mesh Daemon.
    return result;
  } catch(err) {
    ${routerId}_metrics.variants[variantIndex].errors++;
    ${routerId}_metrics.runs++;
    throw err;
  }
}
// [END QUANTUM ROUTER]
`;

      // Simplified Regex replacement: Assume it's a standard function declaration.
      // We replace `function funcName(...) { ... }` or `const funcName = ...`
      // For moonshot demo purposes, we append it if we can't find it easily, but let's try a regex.
      const fnRegex = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\([^{]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m");
      let updatedRaw = raw;
      if (fnRegex.test(raw)) {
        updatedRaw = raw.replace(fnRegex, routerCode);
      } else {
        updatedRaw += "\n" + routerCode;
      }

      await fs.writeFile(absolutePath, updatedRaw, "utf8");

      const ledgerPath = ".mesh/schrodingers-ast/active-states.json";
      const existing = await readJson<{ states: any[] }>(path.join(this.workspaceRoot, ledgerPath), { states: [] });
      const newState = {
        id: routerId,
        file,
        functionName,
        variantsCount: variants.length,
        superposedAt: new Date().toISOString(),
        status: "measuring"
      };
      existing.states.push(newState);
      await writeJson(path.join(this.workspaceRoot, ledgerPath), existing);

      return {
        ok: true,
        action,
        status: "superposed",
        file,
        functionName,
        variantsCount: variants.length,
        message: "Code successfully placed into Superposition. Quantum Router injected. Awaiting wave function collapse.",
        ledgerPath
      };
    }

    throw new Error("workspace.schrodingers_ast action must be superpose or status");
  }
}
