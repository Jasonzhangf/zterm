import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { TraversalRelayStore } from './store';

interface SignalMessage {
  type: 'rtc-init' | 'rtc-offer' | 'rtc-answer' | 'rtc-candidate' | 'rtc-close' | 'rtc-error';
  payload?: Record<string, unknown>;
}

interface RelayHostEnvelope {
  type: 'relay-ready' | 'relay-signal' | 'relay-peer-close' | 'relay-error';
  peerId?: string;
  message?: SignalMessage;
  reason?: string;
  hostId?: string;
}

interface RelayHostConnection {
  socket: WebSocket;
  userId: string;
  username: string;
  hostId: string;
}

interface RelayClientConnection {
  socket: WebSocket;
  userId: string;
  username: string;
  hostId: string;
  peerId: string;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolvePort() {
  const raw = asString(process.env.ZTERM_TRAVERSAL_PORT || process.env.PORT || '19090');
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 19090;
}

function resolveHost() {
  return asString(process.env.ZTERM_TRAVERSAL_HOST || process.env.HOST || '127.0.0.1') || '127.0.0.1';
}

function resolveStorePath() {
  const configured = asString(process.env.ZTERM_TRAVERSAL_STORE_PATH);
  if (configured) {
    return configured;
  }
  const baseDir = asString(process.env.ZTERM_TRAVERSAL_DATA_DIR) || join(homedir(), '.wterm', 'traversal-relay');
  return join(baseDir, 'store.json');
}

function resolveTurnConfig() {
  const url = asString(process.env.ZTERM_TURN_URL);
  const username = asString(process.env.ZTERM_TURN_USERNAME);
  const credential = asString(process.env.ZTERM_TURN_CREDENTIAL);
  if (!url) {
    return null;
  }
  return { url, username, credential };
}

function resolveRequestOrigin(request: IncomingMessage) {
  const protocol = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
  const host = request.headers['x-forwarded-host'] || request.headers.host || `${HOST}:${PORT}`;
  return `${protocol}://${host}`;
}

function writeCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function serveJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw.trim() ? JSON.parse(raw) as T : {} as T;
}

function extractAccessToken(request: IncomingMessage, url: URL) {
  const authHeader = asString(request.headers.authorization);
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return asString(url.searchParams.get('token') || url.searchParams.get('accessToken'));
}

function sendHostEnvelope(socket: WebSocket, envelope: RelayHostEnvelope) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}

function hostKey(userId: string, hostId: string) {
  return `${userId}:${hostId}`;
}

const PORT = resolvePort();
const HOST = resolveHost();
const STORE_PATH = resolveStorePath();
const TURN_CONFIG = resolveTurnConfig();
mkdirSync(dirname(STORE_PATH), { recursive: true });
const store = new TraversalRelayStore(STORE_PATH);
const hosts = new Map<string, RelayHostConnection>();
const clients = new Map<string, RelayClientConnection>();

function buildHealthSnapshot(request: IncomingMessage) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    origin: resolveRequestOrigin(request),
    listeners: {
      host: HOST,
      port: PORT,
    },
    store: store.summary(),
    relay: {
      hosts: hosts.size,
      clients: clients.size,
    },
    turn: TURN_CONFIG,
  };
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse) {
  writeCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }

  const origin = resolveRequestOrigin(request);
  const url = new URL(request.url || '/', origin);

  if (request.method === 'GET' && url.pathname === '/health') {
    serveJson(response, buildHealthSnapshot(request));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    try {
      const body = await readJsonBody<{ username?: string; password?: string }>(request);
      const user = store.register(asString(body.username), asString(body.password));
      serveJson(response, { ok: true, user }, 201);
    } catch (error) {
      serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 400);
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const body = await readJsonBody<{ username?: string; password?: string }>(request);
      const login = store.login(asString(body.username), asString(body.password));
      serveJson(response, {
        ok: true,
        accessToken: login.token,
        user: login.user,
        turn: TURN_CONFIG,
        signalBaseUrl: new URL('./', origin).toString(),
      });
    } catch (error) {
      serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 401);
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: 'unauthorized' }, 401);
      return;
    }
    serveJson(response, { ok: true, user, turn: TURN_CONFIG });
    return;
  }

  serveJson(response, { ok: false, message: 'not found' }, 404);
}

const server = createServer((request, response) => {
  handleHttpRequest(request, response).catch((error) => {
    serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 500);
  });
});

const wss = new WebSocketServer({ noServer: true });

function closeClientPeer(peerId: string, reason: string) {
  const client = clients.get(peerId);
  if (!client) {
    return;
  }
  clients.delete(peerId);
  if (client.socket.readyState < WebSocket.CLOSING) {
    client.socket.close(1013, reason.slice(0, 120));
  }
}

