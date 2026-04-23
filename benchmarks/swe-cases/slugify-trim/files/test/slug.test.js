import test from "node:test";
import assert from "node:assert/strict";
import { slugifyTitle } from "../src/slug.js";

test("slugifyTitle collapses repeated spaces into one dash", () => {
  assert.equal(slugifyTitle("  Mesh   CLI   Score  "), "mesh-cli-score");
});
