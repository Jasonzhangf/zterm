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

const MAX_APK_MEMBER_BYTES = 32 * 1024 * 1024;

function scanApk(apkPath, needle) {
  if (!existsSync(apkPath)) {
    throw new Error(`APK not found: ${apkPath}`);
  }

  const list = spawnSync('unzip', ['-Z1', apkPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (list.status !== 0) {
    throw new Error(list.stderr || `failed to list zip entries for ${apkPath}`);
  }

  const entries = list.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const needleBuffer = Buffer.from(needle, 'utf8');

  for (const entry of entries) {
    if (entry.endsWith('/')) continue;

    const unzip = spawnSync('unzip', ['-p', apkPath, entry], { encoding: 'buffer', maxBuffer: MAX_APK_MEMBER_BYTES });
    if (unzip.status !== 0) {
      throw new Error(unzip.stderr?.toString() || `unzip failed for ${entry} in ${apkPath}`);
    }
    if (unzip.stdout.includes(needleBuffer)) {
      throw new Error(`relay default address leak found in APK entry ${entry} of ${apkPath} for needle: ${needle}`);
    }
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
