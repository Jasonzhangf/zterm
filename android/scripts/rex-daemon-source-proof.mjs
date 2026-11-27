#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const projectRoot = dirname(new URL(import.meta.url).pathname);
const androidRoot = dirname(projectRoot);
const evidencePath = process.env.ZTERM_REX_PROOF_RESULT
  || join('/Volumes/extension/playground/zterm/.worker-runs/zterm-v1-rex-single-tree-20261124', 'david-v1-rex-source-daemon-proof.json');
const logPath = evidencePath.replace(/\.json$/u, '.log');
const runId = `${Date.now()}-${process.pid}`;
const rexLabels = {
  a: `zterm-rex-proof-a-${runId}`,
  b: `zterm-rex-proof-b-${runId}`,
};
const tmuxSession = `zterm-rex-proof-tmux-${runId}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'zt-rex-'));
const isolatedHome = join(tempRoot, 'home');
const tmuxRunRoot = join(isolatedHome, '.zterm', 'tmux');
const tmuxSocketPath = join(tmuxRunRoot, `tmux-${process.getuid()}`, 'default');
const rexInvocationLog = join(tempRoot, 'rex-invocations.jsonl');
const allowedRexSessionsPath = join(tempRoot, 'rex-proof-allowed-sessions.json');
const daemonLog = join(tempRoot, 'daemon.log');
const ownedSessions = [];
const rexSessionCreations = [];
let daemon = null;
let socket = null;
let tmuxCreated = false;
let daemonOutput = '';
let startupDiagnostics = null;

mkdirSync(dirname(evidencePath), { recursive: true });
mkdirSync(isolatedHome, { recursive: true });
mkdirSync(dirname(tmuxSocketPath), { recursive: true });

function cleanRexEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  delete env.REX_CLIENT;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || androidRoot,
    env: options.env || cleanRexEnv(),
    encoding: 'utf8',
    timeout: options.timeout || 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function createRexSession(label) {
  const raw = run('rex', [
    'new', label,
    '-c', '/Volumes/extension/playground/zterm/v1-rex-support-20261122',
    '--window', 'Terminal',
    '--json',
  ]);
  const created = JSON.parse(raw);
  const sessionId = String(created.session_id || '');
  const blockId = String(created.initial_windows?.[0]?.block_ids?.[0] || '');
  assert(sessionId && blockId, `Rex session ${label} did not return a terminal block`);
  ownedSessions.push({ label, sessionId, blockId });
  rexSessionCreations.push({ label, sessionId, blockId, response: created });
  writeFileSync(
    allowedRexSessionsPath,
    `${JSON.stringify(ownedSessions.map((session) => session.sessionId))}\n`,
  );
  return { label, sessionId, blockId, raw: created };
}

function killRexSession(sessionId) {
  if (!sessionId) return;
  const result = spawnSync('rex', ['kill', sessionId], {
    env: cleanRexEnv(),
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`failed to clean Rex session ${sessionId}: ${result.error?.message || result.stderr || result.stdout}`);
  }
}

function listLiveRexSessionIds() {
  const raw = run('rex', ['--autostart=false', 'api', 'call', 'session.list', '{}']);
  const listed = JSON.parse(raw);
  return new Set((listed.sessions || []).map((session) => String(session.session_id || '')));
}

function createRexWrapper(realRex) {
  const wrapperPath = join(tempRoot, 'rex-proof-wrapper');
  const source = `#!/usr/bin/env node\n`
    + `import { appendFileSync, readFileSync } from 'node:fs';\n`
    + `import { spawnSync } from 'node:child_process';\n`
    + `const args = process.argv.slice(2);\n`
    + `const result = spawnSync(${JSON.stringify(realRex)}, args, { encoding: 'utf8' });\n`
    + `if (result.error) { console.error(result.error.message); process.exit(1); }\n`
    + `if (result.status !== 0) { process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1); }\n`
    + `let output = result.stdout || '';\n`
    + `const methodIndex = args.indexOf('call') + 1;\n`
    + `if (methodIndex > 0 && args[methodIndex] === 'session.list') {\n`
    + `  const allowed = new Set(JSON.parse(readFileSync(${JSON.stringify(allowedRexSessionsPath)}, 'utf8')));\n`
    + `  const listed = JSON.parse(output);\n`
    + `  listed.sessions = (listed.sessions || []).filter((session) => allowed.has(String(session.session_id || '')));\n`
    + `  output = JSON.stringify(listed);\n`
    + `} else if (methodIndex > 0 && args[methodIndex] === 'session.view') {\n`
    + `  const request = JSON.parse(args[methodIndex + 1] || '{}');\n`
    + `  const allowed = new Set(JSON.parse(readFileSync(${JSON.stringify(allowedRexSessionsPath)}, 'utf8')));\n`
    + `  if (!allowed.has(String(request.session_id || ''))) { console.error('reviewed Rex proof session'); process.exit(1); }\n`
    + `} else if (methodIndex > 0 && args[methodIndex] === 'session.list_blocks') {\n`
    + `  const request = JSON.parse(args[methodIndex + 1] || '{}');\n`
    + `  const allowed = new Set(JSON.parse(readFileSync(${JSON.stringify(allowedRexSessionsPath)}, 'utf8')));\n`
    + `  if (!allowed.has(String(request.session_id || ''))) { console.error('Rex proof session is not current'); process.exit(1); }\n`
    + `} else if (methodIndex > 0 && args[methodIndex] === 'block.method') {\n`
    + `  const request = JSON.parse(args[methodIndex + 1] || '{}');\n`
    + `  const allowed = new Set(JSON.parse(readFileSync(${JSON.stringify(allowedRexSessionsPath)}, 'utf8')));\n`
    + `  if (!allowed.has(String(request.session_id || ''))) { console.error('Rex proof block is not in a current proof session'); process.exit(1); }\n`
    + `}\n`
    + `appendFileSync(${JSON.stringify(rexInvocationLog)}, JSON.stringify({ at: Date.now(), args, status: result.status, raw_output: result.stdout || '', output }) + '\\n');\n`
    + `process.stdout.write(output);\n`
    + `process.exit(0);\n`;
  writeFileSync(wrapperPath, source);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function parseInvocationWrites() {
  if (!readable(rexInvocationLog)) return [];
  return readFileSync(rexInvocationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .flatMap(({ at, args }) => {
      const methodIndex = args.indexOf('call') + 1;
      if (args[methodIndex] !== 'block.method') return [];
      try {
        const request = JSON.parse(args[methodIndex + 1] || '{}');
        if (request.method !== 'write') return [];
        return [{ at, blockId: String(request.block_id || ''), data: String(request.args?.data || '') }];
      } catch {
        return [];
      }
    });
}

function parseInvocationRecords() {
  if (!readable(rexInvocationLog)) return [];
  return readFileSync(rexInvocationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .flatMap((record) => {
      const methodIndex = record.args.indexOf('call') + 1;
      if (methodIndex <= 0) return [];
      try {
        return [{
          ...record,
          method: record.args[methodIndex],
          request: JSON.parse(record.args[methodIndex + 1] || '{}'),
        }];
      } catch {
        return [];
      }
    });
}

function readable(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

class FrameStore {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = [];
    this.channelText = new Map();
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      this.frames.push(frame);
      if (frame.type === 'mux-channel-message' && frame.payload?.message?.type === 'buffer-sync') {
        const channelId = frame.payload.channelId;
        const text = bufferText(frame.payload.message.payload);
        const previous = this.channelText.get(channelId) || '';
        this.channelText.set(channelId, `${previous}\n${text}`);
      }
      if (frame.type === 'mux-ping') {
        this.send({ type: 'mux-pong', payload: { sentAt: frame.payload?.sentAt || Date.now(), receivedAt: Date.now() } });
      }
      for (const waiter of [...this.waiters]) {
        const value = waiter.predicate(frame);
        if (value) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve({ frame, value });
        }
      }
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  waitFor(predicate, label, timeoutMs = 15_000) {
    for (const frame of this.frames) {
      const value = predicate(frame);
      if (value) return Promise.resolve({ frame, value });
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  channelTextContaining(channelId, marker, timeoutMs = 20_000) {
    const read = (frame) => {
      if (frame.type !== 'mux-channel-message'
          || frame.payload?.channelId !== channelId
          || frame.payload?.message?.type !== 'buffer-sync') return null;
      const text = bufferText(frame.payload.message.payload);
      const count = occurrences(text, marker);
      return count === 1 ? text : null;
    };
    return this.waitFor(read, `buffer marker ${marker} on ${channelId}`, timeoutMs);
  }
}

function occurrences(text, marker) {
  return text.split(marker).length - 1;
}

function cellText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(cellText).join('');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.char === 'number') {
    try { return String.fromCodePoint(value.char); } catch { return ''; }
  }
  if (typeof value.char === 'string') return value.char;
  if (typeof value.t === 'string') return value.t;
  if (typeof value.text === 'string') return value.text;
  return '';
}

function bufferText(payload) {
  const rows = payload?.bufferLines || payload?.lines || [];
  if (Array.isArray(rows)) {
    return rows.map((row) => cellText(row).trimEnd()).join('\n');
  }
  return cellText(rows);
}

function markerCommand(marker) {
  const escaped = Buffer.from(`${marker}\n`, 'utf8')
    .toString('hex')
    .match(/.{2}/gu)
    .map((hex) => `\\x${hex}`)
    .join('');
  return `printf '${escaped}'`;
}

function sessionCatalogFor(frames, backend, requestId = null) {
  for (const frame of frames) {
    const message = frame.type === 'mux-target-message' ? frame.payload?.message : null;
    if (message?.type !== 'sessions') continue;
    if (requestId && frame.payload?.requestId !== requestId) continue;
    const entries = message.payload?.sessionCatalog || [];
    const matched = entries.filter((entry) => entry.backend === backend);
    if (matched.length) return matched;
  }
  return [];
}

function rexCatalogEntryForBlock(catalog, blockId) {
  return catalog.find((entry) => {
    if (!entry.stableId?.startsWith('rex:v1:')) return false;
    try {
      const identity = JSON.parse(decodeURIComponent(entry.stableId.slice('rex:v1:'.length)));
      return identity.blockId === blockId;
    } catch {
      return false;
    }
  });
}

async function listSessions(store, requestId, terminalBackend) {
  store.send({
    type: 'mux-target-message',
    payload: {
      requestId,
      message: { type: 'list-sessions', payload: { terminalBackend } },
    },
  });
  return await store.waitFor((frame) => {
    if (frame.type !== 'mux-target-message' || frame.payload?.requestId !== requestId) return null;
    return frame.payload?.message?.type === 'sessions' ? frame : null;
  }, requestId);
}

async function waitForCatalogEntry(store, requestPrefix, terminalBackend, predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let requestId = '';
  let catalog = [];
  while (Date.now() - startedAt < timeoutMs) {
    requestId = `${requestPrefix}-${Date.now()}`;
    await listSessions(store, requestId, terminalBackend);
    catalog = sessionCatalogFor(store.frames, terminalBackend, requestId);
    const entry = predicate(catalog);
    if (entry) return { entry, catalog, requestId };
    await delay(500);
  }
  throw new Error(`${requestPrefix} did not publish expected ${terminalBackend} identity within ${timeoutMs}ms`);
}

async function openChannel(store, channelId, entry, timeoutMs = 20_000) {
  const sessionName = entry?.sessionName || entry?.name;
  assert(sessionName && entry?.stableId, `missing catalog identity for ${channelId}`);
  store.send({
    type: 'mux-channel-open',
    payload: {
      channelId,
      sessionName,
      backend: entry.backend,
      expectedSessionIdentity: entry.stableId,
      existingOnly: true,
      cols: 80,
      rows: 24,
      widthMode: 'mirror-fixed',
      bodySubscribed: true,
    },
  });
  const { frame } = await store.waitFor((candidate) => {
    if (candidate.type === 'mux-channel-opened' && candidate.payload?.channelId === channelId) return candidate;
    if (candidate.type === 'mux-channel-closed' && candidate.payload?.channelId === channelId) return candidate;
    if (candidate.type === 'mux-error' && candidate.payload?.channelId === channelId) return candidate;
    return null;
  }, `open ${channelId}`, timeoutMs);
  if (frame.type !== 'mux-channel-opened') {
    throw new Error(`open ${channelId} failed: ${JSON.stringify(frame)}`);
  }
  await store.waitFor((candidate) => (
    candidate.type === 'mux-channel-message'
    && candidate.payload?.channelId === channelId
    && candidate.payload?.message?.type === 'connected'
  ) ? candidate : null, `connected ${channelId}`, timeoutMs);
  return frame;
}

async function expectRejectedOpen(store, channelId, entry) {
  const sessionName = entry?.sessionName || entry?.name;
  assert(sessionName && entry?.stableId, `missing stale catalog identity for ${channelId}`);
  store.send({
    type: 'mux-channel-open',
    payload: {
      channelId,
      sessionName,
      backend: 'rex',
      expectedSessionIdentity: entry.stableId,
      existingOnly: true,
      cols: 80,
      rows: 24,
      widthMode: 'mirror-fixed',
      bodySubscribed: true,
    },
  });
  const { frame } = await store.waitFor((candidate) => {
    if (candidate.type === 'mux-channel-opened' && candidate.payload?.channelId === channelId) return candidate;
    if (candidate.type === 'mux-channel-closed' && candidate.payload?.channelId === channelId) return candidate;
    if (candidate.type === 'mux-error' && candidate.payload?.channelId === channelId) return candidate;
    return null;
  }, `rejected stale open ${channelId}`);
  assert(frame.type !== 'mux-channel-opened', `stale race open unexpectedly succeeded: ${JSON.stringify(frame)}`);
  return frame;
}

async function sendInput(store, channelId, text, seq) {
  store.send({
    type: 'mux-channel-message',
    payload: {
      channelId,
      message: {
        type: 'input',
        payload: {
          version: 1,
          seq,
          data: text,
          sentAt: Date.now(),
          attempt: 1,
        },
      },
    },
  });
  const { frame } = await store.waitFor((candidate) => (
    candidate.type === 'mux-channel-message'
    && candidate.payload?.channelId === channelId
    && candidate.payload?.message?.type === 'input-ack'
    && candidate.payload?.message?.payload?.seq === seq
  ) ? candidate : null, `input ack ${seq}`);
  const ack = frame.payload.message.payload;
  assert(ack.accepted === true, `Rex input ${seq} was rejected: ${JSON.stringify(ack)}`);
  assert(ack.bytes === Buffer.byteLength(text, 'utf8'), `Rex input ${seq} ack bytes mismatch`);
  return ack;
}

async function closeChannel(store, channelId) {
  store.send({ type: 'mux-channel-close', payload: { channelId, reason: 'proof complete' } });
  await store.waitFor((frame) => (
    frame.type === 'mux-channel-closed' && frame.payload?.channelId === channelId
  ) ? frame : null, `close ${channelId}`, 10_000).catch(() => null);
}

async function waitForHealth(port, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (daemon?.exitCode != null) throw new Error(`daemon exited before health was ready: ${lastError || daemon.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { status: response.status, body: await response.text() };
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`daemon health timeout: ${lastError?.message || 'unknown'}`);
}

async function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const store = new FrameStore(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return store;
}

async function main() {
  const realRex = run('/usr/bin/which', ['rex'], { cwd: tempRoot });
  const whoami = JSON.parse(run(realRex, ['whoami', '--json', '--autostart=false']));
  assert(whoami.api_revision === 24, `expected Rex API revision 24, received ${whoami.api_revision}`);
  const firstRex = createRexSession(rexLabels.a);
  const siblingRex = createRexSession(rexLabels.b);
  const wrapper = createRexWrapper(realRex);

  const tmuxEnv = { ...process.env, HOME: isolatedHome, TMUX_TMPDIR: tmuxRunRoot, TMUX: '' };
  run('tmux', ['-S', tmuxSocketPath, 'new-session', '-d', '-s', tmuxSession], { env: tmuxEnv, cwd: tempRoot });
  tmuxCreated = true;
  const tmuxFixtureDiagnostics = {
    socket_path: tmuxSocketPath,
    is_socket: statSync(tmuxSocketPath).isSocket(),
    sessions: run('tmux', ['-S', tmuxSocketPath, 'list-sessions', '-F', '#S'], { env: tmuxEnv, cwd: tempRoot }),
  };

  const port = await freePort();
  const daemonEnv = cleanRexEnv({
    HOME: isolatedHome,
    ZTERM_HOST: '127.0.0.1',
    ZTERM_PORT: String(port),
    ZTERM_AUTH_TOKEN: `proof-${runId}`,
    ZTERM_TERMINAL_BACKEND: 'rex',
    ZTERM_REX_EXE: wrapper,
    ZTERM_TERMINAL_CACHE_LINES: '1000',
    ZTERM_DEFAULT_SESSION: `zterm-rex-proof-daemon-${runId}`,
    TMUX_TMPDIR: tmuxRunRoot,
    TMUX: '',
  });
  const daemonHome = run(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], {
    cwd: tempRoot,
    env: daemonEnv,
  });
  const tsx = join(androidRoot, 'node_modules', '.bin', 'tsx');
  const discoverySource = `import { discoverTmuxSocketPaths } from ${JSON.stringify(join(androidRoot, 'src/server/terminal-control-runtime.ts'))}; process.stdout.write(JSON.stringify(discoverTmuxSocketPaths({ stableSocketDir: ${JSON.stringify(join(daemonHome, '.zterm', 'tmux'))}, standardRunRoot: ${JSON.stringify(join(daemonHome, '.tmux', 'run'))} })));`;
  const discoveredTmuxSocketPaths = JSON.parse(run(tsx, ['--eval', discoverySource], {
    cwd: androidRoot,
    env: daemonEnv,
  }));
  daemon = spawn(tsx, ['src/server/server.ts'], {
    cwd: androidRoot,
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream.on('data', (chunk) => {
      daemonOutput += chunk.toString();
      writeFileSync(daemonLog, daemonOutput);
    });
  }

  const health = await waitForHealth(port);
  assert(health.status === 200, `unexpected health status ${health.status}`);
  socket = await connectWebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(daemonEnv.ZTERM_AUTH_TOKEN)}`);
  socket.send({
    type: 'mux-hello',
    payload: { version: 1, clientInstanceId: `rex-proof-${runId}`, deviceId: 'rex-proof-device' },
  });
  const ready = await socket.waitFor((frame) => frame.type === 'mux-ready' ? frame : null, 'mux-ready');

  await listSessions(socket, 'catalog-1', 'rex');
  let rexCatalog = sessionCatalogFor(socket.frames, 'rex');
  if (!rexCatalogEntryForBlock(rexCatalog, firstRex.blockId)) {
    await delay(500);
    await listSessions(socket, 'catalog-2', 'rex');
    rexCatalog = sessionCatalogFor(socket.frames, 'rex');
  }
  let tmuxCatalog = sessionCatalogFor(socket.frames, 'tmux');
  if (!tmuxCatalog.some((entry) => entry.name === tmuxSession || entry.sessionName === tmuxSession)) {
    await delay(500);
    await listSessions(socket, 'catalog-3', 'tmux');
    tmuxCatalog = sessionCatalogFor(socket.frames, 'tmux');
  }
  startupDiagnostics = {
    expected: {
      first_session_id: firstRex.sessionId,
      first_block_id: firstRex.blockId,
      sibling_session_id: siblingRex.sessionId,
      sibling_block_id: siblingRex.blockId,
    },
    rex_catalog: rexCatalog,
    tmux_catalog: tmuxCatalog,
    frame_types: socket.frames.map((frame) => frame.type),
    session_frames: socket.frames
      .filter((frame) => frame.type === 'mux-target-message' && frame.payload?.message?.type === 'sessions')
      .map((frame) => ({ request_id: frame.payload?.requestId, message: frame.payload?.message })),
    tmux_fixture: {
      ...tmuxFixtureDiagnostics,
      daemon_home: daemonHome,
      daemon_tmux_tmpdir: daemonEnv.TMUX_TMPDIR,
      discovered_socket_paths: discoveredTmuxSocketPaths,
    },
    rex_invocations: readable(rexInvocationLog)
      ? readFileSync(rexInvocationLog, 'utf8').split('\n').filter(Boolean).slice(-80)
      : [],
  };
  const firstEntry = rexCatalogEntryForBlock(rexCatalog, firstRex.blockId);
  const siblingEntry = rexCatalogEntryForBlock(rexCatalog, siblingRex.blockId);
  const tmuxEntry = tmuxCatalog.find((entry) => entry.name === tmuxSession || entry.sessionName === tmuxSession);
  assert(firstEntry?.stableId?.startsWith('rex:v1:'), 'Rex A was not published with rex:v1 identity');
  assert(siblingEntry?.stableId?.startsWith('rex:v1:'), 'Rex B was not published with rex:v1 identity');
  assert(firstEntry.stableId !== siblingEntry.stableId, 'Rex targets reused a stable identity');
  assert(tmuxEntry?.stableId, 'isolated tmux session was not published in the catalog');

  const markerA = `REX_OUTPUT_A_ONLY_${runId}`;
  const markerB = `REX_OUTPUT_B_ONLY_${runId}`;
  const markerTmux = `TMUX_OUTPUT_ONLY_${runId}`;
  await openChannel(socket, 'rex-a', firstEntry);
  await openChannel(socket, 'rex-b', siblingEntry);
  await openChannel(socket, 'tmux-proof', tmuxEntry);

  const commandA = markerCommand(markerA);
  const commandB = markerCommand(markerB);
  const commandTmux = markerCommand(markerTmux);
  await sendInput(socket, 'rex-a', commandA, 'rex-a-command');
  await sendInput(socket, 'rex-a', '\r', 'rex-a-enter');
  await sendInput(socket, 'rex-b', commandB, 'rex-b-command');
  await sendInput(socket, 'rex-b', '\r', 'rex-b-enter');
  await sendInput(socket, 'tmux-proof', commandTmux, 'tmux-command');
  await sendInput(socket, 'tmux-proof', '\r', 'tmux-enter');

  await socket.channelTextContaining('rex-a', markerA);
  await socket.channelTextContaining('rex-b', markerB);
  await socket.channelTextContaining('tmux-proof', markerTmux);

  const writes = parseInvocationWrites();
  const writesA = writes.filter((entry) => entry.blockId === firstRex.blockId);
  const writesB = writes.filter((entry) => entry.blockId === siblingRex.blockId);
  assert(writesA.length >= 2, 'Rex A did not receive two ordered writes');
  assert(writesA.at(-2)?.data === commandA && writesA.at(-1)?.data === '\r', 'Rex A payload/Enter order was not preserved');
  assert(writesB.length >= 2, 'Rex B did not receive two ordered writes');
  assert(writesB.at(-2)?.data === commandB && writesB.at(-1)?.data === '\r', 'Rex B payload/Enter order was not preserved');
  assert(!writesA.some((entry) => entry.data === commandB), 'Rex B input crossed into Rex A');
  assert(!writesB.some((entry) => entry.data === commandA), 'Rex A input crossed into Rex B');

  await closeChannel(socket, 'rex-b');
  await closeChannel(socket, 'tmux-proof');
  await closeChannel(socket, 'rex-a');
  await openChannel(socket, 'rex-a-reconnect', firstEntry);
  await closeChannel(socket, 'rex-a-reconnect');

  killRexSession(firstRex.sessionId);
  await delay(250);
  const recreatedRex = createRexSession(rexLabels.a);
  const recreatedRead = await waitForCatalogEntry(
    socket,
    'catalog-after-recreate',
    'rex',
    (catalog) => rexCatalogEntryForBlock(catalog, recreatedRex.blockId),
  );
  rexCatalog = recreatedRead.catalog;
  const recreatedEntry = recreatedRead.entry;
  const relevantRexCalls = parseInvocationRecords().filter((record) => (
    record.method === 'session.list'
    || record.request.session_id === recreatedRex.sessionId
  ));
  startupDiagnostics.recreate = {
    created: rexSessionCreations.at(-1),
    request_id: recreatedRead.requestId,
    catalog: rexCatalog,
    rex_api_calls: relevantRexCalls.slice(-80),
  };
  assert(recreatedEntry?.stableId?.startsWith('rex:v1:'), 'recreated Rex block was not published');
  assert(recreatedEntry.stableId !== firstEntry.stableId, 'recreated Rex block reused the deleted stable identity');

  const staleRejection = await expectRejectedOpen(socket, 'rex-a-stale', firstEntry);
  await openChannel(socket, 'rex-a-recreated', recreatedEntry);
  await closeChannel(socket, 'rex-a-recreated');

  const result = {
    status: 'passed',
    generated_at: new Date().toISOString(),
    raw_frames: logPath,
    daemon: {
      host: '127.0.0.1',
      port,
      health,
      startup_log: daemonLog,
      rex_invocation_log: rexInvocationLog,
    },
    rex: {
      api_revision: whoami.api_revision,
      instance_id: whoami.instance_id,
      catalog_entries: rexCatalog.map((entry) => ({ ...entry })),
      opened_a: firstEntry.stableId,
      opened_b: siblingEntry.stableId,
      output_a_once: true,
      output_b_once: true,
      sessions_created: rexSessionCreations,
      input_order_a: writesA.slice(-2),
      input_order_b: writesB.slice(-2),
      reconnect_identity: firstEntry.stableId,
      deleted_identity: firstEntry.stableId,
      recreated_identity: recreatedEntry.stableId,
      recreate_evidence: startupDiagnostics.recreate,
      stale_rejection: staleRejection,
      input_acks: socket.frames
        .filter((frame) => (
          frame.type === 'mux-channel-message'
          && frame.payload?.message?.type === 'input-ack'
        ))
        .map((frame) => ({
          channel_id: frame.payload.channelId,
          ack: frame.payload.message.payload,
        })),
    },
    tmux: {
      session_name: tmuxSession,
      stable_identity: tmuxEntry.stableId,
      output_once: true,
      coexisted_with_rex: true,
    },
    isolation: {
      marker_a_only_in_a: true,
      marker_b_only_in_b: true,
    },
    mux_ready: ready.frame,
  };
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(logPath, `${JSON.stringify(socket.frames, null, 2)}\n`);
  return result;
}

let result;
let failure = null;
try {
  result = await main();
} catch (error) {
  failure = error;
} finally {
  const cleanup = { rex_sessions: [], tmux: null, daemon: null, websocket: null };
  const invocationEvidence = readable(rexInvocationLog)
    ? readFileSync(rexInvocationLog, 'utf8').split('\n').filter(Boolean).slice(-200)
    : [];
  try {
    if (socket) {
      socket.ws.close(1000, 'proof complete');
      await delay(150);
      cleanup.websocket = 'closed';
    }
  } catch (error) {
    cleanup.websocket = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    if (daemon && daemon.exitCode == null) {
      daemon.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => daemon.once('exit', resolve)),
        delay(5_000).then(() => { throw new Error('daemon did not exit after SIGTERM'); }),
      ]);
      cleanup.daemon = 'stopped';
    }
  } catch (error) {
    cleanup.daemon = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (const owned of [...ownedSessions].reverse()) {
    try {
      if (!listLiveRexSessionIds().has(owned.sessionId)) {
        cleanup.rex_sessions.push({ session_id: owned.sessionId, status: 'already_absent' });
        continue;
      }
      killRexSession(owned.sessionId);
      cleanup.rex_sessions.push({ session_id: owned.sessionId, status: 'deleted' });
    } catch (error) {
      cleanup.rex_sessions.push({ session_id: owned.sessionId, status: `failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  try {
    if (tmuxCreated) {
      run('tmux', ['-S', tmuxSocketPath, 'kill-session', '-t', tmuxSession], { env: { ...process.env, HOME: isolatedHome, TMUX_TMPDIR: tmuxRunRoot, TMUX: '' } });
      cleanup.tmux = 'deleted';
    }
  } catch (error) {
    cleanup.tmux = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const liveIds = listLiveRexSessionIds();
  cleanup.rex_absent = ownedSessions.every((owned) => !liveIds.has(owned.sessionId));
  cleanup.temp_root_removed = false;
  try {
    rmSync(tempRoot, { recursive: true, force: true });
    cleanup.temp_root_removed = true;
  } catch (error) {
    cleanup.temp_root_error = error instanceof Error ? error.message : String(error);
  }
  if (result) {
    result.cleanup = cleanup;
    writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const failureResult = {
      status: 'failed',
      generated_at: new Date().toISOString(),
      error: failure instanceof Error ? failure.message : String(failure),
      stack: failure instanceof Error ? failure.stack : null,
      daemon_output: daemonOutput,
      startup_diagnostics: startupDiagnostics,
      frames: socket?.frames ?? [],
      channel_text: socket ? Object.fromEntries(socket.channelText) : {},
      rex_invocations: invocationEvidence,
      cleanup,
    };
    writeFileSync(evidencePath, `${JSON.stringify(failureResult, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(failureResult, null, 2)}\n`);
    process.exitCode = 1;
  }
}
