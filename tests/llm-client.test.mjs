import test from "node:test";
import assert from "node:assert/strict";

import { BedrockLlmClient } from "../src/llm-client.ts";

test("Bedrock client retries fallback model on transient 429 response", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (requestedUrls.length === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({
      output: {
        message: {
          content: [{ text: "fallback ok" }]
        }
      },
      stopReason: "end_turn"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "primary-model",
      fallbackModelIds: ["fallback-model"],
      temperature: 0,
      maxTokens: 100
    });

    const response = await client.converse(
      [{ role: "user", content: [{ text: "hello" }] }],
      [],
      "system"
    );

    assert.equal(response.kind, "text");
    assert.equal(response.text, "fallback ok");
    assert.match(requestedUrls[0], /primary-model/);
    assert.match(requestedUrls[1], /fallback-model/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry retries same model up to 3 times on 429 before failing", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (_url) => {
    callCount++;
    return new Response("rate limited", { status: 429 });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "primary-model",
      temperature: 0,
      maxTokens: 100
    });

    await assert.rejects(
      () => client.converse(
        [{ role: "user", content: [{ text: "hello" }] }],
        [],
        "system"
      ),
      /LLM request failed/
    );

    // maxRetries=3 means 4 total attempts (initial + 3 retries)
    assert.equal(callCount, 4, `Expected 4 fetch calls (1 initial + 3 retries), got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry succeeds on 3rd retry attempt", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (_url) => {
    callCount++;
    if (callCount < 3) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({
      output: {
        message: {
          content: [{ text: "retry success" }]
        }
      },
      stopReason: "end_turn"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "primary-model",
      temperature: 0,
      maxTokens: 100
    });

    const response = await client.converse(
      [{ role: "user", content: [{ text: "hello" }] }],
      [],
      "system"
    );

    assert.equal(response.kind, "text");
    assert.equal(response.text, "retry success");
    assert.equal(callCount, 3, `Expected 3 fetch calls (2 retries then success), got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry does NOT retry on non-retryable 400 error", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (_url) => {
    callCount++;
    return new Response("bad request", { status: 400 });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.example.test",
      modelId: "primary-model",
      temperature: 0,
      maxTokens: 100
    });

    await assert.rejects(
      () => client.converse(
        [{ role: "user", content: [{ text: "hello" }] }],
        [],
        "system"
      ),
      /LLM request failed/
    );

    // 400 is not retryable — only 1 fetch call per model
    assert.equal(callCount, 1, `Expected 1 fetch call (no retries on 400), got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
