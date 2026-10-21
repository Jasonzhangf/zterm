#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

import {
  formalCliInvocation,
  installedCliBin,
  installedCliPackageRoot,
} from './platform-smoke-helper.mjs';
import { resolveRemoteNodePty } from './remote-cli-blackbox-helper.mjs';
import { resolveNpmInvocation } from './process-entry.mjs';

const CLI_PACKAGE = '@jsonstudio/zterm-cli';
const CLI_V1 = '1.0.0-blackbox.1';
const CLI_V2 = '2.0.0-blackbox.1';
const TEST_REGION = '127.0.0.1';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = dirname(scriptDir);
const repoRoot = resolve(cliDir, '..', '..');
const DEFAULT_EVIDENCE_DIR = join(repoRoot, 'tmp', 'npm-blackbox');
const mainEntry = join(cliDir, 'src', 'main.ts');
const sourceManifestPath = join(cliDir, 'package.json');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const evidenceDir = resolve(
  argumentValue('--evidence-dir') ?? DEFAULT_EVIDENCE_DIR,
);
const nodePtyPackageRootArg = argumentValue('--pty-package-root');
const nodePtyPackageRoot = nodePtyPackageRootArg
  ? resolve(nodePtyPackageRootArg)
  : undefined;
const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'zterm-cli-npm-blackbox-')));
const testHome = join(testRoot, 'home');
const npmPrefix = join(testRoot, 'npm-global');
const npmCache = join(testRoot, 'npm-cache');
const npmUserConfig = join(testRoot, 'npmrc');
const packageRoot = join(testRoot, 'packages');
const dependencyRoot = join(testRoot, 'dependencies');
const configPath = join(testHome, '.zterm', 'config.json');
const activeEvidence = join(evidenceDir, 'npm-blackbox-run.log');
const platform = process.platform;

const stages = [];
const activeChildren = new Set();
let registry;
let tempRootRemoved = false;
let failure;

function now() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${now()}] ${message}`;
  process.stdout.write(`${line}\n`);
}

function appendEvidence(message) {
  try {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(activeEvidence, `${message}\n`, { flag: 'a', mode: 0o644 });
  } catch {
    // The run summary still contains the stage outcome if evidence writing fails.
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function makeDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function copyPackageFile(source, destination) {
  copyFileSync(source, destination);
}

function sourcePackageManifest() {
  return readJson(sourceManifestPath);
}

function isolatedEnvironment(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key === 'TMUX'
      || key === 'TMUX_PANE'
      || key === 'TMUX_TMPDIR'
      || key === 'ZTERM'
      || key.startsWith('ZTERM_')
      || key.startsWith('npm_config_')
      || key.startsWith('NPM_CONFIG_')
    ) {
      continue;
    }
    env[key] = value;
  }
  const path = env.PATH ?? env.Path ?? (
    platform === 'win32'
      ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${process.env.SystemRoot || 'C:\\Windows'}`
      : '/usr/local/bin:/usr/bin:/bin'
  );
  const pathSeparator = delimiter;
  const binPath = platform === 'win32'
    ? npmPrefix
    : join(npmPrefix, 'bin');
  return {
    ...env,
    HOME: testHome,
    USERPROFILE: testHome,
    npm_config_prefix: npmPrefix,
    NPM_CONFIG_PREFIX: npmPrefix,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_userconfig: npmUserConfig,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    npm_config_registry: registry?.url ?? '',
    NPM_CONFIG_REGISTRY: registry?.url ?? '',
    npm_config_audit: 'false',
    NPM_CONFIG_AUDIT: 'false',
    npm_config_fund: 'false',
    NPM_CONFIG_FUND: 'false',
    npm_config_update_notifier: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    npm_config_fetch_retries: '0',
    NPM_CONFIG_FETCH_RETRIES: '0',
    PATH: `${binPath}${pathSeparator}${path}`,
    ...(platform === 'win32' ? { Path: `${binPath}${pathSeparator}${path}` } : {}),
    ...extra,
  };
}

function signalChildTree(child, signal) {
  if (!child.pid) return;
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  if (platform === 'win32') {
    try {
      const killer = spawn(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        },
      );
      killer.once('error', () => {
        try {
          child.kill(signal);
        } catch {
          // The child may have exited before fallback cleanup.
        }
      });
      killer.unref();
      return;
    } catch {
      // Fall back to the direct child if taskkill is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited before cleanup.
  }
}

function startChild(command, args, options = {}) {
  const state = {
    command,
    args: [...args],
    stdout: '',
    stderr: '',
    error: undefined,
    timedOut: false,
  };
  let settled = false;
  let timeout;
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? isolatedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: platform !== 'win32',
    windowsHide: platform === 'win32',
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  });
  const finish = (code, signal) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    activeChildren.delete(child);
    options.onFinish?.(state);
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    state.stdout += chunk;
    options.onOutput?.('stdout', chunk);
  });
  child.stderr?.on('data', (chunk) => {
    state.stderr += chunk;
    options.onOutput?.('stderr', chunk);
  });
  child.once('error', (error) => {
    state.error = error;
  });
  child.once('close', (code, signal) => {
    finish(code, signal);
  });
  const done = new Promise((resolveResult) => {
    child.once('close', (code, signal) => {
      resolveResult({
        command,
        args: [...args],
        exitCode: code,
        signal,
        stdout: state.stdout,
        stderr: state.stderr,
        error: state.error,
        timedOut: state.timedOut,
      });
    });
  });
  activeChildren.add(child);
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      state.timedOut = true;
      signalChildTree(child, 'SIGTERM');
    }, options.timeoutMs);
    timeout.unref();
  }
  return { child, state, done };
}

