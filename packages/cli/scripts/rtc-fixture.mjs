#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

import {
  RTC_FIXTURE_KIND,
  RTC_FIXTURE_SCHEMA_VERSION,
  assertPrivateReceipt,
  buildPublicReceipt,
  closeDescriptor,
  ensurePrivateDirectory,
  errorMessage,
  extractCloudflaredQuickTunnelUrl,
  findAvailableTcpPort,
  findAvailableUdpPort,
  findAvailableUdpRange,
  fixtureCleanupCommand,
  fixtureRunPaths,
  isPathInside,
  openPrivateLog,
  parseRtcFixtureArgs,
  processCommand,
  processExists,
  readPrivateReceipt,
  readTextTail,
  redactText,
  removeFileIfPresent,
  waitForRtcFixtureHold,
  writePrivateReceipt,
  writePublicReceipt,
} from './rtc-fixture-helper.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const cliDir = dirname(scriptDir);
const repoRoot = dirname(dirname(cliDir));
const androidDir = join(repoRoot, 'android');
const relayEntry = join(androidDir, 'src', 'traversal-relay', 'server.ts');
const daemonEntry = join(androidDir, 'src', 'server', 'server.ts');
const tmuxWrapper = join(androidDir, 'scripts', 'cli-blackbox-tmux-wrapper.mjs');
const installedDagpipeNative = join(homedir(), '.zterm', 'daemon-runtime', 'dagpipe.node');
const nodeExecutable = process.execPath;
const defaultTimeoutMs = 60_000;

let rtcRuntimePromise = null;

function isoNow() {
  return new Date().toISOString();
}

function token(bytes = 12) {
  return randomBytes(bytes).toString('hex');
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} missing: ${path}`);
  return path;
}

function cleanEnvironment(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined
      || key === 'TMUX'
      || key === 'TMUX_PANE'
      || key === 'TMUX_TMPDIR'
      || key.startsWith('ZTERM_')
    ) {
      continue;
    }
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function executableInPath(name) {
  const pathEntries = String(process.env.PATH || '').split(delimiter);
  for (const directory of pathEntries) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 30_000,
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || 'no output';
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${String(result.status)}: ${detail.trim()}`,
    );
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

async function waitFor(predicate, label, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError}` : ''}`);
}

