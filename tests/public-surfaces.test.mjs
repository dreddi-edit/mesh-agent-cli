import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

test("local tools expose moonshot public interfaces through the runtime registry", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-public-surfaces-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;
  const backend = new LocalToolBackend(workspaceRoot, testConfig(workspaceRoot));

  try {
    const toolNames = new Set((await backend.listTools()).map((tool) => tool.name));
    const expectedTools = [
      "workspace.open_artifact",
      "workspace.index_status",
      "workspace.explain_symbol",
      "workspace.impact_map",
      "workspace.timeline_create",
      "workspace.timeline_apply_patch",
      "workspace.timeline_run",
      "workspace.timeline_compare",
      "workspace.timeline_promote",
      "frontend.preview",
      "runtime.start",
      "runtime.capture_failure",
      "runtime.explain_failure",
      "agent.spawn",
      "agent.review",
      "agent.merge_verified",
      "workspace.digital_twin",
      "workspace.predictive_repair",
      "workspace.engineering_memory",
      "workspace.company_brain",
      "workspace.issue_autopilot",
      "workspace.intent_compile",
      "workspace.cockpit_snapshot",
      "workspace.causal_intelligence",
      "workspace.discovery_lab",
      "workspace.reality_fork",
      "workspace.ghost_engineer",
      "workspace.self_defend",
      "workspace.precrime",
      "workspace.end_staging",
      "workspace.semantic_git",
      "workspace.probabilistic_codebase",
      "workspace.conversational_codebase",
      "workspace.spec_code",
      "workspace.natural_language_source",
      "workspace.fluid_mesh",
      "workspace.living_software",
      "workspace.proof_carrying_change",
      "workspace.causal_autopsy"
    ];

    for (const toolName of expectedTools) {
      assert.equal(toolNames.has(toolName), true, `missing tool ${toolName}`);
    }
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

test("package test runner excludes benchmark fixtures", () => {
  const runner = readFileSync(new URL("../scripts/run-tests.cjs", import.meta.url), "utf8");
  assert.match(runner, /"benchmarks"/);
  assert.match(runner, /Skipping benchmark fixtures/);
});
