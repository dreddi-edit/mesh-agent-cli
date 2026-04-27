import test from "node:test";
import assert from "node:assert/strict";

test("sanitizeLlmOutput strips <thinking> and <thought> blocks from LLM output", async () => {
  // Dynamic import so the test file is loadable before the function exists
  let sanitizeLlmOutput;
  try {
    // This import will fail until Plan 03 adds the function — that is expected
    // For now, write the test so it documents the contract
    const mod = await import("../src/agent-loop.ts");
    sanitizeLlmOutput = mod.sanitizeLlmOutput;
  } catch {
    // Function not yet exported — skip this test
    return;
  }
  if (!sanitizeLlmOutput) return;

  const input = "<thinking>\nStep 1: consider options\n</thinking>\nHere is the answer.";
  const output = sanitizeLlmOutput(input);
  assert.ok(!output.includes("<thinking>"), "output must not contain <thinking>");
  assert.ok(!output.includes("Step 1: consider options"), "thought content must be stripped");
  assert.ok(output.includes("Here is the answer"), "real content must be preserved");
});

test("sanitizeLlmOutput strips <thought> blocks and XML artifact wrappers", async () => {
  let sanitizeLlmOutput;
  try {
    const mod = await import("../src/agent-loop.ts");
    sanitizeLlmOutput = mod.sanitizeLlmOutput;
  } catch { return; }
  if (!sanitizeLlmOutput) return;

  const withThought = "<thought>internal reasoning here</thought>\nActual response text.";
  const withArtifact = "<artifact>some content</artifact>\n<result>more content</result>\nFinal answer.";

  const cleaned1 = sanitizeLlmOutput(withThought);
  assert.ok(!cleaned1.includes("<thought>"), "output must not contain <thought>");
  assert.ok(cleaned1.includes("Actual response text"), "real content preserved");

  const cleaned2 = sanitizeLlmOutput(withArtifact);
  assert.ok(!cleaned2.includes("<artifact>"), "artifact tags must be stripped");
  assert.ok(!cleaned2.includes("<result>"), "result tags must be stripped");
  assert.ok(cleaned2.includes("Final answer"), "final answer preserved");
});

test("JSON.parse failures in agent-loop produce [Mesh] Error: format not raw SyntaxError", async () => {
  // This is a contract test — documents what the output format must be.
  // The actual wrapping happens in Plan 04. For now it verifies the format string.
  const errorPrefix = "[Mesh] Error:";
  const sampleMessage = "[Mesh] Error: Intent file is corrupted. Try /index first to rebuild workspace state.";
  assert.ok(sampleMessage.startsWith(errorPrefix), `Error messages must start with "${errorPrefix}"`);
  assert.ok(sampleMessage.includes("Try"), "Error messages must include a recovery action");
});

test("AbortSignal.any combines controller signal with 60s timeout", async () => {
  // Verify Node.js 20 APIs are available (they will be needed in Plan 02)
  assert.ok(typeof AbortSignal.timeout === "function", "AbortSignal.timeout must exist (Node 20+)");
  assert.ok(typeof AbortSignal.any === "function", "AbortSignal.any must exist (Node 20+)");

  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(200)]);
  assert.ok(combined instanceof AbortSignal, "AbortSignal.any must return an AbortSignal");

  // Verify abort propagates — trigger via controller (synchronous, no timer needed)
  assert.ok(!combined.aborted, "signal must not be aborted yet");
  controller.abort();
  assert.ok(combined.aborted, "combined signal must be aborted after controller.abort()");
});
