import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installNativeTimingObserver } from './rtc-passive-observer.mjs';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const preloadUrl = pathToFileURL(join(scriptDir, 'rtc-cli-timing-preload.mjs')).href;
const realWrtcEntry = require.resolve('@roamhq/wrtc');

const ALLOWED_FIELDS = new Set([
  'ms', 'event', 'ws', 'pc', 'type', 'ice', 'connection', 'gathering', 'scope',
]);

const WS_STUB = `'use strict';
const { EventEmitter } = require('node:events');

class StubWebSocket extends EventEmitter {
  constructor() {
    super();
    this._req = undefined;
  }

  send() {
    return undefined;
  }
}

module.exports = { WebSocket: StubWebSocket };
`;

const ENTRY_SOURCE = `import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const socket = new WebSocket();
socket.emit('open');
socket.emit('message', Buffer.from(JSON.stringify({ type: 'mux-ready' })));
socket.send(JSON.stringify({ type: 'mux-hello' }));
socket.emit('close');

if (process.env.RTC_TIMING_TEST_PEER === '1') {
  const { RTCPeerConnection } = require('@roamhq/wrtc');
  const peer = new RTCPeerConnection();
  peer.close();
}
`;

function wrtcStubSource(real) {
  if (!real) {
    return `'use strict';

class StubPeerConnection {}

module.exports = { RTCPeerConnection: StubPeerConnection };
`;
  }
  return `'use strict';

const { RTCPeerConnection } = require(${JSON.stringify(realWrtcEntry)});

module.exports = { RTCPeerConnection };
`;
}

function writePackage(directory, name, source) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name,
    main: 'index.js',
    type: 'commonjs',
  }));
  writeFileSync(join(directory, 'index.js'), source);
}

function createConsumerContext(root, { realWrtc = true } = {}) {
  const consumer = join(root, 'consumer');
  const modules = join(consumer, 'node_modules');
  writePackage(join(modules, 'ws'), 'ws', WS_STUB);
  writePackage(join(modules, '@roamhq', 'wrtc'), '@roamhq/wrtc', wrtcStubSource(realWrtc));
  const entry = join(consumer, 'entry.mjs');
  writeFileSync(entry, ENTRY_SOURCE);
  return { consumer, entry };
}

function childEnvironment(overrides) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return { ...env, ...overrides };
}

function spawnChild(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: scriptDir,
    env: childEnvironment(env),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function timingEvents(directory) {
  const files = readdirSync(directory);
  assert.equal(files.length, 1, files.join(', '));
  assert.match(files[0], /^cli-native-\d+\.jsonl$/u);
  const path = join(directory, files[0]);
  return {
    path,
    text: readFileSync(path, 'utf8'),
    events: readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'zterm-rtc-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function timingEnv(entry, timingDir) {
  return {
    ZTERM_REMOTE_CLI: entry,
    ZTERM_NATIVE_TIMING_DIR: timingDir,
    NODE_OPTIONS: `--import=${preloadUrl}`,
  };
}

test('unwritable diagnostic destination does not interrupt the CLI', (t) => {
  const root = tempRoot(t);
  const { entry } = createConsumerContext(root, { realWrtc: false });
  const destination = join(root, 'file-instead-of-directory');
  writeFileSync(destination, 'owned fixture');
  const child = spawnChild([entry, '1'], timingEnv(entry, destination));
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
});

test('preload resolves from the CLI entry context and writes only safe fields', (t) => {
  const root = tempRoot(t);
  const { entry } = createConsumerContext(root);
  const timingDir = join(root, 'timing');
  mkdirSync(timingDir, { recursive: true, mode: 0o700 });
  const result = spawnChild(
    [entry, 'login', '--token=supersecretvalue', 'ws://127.0.0.1:1/private'],
    {
      ...timingEnv(entry, timingDir),
      RTC_TIMING_TEST_PEER: '1',
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const { path, text, events } = timingEvents(timingDir);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  for (const event of events) {
    for (const field of Object.keys(event)) {
      assert.ok(ALLOWED_FIELDS.has(field), `unexpected field ${field}`);
    }
    assert.equal(event.scope, 'login');
  }
  assert.ok(events.some((event) => event.event === 'ws.construct'));
  assert.ok(events.some((event) => event.event === 'ws.receive' && event.type === 'mux-ready'));
  assert.ok(events.some((event) => event.event === 'ws.send' && event.type === 'mux-hello'));
  assert.ok(events.some((event) => event.event === 'pc.construct'));
  assert.ok(events.some((event) => event.event === 'pc.close'));
  assert.ok(!text.includes('supersecretvalue'));
  assert.ok(!text.includes('127.0.0.1'));
});

test('preload scope is a fixed whitelist value', (t) => {
  const root = tempRoot(t);
  const { entry } = createConsumerContext(root, { realWrtc: false });
  const cases = [
    { args: ['logout'], scope: 'logout' },
    { args: ['slot', 'list'], scope: 'slot' },
    { args: ['3'], scope: 'numbered' },
    { args: ['status'], scope: 'other' },
  ];
  for (const [index, item] of cases.entries()) {
    const timingDir = join(root, `timing-${index}`);
    mkdirSync(timingDir, { recursive: true, mode: 0o700 });
    const result = spawnChild([entry, ...item.args], timingEnv(entry, timingDir));
    assert.equal(result.status, 0, result.stderr);
    const { events } = timingEvents(timingDir);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.scope === item.scope));
  }
});

test('preload is inert for unrelated argv entries and inline commands', (t) => {
  const root = tempRoot(t);
  const { consumer, entry } = createConsumerContext(root, { realWrtc: false });
  const otherEntry = join(consumer, 'other-entry.mjs');
  writeFileSync(
    otherEntry,
    `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
new WebSocket();
`,
  );
  const timingDir = join(root, 'timing');
  mkdirSync(timingDir, { recursive: true, mode: 0o700 });
  const env = timingEnv(entry, timingDir);

  const otherResult = spawnChild([otherEntry], env);
  assert.equal(otherResult.status, 0, otherResult.stderr);
  const inlineResult = spawnChild(['-e', '0'], env);
  assert.equal(inlineResult.status, 0, inlineResult.stderr);
  assert.deepEqual(readdirSync(timingDir), []);
});

test('default observer API installs and restores the native wrappers', () => {
  const wsModule = require('ws');
  const wrtc = require('@roamhq/wrtc');
  const originalWebSocket = wsModule.WebSocket;
  const originalPeer = wrtc.RTCPeerConnection;
  const events = [];
  const uninstall = installNativeTimingObserver({ emit: (event) => events.push(event) });
  try {
    assert.notEqual(wsModule.WebSocket, originalWebSocket);
    assert.notEqual(wrtc.RTCPeerConnection, originalPeer);
    assert.equal(Object.getPrototypeOf(wrtc.RTCPeerConnection), originalPeer);
    assert.equal(wrtc.RTCPeerConnection.prototype, originalPeer.prototype);
  } finally {
    uninstall();
  }
  assert.equal(wsModule.WebSocket, originalWebSocket);
  assert.equal(wrtc.RTCPeerConnection, originalPeer);
  assert.deepEqual(events, []);
});
