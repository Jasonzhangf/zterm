#!/usr/bin/env node

import { existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const needles = [
  'https://claw.codewhisper.cc:18443/relay/',
  'claw.codewhisper.cc:18443/relay',
];

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error('[check-relay-default-address-leak] usage: node scripts/check-relay-default-address-leak.mjs <path...>');
  process.exit(1);
}

function scanTextFile(filePath, needle) {
  const result = spawnSync('rg', ['-n', '-a', '-F', needle, filePath], { encoding: 'utf8' });
  if (result.status === 0) {
    throw new Error(`relay default address leak found in ${filePath} for needle: ${needle}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || result.stdout || `rg failed for ${filePath}`);
  }
}

function scanDirectory(dirPath, needle) {
  if (!existsSync(dirPath)) {
    return;
  }
  const result = spawnSync('rg', ['-n', '-a', '-F', needle, dirPath], { encoding: 'utf8' });
  if (result.status === 0) {
    throw new Error(`relay default address leak found under ${dirPath} for needle: ${needle}`);
  }
  if (result.status !== 1) {
    throw new Error(result.stderr || result.stdout || `rg failed for ${dirPath}`);
  }
}

function scanApk(apkPath, needle) {
  if (!existsSync(apkPath)) {
    throw new Error(`APK not found: ${apkPath}`);
  }
  const unzip = spawnSync('unzip', ['-p', apkPath], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (unzip.status !== 0) {
    throw new Error(unzip.stderr?.toString() || `unzip failed for ${apkPath}`);
  }
  if (unzip.stdout.includes(Buffer.from(needle, 'utf8'))) {
    throw new Error(`relay default address leak found in APK ${apkPath} for needle: ${needle}`);
  }
}

for (const input of inputs) {
  const target = resolve(input);
  if (!existsSync(target)) {
    throw new Error(`path not found: ${target}`);
  }
  const stat = statSync(target);
  for (const needle of needles) {
    if (stat.isDirectory()) {
      scanDirectory(target, needle);
    } else if (target.endsWith('.apk')) {
      scanApk(target, needle);
    } else {
      scanTextFile(target, needle);
    }
  }
}

console.log('[check-relay-default-address-leak] ok');
