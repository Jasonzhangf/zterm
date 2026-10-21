#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(projectRoot, '..');
const supportedTargets = new Set([
  'darwin-arm64',
  'linux-x64',
  'win32-x64',
]);

function fail(message) {
  throw new Error(message);
}

function requireFile(filePath, label) {
  if (!filePath) fail(`missing ${label}`);
  const absolute = resolve(filePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`missing ${label}: ${absolute}`);
  }
  return absolute;
}

function requireDirectory(directoryPath, label) {
  if (!directoryPath) fail(`missing ${label}`);
  const absolute = resolve(directoryPath);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    fail(`missing ${label}: ${absolute}`);
  }
  return absolute;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
  if (result.error) {
    fail(`${options.label ?? command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(
      `${options.label ?? command} failed with exit ${result.status}${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return result.stdout;
}

function resolvePackageDirectory(packageName) {
  const requireFromProject = createRequire(join(projectRoot, 'package.json'));
  for (const base of [projectRoot, workspaceRoot]) {
    try {
      return dirname(requireFromProject.resolve(`${packageName}/package.json`, { paths: [base] }));
    } catch {
      // Continue with the pnpm store resolver.
    }
  }

  const namespace = packageName.includes('/') ? packageName.split('/')[0] : '';
  const packageBase = packageName.split('/').at(-1);
  const storeRoot = join(workspaceRoot, 'node_modules', '.pnpm');
  if (existsSync(storeRoot)) {
    const matches = readdirSync(storeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${packageName.replace('/', '+')}@`))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    for (const storeEntry of matches.reverse()) {
      const candidate = namespace
        ? join(storeRoot, storeEntry, 'node_modules', namespace, packageBase)
        : join(storeRoot, storeEntry, 'node_modules', packageBase);
      if (existsSync(candidate)) return candidate;
    }
  }
  fail(`unable to resolve ${packageName}`);
}

function resolveEsbuildBin() {
  if (process.env.ZTERM_STAGE_ESBUILD_BIN) {
    return requireFile(process.env.ZTERM_STAGE_ESBUILD_BIN, 'esbuild binary');
  }
  const storeRoot = join(workspaceRoot, 'node_modules', '.pnpm');
  const candidates = existsSync(storeRoot)
    ? readdirSync(storeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^esbuild@\d/.test(entry.name))
        .map((entry) => join(storeRoot, entry.name, 'node_modules', 'esbuild', 'bin', 'esbuild'))
        .filter(existsSync)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    : [];
  if (candidates.length === 0) {
    fail(`missing esbuild under ${storeRoot}`);
  }
  return candidates.at(-1);
}

function bundle(sourcePath, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  run(
    process.execPath,
    [
      resolveEsbuildBin(),
      sourcePath,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      '--outfile=' + outputPath,
      '--external:node-pty',
    ],
    { label: `esbuild ${basename(sourcePath)}` },
  );
  chmodSync(outputPath, 0o755);
}

function validateDagpipeNative(nativePath) {
  const absolute = requireFile(nativePath, 'DAGpipe native input');
  const probe = [
    "const native = require(process.argv[1]);",
    "const required = ['compileAllDagpipePhases', 'runPhase2DaemonConnection', 'runPhase7Release'];",
    "for (const name of required) {",
    "  if (typeof native[name] !== 'function') throw new Error(`missing export ${name}`);",
    '}',
  ].join('\n');
  run(process.execPath, ['-e', probe, absolute], {
    label: `DAGpipe native input ${absolute} could not be loaded`,
  });
  return absolute;
}

function normalizeTarget(options = {}) {
  const targetOs = options.targetOs ?? platform();
  const targetArch = options.targetArch ?? arch();
  const triple = `${targetOs}-${targetArch}`;
  if (!supportedTargets.has(triple)) {
    fail(
      `unsupported target ${triple}; expected one of ${[...supportedTargets].join(', ')}`,
    );
  }
  return { targetOs, targetArch, triple };
}

function linuxRunner() {
  return `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$(realpath "$PACKAGE_ROOT")"
RUNTIME_DIR="$PACKAGE_ROOT/runtime"
SUPPORT_DIR="$PACKAGE_ROOT/support"
TERMINAL_CONFIG_COMMAND="$SUPPORT_DIR/terminal-config-command.cjs"
SERVER_ENTRY="$RUNTIME_DIR/server.cjs"
DAGPIPE_NATIVE="$RUNTIME_DIR/dagpipe.node"
NODE_BIN="\${ZTERM_NODE_EXE:-$(command -v node)}"
ZTERM_HOME="\${HOME}/.zterm"
RUN_DIR="$ZTERM_HOME/run"
LOG_DIR="$ZTERM_HOME/logs"
PID_FILE="$RUN_DIR/zterm-daemon.pid"

if [[ ! -f "$SERVER_ENTRY" ]]; then
  echo "missing daemon runtime: $SERVER_ENTRY" >&2
  exit 1
fi
if [[ ! -f "$DAGPIPE_NATIVE" ]]; then
  echo "missing DAGpipe native: $DAGPIPE_NATIVE" >&2
  exit 1
fi

export ZTERM_PACKAGE_ROOT="$PACKAGE_ROOT"
export ZTERM_DAGPIPE_NATIVE="$DAGPIPE_NATIVE"

read_config() {
  "$NODE_BIN" "$TERMINAL_CONFIG_COMMAND" daemon-config --shell
}

read_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ -n "$pid" ]] || return 1
  printf '%s\\n' "$pid"
}

pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

run_foreground() {
  exec "$NODE_BIN" "$SERVER_ENTRY" "$@"
}

start_direct() {
  local pid
  if pid="$(read_pid)" && pid_running "$pid"; then
    echo "zterm daemon already running: pid=$pid"
    return 0
  fi
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  local timestamp stdout_log stderr_log
  timestamp="$(date +%Y%m%d-%H%M%S)"
  stdout_log="$LOG_DIR/daemon-$timestamp.out.log"
  stderr_log="$LOG_DIR/daemon-$timestamp.err.log"
  nohup "$NODE_BIN" "$SERVER_ENTRY" >"$stdout_log" 2>"$stderr_log" &
  pid="$!"
  printf '%s\\n' "$pid" > "$PID_FILE"
  sleep 1
  if ! pid_running "$pid"; then
    rm -f "$PID_FILE"
    echo "zterm daemon failed to start; stdout=$stdout_log stderr=$stderr_log" >&2
    return 1
  fi
  echo "zterm daemon started: pid=$pid"
  echo "stdout=$stdout_log"
  echo "stderr=$stderr_log"
}

stop_direct() {
  local pid
  if ! pid="$(read_pid)"; then
    echo "zterm daemon not running"
    return 0
  fi
  if ! pid_running "$pid"; then
    rm -f "$PID_FILE"
    echo "zterm daemon not running"
    return 0
  fi
  kill "$pid"
  for _ in {1..40}; do
    if ! pid_running "$pid"; then
      rm -f "$PID_FILE"
      echo "zterm daemon stopped: pid=$pid"
      return 0
    fi
    sleep 0.25
  done
  echo "zterm daemon pid $pid did not stop" >&2
  return 1
}

status_direct() {
  local pid
  if pid="$(read_pid)" && pid_running "$pid"; then
    echo "zterm daemon running: pid=$pid"
    return 0
  fi
  echo "zterm daemon not running"
  return 1
}

command_name="\${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$command_name" in
  run) run_foreground "$@" ;;
  start) start_direct ;;
  stop) stop_direct ;;
  restart) stop_direct; start_direct ;;
  status) status_direct ;;
  config) "$NODE_BIN" "$TERMINAL_CONFIG_COMMAND" daemon-config ;;
  configure-relay) "$NODE_BIN" "$TERMINAL_CONFIG_COMMAND" configure-relay "$@" ;;
  install-service|uninstall-service|service-status)
    echo "Linux service management is not provided by this payload runner" >&2
    exit 2
    ;;
  ""|help|-h|--help)
    cat <<'USAGE'