function installedCliJsEntry() {
  const packageRoot = installedCliPackageRoot(npmPrefix);
  const manifest = readJson(join(packageRoot, 'package.json'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.zterm;
  assert(typeof bin === 'string' && bin.length > 0, 'installed CLI manifest has no zterm bin');
  const entry = resolve(packageRoot, bin);
  assert(existsSync(entry), `installed CLI JS entry is missing: ${entry}`);
  return entry;
}

function windowsCancelPtyInvocation(args) {
  const entry = installedCliJsEntry();
  return formalCliInvocation(process.execPath, [entry, ...args], 'win32');
}

function startWindowsCancelPty(command, args, options = {}) {
  assert(platform === 'win32', 'ConPTY cancellation is only valid on Windows');
  assert(nodePtyPackageRoot, '--pty-package-root is required for Windows cancellation');
  const installation = resolveRemoteNodePty(nodePtyPackageRoot);
  const packageRequire = createRequire(installation.entry);
  const pty = packageRequire(installation.packageRoot);
  assert(pty && typeof pty.spawn === 'function', 'node-pty does not expose spawn()');

  const state = {
    output: '',
    timedOut: false,
    actualExitObserved: false,
    cleanupTerminationRequested: false,
  };
  let exited = false;
  let timeout;
  let exitGrace;
  let settled = false;
  let resolveResult;
  let dataSubscription;
  let exitSubscription;
  const terminal = pty.spawn(command, options.windowsVerbatimArguments ? args.join(' ') : args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? isolatedEnvironment(),
    useConpty: true,
  });
  dataSubscription = terminal.onData((chunk) => {
    state.output += chunk;
    appendEvidence(`cancel PTY output ${now()} ${JSON.stringify(chunk)}`);
    if (state.output.length > 2_000_000) {
      state.output = state.output.slice(-1_000_000);
    }
  });
  const done = new Promise((resolveExit) => { resolveResult = resolveExit; });
  const finish = (exitCode, signal, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(exitGrace);
    resolveResult({
      command,
      args: [...args],
      exitCode,
      signal,
      stdout: state.output,
      stderr: '',
      error,
      timedOut: state.timedOut,
      actualExitObserved: state.actualExitObserved,
      cleanupTerminationRequested: state.cleanupTerminationRequested,
    });
  };
  exitSubscription = terminal.onExit(({ exitCode, signal }) => {
    exited = true;
    state.actualExitObserved = true;
    appendEvidence(`cancel PTY exit ${now()} code=${exitCode} signal=${signal}`);
    finish(exitCode, signal);
  });
  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      state.timedOut = true;
      state.cleanupTerminationRequested = true;
      appendEvidence(`cancel PTY timeout ${now()}`);
      try {
        terminal.kill();
      } catch {
        // The owned PTY may have exited at the timeout boundary.
      }
      if (!settled) exitGrace = setTimeout(() => finish(null, null,
        new Error('owned ConPTY did not exit after timeout cleanup')), 5_000);
    }, options.timeoutMs);
    timeout.unref();
  }

  return {
    terminal,
    done,
    isRunning: () => !exited,
    async close() {
      state.cleanupTerminationRequested ||= !exited;
      if (!exited) {
        try {
          terminal.kill();
        } catch {
          // The owned PTY may have exited before cleanup.
        }
      }
      await Promise.race([
        done,
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
      ]);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      clearTimeout(timeout);
      clearTimeout(exitGrace);
      if (!exited) {
        const error = new Error('owned ConPTY did not exit during cleanup');
        finish(null, null, error);
        throw error;
      }
    },
  };
}

async function runChild(command, args, options = {}) {
  const started = startChild(command, args, options);
  return await started.done;
}

function processSummary(result) {
  return {
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout.trim().slice(0, 1200),
    stderr: result.stderr.trim().slice(0, 1200),
    ...(result.error ? { error: messageOf(result.error) } : {}),
  };
}

async function requireSuccess(result, label) {
  if (result.error) {
    throw new Error(`${label} spawn error: ${messageOf(result.error)}`);
  }
  if (result.timedOut) {
    throw new Error(`${label} timed out`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} exited ${String(result.exitCode)}${result.signal ? ` by ${result.signal}` : ''}: `
        + `${result.stderr.trim() || result.stdout.trim() || 'no process output'}`,
    );
  }
  return result;
}

function packageFilename(manifest, tarballPath) {
  return basename(tarballPath);
}

function parseNpmPackOutput(result) {
  const text = result.stdout.trim();
  assert(text, 'npm pack returned no JSON output');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${messageOf(error)}`);
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  assert(item && typeof item.filename === 'string', 'npm pack JSON is missing filename');
  return item.filename;
}

