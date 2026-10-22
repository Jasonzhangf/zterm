import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformRuntimeComponents } from './prepare-daemon-platform-release.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(projectRoot, '..');
const publicPackageName = '@jsonstudio/zterm-daemon';
const tuples = [
  { tuple: 'darwin-arm64', os: 'darwin', arch: 'arm64' },
  { tuple: 'linux-x64', os: 'linux', arch: 'x64' },
  { tuple: 'win32-x64', os: 'win32', arch: 'x64' },
];

const payloadResolverSource = String.raw`
function parseNodeVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function nodeVersionAtLeast(actual, minimum) {
  const actualParts = parseNodeVersion(actual);
  const minimumParts = parseNodeVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

function resolveLocalPayload() {
  const tuple = process.platform + '-' + process.arch;
  const payloadName = '@jsonstudio/zterm-daemon-' + tuple;
  const optionalDependencies = packageJson.optionalDependencies || {};
  const optionalVersion = optionalDependencies[payloadName];
  if (!optionalVersion) {
    throw new Error('daemon_platform_mismatch: unsupported host ' + tuple);
  }
  if (optionalVersion !== packageJson.version) {
    throw new Error(
      'daemon_payload_version_mismatch: public=' +
        packageJson.version +
        ' payload=' +
        optionalVersion,
    );
  }

  let packagePath;
  try {
    packagePath = require.resolve(payloadName + '/package.json', { paths: [packageRoot] });
  } catch {
    throw new Error(
      'daemon_payload_missing: install the exact optional dependency ' +
        payloadName +
        '@' +
        packageJson.version,
    );
  }
  const payloadRoot = dirname(packagePath);
  const payloadPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (payloadPackage.name !== payloadName || payloadPackage.version !== packageJson.version) {
    throw new Error(
      'daemon_payload_identity_mismatch: expected ' +
        payloadName +
        '@' +
        packageJson.version,
    );
  }

  const manifestPath = join(payloadRoot, 'zterm-package.json');
  if (!existsSync(manifestPath)) {
    throw new Error('daemon_payload_manifest_missing: ' + manifestPath);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package?.name !== payloadName ||
    manifest.package?.version !== packageJson.version
  ) {
    throw new Error('daemon_payload_manifest_invalid: ' + manifestPath);
  }
  if (manifest.platform?.os !== process.platform || manifest.platform?.arch !== process.arch) {
    throw new Error(
      'daemon_platform_mismatch: payload=' +
        String(manifest.platform?.os) +
        '-' +
        String(manifest.platform?.arch) +
        ' host=' +
        tuple,
    );
  }
  if (!nodeVersionAtLeast(process.versions.node, manifest.platform?.node?.minimum)) {
    throw new Error(
      'daemon_node_version_mismatch: requires Node ' +
        String(manifest.platform?.node?.minimum) +
        ', actual=' +
        process.versions.node,
    );
  }
  if (manifest.platform?.node?.abi !== process.versions.modules) {
    throw new Error(
      'daemon_node_abi_mismatch: payload=' +
        String(manifest.platform?.node?.abi) +
        ' actual=' +
        process.versions.modules,
    );
  }
  const missing = (manifest.runtimeComponents || []).filter(
    (component) => !existsSync(join(payloadRoot, component)),
  );
  if (missing.length > 0) {
    throw new Error('daemon_runtime_component_missing: ' + missing.join(', '));
  }
  return { payloadName, payloadRoot, manifest };
}
`;

const publicBinSource = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
${payloadResolverSource}

function fail(error) {
  console.error('zterm-daemon: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

try {
  const { payloadRoot } = resolveLocalPayload();
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    process.stdout.write(packageJson.version + '\\n');
    process.exit(0);
  }

  const isWindows = process.platform === 'win32';
  const runner = isWindows
    ? join(payloadRoot, 'support', 'windows', 'zterm-daemon.ps1')
    : join(payloadRoot, 'support', 'zterm-daemon.sh');
  if (!existsSync(runner)) {
    throw new Error('daemon_runner_missing: ' + runner);
  }
  const command = isWindows ? 'powershell.exe' : runner;
  const commandArgs = isWindows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, ...args]
    : args;
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ZTERM_PACKAGE_ROOT: payloadRoot,
      ZTERM_NODE_EXE: process.execPath,
    },
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status === null ? 1 : result.status);
} catch (error) {
  fail(error);
}
`;

const publicWtermSource = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const args = process.argv.slice(2);
if (args[0] === 'daemon') {
  args.shift();
}
const target = resolve(__dirname, 'zterm-daemon.cjs');
const result = spawnSync(process.execPath, [target, ...args], {
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`;

