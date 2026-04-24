#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const skipDirs = new Set([
  ".git",
  ".mesh",
  "benchmarks",
  "dist",
  "mesh-core",
  "node_modules",
  "worker"
]);
const testFilePattern = /\.(test|spec)\.(js|mjs|cjs)$/;

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name) || relativePath.startsWith(".")) continue;
      walk(absolutePath, out);
      continue;
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      out.push(relativePath);
    }
  }
}

const files = [];
walk(root, files);

if (files.length === 0) {
  console.log("No first-party test files found. Skipping benchmark fixtures.");
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