async function packDirectory(directory, label) {
  const destination = join(testRoot, 'tarballs', label);
  makeDirectory(destination);
  const invocation = resolveNpmInvocation(
    ['pack', '--ignore-scripts', '--json', '--pack-destination', destination, directory],
    { npmCommand: npmCommand(), env: isolatedEnvironment() },
  );
  const result = await runChild(
    invocation.command,
    invocation.args,
    {
      cwd: repoRoot,
      env: isolatedEnvironment(),
      timeoutMs: 120_000,
    },
  );
  await requireSuccess(result, `npm pack ${label}`);
  const filename = parseNpmPackOutput(result);
  const tarballPath = join(destination, filename);
  assert(existsSync(tarballPath), `npm pack did not produce ${tarballPath}`);
  return tarballPath;
}

async function buildCliPackage(version, label) {
  const directory = join(packageRoot, label);
  makeDirectory(join(directory, 'bin'));
  makeDirectory(join(directory, 'dist'));
  copyPackageFile(join(cliDir, 'bin', 'zterm.mjs'), join(directory, 'bin', 'zterm.mjs'));
  copyPackageFile(join(cliDir, 'README.md'), join(directory, 'README.md'));
  copyPackageFile(join(cliDir, 'LICENSE'), join(directory, 'LICENSE'));
  chmodSync(join(directory, 'bin', 'zterm.mjs'), 0o755);

  const manifest = sourcePackageManifest();
  manifest.version = version;
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );

  log(`bundle ${label} from actual main: ${mainEntry}`);
  await esbuild({
    entryPoints: [mainEntry],
    outfile: join(directory, 'dist', 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: {
      __ZTERM_CLI_VERSION__: JSON.stringify(version),
    },
    external: ['ws', '@roamhq/wrtc'],
    logLevel: 'silent',
    absWorkingDir: cliDir,
  });
  const tarballPath = await packDirectory(directory, label);
  return {
    directory,
    manifest,
    tarballPath,
    filename: packageFilename(manifest, tarballPath),
  };
}

function dependencyManifestPath(packageName, parentManifestPath) {
  const requireFromParent = createRequire(parentManifestPath);
  try {
    return realpathSync(requireFromParent.resolve(`${packageName}/package.json`));
  } catch (error) {
    return undefined;
  }
}

function collectDependencyManifests(rootManifestPath) {
  const manifests = new Map();
  const pending = [rootManifestPath];
  while (pending.length > 0) {
    const manifestPath = pending.pop();
    const manifest = readJson(manifestPath);
    const key = `${manifest.name}@${manifest.version}`;
    if (manifests.has(key)) continue;
    manifests.set(key, manifestPath);
    const dependencyNames = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const name of Object.keys(dependencyNames)) {
      const dependencyPath = dependencyManifestPath(name, manifestPath);
      if (dependencyPath) {
        pending.push(dependencyPath);
      } else if (manifest.dependencies?.[name]) {
        throw new Error(`required installed dependency is missing: ${name} (from ${manifestPath})`);
      }
    }
  }
  return [...manifests.values()];
}

async function buildLocalDependencyTarballs() {
  const cliRequire = createRequire(sourceManifestPath);
  const roots = [];
  for (const name of ['ws', '@roamhq/wrtc']) {
    const manifestPath = realpathSync(cliRequire.resolve(`${name}/package.json`));
    roots.push(manifestPath);
  }
  const manifests = [];
  for (const root of roots) {
    manifests.push(...collectDependencyManifests(root));
  }
  const seen = new Set();
  const records = [];
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const directory = realpathSync(dirname(manifestPath));
    const label = `dependency-${key.replaceAll('/', '-')}`;
    const stagingDirectory = join(dependencyRoot, label);
    cpSync(directory, stagingDirectory, {
      recursive: true,
      dereference: true,
    });
    const stagedManifest = readJson(join(stagingDirectory, 'package.json'));
    delete stagedManifest.scripts;
    writeFileSync(
      join(stagingDirectory, 'package.json'),
      `${JSON.stringify(stagedManifest, null, 2)}\n`,
      { mode: 0o644 },
    );
    const tarballPath = await packDirectory(stagingDirectory, label);
    records.push({
      name: manifest.name,
      version: manifest.version,
      manifest,
      tarballPath,
    });
  }
  return records;
}

function jsonResponse(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function splitTarballPath(pathname) {
  const parts = pathname.split('/');
  if (parts.length !== 4 || parts[1] !== 'tarball') return undefined;
  try {
    return {
      name: decodeURIComponent(parts[2]),
      filename: decodeURIComponent(parts[3]),
    };
  } catch {
    return undefined;
  }
}

function requestName(pathname) {
  const path = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!path || path.startsWith('-/')) return undefined;
  const marker = path.indexOf('/-/');
  return marker === -1 ? path : path.slice(0, marker);
}

class LocalRegistry {
  constructor() {
    this.packages = new Map();
    this.latest = new Map();
    this.requests = [];
    this.waiters = new Set();
    this.mode = 'normal';
    this.cancelReleased = false;
    this.cancelWaiters = new Set();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.url = '';
  }

