#!/usr/bin/env node

const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageName = process.env.MESH_PUBLISHED_PACKAGE || pkg.name;
const packageVersion = process.env.MESH_PUBLISHED_VERSION || pkg.version;
const spec = packageVersion ? `${packageName}@${packageVersion}` : packageName;
const keepTemp = /^(1|true|yes)$/i.test(process.env.MESH_SMOKE_KEEP_TMP || "");
const npmCache = process.env.MESH_SMOKE_NPM_CACHE || path.join(os.tmpdir(), "mesh-npm-cache");
const installTimeoutMs = Number(process.env.MESH_PUBLISHED_INSTALL_TIMEOUT_MS || 180000);
const commandTimeoutMs = Number(process.env.MESH_PUBLISHED_COMMAND_TIMEOUT_MS || 15000);
const tmp = mkdtempSync(path.join(os.tmpdir(), "mesh-published-smoke-"));
const prefix = path.join(tmp, "prefix");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_prefix: prefix,
      NPM_CONFIG_PREFIX: prefix
    },
    encoding: "utf8",
    timeout: options.timeoutMs || commandTimeoutMs,
    stdio: options.capture ? "pipe" : "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${output ? `\n${output}` : ""}`);
  }
  return result;
}

try {
  mkdirSync(prefix, { recursive: true });
  console.log(`[published-smoke] temp: ${tmp}`);
  console.log(`[published-smoke] installing ${spec} into isolated global prefix`);
  
  let installSuccess = false;
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      if (attempt > 1) {
        run("npm", ["cache", "clean", "--force"], { timeoutMs: 30000, capture: true });
      }
      run("npm", ["install", "--global", "--no-audit", "--no-fund", "--prefer-online", spec], { timeoutMs: installTimeoutMs });
      installSuccess = true;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 6) {
        console.log(`[published-smoke] install failed (attempt ${attempt}/6), waiting 10s for npm registry propagation...`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
      }
    }
  }
  
  if (!installSuccess) {
    throw lastError;
  }

  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const meshBin = path.join(binDir, process.platform === "win32" ? "mesh.cmd" : "mesh");
  const version = run(meshBin, ["--version"], { capture: true }).stdout.trim();
  const help = run(meshBin, ["--help"], { capture: true }).stdout;
  const support = run(meshBin, ["support"], { capture: true }).stdout;

  if (packageVersion && version !== packageVersion) {
    throw new Error(`Expected mesh --version=${packageVersion}, got ${version}`);
  }
  if (!help.includes("mesh init") || !help.includes("mesh doctor") || !help.includes("mesh support")) {
    throw new Error("mesh --help is missing first-run commands.");
  }
  if (!support.includes("Mesh Support Info") || !support.includes("mesh:")) {
    throw new Error("mesh support output is missing expected support info.");
  }

  const workspace = path.join(tmp, "workspace");
  mkdirSync(workspace, { recursive: true });
  run("git", ["init"], { cwd: workspace, capture: true });
  run(meshBin, ["doctor", "brief"], { cwd: workspace, timeoutMs: 30000 });

  console.log(`[published-smoke] ok: ${spec} installed and mesh --version=${version}`);
} catch (error) {
  const message = error && typeof error === "object" && "message" in error ? error.message : String(error);
  console.error(`[published-smoke] failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (keepTemp) {
    console.log(`[published-smoke] kept temp directory: ${tmp}`);
  } else {
    rmSync(tmp, { recursive: true, force: true });
  }
}
