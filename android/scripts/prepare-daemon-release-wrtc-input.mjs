#!/usr/bin/env node
// @ts-check
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_SCHEMA = 'zterm.daemon.wrtc-release-input/v1';
const PROVENANCE_SCHEMA = 'zterm.daemon.wrtc-provenance/v1';
// Single trusted source pin for the daemon's wrtc native artifact (upstream
// node-webrtc HEAD B is built from). B = this pin + a 3-file patch.
const PINNED_WRTC_SOURCE_COMMIT = '75f1f55642d803ee558abd7f99b1915598ad21a0';
const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function requireString(obj, key, label) {
  const value = obj?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} missing required string field "${key}"`);
  }
  return value;
}

function validateManifest(manifest, manifestDir) {
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    fail(`manifest schema must be "${MANIFEST_SCHEMA}" (got ${JSON.stringify(manifest?.schema)})`);
  }
  const platform = requireString(manifest, 'platform', 'manifest');
  const arch = requireString(manifest, 'arch', 'manifest');
  const packageVersion = requireString(manifest, 'packageVersion', 'manifest');
  const sourcePin = requireString(manifest, 'sourcePin', 'manifest');
  const patchSha256 = requireString(manifest, 'patchSha256', 'manifest');
  const addon = manifest?.addon;
  if (!addon || typeof addon !== 'object') {
    fail('manifest missing addon object');
  }
  const addonFile = requireString(addon, 'file', 'manifest.addon');
  const addonSha256 = requireString(addon, 'sha256', 'manifest.addon');
  // Declared input kind and addon origin are optional: the patched release input
  // omits them, while a non-release input (for example the CI packaging dry-run)
  // must describe itself so the staged provenance is never misleading.
  const inputKind = manifest.inputKind;
  if (inputKind !== undefined && (typeof inputKind !== 'string' || inputKind.length === 0)) {
    fail('manifest.inputKind must be a non-empty string when present');
  }
  const addonOrigin = addon.origin;
  if (addonOrigin !== undefined && (typeof addonOrigin !== 'string' || addonOrigin.length === 0)) {
    fail('manifest.addon.origin must be a non-empty string when present');
  }

  if (!/^[a-z0-9-]+$/.test(platform) || !/^[a-z0-9-]+$/.test(arch)) {
    fail(`invalid platform/arch "${platform}-${arch}"`);
  }
  if (sourcePin !== PINNED_WRTC_SOURCE_COMMIT) {
    fail(
      `sourcePin mismatch: declared ${sourcePin}, expected pinned ${PINNED_WRTC_SOURCE_COMMIT}`,
    );
  }
  if (!SHA256_HEX.test(patchSha256)) {
    fail(`manifest patchSha256 must be a 64-char sha256 hex string`);
  }
  if (!SHA256_HEX.test(addonSha256)) {
    fail(`manifest.addon.sha256 must be a 64-char sha256 hex string`);
  }
  if (/^[a-zA-Z]:[\\/]|^[/\\]/.test(addonFile) || addonFile.includes('\\')) {
    fail(`manifest.addon.file must be a portable relative path (got "${addonFile}")`);
  }
  const addonPath = resolve(manifestDir, addonFile);
  if (addonPath === manifestDir || !addonPath.startsWith(`${manifestDir}${sep}`)) {
    fail(`manifest.addon.file must live under the manifest directory (got "${addonFile}")`);
  }
  if (!existsSync(addonPath) || !statSync(addonPath).isFile()) {
    fail(`missing addon file: ${addonPath}`);
  }

  return {
    platform,
    arch,
    triple: `${platform}-${arch}`,
    packageVersion,
    sourcePin,
    patchSha256,
    addonFile: addonPath,
    addonSha256,
    inputKind,
    addonOrigin,
  };
}

function readVersion(packageDir, label) {
  const pkgPath = join(packageDir, 'package.json');
  if (!existsSync(pkgPath)) {
    fail(`missing ${label} package.json: ${pkgPath}`);
  }
  return readJson(pkgPath).version;
}

function checkCurrentDependencyVersion(runtimeDir, declared) {
  const mainPkg = join(runtimeDir, 'node_modules', '@roamhq', 'wrtc');
  const platformPkg = join(runtimeDir, 'node_modules', '@roamhq', `wrtc-${declared.triple}`);
  const mainVersion = readVersion(mainPkg, '@roamhq/wrtc');
  const platformVersion = readVersion(platformPkg, `@roamhq/wrtc-${declared.triple}`);
  for (const [name, version] of [
    ['@roamhq/wrtc', mainVersion],
    [`@roamhq/wrtc-${declared.triple}`, platformVersion],
  ]) {
    if (version !== declared.packageVersion) {
      fail(
        `current ${name} version ${version} != manifest packageVersion ${declared.packageVersion}`,
      );
    }
  }
}

function collectFilesNamed(dir, name, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesNamed(full, name, out);
    } else if (entry.name === name) {
      out.push(full);
    }
  }
  return out;
}

function checkUniqueCompiledAddon(runtimeDir, declared) {
  const mainPkg = join(runtimeDir, 'node_modules', '@roamhq', 'wrtc');
  const platformPkg = join(runtimeDir, 'node_modules', '@roamhq', `wrtc-${declared.triple}`);
  const expectedAddon = join(platformPkg, 'wrtc.node');
  const mainWrtcNodes = collectFilesNamed(mainPkg, 'wrtc.node');
  if (mainWrtcNodes.length > 0) {
    fail(
      `shadow addon found under main @roamhq/wrtc (loader paths #1-3 would win): ${mainWrtcNodes.join(', ')}`,
    );
  }
  const platformWrtcNodes = collectFilesNamed(platformPkg, 'wrtc.node');
  if (platformWrtcNodes.length !== 1 || platformWrtcNodes[0] !== expectedAddon) {
    fail(
      `expected exactly one compiled addon at ${expectedAddon}, found: ${platformWrtcNodes.join(', ')}`,
    );
  }
  return expectedAddon;
}

