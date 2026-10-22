import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
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
      res.writeHead(207, { 'x-origin-echo': 'yes', 'x-seen-host': req.headers.host });
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
      res.writeHead(207, { 'x-origin-echo': 'yes', 'x-seen-host': req.headers.host });
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

function timingEvents(logText) {
  return logText.split('\n')
    .filter(line => line.startsWith('rtc-bridge-timing: '))
    .map(line => JSON.parse(line.slice('rtc-bridge-timing: '.length)));
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
    const httpRes = await new Promise((resolveResponse, rejectResponse) => {
      const outgoing = request(`${frontend.origin}/echo-path`, {
        method: 'POST', headers: { host: 'public-fixture.example.test' },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers,
          body: Buffer.concat(chunks) }));
      });
      outgoing.once('error', rejectResponse);
      outgoing.end(Buffer.from('request-body'));
    });
    assert.equal(httpRes.status, 207);
    assert.equal(httpRes.headers['x-origin-echo'], 'yes');
    assert.equal(httpRes.headers['x-seen-host'], 'public-fixture.example.test');
    assert.deepEqual(httpRes.body, Buffer.from('http:request-body'));

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

test('prepared admission is claimed by the next native accept without a new WSS', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const events = [];
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
    onTiming: event => events.push(event),
  });
  try {
    assert.equal(typeof client.prepareNextConnection, 'function');
    await client.prepareNextConnection();
    const ready = events.find(event => event.event === 'reservation.ready');
    assert.ok(ready, 'preparation must publish a ready reservation');
    const connection = ready.connection;
    assert.equal(events.filter(event => event.event === 'wss.construct'
      && event.connection === connection).length, 1);
    assert.equal(events.filter(event => event.event === 'wss.open'
      && event.connection === connection).length, 1);
    const constructionsBeforeClaim = events.filter(event => event.event === 'wss.construct').length;
    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(socket, 3);
    socket.write(Buffer.from([0x10, 0x20, 0x30]));
    assert.deepEqual(await received, Buffer.from([0x10, 0x20, 0x30]));
    await waitFor(() => events.some(event => event.event === 'reservation.claim'
      && event.connection === connection));
    assert.equal(events.filter(event => event.event === 'tcp.accept'
      && event.connection === connection).length, 1);
    assert.equal(events.filter(event => event.event === 'wss.construct').length, constructionsBeforeClaim);
    assertTimingShape(events);
    socket.destroy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('unused prepared stream retains early server bytes and carries binary both ways', async () => {
  const early = Buffer.from([0xde, 0xad, 0x01, 0x02]);
  const native = Buffer.from([0x00, 0xff, 0x41, 0x42]);
  const upstreamChunks = [];
  let reservationConnected;
  const reservationConnectedPromise = new Promise(resolve => { reservationConnected = resolve; });
  let connections = 0;
  const upstream = createTcpServer(socket => {
    connections += 1;
    const index = connections;
    socket.on('error', () => {});
    socket.write(early);
    socket.on('data', chunk => { upstreamChunks.push(chunk); socket.write(chunk); });
    if (index >= 2) reservationConnected();
  });
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const events = [];
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
    onTiming: event => events.push(event),
  });
  try {
    await client.prepareNextConnection();
    await reservationConnectedPromise;
    const ready = events.find(event => event.event === 'reservation.ready');
    assert.ok(ready);
    await waitFor(() => events.some(event => event.event === 'wss.first-bytes'
      && event.connection === ready.connection));
    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(socket, early.length + native.length);
    socket.write(native);
    assert.deepEqual(await received, Buffer.concat([early, native]));
    await waitFor(() => Buffer.concat(upstreamChunks).includes(native));
    assert.ok(events.some(event => event.event === 'reservation.claim'
      && event.connection === ready.connection));
    socket.destroy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('one prepared slot is claimed by only the first native accept', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const events = [];
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
    onTiming: event => events.push(event),
  });
  try {
    await client.prepareNextConnection();
    const ready = events.find(event => event.event === 'reservation.ready');
    assert.ok(ready);
    const reservedConnection = ready.connection;
    const first = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const firstReceived = collectBytes(first, 3);
    first.write(Buffer.from([0x01, 0x02, 0x03]));
    await waitFor(() => events.some(event => event.event === 'reservation.claim'
      && event.connection === reservedConnection));
    const second = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const secondReceived = collectBytes(second, 3);
    second.write(Buffer.from([0x04, 0x05, 0x06]));
    assert.deepEqual(await firstReceived, Buffer.from([0x01, 0x02, 0x03]));
    assert.deepEqual(await secondReceived, Buffer.from([0x04, 0x05, 0x06]));
    const claims = events.filter(event => event.event === 'reservation.claim');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].connection, reservedConnection);
    const secondAccept = events.find(event => event.event === 'tcp.accept'
      && event.connection !== reservedConnection);
    assert.ok(secondAccept);
    assert.equal(events.filter(event => event.event === 'wss.construct'
      && event.connection === secondAccept.connection).length, 1);
    first.destroy();
    second.destroy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('reservation closed before claim rejects the same accept without cold fallback', async () => {
  let connections = 0;
  const upstream = createTcpServer(socket => {
    connections += 1;
    socket.on('error', () => {});
    if (connections === 2) {
      setTimeout(() => socket.destroy(), 150);
      return;
    }
    socket.pipe(socket);
  });
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const events = [];
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
    onTiming: event => events.push(event),
  });
  try {
    await client.prepareNextConnection();
    const ready = events.find(event => event.event === 'reservation.ready');
    assert.ok(ready);
    const connection = ready.connection;
    await waitFor(() => events.some(event => event.event === 'reservation.failed'
      && event.connection === connection));
    assertTimingShape(events);
    const constructionsBeforeAccept = events.filter(event => event.event === 'wss.construct').length;
    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    socket.on('error', () => {});
    await once(socket, 'close');
    await waitFor(() => events.some(event => event.event === 'tcp.accept'
      && event.connection === connection));
    assert.equal(events.filter(event => event.event === 'wss.construct').length, constructionsBeforeAccept);
    const second = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(second, 3);
    second.write(Buffer.from([0x11, 0x22, 0x33]));
    assert.deepEqual(await received, Buffer.from([0x11, 0x22, 0x33]));
    const coldAccept = events.find(event => event.event === 'tcp.accept'
      && event.connection !== connection);
    assert.ok(coldAccept);
    assert.equal(events.filter(event => event.event === 'wss.construct'
      && event.connection === coldAccept.connection).length, 1);
    second.destroy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('overlapping and ready reservation preparation requests reject explicitly', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const events = [];
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
    onTiming: event => events.push(event),
  });
  try {
    const first = client.prepareNextConnection();
    await assert.rejects(client.prepareNextConnection(), /reservation already preparing/);
    await first;
    await assert.rejects(client.prepareNextConnection(), /reservation already ready/);
    assert.equal(events.filter(event => event.event === 'reservation.ready').length, 1);
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('close cleans an unused prepared reservation and stops admission', async () => {
  const sockets = new Set();
  const upstream = createTcpServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
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
    await client.prepareNextConnection();
    await waitFor(() => sockets.size === 1);
    const result = await client.close();
    assert.equal(result.closed, true);
    await waitFor(() => sockets.size === 0);
    const refused = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const [error] = await once(refused, 'error');
    assert.equal(error.code, 'ECONNREFUSED');
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('close rejects and cleans a pending reservation preparation', async () => {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  const serverSockets = new Set();
  http.on('connection', socket => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
  });
  http.on('upgrade', (req, socket, head) => {
    setTimeout(() => {
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => {}); });
    }, 200);
  });
  const { port } = await listenOnce(http);
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `ws://127.0.0.1:${port}/fixture/turn`,
    token: 'fresh-token',
  });
  try {
    const preparing = client.prepareNextConnection();
    const result = await client.close();
    await assert.rejects(preparing, /closed during reservation preparation/);
    assert.equal(result.closed, true);
    await waitFor(() => serverSockets.size === 0);
    const refused = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const [error] = await once(refused, 'error');
    assert.equal(error.code, 'ECONNREFUSED');
  } finally {
    await client.close();
    await new Promise(resolve => http.close(resolve));
    wss.close();
  }
});