const publicShimInstallerSource = `#!/usr/bin/env node
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const packageRoot = resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
${payloadResolverSource}

function stageShim(directory, name, body) {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, name);
  const temporary = join(directory, '.' + name + '.' + process.pid + '.tmp');
  writeFileSync(temporary, body, { mode: 0o755 });
  chmodSync(temporary, 0o755);
  return { target, temporary };
}

try {
  resolveLocalPayload();
  const localBin = join(homedir(), '.local', 'bin');
  const isWindows = process.platform === 'win32';
  const staged = isWindows
    ? [
        stageShim(
          localBin,
          'zterm-daemon.cmd',
          '@echo off\\r\\nnode "' + join(packageRoot, 'bin', 'zterm-daemon.cjs') + '" %*\\r\\n',
        ),
        stageShim(
          localBin,
          'wterm.cmd',
          '@echo off\\r\\nnode "' + join(packageRoot, 'bin', 'wterm.cjs') + '" %*\\r\\n',
        ),
      ]
    : [
        stageShim(
          localBin,
          'zterm-daemon',
          '#!/usr/bin/env bash\\nset -euo pipefail\\nexec node "' +
            join(packageRoot, 'bin', 'zterm-daemon.cjs') +
            '" "$@"\\n',
        ),
        stageShim(
          localBin,
          'wterm',
          '#!/usr/bin/env bash\\nset -euo pipefail\\nexec node "' +
            join(packageRoot, 'bin', 'wterm.cjs') +
            '" "$@"\\n',
        ),
      ];
  for (const { target, temporary } of staged) {
    renameSync(temporary, target);
    console.log('[zterm-daemon] installed user shim ' + target);
  }
} catch (error) {
  console.error(
    '[zterm-daemon] shim install failed: ' +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
}
`;

