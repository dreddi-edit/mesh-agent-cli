import test from "node:test";
import assert from "node:assert/strict";
import { getOpenItems } from "../src/items.js";

test("getOpenItems excludes done entries", () => {
  const items = [
    { id: 1, status: "todo" },
    { id: 2, status: "done" },
    { id: 3, status: "in_progress" }
  ];
  assert.deepEqual(getOpenItems(items), [
    { id: 1, status: "todo" },
    { id: 3, status: "in_progress" }
  ]);
});