async function fetchJson(url, init = {}, timeoutMs = 10_000) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`${url} returned invalid JSON: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function spawnLogged(options) {
  const descriptor = openPrivateLog(options.logPath);
  let child;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', descriptor, descriptor],
      shell: false,
      windowsHide: true,
    });
  } finally {
    closeDescriptor(descriptor);
  }
  return {
    label: options.label,
    pid: child.pid,
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    logPath: options.logPath,
    startedAt: isoNow(),
    identityNeedle: options.identityNeedle,
    child,
  };
}

function processRecord(process) {
  return {
    label: process.label,
    pid: process.pid,
    command: process.command,
    args: process.args,
    cwd: process.cwd,
    logPath: process.logPath,
    startedAt: process.startedAt,
    identityNeedle: process.identityNeedle,
  };
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
    });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`process ${child.pid || 'unknown'} exit timeout`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      rejectExit(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function stopLiveProcess(process, timeoutMs = 7_000) {
  const child = process.child;
  if (!child?.pid) return { label: process.label, pid: 0, stopped: true };
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      label: process.label,
      pid: child.pid,
      stopped: true,
      exitCode: child.exitCode,
      signal: child.signalCode,
    };
  }
  child.kill('SIGTERM');
  try {
    const exit = await waitForChildExit(child, timeoutMs);
    return {
      label: process.label,
      pid: child.pid,
      stopped: true,
      exitCode: exit.code,
      signal: exit.signal,
    };
  } catch {
    child.kill('SIGKILL');
    try {
      const exit = await waitForChildExit(child, 3_000);
      return {
        label: process.label,
        pid: child.pid,
        stopped: true,
        exitCode: exit.code,
        signal: exit.signal,
      };
    } catch {
      return { label: process.label, pid: child.pid, stopped: false };
    }
  }
}

async function stopRecordedProcess(record, timeoutMs = 7_000) {
  const pid = positiveInteger(record?.pid);
  if (!pid) return { label: record?.label || 'unknown', pid: 0, stopped: true };
  if (!processExists(pid)) {
    return { label: record.label, pid, stopped: true, alreadyExited: true };
  }
  const command = processCommand(pid);
  const needle = String(record.identityNeedle || record.command || '').trim();
  if (!command || !needle || !command.includes(needle)) {
    return {
      label: record.label,
      pid,
      stopped: false,
      identityMismatch: true,
      observedCommand: command,
    };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { label: record.label, pid, stopped: true, alreadyExited: true };
    }
    return { label: record.label, pid, stopped: false, error: errorMessage(error) };
  }
  try {
    await waitFor(() => !processExists(pid), `${record.label} exit`, timeoutMs, 100);
    return { label: record.label, pid, stopped: true };
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      await waitFor(() => !processExists(pid), `${record.label} forced exit`, 3_000, 100);
      return { label: record.label, pid, stopped: true, forced: true };
    } catch (error) {
      return { label: record.label, pid, stopped: false, error: errorMessage(error) };
    }
  }
}

function runTmux(binary, socketPath, args, env, allowFailure = false) {
  const result = spawnSync(binary, ['-S', socketPath, ...args], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `owned tmux failed: ${result.error?.message || result.stderr || result.stdout || 'no output'}`,
    );
  }
  return result;
}

function dockerInspect(dockerBinary, containerId, format) {
  const result = spawnSync(dockerBinary, ['inspect', '--format', format, containerId], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

async function startCoturn(options, receipt) {
  if (!options.turnRequested) {
    return {
      configured: false,
      error: 'TURN disabled by fixture options',
    };
  }
  const dockerBinary = executableInPath('docker');
  if (!dockerBinary) {
    return { configured: false, error: 'docker executable not found' };
  }
  const image = 'coturn/coturn:latest';
  const imageInspect = spawnSync(dockerBinary, ['image', 'inspect', image], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (imageInspect.error || imageInspect.status !== 0) {
    return { configured: false, error: `Docker image unavailable: ${image}` };
  }

  const listeningPort = await findAvailableUdpPort();
  const relayPortRange = await findAvailableUdpRange();
  const turnUsername = `turn-user-${receipt.runId}`;
  const turnCredential = randomUUID();
  const authConfigPath = join(receipt.runtimeRoot, 'coturn', 'turnserver.conf');
  ensurePrivateDirectory(dirname(authConfigPath));
  writeFileSync(
    authConfigPath,
    [
      `listening-port=${listeningPort}`,
      `min-port=${relayPortRange.min}`,
      `max-port=${relayPortRange.max}`,
      'listening-ip=0.0.0.0',
      'relay-ip=0.0.0.0',
      'external-ip=127.0.0.1/__CONTAINER_IP__',
      'realm=zterm-rtc-fixture',
      'fingerprint',
      'lt-cred-mech',
      'allow-loopback-peers',
      'allowed-peer-ip=127.0.0.1',
      'relay-threads=1',
      `user=${turnUsername}:${turnCredential}`,
      'no-tcp',
      'no-tcp-relay',
      'no-tls',
      'simple-log',
      'verbose',
      'log-file=stdout',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
  chmodSync(authConfigPath, 0o600);

  const containerName = `zterm-rtc-fixture-coturn-${receipt.runId}`;
  const args = [
    'run',
    '--detach',
    '--name',
    containerName,
    '--label',
    `zterm.rtc-fixture.runId=${receipt.runId}`,
    '--entrypoint',
    '/bin/sh',
    '-p',
    `127.0.0.1:${listeningPort}:${listeningPort}/udp`,
    '-p',
    `127.0.0.1:${relayPortRange.min}-${relayPortRange.max}:${relayPortRange.min}-${relayPortRange.max}/udp`,
    '-v',
    `${authConfigPath}:/etc/coturn/turnserver.conf:ro`,
    image,
    '-lc',
    [
      'container_ip=$(hostname -i | awk \'{print $1}\')',
      'sed "s|__CONTAINER_IP__|$container_ip|g" /etc/coturn/turnserver.conf > /tmp/turnserver.conf',
      'exec turnserver -c /tmp/turnserver.conf',
    ].join(' && '),
  ];
  const result = spawnSync(dockerBinary, args, {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `coturn start failed: ${result.error?.message || result.stderr || result.stdout || 'no output'}`,
    );
  }
  const containerId = String(result.stdout || '').trim();
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) {
    throw new Error('docker run did not return a usable coturn container ID');
  }

  try {
    await waitFor(
      () => dockerInspect(dockerBinary, containerId, '{{.State.Running}}') === 'true',
      'coturn container running',
      20_000,
    );
  } catch (error) {
    let cleanupError = '';
    try {
      runChecked(dockerBinary, ['stop', '--time', '1', containerId], { timeoutMs: 20_000 });
      runChecked(dockerBinary, ['rm', containerId], { timeoutMs: 20_000 });
    } catch (cleanupFailure) {
      cleanupError = `; failed to remove failed coturn container: ${errorMessage(cleanupFailure)}`;
    }
    const logs = spawnSync(dockerBinary, ['logs', containerId], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    const detail = String(logs.stderr || logs.stdout || '').trim();
    throw new Error(`${errorMessage(error)}${detail ? `: ${detail}` : ''}${cleanupError}`);
  }

  return {
    configured: true,
    required: options.turnRequired,
    dockerBinary,
    containerId,
    containerName,
    listeningPort,
    relayPortRange,
    authConfigPath,
    url: `turn:127.0.0.1:${listeningPort}?transport=udp`,
    username: turnUsername,
    credential: turnCredential,
  };
}

async function registerAndLogin(relayBaseUrl, username, password) {
  const register = await fetchJson(`${relayBaseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });
  if (register.ok !== true) {
    throw new Error(`relay registration returned ok=${String(register.ok)}`);
  }
  const login = await fetchJson(`${relayBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });
  if (typeof login.accessToken !== 'string' || !login.accessToken) {
    throw new Error('relay login response is missing accessToken');
  }
  if (!login.user || typeof login.user.id !== 'string') {
    throw new Error('relay login response is missing user identity');
  }
  if (!login.ws || typeof login.ws.client !== 'string') {
    throw new Error('relay login response is missing ws.client');
  }
  return login;
}

async function waitForDirectory(relayBaseUrl, accessToken, daemonHostId, sessionName, timeoutMs) {
  return await waitFor(async () => {
    const payload = await fetchJson(`${relayBaseUrl}/api/directory`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const directory = payload.directory;
    const daemon = Array.isArray(directory?.devices)
      ? directory.devices.find((device) => device?.daemon?.hostId === daemonHostId)?.daemon
      : null;
    if (
      daemon?.presence?.connected === true
      && Array.isArray(daemon.sessions)
      && daemon.sessions.some((session) => session?.name === sessionName)
    ) {
      return directory;
    }
    return null;
  }, 'relay directory daemon/session publish', timeoutMs, 250);
}

async function loadRtcRuntime() {
  if (!rtcRuntimePromise) {
    rtcRuntimePromise = (async () => {
      const { register } = await import('tsx/esm/api');
      register();
      const [nodePlatform, wrtcModule] = await Promise.all([
        import(pathToFileURL(join(cliDir, 'src', 'node-platform.ts')).href),
        import('@roamhq/wrtc'),
      ]);
      const wrtc = wrtcModule.default || wrtcModule;
      return {
        createNodeTraversalFactory: nodePlatform.createNodeTraversalFactory,
        wrtc,
      };
    })();
  }
  return await rtcRuntimePromise;
}

function normalizeData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}

async function runForcedRtcRoute(options) {
  const { createNodeTraversalFactory, wrtc } = await loadRtcRuntime();
  const factory = createNodeTraversalFactory({
    WebSocket,
    RTCPeerConnection: options.relayOnlyRtc
      ? class RelayOnlyRtcPeerConnection extends wrtc.RTCPeerConnection {
          constructor(config) {
            if (config?.iceTransportPolicy !== 'relay') {
              super(config);
              this.close();
              throw new Error(`${options.label} rejected non-relay ICE policy`);
            }
            super(config);
          }
        }
      : wrtc.RTCPeerConnection,
    RTCSessionDescription: wrtc.RTCSessionDescription,
    RTCIceCandidate: wrtc.RTCIceCandidate,
  });
  const socket = factory.createSocket(
    options.target,
    options.settings,
    {
      autoReconnect: false,
      requireOpenConfirmation: true,
      routeHealthScope: {
        accountId: options.accountId,
        daemonHostId: options.daemonHostId,
      },
    },
  );
  const requestId = `rtc-fixture-list-${token(6)}`;
  let settled = false;
  const startedAt = Date.now();
  let result;
  let rejectResult;
  const completion = new Promise((resolveResult, rejectCompletion) => {
    result = resolveResult;
    rejectResult = rejectCompletion;
  });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    result(value);
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectResult(error);
  };
  const timer = setTimeout(() => {
    fail(new Error(`${options.label} timeout`));
  }, options.timeoutMs || defaultTimeoutMs);

  let helloSequence = 0;
  socket.onopen = () => {
    helloSequence += 1;
    try {
      socket.send(JSON.stringify({
        type: 'mux-hello',
        payload: {
          version: 1,
          clientInstanceId: `rtc-fixture-${token(8)}`,
          deviceId: options.clientDeviceId,
        },
      }));
    } catch (error) {
      fail(error);
    }
  };
  socket.onerror = () => {
    fail(new Error(`${options.label} traversal socket error`));
  };
  socket.onclose = (event) => {
    if (!settled) {
      fail(new Error(
        `${options.label} socket closed${event?.reason ? `: ${event.reason}` : ''}`,
      ));
    }
  };
  socket.onmessage = (event) => {
    if (settled) return;
    let frame;
    try {
      frame = JSON.parse(normalizeData(event.data));
    } catch (error) {
      fail(new Error(`${options.label} invalid mux frame: ${errorMessage(error)}`));
      return;
    }
    try {
      if (frame.type === 'mux-error' || frame.type === 'mux-channel-closed') {
        fail(new Error(`${options.label} mux error: ${JSON.stringify(frame)}`));
        return;
      }
      if (frame.type === 'mux-ready') {
        const reportedHostId = frame.payload?.daemonHostId;
        if (reportedHostId && reportedHostId !== options.daemonHostId) {
          fail(new Error(
            `${options.label} daemonHostId mismatch: expected ${options.daemonHostId} received ${reportedHostId}`,
          ));
          return;
        }
        socket.confirmTransportReady();
        socket.send(JSON.stringify({
          type: 'mux-target-message',
          payload: {
            requestId,
            message: { type: 'list-sessions' },
          },
        }));
        return;
      }
      if (
        frame.type === 'mux-target-message'
        && frame.payload?.requestId === requestId
        && frame.payload?.message?.type === 'sessions'
      ) {
        const sessions = Array.isArray(frame.payload.message.payload?.sessions)
          ? frame.payload.message.payload.sessions.map(String)
          : [];
        const catalog = Array.isArray(frame.payload.message.payload?.sessionCatalog)
          ? frame.payload.message.payload.sessionCatalog
          : [];
        const catalogEntry = catalog.find((entry) => entry?.name === options.sessionName);
        if (!sessions.includes(options.sessionName)) {
          fail(new Error(
            `${options.label} mux catalog omitted owned session ${options.sessionName}`,
          ));
          return;
        }
        const stableId = String(catalogEntry?.stableId || '').trim();
        if (!stableId) {
          fail(new Error(`${options.label} mux catalog omitted owned stableId`));
          return;
        }
        const diagnostics = socket.getDiagnostics();
        finish({
          attempted: true,
          ok: true,
          path: diagnostics.resolvedPath || null,
          relayTransport: diagnostics.resolvedRelayTransport || null,
          selectedIcePair: diagnostics.selectedIcePair || null,
          muxReady: true,
          ownedSessionVisible: true,
          stableId,
          durationMs: Date.now() - startedAt,
          diagnostics,
          helloSequence,
        });
      }
    } catch (error) {
      fail(error);
    }
  };

  try {
    return await completion;
  } finally {
    clearTimeout(timer);
    try {
      socket.close(1000, 'rtc fixture selfcheck complete');
    } catch {
      // The owned socket may already be closed.
    }
  }
}

function routeSettings(login, path) {
  const turn = login.turn;
  return {
    signalUrl: '',
    turnServerUrl: turn?.url || '',
    turnUsername: turn?.username || '',
    turnCredential: turn?.credential || '',
    transportMode: 'webrtc',
    traversalPathPriority: [path],
    traversalRelay: {
      relayBaseUrl: login.relayBaseUrl,
      accessToken: login.accessToken,
      userId: String(login.user.id),
      username: String(login.user.username || login.user.id),
      deviceId: login.clientDeviceId,
      deviceName: 'rtc-fixture-selfcheck-client',
      platform: process.platform,
      wsDevicesUrl: login.ws.devices,
      wsHostUrl: login.ws.host,
      wsClientUrl: login.ws.client,
      turnUrl: turn?.url || '',
      turnUsername: turn?.username || '',
      turnCredential: turn?.credential || '',
      updatedAt: Date.now(),
    },
  };
}

function routeTarget(directory, options) {
  const daemon = directory.devices.find((device) => device?.daemon?.hostId === options.daemonHostId)?.daemon;
  if (!daemon) throw new Error(`relay directory omitted daemon ${options.daemonHostId}`);
  return {
    bridgeHost: options.bridgeHost || '',
    bridgePort: options.bridgePort,
    relayHostId: options.daemonHostId,
    daemonHostId: options.daemonHostId,
    relayEndpointCandidates: daemon.endpoints || [],
    transportMode: 'webrtc',
  };
}

async function selfcheckRoute(options) {
  const startedAt = Date.now();
  try {
    const route = await runForcedRtcRoute(options);
    return {
      ...route,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      path: options.expectedPath,
      relayTransport: null,
      selectedIcePair: null,
      muxReady: false,
      ownedSessionVisible: false,
      durationMs: Date.now() - startedAt,
      error: redactText(errorMessage(error), options.secrets),
    };
  }
}

function validateDirectRoute(result) {
  if (!result.ok || result.path !== 'rtc-direct') {
    throw new Error(`direct RTC selfcheck failed: ${result.error || `path=${result.path || 'missing'}`}`);
  }
  const localType = result.selectedIcePair?.local?.candidateType;
  const remoteType = result.selectedIcePair?.remote?.candidateType;
  if (!localType || !remoteType) {
    throw new Error('direct RTC selfcheck did not report both selected ICE candidate types');
  }
  if (localType === 'relay' || remoteType === 'relay') {
    throw new Error(`direct RTC route selected TURN candidates: local=${localType} remote=${remoteType}`);
  }
  if (result.relayTransport !== 'direct') {
    throw new Error(`direct RTC selfcheck resolved relayTransport=${String(result.relayTransport)}`);
  }
}

function validateRelayRoute(result) {
  if (!result.ok || result.path !== 'rtc-relay') {
    throw new Error(`relay RTC selfcheck failed: ${result.error || `path=${result.path || 'missing'}`}`);
  }
  const localType = result.selectedIcePair?.local?.candidateType;
  const remoteType = result.selectedIcePair?.remote?.candidateType;
  if (localType !== 'relay' && remoteType !== 'relay') {
    throw new Error(`relay RTC selfcheck did not select a TURN relay candidate: local=${String(localType)} remote=${String(remoteType)}`);
  }
  if (result.relayTransport !== 'turn') {
    throw new Error(`relay RTC selfcheck resolved relayTransport=${String(result.relayTransport)}`);
  }
}

async function writeReceipts(receipt) {
  receipt.updatedAt = isoNow();
  writePrivateReceipt(receipt.receiptPath, receipt);
  const publicReceipt = buildPublicReceipt(receipt);
  writePublicReceipt(receipt.publicReceiptPath, publicReceipt);
  return publicReceipt;
}

function resourceSummary(receipt) {
  return {
    runtimeRoot: receipt.runtimeRoot,
    privateReceiptPath: receipt.receiptPath,
    publicReceiptPath: receipt.publicReceiptPath,
    relayPid: receipt.relay?.pid || null,
    daemonPid: receipt.daemon?.pid || null,
    cloudflaredPid: receipt.tunnel?.pid || null,
    coturnContainerId: receipt.turn?.containerId || null,
    tmuxSocketPath: receipt.tmux?.socketPath || null,
    tmuxSessionName: receipt.sessionName,
  };
}

async function cleanupOwnedResources(receipt, processHandles = new Map()) {
  if (receipt.state === 'closed') {
    return buildPublicReceipt(receipt);
  }
  const cleanup = {
    state: 'running',
    startedAt: isoNow(),
    completedAt: null,
    command: fixtureCleanupCommand(scriptPath, receipt.receiptPath),
    resources: resourceSummary(receipt),
    processes: [],
    tmux: null,
    coturn: null,
    runtimeRemoved: false,
    gaps: [],
  };
  receipt.cleanup = cleanup;
  receipt.state = 'closing';
  await writeReceipts(receipt);

  const stop = async (label) => {
    const processRecordValue = processHandles.get(label) || (
      label === 'cloudflared' ? receipt.tunnel : receipt[label]
    );
    if (!processRecordValue?.pid) {
      cleanup.processes.push({ label, pid: 0, stopped: true });
      return;
    }
    const live = processHandles.get(label);
    const result = live
      ? await stopLiveProcess(live)
      : await stopRecordedProcess(processRecordValue);
    cleanup.processes.push(result);
    if (!result.stopped) cleanup.gaps.push(`${label} process cleanup failed`);
  };

  await stop('daemon');

  if (receipt.tmux?.binary && receipt.tmux?.socketPath && receipt.sessionName) {
    try {
      assertPrivateReceipt(receipt);
      const tmuxBinary = executableInPath('tmux');
      if (!tmuxBinary) throw new Error('tmux executable unavailable');
      if (resolve(receipt.tmux.binary) !== resolve(tmuxBinary)) {
        throw new Error('private receipt tmux binary does not match the current executable');
      }
      const tmuxEnv = cleanEnvironment({
        HOME: receipt.homeDir,
        TMPDIR: receipt.tmpDir,
      });
      const hasSession = runTmux(
        tmuxBinary,
        receipt.tmux.socketPath,
        ['has-session', '-t', `=${receipt.sessionName}`],
        tmuxEnv,
        true,
      );
      if (hasSession.status === 0) {
        runTmux(
          tmuxBinary,
          receipt.tmux.socketPath,
          ['kill-session', '-t', `=${receipt.sessionName}`],
          tmuxEnv,
        );
      }
      const serverPid = positiveInteger(receipt.tmux.serverPid);
      if (serverPid) {
        await waitFor(
          () => !processExists(serverPid),
          'owned tmux server exit',
          7_000,
          100,
        );
      }
      // tmux 3.6 may leave the socket inode after the owned server exits.
      // Remove only the exact run-scoped path after its server is gone.
      removeFileIfPresent(receipt.tmux.socketPath);
      await waitFor(
        () => !existsSync(receipt.tmux.socketPath),
        'owned tmux socket close',
        3_000,
        100,
      );
      cleanup.tmux = {
        stopped: true,
        socketPath: receipt.tmux.socketPath,
        serverPid: serverPid || null,
      };
    } catch (error) {
      cleanup.tmux = { stopped: false, error: errorMessage(error) };
      cleanup.gaps.push(`tmux cleanup failed: ${errorMessage(error)}`);
    }
  } else {
    cleanup.tmux = { stopped: true, absent: true };
  }

  await stop('cloudflared');

  if (receipt.turn?.containerId) {
    try {
      assertPrivateContainerIdentity(receipt);
      const dockerBinary = executableInPath('docker');
      if (!dockerBinary) throw new Error('docker executable unavailable');
      const containerExists = dockerInspect(dockerBinary, receipt.turn.containerId, '{{.Id}}');
      if (containerExists) {
        const logs = spawnSync(dockerBinary, ['logs', receipt.turn.containerId], {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        });
        const coturnLogPath = join(dirname(receipt.receiptPath), 'coturn.log');
        const coturnLog = redactText(
          `${logs.stdout || ''}${logs.stderr || ''}`,
          [
            receipt.password,
            receipt.accessToken,
            receipt.daemon.authToken,
            receipt.turn.username,
            receipt.turn.credential,
          ],
        );
        writeFileSync(coturnLogPath, coturnLog, { encoding: 'utf8', mode: 0o600 });
        chmodSync(coturnLogPath, 0o600);
        const running = dockerInspect(dockerBinary, receipt.turn.containerId, '{{.State.Running}}');
        if (running === 'true') {
          runChecked(
            dockerBinary,
            ['stop', '--time', '5', receipt.turn.containerId],
            { timeoutMs: 20_000 },
          );
        }
        runChecked(
          dockerBinary,
          ['rm', receipt.turn.containerId],
          { timeoutMs: 20_000 },
        );
        cleanup.coturnLogPath = coturnLogPath;
      }
      cleanup.coturn = {
        stopped: true,
        containerId: receipt.turn.containerId,
        containerName: receipt.turn.containerName,
      };
    } catch (error) {
      cleanup.coturn = {
        stopped: false,
        containerId: receipt.turn.containerId,
        error: errorMessage(error),
      };
      cleanup.gaps.push(`coturn cleanup failed: ${errorMessage(error)}`);
    }
  } else {
    cleanup.coturn = { stopped: true, absent: true };
  }

  await stop('relay');

  if (cleanup.gaps.length === 0) {
    try {
      if (existsSync(receipt.runtimeRoot)) {
        rmSync(receipt.runtimeRoot, { recursive: true, force: true });
      }
      cleanup.runtimeRemoved = !existsSync(receipt.runtimeRoot);
      if (!cleanup.runtimeRemoved) cleanup.gaps.push('fixture runtime root still exists');
      const runtimeRunRoot = dirname(receipt.runtimeRoot);
      if (existsSync(runtimeRunRoot)) {
        rmdirSync(runtimeRunRoot);
      }
      cleanup.runtimeRunRootRemoved = !existsSync(runtimeRunRoot);
      if (!cleanup.runtimeRunRootRemoved) cleanup.gaps.push('fixture runtime run root still exists');
      const runtimeParent = dirname(runtimeRunRoot);
      try {
        rmdirSync(runtimeParent);
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
      }
    } catch (error) {
      cleanup.gaps.push(`runtime root cleanup failed: ${errorMessage(error)}`);
    }
  }

  cleanup.completedAt = isoNow();
  cleanup.state = cleanup.gaps.length === 0 ? 'complete' : 'incomplete';
  receipt.state = cleanup.gaps.length === 0 ? 'closed' : 'cleanup-failed';
  if (cleanup.gaps.length > 0) {
    receipt.gaps = [...new Set([...(receipt.gaps || []), ...cleanup.gaps])];
    receipt.status = 'cleanup-failed';
    receipt.ok = false;
  }
  return await writeReceipts(receipt);
}

function assertPrivateContainerIdentity(receipt) {
  if (!/^[a-f0-9]{12,64}$/u.test(receipt.turn.containerId)) {
    throw new Error('invalid coturn container ID');
  }
  const dockerBinary = executableInPath('docker');
  if (!dockerBinary) throw new Error('docker executable unavailable');
  const observed = dockerInspect(
    dockerBinary,
    receipt.turn.containerId,
    '{{.Name}}|{{index .Config.Labels "zterm.rtc-fixture.runId"}}',
  );
  if (!observed) return;
  const [observedName, observedRunId] = observed.split('|');
  if (observedRunId !== receipt.runId) {
    throw new Error('coturn container label does not match fixture runId');
  }
  const normalizedName = String(observedName || '').replace(/^\//u, '');
  if (normalizedName !== receipt.turn.containerName) {
    throw new Error('coturn container name does not match private receipt');
  }
}

function cloudflareWsClientUrl(baseUrl) {
  const url = new URL('/ws/client', baseUrl);
  url.protocol = 'wss:';
  return url.toString();
}

async function startCloudflared(receipt, relayPort, timeoutMs) {
  const cloudflaredBinary = executableInPath('cloudflared');
  if (!cloudflaredBinary) {
    return {
      requested: true,
      ready: false,
      error: 'cloudflared executable not found',
    };
  }
  const logPath = join(receipt.runtimeRoot, 'logs', 'cloudflared.log');
  const processRecordValue = spawnLogged({
    label: 'cloudflared',
    command: cloudflaredBinary,
    args: [
      'tunnel',
      '--url',
      `http://127.0.0.1:${relayPort}`,
      '--no-autoupdate',
      '--loglevel',
      'info',
    ],
    cwd: receipt.runtimeRoot,
    env: cleanEnvironment({
      HOME: receipt.homeDir,
      TMPDIR: receipt.tmpDir,
    }),
    logPath,
    identityNeedle: cloudflaredBinary,
  });
  if (!processRecordValue.pid) {
    return { requested: true, ready: false, error: 'cloudflared did not start', logPath };
  }
  receipt.tunnel = {
    requested: true,
    ready: false,
    pid: processRecordValue.pid,
    command: processRecordValue.command,
    args: processRecordValue.args,
    startedAt: processRecordValue.startedAt,
    identityNeedle: processRecordValue.identityNeedle,
    logPath,
    url: '',
    wsClientUrl: '',
  };
  await writeReceipts(receipt);
  try {
    const url = await waitFor(() => {
      const found = extractCloudflaredQuickTunnelUrl(readTextTail(logPath));
      return found || null;
    }, 'cloudflared quick tunnel URL', timeoutMs, 250);
    await waitFor(async () => {
      const health = await fetchJson(`${url}/health`, {}, 8_000);
      return health.ok === true;
    }, 'cloudflared relay health', timeoutMs, 500);
    receipt.tunnel.ready = true;
    receipt.tunnel.url = url;
    receipt.tunnel.wsClientUrl = cloudflareWsClientUrl(url);
    receipt.publicRelayBaseUrl = `${url}/`;
    await writeReceipts(receipt);
    return {
      process: processRecordValue,
      ready: true,
      url,
      wsClientUrl: receipt.tunnel.wsClientUrl,
    };
  } catch (error) {
    receipt.tunnel.ready = false;
    receipt.tunnel.error = redactText(errorMessage(error), [
      receipt.password,
      receipt.accessToken,
      receipt.daemon?.authToken,
      receipt.turn?.credential,
    ]);
    await writeReceipts(receipt);
    return {
      process: processRecordValue,
      ready: false,
      error: receipt.tunnel.error,
    };
  }
}

