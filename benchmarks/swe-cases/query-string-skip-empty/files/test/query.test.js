import test from "node:test";
import assert from "node:assert/strict";
import { buildQueryString } from "../src/query.js";

test("buildQueryString omits empty values", () => {
  assert.equal(
    buildQueryString({ q: "mesh", page: 2, filter: "", draft: null, extra: undefined }),
    "q=mesh&page=2"
  );
});
