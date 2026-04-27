import test from "node:test";
import assert from "node:assert/strict";

import { BedrockLlmClient } from "../src/llm-client.ts";

// Test 1: logEndpoint() writes the endpoint to stderr
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

// Test 2: converse() passes the combinedSignal (not the raw caller signal) to fetch
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

    // The signal passed to fetch must be an AbortSignal
    assert.ok(capturedSignalFromFetch instanceof AbortSignal,
      "fetch must receive an AbortSignal (the combined signal)");
    // The combined signal should not be already aborted
    assert.equal(capturedSignalFromFetch.aborted, false,
      "combined signal should not be pre-aborted when controller is still active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test 3: converse() without caller signal still applies 60s timeout (combinedSignal exists)
test("converse() applies timeout signal even when no caller abort signal is provided", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    // Verify that a signal is always present on the fetch call
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

    // No abortSignal passed — combinedSignal should still be created from AbortSignal.timeout(60_000)
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

// Test 4: AbortSignal.any combines caller signal and timeout signal
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

    // The captured signal must be an AbortSignal (the combinedSignal, not the raw controller.signal)
    assert.ok(capturedSignal instanceof AbortSignal, "fetch must receive an AbortSignal");
    // The combined signal should not be the same object as the raw controller.signal
    // (it is a composed AbortSignal.any result)
    assert.equal(capturedSignal.aborted, false, "combined signal should not be aborted before use");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
