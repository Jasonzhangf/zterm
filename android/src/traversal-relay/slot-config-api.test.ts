import { spawn, type ChildProcess } from 'child_process';
import { createServer as createNetServer } from 'net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

type WidthMode = 'adaptive-phone' | 'mirror-fixed';

interface SyncedSlot {
  slot: number;
  alias?: string;
  server: {
    deviceId: string;
    daemonHostId: string;
    displayName: string;
  };
  session: {
    backend: 'tmux' | 'herdr';
    stableId: string;
    name: string;
  };
  widthMode: WidthMode;
}

type SyncedSlotBinding = Omit<SyncedSlot, 'slot'>;

interface Account {
  id: string;
  token: string;
  username: string;
  password: string;
}

interface ApiResponse {
  status: number;
  body: Record<string, any> | null;
  text: string;
}

interface RelayFixture {
  child: ChildProcess;
  port: number;
  tempRoot: string;
  dataDir: string;
  updatesDir: string;
  baseUrl: string;
  wsBaseUrl: string;
  output: string[];
}

let currentFixture: RelayFixture | null = null;
let ownedSockets: WebSocket[] = [];
let fixtureSequence = 0;

function uniqueName(label: string) {
  fixtureSequence += 1;
  return `slot-api-${label}-${process.pid}-${Date.now()}-${fixtureSequence}`;
}

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate slot API test port')));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHttpOk(url: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay server did not become healthy: ${lastError}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`relay child ${child.pid ?? 'unknown'} did not exit after SIGTERM`));
    }, 8_000);
    timeout.unref?.();

    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };

    child.once('exit', onExit);
    const delivered = child.kill('SIGTERM');
    if (!delivered && child.exitCode === null && child.signalCode === null) {
      clearTimeout(timeout);
      child.off('exit', onExit);
      reject(new Error(`SIGTERM was not delivered to relay child ${child.pid ?? 'unknown'}`));
    }
  });
}

async function stopRelayFixture(fixture: RelayFixture, removeTempRoot: boolean) {
  try {
    await stopChild(fixture.child);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n`
      + `fixture preserved at ${fixture.tempRoot}\n${fixture.output.join('')}`,
    );
  }
  if (removeTempRoot) {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
}

async function startRelayFixture(existingTempRoot?: string): Promise<RelayFixture> {
  const tempRoot = existingTempRoot || mkdtempSync(join(tmpdir(), 'zterm-slot-config-api-test-'));
  const updatesDir = join(tempRoot, 'updates');
  const dataDir = join(tempRoot, 'data');
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(join(updatesDir, 'latest.json'), '{"versionCode":1,"apkUrl":"noop.apk"}\n');
  writeFileSync(join(updatesDir, 'noop.apk'), 'noop');

  const port = await availablePort();
  const output: string[] = [];
  const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['src/traversal-relay/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZTERM_TRAVERSAL_HOST: '127.0.0.1',
      ZTERM_TRAVERSAL_PORT: String(port),
      ZTERM_TRAVERSAL_BASE_PATH: '/relay',
      ZTERM_TRAVERSAL_DATA_DIR: dataDir,
      ZTERM_TRAVERSAL_STORE_PATH: join(dataDir, 'store.json'),
      ZTERM_TRAVERSAL_UPDATES_DIR: updatesDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));

  const fixture: RelayFixture = {
    child,
    port,
    tempRoot,
    dataDir,
    updatesDir,
    baseUrl: `http://127.0.0.1:${port}/relay`,
    wsBaseUrl: `ws://127.0.0.1:${port}/relay`,
    output,
  };

  try {
    await waitForHttpOk(`${fixture.baseUrl}/health`);
  } catch (error) {
    try {
      await stopRelayFixture(fixture, true);
    } catch {
      // Keep the fixture when the owned child cannot be stopped cleanly.
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join('')}`);
  }
  return fixture;
}

async function bootRelayFixture() {
  const fixture = await startRelayFixture();
  currentFixture = fixture;
  return fixture;
}

async function restartRelayFixture(fixture: RelayFixture) {
  await closeOwnedSockets();
  await stopRelayFixture(fixture, false);
  const restarted = await startRelayFixture(fixture.tempRoot);
  currentFixture = restarted;
  return restarted;
}

async function closeSocket(socket: WebSocket) {
  const index = ownedSockets.indexOf(socket);
  if (index >= 0) ownedSockets.splice(index, 1);
  if (socket.readyState === WebSocket.CLOSED) return;

  const closed = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      socket.off('close', onClose);
      resolve();
    }, 3_000);
    timeout.unref?.();
    const onClose = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.once('close', onClose);
  });

  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, 'test cleanup');
  }
  await closed;
  if ((socket.readyState as number) !== WebSocket.CLOSED) {
    socket.terminate();
  }
}

async function closeOwnedSockets() {
  const sockets = [...ownedSockets];
  ownedSockets = [];
  for (const socket of sockets) {
    try {
      await closeSocket(socket);
    } catch {
      // The test fixture cleanup must continue for the remaining owned sockets.
    }
  }
}

async function openRelaySocket(url: string) {
  const socket = new WebSocket(url);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`websocket open timeout: ${url}`)), 5_000);
    timeout.unref?.();
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  ownedSockets.push(socket);
  return socket;
}

function waitForEnvelope<T extends Record<string, any>>(
  socket: WebSocket,
  predicate: (envelope: T) => boolean,
  timeoutMs = 5_000,
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('relay websocket envelope timeout'));
    }, timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      let envelope: T;
      try {
        envelope = JSON.parse(String(raw)) as T;
      } catch {
        return;
      }
      if (!predicate(envelope)) return;
      cleanup();
      resolve(envelope);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`websocket closed while waiting: ${code} ${reason.toString()}`));
    };

    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function requestJson(
  fixture: RelayFixture,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${fixture.baseUrl}${path}`, init);
  const text = await response.text();
  let body: Record<string, any> | null = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, text };
}