async function startRelayProcess(receipt, relayPort, turn) {
  const logPath = join(receipt.runtimeRoot, 'logs', 'relay.log');
  const env = cleanEnvironment({
    HOME: receipt.homeDir,
    TMPDIR: receipt.tmpDir,
    ZTERM_TRAVERSAL_HOST: '127.0.0.1',
    ZTERM_TRAVERSAL_PORT: String(relayPort),
    ZTERM_TRAVERSAL_BASE_PATH: '',
    ZTERM_TRAVERSAL_DATA_DIR: join(receipt.runtimeRoot, 'relay-data'),
    ZTERM_TRAVERSAL_UPDATES_DIR: join(receipt.runtimeRoot, 'relay-updates'),
    ...(turn?.configured
      ? {
          ZTERM_TURN_URL: turn.url,
          ZTERM_TURN_USERNAME: turn.username,
          ZTERM_TURN_CREDENTIAL: turn.credential,
        }
      : {}),
  });
  const processRecordValue = spawnLogged({
    label: 'relay',
    command: nodeExecutable,
    args: ['--import', 'tsx', relayEntry],
    cwd: androidDir,
    env,
    logPath,
    identityNeedle: relayEntry,
  });
  if (!processRecordValue.pid) throw new Error('relay process did not start');
  receipt.relay = {
    ...processRecord(processRecordValue),
    endpoint: receipt.relayBaseUrl,
  };
  await writeReceipts(receipt);
  await waitFor(async () => {
    const health = await fetchJson(`${receipt.relayBaseUrl}/health`, {}, 5_000);
    return health.ok === true ? health : null;
  }, 'relay health', defaultTimeoutMs);
  return processRecordValue;
}