Usage:
  zterm-daemon run
  zterm-daemon start
  zterm-daemon status
  zterm-daemon config
  zterm-daemon stop
  zterm-daemon restart
  zterm-daemon configure-relay --relay-url URL --username USER --password-stdin --host-id HOST_ID [--device-name NAME]
USAGE
    ;;
  *)
    echo "unknown command: $command_name" >&2
    exit 1
    ;;
esac
`;
}

function stageDarwinAdapter({
  outputDir,
  packageRoot,
  adapter = join(projectRoot, 'scripts', 'prepare-global-daemon-release.sh'),
}) {
  const adapterPath = requireFile(adapter, 'Darwin release adapter');
  const adapterStage = mkdtempSync(join(tmpdir(), 'zterm-darwin-support-'));
  try {
    run('bash', [adapterPath, '--stage-platform-support', adapterStage], {
      cwd: packageRoot,
      label: `Darwin release adapter ${adapterPath}`,
    });
    const stagedSupport = join(adapterStage, 'support');
    for (const component of [
      'zterm-daemon.sh',
      'zterm-daemon',
      'terminal-config-command.cjs',
    ]) {
      const source = requireFile(join(stagedSupport, component), `Darwin adapter ${component}`);
      const destination = join(outputDir, 'support', component);
      copyFileSync(source, destination);
      chmodSync(destination, 0o755);
    }
  } finally {
    rmSync(adapterStage, { recursive: true, force: true });
  }
}

export function stagePlatformSupport({
  outputDir,
  packageRoot = projectRoot,
  targetOs = platform(),
  targetArch = arch(),
  terminalConfigSource = join(packageRoot, 'src', 'server', 'terminal-config-command.ts'),
  darwinReleaseAdapter,
}) {
  const supportDir = resolve(outputDir, 'support');
  mkdirSync(supportDir, { recursive: true });

  if (targetOs === 'darwin') {
    stageDarwinAdapter({
      outputDir,
      packageRoot,
      adapter:
        darwinReleaseAdapter ??
        join(packageRoot, 'scripts', 'prepare-global-daemon-release.sh'),
    });
    return {
      runner: 'support/zterm-daemon.sh',
      nativeHelper: 'support/zterm-daemon',
    };
  }

  bundle(
    requireFile(terminalConfigSource, 'terminal config command source'),
    join(supportDir, 'terminal-config-command.cjs'),
  );
  if (targetOs === 'linux') {
    const runnerPath = join(supportDir, 'zterm-daemon.sh');
    writeFileSync(runnerPath, linuxRunner(), { mode: 0o755 });
    chmodSync(runnerPath, 0o755);
    return { runner: 'support/zterm-daemon.sh' };
  }
  if (targetOs === 'win32') {
    const source = requireFile(
      join(packageRoot, 'scripts', 'windows', 'zterm-daemon.ps1'),
      'Windows daemon runner',
    );
    const destination = join(supportDir, 'windows', 'zterm-daemon.ps1');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return { runner: 'support/windows/zterm-daemon.ps1' };
  }
  fail(`unsupported runner target: ${targetOs}-${targetArch}`);
}

export function createPlatformManifest({
  version,
  targetOs,
  targetArch,
  nodeAbi,
}) {
  for (const [name, value] of Object.entries({ version, targetOs, targetArch })) {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`platform manifest requires ${name}`);
    }
  }
  const runtimeComponents = [
    'runtime/server.cjs',
    'runtime/dagpipe.node',
    'runtime/node_modules/node-pty',
    'runtime/node_modules/@roamhq/wrtc',
    `runtime/node_modules/@roamhq/wrtc-${targetOs}-${targetArch}/wrtc.node`,
    'support/terminal-config-command.cjs',
  ];
  if (targetOs === 'darwin') {
    runtimeComponents.push('support/zterm-daemon.sh', 'support/zterm-daemon');
  } else if (targetOs === 'linux') {
    runtimeComponents.push('support/zterm-daemon.sh');
  } else if (targetOs === 'win32') {
    runtimeComponents.push('support/windows/zterm-daemon.ps1');
  } else {
    fail(`unsupported manifest target: ${targetOs}-${targetArch}`);
  }
  return {
    schemaVersion: 1,
    package: {
      name: `@jsonstudio/zterm-daemon-${targetOs}-${targetArch}`,
      version,
    },
    platform: {
      os: targetOs,
      arch: targetArch,
      node: {
        minimum: '22.0.0',
        abi: String(nodeAbi ?? process.versions.modules),
      },
    },
    runtimeComponents,
  };
}

function stageRuntime({
  outputDir,
  packageRoot,
  targetOs,
  targetArch,
  dagpipeNative,
  dagpipeValidationSource,
  wrtcInputManifest,
  nodePtyDir,
  wrtcDir,
  wrtcPlatformDir,
}) {
  if (`${targetOs}-${targetArch}` !== `${platform()}-${arch()}`) {
    fail(
      `cross-platform staging is unsupported: target ${targetOs}-${targetArch}, host ${platform()}-${arch()}; run this entry on the target tuple`,
    );
  }
  const native = requireFile(dagpipeNative, 'DAGpipe native input');
  validateDagpipeNative(dagpipeValidationSource ?? native);
  const manifestPath = requireFile(
    wrtcInputManifest ?? process.env.ZTERM_DAEMON_WRTC_INPUT_MANIFEST,
    'WRTC release input manifest',
  );
  const nodePtySource = requireDirectory(
    nodePtyDir ?? resolvePackageDirectory('node-pty'),
    'node-pty package',
  );
  const wrtcSource = requireDirectory(
    wrtcDir ?? resolvePackageDirectory('@roamhq/wrtc'),
    '@roamhq/wrtc package',
  );
  const wrtcPlatformSource = requireDirectory(
    wrtcPlatformDir ?? resolvePackageDirectory(`@roamhq/wrtc-${targetOs}-${targetArch}`),
    `@roamhq/wrtc-${targetOs}-${targetArch} package`,
  );

  const runtimeDir = join(outputDir, 'runtime');
  const nodeModulesDir = join(runtimeDir, 'node_modules');
  const roamhqDir = join(nodeModulesDir, '@roamhq');
  mkdirSync(roamhqDir, { recursive: true });
  copyFileSync(native, join(runtimeDir, 'dagpipe.node'));
  chmodSync(join(runtimeDir, 'dagpipe.node'), 0o755);
  bundle(
    requireFile(join(packageRoot, 'src', 'server', 'server.ts'), 'daemon server source'),
    join(runtimeDir, 'server.cjs'),
  );
  cpSync(nodePtySource, join(nodeModulesDir, 'node-pty'), { recursive: true });
  cpSync(wrtcSource, join(roamhqDir, 'wrtc'), { recursive: true });
  cpSync(
    wrtcPlatformSource,
    join(roamhqDir, `wrtc-${targetOs}-${targetArch}`),
    { recursive: true },
  );

  const helperDirectory = join(nodePtySource, 'prebuilds', `${targetOs}-${targetArch}`);
  if (existsSync(join(helperDirectory, 'spawn-helper'))) {
    chmodSync(
      join(nodeModulesDir, 'node-pty', 'prebuilds', `${targetOs}-${targetArch}`, 'spawn-helper'),
      0o755,
    );
  }
  const platformPrebuild = join(nodeModulesDir, 'node-pty', 'prebuilds', `${targetOs}-${targetArch}`);
  if (existsSync(platformPrebuild)) {
    for (const entry of readdirSync(platformPrebuild, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.node') || entry.name.endsWith('.exe'))) {
        chmodSync(join(platformPrebuild, entry.name), 0o755);
      }
    }
  }

  run(
    process.execPath,
    [
      join(projectRoot, 'scripts', 'prepare-daemon-release-wrtc-input.mjs'),
      '--manifest',
      manifestPath,
      '--runtime-dir',
      runtimeDir,
    ],
    { label: 'WRTC release input gate' },
  );
}

function parseArgs(args) {
  const options = {};
  const stringArgs = new Map([
    ['--output-dir', 'outputDir'],
    ['--version', 'version'],
    ['--dagpipe-native', 'dagpipeNative'],
    ['--wrtc-input-manifest', 'wrtcInputManifest'],
    ['--node-pty-dir', 'nodePtyDir'],
    ['--wrtc-dir', 'wrtcDir'],
    ['--wrtc-platform-dir', 'wrtcPlatformDir'],
    ['--target-os', 'targetOs'],
    ['--target-arch', 'targetArch'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const key = stringArgs.get(arg);
    if (!key) fail(`unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  for (const required of ['outputDir', 'version', 'dagpipeNative']) {
    if (!options[required]) fail(`missing --${required.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`);
  }
  return options;
}