async function apiRequest(
  fixture: RelayFixture,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['content-type'] = 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  return requestJson(fixture, path, { method, headers, body });
}

function slot(slotNumber: number, overrides: Partial<SyncedSlot> = {}): SyncedSlot {
  const base: SyncedSlot = {
    slot: slotNumber,
    alias: `Slot ${slotNumber}`,
    server: {
      deviceId: `device-${slotNumber}`,
      daemonHostId: `host-${slotNumber}`,
      displayName: `Display ${slotNumber}`,
    },
    session: {
      backend: 'tmux',
      stableId: `stable-${slotNumber}`,
      name: `session-${slotNumber}`,
    },
    widthMode: 'adaptive-phone',
  };
  return {
    ...base,
    ...overrides,
    server: { ...base.server, ...(overrides.server || {}) },
    session: { ...base.session, ...(overrides.session || {}) },
  };
}

function bindingOf(value: SyncedSlot): SyncedSlotBinding {
  const { slot: _slot, ...binding } = value;
  return binding;
}

function fullBody(slots: SyncedSlot[], extras: Record<string, unknown> = {}) {
  return { schemaVersion: 1, slots, ...extras };
}

function singleBody(binding: unknown, extras: Record<string, unknown> = {}) {
  return { schemaVersion: 1, binding, ...extras };
}

async function registerAndLogin(fixture: RelayFixture, label: string): Promise<Account> {
  const username = uniqueName(label);
  const password = `pw-${uniqueName(label)}`;
  const register = await apiRequest(fixture, 'POST', '/api/auth/register', {
    body: { username, password },
  });
  expect(register.status).toBe(201);
  const userId = register.body?.user?.id;
  expect(typeof userId).toBe('string');
  expect(userId.length).toBeGreaterThan(0);

  const login = await apiRequest(fixture, 'POST', '/api/auth/login', {
    body: { username, password },
  });
  expect(login.status).toBe(200);
  expect(typeof login.body?.accessToken).toBe('string');
  expect(login.body?.accessToken.length).toBeGreaterThan(0);
  return {
    id: userId,
    token: login.body?.accessToken,
    username,
    password,
  };
}

async function loginAgain(fixture: RelayFixture, account: Account) {
  const login = await apiRequest(fixture, 'POST', '/api/auth/login', {
    body: { username: account.username, password: account.password },
  });
  expect(login.status).toBe(200);
  expect(typeof login.body?.accessToken).toBe('string');
  return login.body?.accessToken as string;
}

function expectSlotSuccess(
  response: ApiResponse,
  userId: string,
  config: { configured: false } | { configured: true; slots: SyncedSlot[] },
) {
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ok: true,
    schemaVersion: 1,
    user: { id: userId },
    config,
  });
}