async function startDaemonProcess(receipt, daemonPort, options) {
  const logPath = join(receipt.runtimeRoot, 'logs', 'daemon.log');
  const env = cleanEnvironment({
    HOME: receipt.homeDir,
    TMPDIR: receipt.tmpDir,
    ZTERM_HOST: '0.0.0.0',
    ZTERM_PORT: String(daemonPort),
    ZTERM_AUTH_TOKEN: receipt.daemon.authToken,
    ZTERM_DAGPIPE_NATIVE: options.nativePath,
    ZTERM_TERMINAL_BACKEND: 'tmux',
    ZTERM_TMUX_BINARY: tmuxWrapper,
    CLI_BLACKBOX_REAL_TMUX: receipt.tmux.binary,
    CLI_BLACKBOX_TMUX_SOCKET: receipt.tmux.socketPath,
    CLI_BLACKBOX_TMUX_SESSION: receipt.sessionName,
    CLI_BLACKBOX_TMUX_AUDIT_LOG: join(receipt.runtimeRoot, 'logs', 'tmux-wrapper-audit.log'),
    ZTERM_TRAVERSAL_RELAY_URL: receipt.relayBaseUrl,
    ZTERM_TRAVERSAL_USERNAME: receipt.username,
    ZTERM_TRAVERSAL_PASSWORD: receipt.password,
    ZTERM_TRAVERSAL_HOST_ID: receipt.daemonHostId,
    ZTERM_TRAVERSAL_DEVICE_ID: receipt.deviceId,
    ZTERM_TRAVERSAL_DEVICE_NAME: `rtc-fixture-${receipt.runId}`,
    ZTERM_TRAVERSAL_PLATFORM: process.platform,
    ZTERM_TRAVERSAL_APP_VERSION: 'rtc-fixture',
    ZTERM_TRAVERSAL_DAEMON_VERSION: 'rtc-fixture-candidate',
  });
  const processRecordValue = spawnLogged({
    label: 'daemon',
    command: nodeExecutable,
    args: ['--import', 'tsx', daemonEntry],
    cwd: androidDir,
    env,
    logPath,
    identityNeedle: daemonEntry,
  });
  if (!processRecordValue.pid) throw new Error('daemon process did not start');
  receipt.daemon.pid = processRecordValue.pid;
  receipt.daemon.command = processRecordValue.command;
  receipt.daemon.args = processRecordValue.args;
  receipt.daemon.startedAt = processRecordValue.startedAt;
  receipt.daemon.identityNeedle = processRecordValue.identityNeedle;
  receipt.daemon.logPath = logPath;
  await writeReceipts(receipt);
  const health = await waitFor(async () => {
    const payload = await fetchJson(`${receipt.daemon.endpoint}/health`, {}, 5_000);
    return payload.ok === true ? payload : null;
  }, 'daemon health', defaultTimeoutMs);
  if (Number(health.pid) !== processRecordValue.pid) {
    throw new Error(`daemon health pid mismatch: health=${String(health.pid)} child=${String(processRecordValue.pid)}`);
  }
  return processRecordValue;
}

