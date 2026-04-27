import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CacheManager } from "../src/cache-manager.ts";
import { detectStreamingHazard } from "../src/llm-client.ts";
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
