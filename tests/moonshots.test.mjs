import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("moonshot proof and autopsy tools expose concrete ledgers and findings", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-moonshots-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;
  const backend = new LocalToolBackend(workspaceRoot, testConfig(workspaceRoot));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      name: "moonshot-fixture",
      scripts: { test: "node -e \"process.exit(0)\"" }
    }, null, 2));
    await writeFile(path.join(workspaceRoot, "src", "auth.ts"), [
      "export function validateSession(token: string) {",
      "  const unsafe = /^(a+)+$/;",
      "  return unsafe.test(token);",
      "}",
      ""
    ].join("\n"));
    await writeFile(path.join(workspaceRoot, "src", "routes.ts"), [
      "const app = { get(_path: string, _handler: Function) {} };",
      "app.get('/login', function loginRoute() { return true; });",
      ""
    ].join("\n"));
    await writeFile(path.join(workspaceRoot, "src", "profile.ts"), [
      "export function normalizeProfile(input: { name: string }) {",
      "  return { name: input.name.trim() };",
      "}",
      ""
    ].join("\n"));
    await writeFile(path.join(workspaceRoot, "src", "profile.test.ts"), [
      "import test from 'node:test';",
      "test('normalizeProfile trims names', () => {});",
      ""
    ].join("\n"));
    await writeFile(path.join(workspaceRoot, "src", "conflict.ts"), [
      "<<<<<<< HEAD",
      "export function alpha() { return 1; }",
      "=======",
      "export function beta() { return 2; }",
      ">>>>>>> feature",
      ""
    ].join("\n"));

    const selfDefense = await backend.callTool("workspace.self_defend", { action: "scan", path: "src/auth.ts" });
    assert.equal(selfDefense.ok, true);
    assert.equal(selfDefense.suspicious, 1);
    assert.equal(selfDefense.findings[0].status, "suspicious");

    const harden = await backend.callTool("workspace.self_defend", {
      action: "harden",
      path: "src/auth.ts",
      verificationCommand: "npm test"
    });
    assert.equal(harden.ok, true);
    assert.equal(harden.patched, 1);
    assert.equal(harden.attempts[0].status, "timeline_ready");
    assert.equal(harden.attempts[0].verification.ok, true);
    assert.ok(harden.attempts[0].timelineId);
    const authAfterHarden = await readFile(path.join(workspaceRoot, "src", "auth.ts"), "utf8");
    assert.doesNotMatch(authAfterHarden, /length > 2048/);

    const companionTick = await backend.callTool("workspace.self_defend", { action: "daemon_tick", path: "src/auth.ts" });
    assert.equal(companionTick.ok, true);
    assert.equal(companionTick.probedFiles, 1);
    assert.ok(companionTick.nextWakeSeconds <= 3600);

    for (let i = 0; i < 3; i += 1) {
      const outcome = await backend.callTool("workspace.precrime", {
        action: "record_outcome",
        file: "src/auth.ts",
        incident: true,
        severity: "critical",
        tags: ["auth", "missing-tests"],
        notes: "Historical auth change caused a production incident."
      });
      assert.equal(outcome.ok, true);
    }

    const precrime = await backend.callTool("workspace.precrime", { action: "analyze", maxFiles: 20 });
    assert.equal(precrime.ok, true);
    const authPrediction = precrime.predictions.find((item) => item.file === "src/auth.ts");
    assert.ok(authPrediction);
    assert.ok(authPrediction.matchedHistoricalCases >= 3);
    assert.ok(["warn", "require_timeline_verification", "block_extended_verification"].includes(authPrediction.gate));

    const precrimeGate = await backend.callTool("workspace.precrime", { action: "gate", path: "src/auth.ts" });
    assert.equal(precrimeGate.ok, true);
    assert.notEqual(precrimeGate.gate, "pass");
    assert.ok(precrimeGate.requiredVerification.length >= 1);

    const semanticGit = await backend.callTool("workspace.semantic_git", { action: "analyze", path: "src/conflict.ts" });
    assert.equal(semanticGit.ok, true);
    assert.equal(semanticGit.autoResolvable, 1);
    assert.equal(semanticGit.semanticMergeReady, true);

    const semanticPlan = await backend.callTool("workspace.semantic_git", { action: "plan", path: "src/conflict.ts" });
    assert.equal(semanticPlan.ok, true);
    assert.equal(semanticPlan.canAutoResolve, true);
    assert.equal(semanticPlan.patches.length, 1);

    const semanticResolve = await backend.callTool("workspace.semantic_git", {
      action: "resolve",
      path: "src/conflict.ts",
      verificationCommand: "npm test"
    });
    assert.equal(semanticResolve.ok, true);
    assert.equal(semanticResolve.resolvedCount, 1);
    assert.equal(semanticResolve.verification.verdict, "pass");
    assert.equal(semanticResolve.promoted, false);
    const conflictAfterResolve = await readFile(path.join(workspaceRoot, "src", "conflict.ts"), "utf8");
    assert.match(conflictAfterResolve, /<<<<<<< HEAD/);

    const probabilistic = await backend.callTool("workspace.probabilistic_codebase", { action: "plan", intent: "reduce login latency" });
    assert.equal(probabilistic.ok, true);
    assert.ok(probabilistic.experiments.some((item) => item.file === "src/routes.ts"));

    const shadow = await backend.callTool("workspace.end_staging", {
      action: "shadow",
      command: "node -e \"process.exit(0)\"",
      timeoutMs: 30_000
    });
    assert.equal(shadow.ok, true);
    assert.equal(shadow.gates.verification, "pass");

    const specCode = await backend.callTool("workspace.spec_code", { action: "synthesize" });
    assert.equal(specCode.ok, true);
    assert.ok(specCode.contracts.some((item) => item.subject === "normalizeProfile"));
    assert.equal(specCode.summary.exportedFunctions >= 2, true);

    const assertedSpec = await backend.callTool("workspace.spec_code", {
      action: "assert",
      subject: "normalizeProfile",
      file: "src/profile.ts",
      behavior: "Profile normalization trims user-facing names and preserves deterministic output."
    });
    assert.equal(assertedSpec.ok, true);
    assert.equal(assertedSpec.contract.implementationStatus, "implemented");

    const missingSpec = await backend.callTool("workspace.spec_code", {
      action: "assert",
      subject: "verifyInvoiceSignature",
      file: "src/billing.ts",
      behavior: "Verify invoice signatures before accepting billing events."
    });
    assert.equal(missingSpec.ok, true);
    assert.equal(missingSpec.contract.implementationStatus, "missing");

    const materialized = await backend.callTool("workspace.spec_code", { action: "materialize", subject: "verifyInvoiceSignature" });
    assert.equal(materialized.ok, true);
    assert.equal(materialized.patches.length, 1);
    assert.match(materialized.patches[0].patch, /verifyInvoiceSignature/);

    const conversationalMap = await backend.callTool("workspace.conversational_codebase", { action: "map" });
    assert.equal(conversationalMap.ok, true);
    assert.ok(conversationalMap.symbols >= 1);
    const conversationalRecord = await backend.callTool("workspace.conversational_codebase", {
      action: "record",
      symbol: "normalizeProfile",
      note: "Profile normalization trims user-facing names."
    });
    assert.equal(conversationalRecord.ok, true);
    const conversationalAsk = await backend.callTool("workspace.conversational_codebase", {
      action: "ask",
      query: "normalizeProfile"
    });
    assert.match(conversationalAsk.answer, /normalizeProfile/);

    const nlSource = await backend.callTool("workspace.natural_language_source", {
      action: "compile",
      intent: "Add validation in src/profile.ts and verify with a test that blank names are rejected."
    });
    assert.equal(nlSource.ok, true);
    assert.ok(nlSource.ir.operations.includes("add"));
    assert.ok(nlSource.ir.operations.includes("validate"));

    const fluidMesh = await backend.callTool("workspace.fluid_mesh", { action: "map" });
    assert.equal(fluidMesh.ok, true);
    assert.ok(fluidMesh.capabilities.some((item) => item.provides.includes("script:test")));
    assert.ok(fluidMesh.capabilities.some((item) => item.provides.includes("http:GET:/login")));

    const proof = await backend.callTool("workspace.proof_carrying_change", {
      action: "generate",
      intent: "Harden profile validation and login safety before promotion."
    });
    assert.equal(proof.ok, true);
    assert.ok(["ready_to_promote", "ready_with_review", "incomplete", "blocked"].includes(proof.verdict));
    assert.ok(proof.touchedCapabilities.some((item) => item.file === "src/routes.ts"));
    assert.ok(proof.affectedContracts.some((item) => item.file === "src/profile.ts"));
    assert.equal(proof.gates.verification, "pass");

    const verifiedProof = await backend.callTool("workspace.proof_carrying_change", {
      action: "verify",
      intent: "Harden profile validation and login safety before promotion.",
      verificationCommand: "node -e \"process.exit(0)\""
    });
    assert.equal(verifiedProof.ok, true);
    assert.equal(verifiedProof.verification.executed, true);
    assert.equal(verifiedProof.gates.verification, "pass");

    const autopsy = await backend.callTool("workspace.causal_autopsy", {
      action: "investigate",
      symptom: "auth regex vulnerability during login"
    });
    assert.equal(autopsy.ok, true);
    assert.ok(autopsy.suspects.some((item) => item.file === "src/auth.ts"));
    assert.ok(autopsy.graph.nodes.length >= 2);
    assert.ok(autopsy.missingInvariants.length >= 1);

    const living = await backend.callTool("workspace.living_software", { action: "pulse" });
    assert.equal(living.ok, true);
    assert.ok(["embryonic", "learning", "self-maintaining"].includes(living.organismState));
    assert.ok(typeof living.scores.immune === "number");
    assert.ok(living.signals.naturalLanguageOperations.includes("add"));
    assert.ok(typeof living.scores.capabilityFluidity === "number");
    assert.notEqual(living.signals.proofVerdict, "none");
    assert.ok(typeof living.scores.causalClarity === "number");
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
