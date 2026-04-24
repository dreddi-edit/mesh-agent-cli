import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("local tools expose moonshot public interfaces", () => {
  const source = readFileSync(new URL("../src/local-tools.ts", import.meta.url), "utf8");
  const expectedTools = [
    "workspace.index_status",
    "workspace.explain_symbol",
    "workspace.impact_map",
    "workspace.timeline_create",
    "workspace.timeline_apply_patch",
    "workspace.timeline_run",
    "workspace.timeline_compare",
    "workspace.timeline_promote",
    "frontend.preview",
    "runtime.start",
    "runtime.capture_failure",
    "runtime.explain_failure",
    "agent.spawn",
    "agent.review",
    "agent.merge_verified"
  ];

  for (const toolName of expectedTools) {
    assert.match(source, new RegExp(`name: "${toolName.replace(".", "\\.")}"`));
  }
});

test("package test runner excludes benchmark fixtures", () => {
  const runner = readFileSync(new URL("../scripts/run-tests.cjs", import.meta.url), "utf8");
  assert.match(runner, /"benchmarks"/);
  assert.match(runner, /Skipping benchmark fixtures/);
});
