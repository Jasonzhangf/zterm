#!/usr/bin/env node
// @ts-check
// Materializes the typed wrtc release input that the CI packaging dry-run feeds
// to the single strict stage helper (`prepare-daemon-release-wrtc-input.mjs`).
//
// The daemon release must be built from the patched B addon, which is an
// external artifact: the app repo never contains the wrtc source, so no CI
// runner can produce it. CI therefore declares its own input explicitly instead
// of falling back silently. The input is marked `ci-prebuilt-dry-run` and the
// addon origin is recorded, so any artifact staged from it is self-describing
// and can never be mistaken for the patched release addon.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_WRTC_SOURCE_COMMIT } from './prepare-daemon-release-wrtc-input.mjs';

const MANIFEST_SCHEMA = 'zterm.daemon.wrtc-release-input/v1';
const INPUT_KIND = 'ci-prebuilt-dry-run';
const ADDON_ORIGIN = 'npm-prebuilt';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { outputDir: null, workspaceRoot: null, packagesRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output-dir' || arg.startsWith('--output-dir=')) {
      args.outputDir = arg === '--output-dir' ? (argv[++i] ?? null) : arg.slice(13);
    } else if (arg === '--workspace-root' || arg.startsWith('--workspace-root=')) {
      args.workspaceRoot = arg === '--workspace-root' ? (argv[++i] ?? null) : arg.slice(17);
    } else if (arg === '--packages-root' || arg.startsWith('--packages-root=')) {
      // Bounded override used by the packaging verifier to exercise the
      // resolution failure paths against synthetic package trees.
      args.packagesRoot = arg === '--packages-root' ? (argv[++i] ?? null) : arg.slice(16);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!args.outputDir) fail('missing --output-dir');
  if (args.packagesRoot !== null && args.packagesRoot.trim() === '') {
    fail('--packages-root must be non-empty when provided');
  }
  return args;
}

function resolvePackageDir(packageName, searchRoots) {
  const namespace = packageName.slice(0, packageName.indexOf('/'));
  const basename = packageName.slice(packageName.indexOf('/') + 1);
  for (const base of searchRoots) {
    try {
      const requireFromBase = createRequire(join(base, 'probe.cjs'));
      return dirname(requireFromBase.resolve(`${packageName}/package.json`));
    } catch {
      // fall through to the pnpm store scan
    }
  }
  // `@roamhq/wrtc-<triple>` is an optional dependency of `@roamhq/wrtc`, so a
  // workspace root install keeps it in the pnpm store instead of a top-level
  // node_modules entry. Mirror the release script's resolver for that layout.
  const candidates = searchRoots.flatMap((base) => {
    const store = join(base, 'node_modules', '.pnpm');
    if (!existsSync(store)) return [];
    return readdirSync(store)
      .filter((entry) => entry.startsWith(`${namespace.replace('/', '+')}+${basename}@`))
      .sort()
      .map((entry) =>
        join(store, entry, 'node_modules', namespace, basename),
      );
  });
  const match = candidates.find((dir) => existsSync(join(dir, 'package.json')));
  if (match) return match;
  fail(`unable to resolve ${packageName} under ${searchRoots.join(', ')}`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const androidRoot = resolve(scriptDir, '..');
  const searchRoots = args.packagesRoot
    ? [resolve(args.packagesRoot)]
    : [androidRoot, args.workspaceRoot ?? resolve(androidRoot, '..')];
  const triple = `${process.platform}-${process.arch}`;

  const mainPackageDir = resolvePackageDir('@roamhq/wrtc', searchRoots);
  const platformPackageDir = resolvePackageDir(`@roamhq/wrtc-${triple}`, searchRoots);
  const packageVersion = readJson(join(mainPackageDir, 'package.json')).version;
  const platformVersion = readJson(join(platformPackageDir, 'package.json')).version;
  if (packageVersion !== platformVersion) {
    fail(
      `installed @roamhq/wrtc ${packageVersion} != @roamhq/wrtc-${triple} ${platformVersion}`,
    );
  }

  const addonSource = join(platformPackageDir, 'wrtc.node');
  if (!existsSync(addonSource) || !statSync(addonSource).isFile()) {
    fail(`missing installed prebuilt addon: ${addonSource}`);
  }

  const outputDir = resolve(args.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const addonFile = 'wrtc.node';
  copyFileSync(addonSource, join(outputDir, addonFile));
  const addonSha256 = sha256File(join(outputDir, addonFile));

  // The declared patch hash must describe a real file in this input directory,
  // so the placeholder is written and hashed instead of being invented.
  const patchFile = 'source.patch';
  writeFileSync(
    join(outputDir, patchFile),
    `# ${INPUT_KIND}: no source patch is applied to the ${ADDON_ORIGIN} addon.\n`,
  );

  const manifest = {
    schema: MANIFEST_SCHEMA,
    inputKind: INPUT_KIND,
    platform: process.platform,
    arch: process.arch,
    packageVersion,
    sourcePin: PINNED_WRTC_SOURCE_COMMIT,
    patchSha256: sha256File(join(outputDir, patchFile)),
    addon: { file: addonFile, sha256: addonSha256, origin: ADDON_ORIGIN },
  };
  const manifestPath = join(outputDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(manifestPath);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[zterm-daemon-ci-wrtc-input] error: ${error.message}`);
    process.exit(1);
  }
}
