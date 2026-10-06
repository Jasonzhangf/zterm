#!/usr/bin/env node
// @ts-check
/**
 * Public-consumer regression harness for the daemon native (wrtc) artifact
 * packaging chain.
 *
 * It drives ONLY public entry points:
 *   - scripts/prepare-daemon-release-wrtc-input.mjs (stage helper CLI)
 *   - scripts/verify-release-assets.mjs           (release verifier CLI)
 *
 * It never imports or asserts private internals and does not mirror either
 * implementation: the positive path asserts the real staged product digest,
 * provenance and main-loader require-cache identity; the negative path asserts
 * the documented external failure with no unintended overwrite.
 *
 * Baseline note: the addon used as the staging input is the real npm platform
 * addon shipped with @roamhq/wrtc-darwin-arm64@0.10.0 (digest below). It proves
 * the packaging chain only, NOT the B fix. B does not exist in this task.
 *
 * Usage: node scripts/verify-daemon-wrtc-packaging.mjs
 * Exit 0 on all checks passing, nonzero otherwise. Own fixtures are removed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const androidRoot = resolve(scriptsDir, '..');
const repoRoot = resolve(androidRoot, '..');
const helperCli = join(scriptsDir, 'prepare-daemon-release-wrtc-input.mjs');
const verifierCli = join(scriptsDir, 'verify-release-assets.mjs');

const MANIFEST_SCHEMA = 'zterm.daemon.wrtc-release-input/v1';
const PROVENANCE_SCHEMA = 'zterm.daemon.wrtc-provenance/v1';
const PINNED_SOURCE_PIN = '75f1f55642d803ee558abd7f99b1915598ad21a0';
const TARGET_TRIPLE = 'darwin-arm64';
const PACKAGE_VERSION = '0.10.0';
const BASELINE_ADDON_SHA256 =
  '844f7e2ed329c652b9f07f26c8aa46930d72f6c8220dba2e63038bbe2e73cdf5';
const FAKE_PATCH_SHA256 = 'a'.repeat(64);

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push(detail ? `${name}: ${detail}` : name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  const hash = createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runCli(cli, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function resolveRealPackageDirs() {
  const require = createRequire(import.meta.url);
  const mainPkg = dirname(require.resolve('@roamhq/wrtc/package.json', { paths: [androidRoot] }));
  const version = readJson(join(mainPkg, 'package.json')).version;
  for (const base of [join(androidRoot, 'node_modules/.pnpm'), join(repoRoot, 'node_modules/.pnpm')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (!entry.startsWith('@roamhq+wrtc-darwin-arm64@')) continue;
      const candidate = join(base, entry, 'node_modules/@roamhq/wrtc-darwin-arm64');
      if (existsSync(join(candidate, 'wrtc.node')) && readJson(join(candidate, 'package.json')).version === version) {
        return { mainPkg, platformPkg: candidate };
      }
    }
  }
  throw new Error('unable to locate the real @roamhq/wrtc-darwin-arm64 package in the pnpm store');
}

function writeManifest(dir, overrides = {}) {
  const manifest = {
    schema: MANIFEST_SCHEMA,
    platform: 'darwin',
    arch: 'arm64',
    packageVersion: PACKAGE_VERSION,
    sourcePin: PINNED_SOURCE_PIN,
    patchSha256: FAKE_PATCH_SHA256,
    addon: { file: 'addon/wrtc.node', sha256: 'b'.repeat(64) },
    ...overrides,
  };
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  writeJson(manifestPath, manifest);
  return manifestPath;
}

function makeLiteRuntime(dest, { addonBytes, shadow = false } = {}) {
  rmSync(dest, { recursive: true, force: true });
  const scope = join(dest, 'node_modules/@roamhq');
  mkdirSync(join(scope, 'wrtc/lib'), { recursive: true });
  mkdirSync(join(scope, 'wrtc-darwin-arm64'), { recursive: true });
  writeJson(join(scope, 'wrtc/package.json'), { name: '@roamhq/wrtc', version: PACKAGE_VERSION });
  writeFileSync(join(scope, 'wrtc/lib/index.js'), 'module.exports = {};\n');
  writeJson(join(scope, 'wrtc-darwin-arm64/package.json'), {
    name: '@roamhq/wrtc-darwin-arm64',
    version: PACKAGE_VERSION,
  });
  writeFileSync(join(scope, 'wrtc-darwin-arm64/index.js'), "module.exports = require('./wrtc.node');\n");
  writeFileSync(join(scope, 'wrtc-darwin-arm64/wrtc.node'), addonBytes ?? Buffer.from('lite-addon'));
  if (shadow) {
    mkdirSync(join(scope, 'wrtc/build-darwin-arm64'), { recursive: true });
    writeFileSync(join(scope, 'wrtc/build-darwin-arm64/wrtc.node'), Buffer.from('shadow-addon'));
  }
  return dest;
}

function loaderIdentity(runtimeDir) {
  const script = [
    "const { createRequire } = require('node:module');",
    "const path = require('node:path');",
    "const fs = require('node:fs');",
    "const crypto = require('node:crypto');",
    'const [runtimeDir, triple] = process.argv.slice(1);',
    "const req = createRequire(path.join(runtimeDir, 'probe.cjs'));",
    "const main = req.resolve('@roamhq/wrtc');",
    "const platform = req.resolve('@roamhq/wrtc-' + triple);",
    "const addon = req.resolve('@roamhq/wrtc-' + triple + '/wrtc.node');",
    'require(main);',
    "const loaded = Object.keys(require.cache).filter((k) => k.endsWith('.node'));",
    "const addonSha256 = crypto.createHash('sha256').update(fs.readFileSync(addon)).digest('hex');",
    'console.log(JSON.stringify({ main, platform, addon, loaded, addonSha256 }));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script, runtimeDir, TARGET_TRIPLE], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function negativeScenario(name, { manifest, runtimeDir, expect }) {
  const addonPath = join(runtimeDir, 'node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node');
  const provenancePath = join(runtimeDir, 'wrtc-provenance.json');
  const before = existsSync(addonPath) ? sha256File(addonPath) : null;
  const result = runCli(helperCli, ['--manifest', manifest, '--runtime-dir', runtimeDir]);
  const after = existsSync(addonPath) ? sha256File(addonPath) : null;
  check(`${name}: exits nonzero`, result.status !== 0, `rc=${result.status}`);
  check(`${name}: no unintended addon overwrite`, before === after, `${before} -> ${after}`);
  check(`${name}: no provenance written`, !existsSync(provenancePath));
  if (expect) {
    check(
      `${name}: error names "${expect}"`,
      `${result.stdout}\n${result.stderr}`.includes(expect),
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
}

function runStageScenarios(tmpRoot) {
  console.log('\n[stage] helper CLI');
  const real = resolveRealPackageDirs();
  const baselineAddon = readFileSync(join(real.platformPkg, 'wrtc.node'));
  check(
    'baseline input is the npm prebuilt addon (NOT B)',
    sha256Buffer(baselineAddon) === BASELINE_ADDON_SHA256,
    `sha=${sha256Buffer(baselineAddon)}`,
  );

  const positiveRuntime = join(tmpRoot, 'positive-runtime');
  cpSync(real.mainPkg, join(positiveRuntime, 'node_modules/@roamhq/wrtc'), { recursive: true, dereference: true });
  cpSync(real.platformPkg, join(positiveRuntime, 'node_modules/@roamhq/wrtc-darwin-arm64'), {
    recursive: true,
    dereference: true,
  });
  const positiveInput = join(tmpRoot, 'positive-input');
  mkdirSync(join(positiveInput, 'addon'), { recursive: true });
  writeFileSync(join(positiveInput, 'addon/wrtc.node'), baselineAddon);
  const positiveManifest = writeManifest(positiveInput, {
    addon: { file: 'addon/wrtc.node', sha256: BASELINE_ADDON_SHA256 },
  });

  const positive = runCli(helperCli, ['--manifest', positiveManifest, '--runtime-dir', positiveRuntime]);
  check('positive: exits 0', positive.status === 0, `rc=${positive.status} ${positive.stderr.trim()}`);
  if (positive.status === 0) {
    let result = null;
    try {
      result = JSON.parse(positive.stdout);
    } catch (error) {
      check('positive: prints JSON result', false, error.message);
    }
    if (result) {
      check('positive: reported addon digest is the real input digest', result.addonSha256 === BASELINE_ADDON_SHA256);
      check('positive: reported triple', result.triple === TARGET_TRIPLE, String(result.triple));
      check('positive: reported packageVersion', result.packageVersion === PACKAGE_VERSION, String(result.packageVersion));
    }
    const stagedAddon = join(positiveRuntime, 'node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node');
    check('positive: staged platform addon bytes equal manifest input', sha256File(stagedAddon) === BASELINE_ADDON_SHA256);
    check(
      'positive: no shadow addon under main @roamhq/wrtc',
      !existsSync(join(positiveRuntime, 'node_modules/@roamhq/wrtc/build-darwin-arm64/wrtc.node')),
    );
    const provenancePath = join(positiveRuntime, 'wrtc-provenance.json');
    check('positive: provenance written', existsSync(provenancePath));
    if (existsSync(provenancePath)) {
      const provenance = readJson(provenancePath);
      check('positive: provenance schema', provenance.schema === PROVENANCE_SCHEMA, String(provenance.schema));
      check('positive: provenance sourcePin pinned', provenance.sourcePin === PINNED_SOURCE_PIN);
      check('positive: provenance patchSha256', provenance.patchSha256 === FAKE_PATCH_SHA256);
      check('positive: provenance addonSha256', provenance.addonSha256 === BASELINE_ADDON_SHA256);
      check('positive: provenance triple', provenance.triple === TARGET_TRIPLE);
      check('positive: provenance packageVersion', provenance.packageVersion === PACKAGE_VERSION);
      check('positive: provenance has no absolute fixture path', !JSON.stringify(provenance).includes(tmpRoot));
    }
    const identity = loaderIdentity(positiveRuntime);
    const stagedAddonResolved = join(positiveRuntime, 'node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node');
    check('loader: main resolves inside staged runtime', identity.main.startsWith(positiveRuntime), identity.main);
    check('loader: platform resolves inside staged runtime', identity.platform.startsWith(positiveRuntime), identity.platform);
    check('loader: resolves exactly the staged addon', identity.addon === stagedAddonResolved, identity.addon);
    check(
      'loader: require.cache holds exactly one compiled addon',
      identity.loaded.length === 1 && identity.loaded[0] === identity.addon,
      JSON.stringify(identity.loaded),
    );
    check('loader: loaded addon digest is the real input digest', identity.addonSha256 === BASELINE_ADDON_SHA256);
  }

  console.log('\n[stage] fail-closed negatives');
  const liteAddon = Buffer.from('lite-addon-bytes');
  const liteAddonSha = sha256Buffer(liteAddon);

  negativeScenario('missing input', {
    manifest: '',
    runtimeDir: makeLiteRuntime(join(tmpRoot, 'neg-missing-input'), { addonBytes: liteAddon }),
    expect: 'missing required B wrtc release input manifest',
  });
  negativeScenario('missing manifest file', {
    manifest: join(tmpRoot, 'does-not-exist.json'),
    runtimeDir: makeLiteRuntime(join(tmpRoot, 'neg-missing-manifest'), { addonBytes: liteAddon }),
    expect: 'manifest not found',
  });

  const tamperDir = join(tmpRoot, 'neg-tampered-input');
  mkdirSync(tamperDir, { recursive: true });
  writeFileSync(join(tamperDir, 'wrtc.node'), liteAddon);
  negativeScenario('tampered declared sha', {
    manifest: writeManifest(tamperDir, {
      addon: { file: 'wrtc.node', sha256: '0'.repeat(64) },
    }),
    runtimeDir: makeLiteRuntime(join(tmpRoot, 'neg-tampered-runtime'), { addonBytes: liteAddon }),
    expect: 'addon hash mismatch',
  });

  const wrongTripleDir = join(tmpRoot, 'neg-wrong-triple');
  mkdirSync(wrongTripleDir, { recursive: true });
  writeFileSync(join(wrongTripleDir, 'wrtc.node'), liteAddon);
  negativeScenario('wrong triple', {
    manifest: writeManifest(wrongTripleDir, {
      platform: 'linux',
      arch: 'x64',
      addon: { file: 'wrtc.node', sha256: liteAddonSha },
    }),
    runtimeDir: makeLiteRuntime(join(tmpRoot, 'neg-wrong-triple-runtime'), { addonBytes: liteAddon }),
    expect: 'manifest triple linux-x64 != build host',
  });

  negativeScenario('missing addon file', {
    manifest: writeManifest(join(tmpRoot, 'neg-missing-addon'), {
      addon: { file: 'addon/absent.node', sha256: liteAddonSha },
    }),
    runtimeDir: makeLiteRuntime(join(tmpRoot, 'neg-missing-addon-runtime'), { addonBytes: liteAddon }),
    expect: 'missing addon file',
  });

  negativeScenario('shadow addon under main package', {
    manifest: writeManifest(join(tmpRoot, 'neg-shadow'), {
      addon: { file: 'wrtc.node', sha256: liteAddonSha },
    }),
    runtimeDir: (() => {
      const dir = makeLiteRuntime(join(tmpRoot, 'neg-shadow-runtime'), { addonBytes: liteAddon, shadow: true });
      writeFileSync(join(tmpRoot, 'neg-shadow/wrtc.node'), liteAddon);
      return dir;
    })(),
    expect: 'shadow addon',
  });

  const depDir = join(tmpRoot, 'neg-dependency');
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, 'wrtc.node'), liteAddon);
  negativeScenario('dependency version mismatch', {
    manifest: writeManifest(depDir, {
      packageVersion: '9.9.9',
      addon: { file: 'wrtc.node', sha256: liteAddonSha },
    }),
    runtimeDir: makeLiteRuntime(join(tmpRoot, 'neg-dependency-runtime'), { addonBytes: liteAddon }),
    expect: '!= manifest packageVersion',
  });
}

function buildReleaseDist(dir, daemonVersion, { addonBytes, provenanceAddonSha, includeProvenance = true }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const apk = Buffer.from('fixture-apk');
  writeFileSync(join(dir, 'app.apk'), apk);
  writeJson(join(dir, 'latest.json'), {
    versionName: 'fixture',
    versionCode: 1,
    apkUrl: 'app.apk',
    sha256: sha256Buffer(apk),
    size: apk.length,
  });

  const archiveName = `zterm-daemon-${daemonVersion}-darwin-arm64.tar.gz`;
  const archive = Buffer.from('fixture-daemon-archive');
  writeFileSync(join(dir, archiveName), archive);
  writeFileSync(join(dir, `${archiveName}.sha256`), `${sha256Buffer(archive)}  ${archiveName}\n`);

  const stageRoot = join(dir, '.npm-stage');
  const pkg = join(stageRoot, 'package');
  mkdirSync(join(pkg, 'runtime/node_modules/node-pty'), { recursive: true });
  mkdirSync(join(pkg, 'runtime/node_modules/@roamhq/wrtc'), { recursive: true });
  mkdirSync(join(pkg, 'runtime/node_modules/@roamhq/wrtc-darwin-arm64'), { recursive: true });
  mkdirSync(join(pkg, 'support'), { recursive: true });
  writeJson(join(pkg, 'runtime/node_modules/node-pty/package.json'), { name: 'node-pty', version: '1.0.0' });
  writeJson(join(pkg, 'runtime/node_modules/@roamhq/wrtc/package.json'), {
    name: '@roamhq/wrtc',
    version: PACKAGE_VERSION,
  });
  writeJson(join(pkg, 'runtime/node_modules/@roamhq/wrtc-darwin-arm64/package.json'), {
    name: '@roamhq/wrtc-darwin-arm64',
    version: PACKAGE_VERSION,
  });
  writeFileSync(join(pkg, 'runtime/node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node'), addonBytes);
  if (includeProvenance) {
    writeJson(join(pkg, 'runtime/wrtc-provenance.json'), {
      schema: PROVENANCE_SCHEMA,
      sourcePin: PINNED_SOURCE_PIN,
      patchSha256: FAKE_PATCH_SHA256,
      addonSha256: provenanceAddonSha,
      triple: TARGET_TRIPLE,
      packageVersion: PACKAGE_VERSION,
      mainPackage: '@roamhq/wrtc',
      platformPackage: '@roamhq/wrtc-darwin-arm64',
    });
  }
  writeFileSync(join(pkg, 'support/zterm-daemon.sh'), '#!/usr/bin/env bash\n# configure-relay\n');

  const tgz = join(dir, `jsonstudio-zterm-daemon-${daemonVersion}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', stageRoot, 'package']);
  writeFileSync(`${tgz}.sha256`, `${sha256File(tgz)}  ${basename(tgz)}\n`);
  rmSync(stageRoot, { recursive: true, force: true });
}

function runVerifierScenarios(tmpRoot) {
  console.log('\n[verifier] release asset gate');
  const daemonVersion = String(readJson(join(androidRoot, 'package.json')).version);
  const releaseDist = join(tmpRoot, 'release-dist');
  const baselineAddon = readFileSync(join(resolveRealPackageDirs().platformPkg, 'wrtc.node'));

  buildReleaseDist(releaseDist, daemonVersion, {
    addonBytes: baselineAddon,
    provenanceAddonSha: BASELINE_ADDON_SHA256,
  });
  const positive = runCli(verifierCli, ['--release-dist', releaseDist]);
  check('positive: verifier exits 0 on intact bundle', positive.status === 0, `rc=${positive.status}`);
  let positiveResult = null;
  try {
    positiveResult = JSON.parse(positive.stdout);
  } catch (error) {
    check('positive: verifier prints JSON', false, error.message);
  }
  if (positiveResult) {
    check('positive: verifier ok=true', positiveResult.ok === true);
    check(
      'positive: addon digest matches provenance',
      positiveResult.checks.daemonNpmWrtcAddonShaMatchesProvenance === true,
    );
    check('positive: provenance present', positiveResult.checks.daemonNpmWrtcProvenancePresent === true);
  }

  buildReleaseDist(releaseDist, daemonVersion, {
    addonBytes: Buffer.concat([baselineAddon, Buffer.from('TAMPER')]),
    provenanceAddonSha: BASELINE_ADDON_SHA256,
  });
  const tampered = runCli(verifierCli, ['--release-dist', releaseDist]);
  check('tampered: verifier exits nonzero', tampered.status !== 0, `rc=${tampered.status}`);
  let tamperedResult = null;
  try {
    tamperedResult = JSON.parse(tampered.stdout);
  } catch (error) {
    check('tampered: verifier prints JSON', false, error.message);
  }
  if (tamperedResult) {
    check('tampered: verifier ok=false', tamperedResult.ok === false);
    check(
      'tampered: addon digest mismatch flagged',
      tamperedResult.checks.daemonNpmWrtcAddonShaMatchesProvenance === false,
    );
    check(
      'tampered: tarball sha still matches (isolates the digest gate)',
      tamperedResult.checks.daemonNpmShaMatches === true,
    );
  }

  buildReleaseDist(releaseDist, daemonVersion, {
    addonBytes: baselineAddon,
    provenanceAddonSha: BASELINE_ADDON_SHA256,
    includeProvenance: false,
  });
  const missingProvenance = runCli(verifierCli, ['--release-dist', releaseDist]);
  check('missing provenance: verifier exits nonzero', missingProvenance.status !== 0, `rc=${missingProvenance.status}`);
  let missingResult = null;
  try {
    missingResult = JSON.parse(missingProvenance.stdout);
  } catch (error) {
    check('missing provenance: verifier prints JSON', false, error.message);
  }
  if (missingResult) {
    check('missing provenance: verifier ok=false', missingResult.ok === false);
    check(
      'missing provenance: presence flagged',
      missingResult.checks.daemonNpmWrtcProvenancePresent === false,
    );
  }
}

const tmpRoot = mkdtempSync(join(androidRoot, '.tmp-wrtc-packaging-'));
console.log(`[verify-daemon-wrtc-packaging] fixture root: ${tmpRoot}`);
try {
  runStageScenarios(tmpRoot);
  runVerifierScenarios(tmpRoot);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
check('own fixture/tmp removed', !existsSync(tmpRoot));

if (failures.length > 0) {
  console.error(`\n[verify-daemon-wrtc-packaging] FAILED (${failures.length})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\n[verify-daemon-wrtc-packaging] PASS');
