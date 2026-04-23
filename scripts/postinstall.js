#!/usr/bin/env node

/**
 * Post-install script for @edgarelmo/mesh-agent-cli
 * Automatically offers to install voice dependencies on macOS.
 */

import { execSync } from 'node:child_process';
import os from 'node:os';

async function main() {
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
    } catch {
      missing.push(dep.name);
    }
  }

  if (missing.length === 0) {
    console.log('  \x1b[32m✓\x1b[0m All voice dependencies found.\n');
    return;
  }

  console.log(`  \x1b[33m!\x1b[0m Missing dependencies: \x1b[1m${missing.join(', ')}\x1b[0m`);
  console.log('    Voice mode (S2S) requires these tools to be installed via Homebrew.\n');

  // We don't want to block the install process, so we just inform the user.
  // In a future version, we could use a prompts library here, but 
  // keeping postinstall lightweight is better.
  
  console.log(`  To install them now, run: \x1b[36mbrew install ${missing.join(' ')}\x1b[0m`);
  console.log(`  Or run \x1b[36mmesh doctor --fix\x1b[0m after installation.\n`);
}

main().catch(() => {});
