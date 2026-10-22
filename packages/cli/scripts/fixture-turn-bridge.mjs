import { createServer, request } from 'node:http';
import { createServer as tcpServer, connect, isIP } from 'node:net';
import { readFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
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
    method: req.method, path: req.url, headers: req.headers, agent: false });
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
      const upstream = sockets.add(connect({ ...turnTarget, noDelay: true }));
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

export async function startFixtureTurnClient({ listenHost, listenPort, bridgeUrl, token, resolvedBridgeAddress, onTiming = () => {} }) {
  loopback(listenHost);
  const startMs = performance.now();
  const bridgeHost = new URL(bridgeUrl).hostname;
  if (resolvedBridgeAddress && isIP(resolvedBridgeAddress) !== 4) throw new Error('fixture bridge resolution requires IPv4');
  const sockets = ownedSockets();
  const webSockets = new Set();
  let nextConnection = 0;
  let shuttingDown = false;
  let reservation = emptyReservation();
  function emptyReservation() {
    return { state: 'empty', connection: null, ws: null, stream: null, error: null,
      onError: null, onClose: null, onStreamError: null, cancel: null };
  }
  function releaseReservation(entry) {
    entry.ws = null;
    entry.stream = null;
    entry.onError = null;
    entry.onClose = null;
    entry.onStreamError = null;
    entry.cancel = null;
  }
  const emit = (event, connection, extra) => {
    const timing = { ms: Math.floor(performance.now() - startMs), event, connection };
    if (extra) Object.assign(timing, extra);
    onTiming(timing);
  };
  const safeErrorMessage = error => {
    const message = error?.message ? String(error.message) : 'reservation admission failed';
    return token ? message.split(token).join('[redacted]') : message;
  };
  const admissionError = error => {
    const safe = error instanceof Error ? error : new Error(String(error ?? 'reservation admission failed'));
    return new Error(`reservation admission failed: ${safeErrorMessage(safe)}`);
  };
  function open(connection) {
    emit('wss.construct', connection);
    const ws = new WebSocket(bridgeUrl, { headers: { Authorization: `Bearer ${token}` },
      perMessageDeflate: false, handshakeTimeout: 10000,
      ...(resolvedBridgeAddress ? { lookup(host, options, callback) {
        if (host !== bridgeHost) { callback(new Error('unexpected bridge hostname')); return; }
        if (options.all) callback(null, [{ address: resolvedBridgeAddress, family: 4 }]);
        else callback(null, resolvedBridgeAddress, 4);
      } } : {}) });
    webSockets.add(ws);
    ws.once('open', () => emit('wss.open', connection));
    ws.once('close', () => { webSockets.delete(ws); emit('wss.close', connection); });
    ws.once('message', chunk => emit('wss.first-bytes', connection, { bytes: Buffer.byteLength(chunk) }));
    return ws;
  }
  function prepareNextConnection() {
    if (shuttingDown) return Promise.reject(new Error('bridge is closing'));
    if (reservation.state === 'preparing') return Promise.reject(new Error('reservation already preparing'));
    if (reservation.state === 'ready') return Promise.reject(new Error('reservation already ready'));
    const connection = ++nextConnection;
    const entry = { ...emptyReservation(), state: 'preparing', connection };
    reservation = entry;
    let ws;
    let stream;
    try {
      ws = open(connection);
      entry.ws = ws;
      stream = createWebSocketStream(ws);
      entry.stream = stream;
    } catch (error) {
      entry.state = 'failed';
      entry.error = error;
      emit('reservation.failed', connection);
      if (ws) ws.terminate();
      releaseReservation(entry);
      return Promise.reject(admissionError(error));
    }
    return new Promise((resolve, rejectReady) => {
      let admissionSettled = false;
      const fail = error => {
        const safeError = error instanceof Error ? error : new Error(String(error ?? 'reservation admission failed'));
        if (entry.state === 'failed' || entry.state === 'claimed') return;
        if (shuttingDown) {
          if (entry.state === 'preparing' && !admissionSettled) {
            admissionSettled = true;
            entry.state = 'failed';
            entry.error = safeError;
            rejectReady(admissionError(safeError));
          }
          if (entry.state === 'ready') entry.state = 'empty';
          ws.terminate();
          if (!stream.destroyed) stream.destroy();
          releaseReservation(entry);
          return;
        }
        const wasPreparing = entry.state === 'preparing';
        entry.state = 'failed';
        entry.error = safeError;
        emit('reservation.failed', connection);
        if (wasPreparing && !admissionSettled) {
          admissionSettled = true;
          rejectReady(admissionError(safeError));
        }
        ws.terminate();
        if (!stream.destroyed) stream.destroy();
        releaseReservation(entry);
      };
      const onOpen = () => {
        if (entry.state !== 'preparing') {
          fail(new Error('reservation closed before claim'));
          return;
        }
        entry.state = 'ready';
        admissionSettled = true;
        emit('reservation.ready', connection);
        resolve();
      };
      const onError = error => fail(error ?? new Error('reservation admission failed'));
      const onClose = () => fail(new Error('reservation closed before claim'));
      const onStreamError = error => fail(error ?? new Error('reservation stream failed'));
      entry.onError = onError;
      entry.onClose = onClose;
      entry.onStreamError = onStreamError;
      entry.cancel = error => {
        if (entry.state !== 'preparing' || admissionSettled) return;
        entry.state = 'failed';
        entry.error = error;
        admissionSettled = true;
        rejectReady(admissionError(error));
        ws.terminate();
        if (!stream.destroyed) stream.destroy();
        releaseReservation(entry);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.once('close', onClose);
      stream.once('error', onStreamError);
    });
  }
  const server = tcpServer(socket => {
    if (shuttingDown) {
      socket.once('error', () => {});
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    sockets.add(socket);
    if (reservation.state === 'ready') {
      const reserved = reservation;
      reservation = { ...emptyReservation(), state: 'claimed', connection: reserved.connection };
      const connection = reserved.connection;
      emit('tcp.accept', connection);
      emit('reservation.claim', connection);
      socket.once('data', chunk => emit('native.first-bytes', connection, { bytes: Buffer.byteLength(chunk) }));
      socket.once('close', () => emit('tcp.close', connection));
      reserved.ws.off('error', reserved.onError);
      reserved.ws.off('close', reserved.onClose);
      reserved.stream.off('error', reserved.onStreamError);
      pair(socket, reserved.stream);
      return;
    }
    if (reservation.state === 'failed') {
      const failed = reservation;
      reservation = emptyReservation();
      const connection = failed.connection;
      emit('tcp.accept', connection);
      socket.once('error', () => {});
      socket.once('close', () => emit('tcp.close', connection));
      socket.destroy();
      return;
    }
    const connection = ++nextConnection;
    emit('tcp.accept', connection);
    socket.once('data', chunk => emit('native.first-bytes', connection, { bytes: Buffer.byteLength(chunk) }));
    socket.once('close', () => emit('tcp.close', connection));
    const ws = open(connection);
    const stream = createWebSocketStream(ws);
    pair(socket, stream);
  });
  const listeningPort = await listen(server, listenHost, listenPort);
  const closeBase = closeOwner(server, sockets, () => {
    for (const ws of webSockets) ws.terminate();
  });
  const close = () => {
    shuttingDown = true;
    if (reservation.state === 'preparing' && reservation.cancel) {
      reservation.cancel(new Error('bridge closed during reservation preparation'));
    }
    return closeBase();
  };
  try {
    await new Promise((resolve, rejectReady) => {
      const probe = open(0);
      probe.once('error', rejectReady);
      probe.once('open', () => probe.close());
      probe.once('close', code => code === 1005 || code === 1000 ? resolve() : rejectReady(new Error('bridge probe closed abnormally')));
    });
  } catch (error) { await close(); throw error; }
  return { listeningPort, close, prepareNextConnection,
    recordHealth: sequence => {
      emit('health', 0, { sequence });
      return reservation.state === 'failed'
        ? `reservation failed: ${safeErrorMessage(reservation.error)}` : undefined;
    } };
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
        child.off('disconnect', gone);
        if (error) rejectHealth(error); else resolve();
      };
      const message = value => {
        if (value.type !== 'health' || value.id !== id) return;
        finish(value.error ? new Error(value.error) : undefined);
      };
      const gone = () => finish(new Error('bridge child exited during health check'));
      const timer = setTimeout(() => finish(new Error('bridge child health timeout')), 3000);
      child.on('message', message);
      child.once('exit', gone);
      child.once('disconnect', gone);
      try {
        child.send({ type: 'health', id }, error => { if (error) finish(error); });
      } catch (error) {
        finish(error);
      }
    });
  };
  let prepareId = 0;
  handle.prepareNextConnection = async () => {
    await handle.ready;
    if (startupError || exited || !child.connected) {
      throw startupError ?? new Error('bridge child exited during reservation preparation');
    }
    const id = ++prepareId;
    await new Promise((resolve, rejectPrepare) => {
      const finish = error => {
        clearTimeout(timer);
        child.off('message', message);
        child.off('exit', gone);
        child.off('disconnect', gone);
        if (error) rejectPrepare(error); else resolve();
      };
      const message = value => {
        if (value.type !== 'prepared' || value.id !== id) return;
        finish(value.ok ? undefined : new Error(value.error || 'reservation preparation failed'));
      };
      const gone = () => finish(new Error('bridge child exited during reservation preparation'));
      const timer = setTimeout(() => finish(new Error('bridge child reservation preparation timeout')), 15000);
      child.on('message', message);
      child.once('exit', gone);
      child.once('disconnect', gone);
      try {
        child.send({ type: 'prepare', id }, error => { if (error) finish(error); });
      } catch (error) {
        finish(error);
      }
    });
  };
  let closing;
  handle.close = () => closing ??= (async () => {
    if (!exited && child.connected) {
      try { child.send({ type: 'close' }); } catch { /* the exit receipt below reports cleanup */ }
    }
    return await exit;
  })();
  return handle;
}

