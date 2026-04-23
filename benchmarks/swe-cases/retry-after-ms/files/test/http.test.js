import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs } from "../src/http.js";

test("parseRetryAfterMs converts seconds to milliseconds", () => {
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("abc"), 0);
});
