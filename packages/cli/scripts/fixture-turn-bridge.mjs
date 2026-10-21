import { createServer, request } from 'node:http';
import { createServer as tcpServer, connect, isIP } from 'node:net';
import { readFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket, createWebSocketStream } from 'ws';

const route = '/fixture/turn';
function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function listen(server, host, port) {
  return new Promise((resolve, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(port, host, () => {
      server.removeListener('error', rejectReady);
      resolve(server.address().port);
    });
  });
}
function ownedSockets() {
  const sockets = new Set();
  return {
    add(socket) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return socket;
    },
    close() { for (const socket of sockets) socket.destroy(); },
  };
}
function pair(first, second) {
  const close = () => { first.destroy(); second.destroy(); };
  first.on('error', close);
  second.on('error', close);
  first.once('close', close);
  second.once('close', close);
  first.pipe(second).pipe(first);
}
function closeOwner(server, sockets, extra = () => {}) {
  let closing;
  return () => closing ??= new Promise(resolve => {
    server.close(error => resolve({ closed: !error, errors: error ? [error.message] : [] }));
    sockets.close();
    extra();
  });
}
function loopback(host) {
  if (host !== '127.0.0.1') throw new Error('fixture target must use IPv4 loopback');
}

export async function startFixtureFrontend({ listenHost, listenPort, relayOrigin, turnTarget, token }) {
  loopback(listenHost);
  loopback(turnTarget.host);
  const relay = new URL(relayOrigin);
  loopback(relay.hostname);
  if (relay.protocol !== 'http:' || !token) throw new Error('invalid fixture frontend control');
  const sockets = ownedSockets();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const proxyRequest = req => request({ hostname: relay.hostname, port: relay.port,
    method: req.method, path: req.url, headers: { ...req.headers, host: relay.host }, agent: false });
  const server = createServer((req, res) => {
    const upstream = proxyRequest(req);
    upstream.once('socket', socket => sockets.add(socket));
    upstream.once('response', response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', socket => sockets.add(socket));
  server.on('upgrade', (req, socket, head) => {
    if (req.url === route) {
      if (req.headers.authorization !== `Bearer ${token}`) { reject(socket, '401 Unauthorized'); return; }
      const upstream = sockets.add(connect(turnTarget));
      socket.once('close', () => upstream.destroy());
      const unavailable = () => reject(socket, '502 Bad Gateway');
      upstream.once('error', unavailable);
      upstream.once('connect', () => {
        if (socket.destroyed) { upstream.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          upstream.removeListener('error', unavailable);
          pair(upstream, createWebSocketStream(ws));
        });
      });
      return;
    }
    const upstream = proxyRequest(req);
    upstream.once('socket', connected => sockets.add(connected));
    socket.once('close', () => upstream.destroy());
    upstream.once('error', () => reject(socket, '502 Bad Gateway'));
    upstream.once('response', response => { reject(socket, `${response.statusCode} Upgrade Rejected`); response.resume(); });
    upstream.once('upgrade', (response, connected, upstreamHead) => {
      const headers = response.rawHeaders;
      socket.write(`HTTP/1.1 101 ${response.statusMessage}\r\n`);
      for (let i = 0; i < headers.length; i += 2) socket.write(`${headers[i]}: ${headers[i + 1]}\r\n`);
      socket.write('\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) connected.write(head);
      pair(socket, connected);
    });
    upstream.end();
  });
  const port = await listen(server, listenHost, listenPort);
  return { origin: `http://127.0.0.1:${port}`, close: closeOwner(server, sockets, () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }) };
}

export async function startFixtureTurnClient({ listenHost, listenPort, bridgeUrl, token, resolvedBridgeAddress }) {
  loopback(listenHost);
  const bridgeHost = new URL(bridgeUrl).hostname;
  if (resolvedBridgeAddress && isIP(resolvedBridgeAddress) !== 4) throw new Error('fixture bridge resolution requires IPv4');
  const sockets = ownedSockets();
  const webSockets = new Set();
  function open() {
    const ws = new WebSocket(bridgeUrl, { headers: { Authorization: `Bearer ${token}` },
      perMessageDeflate: false, handshakeTimeout: 10000,
      ...(resolvedBridgeAddress ? { lookup(host, options, callback) {
        if (host !== bridgeHost) { callback(new Error('unexpected bridge hostname')); return; }
        if (options.all) callback(null, [{ address: resolvedBridgeAddress, family: 4 }]);
        else callback(null, resolvedBridgeAddress, 4);
      } } : {}) });
    webSockets.add(ws);
    ws.once('close', () => webSockets.delete(ws));
    return ws;
  }
  const server = tcpServer(socket => {
    sockets.add(socket);
    const ws = open();
    pair(socket, createWebSocketStream(ws));
  });
  const listeningPort = await listen(server, listenHost, listenPort);
  const close = closeOwner(server, sockets, () => {
    for (const ws of webSockets) ws.terminate();
  });
  try {
    await new Promise((resolve, rejectReady) => {
      const probe = open();
      probe.once('error', rejectReady);
      probe.once('open', () => probe.close());
      probe.once('close', code => code === 1005 || code === 1000 ? resolve() : rejectReady(new Error('bridge probe closed abnormally')));
    });
  } catch (error) { await close(); throw error; }
  return { listeningPort, close };
}

export function spawnOwnedFixtureBridge({ role, controlPath, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a', 0o600);
  const child = fork(fileURLToPath(import.meta.url), [controlPath], { stdio: ['ignore', log, log, 'ipc'], execArgv: [] });
  closeSync(log);
  const handle = { pid: child.pid, child };
  let startupError;
  let closedResult;
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true;
    resolve(closedResult ?? { closed: false, errors: [`bridge exited without cleanup receipt (${code ?? signal})`] });
  }));
  handle.ready = new Promise((resolve, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('bridge readiness timeout')), 15000);
    const finish = () => clearTimeout(timer);
    child.once('error', error => { startupError = error; finish(); rejectReady(error); });
    child.once('exit', () => { finish(); rejectReady(new Error('bridge exited before readiness')); });
    child.on('message', message => {
      if (message.type === 'ready') {
        Object.assign(handle, message.value); finish(); resolve(message.value);
      } else if (message.type === 'error') {
        startupError = new Error(message.error); finish(); rejectReady(startupError);
      } else if (message.type === 'closed') closedResult = message.result;
    });
  });
  let healthId = 0;
  handle.assertHealthy = async () => {
    await handle.ready;
    if (startupError || exited || !child.connected) throw startupError ?? new Error('bridge child exited');
    const id = ++healthId;
    await new Promise((resolve, rejectHealth) => {
      const finish = error => {
        clearTimeout(timer);
        child.off('message', message);
        child.off('exit', gone);
        if (error) rejectHealth(error); else resolve();
      };
      const message = value => { if (value.type === 'health' && value.id === id) finish(); };
      const gone = () => finish(new Error('bridge child exited during health check'));
      const timer = setTimeout(() => finish(new Error('bridge child health timeout')), 3000);
      child.on('message', message);
      child.once('exit', gone);
      child.send({ type: 'health', id }, error => { if (error) finish(error); });
    });
  };
  let closing;
  handle.close = () => closing ??= (async () => {
    if (!exited && child.connected) child.send({ type: 'close' });
    return await exit;
  })();
  return handle;
}

async function childMain() {
  const control = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  let owner;
  let closing;
  const close = () => closing ??= (async () => {
    const result = owner ? await owner.close() : { closed: true, errors: [] };
    if (process.connected) process.send({ type: 'closed', result }, () => process.disconnect());
    process.exitCode = result.closed ? 0 : 1;
  })();
  process.on('message', message => {
    if (message.type === 'close') void close();
    if (message.type === 'health' && owner && !closing) process.send({ type: 'health', id: message.id });
  });
  process.on('disconnect', () => { void close(); });
  try {
    if (control.role === 'frontend') owner = await startFixtureFrontend(control.options);
    else if (control.role === 'client') owner = await startFixtureTurnClient(control.options);
    else throw new Error('unknown fixture bridge role');
    if (!process.connected) { await owner.close(); return; }
    process.send({ type: 'ready', value: control.role === 'frontend'
      ? { origin: owner.origin } : { listeningPort: owner.listeningPort } });
  } catch (error) {
    if (process.connected) process.send({ type: 'error', error: error.message });
    await close();
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await childMain();
