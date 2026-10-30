/**
 * Two-daemon real WebSocket gate for the zterm `/app` transport.
 *
 * Each test daemon runs the product gateway/store/messaging owners on an
 * isolated port, identity, token, and HOME. The public CLI binary under test is
 * the packed workspace build in `packages/cli/dist/main.mjs`, or the installed
 * entry named by `APP_E2E_CLI_BIN` when that override is set.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  APP_FILE_CHUNK_BYTES,
  APP_MAX_MESSAGE_BYTES,
  encodeAppPathSegment,
  type AppFileMetadata,
  type AppServerFrame,
} from '../../packages/shared/src/connection/app-protocol';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACE_CLI_BIN = join(REPO_ROOT, 'packages/cli/dist/main.mjs');
const INSTALLED_CLI_BIN = process.env.APP_E2E_CLI_BIN
  ? resolve(process.env.APP_E2E_CLI_BIN)
  : null;
const CLI_COMMAND = INSTALLED_CLI_BIN ?? process.execPath;
const CLI_ARG_PREFIX = INSTALLED_CLI_BIN ? [] : [WORKSPACE_CLI_BIN];
const CLI_SHELL = process.platform === 'win32'
  && INSTALLED_CLI_BIN !== null
  && /\.(cmd|bat)$/i.test(INSTALLED_CLI_BIN);
const DAEMON_SCRIPT = join(REPO_ROOT, 'android/scripts/app-messaging-test-daemon.ts');
const ROOT = process.env.APP_E2E_ROOT
  ? resolve(process.env.APP_E2E_ROOT)
  : join(REPO_ROOT, 'android/evidence/app-messaging-e2e', String(Date.now()));

const TOKEN_A = 'e2e-token-a-7f1c';
const TOKEN_B = 'e2e-token-b-9a2d';
const DEVICE_A = 'e2e-device-a';
const DEVICE_B = 'e2e-device-b';
const DEVICE_C = 'e2e-device-c';
const HOST_A = 'e2e-daemon-a';
const HOST_B = 'e2e-daemon-b';
const HOST_C = 'e2e-daemon-c';
const USER_ID = 'e2e-user';

function cliCommandLine(args: string[]) {
  return [...CLI_ARG_PREFIX, ...args];
}

type Daemon = {
  name: string;
  home: string;
  port: number;
  deviceId: string;
  daemonHostId: string;
  token: string;
  child: ReturnType<typeof spawn>;
};

type DirectoryDevice = {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  client: { connected: boolean; lastSeenAt: string };
  daemon: {
    hostId: string;
    version: string;
    presence: { connected: boolean; lastSeenAt: string };
    endpoints: Array<Record<string, unknown>>;
    sessions: never[];
    lastPublishedAt: string;
  };
};

const events: string[] = [];
function event(name: string, detail: Record<string, unknown> = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event: name, ...detail });
  events.push(line);
  console.log(line);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`E2E assertion failed: ${message}`);
}

async function assertCliEntry() {
  if (!INSTALLED_CLI_BIN) {
    event('cli.bin', { mode: 'workspace', command: process.execPath, entry: WORKSPACE_CLI_BIN });
    return;
  }
  const info = await stat(INSTALLED_CLI_BIN).catch(() => null);
  assert(info, `APP_E2E_CLI_BIN does not exist: ${INSTALLED_CLI_BIN}`);
  assert(info.isFile(), `APP_E2E_CLI_BIN is not a file: ${INSTALLED_CLI_BIN}`);
  if (process.platform !== 'win32') {
    assert((info.mode & 0o111) !== 0, `APP_E2E_CLI_BIN is not executable: ${INSTALLED_CLI_BIN}`);
  }
  event('cli.bin', { mode: 'installed', command: INSTALLED_CLI_BIN, entry: INSTALLED_CLI_BIN, shell: CLI_SHELL });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function wait(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) {
    await wait(50);
  }
  return child.exitCode;
}

async function portReady(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(false));
  });
}

async function waitForPort(port: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portReady(port)) return;
    await wait(100);
  }
  throw new Error(`port ${port} did not become ready`);
}

async function waitForPortClosed(port: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portReady(port))) return;
    await wait(100);
  }
  throw new Error(`port ${port} did not close`);
}

function daemonEnv(daemon: Omit<Daemon, 'child'> & { home: string }, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: daemon.home,
    TMPDIR: '/tmp',
    APP_TEST_PORT: String(daemon.port),
    ZTERM_AUTH_TOKEN: daemon.token,
    ZTERM_TRAVERSAL_DEVICE_ID: daemon.deviceId,
    ZTERM_TRAVERSAL_HOST_ID: daemon.daemonHostId,
    ZTERM_APP_ROOT: join(daemon.home, '.zterm'),
    ...extra,
  };
}

async function startDaemon(
  spec: Omit<Daemon, 'child'>,
  logName: string,
  extraEnv: Record<string, string> = {},
): Promise<Daemon> {
  const logPath = join(ROOT, `${logName}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const out = await import('node:fs').then((fs) => fs.createWriteStream(logPath));
  const err = await import('node:fs').then((fs) => fs.createWriteStream(logPath, { flags: 'a' }));
  const child = spawn(process.execPath, ['--import', 'tsx', DAEMON_SCRIPT], {
    cwd: join(REPO_ROOT, 'android'),
    env: daemonEnv(spec, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(err);
  const daemon: Daemon = { ...spec, child };
  await waitForPort(spec.port);
  event('daemon.ready', { name: spec.name, port: spec.port, pid: child.pid, log: logPath });
  return daemon;
}

async function stopDaemon(daemon: Daemon) {
  const pid = daemon.child.pid;
  if (!pid) return;
  if (daemon.child.exitCode === null) {
    daemon.child.kill('SIGTERM');
    await waitForExit(daemon.child, 5_000);
  }
  await waitForPortClosed(daemon.port);
  event('daemon.stopped', { name: daemon.name, pid, port: daemon.port });
}

async function writeHomeConfig(daemon: Omit<Daemon, 'child'>, accountBaseUrl: string) {
  await mkdir(join(daemon.home, '.zterm'), { recursive: true });
  await writeFile(join(daemon.home, '.zterm', 'config.json'), JSON.stringify({
    zterm: {
      android: {
        daemon: {
          host: '127.0.0.1',
          port: daemon.port,
          authToken: daemon.token,
        },
        relay: {
          hostId: daemon.daemonHostId,
          deviceId: daemon.deviceId,
        },
      },
      cli: {
        authGeneration: 1,
        server: { relayBaseUrl: accountBaseUrl },
        auth: {
          loginId: 'e2e-login',
          userId: USER_ID,
          username: 'e2e',
          accessToken: 'e2e-access-token',
          authenticatedAt: new Date(0).toISOString(),
        },
      },
    },
  }, null, 2));
}

type CliResult = { code: number; stdout: string; stderr: string };

function parseNdjson(stdout: string): AppServerFrame[] {
  return stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AppServerFrame);
}

async function runCli(
  daemon: Omit<Daemon, 'child'>,
  args: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  const child = spawn(CLI_COMMAND, cliCommandLine(args), {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: daemon.home,
      ZTERM_HOST: '127.0.0.1',
      ZTERM_PORT: String(daemon.port),
      ZTERM_AUTH_TOKEN: daemon.token,
      ZTERM_TRAVERSAL_DEVICE_ID: daemon.deviceId,
      ZTERM_TRAVERSAL_HOST_ID: daemon.daemonHostId,
    },
    shell: CLI_SHELL,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end(options.stdin ?? '');
  const code = await waitForExit(child, options.timeoutMs ?? 30_000);
  if (code === null) {
    child.kill('SIGKILL');
    await wait(200);
  }
  await wait(20);
  return { code: code ?? -1, stdout, stderr };
}

function directoryDevice(spec: {
  deviceId: string;
  daemonHostId: string;
  port: number;
  token: string;
}): DirectoryDevice {
  const seen = new Date().toISOString();
  return {
    deviceId: spec.deviceId,
    deviceName: spec.deviceId,
    platform: 'test',
    appVersion: 'test',
    client: { connected: true, lastSeenAt: seen },
    daemon: {
      hostId: spec.daemonHostId,
      version: 'test',
      presence: { connected: true, lastSeenAt: seen },
      endpoints: [{
        id: `lan-${spec.port}`,
        kind: 'lan',
        authRequired: true,
        lastSeenAt: seen,
        host: '127.0.0.1',
        port: spec.port,
        authToken: spec.token,
      }],
      sessions: [],
      lastPublishedAt: seen,
    },
  };
}

async function startAccountStub(port: number) {
  const devices = new Map<string, DirectoryDevice>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.headers.authorization !== 'Bearer e2e-access-token') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const user = { id: USER_ID, username: 'e2e' };
    if (url.pathname === '/api/auth/me' || url.pathname === '/api/directory') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        user,
        directory: {
          schemaVersion: 1,
          user,
          updatedAt: new Date().toISOString(),
          devices: [...devices.values()],
        },
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  return { server, devices };
}

type PeerClient = {
  request: (frame: Record<string, unknown>) => Promise<AppServerFrame>;
  send: (frame: Record<string, unknown>) => void;
  close: () => void;
  terminate: () => void;
};

async function connectPeer(input: {
  port: number;
  token: string;
  senderDeviceId: string;
  senderDaemonHostId: string;
}): Promise<PeerClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${input.port}/app`, {
    headers: { Authorization: `Bearer ${input.token}` },
  });
  const pending = new Map<string, (frame: AppServerFrame) => void>();
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as AppServerFrame;
    const requestId = 'requestId' in frame.payload ? (frame.payload as { requestId?: string }).requestId : undefined;
    if (requestId) {
      pending.get(requestId)?.(frame);
      pending.delete(requestId);
    }
  });
  await new Promise<void>((done, fail) => {
    ws.once('open', () => done());
    ws.once('error', fail);
  });
  const helloId = `hello-${randomUUID()}`;
  const readyPromise = new Promise<AppServerFrame>((done) => pending.set(helloId, done));
  ws.send(JSON.stringify({
    type: 'app-hello',
    payload: {
      protocolVersion: 1,
      requestId: helloId,
      role: 'peer',
      clientInstanceId: `e2e-peer-${randomUUID()}`,
      deviceId: input.senderDeviceId,
      daemonHostId: input.senderDaemonHostId,
      capabilities: {},
    },
  }));
  const ready = await readyPromise;
  assert(ready.type === 'app-ready', `peer handshake returned ${ready.type}`);
  return {
    request(frame) {
      const payload = frame.payload as { requestId: string };
      return new Promise<AppServerFrame>((done) => {
        pending.set(payload.requestId, done);
        ws.send(JSON.stringify(frame));
      });
    },
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
    close() {
      ws.close();
    },
    terminate() {
      ws.terminate();
    },
  };
}

type LocalSubscriber = {
  readonly frames: AppServerFrame[];
  waitForFrame: (predicate: (frame: AppServerFrame) => boolean, timeoutMs?: number) => Promise<AppServerFrame>;
  waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  request: (frame: Record<string, unknown>) => Promise<AppServerFrame>;
  pause: () => void;
  resume: () => void;
  close: () => void;
  terminate: () => void;
};

type FrameWaiter = {
  predicate: (frame: AppServerFrame) => boolean;
  resolve: (frame: AppServerFrame) => void;
  reject: (error: Error) => void;
};

type CloseWaiter = {
  resolve: (info: { code: number; reason: string }) => void;
  reject: (error: Error) => void;
};

async function connectLocalSubscriber(input: {
  name: string;
  port: number;
  token: string;
  deviceId: string;
  daemonHostId: string;
}): Promise<LocalSubscriber> {
  const ws = new WebSocket(`ws://127.0.0.1:${input.port}/app`, {
    headers: { Authorization: `Bearer ${input.token}` },
  });
  const frames: AppServerFrame[] = [];
  const frameWaiters = new Set<FrameWaiter>();
  const closeWaiters = new Set<CloseWaiter>();
  let closeInfo: { code: number; reason: string } | null = null;

  function waitForFrame(predicate: (frame: AppServerFrame) => boolean, timeoutMs = 15_000) {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<AppServerFrame>((resolve, reject) => {
      let waiter: FrameWaiter;
      const timer = setTimeout(() => {
        frameWaiters.delete(waiter);
        reject(new Error(`local subscriber ${input.name} did not receive the expected frame within ${timeoutMs} ms`));
      }, timeoutMs);
      waiter = {
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      frameWaiters.add(waiter);
    });
  }

  function waitForClose(timeoutMs = 20_000) {
    if (closeInfo) return Promise.resolve(closeInfo);
    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      let waiter: CloseWaiter;
      const timer = setTimeout(() => {
        closeWaiters.delete(waiter);
        reject(new Error(`local subscriber ${input.name} did not close within ${timeoutMs} ms`));
      }, timeoutMs);
      waiter = {
        resolve: (info) => {
          clearTimeout(timer);
          resolve(info);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      closeWaiters.add(waiter);
    });
  }

  ws.on('message', (raw) => {
    let frame: AppServerFrame;
    try {
      frame = JSON.parse(raw.toString()) as AppServerFrame;
    } catch {
      return;
    }
    frames.push(frame);
    for (const waiter of [...frameWaiters]) {
      if (!waiter.predicate(frame)) continue;
      frameWaiters.delete(waiter);
      waiter.resolve(frame);
    }
  });

  ws.on('close', (code, reason) => {
    const info = { code, reason: reason.toString() };
    closeInfo = info;
    for (const waiter of [...closeWaiters]) {
      closeWaiters.delete(waiter);
      waiter.resolve(info);
    }
    for (const waiter of [...frameWaiters]) {
      frameWaiters.delete(waiter);
      waiter.reject(new Error(`local subscriber ${input.name} closed (${info.code} ${info.reason}) before the expected frame`));
    }
  });

  ws.on('error', () => {
    // The close event carries the actionable code and reason.
  });

  try {
    await new Promise<void>((resolve, reject) => {
      function onOpen() {
        ws.off('error', onError);
        resolve();
      }
      function onError(error: Error) {
        ws.off('open', onOpen);
        reject(error);
      }
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    const helloId = `local-hello-${randomUUID()}`;
    ws.send(JSON.stringify({
      type: 'app-hello',
      payload: {
        protocolVersion: 1,
        requestId: helloId,
        role: 'local',
        clientInstanceId: `e2e-local-${randomUUID()}`,
        deviceId: input.deviceId,
        daemonHostId: input.daemonHostId,
        capabilities: {},
      },
    }));
    const ready = await waitForFrame((frame) => frame.type === 'app-ready' && frame.payload.requestId === helloId);
    assert(ready.type === 'app-ready', `local subscriber ${input.name} handshake returned ${ready.type}`);
  } catch (error) {
    ws.terminate();
    throw error;
  }

  return {
    frames,
    waitForFrame,
    waitForClose,
    request(frame) {
      const payload = frame.payload as { requestId: string };
      const response = waitForFrame((candidate) =>
        'requestId' in candidate.payload
        && (candidate.payload as { requestId?: string }).requestId === payload.requestId,
      );
      ws.send(JSON.stringify(frame));
      return response;
    },
    pause() {
      ws.pause();
    },
    resume() {
      ws.resume();
    },
    close() {
      ws.close();
    },
    terminate() {
      ws.terminate();
    },
  };
}

async function connectUnauthorized(port: number, token?: string) {
  return new Promise<number>((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/app`, token ? {
      headers: { Authorization: `Bearer ${token}` },
    } : {});
    ws.once('unexpected-response', (_request, response) => {
      done(response.statusCode ?? 0);
      response.resume();
    });
    ws.once('open', () => {
      ws.terminate();
      fail(new Error('unauthorized /app upgrade unexpectedly succeeded'));
    });
    ws.once('error', (error) => {
      if (!String(error.message).includes('401')) fail(error);
    });
  });
}

async function readInboxRecord(home: string, senderDaemonHostId: string, messageId: string) {
  const path = join(
    home,
    '.zterm/app-inbox/records',
    encodeAppPathSegment(senderDaemonHostId),
    encodeAppPathSegment(messageId),
    'record.json',
  );
  return JSON.parse(await readFile(path, 'utf8')) as {
    messageId: string;
    state: string;
    body?: string;
    file?: { absolutePath: string; sha256: string; totalBytes: number };
  };
}

async function expectFileAbsent(path: string) {
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new Error(`file should not be published before commit: ${path}`);
}

function fileMetadata(bytes: Buffer, transferId: string): AppFileMetadata {
  return {
    transferId,
    fileName: 'evidence.bin',
    totalBytes: bytes.length,
    chunkCount: Math.ceil(bytes.length / APP_FILE_CHUNK_BYTES),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  await assertCliEntry();
  await mkdir(ROOT, { recursive: true });
  event('e2e.start', { root: ROOT });
  const [portA, portB, portC, accountPort, proxyPort] = await Promise.all([
    freePort(), freePort(), freePort(), freePort(), freePort(),
  ]);
  const account = await startAccountStub(accountPort);
  const accountBaseUrl = `http://127.0.0.1:${accountPort}`;
  const homeA = join(ROOT, 'home-a');
  const homeB = join(ROOT, 'home-b');
  const homeC = join(ROOT, 'home-c');
  const specA = { name: 'A', home: homeA, port: portA, deviceId: DEVICE_A, daemonHostId: HOST_A, token: TOKEN_A };
  const specB = { name: 'B', home: homeB, port: portB, deviceId: DEVICE_B, daemonHostId: HOST_B, token: TOKEN_B };
  const specC = { name: 'C', home: homeC, port: portC, deviceId: DEVICE_C, daemonHostId: HOST_C, token: 'e2e-token-c' };
  await Promise.all([writeHomeConfig(specA, accountBaseUrl), writeHomeConfig(specB, accountBaseUrl), writeHomeConfig(specC, accountBaseUrl)]);
  account.devices.set(DEVICE_A, directoryDevice(specA));
  account.devices.set(DEVICE_B, directoryDevice(specB));
  account.devices.set(DEVICE_C, directoryDevice(specC));

  let daemonA: Daemon | null = null;
  let daemonB: Daemon | null = null;
  let daemonC: Daemon | null = null;
  let streamB: ReturnType<typeof spawn> | null = null;
  let slowSubscriber: LocalSubscriber | null = null;
  let ackSubscriber: LocalSubscriber | null = null;
  let freshSubscriber: LocalSubscriber | null = null;
  let burstPeer: PeerClient | null = null;
  const blackhole: Server = createServer();
  try {
    daemonA = await startDaemon(specA, 'daemon-a');
    daemonB = await startDaemon(specB, 'daemon-b');

    // 1. Background receive: B has no CLI stream while A sends.
    const messageId1 = `msg-${randomUUID()}`;
    const body1 = 'line one\nline two\n{"json":"exact"}\nno trailing change';
    const send1 = await runCli(specA, [
      'app', 'send', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', messageId1, '--subject', 'multiline', '--body', body1,
    ]);
    event('cli.send.result', { code: send1.code, stdout: send1.stdout.trim(), stderr: send1.stderr.trim() });
    assert(send1.code === 0, `A send exit ${send1.code}: ${send1.stderr}`);
    const sendFrame1 = parseNdjson(send1.stdout)[0];
    assert(sendFrame1?.type === 'app-send-result' && sendFrame1.payload.status === 'received', 'A send did not return received');
    const stored1 = await readInboxRecord(homeB, HOST_A, messageId1);
    assert(stored1.body === body1, 'B persisted body differs');
    assert(stored1.state === 'received', 'B durable state is not received');
    event('inbox.persisted', { messageId: messageId1, bytes: Buffer.byteLength(body1), state: stored1.state });

    // 2. Push on subscribe, ack, consume, status.
    streamB = spawn(CLI_COMMAND, cliCommandLine(['app', 'stream', '--json']), {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeB,
        ZTERM_HOST: '127.0.0.1',
        ZTERM_PORT: String(portB),
        ZTERM_AUTH_TOKEN: TOKEN_B,
        ZTERM_TRAVERSAL_DEVICE_ID: DEVICE_B,
        ZTERM_TRAVERSAL_HOST_ID: HOST_B,
      },
      shell: CLI_SHELL,
    });
    let streamOut = '';
    streamB.stdout!.on('data', (chunk) => {
      streamOut += chunk.toString('utf8');
    });
    let seenInbound: AppServerFrame | null = null;
    const pushDeadline = Date.now() + 10_000;
    while (Date.now() < pushDeadline) {
      const frames = streamOut.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AppServerFrame);
      seenInbound = frames.find((frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === messageId1) ?? null;
      if (seenInbound) break;
      await wait(100);
    }
    assert(seenInbound?.type === 'app-inbound-message', 'B stream did not receive pushed inbound message');
    assert(seenInbound.payload.body === body1, 'pushed body differs from sent body');
    streamB.stdin!.write(JSON.stringify({ type: 'ack', messageId: messageId1 }) + '\n');
    const ackDeadline = Date.now() + 10_000;
    let ackState = '';
    while (Date.now() < ackDeadline) {
      const frames = streamOut.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AppServerFrame);
      const status = frames.find((frame) => frame.type === 'app-status-result' && frame.payload.messageId === messageId1);
      if (status?.type === 'app-status-result' && status.payload.state) {
        ackState = status.payload.state;
        break;
      }
      await wait(100);
    }
    assert(ackState === 'delivered', `ack state was ${ackState}`);
    streamB.stdin!.end();
    await waitForExit(streamB, 5_000);
    event('inbox.ack', { messageId: messageId1, state: ackState });

    const consume1 = await runCli(specB, ['app', 'consume', '--message-id', messageId1]);
    assert(consume1.code === 0, `consume exit ${consume1.code}: ${consume1.stderr}`);
    const status1 = await runCli(specB, ['app', 'status', '--message-id', messageId1]);
    const statusFrame1 = parseNdjson(status1.stdout)[0];
    assert(statusFrame1?.type === 'app-status-result' && statusFrame1.payload.state === 'consumed', 'status did not report consumed');
    event('inbox.consume', { messageId: messageId1, state: 'consumed' });

    // 3. Restart persistence and replay of an unacknowledged record.
    await stopDaemon(daemonB);
    daemonB = await startDaemon(specB, 'daemon-b-restart-1');
    const statusAfterRestart = await runCli(specB, ['app', 'status', '--message-id', messageId1]);
    const statusFrame2 = parseNdjson(statusAfterRestart.stdout)[0];
    assert(statusFrame2?.type === 'app-status-result' && statusFrame2.payload.state === 'consumed', 'consumed record did not survive restart');
    const replayId = `msg-replay-${randomUUID()}`;
    const sendReplay = await runCli(specA, [
      'app', 'send', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', replayId, '--subject', 'replay', '--body', 'survive restart',
    ]);
    assert(sendReplay.code === 0, `replay send exit ${sendReplay.code}`);
    await stopDaemon(daemonB);
    daemonB = await startDaemon(specB, 'daemon-b-restart-2');
    const streamReplay = spawn(CLI_COMMAND, cliCommandLine(['app', 'stream', '--json']), {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeB,
        ZTERM_HOST: '127.0.0.1',
        ZTERM_PORT: String(portB),
        ZTERM_AUTH_TOKEN: TOKEN_B,
        ZTERM_TRAVERSAL_DEVICE_ID: DEVICE_B,
        ZTERM_TRAVERSAL_HOST_ID: HOST_B,
      },
      shell: CLI_SHELL,
    });
    let replayOut = '';
    streamReplay.stdout!.on('data', (chunk) => {
      replayOut += chunk.toString('utf8');
    });
    let replayCount = 0;
    const replayDeadline = Date.now() + 10_000;
    while (Date.now() < replayDeadline) {
      replayCount = replayOut.split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as AppServerFrame)
        .filter((frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === replayId).length;
      if (replayCount > 0) break;
      await wait(100);
    }
    assert(replayCount === 1, `restart replay produced ${replayCount} records`);
    streamReplay.stdin!.end();
    await waitForExit(streamReplay, 5_000);
    event('inbox.replay', { messageId: replayId, count: replayCount });

    // 4. Idempotent retry and conflicting content.
    const retry1 = await runCli(specA, [
      'app', 'send', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', messageId1, '--subject', 'multiline', '--body', body1,
    ]);
    assert(retry1.code === 0, `identical retry exit ${retry1.code}`);
    const conflict = await runCli(specA, [
      'app', 'send', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', messageId1, '--subject', 'multiline', '--body', `${body1}\nchanged`,
    ]);
    const conflictFrame = parseNdjson(conflict.stdout)[0];
    assert(conflict.code === 1 && conflictFrame?.type === 'app-error' && conflictFrame.payload.code === 'message_id_conflict', `conflict result was ${conflict.stdout}`);
    event('dedupe.verified', { messageId: messageId1, identicalCode: retry1.code, conflictCode: conflict.code });

    // 5. Files in both directions.
    const fileA = Buffer.alloc(40_000);
    for (let index = 0; index < fileA.length; index += 1) fileA[index] = (index * 31) % 251;
    const fileAPath = join(ROOT, 'a-file.bin');
    await writeFile(fileAPath, fileA);
    const fileAId = `file-a-${randomUUID()}`;
    const fileASend = await runCli(specA, [
      'app', 'send-file', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', fileAId, '--file', fileAPath, '--subject', 'file a to b',
    ], { timeoutMs: 60_000 });
    assert(fileASend.code === 0, `A->B file exit ${fileASend.code}: ${fileASend.stderr}`);
    const fileARecord = await readInboxRecord(homeB, HOST_A, fileAId);
    assert(fileARecord.file, 'A->B file record missing metadata');
    const fileABytes = await readFile(fileARecord.file.absolutePath);
    assert(fileABytes.equals(fileA), 'A->B published bytes differ');
    assert(sha256(fileABytes) === fileARecord.file.sha256, 'A->B published sha differs');
    event('file.received', { direction: 'A->B', messageId: fileAId, path: fileARecord.file.absolutePath, bytes: fileABytes.length });

    const fileB = Buffer.alloc(33_000, 7);
    const fileBPath = join(ROOT, 'b-file.bin');
    await writeFile(fileBPath, fileB);
    const fileBId = `file-b-${randomUUID()}`;
    const fileBSend = await runCli(specB, [
      'app', 'send-file', '--peer', DEVICE_A, '--daemon-host-id', HOST_A,
      '--message-id', fileBId, '--file', fileBPath, '--subject', 'file b to a',
    ], { timeoutMs: 60_000 });
    assert(fileBSend.code === 0, `B->A file exit ${fileBSend.code}: ${fileBSend.stderr}`);
    const fileBRecord = await readInboxRecord(homeA, HOST_B, fileBId);
    assert(fileBRecord.file, 'B->A file record missing metadata');
    assert((await readFile(fileBRecord.file.absolutePath)).equals(fileB), 'B->A published bytes differ');
    event('file.received', { direction: 'B->A', messageId: fileBId, path: fileBRecord.file.absolutePath, bytes: fileB.length });

    // 6. Interrupted transfer, duplicate chunk, conflicting duplicate, resume.
    const resumeBytes = Buffer.alloc(40_000);
    for (let index = 0; index < resumeBytes.length; index += 1) resumeBytes[index] = (index * 17) % 256;
    const resumeId = `file-resume-${randomUUID()}`;
    const resumeMeta = fileMetadata(resumeBytes, `transfer-${randomUUID()}`);
    let peer = await connectPeer({ port: portB, token: TOKEN_B, senderDeviceId: DEVICE_A, senderDaemonHostId: HOST_A });
    let frame = await peer.request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: resumeId, subject: 'resume', file: resumeMeta },
    });
    assert(frame.type === 'app-send-result' && frame.payload.status === 'receiving', 'file start was not receiving');
    for (const chunkIndex of [0, 1]) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = resumeBytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      frame = await peer.request({
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(), messageId: resumeId, transferId: resumeMeta.transferId,
          offset, chunkIndex, dataBase64: chunk.toString('base64'),
        },
      });
      assert(frame.type === 'app-send-result' && frame.payload.persistedOffset === offset + chunk.length, 'chunk did not persist');
    }
    peer.terminate();
    const partialPath = join(
      homeB,
      '.zterm/app-inbox/files',
      encodeAppPathSegment(HOST_A),
      encodeAppPathSegment(resumeId),
    );
    await expectFileAbsent(join(partialPath, resumeMeta.fileName));
    peer = await connectPeer({ port: portB, token: TOKEN_B, senderDeviceId: DEVICE_A, senderDaemonHostId: HOST_A });
    frame = await peer.request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: resumeId, subject: 'resume', file: resumeMeta },
    });
    assert(frame.type === 'app-send-result' && frame.payload.persistedOffset === APP_FILE_CHUNK_BYTES * 2, 'resume offset was not returned');
    const duplicate = resumeBytes.subarray(0, APP_FILE_CHUNK_BYTES);
    frame = await peer.request({
      type: 'app-send-file-chunk',
      payload: {
        requestId: randomUUID(), messageId: resumeId, transferId: resumeMeta.transferId,
        offset: 0, chunkIndex: 0, dataBase64: duplicate.toString('base64'),
      },
    });
    assert(frame.type === 'app-send-result' && frame.payload.persistedOffset === APP_FILE_CHUNK_BYTES * 2, 'duplicate chunk was not idempotent');
    const corrupted = Buffer.from(duplicate);
    corrupted[0] = (corrupted[0]! + 1) % 256;
    frame = await peer.request({
      type: 'app-send-file-chunk',
      payload: {
        requestId: randomUUID(), messageId: resumeId, transferId: resumeMeta.transferId,
        offset: 0, chunkIndex: 0, dataBase64: corrupted.toString('base64'),
      },
    });
    assert(frame.type === 'app-error' && frame.payload.code === 'chunk_conflict', 'conflicting duplicate chunk was accepted');
    for (let chunkIndex = 2; chunkIndex < resumeMeta.chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = resumeBytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      frame = await peer.request({
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(), messageId: resumeId, transferId: resumeMeta.transferId,
          offset, chunkIndex, dataBase64: chunk.toString('base64'),
        },
      });
      assert(frame.type === 'app-send-result', 'remaining chunk failed');
    }
    frame = await peer.request({
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId: resumeId, transferId: resumeMeta.transferId },
    });
    assert(frame.type === 'app-send-result' && frame.payload.status === 'received', 'resumed transfer did not commit');
    peer.close();
    const resumedRecord = await readInboxRecord(homeB, HOST_A, resumeId);
    assert(resumedRecord.file && (await readFile(resumedRecord.file.absolutePath)).equals(resumeBytes), 'resumed file bytes differ');
    event('file.resume', { messageId: resumeId, chunkCount: resumeMeta.chunkCount, duplicate: 'idempotent', conflict: 'chunk_conflict' });

    // 7. Commit crash window: all bytes durable, daemon restarts, commit succeeds.
    const crashBytes = Buffer.alloc(20_000, 3);
    const crashId = `file-crash-${randomUUID()}`;
    const crashMeta = fileMetadata(crashBytes, `transfer-${randomUUID()}`);
    peer = await connectPeer({ port: portB, token: TOKEN_B, senderDeviceId: DEVICE_A, senderDaemonHostId: HOST_A });
    frame = await peer.request({
      type: 'app-send-file-start',
      payload: { requestId: randomUUID(), messageId: crashId, subject: 'crash window', file: crashMeta },
    });
    assert(frame.type === 'app-send-result', 'crash transfer start failed');
    for (let chunkIndex = 0; chunkIndex < crashMeta.chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * APP_FILE_CHUNK_BYTES;
      const chunk = crashBytes.subarray(offset, offset + APP_FILE_CHUNK_BYTES);
      frame = await peer.request({
        type: 'app-send-file-chunk',
        payload: {
          requestId: randomUUID(), messageId: crashId, transferId: crashMeta.transferId,
          offset, chunkIndex, dataBase64: chunk.toString('base64'),
        },
      });
      assert(frame.type === 'app-send-result', 'crash transfer chunk failed');
    }
    peer.terminate();
    await expectFileAbsent(join(homeB, '.zterm/app-inbox/files', encodeAppPathSegment(HOST_A), encodeAppPathSegment(crashId), crashMeta.fileName));
    await stopDaemon(daemonB);
    daemonB = await startDaemon(specB, 'daemon-b-restart-3');
    peer = await connectPeer({ port: portB, token: TOKEN_B, senderDeviceId: DEVICE_A, senderDaemonHostId: HOST_A });
    frame = await peer.request({
      type: 'app-send-file-commit',
      payload: { requestId: randomUUID(), messageId: crashId, transferId: crashMeta.transferId },
    });
    assert(frame.type === 'app-send-result' && frame.payload.status === 'received', 'commit after restart did not complete');
    peer.close();
    const crashRecord = await readInboxRecord(homeB, HOST_A, crashId);
    assert(crashRecord.file && (await readFile(crashRecord.file.absolutePath)).equals(crashBytes), 'crash-window published bytes differ');
    event('file.commit-crash-window', { messageId: crashId, published: true });

    // 8. resultUnknown: peer transport closes after the request was sent.
    const blackholeServer = createServer();
    blackholeServer.on('upgrade', (request, socket) => {
      if (new URL(request.url ?? '/', 'ws://127.0.0.1').pathname !== '/app') {
        socket.destroy();
        return;
      }
      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(request, socket, Buffer.alloc(0), (ws) => {
        ws.on('message', (raw) => {
          const parsed = JSON.parse(raw.toString()) as { type: string; payload: { requestId: string } };
          if (parsed.type === 'app-hello') {
            ws.send(JSON.stringify({
              type: 'app-ready',
              payload: {
                requestId: parsed.payload.requestId,
                protocolVersion: 1,
                deviceId: DEVICE_B,
                daemonHostId: HOST_B,
                capabilities: {},
              },
            }));
            return;
          }
          if (parsed.type === 'app-send-message') {
            ws.terminate();
          }
        });
      });
    });
    await new Promise<void>((done) => blackholeServer.listen(proxyPort, '127.0.0.1', done));
    account.devices.set(DEVICE_B, directoryDevice({
      deviceId: DEVICE_B,
      daemonHostId: HOST_B,
      port: proxyPort,
      token: TOKEN_B,
    }));
    const unknownId = `msg-unknown-${randomUUID()}`;
    const unknown = await runCli(specA, [
      'app', 'send', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', unknownId, '--subject', 'unknown', '--body', 'drop after send',
    ], { timeoutMs: 40_000 });
    const unknownFrame = parseNdjson(unknown.stdout)[0];
    assert(unknown.code === 3, `resultUnknown exit was ${unknown.code}: ${unknown.stderr}`);
    assert(unknownFrame?.type === 'app-send-result' && unknownFrame.payload.status === 'resultUnknown', 'resultUnknown frame missing');
    const outboxStatus = await runCli(specA, ['app', 'status', '--message-id', unknownId]);
    const outboxFrame = parseNdjson(outboxStatus.stdout)[0];
    assert(outboxFrame?.type === 'app-status-result' && outboxFrame.payload.outboxState === 'result_unknown', 'outbox did not retain resultUnknown state');
    event('send.result-unknown', { messageId: unknownId, exit: unknown.code, outboxState: 'result_unknown' });
    account.devices.set(DEVICE_B, directoryDevice(specB));
    await new Promise<void>((done) => blackholeServer.close(() => done()));

    // 9. Unauthorized connections.
    const noToken = await connectUnauthorized(portB);
    const wrongToken = await connectUnauthorized(portB, 'wrong-token');
    assert(noToken === 401 && wrongToken === 401, `unauthorized statuses were ${noToken}/${wrongToken}`);
    event('auth.unauthorized', { noToken, wrongToken });

    // 10. Offline target produces unreachable, not success.
    await stopDaemon(daemonB);
    const offline = await runCli(specA, [
      'app', 'send', '--peer', DEVICE_B, '--daemon-host-id', HOST_B,
      '--message-id', `msg-offline-${randomUUID()}`, '--subject', 'offline', '--body', 'no daemon',
    ], { timeoutMs: 40_000 });
    const offlineFrame = parseNdjson(offline.stdout)[0];
    assert(offline.code === 1, `offline exit was ${offline.code}`);
    assert(offlineFrame?.type === 'app-error' && offlineFrame.payload.code === 'unreachable', `offline error was ${offline.stdout}`);
    event('send.offline', { exit: offline.code, code: offlineFrame.payload.code });
    daemonB = await startDaemon(specB, 'daemon-b-restart-4');

    // 11. Real paused local subscriber: queue overflow, durable replay, isolation.
    const burstIds = Array.from({ length: 5 }, () => `msg-slow-${randomUUID()}`);
    const burstBody = 's'.repeat(APP_MAX_MESSAGE_BYTES);
    assert(Buffer.byteLength(burstBody) === APP_MAX_MESSAGE_BYTES, 'burst body is not exactly 1 MiB');
    const slow = await connectLocalSubscriber({
      name: 'slow',
      port: portB,
      token: TOKEN_B,
      deviceId: DEVICE_B,
      daemonHostId: HOST_B,
    });
    slowSubscriber = slow;
    slow.pause();
    event('slow-consumer.paused', { messages: burstIds.length, bytesPerMessage: APP_MAX_MESSAGE_BYTES });

    const settler = await connectLocalSubscriber({
      name: 'settler',
      port: portB,
      token: TOKEN_B,
      deviceId: DEVICE_B,
      daemonHostId: HOST_B,
    });
    ackSubscriber = settler;
    const burst = await connectPeer({
      port: portB,
      token: TOKEN_B,
      senderDeviceId: DEVICE_A,
      senderDaemonHostId: HOST_A,
    });
    burstPeer = burst;
    for (const [index, messageId] of burstIds.entries()) {
      const result = await burst.request({
        type: 'app-send-message',
        payload: { requestId: randomUUID(), messageId, subject: 'slow burst', body: burstBody },
      });
      assert(result.type === 'app-send-result' && result.payload.status === 'received', `burst ${messageId} was not persisted`);
      const published = await settler.waitForFrame(
        (frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === messageId,
      );
      assert(published.type === 'app-inbound-message', `healthy subscriber did not receive burst ${messageId}`);
      if (index < burstIds.length - 1) {
        const ack = await settler.request({
          type: 'app-ack',
          payload: { requestId: `ack-${randomUUID()}`, messageId },
        });
        assert(ack.type === 'app-status-result' && ack.payload.state === 'delivered', `ack ${messageId} was not delivered`);
      }
    }

    slow.resume();
    const slowClose = await slow.waitForClose(35_000);
    assert(slowClose.code === 4008, `slow subscriber close code was ${slowClose.code}`);
    assert(slowClose.reason === 'slow_consumer', `slow subscriber close reason was ${slowClose.reason}`);
    const slowError = slow.frames.find(
      (frame): frame is Extract<AppServerFrame, { type: 'app-error' }> =>
        frame.type === 'app-error' && frame.payload.code === 'slow_consumer',
    );
    assert(slowError, 'slow_consumer app-error was not observed before close');
    event('slow-consumer.evicted', {
      closeCode: slowClose.code,
      closeReason: slowClose.reason,
      appError: slowError.payload.code,
      messages: burstIds.length,
    });

    const unacknowledgedBurstId = burstIds[burstIds.length - 1]!;
    for (const [index, messageId] of burstIds.entries()) {
      const record = await readInboxRecord(homeB, HOST_A, messageId);
      assert(record.messageId === messageId, `burst record ${messageId} durable ID differs`);
      const expectedState = index < burstIds.length - 1 ? 'delivered' : 'received';
      assert(record.state === expectedState, `burst record ${messageId} state was ${record.state}, expected ${expectedState}`);
    }

    const fresh = await connectLocalSubscriber({
      name: 'fresh',
      port: portB,
      token: TOKEN_B,
      deviceId: DEVICE_B,
      daemonHostId: HOST_B,
    });
    freshSubscriber = fresh;
    const replayed = await fresh.waitForFrame(
      (frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === unacknowledgedBurstId,
    );
    assert(replayed.type === 'app-inbound-message', 'fresh subscriber did not replay an unacknowledged burst message');
    assert(replayed.payload.state === 'received', 'replayed burst message was not unacknowledged');
    assert(replayed.payload.body === burstBody, 'replayed burst body differs from the durable body');
    const replayRecord = await readInboxRecord(homeB, HOST_A, unacknowledgedBurstId);
    assert(replayRecord.messageId === unacknowledgedBurstId, 'replayed durable message ID differs');
    assert(replayRecord.state === 'received', 'replayed record is not unacknowledged');
    const burstReplayCount = fresh.frames.filter(
      (frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === unacknowledgedBurstId,
    ).length;
    assert(burstReplayCount === 1, `burst ${unacknowledgedBurstId} replay count was ${burstReplayCount}`);
    event('slow-consumer.replay', {
      messageId: unacknowledgedBurstId,
      state: 'received',
      duplicates: 0,
      acked: burstIds.length - 1,
    });

    const afterId = `msg-after-slow-${randomUUID()}`;
    const afterBody = 'fresh subscriber still receives after slow_consumer';
    const after = await burst.request({
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: afterId, subject: 'after slow consumer', body: afterBody },
    });
    assert(after.type === 'app-send-result' && after.payload.status === 'received', 'post-slow message was not persisted');
    const delivered = await fresh.waitForFrame(
      (frame) => frame.type === 'app-inbound-message' && frame.payload.messageId === afterId,
    );
    assert(delivered.type === 'app-inbound-message' && delivered.payload.body === afterBody, 'fresh subscriber did not receive the subsequent message');
    event('slow-consumer.isolated', { messageId: afterId, subscriber: 'fresh' });

    fresh.terminate();
    freshSubscriber = null;
    settler.terminate();
    ackSubscriber = null;
    burst.terminate();
    burstPeer = null;
    slow.terminate();
    slowSubscriber = null;

    // 12. Inbox limit over real WebSocket on daemon C.
    daemonC = await startDaemon(specC, 'daemon-c', { APP_TEST_MAX_INBOX_RECORDS: '1' });
    const peerC = await connectPeer({ port: portC, token: specC.token, senderDeviceId: DEVICE_A, senderDaemonHostId: HOST_A });
    const first = await peerC.request({
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: `c-1-${randomUUID()}`, subject: 'one', body: 'first' },
    });
    assert(first.type === 'app-send-result' && first.payload.status === 'received', 'first inbox record failed');
    const second = await peerC.request({
      type: 'app-send-message',
      payload: { requestId: randomUUID(), messageId: `c-2-${randomUUID()}`, subject: 'two', body: 'second' },
    });
    assert(second.type === 'app-error' && second.payload.code === 'inbox_full', 'inbox_full was not returned');
    peerC.close();
    event('inbox.full', { code: second.payload.code });

    event('e2e.pass');
  } finally {
    slowSubscriber?.terminate();
    ackSubscriber?.terminate();
    freshSubscriber?.terminate();
    burstPeer?.terminate();
    if (streamB && streamB.exitCode === null) streamB.kill('SIGTERM');
    if (daemonA) await stopDaemon(daemonA).catch(() => undefined);
    if (daemonB) await stopDaemon(daemonB).catch(() => undefined);
    if (daemonC) await stopDaemon(daemonC).catch(() => undefined);
    await new Promise<void>((done) => account.server.close(() => done()));
    await new Promise<void>((done) => blackhole.close(() => done()));
    const ports = [portA, portB, portC, accountPort, proxyPort];
    for (const port of ports) {
      const open = await portReady(port);
      assert(!open, `port ${port} leaked after cleanup`);
    }
    event('e2e.cleanup', { portsReleased: ports });
    await writeFile(join(ROOT, 'events.jsonl'), `${events.join('\n')}\n`);
  }
}

main().then(() => {
  process.exit(0);
}).catch((error: unknown) => {
  event('e2e.fail', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  console.error(error);
  process.exit(1);
});
