import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentLoop } from "../src/agent-loop.ts";
import { CacheManager } from "../src/cache-manager.ts";
import { BedrockLlmClient, detectStreamingHazard } from "../src/llm-client.ts";
import { TimelineManager } from "../src/timeline-manager.ts";

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

test("cache manager batch returns L1 hits and leaves misses absent", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-cache-batch-"));
  const cache = new CacheManager(testConfig(workspaceRoot));

  try {
    await cache.setCapsule("src/one.ts", "medium", "cached", 100, "hash-1");
    const result = await cache.getCapsuleBatch([
      { filePath: "src/one.ts", tier: "medium", mtimeMs: 100, contentHash: "hash-1" },
      { filePath: "src/two.ts", tier: "medium", mtimeMs: 200, contentHash: "hash-2" }
    ]);

    assert.equal(result.size, 1);
    assert.equal(result.get("src/one.ts\u0000medium")?.content, "cached");
    assert.equal(result.has("src/two.ts\u0000medium"), false);
  } finally {
    await cache.flushCache();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("timeline manager falls back to copy mode outside git worktrees", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-timeline-copy-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;

  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");

    const timelines = new TimelineManager(workspaceRoot);
    const created = await timelines.create({ name: "copy-fallback" });

    assert.equal(created.timeline.kind, "copy");
    assert.equal(created.timeline.status, "created");
    await timelines.close();
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.MESH_STATE_DIR;
    } else {
      process.env.MESH_STATE_DIR = previousStateDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("streaming hazard detection catches high-confidence broken patterns", () => {
  assert.match(
    detectStreamingHazard("", "const x = undefined.value;") ?? "",
    /null\/undefined property access/
  );
  assert.match(
    detectStreamingHazard("", "const token = process.env.API_KEY.trim();") ?? "",
    /unsafe chained env access/
  );
  assert.equal(detectStreamingHazard("", "const value = process.env.API_KEY ?? '';"), null);
});

test("llm client tries configured fallback models when selected model is missing", async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response("missing model", { status: 404 });
    }
    return Response.json({
      output: { message: { content: [{ text: "fallback ok" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  };

  try {
    const client = new BedrockLlmClient({
      endpointBase: "https://mesh.test",
      modelId: "primary-model",
      fallbackModelIds: ["fallback-model"],
      temperature: 0,
      maxTokens: 100
    });

    const response = await client.converse(
      [{ role: "user", content: [{ text: "hello" }] }],
      [],
      "system",
      "primary-model"
    );

    assert.equal(response.kind, "text");
    assert.equal(response.text, "fallback ok");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /primary-model/);
    assert.match(calls[1], /fallback-model/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("agent falls back from unavailable streaming and skips stream on later turns", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-agent-stream-fallback-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  const previousFetch = globalThis.fetch;
  process.env.MESH_STATE_DIR = workspaceRoot;
  const calls = [];

  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (requestUrl.includes("/converse-stream")) {
      return new Response(
        JSON.stringify({ error: "not_found", hint: "Use POST /model/{modelId}/converse" }),
        { status: 404 }
      );
    }
    return Response.json({
      output: { message: { content: [{ text: "pong" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  };

  const config = testConfig(workspaceRoot);
  config.bedrock.endpointBase = "https://mesh.test";
  config.bedrock.modelId = "primary-model";
  config.bedrock.fallbackModelIds = ["fallback-model"];
  config.bedrock.maxTokens = 20;
  const backend = {
    async listTools() {
      return [];
    },
    async invokeTool(name) {
      return { ok: false, error: `unexpected tool call ${name}` };
    },
    async close() {}
  };

  try {
    const agent = new AgentLoop(config, backend);
    let firstDeltas = "";
    let secondDeltas = "";

    const first = await agent.runHeadlessTurn("reply with pong", {
      onDelta: (delta) => {
        firstDeltas += delta;
      },
      askPermission: async () => false
    });
    const streamCallsAfterFirst = calls.filter((url) => url.includes("/converse-stream")).length;

    const second = await agent.runHeadlessTurn("reply with pong again", {
      onDelta: (delta) => {
        secondDeltas += delta;
      },
      askPermission: async () => false
    });
    const streamCallsAfterSecond = calls.filter((url) => url.includes("/converse-stream")).length;

    assert.equal(first.text, "pong");
    assert.equal(second.text, "pong");
    assert.equal(firstDeltas, "pong");
    assert.equal(secondDeltas, "pong");
    assert.equal(streamCallsAfterFirst, 2);
    assert.equal(streamCallsAfterSecond, streamCallsAfterFirst);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStateDir === undefined) {
      delete process.env.MESH_STATE_DIR;
    } else {
      process.env.MESH_STATE_DIR = previousStateDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
