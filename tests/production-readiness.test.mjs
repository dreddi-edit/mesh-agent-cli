import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { routeMeshTask } from "../src/model-router.ts";
import { ProductionReadinessEngine } from "../src/production-readiness.ts";

test("model router chooses specialist gates for production-relevant tasks", () => {
  const route = routeMeshTask("review this auth runtime diff for security and test gaps");

  assert.equal(route.taskType, "security");
  assert.equal(route.primaryChatModel, "us.anthropic.claude-sonnet-4-6");
  assert.ok(route.retrievalModels.includes("nvidia/nv-embedcode-7b-v1"));
  assert.ok(route.safetyModels.includes("meta/llama-guard-4-12b"));
  assert.ok(route.requiredGates.includes("safety_guard"));
  assert.ok(route.requiredGates.includes("pii_scan"));
});

test("production readiness gate aggregates all seven dimensions", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-production-readiness-"));
  const calls = [];
  const engine = new ProductionReadinessEngine(workspaceRoot, async (name, args) => {
    calls.push({ name, args });
    if (name === "workspace.index_status") return { ok: true, percent: 100 };
    if (name === "workspace.ask_codebase") return {
      ok: true,
      results: [{ file: "src/app.ts" }, { file: "src/auth.ts" }, { file: "tests/app.test.ts" }],
      queryVariants: ["intent"]
    };
    if (name === "workspace.precrime") return { ok: true, predictions: [] };
    if (name === "workspace.timeline_list") return { ok: true, timelines: [{ id: "tl1" }] };
    if (name === "workspace.proof_carrying_change") return { ok: true, proof: {} };
    if (name === "workspace.production_status") return { ok: true, totalSignals: 1 };
    if (name === "workspace.predictive_repair") return { ok: true, queue: [] };
    if (name === "workspace.causal_autopsy") return { ok: true, graph: {} };
    if (name === "workspace.engineering_memory") return { ok: true, memory: { rules: ["rule"], decisions: ["decision"] } };
    if (name === "workspace.git_status") return { ok: true, status: " M src/app.ts\n M tests/app.test.ts" };
    if (name === "workspace.git_diff") return { ok: true, diff: "diff --git a/src/app.ts b/src/app.ts" };
    return { ok: true };
  });

  try {
    const report = await engine.run({
      action: "audit",
      intent: "ship a production auth change",
      verificationCommand: "npm test"
    });

    assert.equal(report.ok, true);
    assert.equal(report.dimensions.length, 7);
    assert.ok(report.score >= 75);
    assert.ok(calls.some((call) => call.name === "workspace.ask_codebase"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