function closeHost(host: RelayHostConnection, reason: string) {
  const key = hostKey(host.userId, host.hostId);
  if (hosts.get(key)?.socket === host.socket) {
    hosts.delete(key);
  }
  for (const client of [...clients.values()]) {
    if (client.userId === host.userId && client.hostId === host.hostId) {
      closeClientPeer(client.peerId, reason);
    }
  }
}

function registerHost(ws: WebSocket, request: IncomingMessage, url: URL) {
  const accessToken = extractAccessToken(request, url);
  const user = accessToken ? store.authenticate(accessToken) : null;
  const hostId = asString(url.searchParams.get('hostId'));
  if (!user || !hostId) {
    ws.send(JSON.stringify({ type: 'relay-error', reason: 'unauthorized host registration' }));
    ws.close(4001, 'unauthorized');
    return;
  }

  const key = hostKey(user.id, hostId);
  if (hosts.has(key)) {
    ws.send(JSON.stringify({ type: 'relay-error', reason: `host ${hostId} already connected` }));
    ws.close(4009, 'host already connected');
    return;
  }

  const host: RelayHostConnection = {
    socket: ws,
    userId: user.id,
    username: user.username,
    hostId,
  };
  hosts.set(key, host);
  sendHostEnvelope(ws, { type: 'relay-ready', hostId });

  ws.on('message', (raw) => {
    try {
      const envelope = JSON.parse(String(raw)) as RelayHostEnvelope;
      if (!envelope.peerId) {
        return;
      }
      const client = clients.get(envelope.peerId);
      if (!client) {
        return;
      }
      if (envelope.type === 'relay-peer-close') {
        closeClientPeer(envelope.peerId, envelope.reason || 'host closed relay peer');
        return;
      }
      if (envelope.type !== 'relay-signal' || !envelope.message) {
        return;
      }
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify(envelope.message));
      }
    } catch (error) {
      sendHostEnvelope(ws, {
        type: 'relay-error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ws.on('close', () => closeHost(host, 'host relay disconnected'));
  ws.on('error', () => closeHost(host, 'host relay websocket error'));
}

function registerClient(ws: WebSocket, request: IncomingMessage, url: URL) {
  const accessToken = extractAccessToken(request, url);
  const user = accessToken ? store.authenticate(accessToken) : null;
  const hostId = asString(url.searchParams.get('hostId'));
  if (!user || !hostId) {
    ws.send(JSON.stringify({ type: 'rtc-error', payload: { message: 'unauthorized relay client' } }));
    ws.close(4001, 'unauthorized');
    return;
  }

  const host = hosts.get(hostKey(user.id, hostId));
  if (!host) {
    ws.send(JSON.stringify({ type: 'rtc-error', payload: { message: `host ${hostId} is offline` } }));
    ws.close(4404, 'host offline');
    return;
  }

  const peerId = randomUUID();
  const client: RelayClientConnection = {
    socket: ws,
    userId: user.id,
    username: user.username,
    hostId,
    peerId,
  };
  clients.set(peerId, client);

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw)) as SignalMessage;
      sendHostEnvelope(host.socket, {
        type: 'relay-signal',
        peerId,
        message,
      });
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'rtc-error',
          payload: { message: error instanceof Error ? error.message : String(error) },
        }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(peerId);
    sendHostEnvelope(host.socket, {
      type: 'relay-peer-close',
      peerId,
      reason: 'client relay websocket closed',
    });
  });

  ws.on('error', () => {
    clients.delete(peerId);
    sendHostEnvelope(host.socket, {
      type: 'relay-peer-close',
      peerId,
      reason: 'client relay websocket error',
    });
  });
}

server.on('upgrade', (request, socket, head) => {
  const origin = resolveRequestOrigin(request);
  const url = new URL(request.url || '/', origin);
  const pathname = url.pathname;

  if (pathname !== '/ws/host' && pathname !== '/ws/client') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === '/ws/host') {
      registerHost(ws, request, url);
      return;
    }
    registerClient(ws, request, url);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] zterm traversal relay listening on http://${HOST}:${PORT}`);
  console.log(`  - health: http://${HOST}:${PORT}/health`);
  console.log(`  - register: POST http://${HOST}:${PORT}/api/auth/register`);
  console.log(`  - login: POST http://${HOST}:${PORT}/api/auth/login`);
  console.log(`  - host ws: ws://${HOST}:${PORT}/ws/host?token=<access>&hostId=<hostId>`);
  console.log(`  - client ws: ws://${HOST}:${PORT}/ws/client?token=<access>&hostId=<hostId>`);
  console.log(`  - store: ${STORE_PATH}`);
  console.log(`  - turn: ${TURN_CONFIG ? TURN_CONFIG.url : 'disabled'}`);
});