function expectApiError(
  response: ApiResponse,
  status: number,
  codes: string | string[],
) {
  expect(response.status).toBe(status);
  expect(response.body).not.toBeNull();
  expect(response.body?.ok).toBe(false);
  expect(typeof response.body?.error?.code).toBe('string');
  expect(typeof response.body?.error?.message).toBe('string');
  expect(response.body?.error?.message.length).toBeGreaterThan(0);
  const allowed = Array.isArray(codes) ? codes : [codes];
  expect(allowed).toContain(response.body?.error?.code);
}

async function getSlots(fixture: RelayFixture, token: string) {
  return apiRequest(fixture, 'GET', '/api/cli/slots', { token });
}

async function putAll(
  fixture: RelayFixture,
  token: string,
  slots: SyncedSlot[],
  extras: Record<string, unknown> = {},
) {
  return apiRequest(fixture, 'PUT', '/api/cli/slots', {
    token,
    body: fullBody(slots, extras),
  });
}

async function putSingle(
  fixture: RelayFixture,
  token: string,
  slotNumber: number,
  binding: unknown,
  extras: Record<string, unknown> = {},
) {
  return apiRequest(fixture, 'PUT', `/api/cli/slots/${slotNumber}`, {
    token,
    body: singleBody(binding, extras),
  });
}

async function cleanupDevices(
  fixture: RelayFixture,
  token: string,
  deviceIds: unknown,
  extras: Record<string, unknown> = {},
) {
  return apiRequest(fixture, 'POST', '/api/devices/cleanup', {
    token,
    body: { deviceIds, ...extras },
  });
}

function expectCleanupSuccess(
  response: ApiResponse,
  userId: string,
  removedDeviceIds: string[],
  absentDeviceIds: string[],
) {
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ok: true,
    user: { id: userId },
    removedDeviceIds,
    absentDeviceIds,
  });
}

async function directoryDevices(fixture: RelayFixture, token: string) {
  const response = await apiRequest(fixture, 'GET', '/api/directory', { token });
  expect(response.status).toBe(200);
  const devices = response.body?.directory?.devices;
  expect(Array.isArray(devices)).toBe(true);
  return devices as Array<Record<string, any>>;
}

async function waitForDirectoryDevice(
  fixture: RelayFixture,
  token: string,
  deviceId: string,
  predicate: (device: Record<string, any>) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastDevice: Record<string, any> | null = null;
  while (Date.now() < deadline) {
    const devices = await directoryDevices(fixture, token);
    const device = devices.find((candidate) => candidate.deviceId === deviceId) || null;
    lastDevice = device;
    if (device && predicate(device)) return device;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`directory device timeout: ${JSON.stringify(lastDevice)}`);
}

async function expectDirectoryDevicePresent(fixture: RelayFixture, token: string, deviceId: string) {
  return waitForDirectoryDevice(fixture, token, deviceId, () => true);
}

async function expectDirectoryDeviceMissing(fixture: RelayFixture, token: string, deviceId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const devices = await directoryDevices(fixture, token);
    if (!devices.some((candidate) => candidate.deviceId === deviceId)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`directory device still present: ${deviceId}`);
}

function publishDirectory(socket: WebSocket, sessionName: string) {
  socket.send(JSON.stringify({
    type: 'directory-update',
    directory: {
      endpoints: [],
      sessions: [{ name: sessionName, updatedAt: new Date().toISOString() }],
      publishedAt: new Date().toISOString(),
    },
  }));
}

async function connectHostAndPublish(
  fixture: RelayFixture,
  account: Account,
  hostId: string,
  deviceId: string,
  sessionName: string,
) {
  const query = new URLSearchParams({
    token: account.token,
    hostId,
    deviceId,
    deviceName: deviceId,
    platform: 'test',
    appVersion: 'test',
    daemonVersion: 'test',
  });
  const socket = await openRelaySocket(`${fixture.wsBaseUrl}/ws/host?${query.toString()}`);
  await waitForEnvelope(socket, (envelope) => envelope.type === 'relay-ready');
  publishDirectory(socket, sessionName);
  await waitForDirectoryDevice(
    fixture,
    account.token,
    deviceId,
    (device) => device.daemon?.presence?.connected === true,
  );
  return socket;
}

async function createOfflineDaemon(
  fixture: RelayFixture,
  account: Account,
  hostId: string,
  deviceId: string,
  sessionName = `session-${deviceId}`,
) {
  const socket = await connectHostAndPublish(fixture, account, hostId, deviceId, sessionName);
  await closeSocket(socket);
  await waitForDirectoryDevice(
    fixture,
    account.token,
    deviceId,
    (device) => device.daemon?.presence?.connected === false,
  );
}