  async start() {
    await new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(0, TEST_REGION, () => {
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          rejectStart(new Error('local registry did not get an ephemeral port'));
          return;
        }
        this.url = `http://${TEST_REGION}:${address.port}/`;
        resolveStart();
      });
    });
    return this.url;
  }

  addPackage(name, version, manifest, tarballPath) {
    if (!this.packages.has(name)) this.packages.set(name, new Map());
    const versions = this.packages.get(name);
    versions.set(version, {
      manifest,
      tarballPath,
    });
    if (!this.latest.has(name)) this.latest.set(name, version);
  }

  setLatest(name, version) {
    assert(this.packages.get(name)?.has(version), `cannot make unknown package version latest: ${name}@${version}`);
    this.latest.set(name, version);
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'cancel') {
      this.cancelReleased = false;
    } else {
      this.releaseCancelledTarball();
    }
  }

  releaseCancelledTarball() {
    this.cancelReleased = true;
    for (const resolveWait of this.cancelWaiters) resolveWait();
    this.cancelWaiters.clear();
  }

  waitForCancelledTarball() {
    if (this.cancelReleased) return Promise.resolve();
    return new Promise((resolveWait) => {
      this.cancelWaiters.add(resolveWait);
    });
  }

  mark() {
    return this.requests.length;
  }

  requestsSince(mark) {
    return this.requests.slice(mark);
  }

  waitFor(predicate, timeoutMs, label) {
    const existing = this.requests.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        predicate,
        resolve: (request) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolveWait(request);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          rejectWait(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectWait(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      timer.unref();
      this.waiters.add(waiter);
    });
  }

  resolveRequestWaiters(request) {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(request)) waiter.resolve(request);
    }
  }

  packument(name) {
    const versions = this.packages.get(name);
    assert(versions, `unknown package: ${name}`);
    const manifestVersions = {};
    for (const [version, record] of versions) {
      const manifest = {
        ...record.manifest,
        dist: {
          tarball: `${this.url}tarball/${encodeURIComponent(name)}/${encodeURIComponent(basename(record.tarballPath))}`,
        },
      };
      manifestVersions[version] = manifest;
    }
    return {
      name,
      'dist-tags': {
        latest: this.latest.get(name),
      },
      versions: manifestVersions,
    };
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', this.url || `http://${TEST_REGION}`);
    const pathname = url.pathname;
    const tarballPath = splitTarballPath(pathname);
    const name = tarballPath?.name ?? requestName(pathname);
    const event = {
      at: now(),
      method: request.method,
      path: pathname,
      name,
      kind: tarballPath ? 'tarball' : 'metadata',
      version: tarballPath
        ? [...(this.packages.get(tarballPath.name)?.entries() ?? [])]
          .find(([, record]) => basename(record.tarballPath) === tarballPath.filename)?.[0]
        : undefined,
    };
    this.requests.push(event);
    this.resolveRequestWaiters(event);
    appendEvidence(`registry ${event.method} ${event.path}`);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.method === 'POST') request.resume();
      jsonResponse(response, 405, { error: 'method not allowed' });
      return;
    }

    if (pathname === '/' || pathname === '/-/ping') {
      jsonResponse(response, 200, { ok: true });
      return;
    }
    if (pathname === '/-/npm/v1/security/advisories/bulk') {
      request.resume();
      jsonResponse(response, 200, {});
      return;
    }
    if (!name) {
      jsonResponse(response, 404, { error: 'not found' });
      return;
    }

    if (
      this.mode === 'registry-error'
      && !tarballPath
      && name === CLI_PACKAGE
    ) {
      jsonResponse(response, 503, { error: 'injected registry metadata failure' });
      return;
    }

    if (tarballPath) {
      const versions = this.packages.get(tarballPath.name);
      const record = versions
        ? [...versions.values()].find(
          (candidate) => basename(candidate.tarballPath) === tarballPath.filename,
        )
        : undefined;
      if (!record) {
        jsonResponse(response, 404, { error: 'tarball not found' });
        return;
      }
      if (
        this.mode === 'install-error'
        && tarballPath.name === CLI_PACKAGE
        && event.version === CLI_V2
      ) {
        jsonResponse(response, 500, { error: 'injected CLI tarball failure' });
        return;
      }
      if (
        this.mode === 'cancel'
        && tarballPath.name === CLI_PACKAGE
        && event.version === CLI_V2
      ) {
        await this.waitForCancelledTarball();
        if (response.destroyed) return;
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': statSync(record.tarballPath).size,
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': statSync(record.tarballPath).size,
        'cache-control': 'no-store',
      });
      const stream = await import('node:fs').then(({ createReadStream }) => createReadStream(record.tarballPath));
      stream.on('error', () => {
        if (!response.headersSent) {
          jsonResponse(response, 500, { error: 'unable to read tarball' });
        } else {
          response.destroy();
        }
      });
      response.on('error', () => stream.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
      return;
    }

    if (!this.packages.has(name)) {
      jsonResponse(response, 404, { error: `unknown package: ${name}` });
      return;
    }
    const packument = this.packument(name);
    jsonResponse(response, 200, packument);
  }

  async close() {
    this.releaseCancelledTarball();
    for (const waiter of this.waiters) {
      waiter.reject(new Error('local registry closed'));
    }
    this.waiters.clear();
    await new Promise((resolveClose) => {
      if (!this.server.listening) {
        resolveClose();
        return;
      }
      this.server.closeAllConnections?.();
      this.server.close(() => resolveClose());
    });
  }
}

