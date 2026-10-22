import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), '..');
const publicDaemonPackage = '@jsonstudio/zterm-daemon';
const daemonTuples = [
  { tuple: 'darwin-arm64', os: 'darwin', arch: 'arm64' },
  { tuple: 'linux-x64', os: 'linux', arch: 'x64' },
  { tuple: 'win32-x64', os: 'win32', arch: 'x64' },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function sha256Bytes(buffer) {
  const hash = createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

function requireFile(path) {
  if (!existsSync(path)) {
    throw new Error(`missing release asset: ${path}`);
  }
  return path;
}

function readShaFile(path) {
  return readFileSync(path, 'utf8').trim().split(/\s+/)[0];
}

function listTarballEntries(path) {
  return execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readTarballText(path, entry) {
  return execFileSync('tar', ['-xOf', path, entry], { encoding: 'utf8' });
}

function readTarballBytes(path, entry) {
  return execFileSync('tar', ['-xOf', path, entry], { maxBuffer: 1024 * 1024 * 1024 });
}

function hasTarballEntry(entries, expected) {
  return entries.includes(expected) || entries.some((entry) => entry.startsWith(`${expected}/`));
}

function readTarballJson(path, entry) {
  if (!hasTarballEntry(listTarballEntries(path), entry)) {
    return null;
  }
  try {
    return JSON.parse(readTarballText(path, entry));
  } catch {
    return null;
  }
}

function packageTarballName(packageName, version) {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

function sortedJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortedJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedJson(value[key])]),
    );
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(sortedJson(left)) === JSON.stringify(sortedJson(right));
}

function versionAtLeast22(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 0);
}

function daemonPayloadComponents(tuple) {
  const components = [
    'runtime/server.cjs',
    'runtime/dagpipe.node',
    'runtime/node_modules/node-pty',
    'runtime/node_modules/@roamhq/wrtc',
    `runtime/node_modules/@roamhq/wrtc-${tuple}/wrtc.node`,
    'support/terminal-config-command.cjs',
  ];
  if (tuple === 'win32-x64') {
    components.push('support/windows/zterm-daemon.ps1');
  } else {
    components.push('support/zterm-daemon.sh');
  }
  if (tuple === 'darwin-arm64') {
    components.push('support/zterm-daemon');
  }
  return components;
}

function verifyWrtcProvenance(tarball, entries, tuple) {
  const provenanceEntry = entries.find(
    (entry) =>
      entry === 'runtime/wrtc-provenance.json' ||
      entry.endsWith('/runtime/wrtc-provenance.json'),
  );
  const addonEntry = entries.find(
    (entry) =>
      entry === `runtime/node_modules/@roamhq/wrtc-${tuple}/wrtc.node` ||
      entry.endsWith(`/runtime/node_modules/@roamhq/wrtc-${tuple}/wrtc.node`),
  );
  const provenance = readTarballJson(tarball, provenanceEntry);
  const addonSha = addonEntry
    ? sha256Bytes(readTarballBytes(tarball, addonEntry))
    : null;
  return {
    provenance,
    addonSha,
    present: Boolean(provenanceEntry),
    schema: provenance?.schema === 'zterm.daemon.wrtc-provenance/v1',
    addonShaDeclared:
      typeof provenance?.addonSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(provenance.addonSha256),
    addonShaMatches: addonSha !== null && addonSha === provenance?.addonSha256,
    tupleMatches: provenance?.triple === tuple,
  };
}