async function childMain() {
  const control = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  let owner;
  let closing;
  const send = (message, callback) => {
    if (!process.connected) return false;
    try { return process.send(message, callback); } catch { return false; }
  };
  const close = () => closing ??= (async () => {
    const result = owner ? await owner.close() : { closed: true, errors: [] };
    if (!send({ type: 'closed', result }, () => process.disconnect()) && process.connected) process.disconnect();
    process.exitCode = result.closed ? 0 : 1;
  })();
  process.on('message', message => {
    if (message.type === 'close') void close();
    if (message.type === 'health' && owner && !closing) {
      const reservationError = owner.recordHealth ? owner.recordHealth(message.id) : undefined;
      send({ type: 'health', id: message.id, ...(reservationError ? { error: reservationError } : {}) });
    }
    if (message.type === 'prepare') {
      const { id } = message;
      if (!owner || !owner.prepareNextConnection || closing) {
        send({ type: 'prepared', id, ok: false, error: 'bridge not ready' });
        return;
      }
      Promise.resolve().then(() => owner.prepareNextConnection()).then(
        () => { if (!closing) send({ type: 'prepared', id, ok: true }); },
        error => { if (!closing) send({ type: 'prepared', id, ok: false,
          error: error?.message ?? 'reservation preparation failed' }); },
      );
    }
  });
  process.on('disconnect', () => { void close(); });
  try {
    if (control.role === 'frontend') owner = await startFixtureFrontend(control.options);
    else if (control.role === 'client') owner = await startFixtureTurnClient({
      ...control.options,
      onTiming: event => process.stdout.write('rtc-bridge-timing: ' + JSON.stringify(event) + '\n'),
    });
    else throw new Error('unknown fixture bridge role');
    if (!process.connected) { await owner.close(); return; }
    send({ type: 'ready', value: control.role === 'frontend'
      ? { origin: owner.origin } : { listeningPort: owner.listeningPort } });
  } catch (error) {
    send({ type: 'error', error: error.message });
    await close();
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await childMain();