test('close cleans a claimed reservation and its native pair', async () => {
  const sockets = new Set();
  const upstream = createTcpServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
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
    await client.prepareNextConnection();
    const native = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(native, 3);
    native.write(Buffer.from([0xaa, 0xbb, 0xcc]));
    assert.deepEqual(await received, Buffer.from([0xaa, 0xbb, 0xcc]));
    await waitFor(() => sockets.size === 1);
    const nativeClosed = once(native, 'close');
    const result = await client.close();
    assert.equal(result.closed, true);
    await nativeClosed;
    await waitFor(() => sockets.size === 0);
    const refused = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const [error] = await once(refused, 'error');
    assert.equal(error.code, 'ECONNREFUSED');
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('spawned client exposes awaited reservation preparation through correlated IPC', async (t) => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'fixture-turn-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const frontendControl = join(dir, 'frontend.json');
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
  const frontend = await spawnOwnedFixtureBridge({ role: 'frontend', controlPath: frontendControl,
    logPath: join(dir, 'frontend.log') });
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
  const client = await spawnOwnedFixtureBridge({ role: 'client', controlPath: clientControl,
    logPath: clientLog });
  await client.ready;
  await client.assertHealthy();
  try {
    const first = client.prepareNextConnection();
    await assert.rejects(client.prepareNextConnection(), /reservation already (preparing|ready)/);
    await first;
    await assert.rejects(client.prepareNextConnection(), /reservation already ready/);
    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(socket, 3);
    socket.write(Buffer.from([0x01, 0x02, 0x03]));
    assert.deepEqual(await received, Buffer.from([0x01, 0x02, 0x03]));
    socket.destroy();
    await client.assertHealthy();
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('spawned client reports admission failure and health without replenishing', async (t) => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'fixture-turn-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const frontendControl = join(dir, 'frontend.json');
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
  const frontend = await spawnOwnedFixtureBridge({ role: 'frontend', controlPath: frontendControl,
    logPath: join(dir, 'frontend.log') });
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
  const client = await spawnOwnedFixtureBridge({ role: 'client', controlPath: clientControl,
    logPath: clientLog });
  await client.ready;
  await client.assertHealthy();
  try {
    await frontend.close();
    await assert.rejects(client.prepareNextConnection(), error => {
      assert.ok(error instanceof Error);
      assert.ok(!/bridge exited|readiness/.test(error.message), error.message);
      return true;
    });
    const before = timingEvents(readFileSync(clientLog, 'utf8'))
      .filter(event => event.event === 'wss.construct').length;
    await assert.rejects(client.assertHealthy(), /reservation/);
    const after = timingEvents(readFileSync(clientLog, 'utf8'))
      .filter(event => event.event === 'wss.construct').length;
    assert.equal(after, before);
  } finally {
    await client.close();
    await frontend.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('child disconnect rejects a pending reservation preparation and cleans sockets', async (t) => {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  const serverSockets = new Set();
  http.on('connection', socket => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
  });
  http.on('upgrade', (req, socket, head) => {
    setTimeout(() => {
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => {}); });
    }, 500);
  });
  const { port } = await listenOnce(http);
  const dir = mkdtempSync(join(tmpdir(), 'fixture-turn-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controlPath = join(dir, 'client.json');
  writeFileSync(controlPath, JSON.stringify({ role: 'client', options: {
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `ws://127.0.0.1:${port}/fixture/turn`,
    token: 'fresh-token',
  } }));
  const client = await spawnOwnedFixtureBridge({ role: 'client', controlPath,
    logPath: join(dir, 'client.log') });
  await client.ready;
  try {
    const preparing = client.prepareNextConnection();
    client.child.disconnect();
    await assert.rejects(preparing, /bridge child (exited|disconnected) during reservation preparation/);
    await once(client.child, 'exit');
    await waitFor(() => serverSockets.size === 0);
  } finally {
    await client.close();
    await new Promise(resolve => http.close(resolve));
    wss.close();
  }
});

const TIMING_EVENTS = new Set(['tcp.accept', 'wss.construct', 'wss.open', 'native.first-bytes',
  'wss.first-bytes', 'tcp.close', 'wss.close', 'health',
  'reservation.ready', 'reservation.claim', 'reservation.failed']);
const TIMING_KEYS = new Set(['ms', 'event', 'connection', 'bytes', 'sequence']);

function assertTimingShape(events) {
  let previous = -1;
  for (const event of events) {
    assert.equal(typeof event.event, 'string');
    assert.ok(TIMING_EVENTS.has(event.event), `unexpected timing event ${event.event}`);
    for (const [key, value] of Object.entries(event)) {
      assert.ok(TIMING_KEYS.has(key), `unexpected timing field ${key}`);
      if (key !== 'event') {
        assert.equal(typeof value, 'number', `timing field ${key} must stay numeric`);
        assert.ok(Number.isInteger(value), `timing field ${key} must be an integer`);
        assert.ok(value >= 0, `timing field ${key} must be non-negative`);
      }
    }
    assert.ok(Number.isInteger(event.connection) && event.connection >= 0);
    if ('bytes' in event) assert.ok(event.bytes >= 0);
    if ('sequence' in event) assert.ok(event.sequence > 0);
    assert.ok(event.ms >= previous, 'timing ms must stay monotonic');
    previous = event.ms;
  }
}

test('passive bridge timing keeps binary echo intact and reports sanitized per-connection events', async () => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const frontend = await startFixtureFrontend({
    listenHost: '127.0.0.1',
    listenPort: 0,
    relayOrigin: `http://127.0.0.1:${upstreamPort}`,
    turnTarget: { host: '127.0.0.1', port: upstreamPort },
    token: 'fresh-token',
  });
  const events = [];
  const client = await startFixtureTurnClient({
    listenHost: '127.0.0.1',
    listenPort: 0,
    bridgeUrl: `${frontend.origin.replace(/^http/, 'ws')}/fixture/turn`,
    token: 'fresh-token',
    onTiming: event => events.push(event),
  });
  try {
    assert.deepEqual(events.filter(event => event.connection === 0).map(event => event.event),
      ['wss.construct', 'wss.open', 'wss.close']);
    assert.ok(!events.some(event => event.event === 'tcp.accept' || event.event === 'native.first-bytes'));
    client.recordHealth(3);
    const health = events.filter(event => event.event === 'health');
    assert.equal(health.length, 1);
    assert.equal(health[0].connection, 0);
    assert.equal(health[0].sequence, 3);

    const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    const received = collectBytes(socket, 9);
    const payload = Buffer.from([0, 1, 2, 0xfe, 0xff, 65, 66, 67, 0]);
    socket.write(payload.slice(0, 2));
    socket.write(payload.slice(2));
    assert.deepEqual(await received, payload);

    const first = events.filter(event => event.connection === 1);
    for (const name of ['tcp.accept', 'wss.construct', 'wss.open', 'native.first-bytes']) {
      assert.equal(first.filter(event => event.event === name).length, 1);
    }
    assert.equal(first.filter(event => event.event === 'wss.first-bytes').length, 1);
    assert.ok(first.find(event => event.event === 'native.first-bytes').bytes > 0);
    assert.ok(first.find(event => event.event === 'wss.first-bytes').bytes > 0);

    const second = createConnection({ host: '127.0.0.1', port: client.listeningPort });
    await waitFor(() => events.some(event => event.connection === 2 && event.event === 'tcp.accept'));
    assert.equal(events.filter(event => event.event === 'wss.construct').length, 3);

    socket.destroy();
    second.destroy();
    await waitFor(() => [1, 2].every(connection => events.some(
      event => event.connection === connection && event.event === 'tcp.close'
        && events.some(paired => paired.connection === connection && paired.event === 'wss.close'))));
    assert.equal(events.filter(event => event.event === 'wss.open').length, 3);
    assertTimingShape(events);
  } finally {
    await client.close();
    await frontend.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('spawned client child emits sanitized timing lines with health boundaries', async (t) => {
  const upstream = echoTcpServer();
  const { port: upstreamPort } = await listenOnce(upstream);
  const dir = mkdtempSync(join(tmpdir(), 'fixture-turn-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const frontendControl = join(dir, 'frontend.json');
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
  const frontend = await spawnOwnedFixtureBridge({ role: 'frontend', controlPath: frontendControl,
    logPath: join(dir, 'frontend.log') });
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
  const client = await spawnOwnedFixtureBridge({ role: 'client', controlPath: clientControl,
    logPath: clientLog });
  await client.ready;
  await client.assertHealthy();
  const socket = createConnection({ host: '127.0.0.1', port: client.listeningPort });
  const received = collectBytes(socket, 3);
  socket.write(Buffer.from([0xaa, 0x00, 0xbb]));
  assert.deepEqual(await received, Buffer.from([0xaa, 0x00, 0xbb]));
  socket.destroy();
  await client.assertHealthy();
  await client.close();
  await frontend.close();
  await new Promise((resolve) => upstream.close(resolve));
  const lines = readFileSync(clientLog, 'utf8').split('\n')
    .filter(line => line.startsWith('rtc-bridge-timing: '));
  const events = lines.map(line => JSON.parse(line.slice('rtc-bridge-timing: '.length)));
  assert.ok(events.length > 0);
  assertTimingShape(events);
  const health = events.filter(event => event.event === 'health');
  assert.deepEqual(health.map(event => event.sequence), [1, 2]);
  assert.ok(health.every(event => event.connection === 0));
  const accepted = events.filter(event => event.event === 'tcp.accept');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].connection, 1);
  const raw = lines.join('\n');
  for (const forbidden of ['ws://', 'http://', '127.0.0.1', 'fresh-token', 'Bearer']) {
    assert.ok(!raw.includes(forbidden), `timing log must not contain ${forbidden}`);
  }
});
