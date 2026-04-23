import test from "node:test";
import assert from "node:assert/strict";
import { clampPercentage } from "../src/math.js";

test("clampPercentage bounds values", () => {
  assert.equal(clampPercentage(-10), 0);
  assert.equal(clampPercentage(35), 35);
  assert.equal(clampPercentage(120), 100);
});