function usage() {
  return [
    'Usage:',
    '  node android/scripts/prepare-daemon-npm-package.mjs \\',
    '    --version <daemon-version> \\',
    '    --release darwin-arm64=<release-dir> \\',
    '    --release linux-x64=<release-dir> \\',
    '    --release win32-x64=<release-dir> \\',
    '    [--output-dir <directory>]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    version: undefined,
    outputDir: undefined,
    releases: new Map(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      return { help: true, options };
    }
    if (!['--version', '--release', '--release-dir', '--output-dir'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === '--version') {
      if (options.version) throw new Error('--version may be specified only once');
      options.version = value.replace(/^v/, '');
    } else if (argument === '--output-dir') {
      if (options.outputDir) throw new Error('--output-dir may be specified only once');
      options.outputDir = resolve(value);
    } else {
      const separator = value.indexOf('=');
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`${argument} must use <tuple>=<release-dir>`);
      }
      const tuple = value.slice(0, separator);
      const releaseDir = resolve(value.slice(separator + 1));
      if (!tuples.some((entry) => entry.tuple === tuple)) {
        throw new Error(`unsupported platform tuple: ${tuple}`);
      }
      if (options.releases.has(tuple)) {
        throw new Error(`duplicate platform tuple: ${tuple}`);
      }
      options.releases.set(tuple, releaseDir);
    }
  }
  return { help: false, options };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON at ${path}: ${error.message}`);
  }
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function nodeVersionParts(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : undefined;
}

function compareVersions(left, right) {
  const leftParts = nodeVersionParts(left);
  const rightParts = nodeVersionParts(right);
  if (!leftParts || !rightParts) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '')) {
    throw new Error(`--version must be an exact semver, got: ${version || '<missing>'}`);
  }
}

function tupleFiles(spec) {
  return platformRuntimeComponents(spec.os, spec.arch);
}

function validateRelease(spec, releaseDir, requestedVersion) {
  const manifestPath = join(releaseDir, 'zterm-package.json');
  requirePath(manifestPath, `${spec.tuple} release manifest`);
  const input = readJson(manifestPath, `${spec.tuple} release manifest`);
  if (input.schemaVersion !== 1 || !input.platform || !input.platform.node) {
    throw new Error(`${spec.tuple} release manifest has an unsupported schema`);
  }
  if (input.platform.os !== spec.os || input.platform.arch !== spec.arch) {
    throw new Error(
      `${spec.tuple} release manifest targets ${input.platform.os}-${input.platform.arch}`,
    );
  }
  if (!/^\d+$/.test(String(input.platform.node.abi || ''))) {
    throw new Error(`${spec.tuple} release manifest is missing Node ABI`);
  }
  if (
    Number.isNaN(compareVersions(input.platform.node.minimum || '', '22.0.0')) ||
    compareVersions(input.platform.node.minimum || '', '22.0.0') < 0
  ) {
    throw new Error(`${spec.tuple} release manifest must require Node 22 or newer`);
  }

  const runtimeComponents = tupleFiles(spec);
  for (const component of runtimeComponents) {
    requirePath(join(releaseDir, component), `${spec.tuple} ${component}`);
  }
  return {
    input,
    runtimeComponents,
    packageName: `${publicPackageName}-${spec.tuple}`,
    requestedVersion,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function copyRuntimeComponent(sourceRoot, packageRoot, relativePath) {
  const source = join(sourceRoot, relativePath);
  const destination = join(packageRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  const stat = statSync(source);
  if (stat.isDirectory()) {
    cpSync(source, destination, { recursive: true });
  } else {
    copyFileSync(source, destination);
  }
}

function writePayloadPackage(stagingRoot, spec, releaseDir, version, release) {
  const packageRoot = join(stagingRoot, 'packages', '@jsonstudio', `zterm-daemon-${spec.tuple}`);
  mkdirSync(packageRoot, { recursive: true });
  for (const relativePath of release.runtimeComponents) {
    copyRuntimeComponent(releaseDir, packageRoot, relativePath);
  }
  for (const relativePath of [
    'support/zterm-daemon.sh',
    'support/zterm-daemon',
    'support/windows/zterm-daemon.ps1',
  ]) {
    if (release.runtimeComponents.includes(relativePath)) {
      chmodSync(join(packageRoot, relativePath), 0o755);
    }
  }

  writeJson(join(packageRoot, 'zterm-package.json'), {
    schemaVersion: 1,
    package: {
      name: release.packageName,
      version,
    },
    platform: {
      os: spec.os,
      arch: spec.arch,
      node: {
        minimum: '22.0.0',
        abi: String(release.input.platform.node.abi),
      },
    },
    runtimeComponents: release.runtimeComponents,
  });
  writeJson(join(packageRoot, 'package.json'), {
    name: release.packageName,
    version,
    description: `ZTerm daemon payload for ${spec.tuple}.`,
    license: 'Apache-2.0',
    type: 'commonjs',
    os: [spec.os],
    cpu: [spec.arch],
    files: ['runtime', 'support', 'zterm-package.json', 'README.md', 'LICENSE'],
    engines: {
      node: '>=22',
    },
    publishConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    },
  });
  copyFileSync(join(workspaceRoot, 'LICENSE'), join(packageRoot, 'LICENSE'));
  writeFileSync(
    join(packageRoot, 'README.md'),
    `# ${release.packageName}\n\nInternal ZTerm daemon runtime payload for ${spec.os} ${spec.arch} on Node.js 22.\n`,
  );
  return packageRoot;
}

