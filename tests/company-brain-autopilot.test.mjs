import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompanyBrainEngine } from "../src/company-brain.ts";
import { IssueAutopilotEngine } from "../src/issue-autopilot.ts";

test("company brain builds durable repo intelligence and answers with citations", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-company-brain-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      name: "brain-test",
      version: "1.0.0",
      scripts: { test: "node --test", typecheck: "tsc --noEmit" }
    }, null, 2));
    await writeFile(path.join(workspaceRoot, "README.md"), "Auth gateway validates session tokens before routing requests.");
    await writeFile(path.join(workspaceRoot, "src", "auth.ts"), [
      "export function validateSession(token: string) {",
      "  if (!token) throw new Error('missing token');",
      "  return token.startsWith('sess_');",
      "}"
    ].join("\n"));

    const engine = new CompanyBrainEngine(workspaceRoot, async (name) => {
      if (name === "workspace.digital_twin") return {
        ok: true,
        path: ".mesh/digital-twin.json",
        twin: {
          riskHotspots: [{ file: "src/auth.ts", risks: ["auth boundary"], score: 5 }],
          routes: []
        }
      };
      if (name === "workspace.engineering_memory") return {
        ok: true,
        path: ".mesh/engineering-memory.json",
        memory: {
          rules: ["Auth changes require tests."],
          decisions: ["Use session tokens at the gateway."],
          acceptedPatterns: [],
          rejectedPatterns: [],
          events: []
        }
      };
      return { ok: true };
    });

    const built = await engine.build();
    assert.equal(built.ok, true);
    assert.ok(built.stats.documents >= 3);

    const answer = await engine.query({ query: "auth session token validation" });
    assert.equal(answer.ok, true);
    assert.ok(answer.citations.length > 0);
    assert.ok(answer.recommendedFiles.includes("src/auth.ts"));
    assert.match(answer.answer, /Company Brain found/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("issue autopilot can run a verified timeline workflow with supplied patch", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-autopilot-"));
  const calls = [];
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      name: "autopilot-test",
      scripts: { test: "node --version" }
    }, null, 2));
    await writeFile(path.join(workspaceRoot, "src", "feature.ts"), "export const enabled = false;\n");

    const engine = new IssueAutopilotEngine(workspaceRoot, {
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "workspace.digital_twin") return { ok: true, twin: { riskHotspots: [] } };
        if (name === "workspace.engineering_memory") return { ok: true, memory: { rules: [], decisions: [], events: [] } };
        if (name === "workspace.intent_compile") return { ok: true, contract: { likelyFiles: ["src/feature.ts"] } };
        if (name === "workspace.impact_map") return { ok: true, ranked: [{ file: "src/feature.ts", score: 1 }] };
        if (name === "workspace.model_route") return { ok: true, route: { taskType: "code" } };
        if (name === "workspace.timeline_create") return { ok: true, timeline: { id: "tl-1", root: path.join(workspaceRoot, ".timeline") } };
        if (name === "workspace.timeline_apply_patch") return { ok: true, message: "Patch applied in isolated timeline." };
        if (name === "workspace.timeline_run") return { ok: true, exitCode: 0, stdout: "v20.0.0", stderr: "" };
        if (name === "workspace.timeline_compare") return {
          ok: true,
          comparisons: [{
            id: "tl-1",
            changedFiles: ["src/feature.ts", "tests/feature.test.ts"],
            changedLineCount: 4,
            diffPreview: "diff --git a/src/feature.ts b/src/feature.ts\n+export const enabled = true;\ndiff --git a/tests/feature.test.ts b/tests/feature.test.ts\n+assert.equal(enabled, true);"
          }]
        };
        return { ok: true };
      }
    });

    const result = await engine.run({
      action: "run",
      title: "Enable feature flag",
      body: "Set enabled to true and verify.",
      patch: "diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;\n",
      verificationCommand: "node --version"
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "verified");
    assert.equal(result.proof.verdict, "pass");
    assert.ok(calls.some((call) => call.name === "workspace.timeline_run"));

    const latest = JSON.parse(await readFile(path.join(workspaceRoot, ".mesh", "autopilot", "latest.json"), "utf8"));
    assert.equal(latest.status, "verified");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
