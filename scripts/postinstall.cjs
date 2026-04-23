#!/usr/bin/env node

/**
 * Post-install script for @edgarelmo/mesh-agent-cli
 * Automatically offers to install voice dependencies on macOS.
 * Using CommonJS for maximum compatibility during installation.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function resolveBinary(command) {
  const candidates = [
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, command)),
    path.join('/opt/homebrew/bin', command),
    path.join('/usr/local/bin', command)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || command;
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function main() {
  // Only run on macOS for now
  if (os.platform() !== 'darwin') return;

  // Check if we are in an interactive terminal
  if (!process.stdout.isTTY) return;

  console.log('\n\x1b[36m\x1b[1mmesh\x1b[0m \x1b[2m›\x1b[0m Checking voice dependencies...\n');

  const deps = [
    { name: 'ffmpeg', cmd: `${resolveBinary('ffmpeg')} -version` },
    { name: 'whisper-cpp', cmd: `${resolveBinary('whisper-cpp')} --help` }
  ];

  const missing = [];
  for (const dep of deps) {
    try {
      execSync(dep.cmd, { stdio: 'ignore' });
    } catch (e) {
      missing.push(dep.name);
    }
  }

  if (missing.length === 0) {
    console.log('  \x1b[32m✓\x1b[0m All voice dependencies found.\n');
    return;
  }

  console.log(`  \x1b[33m!\x1b[0m Missing dependencies: \x1b[1m${missing.join(', ')}\x1b[0m`);
  console.log('    Voice mode (S2S) requires these tools to be installed via Homebrew.\n');

  const brewPath = resolveBinary('brew');
  if (brewPath === 'brew') {
    console.log('  Homebrew not found. Install it first from https://brew.sh');
    console.log(`  Then run: \x1b[36mbrew install ${missing.join(' ')}\x1b[0m\n`);
    return;
  }

  const shouldInstall = await askYesNo(`  Install now with Homebrew? [y/N] `);
  if (!shouldInstall) {
    console.log(`\n  To install later, run: \x1b[36mbrew install ${missing.join(' ')}\x1b[0m`);
    console.log(`  Or run \x1b[36mmesh doctor voice fix\x1b[0m\n`);
    return;
  }

  try {
    execSync(`${brewPath} install ${missing.join(' ')}`, { stdio: 'inherit' });
    console.log('\n  \x1b[32m✓\x1b[0m Voice dependencies installed.\n');
  } catch (e) {
    console.log('\n  \x1b[31m✘\x1b[0m Installation failed.');
    console.log(`  Retry with: \x1b[36mbrew install ${missing.join(' ')}\x1b[0m`);
    console.log(`  Or run \x1b[36mmesh doctor voice fix\x1b[0m\n`);
  }
}

try {
  main();
} catch (e) {
  // Silent fail for postinstall to avoid blocking the main installation
}
