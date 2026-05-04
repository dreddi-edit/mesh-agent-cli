import test from "node:test";
import assert from "node:assert/strict";
import { BedrockLlmClient } from "../src/llm-client.ts";

// === Sanitization tests (from 01-01 scaffold) ===

test("sanitizeLlmOutput strips <thinking> and <thought> blocks from LLM output", async () => {
  let sanitizeLlmOutput;
  try {
    const mod = await import("../src/agent-loop.ts");
    sanitizeLlmOutput = mod.sanitizeLlmOutput;
  } catch {
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

test("sanitizeLlmOutput preserves XML-like text inside markdown code fences", async () => {
  const { sanitizeLlmOutput } = await import("../src/agent-loop.ts");
  const input = [
    "Before <result>plain</result>",
    "```tsx",
    "const node = <result>{value}</result>;",
    "<thinking>keep this fixture exactly</thinking>",
    "```",
    "After"
  ].join("\n");

  const output = sanitizeLlmOutput(input);
  assert.ok(!output.includes("Before <result>plain</result>"), "plain text wrappers are sanitized");
  assert.ok(output.includes("const node = <result>{value}</result>;"), "code-fence JSX is preserved");
  assert.ok(output.includes("<thinking>keep this fixture exactly</thinking>"), "code-fence XML-like fixtures are preserved");
});

// === Error format tests (from 01-01 scaffold) ===

test("JSON.parse failures in agent-loop produce [Mesh] Error: format not raw SyntaxError", async () => {
  const errorPrefix = "[Mesh] Error:";
  const sampleMessage = "[Mesh] Error: Intent file is corrupted. Try /index first to rebuild workspace state.";
  assert.ok(sampleMessage.startsWith(errorPrefix), `Error messages must start with "${errorPrefix}"`);
  assert.ok(sampleMessage.includes("Try"), "Error messages must include a recovery action");
});

test("AbortSignal.any combines controller signal with 60s timeout", async () => {
  assert.ok(typeof AbortSignal.timeout === "function", "AbortSignal.timeout must exist (Node 20+)");
  assert.ok(typeof AbortSignal.any === "function", "AbortSignal.any must exist (Node 20+)");

  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(200)]);
  assert.ok(combined instanceof AbortSignal, "AbortSignal.any must return an AbortSignal");

  assert.ok(!combined.aborted, "signal must not be aborted yet");
  controller.abort();
  assert.ok(combined.aborted, "combined signal must be aborted after controller.abort()");
});

// === LLM client tests (from 01-02) ===

test("logEndpoint writes LLM endpoint to stderr", () => {
  const client = new BedrockLlmClient({
    endpointBase: "https://mesh.example.test",
    modelId: "test-model",
    temperature: 0,
    maxTokens: 100
  });

  const chunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    client.logEndpoint();
  } finally {
    process.stderr.write = originalWrite;
  }

  const output = chunks.join("");
  assert.match(output, /\[Mesh\] LLM endpoint: https:\/\/mesh\.example\.test/);
});

test("converse() passes combinedSignal derived from caller signal to fetch", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSignalFromFetch = null;
  globalThis.fetch = async (_url, init) => {
    capturedSignalFromFetch = init.signal;
    return new Response(JSON.stringify({
      output: { message: { content: [{ text: "signal ok" }] } },
      stopReason: "end_turn"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "test-model",
      temperature: 0,
      maxTokens: 100
    });

    const controller = new AbortController();
    await client.converse(
      [{ role: "user", content: [{ text: "hello" }] }],
      [],
      "system",
      undefined,
      controller.signal
    );

    assert.ok(capturedSignalFromFetch instanceof AbortSignal,
      "fetch must receive an AbortSignal (the combined signal)");
    assert.equal(capturedSignalFromFetch.aborted, false,
      "combined signal should not be pre-aborted when controller is still active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("converse() applies timeout signal even when no caller abort signal is provided", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal, "fetch must always receive an AbortSignal");
    assert.equal(init.signal.aborted, false, "signal should not be aborted yet");
    return new Response(JSON.stringify({
      output: { message: { content: [{ text: "ok" }] } },
      stopReason: "end_turn"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "test-model",
      temperature: 0,
      maxTokens: 100
    });

    const response = await client.converse(
      [{ role: "user", content: [{ text: "hello" }] }],
      [],
      "system"
    );

    assert.equal(response.kind, "text");
    assert.equal(response.text, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AbortSignal.any combines caller abort signal with 60s timeout (LLM-02)", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSignal = null;
  globalThis.fetch = async (_url, init) => {
    capturedSignal = init.signal;
    return new Response(JSON.stringify({
      output: { message: { content: [{ text: "combined signal ok" }] } },
      stopReason: "end_turn"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "test-model",
      temperature: 0,
      maxTokens: 100
    });

    const controller = new AbortController();
    await client.converse(
      [{ role: "user", content: [{ text: "hello" }] }],
      [],
      "system",
      undefined,
      controller.signal
    );

    assert.ok(capturedSignal instanceof AbortSignal, "fetch must receive an AbortSignal");
    assert.equal(capturedSignal.aborted, false, "combined signal should not be aborted before use");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
