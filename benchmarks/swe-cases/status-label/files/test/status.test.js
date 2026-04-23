import test from "node:test";
import assert from "node:assert/strict";
import { formatStatusLabel } from "../src/status.js";

test("formatStatusLabel title-cases known statuses", () => {
  assert.equal(formatStatusLabel("in_progress"), "In Progress");
  assert.equal(formatStatusLabel("done"), "Done");
});