function verifyDaemonPackageSet(packageSetDir, version) {
  const packageSetPresent =
    existsSync(packageSetDir) && statSync(packageSetDir).isDirectory();
  const tarballs = packageSetPresent
    ? readdirSync(packageSetDir)
        .filter((entry) => entry.endsWith('.tgz'))
        .sort()
    : [];
  const expectedTarballs = [
    packageTarballName(publicDaemonPackage, version),
    ...daemonTuples.map(({ tuple }) =>
      packageTarballName(`${publicDaemonPackage}-${tuple}`, version),
    ),
  ].sort();

  const publicTgz = requireFile(
    resolve(packageSetDir, packageTarballName(publicDaemonPackage, version)),
  );
  const publicEntries = listTarballEntries(publicTgz);
  const publicManifest = readTarballJson(publicTgz, 'package/package.json');
  const expectedPublicBins = {
    'zterm-daemon': 'bin/zterm-daemon.cjs',
    wterm: 'bin/wterm.cjs',
  };
  const expectedOptionalDependencies = Object.fromEntries(
    daemonTuples.map(({ tuple }) => [`${publicDaemonPackage}-${tuple}`, version]),
  );

  const payloads = daemonTuples.map((spec) => {
    const { tuple, os, arch } = spec;
    const tarball = requireFile(
      resolve(packageSetDir, packageTarballName(`${publicDaemonPackage}-${tuple}`, version)),
    );
    const entries = listTarballEntries(tarball);
    const packageManifest = readTarballJson(tarball, 'package/package.json');
    const distributionManifest = readTarballJson(tarball, 'package/zterm-package.json');
    const expectedComponents = daemonPayloadComponents(tuple);
    const supportEntry =
      os === 'win32'
        ? 'package/support/windows/zterm-daemon.ps1'
        : 'package/support/zterm-daemon.sh';
    const supportScript = hasTarballEntry(entries, supportEntry)
      ? readTarballText(tarball, supportEntry)
      : '';
    return {
      tuple,
      os,
      arch,
      tarball,
      packageManifest,
      distributionManifest,
      checks: {
        nameMatches: packageManifest?.name === `${publicDaemonPackage}-${tuple}`,
        versionMatches: packageManifest?.version === version,
        distributionNameMatches:
          distributionManifest?.package?.name === `${publicDaemonPackage}-${tuple}`,
        distributionVersionMatches: distributionManifest?.package?.version === version,
        platformMatches:
          packageManifest?.os?.length === 1 &&
          packageManifest.os[0] === os &&
          packageManifest?.cpu?.length === 1 &&
          packageManifest.cpu[0] === arch &&
          distributionManifest?.platform?.os === os &&
          distributionManifest?.platform?.arch === arch,
        nodeMinimumMatches: versionAtLeast22(
          distributionManifest?.platform?.node?.minimum,
        ),
        nodeAbiDeclared: /^\d+$/.test(
          String(distributionManifest?.platform?.node?.abi || ''),
        ),
        noBin: packageManifest?.bin === undefined,
        componentsPresent: expectedComponents.every((component) =>
          hasTarballEntry(entries, `package/${component}`),
        ),
        componentsDeclared: expectedComponents.every((component) =>
          Array.isArray(distributionManifest?.runtimeComponents) &&
          distributionManifest.runtimeComponents.includes(component),
        ),
        configureRelayPresent: supportScript.includes('configure-relay'),
      },
    };
  });

  return {
    packageSetDir,
    tarballs,
    payloads,
    checks: {
      daemonPackageSetPresent: packageSetPresent,
      daemonPackageSetHasExactlyFourTarballs: jsonEqual(tarballs, expectedTarballs),
      daemonPublicPackageNameMatches: publicManifest?.name === publicDaemonPackage,
      daemonPublicPackageVersionMatches: publicManifest?.version === version,
      daemonPublicPackageBinsMatch: jsonEqual(publicManifest?.bin, expectedPublicBins),
      daemonPublicPackageBinsPresent:
        Object.values(expectedPublicBins).every((entry) =>
          hasTarballEntry(publicEntries, `package/${entry}`),
        ),
      daemonPublicPackageOptionalDependenciesMatch: jsonEqual(
        publicManifest?.optionalDependencies,
        expectedOptionalDependencies,
      ),
      daemonPublicPackageHasNoRuntime: !hasTarballEntry(publicEntries, 'package/runtime'),
      daemonPublicPackageHasShimInstaller: hasTarballEntry(
        publicEntries,
        'package/support/install-user-shims.cjs',
      ),
      daemonPayloadsMatch:
        payloads.length === daemonTuples.length &&
        payloads.every((payload) => Object.values(payload.checks).every(Boolean)),
    },
  };
}

