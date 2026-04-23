import test from "node:test";
import assert from "node:assert/strict";
import { loadPort } from "../src/config.js";

test("loadPort uses fallback on invalid input", () => {
  assert.equal(loadPort("abc", 8080), 8080);
  assert.equal(loadPort("0", 8080), 8080);
  assert.equal(loadPort("4500", 8080), 4500);
});
