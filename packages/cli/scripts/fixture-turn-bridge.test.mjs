import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  startFixtureFrontend,
  startFixtureTurnClient,
  spawnOwnedFixtureBridge,
} from './fixture-turn-bridge.mjs';

function listenOnce(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
  });
}

function echoTcpServer() {
  const server = createTcpServer((socket) => socket.pipe(socket));
  return server;
}

function httpEchoServer() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(207, { 'x-origin-echo': 'yes' });
      res.end(Buffer.concat([Buffer.from('http:'), body]));
    });
  });
  return server;
}

function relayWsEchoServer() {
  const server = new WebSocketServer({ noServer: true });
  server.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  const http = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(207, { 'x-origin-echo': 'yes' });
      res.end(Buffer.concat([Buffer.from('http:'), ...chunks]));
    });
  });
  http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head,
    ws => server.emit('connection', ws, req)));
  return { http, server };
}

function collectBytes(stream, length) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    const receive = chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= length) {
        stream.removeListener('data', receive);
        resolve(Buffer.concat(chunks));
      }
    };
    stream.on('data', receive);
    stream.once('error', reject);
  });
}

async function waitFor(condition, timeoutMs = 3000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('authentication rejection happens before upstream TCP admission', async () => {
  let upstreamConnections = 0;
  const upstream = echoTcpServer();
  upstream.on('connection', () => { upstreamConnections += 1; });
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  try {
    for (const headers of [{}, { Authorization: 'Bearer wrong-token' }]) {
      const ws = new WebSocket(`${frontend.origin}/fixture/turn`, { headers });
      const closed = new Promise(resolve => ws.once('close', resolve));
      const [error] = await once(ws, 'error');
      assert.match(error.message, /401/);
      await closed;
    }
    assert.equal(upstreamConnections, 0);
  } finally {
    await frontend.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('binary bytes survive fragmentation and coalescing through the bridge', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
  });
  try {
    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(socket, 9);
    const payload = Buffer.from([0, 1, 2, 0xfe, 0xff, 65, 66, 67, 0]);
    socket.write(payload.slice(0, 2));
    socket.write(payload.slice(2));
    assert.deepEqual(await received, payload);
    socket.destroy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('two local connections stay isolated and one close preserves the other', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
  });
  try {
    const a = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const b = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const aReceived = collectBytes(a, 3);
    const bReceived = collectBytes(b, 9);
    a.write('one');
    b.write('two');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await aReceived, Buffer.from('one'));
    a.destroy();
    b.write('-three');
    assert.deepEqual(await bReceived, Buffer.from('two-three'));
    b.destroy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('close is idempotent and stops admission with owned pairs destroyed', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
  });
  try {
    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    await once(socket, 'connect');
    const socketClosed = new Promise(resolve => socket.once('close', resolve));
    socket.on('error', error => assert.equal(error.code, 'ECONNRESET'));
    await frontend.close();
    await client.close();
    const first = await client.close();
    const second = await client.close();
    assert.equal(first.closed, true);
    assert.equal(second.closed, true);
    await socketClosed;
    const refused = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const [error] = await once(refused, 'error');
    assert.equal(error.code, 'ECONNREFUSED');
  } finally {
    await client.close();
    await frontend.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('explicit upstream failure surfaces and cleanup remains idempotent', async () => {
  const upstream = createServer(() => {});
  const { port: upstreamPort } = await listenOnce(upstream);
  upstream.close();
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  try {
    const ws = new WebSocket(`${frontend.origin}/fixture/turn`, {
      headers: { Authorization: 'Bearer fresh-token' },
    });
    const closed = new Promise(resolve => ws.once('close', resolve));
    const [error] = await once(ws, 'error');
    assert.ok(error);
    await closed;
    ws.terminate();
    const first = await frontend.close();
    const second = await frontend.close();
    assert.equal(first.closed, true);
    assert.equal(second.closed, true);
  } finally {
    await frontend.close();
  }
});

test('frontend proxies HTTP status/body and relay WS bytes transparently', async () => {
  const relay = relayWsEchoServer();
  const { port: relayPort } = await listenOnce(relay.http);
  const upstream = httpEchoServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${relayPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  try {
    const httpRes = await fetch(`${frontend.origin}/echo-path`, {
      method: 'POST',
      body: Buffer.from('request-body'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(httpRes.status, 207);
    assert.equal(httpRes.headers.get('x-origin-echo'), 'yes');
    assert.deepEqual(Buffer.from(await httpRes.arrayBuffer()), Buffer.from('http:request-body'));

    const ws = new WebSocket(`${frontend.origin}/relay-ws`);
    const reply = new Promise((resolve) => ws.once('message', (data, isBinary) => resolve({ data, isBinary })));
    await once(ws, 'open');
    ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true });
    const { data, isBinary } = await reply;
    assert.equal(isBinary, true);
    assert.deepEqual(data, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    ws.close();
  } finally {
    await frontend.close();
    relay.http.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('spawned bridge child supervises readiness, close and disconnect cleanup', async (t) => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'fixture-turn-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const frontendControl = join(dir, 'frontend.json');
  const frontendLog = join(dir, 'frontend.log');
  writeFileSync(frontendControl, JSON.stringify({
    role: 'frontend',
    options: {
      listenHost: '127.0.0.1',
      listenPort: 0,
      relayOrigin: `http://127.0.0.1:${upstreamPort}`,
      turnTarget: { host: '127.0.0.1', port: upstreamPort },
      token: 'fresh-token',
    },
  }));
  const frontend = await spawnOwnedFixtureBridge({
    role: 'frontend',
    controlPath: frontendControl,
    logPath: frontendLog,
  });
  await frontend.ready;
  await frontend.assertHealthy();
  const clientControl = join(dir, 'client.json');
  const clientLog = join(dir, 'client.log');
  writeFileSync(clientControl, JSON.stringify({
    role: 'client',
    options: {
      listenHost: '127.0.0.1',
      listenPort: 0,
      bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
      token: 'fresh-token',
    },
  }));
  const client = await spawnOwnedFixtureBridge({
    role: 'client',
    controlPath: clientControl,
    logPath: clientLog,
  });
  await client.ready;
  await client.assertHealthy();
  const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
  const received = collectBytes(socket, 3);
  socket.write(Buffer.from([0xaa, 0x00, 0xbb]));
  assert.deepEqual(await received, Buffer.from([0xaa, 0x00, 0xbb]));
  socket.destroy();
  const closeResult = await client.close();
  assert.equal(closeResult.closed, true);
  assert.equal(closeResult.errors.length, 0);
  const frontendClose = await frontend.close();
  assert.equal(frontendClose.closed, true);
  assert.equal(frontendClose.errors.length, 0);
  await new Promise((resolve) => upstream.close(resolve));
});

test('child IPC disconnect triggers owned cleanup', async (t) => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'fixture-turn-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controlPath = join(dir, 'frontend.json');
  writeFileSync(controlPath, JSON.stringify({
    role: 'frontend',
    options: {
      listenHost: '127.0.0.1',
      listenPort: 0,
      relayOrigin: `http://127.0.0.1:${upstreamPort}`,
      turnTarget: { host: '127.0.0.1', port: upstreamPort },
      token: 'fresh-token',
    },
  }));
  const frontend = await spawnOwnedFixtureBridge({
    role: 'frontend',
    controlPath,
    logPath: join(dir, 'frontend.log'),
  });
  await frontend.ready;
  frontend.child.disconnect();
  await once(frontend.child, 'exit');
  await waitFor(() => !readFileSync(join(dir, 'frontend.log'), 'utf8').includes('RUNNING'));
  await new Promise((resolve) => upstream.close(resolve));
});