function writeFixtureConfig() {
  makeDirectory(dirname(configPath));
  const config = {
    daemon: {
      host: '127.0.0.1',
      port: 43210,
      unknownDaemonField: {
        keep: 'daemon-fixture',
      },
    },
    zterm: {
      cli: {
        authGeneration: 7,
        auth: {
          loginId: 'fixture-login',
          userId: 'fixture-user',
          username: 'fixture-user',
          accessToken: 'fixture-token-not-a-real-secret',
          authenticatedAt: '2026-10-20T00:00:00.000Z',
        },
        server: {
          relayBaseUrl: 'https://fixture.invalid',
        },
        slots: {
          1: {
            account: {
              relayBaseUrl: 'https://fixture.invalid',
              userId: 'fixture-user',
            },
            server: {
              deviceId: 'fixture-device',
              daemonHostId: 'fixture-daemon',
              displayName: 'Fixture Daemon',
            },
            session: {
              backend: 'tmux',
              stableId: 'fixture-session-id',
              name: 'fixture-session',
            },
            widthMode: 'adaptive-phone',
          },
        },
        unknownCliField: {
          keep: ['config', 'value'],
        },
      },
      unknownSection: {
        keep: true,
      },
    },
    unknownRootField: {
      keep: 'root-fixture',
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return readFileSync(configPath, 'utf8');
}

function configUnchanged(label, before) {
  const after = readFileSync(configPath, 'utf8');
  assert(
    after === before,
    `${label}: shared config bytes changed unexpectedly`,
  );
  return true;
}

function parseVersion(output) {
  const match = output.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1];
}

function stageResult(name, startedAt, status, detail, error) {
  return {
    stage: name,
    status,
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    ...(detail ? { detail } : {}),
    ...(error ? { error: messageOf(error) } : {}),
  };
}

async function runStage(name, action) {
  const startedAt = now();
  log(`stage ${name} started`);
  try {
    const detail = await action();
    const result = stageResult(name, startedAt, 'passed', detail);
    stages.push(result);
    appendEvidence(
      `stage ${name} passed ${JSON.stringify(detail ?? {})}`,
    );
    log(`stage ${name} passed`);
    return result;
  } catch (error) {
    const result = stageResult(name, startedAt, 'failed', undefined, error);
    stages.push(result);
    appendEvidence(`stage ${name} failed ${messageOf(error)}`);
    throw error;
  }
}

function npmCommand() {
  return process.env.NPM_COMMAND || 'npm';
}

async function installVersion(version) {
  const mark = registry.mark();
  const invocation = resolveNpmInvocation(
    [
      'install',
      '--global',
      '--prefix',
      npmPrefix,
      `${CLI_PACKAGE}@${version}`,
      '--registry',
      registry.url,
    ],
    { npmCommand: npmCommand(), env: isolatedEnvironment() },
  );
  const result = await runChild(
    invocation.command,
    invocation.args,
    {
      cwd: testRoot,
      env: isolatedEnvironment(),
      timeoutMs: 180_000,
    },
  );
  return {
    result,
    requests: registry.requestsSince(mark),
  };
}

function resetIsolatedNpmPrefix() {
  const relation = relative(resolve(testRoot), resolve(npmPrefix));
  assert(
    relation && !relation.startsWith('..') && !isAbsolute(relation),
    'refusing to reset npm prefix outside the test root',
  );
  rmSync(npmPrefix, { recursive: true, force: true });
  makeDirectory(npmPrefix);
}

function installedPackageTreePresent() {
  return existsSync(installedCliPackageRoot(npmPrefix));
}

async function observeInstalledVersion() {
  const bin = installedCliBin(npmPrefix);
  const entryPresent = existsSync(bin);
  if (!entryPresent) {
    return {
      available: false,
      entryPresent: false,
      raw: '',
      version: 'unavailable',
      result: undefined,
    };
  }
  const cliInvocation = platform === 'win32'
    ? formalCliInvocation(bin, ['--version'])
    : { command: bin, args: ['--version'] };
  const result = await runChild(cliInvocation.command, cliInvocation.args, {
    windowsVerbatimArguments: cliInvocation.windowsVerbatimArguments,
    cwd: testRoot,
    env: isolatedEnvironment(),
    timeoutMs: 30_000,
  });
  const available = !result.error
    && !result.timedOut
    && result.exitCode === 0
    && typeof parseVersion(result.stdout) === 'string';
  return {
    available,
    entryPresent,
    raw: result.stdout.trim(),
    version: parseVersion(result.stdout),
    result,
  };
}

async function installedVersion() {
  const observed = await observeInstalledVersion();
  if (!observed.result) {
    throw new Error(`installed zterm --version missing ${installedCliBin(npmPrefix)}`);
  }
  await requireSuccess(
    observed.result,
    'installed zterm --version',
  );
  assert(observed.available, 'installed zterm --version did not report a version');
  return observed;
}

async function runUpgrade() {
  const bin = installedCliBin(npmPrefix);
  const cliInvocation = platform === 'win32'
    ? formalCliInvocation(bin, ['upgrade', '--registry', registry.url])
    : { command: bin, args: ['upgrade', '--registry', registry.url] };
  const mark = registry.mark();
  const result = await runChild(
    cliInvocation.command,
    cliInvocation.args,
    {
      windowsVerbatimArguments: cliInvocation.windowsVerbatimArguments,
      cwd: testRoot,
      env: isolatedEnvironment(),
      timeoutMs: 180_000,
    },
  );
  return {
    result,
    requests: registry.requestsSince(mark),
    output: `${result.stdout}\n${result.stderr}`,
  };
}

async function expectFailureUpgrade(label, beforeVersion, beforeConfig) {
  const result = await runUpgrade();
  assert(result.result.exitCode !== 0 || result.result.signal, `${label}: expected non-success exit`);
  assert(!result.output.includes('CLI 已升级'), `${label}: falsely reported an updated CLI`);
  assert(
    result.output.includes('未自动回滚'),
    `${label}: missing explicit unverified/rollback boundary in CLI output`,
  );
  const observed = await observeInstalledVersion();
  configUnchanged(label, beforeConfig);
  return {
    installationState: 'unverified',
    exitCode: result.result.exitCode,
    signal: result.result.signal,
    expectedBeforeVersion: beforeVersion,
    observedVersion: observed.version,
    entryPresent: observed.entryPresent,
    packageTreePresent: installedPackageTreePresent(),
    configPreserved: true,
    registryRequests: result.requests.map((entry) => `${entry.kind}:${entry.name}:${entry.version ?? ''}`),
  };
}

async function writeRunNote() {
  mkdirSync(evidenceDir, { recursive: true });
  const completed = stages.filter((stage) => stage.status === 'passed').length;
  const allPassed = !failure && stages.length > 0 && stages.every((stage) => stage.status === 'passed');
  const note = [
    '# zterm npm blackbox',
    '',
    `Status: ${allPassed ? 'PASS' : 'FAIL'}`,
    `Started: ${startedAt}`,
    `Finished: ${now()}`,
    `Command: node packages/cli/scripts/npm-blackbox.mjs --evidence-dir ${evidenceDir}`,
    `Repository: ${repoRoot}`,
    `Isolated HOME: ${testHome}`,
    `Isolated npm prefix: ${npmPrefix}`,
    `Local registry: ${registry?.url ?? 'not started'}`,
    `Result: ${completed}/${stages.length} stages passed`,
    '',
    '## Stages',
    '',
    ...(stages.length === 0
      ? ['- no stage completed']
      : stages.map((stage) => (
        `- ${stage.stage}: ${stage.status} (${stage.durationMs}ms)`
        + (stage.detail
          ? ` - ${[
            typeof stage.detail.version === 'string' ? `version=${stage.detail.version}` : undefined,
            typeof stage.detail.beforeVersion === 'string' ? `before=${stage.detail.beforeVersion}` : undefined,
            typeof stage.detail.afterVersion === 'string' ? `after=${stage.detail.afterVersion}` : undefined,
            typeof stage.detail.observedVersion === 'string' ? `observed=${stage.detail.observedVersion}` : undefined,
            typeof stage.detail.installationState === 'string'
              ? `installationState=${stage.detail.installationState}`
              : undefined,
            typeof stage.detail.entryPresent === 'boolean'
              ? `entryPresent=${String(stage.detail.entryPresent)}`
              : undefined,
            typeof stage.detail.packageTreePresent === 'boolean'
              ? `packageTreePresent=${String(stage.detail.packageTreePresent)}`
              : undefined,
            stage.detail.isolatedPrefixReset === true ? 'isolatedPrefixReset=yes' : undefined,
            stage.detail.configPreserved === true ? 'config=preserved' : undefined,
            typeof stage.detail.injectedFault === 'string' ? `fault=${stage.detail.injectedFault}` : undefined,
          ].filter(Boolean).join(', ')}`
          : '')
        + (stage.error ? ` - ${stage.error}` : '')
      ))),
    '',
    '## Boundary',
    '',
    '- This is an isolated local-registry npm blackbox. It is not a public npm release.',
    '- No current-user global CLI install, daemon lifecycle, daemon configuration mutation, tmux operation, Android build, APK, or OTA operation was performed.',
    '- The two CLI tarballs were bundled from packages/cli/src/main.ts into test-owned temporary directories.',
    '- The shared config was written only under the test HOME. Every stage compared its raw bytes by direct string equality, without hashing.',
    '- The local registry logged npm metadata and tarball HTTP requests; unchanged-v2 requested metadata only.',
    '- Runtime dependency tarballs were packed from the existing installed ws/@roamhq/wrtc input.',
    '- Failure and cancellation report the observed entry and package tree; the harness does not assume automatic rollback.',
    '',
    '## Cleanup',
    '',
    `- Registry closed: ${registry ? 'yes' : 'not started'}`,
    `- Child cleanup: ${activeChildren.size === 0 ? 'yes' : `pending (${activeChildren.size})`}`,
    `- Temporary test root removed: ${tempRootRemoved ? 'yes' : 'no'}`,
    `- Temporary root: ${testRoot}`,
    '',
    ...(failure ? [`Failure: ${failure}`, ''] : []),
    'Evidence: npm-blackbox-run.log',
    '',
  ].join('\n');
  writeFileSync(join(evidenceDir, 'npm-blackbox-note.md'), note, { mode: 0o644 });
}

const startedAt = now();

async function main() {
  assert(existsSync(mainEntry), `actual CLI main entry is missing: ${mainEntry}`);
  assert(existsSync(sourceManifestPath), `CLI package manifest is missing: ${sourceManifestPath}`);
  makeDirectory(evidenceDir);
  makeDirectory(testHome);
  makeDirectory(npmPrefix);
  makeDirectory(npmCache);
  makeDirectory(packageRoot);
  makeDirectory(dependencyRoot);
  writeFileSync(activeEvidence, '');
  const fixtureConfig = writeFixtureConfig();
  writeFileSync(
    npmUserConfig,
    'audit=false\nfund=false\nupdate-notifier=false\n',
    { mode: 0o600 },
  );

  registry = new LocalRegistry();
  log(`local registry ${await registry.start()}`);

  const dependencyRecords = await buildLocalDependencyTarballs();
  for (const record of dependencyRecords) {
    registry.addPackage(record.name, record.version, record.manifest, record.tarballPath);
    registry.setLatest(record.name, record.version);
  }
  const v1 = await buildCliPackage(CLI_V1, 'cli-v1');
  const v2 = await buildCliPackage(CLI_V2, 'cli-v2');
  for (const record of [v1, v2]) {
    registry.addPackage(CLI_PACKAGE, record.manifest.version, record.manifest, record.tarballPath);
  }
  registry.setLatest(CLI_PACKAGE, CLI_V2);

  await runStage('initial-install-v1', async () => {
    const install = await installVersion(CLI_V1);
    await requireSuccess(install.result, 'npm install v1');
    const observed = await installedVersion();
    assert(observed.version === CLI_V1, `expected v1, observed ${observed.raw}`);
    assert(configUnchanged('initial-install-v1', fixtureConfig), 'config check failed');
    return {
      version: observed.version,
      actualBin: installedCliBin(npmPrefix),
      configPreserved: true,
      registryRequests: install.requests.map((entry) => `${entry.kind}:${entry.name}:${entry.version ?? ''}`),
    };
  });

  await runStage('cancel-upgrade', async () => {
    const beforeConfig = readFileSync(configPath, 'utf8');
    registry.setMode('cancel');
    const mark = registry.mark();
    const bin = installedCliBin(npmPrefix);
    const env = isolatedEnvironment();
    const args = ['upgrade', '--registry', registry.url];
    const cliInvocation = platform === 'win32'
      ? windowsCancelPtyInvocation(args)
      : { command: bin, args };
    const running = platform === 'win32'
      ? startWindowsCancelPty(cliInvocation.command, cliInvocation.args, {
        cwd: testRoot,
        env,
        timeoutMs: 60_000,
        windowsVerbatimArguments: cliInvocation.windowsVerbatimArguments,
      })
      : startChild(cliInvocation.command, cliInvocation.args, {
        cwd: testRoot,
        env,
        timeoutMs: 60_000,
        onOutput: (stream, chunk) => appendEvidence(
          `cancel ${stream} ${now()} ${JSON.stringify(chunk)}`,
        ),
      });
    try {
      try {
        await registry.waitFor(
          (request) => request.kind === 'tarball'
            && request.name === CLI_PACKAGE
            && request.version === CLI_V2,
          15_000,
          'CLI v2 tarball request for cancellation',
        );
      } catch (error) {
        if (platform === 'win32') {
          try { await running.close(); } catch (cleanupError) {
            appendEvidence(`cancel wait cleanup error ${messageOf(cleanupError)}`);
          }
        } else if (running.child.exitCode === null && running.child.signalCode === null) {
          signalChildTree(running.child, 'SIGINT');
        }
        registry.releaseCancelledTarball();
        const result = await running.done;
        appendEvidence(`cancel wait failure result ${JSON.stringify(result)}`);
        throw new Error(
          `${messageOf(error)}; child exit=${String(result.exitCode)} signal=${String(result.signal)}; `
            + `stdout=${result.stdout.trim() || '<empty>'}; stderr=${result.stderr.trim() || '<empty>'}`,
        );
      }
      assert(
        platform === 'win32'
          ? running.isRunning()
          : running.child.exitCode === null,
        'cancel process exited before the tarball request',
      );
      appendEvidence(`cancel held tarball observed ${now()}`);
      appendEvidence(`cancel stimulus ${now()} platform=${platform}`);
      if (platform === 'win32') {
        running.terminal.write('\x03');
      } else {
        signalChildTree(running.child, 'SIGINT');
      }
      const result = await running.done;
      appendEvidence(`cancel held-tarball result ${JSON.stringify(result)}`);
      assert(!result.timedOut, 'cancellation timed out; forced termination is not acceptance');
      assert(!result.error, `cancellation process error: ${messageOf(result.error)}`);
      if (platform === 'win32') assert(result.actualExitObserved,
        'cancellation did not observe an actual ConPTY exit');
      const observed = await observeInstalledVersion();
      const output = `${result.stdout}\n${result.stderr}`;
      assert(result.exitCode !== 0 || result.signal, 'cancelled upgrade returned success');
      assert(!output.includes('CLI 已升级'), 'cancelled upgrade falsely reported success');
      assert(
        output.includes('取消') || output.includes('cancelled') || output.includes('未自动回滚'),
        'cancelled upgrade did not expose cancellation or installation state',
      );
      configUnchanged('cancel-upgrade', beforeConfig);
      return {
        installationState: 'unverified',
        exitCode: result.exitCode,
        signal: result.signal,
        observedVersion: observed.version,
        entryPresent: observed.entryPresent,
        packageTreePresent: installedPackageTreePresent(),
        tarballRequestObserved: true,
        configPreserved: true,
        registryRequests: registry.requestsSince(mark).map(
          (entry) => `${entry.kind}:${entry.name}:${entry.version ?? ''}`,
        ),
      };
    } finally {
      log('cancel cleanup started');
      appendEvidence(`cancel tarball release ${now()}`);
      registry.releaseCancelledTarball();
      try {
        if (platform === 'win32') await running.close();
      } finally {
        registry.setMode('normal');
        log('cancel cleanup finished');
      }
    }
  });

  await runStage('restore-v1-before-install-error', async () => {
    resetIsolatedNpmPrefix();
    const install = await installVersion(CLI_V1);
    await requireSuccess(install.result, 'restore npm install v1');
    const observed = await installedVersion();
    assert(observed.version === CLI_V1, `expected restored v1, observed ${observed.raw}`);
    configUnchanged('restore-v1-before-install-error', fixtureConfig);
    return {
      version: observed.version,
      isolatedPrefixReset: true,
      configPreserved: true,
    };
  });

  await runStage('npm-install-error', async () => {
    const beforeConfig = readFileSync(configPath, 'utf8');
    registry.setMode('install-error');
    const result = await expectFailureUpgrade(
      'npm-install-error',
      CLI_V1,
      beforeConfig,
    );
    registry.setMode('normal');
    return {
      ...result,
      injectedFault: 'HTTP 500 while fetching the v2 tarball',
    };
  });

  await runStage('restore-v1-before-success', async () => {
    resetIsolatedNpmPrefix();
    const install = await installVersion(CLI_V1);
    await requireSuccess(install.result, 'restore npm install v1 before success');
    const observed = await installedVersion();
    assert(observed.version === CLI_V1, `expected v1 before success, observed ${observed.raw}`);
    configUnchanged('restore-v1-before-success', fixtureConfig);
    return {
      version: observed.version,
      isolatedPrefixReset: true,
      configPreserved: true,
    };
  });

  await runStage('upgrade-v1-to-v2', async () => {
    const beforeConfig = readFileSync(configPath, 'utf8');
    const result = await runUpgrade();
    await requireSuccess(result.result, 'zterm upgrade v1 to v2');
    assert(
      result.output.includes(`CLI 已升级：${CLI_V1} -> ${CLI_V2}`),
      `upgrade output did not expose v1-to-v2 transition: ${result.output.trim()}`,
    );
    const observed = await installedVersion();
    assert(observed.version === CLI_V2, `expected v2, observed ${observed.raw}`);
    configUnchanged('upgrade-v1-to-v2', beforeConfig);
    return {
      beforeVersion: CLI_V1,
      afterVersion: observed.version,
      installationState: 'updated',
      configPreserved: true,
      registryRequests: result.requests.map(
        (entry) => `${entry.kind}:${entry.name}:${entry.version ?? ''}`,
      ),
    };
  });

  await runStage('unchanged-v2', async () => {
    const beforeConfig = readFileSync(configPath, 'utf8');
    const beforeMark = registry.mark();
    const result = await runUpgrade();
    await requireSuccess(result.result, 'zterm upgrade unchanged');
    assert(
      result.output.includes(`CLI 已是版本 ${CLI_V2}`),
      `unchanged output was not explicit: ${result.output.trim()}`,
    );
    const observed = await installedVersion();
    assert(observed.version === CLI_V2, `unchanged entry is not v2: ${observed.raw}`);
    configUnchanged('unchanged-v2', beforeConfig);
    const requests = registry.requestsSince(beforeMark);
    assert(
      !requests.some((entry) => entry.kind === 'tarball' && entry.name === CLI_PACKAGE),
      'unchanged path fetched a CLI tarball',
    );
    return {
      version: observed.version,
      installationState: 'unchanged',
      configPreserved: true,
      registryRequests: requests.map(
        (entry) => `${entry.kind}:${entry.name}:${entry.version ?? ''}`,
      ),
    };
  });

  await runStage('registry-error', async () => {
    const beforeConfig = readFileSync(configPath, 'utf8');
    registry.setMode('registry-error');
    const result = await expectFailureUpgrade(
      'registry-error',
      CLI_V2,
      beforeConfig,
    );
    registry.setMode('normal');
    return {
      ...result,
      injectedFault: 'HTTP 503 for CLI metadata query',
    };
  });

  log(`PASS ${stages.length} stages`);
}

try {
  await main();
} catch (error) {
  failure = messageOf(error);
  log(`FAIL ${failure}`);
  process.exitCode = 1;
} finally {
  log('cleanup registry started');
  if (registry) {
    try {
      await registry.close();
    } catch (error) {
      const detail = `registry cleanup failed: ${messageOf(error)}`;
      appendEvidence(detail);
      log(detail);
      failure = [failure, detail].filter(Boolean).join('; ');
      process.exitCode = 1;
    }
  }
  log('cleanup registry finished');
  log(`cleanup child processes started count=${activeChildren.size}`);
  for (const child of [...activeChildren]) {
    if (child.exitCode === null && child.signalCode === null) {
      signalChildTree(child, 'SIGTERM');
    }
  }
  const cleanupDeadline = Date.now() + 5_000;
  while (activeChildren.size > 0 && Date.now() < cleanupDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  log(`cleanup child processes finished remaining=${activeChildren.size}`);
  if (activeChildren.size > 0) {
    failure = [failure, 'owned child cleanup did not finish'].filter(Boolean).join('; ');
    process.exitCode = 1;
  }
  log('cleanup temporary root started');
  rmSync(testRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
  tempRootRemoved = !existsSync(testRoot);
  log(`cleanup temporary root finished removed=${tempRootRemoved}`);
  log('cleanup run note started');
  await writeRunNote();
  log('cleanup run note finished');
}