async function createOfflineClientOnly(
  fixture: RelayFixture,
  account: Account,
  deviceId: string,
) {
  const query = new URLSearchParams({
    token: account.token,
    deviceId,
    deviceName: deviceId,
    platform: 'test',
    appVersion: 'test',
  });
  const socket = await openRelaySocket(`${fixture.wsBaseUrl}/ws/devices?${query.toString()}`);
  const snapshot = waitForEnvelope(
    socket,
    (envelope) => envelope.type === 'directory-snapshot' || envelope.type === 'devices-snapshot',
  );
  socket.send(JSON.stringify({
    type: 'devices-request',
    payload: {
      deviceId,
      deviceName: deviceId,
      platform: 'test',
      appVersion: 'test',
    },
  }));
  await snapshot;
  await closeSocket(socket);
  await waitForDirectoryDevice(
    fixture,
    account.token,
    deviceId,
    (device) => device.daemon === null && device.client?.connected === false,
  );
}

function setStaleStoredDaemonConnected(fixture: RelayFixture, deviceId: string, connected: boolean) {
  const storePath = join(fixture.dataDir, 'store.json');
  const data = JSON.parse(readFileSync(storePath, 'utf8')) as {
    devices?: Array<Record<string, unknown>>;
  };
  const device = data.devices?.find((candidate) => candidate.deviceId === deviceId);
  if (!device) throw new Error(`fixture device not found: ${deviceId}`);
  device.daemonConnected = connected;
  writeFileSync(storePath, JSON.stringify(data, null, 2));
}

afterEach(async () => {
  await closeOwnedSockets();
  const fixture = currentFixture;
  currentFixture = null;
  if (fixture) {
    await stopRelayFixture(fixture, true);
  }
});

