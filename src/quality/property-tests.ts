import { promises as fs } from "node:fs";
import path from "node:path";

export class PropertyTestGenerator {
  constructor(private readonly workspaceRoot: string) {}

  async generate(args: { path?: string; functionName?: string; all?: boolean }): Promise<Record<string, unknown>> {
    const targets = args.all ? await this.collectTsFiles() : [args.path].filter((value): value is string => Boolean(value));
    const written: string[] = [];
    for (const target of targets) {
      const abs = path.resolve(this.workspaceRoot, target);
      const raw = await fs.readFile(abs, "utf8").catch(() => "");
      if (!raw) continue;
      const functionName = args.functionName || inferFunctionName(raw);
      if (!functionName) continue;
      const propertyPath = abs.replace(/\.tsx?$/, ".property.test.ts");
      const content = buildPropertyTest(functionName, path.basename(target));
      await fs.writeFile(propertyPath, content, "utf8");
      written.push(path.relative(this.workspaceRoot, propertyPath));
    }
    return {
      ok: true,
      generated: written.length,
      files: written
    };
  }

  private async collectTsFiles(): Promise<string[]> {
    const src = path.join(this.workspaceRoot, "src");
    const files: string[] = [];
    await walk(src, files);
    return files.filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts") && !file.endsWith(".property.test.ts"))
      .map((file) => path.relative(this.workspaceRoot, file));
  }
}

function buildPropertyTest(functionName: string, sourceLabel: string): string {
  return [
    `import fc from "fast-check";`,
    `import { ${functionName} } from "./${sourceLabel.replace(/\.ts$/, "")}";`,
    ``,
    `describe("${functionName} property checks", () => {`,
    `  it("is deterministic for identical input", () => {`,
    `    fc.assert(`,
    `      fc.property(fc.anything(), (input) => {`,
    `        const first = ${functionName}(input as any);`,
    `        const second = ${functionName}(input as any);`,
    `        expect(JSON.stringify(first)).toBe(JSON.stringify(second));`,
    `      }),`,
    `      { numRuns: 1000 }`,
    `    );`,
    `  });`,
    `});`,
    ``
  ].join("\n");
}

function inferFunctionName(raw: string): string | null {
  const match = raw.match(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  return match?.[1] ?? null;
}

async function walk(current: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const next = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(next, files);
    } else {
      files.push(next);
    }
  }
}