function writePublicPackage(stagingRoot, version, payloadPackages) {
  const packageRoot = join(stagingRoot, 'packages', '@jsonstudio', 'zterm-daemon');
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(packageRoot, 'support'), { recursive: true });
  writeExecutable(join(packageRoot, 'bin', 'zterm-daemon.cjs'), publicBinSource);
  writeExecutable(join(packageRoot, 'bin', 'wterm.cjs'), publicWtermSource);
  writeExecutable(join(packageRoot, 'support', 'install-user-shims.cjs'), publicShimInstallerSource);
  copyFileSync(join(workspaceRoot, 'LICENSE'), join(packageRoot, 'LICENSE'));
  writeJson(join(packageRoot, 'package.json'), {
    name: publicPackageName,
    version,
    description:
      'ZTerm daemon terminal bridge, file transfer, relay, and remote screenshot support.',
    license: 'Apache-2.0',
    homepage: 'https://github.com/Jasonzhangf/zterm#readme',
    repository: {
      type: 'git',
      url: 'git+https://github.com/Jasonzhangf/zterm.git',
    },
    bugs: {
      url: 'https://github.com/Jasonzhangf/zterm/issues',
    },
    type: 'commonjs',
    bin: {
      'zterm-daemon': 'bin/zterm-daemon.cjs',
      wterm: 'bin/wterm.cjs',
    },
    files: ['bin', 'support', 'README.md', 'LICENSE'],
    optionalDependencies: Object.fromEntries(
      payloadPackages.map(({ packageName }) => [packageName, version]),
    ),
    engines: {
      node: '>=22',
    },
    publishConfig: {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    },
    keywords: ['zterm', 'terminal', 'daemon', 'tmux'],
  });
  writeFileSync(
    join(packageRoot, 'README.md'),
    `# @jsonstudio/zterm-daemon

Node.js 22 daemon package with platform payloads for:

- darwin-arm64
- linux-x64
- win32-x64

Install the public package and run \`zterm-daemon --version\` to verify the local payload.
\`zterm-daemon config\` reads the shared ZTerm configuration without migration.
\`zterm-daemon install-service\` is a separate explicit lifecycle action.
`,
  );
  return packageRoot;
}

function packPackage(packageRoot, stagingRoot) {
  const output = execFileSync(
    'npm',
    ['pack', packageRoot, '--pack-destination', stagingRoot],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  if (!output) {
    throw new Error(`npm pack returned no tarball for ${packageRoot}`);
  }
  return join(stagingRoot, basename(output));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const { options } = parsed;
  validateVersion(options.version);
  const missingTuples = tuples
    .filter(({ tuple }) => !options.releases.has(tuple))
    .map(({ tuple }) => tuple);
  const extraTuples = [...options.releases.keys()].filter(
    (tuple) => !tuples.some((entry) => entry.tuple === tuple),
  );
  if (missingTuples.length > 0 || extraTuples.length > 0) {
    throw new Error(
      `exactly three release tuples are required; missing=${missingTuples.join(',') || '-'} extra=${extraTuples.join(',') || '-'}`,
    );
  }

  const validated = tuples.map((spec) => {
    const releaseDir = options.releases.get(spec.tuple);
    return {
      ...spec,
      releaseDir,
      release: validateRelease(spec, releaseDir, options.version),
    };
  });
  const outputDir =
    options.outputDir ??
    resolve(projectRoot, 'release-dist', 'npm', `zterm-daemon-${options.version}`);
  if (existsSync(outputDir)) {
    throw new Error(`output already exists for daemon ${options.version}: ${outputDir}`);
  }

  const outputParent = dirname(outputDir);
  mkdirSync(outputParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(outputParent, `.${basename(outputDir)}-`));
  try {
    const payloadPackages = validated.map(({ spec, ...entry }) => ({
      ...entry,
      packageRoot: writePayloadPackage(
        stagingRoot,
        entry,
        entry.releaseDir,
        options.version,
        entry.release,
      ),
      packageName: entry.release.packageName,
    }));
    const publicPackageRoot = writePublicPackage(
      stagingRoot,
      options.version,
      payloadPackages,
    );

    const tarballs = [];
    for (const payloadPackage of payloadPackages) {
      tarballs.push(packPackage(payloadPackage.packageRoot, stagingRoot));
    }
    tarballs.unshift(packPackage(publicPackageRoot, stagingRoot));
    if (existsSync(outputDir)) {
      throw new Error(`output appeared during packaging: ${outputDir}`);
    }
    renameSync(stagingRoot, outputDir);
    const relativePackages = join(outputDir, 'packages', '@jsonstudio');
    console.log('[prepare-daemon-npm-package] ready');
    console.log(`- version: ${options.version}`);
    console.log(`- outputDir: ${outputDir}`);
    console.log(`- publicPackage: ${join(relativePackages, 'zterm-daemon')}`);
    for (const { tuple } of tuples) {
      console.log(`- payload.${tuple}: ${join(relativePackages, `zterm-daemon-${tuple}`)}`);
    }
    for (const tarball of tarballs) {
      console.log(`- tarball: ${join(outputDir, basename(tarball))}`);
    }
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(`[prepare-daemon-npm-package] ${error.message}`);
  process.exitCode = 1;
}