function writeProvenance(runtimeDir, declared, addonSha256) {
  const provenance = {
    schema: PROVENANCE_SCHEMA,
    sourcePin: declared.sourcePin,
    patchSha256: declared.patchSha256,
    addonSha256,
    triple: declared.triple,
    packageVersion: declared.packageVersion,
    mainPackage: '@roamhq/wrtc',
    platformPackage: `@roamhq/wrtc-${declared.triple}`,
  };
  if (declared.inputKind) provenance.inputKind = declared.inputKind;
  if (declared.addonOrigin) provenance.addonOrigin = declared.addonOrigin;
  writeFileSync(
    join(runtimeDir, 'wrtc-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

function runLoaderIdentityCheck(runtimeDir, declared) {
  const script = [
    "const { createRequire } = require('node:module');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const [runtimeDir, triple] = process.argv.slice(1);",
    "const req = createRequire(path.join(runtimeDir, 'probe.cjs'));",
    "const main = req.resolve('@roamhq/wrtc');",
    "const platform = req.resolve(`@roamhq/wrtc-${triple}`);",
    "const addon = req.resolve(`@roamhq/wrtc-${triple}/wrtc.node`);",
    "require(main);",
    "const loaded = Object.keys(require.cache).filter((k) => k.endsWith('.node'));",
    "const addonSha256 = crypto.createHash('sha256').update(fs.readFileSync(addon)).digest('hex');",
    "console.log(JSON.stringify({ main, platform, addon, loaded, addonSha256 }));",
  ].join('\n');
  const result = execFileSync(process.execPath, ['-e', script, runtimeDir, declared.triple], {
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  const info = JSON.parse(result.trim().split('\n').pop());
  for (const key of ['main', 'platform', 'addon']) {
    if (!info[key] || relative(runtimeDir, info[key]).startsWith('..')) {
      fail(`loader resolved ${key} outside the staged runtime tree: ${info[key]}`);
    }
  }
  if (info.loaded.length !== 1 || info.loaded[0] !== info.addon) {
    fail(
      `loader loaded ${JSON.stringify(info.loaded)}; expected exactly the staged addon ${info.addon}`,
    );
  }
  return info;
}

function stageWrtcInput({ manifestPath, runtimeDir }) {
  if (!manifestPath) {
    fail(
      'missing required B wrtc release input manifest (pass --manifest, set by stage_runtime via ZTERM_DAEMON_WRTC_INPUT_MANIFEST)',
    );
  }
  const resolvedManifest = resolve(manifestPath);
  if (!existsSync(resolvedManifest) || !statSync(resolvedManifest).isFile()) {
    fail(`manifest not found: ${resolvedManifest}`);
  }
  const manifestDir = dirname(resolvedManifest);
  const declared = validateManifest(readJson(resolvedManifest), manifestDir);
  const hostTriple = `${process.platform}-${process.arch}`;
  if (declared.triple !== hostTriple) {
    fail(
      `manifest triple ${declared.triple} != build host ${hostTriple} (no cross-triple staging)`,
    );
  }
  checkCurrentDependencyVersion(runtimeDir, declared);
  const actualAddonSha256 = sha256File(declared.addonFile);
  if (actualAddonSha256 !== declared.addonSha256) {
    fail(
      `addon hash mismatch for ${declared.addonFile}: declared ${declared.addonSha256}, actual ${actualAddonSha256}`,
    );
  }
  const expectedAddon = checkUniqueCompiledAddon(runtimeDir, declared);
  copyFileSync(declared.addonFile, expectedAddon);
  const provenance = writeProvenance(runtimeDir, declared, actualAddonSha256);
  const loader = runLoaderIdentityCheck(runtimeDir, declared);
  return {
    triple: declared.triple,
    packageVersion: declared.packageVersion,
    addonSha256: actualAddonSha256,
    patchSha256: declared.patchSha256,
    sourcePin: declared.sourcePin,
    provenance: join(runtimeDir, 'wrtc-provenance.json'),
    platformAddon: expectedAddon,
    loader,
  };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--manifest') {
      out.manifestPath = args[i + 1];
      i += 1;
    } else if (arg === '--runtime-dir') {
      out.runtimeDir = args[i + 1];
      i += 1;
    } else fail(`unknown argument: ${arg}`);
  }
  if (!out.runtimeDir) fail('missing --runtime-dir');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = stageWrtcInput(args);
  console.log(JSON.stringify(result, null, 2));
}

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[zterm-daemon-wrtc] error: ${error.message}`);
    process.exit(1);
  }
}

export { stageWrtcInput, validateManifest, PINNED_WRTC_SOURCE_COMMIT };
