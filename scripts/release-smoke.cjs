#!/usr/bin/env node

const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = process.cwd();
const keepTemp = /^(1|true|yes)$/i.test(process.env.MESH_SMOKE_KEEP_TMP || "");
const installTimeoutMs = Number(process.env.MESH_SMOKE_INSTALL_TIMEOUT_MS || 120000);
const commandTimeoutMs = Number(process.env.MESH_SMOKE_COMMAND_TIMEOUT_MS || 15000);
const npmCache = process.env.MESH_SMOKE_NPM_CACHE || path.join(os.tmpdir(), "mesh-npm-cache");
const tmp = mkdtempSync(path.join(os.tmpdir(), "mesh-release-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: {
      ...process.env,
      // npm publish --dry-run exports npm_config_dry_run=true; this smoke test
      // needs npm pack to create a real local tarball without publishing it.
      npm_config_dry_run: "false",
      NPM_CONFIG_DRY_RUN: "false",
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache
    },
    encoding: "utf8",
    timeout: options.timeoutMs || commandTimeoutMs,
    stdio: options.capture ? "pipe" : "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${output ? `\n${output}` : ""}`);
  }
  return result;
}

function parsePackJson(stdout) {
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry?.filename) {
    throw new Error("npm pack did not return a tarball filename.");
  }
  return entry.filename;
}

try {
  console.log(`[smoke] temp: ${tmp}`);
  const pack = run("npm", ["pack", "--json", "--pack-destination", tmp], { capture: true });
  const tarball = path.join(tmp, parsePackJson(pack.stdout));
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not create expected tarball: ${tarball}`);
  }

  const project = path.join(tmp, "project");
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ private: true }, null, 2));
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ private: true }, null, 2));

  console.log("[smoke] installing packed tarball into isolated project");
  run("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--omit=dev", tarball], {
    cwd: project,
    timeoutMs: installTimeoutMs
  });

  const meshBin = path.join(project, "node_modules", ".bin", process.platform === "win32" ? "mesh.cmd" : "mesh");
  const version = run(meshBin, ["--version"], { cwd: project, capture: true }).stdout.trim();
  const help = run(meshBin, ["--help"], { cwd: project, capture: true }).stdout;
  const support = run(meshBin, ["support"], { cwd: project, capture: true }).stdout;

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Unexpected mesh --version output: ${version}`);
  }
  if (!help.includes("Mesh CLI") || !help.includes("Usage:") || !help.includes("mesh init") || !help.includes("mesh doctor") || !help.includes("mesh support")) {
    throw new Error("mesh --help output is missing expected CLI help text.");
  }
  if (!support.includes("Mesh Support Info") || !support.includes("mesh:")) {
    throw new Error("mesh support output is missing expected support info.");
  }

  console.log(`[smoke] ok: installed package works, mesh --version=${version}`);

  const noOptionalProject = path.join(tmp, "project-no-optional");
  mkdirSync(noOptionalProject, { recursive: true });
  writeFileSync(path.join(noOptionalProject, "package.json"), JSON.stringify({ private: true }, null, 2));

  console.log("[smoke] installing with keytar removed to verify auth fallback");
  run("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--omit=dev", tarball], {
    cwd: noOptionalProject,
    timeoutMs: installTimeoutMs
  });
  rmSync(path.join(noOptionalProject, "node_modules", "keytar"), { recursive: true, force: true });

  const noOptionalMeshBin = path.join(noOptionalProject, "node_modules", ".bin", process.platform === "win32" ? "mesh.cmd" : "mesh");
  const noOptionalHelp = run(noOptionalMeshBin, ["--help"], { cwd: noOptionalProject, capture: true }).stdout;
  const noOptionalSupport = run(noOptionalMeshBin, ["support"], { cwd: noOptionalProject, capture: true }).stdout;
  if (!noOptionalHelp.includes("mesh support") || !noOptionalSupport.includes("Mesh Support Info")) {
    throw new Error("mesh did not start correctly without keytar.");
  }

  console.log("[smoke] ok: package starts without keytar");
} catch (error) {
  const message = error && typeof error === "object" && "message" in error ? error.message : String(error);
  console.error(`[smoke] failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (keepTemp) {
    console.log(`[smoke] kept temp directory: ${tmp}`);
  } else {
    rmSync(tmp, { recursive: true, force: true });
  }
}
