import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("docs and xray surface reflect the implemented v1 features", () => {
  const moonshot = readFileSync(new URL("../MOONSHOT-FEATURES.md", import.meta.url), "utf8");
  assert.match(moonshot, /Implemented v1/);
  assert.match(moonshot, /Planned/);
  assert.match(moonshot, /Inspector-backed local variable capture/);
  assert.match(moonshot, /Causal Software Intelligence/);
  assert.match(moonshot, /Autonomous Discovery Lab/);
  assert.match(moonshot, /Reality Fork Engine/);
  assert.match(moonshot, /Ghost Engineer Replay/);

  const overlay = readFileSync(new URL("../src/mesh-canvas-overlay.js", import.meta.url), "utf8");
  assert.match(overlay, /requestLog/);
  assert.match(overlay, /XMLHttpRequest\.prototype\.open/);
  assert.match(overlay, /buildXrayPayload/);

  const agentLoop = readFileSync(new URL("../src/agent-loop.ts", import.meta.url), "utf8");
  assert.match(agentLoop, /workspace\.ask_codebase/);
  assert.match(agentLoop, /workspace\.trace_symbol/);
  assert.match(agentLoop, /Evidence:/);

  const runtime = readFileSync(new URL("../src/runtime-observer.ts", import.meta.url), "utf8");
  assert.match(runtime, /Debugger\.setPauseOnExceptions/);
  assert.match(runtime, /MESH_RUNTIME_AUTOPSY_PATH/);
  assert.match(runtime, /autopsy-hook\.cjs/);
});
