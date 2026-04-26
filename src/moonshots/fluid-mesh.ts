import { promises as fs } from "node:fs";
import path from "node:path";
import { collectWorkspaceFiles, lineNumberAt, writeJson, readJson } from "./common.js";

interface Capability {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: "script" | "route" | "tool" | "export";
  provides: string[];
  dependsOn: string[];
}

export class FluidMeshEngine {
  constructor(private readonly workspaceRoot: string) {}

  async run(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const action = String(args.action ?? "map").trim().toLowerCase();
    if (action === "status") return this.status();
    if (action !== "map") throw new Error("workspace.fluid_mesh action must be map|status");
    const capabilities: Capability[] = [];
    capabilities.push(...await this.packageScripts());
    const files = await collectWorkspaceFiles(this.workspaceRoot, { maxFiles: 1500 });
    for (const file of files) {
      const raw = await fs.readFile(path.join(this.workspaceRoot, file), "utf8").catch(() => "");
      capabilities.push(...extractCapabilities(file, raw));
    }
    const manifest = {
      ok: true,
      action,
      generatedAt: new Date().toISOString(),
      capabilities,
      graph: capabilities.map((capability) => ({
        id: capability.id,
        provides: capability.provides,
        dependsOn: capability.dependsOn
      })),
      exportable: capabilities.filter((item) => item.kind === "script" || item.kind === "export").length,
      manifestPath: ".mesh/fluid-mesh/capabilities.json"
    };
    await writeJson(this.manifestPath(), manifest);
    return manifest;
  }

  private async status(): Promise<Record<string, unknown>> {
    return readJson(this.manifestPath(), {
      ok: true,
      action: "status",
      capabilities: [],
      message: "No fluid mesh capability manifest exists yet. Run action=map."
    });
  }

  private async packageScripts(): Promise<Capability[]> {
    const raw = await fs.readFile(path.join(this.workspaceRoot, "package.json"), "utf8").catch(() => "");
    if (!raw) return [];
    const pkg = safeParsePackage(raw);
    return Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({
      id: slug(`script:${name}`),
      name,
      file: "package.json",
      line: 1,
      kind: "script" as const,
      provides: [`script:${name}`],
      dependsOn: String(command).match(/\b(tsc|node|npm|vitest|jest|tsx|wrangler)\b/g) ?? []
    }));
  }

  private manifestPath(): string {
    return path.join(this.workspaceRoot, ".mesh", "fluid-mesh", "capabilities.json");
  }
}

function extractCapabilities(file: string, raw: string): Capability[] {
  const capabilities: Capability[] = [];
  const routeRe = /\b(?:app|router|server)\.(get|post|put|patch|delete|all)\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of raw.matchAll(routeRe)) {
    capabilities.push({
      id: slug(`route:${match[1]}:${match[3]}:${file}`),
      name: `${match[1].toUpperCase()} ${match[3]}`,
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "route",
      provides: [`http:${match[1].toUpperCase()}:${match[3]}`],
      dependsOn: inferDependencies(raw)
    });
  }
  const toolRe = /name:\s*(["'`])(workspace\.[A-Za-z0-9_.-]+|agent\.[A-Za-z0-9_.-]+|runtime\.[A-Za-z0-9_.-]+)\1/g;
  for (const match of raw.matchAll(toolRe)) {
    capabilities.push({
      id: slug(`tool:${match[2]}`),
      name: match[2],
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "tool",
      provides: [`tool:${match[2]}`],
      dependsOn: inferDependencies(raw)
    });
  }
  const exportRe = /\bexport\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of raw.matchAll(exportRe)) {
    capabilities.push({
      id: slug(`export:${file}:${match[1]}`),
      name: match[1],
      file,
      line: lineNumberAt(raw, match.index ?? 0),
      kind: "export",
      provides: [`symbol:${match[1]}`],
      dependsOn: inferDependencies(raw)
    });
  }
  return capabilities;
}

function inferDependencies(raw: string): string[] {
  return Array.from(raw.matchAll(/from\s+(["'`])([^"'`]+)\1/g)).map((match) => match[2]).slice(0, 20);
}

function safeParsePackage(raw: string): { scripts?: Record<string, unknown> } {
  try {
    return JSON.parse(raw) as { scripts?: Record<string, unknown> };
  } catch {
    return {};
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}
