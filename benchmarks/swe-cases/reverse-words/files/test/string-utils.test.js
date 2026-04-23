import test from "node:test";
import assert from "node:assert/strict";
import { reverseWords } from "../src/string-utils.js";

test("reverseWords flips word order", () => {
  assert.equal(reverseWords("mesh cli benchmark"), "benchmark cli mesh");
});