function makeInitialReceipt(options) {
  const runId = `${Date.now().toString(36)}-${token(5)}`;
  const evidenceDir = resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const paths = fixtureRunPaths(evidenceDir, runId);
  ensurePrivateDirectory(paths.runDir);
  ensurePrivateDirectory(paths.runtimeRoot);
  ensurePrivateDirectory(paths.privateDir);
  mkdirSync(paths.publicDir, { recursive: true });
  const runtimeRoot = paths.runtimeRoot;
  const receiptPath = paths.receiptPath;
  const publicReceiptPath = paths.publicReceiptPath;
  const homeDir = join(runtimeRoot, 'home');
  const tmpDir = join(runtimeRoot, 'tmp');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(runtimeRoot, 'logs'), { recursive: true, mode: 0o700 });
  const now = isoNow();
  const relayPort = 0;
  const username = `rtc-fixture-account-${runId}`;
  return {
    schemaVersion: RTC_FIXTURE_SCHEMA_VERSION,
    kind: RTC_FIXTURE_KIND,
    runId,
    managedTest: true,
    state: 'initializing',
    status: 'initializing',
    ok: false,
    createdAt: now,
    updatedAt: now,
    evidenceDir,
    runtimeRoot,
    homeDir,
    tmpDir,
    receiptPath,
    publicReceiptPath,
    relayBaseUrl: `http://127.0.0.1:${relayPort}`,
    publicRelayBaseUrl: '',
    username,
    password: randomUUID(),
    accessToken: '',
    deviceId: `rtc-fixture-device-${runId}`,
    clientDeviceId: `rtc-fixture-client-${runId}`,
    daemonHostId: `rtc-fixture-host-${runId}`,
    sessionName: `rtc-fixture-${runId}`,
    backend: 'tmux',
    stableId: '',
    relay: {},
    daemon: {
      authToken: randomUUID(),
      nativePath: options.nativePath,
      endpoint: '',
      listener: null,
    },
    tmux: {
      binary: '',
      socketPath: paths.tmuxSocketPath,
      sessionName: `rtc-fixture-${runId}`,
      marker: `RTC_FIXTURE_${runId}`,
    },
    turn: {
      required: options.turnRequired,
      configured: false,
      authConfigPath: null,
      relayPortRange: null,
    },
    selfcheck: {
      direct: null,
      relay: null,
      tunnelRelay: null,
    },
    tunnel: null,
    gaps: [],
    cleanup: {
      state: 'pending',
      completedAt: null,
      command: null,
      resources: null,
    },
  };
}

