import { promises as fs } from "node:fs";
import path from "node:path";

export class SmtEdgeCaseFinder {
  constructor(private readonly workspaceRoot: string) {}

  async find(args: { path: string; functionName?: string }): Promise<Record<string, unknown>> {
    const absolute = path.resolve(this.workspaceRoot, args.path);
    const raw = await fs.readFile(absolute, "utf8");
    const functionName = args.functionName || inferFunctionName(raw) || "unknown";
    const findings = inferEdgeCases(raw, functionName);
    const testsPath = absolute.replace(/\.tsx?$/, ".edge-cases.test.ts");
    if (findings.length > 0) {
      await fs.writeFile(testsPath, buildEdgeTest(functionName, findings), "utf8");
    }
    return {
      ok: true,
      functionName,
      findings,
      generatedTest: findings.length > 0 ? path.relative(this.workspaceRoot, testsPath) : null
    };
  }
}

function inferFunctionName(raw: string): string | null {
  const match = raw.match(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  return match?.[1] ?? null;
}

function inferEdgeCases(raw: string, functionName: string): Array<{ input: string; reason: string }> {
  const findings: Array<{ input: string; reason: string }> = [];
  if (/\bMath\.abs\(/.test(raw)) {
    findings.push({
      input: "-2147483648",
      reason: `${functionName}: abs edge-case may overflow integer assumptions`
    });
  }
  if (/\b\/\s*0\b/.test(raw) || /\bNumber\(/.test(raw)) {
    findings.push({
      input: "Infinity",
      reason: `${functionName}: division/coercion can produce non-finite values`
    });
  }
  if (/\?\./.test(raw) || /null|undefined/.test(raw)) {
    findings.push({
      input: "null",
      reason: `${functionName}: nullable path can violate assumptions`
    });
  }
  return findings;
}

function buildEdgeTest(functionName: string, findings: Array<{ input: string; reason: string }>): string {
  return [
    `import { ${functionName} } from "./${functionName}";`,
    ``,
    `describe("${functionName} SMT edge cases", () => {`,
    ...findings.map((finding) => [
      `  it("handles ${finding.input} (${finding.reason})", () => {`,
      `    expect(() => ${functionName}(${finding.input as any} as any)).not.toThrow();`,
      `  });`
    ].join("\n")),
    `});`,
    ``
  ].join("\n");
}