function outputOwnershipError(outputDir) {
  if (!existsSync(outputDir)) return null;
  if (!statSync(outputDir).isDirectory()) {
    fail(`output path is not a directory: ${outputDir}`);
  }
  const manifestPath = join(outputDir, 'zterm-package.json');
  if (!existsSync(manifestPath)) {
    fail(`refusing to replace non-staging output directory: ${outputDir}`);
  }
  const manifest = readJson(manifestPath, 'existing output manifest');
  const packageName = manifest?.package?.name;
  if (typeof packageName !== 'string' || !packageName.startsWith('@jsonstudio/zterm-daemon-')) {
    fail(`refusing to replace output owned by ${JSON.stringify(packageName)}: ${outputDir}`);
  }
  return manifest;
}

export function stageDaemonPlatformRelease({
  outputDir,
  version,
  dagpipeNative,
  dagpipeValidationSource,
  wrtcInputManifest,
  nodePtyDir,
  wrtcDir,
  wrtcPlatformDir,
  targetOs,
  targetArch,
  darwinReleaseAdapter,
  packageRoot = projectRoot,
}) {
  const target = normalizeTarget({ targetOs, targetArch });
  outputDir = resolve(outputDir);
  outputOwnershipError(outputDir);

  const parentDir = dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });
  const temporaryOutput = mkdtempSync(join(parentDir, `.${basename(outputDir)}-stage-`));
  try {
    stageRuntime({
      outputDir: temporaryOutput,
      packageRoot,
      targetOs: target.targetOs,
      targetArch: target.targetArch,
      dagpipeNative,
      dagpipeValidationSource,
      wrtcInputManifest,
      nodePtyDir,
      wrtcDir,
      wrtcPlatformDir,
    });
    const support = stagePlatformSupport({
      outputDir: temporaryOutput,
      packageRoot,
      targetOs: target.targetOs,
      targetArch: target.targetArch,
      darwinReleaseAdapter,
    });
    const manifest = createPlatformManifest({
      version,
      targetOs: target.targetOs,
      targetArch: target.targetArch,
    });
    const missing = manifest.runtimeComponents.filter(
      (component) => !existsSync(join(temporaryOutput, component)),
    );
    if (missing.length > 0) {
      fail(`staged platform payload is missing components: ${missing.join(', ')}`);
    }
    writeFileSync(
      join(temporaryOutput, 'zterm-package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeFileSync(join(temporaryOutput, 'VERSION'), `${version}\n`);
    rmSync(outputDir, { recursive: true, force: true });
    renameSync(temporaryOutput, outputDir);
    return {
      outputDir,
      target: target.triple,
      version,
      runner: support.runner,
      nativeHelper: support.nativeHelper ?? null,
      manifest,
    };
  } catch (error) {
    rmSync(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = stageDaemonPlatformRelease(options);
    console.log('[zterm-daemon-platform] ready');
    console.log(`- target: ${result.target}`);
    console.log(`- version: ${result.version}`);
    console.log(`- dir: ${result.outputDir}`);
    console.log(`- runner: ${result.runner}`);
    if (result.nativeHelper) {
      console.log(`- native helper: ${result.nativeHelper}`);
    }
  } catch (error) {
    console.error(`[zterm-daemon-platform] error: ${error.message}`);
    process.exit(1);
  }
}
