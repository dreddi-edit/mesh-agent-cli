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
