import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { WebSocket } from 'ws';

import { runProcess } from './platform-smoke-helper.mjs';

const RELAY_PACKAGE_NAME = '@jsonstudio/zterm-relay-server';
const RELAY_HOST = '127.0.0.1';
const RELAY_BASE_PATH = '/relay';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function fixtureBinding(options) {
  const {
    relayBaseUrl,
    userId,
    slotName = 'fixture-session',
    alias,
    widthMode = 'adaptive-phone',
  } = options;
  return {
    ...(alias === undefined ? {} : { alias }),
    account: {
      // Match the canonical base saved by real login and slot configuration.
      relayBaseUrl: relayBaseUrl.endsWith('/') ? relayBaseUrl : `${relayBaseUrl}/`,
      userId,
    },
    server: {
      deviceId: `fixture-device-${slotName}`,
      daemonHostId: `fixture-host-${slotName}`,
      displayName: `Fixture ${slotName}`,
    },
    session: {
      backend: 'tmux',
      stableId: `fixture-stable-${slotName}`,
      name: slotName,
    },
    widthMode,
  };
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, RELAY_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate relay port')));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

export async function waitForRelayHealth(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(100);
  }
  throw new Error(`relay health timeout: ${lastError}`);
}

function relayEnvironment(homeDir, dataDir, updatesDir, port) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      name.startsWith('ZTERM_TRAVERSAL_')
      || name.startsWith('ZTERM_TURN_')
      || name === 'ZTERM_RELAY_UPDATES_DIR'
      || name === 'NODE_OPTIONS'
      || name === 'NODE_PATH'
    ) {
      continue;
    }
    env[name] = value;
  }
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    ZTERM_TRAVERSAL_HOST: RELAY_HOST,
    ZTERM_TRAVERSAL_PORT: String(port),
    ZTERM_TRAVERSAL_BASE_PATH: RELAY_BASE_PATH,
    ZTERM_TRAVERSAL_DATA_DIR: dataDir,
    ZTERM_TRAVERSAL_STORE_PATH: join(dataDir, 'store.json'),
    ZTERM_TRAVERSAL_UPDATES_DIR: updatesDir,
  };
}

export async function startRelayRuntime(options) {
  const {
    runtimePath,
    rootDir,
    label,
    timeoutMs = 15_000,
  } = options;
  if (!existsSync(runtimePath)) {
    throw new Error(`relay runtime is missing: ${runtimePath}`);
  }

  const dataDir = join(rootDir, 'data');
  const updatesDir = join(rootDir, 'updates');
  const homeDir = join(rootDir, 'home');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(updatesDir, 'latest.json'),
    '{"versionCode":1,"apkUrl":"fixture.apk"}\n',
    { mode: 0o600 },
  );
  writeFileSync(join(updatesDir, 'fixture.apk'), 'fixture\n', { mode: 0o600 });

  const port = await availablePort();
  const env = relayEnvironment(homeDir, dataDir, updatesDir, port);
  const output = [];
  const child = spawn(process.execPath, [runtimePath], {
    cwd: rootDir,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const append = (chunk) => {
    output.push(String(chunk));
    const joined = output.join('');
    if (joined.length > 24_000) {
      output.splice(0, output.length, joined.slice(-12_000));
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
  });
  const state = {
    label,
    child,
    pid: child.pid,
    port,
    baseUrl: `http://${RELAY_HOST}:${port}${RELAY_BASE_PATH}`,
    dataDir,
    updatesDir,
    storePath: join(dataDir, 'store.json'),
    cloudPath: join(dataDir, 'cli-slot-config.json'),
    rootDir,
    output,
    exitPromise,
    exitCode: null,
    signal: null,
    stopped: false,
  };
  child.once('exit', (exitCode, signal) => {
    state.exitCode = exitCode;
    state.signal = signal;
  });
  child.once('error', (error) => {
    state.spawnError = error;
  });

  try {
    await waitForRelayHealth(state.baseUrl, timeoutMs);
  } catch (error) {
    try {
      await stopRelayRuntime(state);
    } catch {
      // Keep the original startup failure and let the caller report cleanup.
    }
    throw new Error(`${label} failed to start: ${errorMessage(error)}\n${output.join('')}`);
  }
  return state;
}

export async function stopRelayRuntime(state, timeoutMs = 8_000) {
  if (!state || state.stopped) {
    return {
      pid: state?.pid ?? null,
      exited: true,
      exitCode: state?.exitCode ?? null,
      signal: state?.signal ?? null,
    };
  }
  state.stopped = true;
  if (state.child.exitCode !== null || state.child.signalCode !== null) {
    const result = await state.exitPromise;
    return { pid: state.pid, exited: true, ...result };
  }

  try {
    state.child.kill('SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const graceful = await Promise.race([
    state.exitPromise.then((result) => ({ ended: true, ...result })),
    delay(timeoutMs).then(() => ({ ended: false })),
  ]);
  if (graceful.ended) {
    return {
      pid: state.pid,
      exited: true,
      exitCode: graceful.exitCode,
      signal: graceful.signal,
    };
  }

  try {
    state.child.kill('SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const forced = await Promise.race([
    state.exitPromise.then((result) => ({ ended: true, ...result })),
    delay(3_000).then(() => ({ ended: false })),
  ]);
  if (!forced.ended) {
    throw new Error(
      `owned relay process ${String(state.pid)} did not exit after exact-PID SIGKILL`,
    );
  }
  return {
    pid: state.pid,
    exited: true,
    exitCode: forced.exitCode,
    signal: forced.signal,
  };
}

export async function apiRequest(baseUrl, path, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    timeoutMs = 15_000,
  } = options;
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text.trim() ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    payload,
    text,
  };
}

