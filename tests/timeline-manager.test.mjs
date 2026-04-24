import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { TimelineManager } from "../src/timeline-manager.ts";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("timeline comparison returns telemetry for multiverse ranking", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mesh-timeline-manager-"));
  const previousStateDir = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;
  try {
    await writeFile(path.join(workspaceRoot, "sample.js"), 'console.log("before");\n', "utf8");
    git(workspaceRoot, ["init"]);
    git(workspaceRoot, ["config", "user.email", "mesh@example.com"]);
    git(workspaceRoot, ["config", "user.name", "Mesh"]);
    git(workspaceRoot, ["add", "."]);
    git(workspaceRoot, ["commit", "-m", "init"]);

    const manager = new TimelineManager(workspaceRoot);
    const created = await manager.create({ name: "telemetry" });
    const patch = [
      "diff --git a/sample.js b/sample.js",
      "index 1111111..2222222 100644",
      "--- a/sample.js",
      "+++ b/sample.js",
      "@@ -1 +1 @@",
      '-console.log("before");',
      '+console.log("after");',
      ""
    ].join("\n");

    const applied = await manager.applyPatch({ timelineId: created.timeline.id, patch });
    assert.equal(applied.ok, true);

    const run = await manager.run({ timelineId: created.timeline.id, command: 'node -e "process.exit(0)"' });
    assert.equal(run.ok, true);

    const comparison = await manager.compare({ timelineIds: [created.timeline.id] });
    assert.equal(comparison.ok, true);
    assert.ok(comparison.comparisons[0].changedFiles.includes("sample.js"));
    assert.ok(Number(comparison.comparisons[0].changedLineCount) >= 2);
    assert.ok(Number(comparison.comparisons[0].commandDurationMs) >= 0);
    assert.ok(comparison.comparisons[0].lastCommand.durationMs >= 0);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.MESH_STATE_DIR;
    } else {
      process.env.MESH_STATE_DIR = previousStateDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
