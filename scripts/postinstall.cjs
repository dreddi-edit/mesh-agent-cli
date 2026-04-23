#!/usr/bin/env node

/**
 * Post-install script for @edgarelmo/mesh-agent-cli
 * Automatically offers to install voice dependencies on macOS.
 * Using CommonJS for maximum compatibility during installation.
 */

const { execSync } = require('child_process');
const os = require('os');

function main() {
  // Only run on macOS for now
  if (os.platform() !== 'darwin') return;

  // Check if we are in an interactive terminal
  if (!process.stdout.isTTY) return;

  console.log('\n\x1b[36m\x1b[1mmesh\x1b[0m \x1b[2m›\x1b[0m Checking voice dependencies...\n');

  const deps = [
    { name: 'ffmpeg', cmd: 'ffmpeg -version' },
    { name: 'whisper-cpp', cmd: 'whisper-cpp --help' }
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

  console.log(`  To install them now, run: \x1b[36mbrew install ${missing.join(' ')}\x1b[0m`);
  console.log(`  Or run \x1b[36mmesh doctor --fix\x1b[0m after installation.\n`);
}

try {
  main();
} catch (e) {
  // Silent fail for postinstall to avoid blocking the main installation
}
