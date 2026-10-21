import { spawnSync } from 'node:child_process';
import { createServer as createTcpServer, isIP } from 'node:net';
import { createSocket as createUdpSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const RTC_FIXTURE_KIND = 'zterm-rtc-fixture';
export const RTC_FIXTURE_SCHEMA_VERSION = 1;

export function selectFixturePublishedIpv4(response, requestedAddress) {
  const answers = response?.Answer;
  const addresses = Array.isArray(answers)
    ? answers
      .filter(answer => answer?.type === 1 && typeof answer?.data === 'string')
      .map(answer => answer.data)
    : [];
  if (addresses.length === 0) {
    throw new Error('public fixture DNS lookup returned no IPv4 address');
  }
  if (requestedAddress === undefined) return addresses[0];
  const requested = typeof requestedAddress === 'string' ? requestedAddress.trim() : '';
  if (isIP(requested) !== 4) {
    throw new Error('ZTERM_FIXTURE_DNS_ADDRESS must be a valid IPv4 address');
  }
  if (!addresses.includes(requested)) {
    throw new Error('public fixture DNS lookup did not publish the requested IPv4 address');
  }
  return requested;
}

export function fixtureRunPaths(evidenceDir, runId) {
  const normalizedEvidenceDir = resolve(evidenceDir);
  const runDir = join(normalizedEvidenceDir, 'rtc-fixture-runs', runId);
  const privateDir = join(runDir, 'private');
  const publicDir = join(runDir, 'public');
  return {
    runDir,
    privateDir,
    publicDir,
    receiptPath: join(privateDir, 'receipt.json'),
    publicReceiptPath: join(publicDir, 'receipt.json'),
    runtimeRoot: join(tmpdir(), 'zterm-rtc-fixture', runId, 'runtime'),
    tmuxSocketPath: join(tmpdir(), `zterm-rtc-${runId}.sock`),
  };
}

export function parseRtcFixtureArgs(argv) {
  const options = {
    evidenceDir: resolve('rtc-fixture-evidence'),
    hold: false,
    interactiveSession: false,
    exposeRelay: false,
    publicTurnBridge: false,
    turnRequired: false,
    nativePath: undefined,
    cleanupPrivateReceipt: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--evidence-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--evidence-dir requires a value');
      options.evidenceDir = resolve(value);
      continue;
    }
    if (arg === '--native-path') {
      const value = argv[++index];
      if (!value) throw new Error('--native-path requires a value');
      options.nativePath = resolve(value);
      continue;
    }
    if (arg === '--cleanup-private-receipt') {
      const value = argv[++index];
      if (!value) throw new Error('--cleanup-private-receipt requires a value');
      options.cleanupPrivateReceipt = resolve(value);
      continue;
    }
    if (arg === '--hold') {
      options.hold = true;
      continue;
    }
    if (arg === '--interactive-session') {
      options.interactiveSession = true;
      continue;
    }
    if (arg === '--expose-relay') {
      options.exposeRelay = true;
      continue;
    }
    if (arg === '--public-turn-bridge') {
      options.publicTurnBridge = true;
      options.exposeRelay = true;
      options.turnRequired = true;
      continue;
    }
    if (arg === '--turn-required') {
      options.turnRequired = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`unknown rtc fixture argument: ${arg}`);
  }

  if (
    options.cleanupPrivateReceipt
    && (
      options.hold
      || options.interactiveSession
      || options.exposeRelay
      || options.turnRequired
      || options.nativePath
    )
  ) {
    throw new Error('--cleanup-private-receipt cannot be combined with fixture startup arguments');
  }
  return options;
}

export function rtcFixtureTmuxStartCommand(marker, options = {}) {
  if (options.interactiveSession === true) {
    return `/bin/sh -c 'printf "%s\\n" "${marker}"; export PS1="${marker} $"; export ENV= BASH_ENV=; exec /bin/sh -i'`;
  }
  return `sh -lc 'printf '%s\\n' '${marker}'; exec cat'`;
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function writePrivateReceipt(path, receipt) {
  assertPrivateReceipt(receipt);
  ensurePrivateDirectory(dirname(path));
  writeJsonAtomically(path, receipt, 0o600);
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new Error(`private receipt mode is not 0600: ${path}`);
  }
  return path;
}

