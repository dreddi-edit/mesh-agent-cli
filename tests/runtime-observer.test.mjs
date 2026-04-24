import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeObserver } from "../src/runtime-observer.ts";

test("runtime observer captures a real autopsy report for crashing node runs", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-runtime-observer-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;
  try {
    const observer = new RuntimeObserver(workspaceRoot);
    const run = await observer.start({
      command: `node -e "const answer = 42; throw new Error('mesh-boom')"`
    });

    const deadline = Date.now() + 6000;
    let report = null;
    while (Date.now() < deadline) {
      report = await observer.captureDeepAutopsy({ runId: run.runId });
      if (report.reason !== "log-fallback" && report.frames.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert.ok(report, "expected a report");
    assert.equal(report.ok, true);
    assert.ok(report.reportPath.endsWith("autopsy.json"));
    assert.ok(report.frames.length > 0, "expected inspector-backed frames");
    assert.ok(report.stackWithScope.length > 0, "expected stack with scope information");
    assert.ok(report.causalChain.length > 0, "expected causal chain entries");
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.MESH_STATE_DIR;
    } else {
      process.env.MESH_STATE_DIR = previousStateDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