export async function startRtcFixture(options = {}) {
  const normalized = {
    evidenceDir: resolve(options.evidenceDir || 'rtc-fixture-evidence'),
    hold: options.hold === true,
    exposeRelay: options.exposeRelay === true,
    turnRequired: options.turnRequired === true,
    nativePath: resolve(options.nativePath || installedDagpipeNative),
    timeoutMs: positiveInteger(options.timeoutMs) || defaultTimeoutMs,
  };
  requireFile(relayEntry, 'relay entry');
  requireFile(daemonEntry, 'daemon entry');
  requireFile(tmuxWrapper, 'tmux wrapper');
  requireFile(normalized.nativePath, 'DAGpipe native');
  const tmuxBinary = executableInPath('tmux');
  if (!tmuxBinary) throw new Error('tmux executable not found');

  const receipt = makeInitialReceipt(normalized);
  receipt.tmux.binary = tmuxBinary;
  const processHandles = new Map();
  let closePromise = null;
  await writeReceipts(receipt);

  const close = async () => {
    if (!closePromise) {
      closePromise = cleanupOwnedResources(receipt, processHandles);
    }
    return await closePromise;
  };

  try {
    const relayPort = await findAvailableTcpPort();
    receipt.relayBaseUrl = `http://127.0.0.1:${relayPort}`;
    receipt.publicRelayBaseUrl = receipt.relayBaseUrl;
    await writeReceipts(receipt);

    const tmuxEnv = cleanEnvironment({
      HOME: receipt.homeDir,
      TMPDIR: receipt.tmpDir,
      TERM: 'xterm-256color',
    });
    runTmux(tmuxBinary, receipt.tmux.socketPath, [
      'new-session',
      '-d',
      '-s',
      receipt.sessionName,
      '-x',
      '80',
      '-y',
      '24',
      'sh',
      '-lc',
      `printf '%s\\n' '${receipt.tmux.marker}'; exec cat`,
    ], tmuxEnv);
    const serverPid = Number.parseInt(String(runTmux(
      tmuxBinary,
      receipt.tmux.socketPath,
      ['display-message', '-p', '-t', `=${receipt.sessionName}`, '#{pid}'],
      tmuxEnv,
    ).stdout || '').trim(), 10);
    if (!Number.isSafeInteger(serverPid) || serverPid <= 0) {
      throw new Error('owned tmux server did not report its process ID');
    }
    receipt.tmux.serverPid = serverPid;
    await writeReceipts(receipt);
    await waitFor(() => {
      const capture = runTmux(
        tmuxBinary,
        receipt.tmux.socketPath,
        ['capture-pane', '-p', '-t', `=${receipt.sessionName}:.{top-left}`],
        tmuxEnv,
        true,
      );
      return capture.status === 0 && String(capture.stdout || '').includes(receipt.tmux.marker)
        ? capture.stdout
        : null;
    }, 'owned tmux marker', 10_000, 100);

    let turn;
    try {
      turn = await startCoturn({
        turnRequested: true,
        turnRequired: normalized.turnRequired,
      }, receipt);
    } catch (error) {
      turn = { configured: false, error: redactText(errorMessage(error), [receipt.turn.credential]) };
    }
    if (turn.configured) {
      Object.assign(receipt.turn, {
        configured: true,
        dockerBinary: turn.dockerBinary,
        containerId: turn.containerId,
        containerName: turn.containerName,
        listeningPort: turn.listeningPort,
        relayPortRange: turn.relayPortRange,
        authConfigPath: turn.authConfigPath,
        url: turn.url,
        username: turn.username,
        credential: turn.credential,
      });
    } else {
      receipt.gaps.push(`TURN route not ready: ${turn.error || 'coturn unavailable'}`);
    }
    await writeReceipts(receipt);

    const relayProcess = await startRelayProcess(receipt, relayPort, turn);
    processHandles.set('relay', relayProcess);

    const login = await registerAndLogin(
      receipt.relayBaseUrl,
      receipt.username,
      receipt.password,
    );
    receipt.accessToken = login.accessToken;
    receipt.login = {
      accessToken: login.accessToken,
      user: login.user,
      ws: login.ws,
      turn: login.turn || null,
    };
    await writeReceipts(receipt);

    const daemonPort = await findAvailableTcpPort();
    receipt.daemon.endpoint = `http://127.0.0.1:${daemonPort}`;
    receipt.daemon.listener = { host: '0.0.0.0', port: daemonPort };
    const daemonProcess = await startDaemonProcess(receipt, daemonPort, normalized);
    processHandles.set('daemon', daemonProcess);

    const directory = await waitForDirectory(
      receipt.relayBaseUrl,
      receipt.accessToken,
      receipt.daemonHostId,
      receipt.sessionName,
      normalized.timeoutMs,
    );
    receipt.directory = directory;
    await writeReceipts(receipt);

    const common = {
      accountId: String(login.user.id),
      daemonHostId: receipt.daemonHostId,
      clientDeviceId: receipt.clientDeviceId,
      sessionName: receipt.sessionName,
      timeoutMs: normalized.timeoutMs,
      secrets: [
        receipt.password,
        receipt.accessToken,
        receipt.daemon.authToken,
        receipt.turn.credential,
        receipt.turn.username,
      ],
    };
    const targetBase = routeTarget(directory, {
      daemonHostId: receipt.daemonHostId,
      bridgePort: daemonPort,
    });
    const loginForClient = {
      ...login,
      relayBaseUrl: receipt.relayBaseUrl,
      clientDeviceId: receipt.clientDeviceId,
    };
    const directClientDeviceId = `${receipt.clientDeviceId}-direct`;

    receipt.selfcheck.direct = await selfcheckRoute({
      ...common,
      ...{
        label: 'rtc-direct selfcheck',
        expectedPath: 'rtc-direct',
        target: targetBase,
        clientDeviceId: directClientDeviceId,
        settings: routeSettings({
          ...loginForClient,
          clientDeviceId: directClientDeviceId,
        }, 'rtc-direct'),
      },
    });
    validateDirectRoute(receipt.selfcheck.direct);
    receipt.stableId = receipt.selfcheck.direct.stableId;
    await writeReceipts(receipt);

    if (receipt.turn.configured && login.turn?.url) {
      const relayClientDeviceId = `${receipt.clientDeviceId}-relay`;
      receipt.selfcheck.relay = await selfcheckRoute({
        ...common,
        label: 'rtc-relay selfcheck',
        expectedPath: 'rtc-relay',
        relayOnlyRtc: true,
        target: targetBase,
        clientDeviceId: relayClientDeviceId,
        settings: routeSettings({
          ...loginForClient,
          clientDeviceId: relayClientDeviceId,
        }, 'rtc-relay'),
      });
      try {
        validateRelayRoute(receipt.selfcheck.relay);
      } catch (error) {
        receipt.gaps.push(redactText(errorMessage(error), common.secrets));
      }
    } else {
      receipt.selfcheck.relay = {
        attempted: false,
        ok: false,
        path: 'rtc-relay',
        relayTransport: null,
        selectedIcePair: null,
        muxReady: false,
        ownedSessionVisible: false,
        error: 'TURN not configured for this fixture run',
      };
      receipt.gaps.push('TURN route not ready: TURN was not configured');
    }

    if (normalized.exposeRelay) {
      const tunnel = await startCloudflared(receipt, relayPort, normalized.timeoutMs);
      if (tunnel.process) processHandles.set('cloudflared', tunnel.process);
      if (tunnel.ready && receipt.selfcheck.relay?.ok) {
        const tunnelClientDeviceId = `${receipt.clientDeviceId}-tunnel`;
        const tunnelSettings = routeSettings({
          ...loginForClient,
          clientDeviceId: tunnelClientDeviceId,
        }, 'rtc-relay');
        tunnelSettings.traversalRelay.wsClientUrl = tunnel.wsClientUrl;
        receipt.selfcheck.tunnelRelay = await selfcheckRoute({
          ...common,
          label: 'tunnel-relay selfcheck',
          expectedPath: 'rtc-relay',
          relayOnlyRtc: true,
          target: targetBase,
          clientDeviceId: tunnelClientDeviceId,
          settings: tunnelSettings,
        });
        try {
          validateRelayRoute(receipt.selfcheck.tunnelRelay);
        } catch (error) {
          receipt.gaps.push(redactText(errorMessage(error), common.secrets));
        }
      } else {
        receipt.gaps.push(`cloudflared fixture not ready: ${tunnel.error || 'TURN relay route unavailable'}`);
      }
    } else {
      receipt.tunnel = null;
    }

    const directReady = receipt.selfcheck.direct?.ok === true;
    const relayReady = receipt.selfcheck.relay?.ok === true;
    const tunnelReady = !normalized.exposeRelay || receipt.selfcheck.tunnelRelay?.ok === true;
    const hardReady = directReady
      && (!normalized.turnRequired || relayReady)
      && (!normalized.exposeRelay || tunnelReady);
    receipt.ok = hardReady;
    receipt.status = hardReady
      ? receipt.gaps.length > 0
        ? 'ready-with-gaps'
        : 'ready'
      : 'failed';
    receipt.state = normalized.hold ? 'held' : 'ready';
    if (!hardReady) {
      throw new Error(
        receipt.gaps[0]
        || `RTC fixture is not ready: direct=${directReady} relay=${relayReady} tunnel=${tunnelReady}`,
      );
    }
    const publicReceipt = await writeReceipts(receipt);
    return {
      receiptPath: receipt.receiptPath,
      publicReceipt,
      close,
    };
  } catch (error) {
    receipt.gaps = [
      ...new Set([
        ...(receipt.gaps || []),
        redactText(errorMessage(error), [
          receipt.password,
          receipt.accessToken,
          receipt.daemon.authToken,
          receipt.turn.credential,
        ]),
      ]),
    ];
    receipt.status = 'failed';
    receipt.ok = false;
    await close().catch(() => undefined);
    throw error;
  }
}