export function writePublicReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomically(path, receipt, 0o644);
  chmodSync(path, 0o644);
  return path;
}

function writeJsonAtomically(path, value, mode) {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode,
  });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, path);
}

export function readPrivateReceipt(path) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) {
    throw new Error(`private receipt missing: ${absolutePath}`);
  }
  if ((statSync(absolutePath).mode & 0o777) !== 0o600) {
    throw new Error(`private receipt must have mode 0600: ${absolutePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`private receipt is not valid JSON: ${errorMessage(error)}`);
  }
  assertPrivateReceipt(parsed);
  return parsed;
}

export async function waitForRtcFixtureHold(path, options = {}) {
  const pollMs = Number.isSafeInteger(options.pollMs) && options.pollMs > 0
    ? options.pollMs
    : 500;
  while (true) {
    const receipt = readPrivateReceipt(path);
    if (
      receipt.state === 'closed'
      || receipt.cleanup?.state === 'complete'
      || receipt.cleanup?.state === 'incomplete'
    ) {
      return receipt;
    }
    await delay(pollMs);
  }
}

export function assertPrivateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('private receipt must be an object');
  }
  if (receipt.schemaVersion !== RTC_FIXTURE_SCHEMA_VERSION) {
    throw new Error(`private receipt schemaVersion must be ${RTC_FIXTURE_SCHEMA_VERSION}`);
  }
  if (receipt.kind !== RTC_FIXTURE_KIND) {
    throw new Error(`private receipt kind must be ${RTC_FIXTURE_KIND}`);
  }
  if (receipt.managedTest !== true) {
    throw new Error('private receipt must declare managedTest=true');
  }
  if (typeof receipt.runId !== 'string' || !/^[a-z0-9-]+$/u.test(receipt.runId)) {
    throw new Error('private receipt has an invalid runId');
  }
  for (const field of [
    'evidenceDir',
    'runtimeRoot',
    'receiptPath',
    'publicReceiptPath',
    'relayBaseUrl',
    'username',
    'password',
    'deviceId',
    'daemonHostId',
    'sessionName',
  ]) {
    if (typeof receipt[field] !== 'string' || !receipt[field].trim()) {
      throw new Error(`private receipt field ${field} must be a non-empty string`);
    }
  }
  if (receipt.backend !== 'tmux') {
    throw new Error('private receipt backend must be tmux');
  }
  if (!isAbsolute(receipt.evidenceDir) || !isAbsolute(receipt.runtimeRoot) || !isAbsolute(receipt.receiptPath)) {
    throw new Error('private receipt paths must be absolute');
  }
  const expected = fixtureRunPaths(receipt.evidenceDir, receipt.runId);
  if (resolve(receipt.runtimeRoot) !== expected.runtimeRoot) {
    throw new Error('private receipt runtimeRoot does not match its managed run directory');
  }
  if (resolve(receipt.receiptPath) !== expected.receiptPath) {
    throw new Error('private receipt path does not match its managed run directory');
  }
  if (resolve(receipt.publicReceiptPath) !== expected.publicReceiptPath) {
    throw new Error('public receipt path does not match its managed run directory');
  }
  if (typeof receipt.stableId !== 'string') {
    throw new Error('private receipt field stableId must be a string');
  }
  if (receipt.sessionName !== `rtc-fixture-${receipt.runId}`) {
    throw new Error('private receipt sessionName is not owned by runId');
  }
  if (receipt.tmux?.socketPath && resolve(receipt.tmux.socketPath) !== expected.tmuxSocketPath) {
    throw new Error('private receipt tmux socket does not match its managed runtime');
  }
  if (receipt.turn?.containerId && !/^[a-f0-9]{12,64}$/u.test(receipt.turn.containerId)) {
    throw new Error('private receipt contains an invalid coturn container ID');
  }
  if (
    receipt.turn?.containerName
    && receipt.turn.containerName !== `zterm-rtc-fixture-coturn-${receipt.runId}`
  ) {
    throw new Error('private receipt coturn container name is not owned by runId');
  }
  return receipt;
}

export function buildPublicReceipt(receipt) {
  assertPrivateReceipt(receipt);
  const secrets = [
    receipt.username,
    receipt.password,
    receipt.accessToken,
    receipt.daemon?.authToken,
    receipt.turn?.username,
    receipt.turn?.credential,
    receipt.fixtureTransport?.token,
  ];
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    runId: receipt.runId,
    managedTest: true,
    state: receipt.state,
    status: receipt.status,
    ok: receipt.ok === true,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    evidenceDir: receipt.evidenceDir,
    runtimeRoot: receipt.runtimeRoot,
    receipt: {
      privatePath: receipt.receiptPath,
      publicPath: receipt.publicReceiptPath,
      privateMode: '0600',
    },
    relay: {
      baseUrl: receipt.relayBaseUrl,
      publicBaseUrl: receipt.publicRelayBaseUrl || null,
      pid: positivePid(receipt.relay?.pid),
      logPath: receipt.relay?.logPath || null,
    },
    daemon: {
      pid: positivePid(receipt.daemon?.pid),
      hostId: receipt.daemonHostId,
      deviceId: receipt.deviceId,
      endpoint: receipt.daemon?.endpoint || null,
      listener: receipt.daemon?.listener || null,
      backend: 'tmux',
      nativePath: receipt.daemon?.nativePath || null,
    },
    session: {
      name: receipt.sessionName,
      stableId: receipt.stableId || null,
      backend: 'tmux',
      socketPath: receipt.tmux?.socketPath || null,
    },
    fixtureTransport: receipt.fixtureTransport ? {
      kind: receipt.fixtureTransport.kind,
      nativePublicUdpProved: false,
      frontendPid: positivePid(receipt.fixtureFrontend?.pid),
      ready: receipt.fixtureFrontend?.ready === true,
    } : null,
    fixtureDns: receipt.fixtureDns ? {
      hostname: receipt.fixtureDns.hostname,
      address: receipt.fixtureDns.address,
      source: receipt.fixtureDns.source,
    } : null,
    turn: {
      required: receipt.turn?.required === true,
      configured: receipt.turn?.configured === true,
      containerId: receipt.turn?.containerId || null,
      containerName: receipt.turn?.containerName || null,
      listeningPort: receipt.turn?.listeningPort || null,
      relayPortRange: receipt.turn?.relayPortRange || null,
      authConfigPath: receipt.turn?.authConfigPath || null,
    },
    selfcheck: {
      forcedWebrtcMode: true,
      direct: publicRouteResult(receipt.selfcheck?.direct, secrets),
      relay: publicRouteResult(receipt.selfcheck?.relay, secrets),
      tunnelRelay: publicRouteResult(receipt.selfcheck?.tunnelRelay, secrets),
    },
    tunnel: receipt.tunnel
      ? {
          requested: true,
          ready: receipt.tunnel.ready === true,
          url: receipt.tunnel.url || null,
          wsClientUrl: receipt.tunnel.wsClientUrl || null,
          scope: 'http-and-wss-signaling-only',
          provesTurnOrUdp: false,
          pid: positivePid(receipt.tunnel.pid),
          logPath: receipt.tunnel.logPath || null,
        }
      : {
          requested: false,
          ready: false,
          scope: 'not-requested',
          provesTurnOrUdp: false,
        },
    gaps: Array.isArray(receipt.gaps) ? [...receipt.gaps] : [],
    cleanup: {
      state: receipt.cleanup?.state || 'pending',
      completedAt: receipt.cleanup?.completedAt || null,
      command: receipt.cleanup?.command || null,
      resources: receipt.cleanup?.resources || null,
    },
  };
}

function publicRouteResult(route, secrets) {
  if (!route) return null;
  return {
    attempted: route.attempted === true,
    ok: route.ok === true,
    path: route.path || null,
    relayTransport: route.relayTransport || null,
    selectedIcePair: route.selectedIcePair
      ? {
          localCandidateType: route.selectedIcePair.local?.candidateType || null,
          remoteCandidateType: route.selectedIcePair.remote?.candidateType || null,
          localProtocol: route.selectedIcePair.local?.protocol || null,
          remoteProtocol: route.selectedIcePair.remote?.protocol || null,
          roundTripTimeMs: route.selectedIcePair.roundTripTimeMs || null,
        }
      : null,
    muxReady: route.muxReady === true,
    ownedSessionVisible: route.ownedSessionVisible === true,
    error: route.error || null,
    trace: route.trace ? publicRouteTrace(route.trace, secrets) : null,
  };
}

function publicRouteTrace(trace, secrets) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    return null;
  }
  return stripUrlText(sanitizeValue(trace, secrets));
}

function stripUrlText(value) {
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"'`]+/giu, '[url]');
  }
  if (Array.isArray(value)) {
    return value.map(stripUrlText);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, stripUrlText(entry)]),
    );
  }
  return value;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isPathInside(parent, candidate) {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const difference = relative(parentPath, candidatePath);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

export function assertOwnedRuntimePath(receipt, candidate) {
  if (!isPathInside(receipt.runtimeRoot, candidate)) {
    throw new Error(`fixture path escapes runtimeRoot: ${candidate}`);
  }
  return resolve(candidate);
}

export function findAvailableTcpPort(host = '127.0.0.1') {
  return new Promise((resolvePort, rejectPort) => {
    const server = createTcpServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('failed to resolve a TCP port')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

export async function findAvailableUdpPort(host = '127.0.0.1') {
  return await new Promise((resolvePort, rejectPort) => {
    const socket = createUdpSocket('udp4');
    socket.once('error', rejectPort);
    socket.bind(0, host, () => {
      const address = socket.address();
      socket.close(() => {
        if (!address || typeof address === 'string') {
          rejectPort(new Error('failed to resolve a UDP port'));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

export async function findAvailableUdpRange(host = '127.0.0.1', width = 16) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const start = randomInteger(30_000, 60_000 - width - 1);
    if (await udpRangeAvailable(host, start, start + width - 1)) {
      return { min: start, max: start + width - 1 };
    }
  }
  throw new Error('failed to find an available UDP relay range');
}

async function udpRangeAvailable(host, min, max) {
  for (let port = min; port <= max; port += 1) {
    if (!(await udpPortAvailable(host, port))) return false;
  }
  return true;
}

async function udpPortAvailable(host, port) {
  return await new Promise((resolveAvailable) => {
    const socket = createUdpSocket('udp4');
    const settle = (available) => {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // A failed bind may already close the socket.
      }
      resolveAvailable(available);
    };
    socket.once('error', () => settle(false));
    socket.bind(port, host, () => settle(true));
  });
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sanitizeValue(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, secrets)]),
    );
  }
  return value;
}

export function redactText(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readTextTail(path, limit = 12_000) {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  return text.length > limit ? text.slice(-limit) : text;
}

export function extractCloudflaredQuickTunnelUrl(text) {
  const matches = (String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/giu) || [])
    .filter(url => new URL(url).hostname !== 'api.trycloudflare.com');
  return matches.length > 0 ? matches[matches.length - 1].replace(/\/$/u, '') : '';
}

export function removeFileIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function processCommand(pid) {
  if (process.platform === 'win32') {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : '';
  }
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function openPrivateLog(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return openSync(path, 'a', 0o600);
}

export function closeDescriptor(fd) {
  try {
    closeSync(fd);
  } catch {
    // The descriptor may already be closed after a failed spawn.
  }
}

export function fixtureCleanupCommand(scriptPath, receiptPath) {
  return `${quoteShell(process.execPath)} ${quoteShell(scriptPath)} --cleanup-private-receipt ${quoteShell(receiptPath)}`;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