function requireApiSuccess(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  return response.payload;
}

export async function registerAccount(baseUrl, username, password) {
  const response = await apiRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { username, password },
  });
  const payload = requireApiSuccess(response, `register ${username}`);
  if (!payload?.user?.id) {
    throw new Error('register response has no user id');
  }
  return payload.user;
}

export async function loginAccount(baseUrl, username, password) {
  const response = await apiRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  const payload = requireApiSuccess(response, `login ${username}`);
  if (!payload?.accessToken || !payload?.user?.id || !payload?.ws?.host) {
    throw new Error('login response is missing token, user, or daemon WebSocket endpoint');
  }
  return {
    username,
    password,
    accessToken: payload.accessToken,
    userId: payload.user.id,
    ws: payload.ws,
  };
}

export async function presenceWriteViaDaemonSocket(login, options = {}) {
  const {
    hostId = `fixture-host-${process.pid}-${Date.now()}`,
    deviceId = `fixture-device-${process.pid}-${Date.now()}`,
    deviceName = 'fixture-daemon',
    platform = 'fixture',
    appVersion = 'fixture',
    daemonVersion = 'fixture',
    timeoutMs = 10_000,
  } = options;
  const url = new URL(login.ws.host);
  url.searchParams.set('token', login.accessToken);
  url.searchParams.set('hostId', hostId);
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('deviceName', deviceName);
  url.searchParams.set('platform', platform);
  url.searchParams.set('appVersion', appVersion);
  url.searchParams.set('daemonVersion', daemonVersion);

  const socket = new WebSocket(url);
  socket.on('error', () => undefined);
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('daemon presence socket open timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });

  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('relay-ready timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onMessage = (raw) => {
      let envelope;
      try {
        envelope = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (envelope?.type !== 'relay-ready') return;
      cleanup();
      resolveReady();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`daemon presence socket closed: ${code} ${String(reason)}`));
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
  return { socket, hostId, deviceId, deviceName };
}

export async function closeWebSocket(socket, timeoutMs = 3_000) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolveClose) => {
    const timer = setTimeout(resolveClose, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, 'fixture cleanup');
  }
  await closed;
  if (socket.readyState !== WebSocket.CLOSED) {
    socket.terminate();
  }
}

export function prepareCandidateRelayPackage(repoRoot, destination, timeoutMs = 120_000) {
  const prepareScript = join(
    repoRoot,
    'android',
    'scripts',
    'prepare-relay-server-npm-package.mjs',
  );
  const result = runProcess(process.execPath, [prepareScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ZTERM_RELAY_SERVER_NPM_NAME: RELAY_PACKAGE_NAME,
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
    timeout: timeoutMs,
  });
  const generatedRoot = join(
    repoRoot,
    'android',
    'release-dist',
    'relay-server-npm',
    RELAY_PACKAGE_NAME.replace('/', '__'),
  );
  const manifestPath = join(generatedRoot, 'package.json');
  const runtimePath = join(generatedRoot, 'runtime', 'server.cjs');
  if (!existsSync(manifestPath) || !existsSync(runtimePath)) {
    throw new Error('official relay package prepare did not produce a runnable package');
  }
  cpSync(generatedRoot, destination, { recursive: true, dereference: true });
  const manifest = readJsonFile(join(destination, 'package.json'));
  if (manifest.name !== RELAY_PACKAGE_NAME) {
    throw new Error(`unexpected relay package name: ${String(manifest.name)}`);
  }
  return {
    packageRoot: destination,
    manifestPath: join(destination, 'package.json'),
    runtimePath: join(destination, 'runtime', 'server.cjs'),
    name: manifest.name,
    version: manifest.version,
    prepareOutput: {
      exitCode: result.exitCode,
      stdout: result.stdout.trim().slice(-2_000),
      stderr: result.stderr.trim().slice(-2_000),
    },
  };
}

export function resolvePreviousRelayRuntime(explicitPath) {
  const runtimePath = explicitPath || process.env.ZTERM_PREVIOUS_RELAY_RUNTIME;
  if (!runtimePath) return undefined;
  const resolved = resolve(runtimePath);
  if (!existsSync(resolved)) {
    throw new Error(`ZTERM_PREVIOUS_RELAY_RUNTIME does not exist: ${resolved}`);
  }
  const packageRoot = resolve(dirname(resolved), '..');
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
  return {
    runtimePath: resolved,
    packageRoot,
    manifest,
  };
}

const FORBIDDEN_CLOUD_KEYS = new Set([
  'account',
  'accessToken',
  'credential',
  'endpoint',
  'endpoints',
  'password',
  'relayBaseUrl',
  'token',
  'turn',
  'userId',
  'ws',
]);

export function assertNoForbiddenCloudFields(value, secrets = []) {
  const visit = (candidate, path = 'config') => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== 'object') {
      if (typeof candidate === 'string') {
        if (/^(?:https?|wss?):\/\//iu.test(candidate)) {
          throw new Error(`${path} contains an endpoint URL`);
        }
        for (const secret of secrets) {
          if (secret && candidate.includes(secret)) {
            throw new Error(`${path} contains an account secret`);
          }
        }
      }
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (FORBIDDEN_CLOUD_KEYS.has(key)) {
        throw new Error(`${path}.${key} is forbidden in cloud slot data`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value);
  return true;
}

export function relayFailureText(state) {
  if (!state) return '';
  return state.output.join('').trim().slice(-12_000);
}