export function verifyReleaseAssets(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const releaseDist = resolve(
    options.releaseDist ?? resolve(projectRoot, 'release-dist'),
  );
  const manifestPath = resolve(releaseDist, 'latest.json');
  const packageJson = readJson(requireFile(resolve(projectRoot, 'package.json')));
  const daemonVersion = String(packageJson.version);
  const packageSetDir = resolve(
    options.daemonPackagesDir ??
      process.env.ZTERM_DAEMON_PACKAGES_DIR ??
      resolve(releaseDist, 'npm', `zterm-daemon-${daemonVersion}`),
  );
  const manifest = readJson(requireFile(manifestPath));
  for (const key of ['versionName', 'versionCode', 'apkUrl', 'sha256', 'size']) {
    if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
      throw new Error(`latest.json missing ${key}`);
    }
  }

  const apkPath = requireFile(resolve(releaseDist, manifest.apkUrl));
  const daemonArchive = requireFile(
    resolve(releaseDist, `zterm-daemon-${daemonVersion}-darwin-arm64.tar.gz`),
  );
  const daemonArchiveSha = requireFile(`${daemonArchive}.sha256`);
  const daemonArchiveEntries = listTarballEntries(daemonArchive);
  // The retired flat npm package carried this provenance; the standalone
  // release archive remains the published artifact that owns it.
  const daemonArchiveWrtc = verifyWrtcProvenance(
    daemonArchive,
    daemonArchiveEntries,
    'darwin-arm64',
  );
  const daemonPackages = verifyDaemonPackageSet(packageSetDir, daemonVersion);

  const checks = {
    apkShaMatches: sha256(apkPath) === manifest.sha256,
    apkSizeMatches: statSync(apkPath).size === manifest.size,
    daemonArchiveShaMatches: sha256(daemonArchive) === readShaFile(daemonArchiveSha),
    daemonArchiveWrtcProvenancePresent: daemonArchiveWrtc.present,
    daemonArchiveWrtcProvenanceSchema: daemonArchiveWrtc.schema,
    daemonArchiveWrtcProvenanceAddonSha: daemonArchiveWrtc.addonShaDeclared,
    daemonArchiveWrtcAddonShaMatchesProvenance: daemonArchiveWrtc.addonShaMatches,
    daemonArchiveWrtcProvenanceTuple: daemonArchiveWrtc.tupleMatches,
    ...daemonPackages.checks,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    versionName: manifest.versionName,
    versionCode: manifest.versionCode,
    daemonVersion,
    apkPath,
    apkSha256: manifest.sha256,
    daemonArchive,
    daemonArchiveSha256: readShaFile(daemonArchiveSha),
    daemonArchiveWrtcAddonSha256: daemonArchiveWrtc.addonSha,
    daemonArchiveWrtcProvenance: daemonArchiveWrtc.provenance,
    daemonPackageSetDir: daemonPackages.packageSetDir,
    daemonPackageTarballs: daemonPackages.tarballs,
    daemonPayloads: daemonPackages.payloads.map((payload) => ({
      tuple: payload.tuple,
      tarball: payload.tarball,
      packageManifest: payload.packageManifest,
      distributionManifest: payload.distributionManifest,
      checks: payload.checks,
    })),
    checks,
  };
}

function parseCliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--release-dist', '--daemon-packages-dir', '--project-root'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === '--release-dist') options.releaseDist = value;
    if (argument === '--daemon-packages-dir') options.daemonPackagesDir = value;
    if (argument === '--project-root') options.projectRoot = value;
  }
  return options;
}

function runCli() {
  try {
    const result = verifyReleaseAssets(parseCliOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[verify-release-assets] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runCli();
}