describe('relay cli slot config and exact device cleanup API', () => {
  it('returns an explicit never-configured state without creating a cloud file', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'never-configured');
    const cloudFile = join(fixture.dataDir, 'cli-slot-config.json');

    expect(existsSync(cloudFile)).toBe(false);
    const response = await getSlots(fixture, account.token);
    expectSlotSuccess(response, account.id, { configured: false });
    expect(existsSync(cloudFile)).toBe(false);
  });

  it('round-trips full state and preserves aliases and opaque target identities exactly', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'round-trip');
    const slots = [
      slot(4, {
        alias: 'Opaque target',
        server: {
          deviceId: 'device:alpha/01 ',
          daemonHostId: 'host:alpha/01 ',
          displayName: 'Studio / alpha',
        },
        session: {
          backend: 'herdr',
          stableId: 'stable:alpha/01 ',
          name: 'workbench',
        },
        widthMode: 'mirror-fixed',
      }),
      slot(9, {
        alias: 'Second account machine',
        session: {
          backend: 'tmux',
          stableId: 'stable:beta/02',
          name: 'main',
        },
      }),
    ];

    const put = await putAll(fixture, account.token, slots);
    expectSlotSuccess(put, account.id, { configured: true, slots });
    const get = await getSlots(fixture, account.token);
    expectSlotSuccess(get, account.id, { configured: true, slots });

    const cloudFile = join(fixture.dataDir, 'cli-slot-config.json');
    expect(existsSync(cloudFile)).toBe(true);
    const persisted = readFileSync(cloudFile, 'utf8');
    expect(persisted).toContain('device:alpha/01 ');
    expect(persisted).toContain('stable:alpha/01 ');
    expect(persisted).not.toContain(account.token);
    expect(persisted).not.toContain('accessToken');
    expect(persisted).not.toContain('passwordHash');
  });

  it('preserves other slots on a single update and creates configured state from never configured', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'single-update');
    const first = slot(1);
    const second = slot(2);
    const third = slot(3);

    const initial = await putAll(fixture, account.token, [first, second]);
    expectSlotSuccess(initial, account.id, { configured: true, slots: [first, second] });
    const single = await putSingle(fixture, account.token, 3, bindingOf(third));
    expectSlotSuccess(single, account.id, { configured: true, slots: [first, second, third] });

    const read = await getSlots(fixture, account.token);
    expectSlotSuccess(read, account.id, { configured: true, slots: [first, second, third] });

    const other = await registerAndLogin(fixture, 'single-first-write');
    const firstWrite = await putSingle(fixture, other.token, 7, bindingOf(slot(7)));
    expectSlotSuccess(firstWrite, other.id, { configured: true, slots: [slot(7)] });
  });

  it('replaces the whole slot map and distinguishes explicit empty from never configured', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'full-replace');
    const initial = [slot(1), slot(2), slot(3)];
    const replacement = [slot(2, { alias: 'Replacement only' })];

    const put = await putAll(fixture, account.token, initial);
    expectSlotSuccess(put, account.id, { configured: true, slots: initial });
    const replaced = await putAll(fixture, account.token, replacement);
    expectSlotSuccess(replaced, account.id, { configured: true, slots: replacement });
    const read = await getSlots(fixture, account.token);
    expectSlotSuccess(read, account.id, { configured: true, slots: replacement });

    const cleared = await putAll(fixture, account.token, []);
    expectSlotSuccess(cleared, account.id, { configured: true, slots: [] });
    const clearedRead = await getSlots(fixture, account.token);
    expectSlotSuccess(clearedRead, account.id, { configured: true, slots: [] });

    const other = await registerAndLogin(fixture, 'full-replace-other');
    const otherRead = await getSlots(fixture, other.token);
    expectSlotSuccess(otherRead, other.id, { configured: false });
  });

  it('isolates two accounts and rejects forged ownership fields', async () => {
    const fixture = await bootRelayFixture();
    const accountA = await registerAndLogin(fixture, 'account-a');
    const accountB = await registerAndLogin(fixture, 'account-b');
    const slotA = slot(1, { alias: 'Account A slot' });
    const slotB = slot(1, { alias: 'Account B slot' });

    const writeA = await putAll(fixture, accountA.token, [slotA]);
    expectSlotSuccess(writeA, accountA.id, { configured: true, slots: [slotA] });
    const bBeforeWrite = await getSlots(fixture, accountB.token);
    expectSlotSuccess(bBeforeWrite, accountB.id, { configured: false });

    const writeB = await putAll(fixture, accountB.token, [slotB]);
    expectSlotSuccess(writeB, accountB.id, { configured: true, slots: [slotB] });
    const aAfterB = await getSlots(fixture, accountA.token);
    const bAfterB = await getSlots(fixture, accountB.token);
    expectSlotSuccess(aAfterB, accountA.id, { configured: true, slots: [slotA] });
    expectSlotSuccess(bAfterB, accountB.id, { configured: true, slots: [slotB] });

    const forgedTopLevel = await putAll(fixture, accountA.token, [slot(2)], {
      userId: accountB.id,
      tokens: ['forged-token'],
    });
    expectApiError(forgedTopLevel, 400, ['invalid_request', 'invalid_slot_config']);

    const forgedSingle = await putSingle(fixture, accountA.token, 2, {
      ...bindingOf(slot(2)),
      userId: accountB.id,
    });
    expectApiError(forgedSingle, 400, ['invalid_request', 'invalid_slot_config']);

    const finalA = await getSlots(fixture, accountA.token);
    const finalB = await getSlots(fixture, accountB.token);
    expectSlotSuccess(finalA, accountA.id, { configured: true, slots: [slotA] });
    expectSlotSuccess(finalB, accountB.id, { configured: true, slots: [slotB] });
  });

  it('requires bearer authentication for every new route and rejects query-token authentication', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'auth');
    const requests = [
      { method: 'GET', path: '/api/cli/slots', body: undefined },
      { method: 'PUT', path: '/api/cli/slots', body: fullBody([slot(1)]) },
      { method: 'PUT', path: '/api/cli/slots/1', body: singleBody(bindingOf(slot(1))) },
      { method: 'POST', path: '/api/devices/cleanup', body: { deviceIds: ['device-auth'] } },
    ];

    for (const request of requests) {
      const noBearer = await requestJson(fixture, request.path, {
        method: request.method,
        headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      expectApiError(noBearer, 401, 'auth_invalid');

      const queryOnly = await requestJson(
        fixture,
        `${request.path}?token=${encodeURIComponent(account.token)}`,
        {
          method: request.method,
          headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        },
      );
      expectApiError(queryOnly, 401, 'auth_invalid');

      const wrongScheme = await requestJson(fixture, request.path, {
        method: request.method,
        headers: {
          authorization: `Token ${account.token}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      expectApiError(wrongScheme, 401, 'auth_invalid');
    }
  });

  it('rejects invalid slot payloads without mutating committed state', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'invalid-slots');
    const original = [slot(1, { alias: 'Original' })];
    const valid = await putAll(fixture, account.token, original);
    expectSlotSuccess(valid, account.id, { configured: true, slots: original });

    const invalidRequests: Array<{ path: string; body: unknown }> = [
      { path: '/api/cli/slots', body: { slots: [slot(2)] } },
      { path: '/api/cli/slots', body: { schemaVersion: 2, slots: [slot(2)] } },
      { path: '/api/cli/slots', body: fullBody([slot(2)], { userId: 'forged-user' }) },
      { path: '/api/cli/slots', body: fullBody([slot(2)], { tokens: ['forged-token'] }) },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { server: { ...slot(2).server, ownerId: 'forged-owner' } } as any)]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { session: { ...slot(2).session, token: 'forged-token' } } as any)]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { session: { ...slot(2).session, backend: 'shell' } } as any)]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { widthMode: 'fixed' } as any)]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { server: { ...slot(2).server, deviceId: '   ' } })]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { server: { ...slot(2).server, deviceId: 'x'.repeat(1_025) } })]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { server: { ...slot(2).server, displayName: 'bad\u0001name' } })]),
      },
      {
        path: '/api/cli/slots',
        body: fullBody([slot(2, { alias: 'bad\u0007alias' })]),
      },
      {
        path: '/api/cli/slots/2',
        body: singleBody({ ...bindingOf(slot(2)), slot: 2 }),
      },
      { path: '/api/cli/slots/2', body: { schemaVersion: 1 } },
    ];

    for (const request of invalidRequests) {
      const response = await apiRequest(fixture, 'PUT', request.path, {
        token: account.token,
        body: request.body,
      });
      expectApiError(response, 400, ['invalid_request', 'invalid_slot_config']);
    }

    const finalRead = await getSlots(fixture, account.token);
    expectSlotSuccess(finalRead, account.id, { configured: true, slots: original });
  });

  it('enforces slot bounds and the 128 KiB request limit', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'bounds');
    const twentySlots = Array.from({ length: 20 }, (_, index) => slot(index + 1));

    const maximum = await putAll(fixture, account.token, twentySlots);
    expectSlotSuccess(maximum, account.id, { configured: true, slots: twentySlots });

    const invalidLists = [
      [slot(1), slot(1)],
      [slot(0)],
      [slot(21)],
      [...twentySlots, slot(1)],
    ];
    for (const slots of invalidLists) {
      const response = await putAll(fixture, account.token, slots);
      expectApiError(response, 400, ['invalid_slot_config', 'invalid_request']);
    }

    const invalidSingle = await putSingle(fixture, account.token, 21, bindingOf(slot(21)));
    expectApiError(invalidSingle, 400, ['invalid_slot_config', 'invalid_request']);

    const stateBeforeOversize = await getSlots(fixture, account.token);
    expectSlotSuccess(stateBeforeOversize, account.id, { configured: true, slots: twentySlots });

    const oversizeBody = JSON.stringify(fullBody([slot(1, { alias: 'x'.repeat(140 * 1_024) })]));
    expect(Buffer.byteLength(oversizeBody)).toBeGreaterThan(128 * 1_024);
    const oversize = await apiRequest(fixture, 'PUT', '/api/cli/slots', {
      token: account.token,
      rawBody: oversizeBody,
    });
    expectApiError(oversize, 413, 'request_too_large');

    const stateAfterOversize = await getSlots(fixture, account.token);
    expectSlotSuccess(stateAfterOversize, account.id, { configured: true, slots: twentySlots });
  });

  it('persists accepted state across restart and unrelated login and presence writers', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'restart');
    const slots = [
      slot(5, {
        alias: 'Restart exact target',
        server: {
          deviceId: 'device:restart/01 ',
          daemonHostId: 'host:restart/01 ',
          displayName: 'Restart display',
        },
        session: {
          backend: 'herdr',
          stableId: 'stable:restart/01 ',
          name: 'restart-session',
        },
        widthMode: 'mirror-fixed',
      }),
    ];
    const put = await putAll(fixture, account.token, slots);
    expectSlotSuccess(put, account.id, { configured: true, slots });

    await loginAgain(fixture, account);
    await createOfflineDaemon(
      fixture,
      account,
      uniqueName('restart-host'),
      uniqueName('restart-device'),
    );

    const restarted = await restartRelayFixture(fixture);
    const read = await getSlots(restarted, account.token);
    expectSlotSuccess(read, account.id, { configured: true, slots });
    expect(existsSync(join(restarted.dataDir, 'cli-slot-config.json'))).toBe(true);
    const persisted = readFileSync(join(restarted.dataDir, 'cli-slot-config.json'), 'utf8');
    expect(persisted).not.toContain(account.token);
  });

  it('cleans offline account-owned daemon records and reports exact absence on retry', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'cleanup-basic');
    const deviceId = uniqueName('cleanup-basic-device');
    const hostId = uniqueName('cleanup-basic-host');
    const cloudSlots = [slot(12, { alias: 'Cloud state survives cleanup' })];
    const put = await putAll(fixture, account.token, cloudSlots);
    expectSlotSuccess(put, account.id, { configured: true, slots: cloudSlots });

    await createOfflineDaemon(fixture, account, hostId, deviceId);
    const removed = await cleanupDevices(fixture, account.token, [deviceId]);
    expectCleanupSuccess(removed, account.id, [deviceId], []);
    await expectDirectoryDeviceMissing(fixture, account.token, deviceId);

    const retry = await cleanupDevices(fixture, account.token, [deviceId]);
    expectCleanupSuccess(retry, account.id, [], [deviceId]);
    await expectDirectoryDeviceMissing(fixture, account.token, deviceId);

    const me = await apiRequest(fixture, 'GET', '/api/auth/me', { token: account.token });
    expect(me.status).toBe(200);
    expect(me.body?.user?.id).toBe(account.id);
    const slotsAfterCleanup = await getSlots(fixture, account.token);
    expectSlotSuccess(slotsAfterCleanup, account.id, { configured: true, slots: cloudSlots });
  });

  it('rejects mixed cleanup batches atomically and protects foreign, client-only, and online records', async () => {
    const fixture = await bootRelayFixture();
    const accountA = await registerAndLogin(fixture, 'cleanup-a');
    const accountB = await registerAndLogin(fixture, 'cleanup-b');
    const aOffline = uniqueName('a-offline');
    const aClient = uniqueName('a-client');
    const aOnline = uniqueName('a-online');
    const bForeign = uniqueName('b-foreign');
    const bClient = uniqueName('b-client');

    await createOfflineDaemon(fixture, accountA, uniqueName('a-offline-host'), aOffline);
    await createOfflineDaemon(fixture, accountB, uniqueName('b-foreign-host'), bForeign);
    await createOfflineClientOnly(fixture, accountA, aClient);
    await createOfflineClientOnly(fixture, accountB, bClient);
    const onlineSocket = await connectHostAndPublish(
      fixture,
      accountA,
      uniqueName('a-online-host'),
      aOnline,
      'a-online-session',
    );

    const foreignMixed = await cleanupDevices(fixture, accountA.token, [aOffline, bForeign]);
    expectApiError(foreignMixed, 409, 'device_cleanup_rejected');
    await expectDirectoryDevicePresent(fixture, accountA.token, aOffline);
    await expectDirectoryDevicePresent(fixture, accountB.token, bForeign);

    const foreignClientMixed = await cleanupDevices(fixture, accountA.token, [aOffline, bClient]);
    expectApiError(foreignClientMixed, 409, 'device_cleanup_rejected');
    await expectDirectoryDevicePresent(fixture, accountA.token, aOffline);
    await expectDirectoryDevicePresent(fixture, accountB.token, bClient);

    const ownClientMixed = await cleanupDevices(fixture, accountA.token, [aOffline, aClient]);
    expectApiError(ownClientMixed, 409, 'device_cleanup_rejected');
    await expectDirectoryDevicePresent(fixture, accountA.token, aOffline);
    await expectDirectoryDevicePresent(fixture, accountA.token, aClient);

    const onlineMixed = await cleanupDevices(fixture, accountA.token, [aOffline, aOnline]);
    expectApiError(onlineMixed, 409, 'device_cleanup_rejected');
    await expectDirectoryDevicePresent(fixture, accountA.token, aOffline);
    await waitForDirectoryDevice(
      fixture,
      accountA.token,
      aOnline,
      (device) => device.daemon?.presence?.connected === true,
    );

    const removedOffline = await cleanupDevices(fixture, accountA.token, [aOffline]);
    expectCleanupSuccess(removedOffline, accountA.id, [aOffline], []);
    await expectDirectoryDeviceMissing(fixture, accountA.token, aOffline);
    await expectDirectoryDevicePresent(fixture, accountB.token, bForeign);
    await expectDirectoryDevicePresent(fixture, accountA.token, aClient);
    await expectDirectoryDevicePresent(fixture, accountB.token, bClient);
    await expectDirectoryDevicePresent(fixture, accountA.token, aOnline);

    await closeSocket(onlineSocket);
    await waitForDirectoryDevice(
      fixture,
      accountA.token,
      aOnline,
      (device) => device.daemon?.presence?.connected === false,
    );
    const removedOnline = await cleanupDevices(fixture, accountA.token, [aOnline]);
    expectCleanupSuccess(removedOnline, accountA.id, [aOnline], []);

    const retry = await cleanupDevices(fixture, accountA.token, [aOffline]);
    expectCleanupSuccess(retry, accountA.id, [], [aOffline]);
    const meB = await apiRequest(fixture, 'GET', '/api/auth/me', { token: accountB.token });
    expect(meB.status).toBe(200);
    expect(meB.body?.user?.id).toBe(accountB.id);
  });

  it('does not resurrect stale on-disk daemon presence after restart', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'stored-online');
    const deviceId = uniqueName('stored-online-device');
    await createOfflineDaemon(fixture, account, uniqueName('stored-online-host'), deviceId);

    await stopRelayFixture(fixture, false);
    setStaleStoredDaemonConnected(fixture, deviceId, true);
    const restarted = await startRelayFixture(fixture.tempRoot);
    currentFixture = restarted;

    await waitForDirectoryDevice(
      restarted,
      account.token,
      deviceId,
      (device) => device.daemon?.presence?.connected === false,
    );
    const removed = await cleanupDevices(restarted, account.token, [deviceId]);
    expectCleanupSuccess(removed, account.id, [deviceId], []);
    await expectDirectoryDeviceMissing(restarted, account.token, deviceId);
  });

  it('rejects a completed reconnect before cleanup and permits registration after deletion', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'reconnect');
    const hostId = uniqueName('reconnect-host');
    const deviceId = uniqueName('reconnect-device');

    await createOfflineDaemon(fixture, account, hostId, deviceId);
    const reconnected = await connectHostAndPublish(
      fixture,
      account,
      hostId,
      deviceId,
      'reconnected-session',
    );
    const rejected = await cleanupDevices(fixture, account.token, [deviceId]);
    expectApiError(rejected, 409, 'device_cleanup_rejected');
    await waitForDirectoryDevice(
      fixture,
      account.token,
      deviceId,
      (device) => device.daemon?.presence?.connected === true,
    );

    await closeSocket(reconnected);
    await waitForDirectoryDevice(
      fixture,
      account.token,
      deviceId,
      (device) => device.daemon?.presence?.connected === false,
    );
    const removed = await cleanupDevices(fixture, account.token, [deviceId]);
    expectCleanupSuccess(removed, account.id, [deviceId], []);
    await expectDirectoryDeviceMissing(fixture, account.token, deviceId);

    const registeredAgain = await connectHostAndPublish(
      fixture,
      account,
      hostId,
      deviceId,
      'registered-after-cleanup',
    );
    await waitForDirectoryDevice(
      fixture,
      account.token,
      deviceId,
      (device) => device.daemon?.presence?.connected === true,
    );
    await closeSocket(registeredAgain);
  });

  it('rejects invalid cleanup device sets', async () => {
    const fixture = await bootRelayFixture();
    const account = await registerAndLogin(fixture, 'cleanup-invalid');
    const invalidBodies: unknown[] = [
      { deviceIds: [] },
      { deviceIds: ['same', 'same'] },
      { deviceIds: [''] },
      { deviceIds: [' device-with-whitespace '] },
      { deviceIds: Array.from({ length: 101 }, (_, index) => `device-${index}`) },
      { deviceIds: ['device-1'], userId: 'forged-user' },
      { deviceIds: 'device-1' },
    ];

    for (const body of invalidBodies) {
      const response = await apiRequest(fixture, 'POST', '/api/devices/cleanup', {
        token: account.token,
        body,
      });
      expectApiError(response, 400, 'invalid_device_set');
    }

    const me = await apiRequest(fixture, 'GET', '/api/auth/me', { token: account.token });
    expect(me.status).toBe(200);
    expect(me.body?.user?.id).toBe(account.id);
  });
});
