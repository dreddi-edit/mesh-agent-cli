import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalToolBackend } from "../src/local-tools.ts";

function testConfig(workspaceRoot) {
  return {
    agent: {
      workspaceRoot,
      maxSteps: 8,
      mode: "local",
      enableCloudCache: false,
      themeColor: "cyan",
      voice: {
        configured: false,
        language: "auto",
        speed: 260,
        voice: "auto",
        microphone: "default",
        transcriptionModel: "small"
      }
    },
    bedrock: {
      endpointBase: "",
      modelId: "",
      fallbackModelIds: [],
      temperature: 0,
      maxTokens: 0
    },
    mcp: { args: [] },
    supabase: {},
    telemetry: {
      contribute: false
    }
  };
}

test("moonshot os tools build twin, memory, repair, intent, and cockpit state", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-moonshot-os-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;
  const backend = new LocalToolBackend(workspaceRoot, testConfig(workspaceRoot));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      name: "fixture",
      scripts: {
        test: "node src/app.js",
        build: "node src/app.js"
      },
      dependencies: {}
    }, null, 2));
    await writeFile(path.join(workspaceRoot, ".env.example"), "API_KEY=\nDATABASE_URL=\n");
    await writeFile(path.join(workspaceRoot, "src", "app.js"), [
      "export function getUser(req, res) { return res.json({ ok: true }); }",
      "app.get('/api/users/:id', getUser);",
      ""
    ].join("\n"));
    await writeFile(path.join(workspaceRoot, "src", "app.test.js"), "import './app.js';\n");

    const twin = await backend.callTool("workspace.digital_twin", { action: "build" });
    assert.equal(twin.ok, true);
    assert.ok(twin.twin.routes.some((r) => r.r.includes("/api/users")));
    assert.ok(twin.twin.symbols.some((s) => s.n === "getUser"));

    const memory = await backend.callTool("workspace.engineering_memory", {
      action: "record",
      outcome: "accepted",
      rule: "Verify API route changes with tests.",
      files: ["src/app.js"]
    });
    assert.equal(memory.ok, true);
    assert.ok(memory.memory.rules.includes("Verify API route changes with tests."));

    const repair = await backend.callTool("workspace.predictive_repair", { action: "analyze" });
    assert.equal(repair.ok, true);
    assert.ok(Array.isArray(repair.queue));

    const compiled = await backend.callTool("workspace.intent_compile", {
      intent: "add a new API endpoint for users"
    });
    assert.equal(compiled.ok, true);
    assert.ok(compiled.contract.interfaces.includes("API route/controller surface"));
    assert.ok(compiled.contract.rollout.verificationCommand);

    const cockpit = await backend.callTool("workspace.cockpit_snapshot", {});
    assert.equal(cockpit.ok, true);
    assert.ok(cockpit.health.score >= 0);

    const causal = await backend.callTool("workspace.causal_intelligence", { action: "build" });
    assert.equal(causal.ok, true);
    assert.ok(causal.graph.nodes.length > 0);
    assert.ok(Array.isArray(causal.graph.insights));

    const causalAnswer = await backend.callTool("workspace.causal_intelligence", {
      action: "query",
      query: "why are API changes risky"
    });
    assert.equal(causalAnswer.ok, true);
    assert.ok(causalAnswer.answer);

    const lab = await backend.callTool("workspace.discovery_lab", { action: "run" });
    assert.equal(lab.ok, true);
    assert.ok(Array.isArray(lab.discoveries));

    const fork = await backend.callTool("workspace.reality_fork", {
      action: "fork",
      intent: "add a new API endpoint for users",
      forks: 3
    });
    assert.equal(fork.ok, true);
    assert.equal(fork.proposals.length, 3);
    assert.ok(fork.proposals.every((proposal) => proposal.timelineId));

    const ghostProfile = await backend.callTool("workspace.ghost_engineer", { action: "learn" });
    assert.equal(ghostProfile.ok, true);
    assert.ok(ghostProfile.profile.habits.firstReadFiles.length > 0);

    const ghostPrediction = await backend.callTool("workspace.ghost_engineer", {
      action: "predict",
      goal: "add a new API endpoint for users"
    });
    assert.equal(ghostPrediction.ok, true);
    assert.ok(ghostPrediction.prediction.predictedApproach.firstReads.length > 0);
    assert.ok(ghostPrediction.prediction.autopilotPatch.suggestedPatchOrder.length > 0);

    const divergence = await backend.callTool("workspace.ghost_engineer", {
      action: "divergence",
      plan: "Change src/app.js quickly without tests or docs."
    });
    assert.equal(divergence.ok, true);
    assert.ok(divergence.divergence.alignmentScore <= 100);
    assert.ok(Array.isArray(divergence.divergence.warnings));

    const ghostPatch = await backend.callTool("workspace.ghost_engineer", {
      action: "patch",
      goal: "add a new API endpoint for users"
    });
    assert.equal(ghostPatch.ok, true);
    assert.ok(ghostPatch.timelineId);
    assert.ok(ghostPatch.autopilot.promotionGates.length > 0);
  } finally {
    await backend.close();
    if (previousStateDir === undefined) {
      delete process.env.MESH_STATE_DIR;
    } else {
      process.env.MESH_STATE_DIR = previousStateDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