export async function cleanupRtcFixtureFromReceipt(receiptPath) {
  const receipt = readPrivateReceipt(receiptPath);
  return await cleanupOwnedResources(receipt, new Map());
}

function printHelp() {
  process.stdout.write([
    'Usage: node --import tsx packages/cli/scripts/rtc-fixture.mjs [options]',
    '',
    'Options:',
    '  --evidence-dir DIR           Store private/public fixture receipts under DIR',
    '  --hold                       Keep the ready fixture running for a consumer',
    '  --expose-relay               Add an authenticated cloudflared HTTP/WSS relay',
    '  --turn-required              Fail unless the real TURN relay route passes',
    '  --native-path FILE           Use an explicit DAGpipe native module',
    '  --cleanup-private-receipt P  Clean the exact resources in receipt P',
    '  --help                       Show this help',
    '',
  ].join('\n'));
}

async function flushStdout(text) {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(text, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

async function main() {
  const options = parseRtcFixtureArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.cleanupPrivateReceipt) {
    const publicReceipt = await cleanupRtcFixtureFromReceipt(options.cleanupPrivateReceipt);
    await flushStdout(`${JSON.stringify(publicReceipt, null, 2)}\n`);
    return;
  }

  const fixture = await startRtcFixture(options);
  if (options.hold) {
    await flushStdout(`${JSON.stringify({
      ...fixture.publicReceipt,
      cleanup: {
        ...fixture.publicReceipt.cleanup,
        command: fixtureCleanupCommand(scriptPath, fixture.receiptPath),
      },
    }, null, 2)}\n`);
    const closeOnSignal = () => {
      void fixture.close();
    };
    process.once('SIGINT', closeOnSignal);
    process.once('SIGTERM', closeOnSignal);
    await waitForRtcFixtureHold(fixture.receiptPath);
    process.off('SIGINT', closeOnSignal);
    process.off('SIGTERM', closeOnSignal);
    return;
  }
  const finalReceipt = await fixture.close();
  await flushStdout(`${JSON.stringify(finalReceipt, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`rtc fixture failed: ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
