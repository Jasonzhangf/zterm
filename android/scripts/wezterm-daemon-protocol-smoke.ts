import { spawn } from 'child_process';
import { createServer } from 'http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../src/lib/types';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, '..');
const tsxBin = join(androidDir, 'node_modules', '.bin', 'tsx');
const tempRoot = mkdtempSync(join(tmpdir(), 'zterm-wezterm-daemon-smoke-'));
const tempHome = join(tempRoot, 'home');
const mockWezTerm = join(tempRoot, 'wezterm-mock.mjs');
const mockState = join(tempRoot, 'wezterm-state.json');
const sessionName = `smoke-${Date.now()}`;

mkdirSync(tempHome, { recursive: true });

function writeMockWezTerm() {
  writeFileSync(
    mockWezTerm,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
const statePath = ${JSON.stringify(mockState)};
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function load() {
  if (!existsSync(statePath)) return { nextPaneId: 10, panes: [] };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
function save(state) {
  writeFileSync(statePath, JSON.stringify(state), 'utf8');
}
const args = process.argv.slice(2);
if (args[0] !== 'cli' || args[1] !== '--prefer-mux') {
  console.error('unexpected wezterm args: ' + args.join(' '));
  process.exit(2);
}
const command = args[2];
const state = load();
if (command === 'list') {
  console.log('WINID TABID PANEID WORKSPACE SIZE TITLE CWD');
  for (const pane of state.panes) {
    console.log('1 1 ' + pane.paneId + ' ' + pane.workspace + ' 80x24 cmd.exe ' + pane.cwd);
  }
  process.exit(0);
}
if (command === 'spawn') {
  const workspace = args[args.indexOf('--workspace') + 1];
  const cwdIndex = args.indexOf('--cwd');
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : 'file:///D:/smoke';
  const paneId = state.nextPaneId++;
  state.panes.push({ paneId, workspace, cwd, text: 'READY ' + workspace });
  save(state);
  console.log(String(paneId));
  process.exit(0);
}
if (command === 'get-text') {
  const paneId = Number(args[args.indexOf('--pane-id') + 1]);
  const pane = state.panes.find((entry) => entry.paneId === paneId);
  if (!pane) {
    console.error('pane not found: ' + paneId);
    process.exit(1);
  }
  console.log(pane.text);
  process.exit(0);
}
if (command === 'send-text') {
  const paneId = Number(args[args.indexOf('--pane-id') + 1]);
  const pane = state.panes.find((entry) => entry.paneId === paneId);
  if (!pane) {
    console.error('pane not found: ' + paneId);
    process.exit(1);
  }
  const input = await readStdin();
  pane.text += '\\n' + input.replace(/\\r/g, '');
  save(state);
  process.exit(0);
}
if (command === 'kill-pane') {
  const paneId = Number(args[args.indexOf('--pane-id') + 1]);
  state.panes = state.panes.filter((entry) => entry.paneId !== paneId);
  save(state);
  process.exit(0);
}
console.error('unsupported wezterm command: ' + command);
process.exit(2);
`,
    'utf8',
  );
  chmodSync(mockWezTerm, 0o755);
  writeFileSync(mockState, JSON.stringify({ nextPaneId: 10, panes: [] }), 'utf8');
}

async function findAvailablePort(host: string) {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to resolve dynamic smoke port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`daemon health timeout: ${lastError}`);
}

function openWs(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const fail = (error: Error) => reject(error);
    ws.once('error', fail);
    ws.once('open', () => {
      ws.off('error', fail);
      resolve(ws);
    });
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 10_000,
) {
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for websocket message'));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString('utf8')) as ServerMessage;
      if (!predicate(message)) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

function send(ws: WebSocket, message: ClientMessage) {
  ws.send(JSON.stringify(message));
}

async function main() {
  writeMockWezTerm();
  const host = '127.0.0.1';
  const port = await findAvailablePort(host);
  const server = spawn(tsxBin, ['src/server/server.ts'], {
    cwd: androidDir,
    env: {
      ...process.env,
      HOME: tempHome,
      ZTERM_TERMINAL_BACKEND: 'wezterm',
      ZTERM_WEZTERM_EXE: mockWezTerm,
      ZTERM_HOST: host,
      ZTERM_PORT: String(port),
      ZTERM_AUTH_TOKEN: '',
      ZTERM_DAEMON_DEBUG_LOG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitPromise = waitForExit(server);
  let stderr = '';
  server.stderr?.setEncoding('utf8');
  server.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForHealth(`http://${host}:${port}/health`);
    const control = await openWs(`ws://${host}:${port}`);

    send(control, { type: 'list-sessions' } as ClientMessage);
    const initialSessions = await waitForMessage(control, (message) => message.type === 'sessions');
    if (initialSessions.type !== 'sessions' || initialSessions.payload.sessions.length !== 0) {
      throw new Error(`expected empty initial sessions, got ${JSON.stringify(initialSessions)}`);
    }

    send(control, {
      type: 'tmux-create-session',
      payload: { sessionName, cwd: 'D:/zterm-smoke' },
    } as ClientMessage);
    const createdSessions = await waitForMessage(
      control,
      (message) => message.type === 'sessions' && message.payload.sessions.includes(sessionName),
    );

    const openRequestId = `open-${Date.now()}`;
    send(control, {
      type: 'session-open',
      payload: { openRequestId, sessionName, cols: 80, rows: 24 },
    } as ClientMessage);
    const ticket = await waitForMessage(control, (message) => message.type === 'session-ticket');
    if (ticket.type !== 'session-ticket') {
      throw new Error(`expected session-ticket, got ${JSON.stringify(ticket)}`);
    }

    const session = await openWs(`ws://${host}:${port}`);
    send(session, {
      type: 'connect',
      payload: {
        openRequestId,
        sessionName,
        cols: 80,
        rows: 24,
        sessionTransportToken: ticket.payload.sessionTransportToken,
      },
    } as ClientMessage);
    await waitForMessage(session, (message) => message.type === 'connected');
    await waitForMessage(session, (message) => message.type === 'buffer-sync');

    session.send('echo ZTERM_WEZTERM_DAEMON_PROTOCOL_OK\r');
    const inputSync = await waitForMessage(
      session,
      (message) => message.type === 'buffer-sync'
        && JSON.stringify(message.payload).includes('ZTERM_WEZTERM_DAEMON_PROTOCOL_OK'),
      12_000,
    );

    control.close(1000, 'smoke complete');
    session.close(1000, 'smoke complete');
    console.log(JSON.stringify({
      ok: true,
      backend: 'wezterm',
      port,
      sessionName,
      createdSessions: createdSessions.type === 'sessions' ? createdSessions.payload.sessions : [],
      inputSyncType: inputSync.type,
    }, null, 2));
  } finally {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
    await Promise.race([exitPromise, delay(3_000)]);
    rmSync(tempRoot, { recursive: true, force: true });
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }
}

main().catch((error) => {
  rmSync(tempRoot, { recursive: true, force: true });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
