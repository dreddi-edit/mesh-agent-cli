import test from "node:test";
import assert from "node:assert/strict";

import { mergeNodeOptions } from "../src/runtime-observer.ts";

test("runtime observer preserves safe NODE_OPTIONS and adds Mesh hook options", () => {
  const merged = mergeNodeOptions("--max-old-space-size=4096 --trace-warnings", [
    "--enable-source-maps",
    "--require=/tmp/mesh-hook.cjs"
  ]);

  assert.equal(
    merged,
    "--max-old-space-size=4096 --trace-warnings --enable-source-maps --require=/tmp/mesh-hook.cjs"
  );
});

test("runtime observer rejects inherited NODE_OPTIONS injection flags", () => {
  assert.throws(
    () => mergeNodeOptions("--inspect-brk --max-old-space-size=4096", ["--require=/tmp/mesh-hook.cjs"]),
    /Unsafe NODE_OPTIONS rejected: --inspect-brk/
  );
  assert.throws(
    () => mergeNodeOptions("--require=./unexpected.cjs", ["--require=/tmp/mesh-hook.cjs"]),
    /Unsafe NODE_OPTIONS rejected: --require=\.\/unexpected\.cjs/
  );
});
