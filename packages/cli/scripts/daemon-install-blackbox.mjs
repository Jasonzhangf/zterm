#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  createReadStream,
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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DAEMON_PACKAGE_NAMES,
  discoverDaemonPackages,
  localTarArguments,
  parseDaemonInstallBlackboxArgs,
  readPackageManifest,
  readTarballPackageJson,
  redactText,
  sanitizeEvidence,
  targetDaemonPayloadName,
} from './daemon-install-blackbox-helper.mjs';
import {
  formalCliInvocation,
  installedCliBin,
} from './platform-smoke-helper.mjs';
import { resolveNpmInvocation } from './process-entry.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(scriptDir, '..');
const cliManifestPath = join(cliDir, 'package.json');
const HOST = '127.0.0.1';
const PUBLIC_DAEMON_PACKAGE = DAEMON_PACKAGE_NAMES[0];
const CONFIG_SECRETS = {
  auth: 'blackbox-auth-token-4f81c0',
  daemon: 'blackbox-daemon-token-772a4d',
  slot: 'blackbox-slot-token-79c873',
};
const activeChildren = new Set();

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function now() {
  return new Date().toISOString();
}

function makeDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function truncate(text, limit = 256 * 1024) {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[TRUNCATED ${text.length - limit} CHARACTERS]`;
}

function commandSummary(command, args) {
  return JSON.stringify({ command, args });
}

function collectEnvironmentSecrets(env = process.env) {
  const secrets = new Set(Object.values(CONFIG_SECRETS));
  for (const [key, value] of Object.entries(env)) {
    if (
      value
      && value.length >= 8
      && /(?:password|passwd|token|secret|auth|cookie)/iu.test(key)
    ) {
      secrets.add(value);
    }
  }
  return [...secrets];
}

function isolatedEnvironment(testRoot, prefix, cache, userConfig, registryUrl) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      /^(?:npm_config_|NPM_CONFIG_)/u.test(key)
      || /^(?:TMUX|TMUX_PANE|TMUX_TMPDIR|ZTERM)$/u.test(key)
      || key.startsWith('ZTERM_')
    ) {
      continue;
    }
    env[key] = value;
  }
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const systemPath = process.platform === 'win32'
    ? [
        dirname(process.execPath),
        join(env.SystemRoot || 'C:\\Windows', 'System32'),
        join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
      ].filter(Boolean).join(pathSeparator)
    : [
        dirname(process.execPath),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(Boolean).join(pathSeparator);
  return {
    ...env,
    HOME: join(testRoot, 'home'),
    USERPROFILE: join(testRoot, 'home'),
    npm_config_prefix: prefix,
    NPM_CONFIG_PREFIX: prefix,
    npm_config_cache: cache,
    NPM_CONFIG_CACHE: cache,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_registry: registryUrl ?? '',
    NPM_CONFIG_REGISTRY: registryUrl ?? '',
    npm_config_audit: 'false',
    NPM_CONFIG_AUDIT: 'false',
    npm_config_fund: 'false',
    NPM_CONFIG_FUND: 'false',
    npm_config_update_notifier: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    npm_config_fetch_retries: '0',
    NPM_CONFIG_FETCH_RETRIES: '0',
    PATH: `${process.platform === 'win32' ? prefix : join(prefix, 'bin')}${pathSeparator}${systemPath}`,
  };
}

function terminateChild(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // The child may not have formed a process group.
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // The process may already be gone.
  }
}

function runProcess(command, args, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolveResult) => {
    const state = {
      command,
      args: [...args],
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: undefined,
    };
    let settled = false;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolveResult({
        ...state,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout: truncate(state.stdout),
        stderr: truncate(state.stderr),
      });
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      state.stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      state.stderr += chunk;
    });
    child.once('error', (error) => {
      state.error = { code: error.code || 'spawn_error', message: error.message };
    });
    child.once('close', finish);
    const timer = setTimeout(() => {
      state.timedOut = true;
      terminateChild(child);
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child may already be gone.
          }
        }
      }, 2_000).unref();
    }, options.timeoutMs ?? 180_000);
    timer.unref();
  });
}

function requireSuccess(result, label) {
  if (result.error) {
    throw new Error(`${label} spawn error: ${result.error.message}`);
  }
  if (result.timedOut) {
    throw new Error(`${label} timed out`);
  }
  if (result.exitCode !== 0 || result.signal) {
    throw new Error(
      `${label} exited ${String(result.exitCode)}${
        result.signal ? ` by ${result.signal}` : ''
      }: ${result.stderr.trim() || result.stdout.trim() || 'no process output'}`,
    );
  }
  return result;
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

function requestName(pathname, knownNames) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname).replace(/^\/+/u, '');
  } catch {
    return undefined;
  }
  return [...knownNames]
    .sort((left, right) => right.length - left.length)
    .find((name) => decoded === name || decoded.startsWith(`${name}/`));
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

class LocalRegistry {
  constructor() {
    this.packages = new Map();
    this.requests = [];
    this.url = '';
    this.failMetadata = new Set();
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start() {
    await new Promise((resolveStart, rejectStart) => {
      this.server.once('error', rejectStart);
      this.server.listen(0, HOST, () => {
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          rejectStart(new Error('local npm registry did not get an ephemeral port'));
          return;
        }
        this.url = `http://${HOST}:${address.port}/`;
        resolveStart();
      });
    });
    return this.url;
  }

  addPackage(record) {
    if (!this.packages.has(record.name)) this.packages.set(record.name, new Map());
    this.packages.get(record.name).set(record.version, {
      ...record,
    });
  }

  setMetadataFailure(name) {
    this.failMetadata = new Set(name ? [name] : []);
  }

  packument(name) {
    const versions = this.packages.get(name);
    assert(versions, `unknown registry package: ${name}`);
    const renderedVersions = {};
    for (const [version, record] of versions) {
      renderedVersions[version] = {
        ...record.manifest,
        dist: {
          tarball: `${this.url}tarball/${encodeURIComponent(name)}/${
            encodeURIComponent(basename(record.tarballPath))
          }`,
        },
      };
    }
    return {
      name,
      'dist-tags': {
        latest: [...versions.keys()].sort().at(-1),
      },
      versions: renderedVersions,
    };
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', this.url || `http://${HOST}`);
    const tarball = splitTarballPath(url.pathname);
    const knownNames = [...this.packages.keys()];
    const name = tarball?.name ?? requestName(url.pathname, knownNames);
    this.requests.push({
      method: request.method,
      path: url.pathname,
      name,
      kind: tarball ? 'tarball' : 'metadata',
    });
    const logLine = `registry ${request.method} ${url.pathname}`;
    evidenceLog(logLine);

    if (request.method === 'POST') {
      request.resume();
      jsonResponse(response, 200, {});
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      jsonResponse(response, 405, { error: 'method not allowed' });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/-/ping') {
      jsonResponse(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/-/npm/v1/security/advisories/bulk') {
      jsonResponse(response, 200, {});
      return;
    }
    if (!name) {
      jsonResponse(response, 404, { error: 'not found' });
      return;
    }
    if (tarball) {
      const versions = this.packages.get(name);
      const record = [...(versions?.values() ?? [])].find(
        (candidate) => basename(candidate.tarballPath) === tarball.filename,
      );
      if (!record) {
        jsonResponse(response, 404, { error: 'tarball not found' });
        return;
      }
      const size = statSync(record.tarballPath).size;
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': size,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': size,
        'cache-control': 'no-store',
      });
      const stream = createReadStream(record.tarballPath);
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
    if (this.failMetadata.has(name)) {
      jsonResponse(response, 503, { error: `injected metadata failure for ${name}` });
      return;
    }
    if (!this.packages.has(name)) {
      jsonResponse(response, 404, { error: `unknown package: ${name}` });
      return;
    }
    jsonResponse(response, 200, this.packument(name));
  }

  async close() {
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

let activeEvidence;
let evidenceSecrets = collectEnvironmentSecrets();

function evidenceLog(message) {
  if (!activeEvidence) return;
  makeDirectory(dirname(activeEvidence));
  writeFileSync(
    activeEvidence,
    `[${now()}] ${redactText(message, evidenceSecrets)}\n`,
    { flag: 'a', mode: 0o600 },
  );
}

function npmProjectEnvironment(testRoot, prefix, cache, userConfig, registryUrl) {
  return isolatedEnvironment(testRoot, prefix, cache, userConfig, registryUrl);
}

async function runNpm(args, options) {
  const invocation = resolveNpmInvocation(args, {
    npmCommand: process.env.NPM_COMMAND || 'npm',
    env: options.env,
  });
  evidenceLog(`spawn ${commandSummary(invocation.command, invocation.args)}`);
  return runProcess(invocation.command, invocation.args, options);
}

function parsePackFilename(result) {
  requireSuccess(result, 'npm pack');
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${messageOf(error)}`);
  }
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  assert(record && typeof record.filename === 'string', 'npm pack JSON is missing filename');
  return record.filename;
}

function dependencyManifestPath(packageName, parentManifestPath) {
  const parentRequire = createRequire(parentManifestPath);
  try {
    return realpathSync(parentRequire.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

function collectDependencyManifests(rootManifestPath) {
  const manifests = new Map();
  const pending = [rootManifestPath];
  while (pending.length > 0) {
    const manifestPath = pending.pop();
    const manifest = readPackageManifest(manifestPath);
    if (
      typeof manifest.name !== 'string'
      || typeof manifest.version !== 'string'
    ) {
      continue;
    }
    const key = `${manifest.name}@${manifest.version}`;
    if (manifests.has(key)) continue;
    manifests.set(key, manifestPath);
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    for (const name of new Set([...required, ...optional])) {
      const dependencyPath = dependencyManifestPath(name, manifestPath);
      if (dependencyPath) {
        pending.push(dependencyPath);
      } else if (required.includes(name)) {
        throw new Error(`required CLI dependency is not installed: ${name}`);
      }
    }
  }
  return [...manifests.values()];
}

async function buildCliDependencyRecords(context) {
  const records = [];
  const packedRoot = join(context.root, 'cli-dependencies');
  makeDirectory(packedRoot);
  for (const manifestPath of collectDependencyManifests(cliManifestPath)) {
    if (manifestPath === cliManifestPath) continue;
    const manifest = readPackageManifest(manifestPath);
    const destination = join(packedRoot, `${records.length}`);
    makeDirectory(destination);
    const result = await runNpm([
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      destination,
      '--registry',
      'https://registry.npmjs.org',
      `${manifest.name}@${manifest.version}`,
    ], {
      cwd: context.root,
      env: npmProjectEnvironment(
        context.root,
        context.prefix,
        context.cache,
        context.userConfig,
        undefined,
      ),
      timeoutMs: 120_000,
    });
    const filename = parsePackFilename(result);
    records.push({
      name: manifest.name,
      version: manifest.version,
      manifest,
      tarballPath: join(destination, filename),
    });
  }
  return records;
}

function createScenario(baseRoot, name) {
  const root = join(baseRoot, name);
  const scenario = {
    name,
    root,
    home: join(root, 'home'),
    prefix: join(root, 'npm-global'),
    cliPrefix: join(root, 'cli-global'),
    cache: join(root, 'npm-cache'),
    userConfig: join(root, 'npmrc'),
    outside: join(root, 'outside-source'),
  };
  for (const directory of [
    scenario.home,
    scenario.prefix,
    scenario.cliPrefix,
    scenario.cache,
    scenario.outside,
  ]) {
    makeDirectory(directory);
  }
  writeFileSync(scenario.userConfig, '', { mode: 0o600 });
  return scenario;
}

function writePrivateConfig(scenario) {
  const path = join(scenario.home, '.zterm', 'config.json');
  const body = `${JSON.stringify({
    auth: {
      accessToken: CONFIG_SECRETS.auth,
      keep: 'private-auth-unknown',
    },
    slots: {
      '1': {
        token: CONFIG_SECRETS.slot,
        keep: 'private-slot-unknown',
      },
    },
    zterm: {
      android: {
        daemon: {
          host: HOST,
          port: 3333,
          authToken: CONFIG_SECRETS.daemon,
          sessionName: 'daemon-blackbox',
          terminalCacheLines: 3210,
        },
      },
    },
    daemon: {
      keep: 'private-daemon-unknown',
      unknown: { nested: [1, 2, 3] },
    },
    unknown: {
      byteSensitive: '  keep spacing and ordering  ',
      list: ['a', 'b'],
    },
  }, null, 2)}\n`;
  makeDirectory(dirname(path));
  writeFileSync(path, body, { mode: 0o600 });
  return { path, body };
}

function scenarioEnvironment(scenario, registryUrl, prefix = scenario.prefix) {
  return npmProjectEnvironment(
    scenario.root,
    prefix,
    scenario.cache,
    scenario.userConfig,
    registryUrl,
  );
}

async function installCli(scenario, registry, cliTarball) {
  const result = await runNpm([
    'install',
    '--global',
    '--prefix',
    scenario.cliPrefix,
    cliTarball,
    '--registry',
    registry.url,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
  ], {
    cwd: scenario.outside,
    env: scenarioEnvironment(scenario, registry.url, scenario.cliPrefix),
    timeoutMs: 180_000,
  });
  requireSuccess(result, 'global install of CLI tarball');
  assert(
    existsSync(installedCliBin(scenario.cliPrefix)),
    `installed CLI entry is missing: ${installedCliBin(scenario.cliPrefix)}`,
  );
}

async function runInstalledCli(scenario, registry, args) {
  const invocation = formalCliInvocation(
    installedCliBin(scenario.cliPrefix),
    args,
  );
  evidenceLog(`spawn ${commandSummary(invocation.command, invocation.args)}`);
  return runProcess(invocation.command, invocation.args, {
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    cwd: scenario.outside,
    env: scenarioEnvironment(scenario, registry.url),
    timeoutMs: 180_000,
  });
}

function daemonPrefixPackageRoot(prefix) {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', '@jsonstudio', 'zterm-daemon')
    : join(prefix, 'lib', 'node_modules', '@jsonstudio', 'zterm-daemon');
}

function daemonPrefixPayloadRoot(prefix) {
  const publicRoot = daemonPrefixPackageRoot(prefix);
  const resolver = createRequire(join(publicRoot, 'package.json'));
  try {
    return dirname(resolver.resolve(`${targetDaemonPayloadName()}/package.json`));
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

function stageSnapshot(scenario) {
  const stagingRoot = join(scenario.home, '.zterm', 'staging');
  const directories = existsSync(stagingRoot)
    ? readdirSync(stagingRoot)
      .map((name) => join(stagingRoot, name))
      .filter((path) => statSync(path).isDirectory())
    : [];
  const targetPayloadName = targetDaemonPayloadName();
  return {
    visible: directories.length > 0,
    directoryCount: directories.length,
    publicPackagePresent: directories.some((path) => existsSync(
      join(path, 'node_modules', '@jsonstudio', 'zterm-daemon', 'package.json'),
    )),
    targetPayloadPresent: directories.some((path) => existsSync(
      join(path, 'node_modules', ...targetPayloadName.split('/'), 'package.json'),
    )),
  };
}

function installedSnapshot(scenario) {
  const packageRoot = daemonPrefixPackageRoot(scenario.prefix);
  const publicPackagePresent = existsSync(join(packageRoot, 'package.json'));
  const payloadRoot = publicPackagePresent ? daemonPrefixPayloadRoot(scenario.prefix) : undefined;
  return {
    publicPackagePresent,
    payloadPresent: payloadRoot !== undefined && existsSync(join(payloadRoot, 'zterm-package.json')),
    entryPresent: existsSync(
      process.platform === 'win32'
        ? join(scenario.prefix, 'zterm-daemon.cmd')
        : join(scenario.prefix, 'bin', 'zterm-daemon'),
    ),
  };
}

function parseState(output) {
  const match = output.match(/(?:^|\n)\s*state\s*=\s*([^\n]+)/iu);
  return match?.[1].trim();
}

async function readServiceSnapshot() {
  if (process.platform === 'darwin') {
    const label = 'com.zterm.android.zterm-daemon';
    const result = await runProcess(
      'launchctl',
      ['print', `gui/${process.getuid?.() ?? ''}/${label}`],
      { env: process.env, timeoutMs: 15_000 },
    );
    return {
      available: !result.error,
      state: parseState(result.stdout) ?? 'absent',
    };
  }
  if (process.platform === 'linux') {
    const result = await runProcess(
      'systemctl',
      ['--user', 'is-active', 'zterm-daemon'],
      { env: process.env, timeoutMs: 15_000 },
    );
    return {
      available: !result.error,
      state: result.stdout.trim() || (result.exitCode === 0 ? 'active' : 'absent'),
    };
  }
  const script = [
    "$task = Get-ScheduledTask -TaskName 'ZTermDaemon' -ErrorAction SilentlyContinue",
    'if ($null -eq $task) { Write-Output missing } else { Write-Output $task.State }',
  ].join('; ');
  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: process.env, timeoutMs: 20_000 },
  );
  return {
    available: !result.error && result.exitCode === 0,
    state: result.stdout.trim() || 'unknown',
  };
}

function createNativeProbe(path) {
  const source = `'use strict';
const { createRequire } = require('node:module');
const { join } = require('node:path');

const payloadRoot = process.argv[2];
const platform = process.argv[3];
const payloadRequire = createRequire(join(payloadRoot, 'runtime', 'server.cjs'));

async function main() {
  const dagpipe = payloadRequire(join(payloadRoot, 'runtime', 'dagpipe.node'));
  for (const name of [
    'compileAllDagpipePhases',
    'runPhase2DaemonConnection',
    'runPhase7Release',
  ]) {
    if (typeof dagpipe[name] !== 'function') {
      throw new Error('DAGpipe export is missing: ' + name);
    }
  }

  const pty = payloadRequire('node-pty');
  const shell = platform === 'win32' ? process.env.ComSpec : '/bin/sh';
  const args = platform === 'win32'
    ? ['/D', '/Q', '/C', 'echo node-pty-probe']
    : ['-c', 'printf node-pty-probe'];
  const terminal = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: payloadRoot,
    env: process.env,
  });
  let ptyOutput = '';
  const ptyExited = new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      terminal.kill();
      rejectExit(new Error('node-pty probe timed out'));
    }, 15000);
    terminal.onData((data) => {
      ptyOutput += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !ptyOutput.includes('node-pty-probe')) {
        rejectExit(new Error('node-pty probe failed: exit=' + exitCode));
        return;
      }
      resolveExit();
    });
  });
  await ptyExited;

  const wrtc = payloadRequire('@roamhq/wrtc');
  if (typeof wrtc.RTCPeerConnection !== 'function') {
    throw new Error('wrtc has no RTCPeerConnection');
  }
  const peer = new wrtc.RTCPeerConnection();
  peer.close();

  process.stdout.write(JSON.stringify({
    dagpipeExports: [
      'compileAllDagpipePhases',
      'runPhase2DaemonConnection',
      'runPhase7Release',
    ],
    nodePtyStarted: true,
    wrtcPeerCreated: true,
  }));
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});
`;
  writeFileSync(path, source, { mode: 0o600 });
}

async function runNativeProbe(scenario) {
  const payloadRoot = daemonPrefixPayloadRoot(scenario.prefix);
  assert(payloadRoot !== undefined, 'installed native payload cannot be resolved');
  const probePath = join(scenario.root, 'native-probe.cjs');
  createNativeProbe(probePath);
  const result = await runProcess(
    process.execPath,
    [probePath, payloadRoot, process.platform],
    {
      cwd: scenario.outside,
      env: scenarioEnvironment(scenario, undefined),
      timeoutMs: 60_000,
    },
  );
  requireSuccess(result, 'installed payload native probe');
  return JSON.parse(result.stdout);
}

async function createDamagedPayloadTarball(record, kind, context) {
  const directory = join(context.root, `damaged-${kind}`);
  const extracted = join(directory, 'extracted');
  const packed = join(directory, 'packed');
  makeDirectory(extracted);
  makeDirectory(packed);
  requireSuccess(await runProcess(
    'tar',
    localTarArguments(['-xzf', record.tarballPath, '-C', extracted]),
    { cwd: directory, env: process.env, timeoutMs: 120_000 },
  ), `extract ${kind} payload`);
  const packageRoot = join(extracted, 'package');
  const dagpipePath = join(packageRoot, 'runtime', 'dagpipe.node');
  if (kind === 'missing-component') {
    rmSync(dagpipePath, { force: true });
  } else if (kind === 'wrong-native') {
    writeFileSync(dagpipePath, 'not a node native addon\n', { mode: 0o644 });
  } else {
    throw new Error(`unknown payload damage: ${kind}`);
  }
  const result = await runNpm([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packed,
    packageRoot,
  ], {
    cwd: context.root,
    env: scenarioEnvironment(context, undefined),
    timeoutMs: 120_000,
  });
  const filename = parsePackFilename(result);
  return { ...record, tarballPath: join(packed, filename) };
}

function recordsWithReplacement(daemonRecords, replacement) {
  return daemonRecords.map((record) => (
    record.name === replacement.name ? replacement : record
  ));
}

async function runDaemonInstallStage(scenario, registry, version) {
  return runInstalledCli(scenario, registry, [
    'daemon',
    'install',
    '--version',
    version,
    '--registry',
    registry.url,
  ]);
}

async function withScenario(baseRoot, name, records, callback) {
  const scenario = createScenario(baseRoot, name);
  const registry = new LocalRegistry();
  for (const record of records) registry.addPackage(record);
  await registry.start();
  try {
    return await callback(scenario, registry);
  } finally {
    await registry.close();
  }
}

async function runPositiveStage(options, daemon, dependencyRecords, baseRoot) {
  return withScenario(
    baseRoot,
    'positive',
    [...daemon.packages, ...dependencyRecords],
    async (scenario, registry) => {
      const config = writePrivateConfig(scenario);
      evidenceSecrets = [...new Set([
        ...evidenceSecrets,
        CONFIG_SECRETS.auth,
        CONFIG_SECRETS.daemon,
        CONFIG_SECRETS.slot,
      ])];
      const serviceBefore = await readServiceSnapshot();
      await installCli(scenario, registry, options.cliTarball);
      const install = await runDaemonInstallStage(scenario, registry, daemon.version);
      requireSuccess(install, 'zterm daemon install');
      const serviceAfter = await readServiceSnapshot();
      const serviceObserved = serviceBefore.available && serviceAfter.available;
      assert(
        JSON.stringify(serviceBefore) === JSON.stringify(serviceAfter),
        'daemon install changed the pre-existing user service state',
      );

      const stage = stageSnapshot(scenario);
      const installed = installedSnapshot(scenario);
      assert(stage.visible, 'successful installer left no visible stage');
      assert(installed.publicPackagePresent, 'installed public daemon package is missing');
      assert(installed.payloadPresent, 'installed target payload is missing');
      assert(installed.entryPresent, 'installed daemon entry is missing');

      const native = await runNativeProbe(scenario);
      const status = await runInstalledCli(scenario, registry, ['daemon', 'status']);
      const configResult = await runInstalledCli(scenario, registry, ['daemon', 'config']);
      const configAfter = readFileSync(config.path, 'utf8');
      assert(configAfter === config.body, 'shared config bytes changed');
      assert(configResult.exitCode === 0, 'daemon config command failed');
      for (const secret of Object.values(CONFIG_SECRETS)) {
        assert(
          !`${status.stdout}\n${status.stderr}\n${configResult.stdout}\n${configResult.stderr}`
            .includes(secret),
          'daemon command output exposed a private config value',
        );
      }
      assert(
        !/\b(?:daemon|service)\s+(?:started|running)\b/iu.test(
          `${install.stdout}\n${install.stderr}`,
        ),
        'daemon install output incorrectly reported a daemon/service start',
      );
      return {
        status: 'passed',
        version: daemon.version,
        targetPayload: targetDaemonPayloadName(),
        stage,
        installed,
        native,
        configBytesPreserved: true,
        configOutputRedacted: true,
        serviceStateUnchanged: serviceObserved,
        statusCommand: {
          exitCode: status.exitCode,
          signal: status.signal,
          stdout: status.stdout.trim(),
          stderr: status.stderr.trim(),
        },
        configCommand: {
          exitCode: configResult.exitCode,
          signal: configResult.signal,
          stdout: configResult.stdout.trim(),
          stderr: configResult.stderr.trim(),
        },
      };
    },
  );
}

async function runNegativeStage({
  baseRoot,
  name,
  daemon,
  dependencyRecords,
  records,
  registryFailure,
  expectedError,
  cliTarball,
}) {
  return withScenario(
    baseRoot,
    name,
    [...(records ?? daemon.packages), ...dependencyRecords],
    async (scenario, registry) => {
      const config = writePrivateConfig(scenario);
      const serviceBefore = await readServiceSnapshot();
      await installCli(scenario, registry, cliTarball);
      if (registryFailure) registry.setMetadataFailure(registryFailure);
      const install = await runDaemonInstallStage(scenario, registry, daemon.version);
      const serviceAfter = await readServiceSnapshot();
      const serviceObserved = serviceBefore.available && serviceAfter.available;
      const stage = stageSnapshot(scenario);
      const installed = installedSnapshot(scenario);
      const output = `${install.stdout}\n${install.stderr}`;
      assert(
        install.exitCode !== 0 || install.signal || install.error,
        `${name} unexpectedly succeeded`,
      );
      assert(stage.visible, `${name} did not leave an observable installer stage`);
      assert(!installed.entryPresent, `${name} unexpectedly published a daemon entry`);
      assert(
        JSON.stringify(serviceBefore) === JSON.stringify(serviceAfter),
        `${name} changed the pre-existing user service state`,
      );
      assert(
        readFileSync(config.path, 'utf8') === config.body,
        `${name} changed shared config bytes`,
      );
      assert(
        new RegExp(expectedError, 'iu').test(output),
        `${name} did not expose the expected error: ${expectedError}`,
      );
      if (registryFailure) {
        assert(
          registry.requests.some(
            (request) => request.kind === 'metadata'
              && request.name === registryFailure,
          ),
          `${name} did not request the failing registry metadata`,
        );
      }
      return {
        status: 'passed',
        exitCode: install.exitCode,
        signal: install.signal,
        expectedErrorVisible: true,
        stage,
        globalEntryPublished: false,
        configBytesPreserved: true,
        serviceStateUnchanged: serviceObserved,
      };
    },
  );
}

function readInputCliManifest(cliTarball) {
  const result = readTarballPackageJson(cliTarball);
  assert(
    result?.name === '@jsonstudio/zterm-cli',
    `CLI tarball must contain @jsonstudio/zterm-cli, found ${String(result?.name)}`,
  );
  assert(typeof result.version === 'string', 'CLI tarball has no version');
  return result;
}

async function main() {
  const options = parseDaemonInstallBlackboxArgs(process.argv.slice(2));
  assert(existsSync(options.cliTarball), `CLI tarball does not exist: ${options.cliTarball}`);
  const cliManifest = readInputCliManifest(options.cliTarball);
  const daemon = discoverDaemonPackages(options.packagesDir);
  makeDirectory(options.evidenceDir);
  activeEvidence = join(options.evidenceDir, 'daemon-install-blackbox-run.log');
  rmSync(activeEvidence, { force: true });
  const baseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'zterm-daemon-install-blackbox-')));
  const context = {
    root: baseRoot,
    prefix: join(baseRoot, 'dependency-prefix'),
    cache: join(baseRoot, 'dependency-cache'),
    userConfig: join(baseRoot, 'dependency-npmrc'),
  };
  makeDirectory(context.prefix);
  makeDirectory(context.cache);
  writeFileSync(context.userConfig, '', { mode: 0o600 });
  const summary = {
    schemaVersion: 1,
    startedAt: now(),
    finishedAt: undefined,
    status: 'failed',
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      nodeAbi: process.versions.modules,
    },
    inputs: {
      daemonVersion: daemon.version,
      daemonPackages: daemon.packages.map((record) => record.name),
      cliPackage: '@jsonstudio/zterm-cli',
      cliVersion: cliManifest.version,
      cliTarballProvided: true,
    },
    stages: {},
    cleanup: { temporaryRootRemoved: false },
  };
  let failure;
  try {
    assert(
      daemon.targetPayload.name === targetDaemonPayloadName(),
      `target payload mismatch: ${daemon.targetPayload.name}`,
    );
    const dependencyRecords = await buildCliDependencyRecords(context);
    summary.inputs.cliDependencyPackageCount = dependencyRecords.length;
    summary.stages.positive = await runPositiveStage(
      options,
      daemon,
      dependencyRecords,
      baseRoot,
    );

    summary.stages['registry-error'] = await runNegativeStage({
      baseRoot,
      name: 'registry-error',
      daemon,
      dependencyRecords,
      registryFailure: PUBLIC_DAEMON_PACKAGE,
      expectedError: '503|injected metadata failure',
      cliTarball: options.cliTarball,
    });

    const missingPayload = await createDamagedPayloadTarball(
      daemon.targetPayload,
      'missing-component',
      context,
    );
    summary.stages['missing-component'] = await runNegativeStage({
      baseRoot,
      name: 'missing-component',
      daemon,
      dependencyRecords,
      records: recordsWithReplacement(daemon.packages, missingPayload),
      expectedError: 'missing required component',
      cliTarball: options.cliTarball,
    });

    const wrongPayload = await createDamagedPayloadTarball(
      daemon.targetPayload,
      'wrong-native',
      context,
    );
    summary.stages['wrong-native'] = await runNegativeStage({
      baseRoot,
      name: 'wrong-native',
      daemon,
      dependencyRecords,
      records: recordsWithReplacement(daemon.packages, wrongPayload),
      expectedError: 'daemon native components failed to load',
      cliTarball: options.cliTarball,
    });
    summary.status = 'passed';
  } catch (error) {
    failure = error;
    summary.error = messageOf(error);
  } finally {
    for (const child of activeChildren) terminateChild(child);
    try {
      rmSync(baseRoot, { recursive: true, force: true });
    } catch (error) {
      summary.cleanup.error = messageOf(error);
    }
    summary.cleanup.temporaryRootRemoved = !existsSync(baseRoot);
    summary.finishedAt = now();
    if (!summary.cleanup.temporaryRootRemoved) {
      summary.status = 'failed';
      summary.error = [summary.error, 'temporary blackbox root was not removed']
        .filter(Boolean)
        .join('; ');
    }
    const sanitized = sanitizeEvidence(summary, evidenceSecrets);
    const resultPath = join(options.evidenceDir, 'daemon-install-blackbox-result.json');
    rmSync(resultPath, { force: true });
    writeFileSync(
      resultPath,
      `${JSON.stringify(sanitized, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
  }
  if (failure || summary.status !== 'passed') process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${redactText(messageOf(error), evidenceSecrets)}\n`);
  process.exitCode = 1;
}
