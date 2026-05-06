import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { TraversalRelayStore, type TraversalRelayPublicUser } from './store';

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

interface DevicePresenceInputEnvelope {
  type: 'devices-request' | 'device-meta';
  payload?: {
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    appVersion?: string;
  };
}

interface DevicePresenceOutputEnvelope {
  type: 'devices-snapshot' | 'device-updated' | 'relay-error';
  payload?: Record<string, unknown>;
  reason?: string;
}

interface RelayHostConnection {
  socket: WebSocket;
  userId: string;
  username: string;
  hostId: string;
  deviceId: string;
  daemonVersion: string;
}

interface RelayClientConnection {
  socket: WebSocket;
  userId: string;
  username: string;
  hostId: string;
  peerId: string;
}

interface DeviceStreamConnection {
  id: string;
  socket: WebSocket;
  userId: string;
  username: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
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

function resolveBasePath() {
  const raw = asString(process.env.ZTERM_TRAVERSAL_BASE_PATH);
  if (!raw || raw === '/') {
    return '';
  }
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, '');
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

function routePath(path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalized}` || normalized;
}

function buildPublicBaseUrl(request: IncomingMessage) {
  return `${resolveRequestOrigin(request)}${BASE_PATH}/`;
}

function buildWebSocketBaseUrl(request: IncomingMessage) {
  const httpOrigin = resolveRequestOrigin(request);
  const wsOrigin = httpOrigin.startsWith('https://')
    ? `wss://${httpOrigin.slice('https://'.length)}`
    : httpOrigin.startsWith('http://')
      ? `ws://${httpOrigin.slice('http://'.length)}`
      : httpOrigin;
  return `${wsOrigin}${BASE_PATH}/`;
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

function serveHtml(response: ServerResponse, html: string, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
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

function sendDeviceEnvelope(socket: WebSocket, envelope: DevicePresenceOutputEnvelope) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}

function hostKey(userId: string, hostId: string) {
  return `${userId}:${hostId}`;
}

function deviceKey(userId: string, deviceId: string) {
  return `${userId}:${deviceId}`;
}

function buildAuthPage(mode: 'login' | 'register') {
  const pageTitle = mode === 'login' ? 'ZTerm Relay Login' : 'ZTerm Relay Register';
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${pageTitle}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0b1220; color:#e5eefb; }
      .wrap { max-width: 980px; margin: 0 auto; padding: 32px 18px 56px; }
      .hero { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; align-items:flex-start; margin-bottom: 24px; }
      .hero h1 { margin:0; font-size:28px; }
      .hero p { margin:8px 0 0; color:#93a4bf; line-height:1.6; }
      .tabs { display:flex; gap:8px; margin-top: 10px; }
      .tab { padding:10px 14px; border-radius: 10px; background:#162033; color:#dce8fb; text-decoration:none; }
      .tab.active { background:#2c486d; }
      .grid { display:grid; grid-template-columns: minmax(300px, 380px) 1fr; gap:18px; }
      .card { background:#111a2d; border:1px solid #1d2a45; border-radius:16px; padding:18px; box-shadow:0 16px 40px rgba(0,0,0,.25); }
      label { display:block; font-size:13px; color:#9fb2d1; margin-bottom:8px; }
      input { width:100%; box-sizing:border-box; padding:12px 14px; border-radius:12px; border:1px solid #2a3a5c; background:#0b1322; color:#f3f7ff; margin-bottom:12px; }
      button { width:100%; padding:12px 14px; border:none; border-radius:12px; background:#4b81c7; color:white; font-weight:700; cursor:pointer; }
      button.secondary { background:#26354f; }
      .stack { display:flex; flex-direction:column; gap:12px; }
      .hint { font-size:12px; color:#8da0bd; line-height:1.6; }
      .status { padding:10px 12px; border-radius:12px; background:#0b1322; color:#b9c7de; white-space:pre-wrap; word-break:break-word; min-height:44px; }
      .device-list { display:flex; flex-direction:column; gap:10px; margin-top:12px; }
      .device { background:#0b1322; border:1px solid #223152; border-radius:12px; padding:12px; }
      .device h3 { margin:0 0 8px; font-size:15px; }
      .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:6px 12px; font-size:12px; color:#9fb2d1; }
      code { color:#cfe0ff; }
      @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="hero">
        <div>
          <h1>${pageTitle}</h1>
          <p>这是 zterm traversal/turn 控制面。主登录通常由客户端完成；此页面用于注册、登录与实时查看当前用户名下设备绑定状态。</p>
        </div>
        <div class="tabs">
          <a class="tab ${mode === 'login' ? 'active' : ''}" href="${routePath('/login')}">登录</a>
          <a class="tab ${mode === 'register' ? 'active' : ''}" href="${routePath('/register')}">注册</a>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="stack">
            <div>
              <label>用户名</label>
              <input id="username" autocomplete="username" />
            </div>
            <div>
              <label>密码</label>
              <input id="password" type="password" autocomplete="current-password" />
            </div>
            <div>
              <label>设备 ID（用于实时 presence，可留空只查看）</label>
              <input id="deviceId" placeholder="例如 tablet-jason / macbook-jason" />
            </div>
            <div>
              <label>设备名称</label>
              <input id="deviceName" placeholder="例如 Jason iPad" />
            </div>
            <div>
              <label>平台</label>
              <input id="platform" placeholder="android / ios / mac / windows" />
            </div>
            <div>
              <label>App Version</label>
              <input id="appVersion" placeholder="0.1.1" />
            </div>
            ${mode === 'register' ? '<button id="submit">注册并登录</button>' : '<button id="submit">登录</button>'}
            <button class="secondary" id="connectDevices">连接设备列表流</button>
            <div class="hint">API base: <code>${BASE_PATH || '/'}</code><br/>登录后会通过 <code>/ws/devices</code> 实时推送同用户名下设备列表。</div>
            <div id="status" class="status">尚未登录</div>
          </div>
        </div>

        <div class="card">
          <h2 style="margin-top:0; font-size:18px;">设备列表</h2>
          <div class="hint">client 登录后会实时上报 device presence；daemon 连接时会绑定 deviceId + hostId。</div>
          <div id="userInfo" class="status" style="margin-top:12px;">未连接</div>
          <div id="devices" class="device-list"></div>
        </div>
      </div>
    </div>

    <script>
      const mode = ${JSON.stringify(mode)};
      const basePath = ${JSON.stringify(BASE_PATH)};
      const tokenKey = 'ztermRelayAccessToken';
      const userKey = 'ztermRelayUser';
      const els = {
        username: document.getElementById('username'),
        password: document.getElementById('password'),
        deviceId: document.getElementById('deviceId'),
        deviceName: document.getElementById('deviceName'),
        platform: document.getElementById('platform'),
        appVersion: document.getElementById('appVersion'),
        submit: document.getElementById('submit'),
        connectDevices: document.getElementById('connectDevices'),
        status: document.getElementById('status'),
        userInfo: document.getElementById('userInfo'),
        devices: document.getElementById('devices'),
      };
      let accessToken = localStorage.getItem(tokenKey) || '';
      let deviceSocket = null;
      const cachedUserRaw = localStorage.getItem(userKey);
      if (cachedUserRaw) {
        try {
          const cachedUser = JSON.parse(cachedUserRaw);
          els.userInfo.textContent = JSON.stringify(cachedUser, null, 2);
          if (cachedUser.username) {
            els.username.value = cachedUser.username;
          }
        } catch {}
      }

      function endpoint(path) {
        return (basePath || '') + path;
      }

      function setStatus(text) {
        els.status.textContent = text;
      }

      function saveAuth(payload) {
        accessToken = payload.accessToken || '';
        localStorage.setItem(tokenKey, accessToken);
        localStorage.setItem(userKey, JSON.stringify(payload.user || null));
        els.userInfo.textContent = JSON.stringify(payload.user || null, null, 2);
      }

      function renderDevices(devices) {
        els.devices.innerHTML = '';
        if (!devices || devices.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'device';
          empty.textContent = '当前没有设备';
          els.devices.appendChild(empty);
          return;
        }
        for (const device of devices) {
          const item = document.createElement('div');
          item.className = 'device';
          const title = document.createElement('h3');
          title.textContent = (device.deviceName || '(未命名设备)') + ' · ' + device.deviceId;
          const meta = document.createElement('div');
          meta.className = 'meta';
          const rows = [
            ['platform', device.platform || '-'],
            ['appVersion', device.appVersion || '-'],
            ['online', String(Boolean(device.online))],
            ['client', device.client?.connected ? 'connected' : 'offline'],
            ['daemon', device.daemon?.connected ? ('connected (' + (device.daemon?.hostId || '-') + ')') : 'offline'],
            ['daemonVersion', device.daemon?.version || '-'],
            ['updatedAt', device.updatedAt || '-'],
            ['lastSeenAt', device.lastSeenAt || '-'],
          ];
          for (const [key, value] of rows) {
            const row = document.createElement('div');
            row.innerHTML = '<strong>' + key + '</strong>: ' + value;
            meta.appendChild(row);
          }
          item.appendChild(title);
          item.appendChild(meta);
          els.devices.appendChild(item);
        }
      }

      async function authRequest(path, payload) {
        const response = await fetch(endpoint(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.message || ('HTTP ' + response.status));
        }
        return data;
      }

      async function fetchDevices() {
        if (!accessToken) {
          throw new Error('请先登录');
        }
        const response = await fetch(endpoint('/api/devices'), {
          headers: { authorization: 'Bearer ' + accessToken },
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.message || ('HTTP ' + response.status));
        }
        renderDevices(data.devices || []);
      }

      function connectDevicesSocket() {
        if (!accessToken) {
          setStatus('请先登录');
          return;
        }
        if (deviceSocket && deviceSocket.readyState < 2) {
          setStatus('设备流已连接');
          return;
        }
        const url = new URL(((location.protocol === 'https:') ? 'wss://' : 'ws://') + location.host + endpoint('/ws/devices'));
        url.searchParams.set('token', accessToken);
        if (els.deviceId.value.trim()) url.searchParams.set('deviceId', els.deviceId.value.trim());
        if (els.deviceName.value.trim()) url.searchParams.set('deviceName', els.deviceName.value.trim());
        if (els.platform.value.trim()) url.searchParams.set('platform', els.platform.value.trim());
        if (els.appVersion.value.trim()) url.searchParams.set('appVersion', els.appVersion.value.trim());
        deviceSocket = new WebSocket(url);
        deviceSocket.onopen = () => {
          setStatus('设备流已连接');
          deviceSocket.send(JSON.stringify({
            type: 'devices-request',
            payload: {
              deviceId: els.deviceId.value.trim(),
              deviceName: els.deviceName.value.trim(),
              platform: els.platform.value.trim(),
              appVersion: els.appVersion.value.trim(),
            },
          }));
        };
        deviceSocket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'devices-snapshot' || data.type === 'device-updated') {
              renderDevices(data.payload?.devices || []);
              return;
            }
            if (data.type === 'relay-error') {
              setStatus(data.reason || '设备流错误');
            }
          } catch (error) {
            setStatus('设备流消息解析失败: ' + error.message);
          }
        };
        deviceSocket.onerror = () => setStatus('设备流连接失败');
        deviceSocket.onclose = () => setStatus('设备流已关闭');
      }

      els.submit.onclick = async () => {
        try {
          setStatus(mode === 'register' ? '注册中…' : '登录中…');
          if (mode === 'register') {
            await authRequest('/api/auth/register', {
              username: els.username.value,
              password: els.password.value,
            });
          }
          const login = await authRequest('/api/auth/login', {
            username: els.username.value,
            password: els.password.value,
          });
          saveAuth(login);
          setStatus('登录成功');
          renderDevices(login.devices || []);
          connectDevicesSocket();
        } catch (error) {
          setStatus(error.message || String(error));
        }
      };

      els.connectDevices.onclick = async () => {
        try {
          await fetchDevices();
          connectDevicesSocket();
        } catch (error) {
          setStatus(error.message || String(error));
        }
      };
    </script>
  </body>
</html>`;
}

const PORT = resolvePort();
const HOST = resolveHost();
const STORE_PATH = resolveStorePath();
const BASE_PATH = resolveBasePath();
const TURN_CONFIG = resolveTurnConfig();
mkdirSync(dirname(STORE_PATH), { recursive: true });
const store = new TraversalRelayStore(STORE_PATH);
const hosts = new Map<string, RelayHostConnection>();
const clients = new Map<string, RelayClientConnection>();
const deviceStreams = new Map<string, DeviceStreamConnection>();
const liveClientDevices = new Map<string, Set<string>>();
const liveDaemonDevices = new Map<string, Set<string>>();

function addLivePresence(map: Map<string, Set<string>>, connectionId: string, userId: string, deviceId: string) {
  const key = deviceKey(userId, deviceId);
  const current = map.get(key) || new Set<string>();
  current.add(connectionId);
  map.set(key, current);
}

function removeLivePresence(map: Map<string, Set<string>>, connectionId: string, userId: string, deviceId: string) {
  const key = deviceKey(userId, deviceId);
  const current = map.get(key);
  if (!current) {
    return false;
  }
  current.delete(connectionId);
  if (current.size === 0) {
    map.delete(key);
    return false;
  }
  return true;
}

function buildHealthSnapshot(request: IncomingMessage) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    pid: process.pid,
    origin: resolveRequestOrigin(request),
    basePath: BASE_PATH || '/',
    listeners: {
      host: HOST,
      port: PORT,
    },
    store: store.summary(),
    relay: {
      hosts: hosts.size,
      clients: clients.size,
      deviceStreams: deviceStreams.size,
      liveClientDevices: liveClientDevices.size,
      liveDaemonDevices: liveDaemonDevices.size,
    },
    turn: TURN_CONFIG,
  };
}

function buildAuthPayload(request: IncomingMessage, user: TraversalRelayPublicUser, accessToken?: string) {
  return {
    ok: true,
    accessToken,
    user,
    devices: store.listDevices(user.id),
    turn: TURN_CONFIG,
    relayBaseUrl: buildPublicBaseUrl(request),
    signalBaseUrl: buildPublicBaseUrl(request),
    ws: {
      devices: `${buildWebSocketBaseUrl(request)}ws/devices`,
      host: `${buildWebSocketBaseUrl(request)}ws/host`,
      client: `${buildWebSocketBaseUrl(request)}ws/client`,
    },
  };
}

function broadcastDevices(userId: string) {
  const devices = store.listDevices(userId);
  for (const connection of deviceStreams.values()) {
    if (connection.userId !== userId) {
      continue;
    }
    sendDeviceEnvelope(connection.socket, {
      type: 'devices-snapshot',
      payload: { devices },
    });
  }
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
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === routePath('/health')) {
    serveJson(response, buildHealthSnapshot(request));
    return;
  }

  if (request.method === 'GET' && (pathname === routePath('/') || pathname === routePath('/login'))) {
    serveHtml(response, buildAuthPage('login'));
    return;
  }

  if (request.method === 'GET' && pathname === routePath('/register')) {
    serveHtml(response, buildAuthPage('register'));
    return;
  }

  if (request.method === 'POST' && pathname === routePath('/api/auth/register')) {
    try {
      const body = await readJsonBody<{ username?: string; password?: string }>(request);
      const user = store.register(asString(body.username), asString(body.password));
      serveJson(response, { ok: true, user }, 201);
    } catch (error) {
      serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 400);
    }
    return;
  }

  if (request.method === 'POST' && pathname === routePath('/api/auth/login')) {
    try {
      const body = await readJsonBody<{ username?: string; password?: string }>(request);
      const login = store.login(asString(body.username), asString(body.password));
      serveJson(response, buildAuthPayload(request, login.user, login.token));
    } catch (error) {
      serveJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) }, 401);
    }
    return;
  }

  if (request.method === 'GET' && pathname === routePath('/api/auth/me')) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: 'unauthorized' }, 401);
      return;
    }
    serveJson(response, buildAuthPayload(request, user));
    return;
  }

  if (request.method === 'GET' && pathname === routePath('/api/devices')) {
    const accessToken = extractAccessToken(request, url);
    const user = accessToken ? store.authenticate(accessToken) : null;
    if (!user) {
      serveJson(response, { ok: false, message: 'unauthorized' }, 401);
      return;
    }
    serveJson(response, {
      ok: true,
      user,
      devices: store.listDevices(user.id),
    });
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
  const hasOtherDaemon = removeLivePresence(liveDaemonDevices, key, host.userId, host.deviceId);
  store.setDaemonConnected({
    userId: host.userId,
    deviceId: host.deviceId,
    hostId: host.hostId,
    daemonVersion: host.daemonVersion,
    connected: hasOtherDaemon,
  });
  broadcastDevices(host.userId);
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
  const deviceId = asString(url.searchParams.get('deviceId'));
  const deviceName = asString(url.searchParams.get('deviceName'));
  const platform = asString(url.searchParams.get('platform'));
  const appVersion = asString(url.searchParams.get('appVersion'));
  const daemonVersion = asString(url.searchParams.get('daemonVersion'));
  if (!user || !hostId || !deviceId) {
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
    deviceId,
    daemonVersion,
  };
  hosts.set(key, host);
  addLivePresence(liveDaemonDevices, key, user.id, deviceId);
  store.setDaemonConnected({
    userId: user.id,
    deviceId,
    hostId,
    deviceName,
    platform,
    appVersion,
    daemonVersion,
    connected: true,
  });
  broadcastDevices(user.id);
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

function registerDeviceStream(ws: WebSocket, request: IncomingMessage, url: URL) {
  const accessToken = extractAccessToken(request, url);
  const user = accessToken ? store.authenticate(accessToken) : null;
  if (!user) {
    sendDeviceEnvelope(ws, { type: 'relay-error', reason: 'unauthorized devices stream' });
    ws.close(4001, 'unauthorized');
    return;
  }

  const connectionId = randomUUID();
  const deviceId = asString(url.searchParams.get('deviceId'));
  const deviceName = asString(url.searchParams.get('deviceName'));
  const platform = asString(url.searchParams.get('platform'));
  const appVersion = asString(url.searchParams.get('appVersion'));
  const connection: DeviceStreamConnection = {
    id: connectionId,
    socket: ws,
    userId: user.id,
    username: user.username,
    deviceId,
    deviceName,
    platform,
    appVersion,
  };
  deviceStreams.set(connectionId, connection);

  if (deviceId) {
    addLivePresence(liveClientDevices, connectionId, user.id, deviceId);
    store.setClientConnected({
      userId: user.id,
      deviceId,
      deviceName,
      platform,
      appVersion,
      connected: true,
    });
  }
  broadcastDevices(user.id);
  sendDeviceEnvelope(ws, {
    type: 'devices-snapshot',
    payload: { devices: store.listDevices(user.id) },
  });

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw)) as DevicePresenceInputEnvelope;
      if (message.type === 'devices-request') {
        if (connection.deviceId) {
          store.setClientConnected({
            userId: user.id,
            deviceId: connection.deviceId,
            deviceName: asString(message.payload?.deviceName) || connection.deviceName,
            platform: asString(message.payload?.platform) || connection.platform,
            appVersion: asString(message.payload?.appVersion) || connection.appVersion,
            connected: true,
          });
          broadcastDevices(user.id);
        } else {
          sendDeviceEnvelope(ws, {
            type: 'devices-snapshot',
            payload: { devices: store.listDevices(user.id) },
          });
        }
        return;
      }
      if (message.type === 'device-meta') {
        const nextDeviceId = asString(message.payload?.deviceId) || connection.deviceId;
        if (!nextDeviceId) {
          throw new Error('deviceId is required for device-meta');
        }
        if (!connection.deviceId) {
          connection.deviceId = nextDeviceId;
          addLivePresence(liveClientDevices, connection.id, user.id, nextDeviceId);
        }
        connection.deviceName = asString(message.payload?.deviceName) || connection.deviceName;
        connection.platform = asString(message.payload?.platform) || connection.platform;
        connection.appVersion = asString(message.payload?.appVersion) || connection.appVersion;
        store.setClientConnected({
          userId: user.id,
          deviceId: connection.deviceId,
          deviceName: connection.deviceName,
          platform: connection.platform,
          appVersion: connection.appVersion,
          connected: true,
        });
        broadcastDevices(user.id);
      }
    } catch (error) {
      sendDeviceEnvelope(ws, {
        type: 'relay-error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const finalize = () => {
    deviceStreams.delete(connectionId);
    if (connection.deviceId) {
      const stillConnected = removeLivePresence(liveClientDevices, connectionId, user.id, connection.deviceId);
      store.setClientConnected({
        userId: user.id,
        deviceId: connection.deviceId,
        deviceName: connection.deviceName,
        platform: connection.platform,
        appVersion: connection.appVersion,
        connected: stillConnected,
      });
    }
    broadcastDevices(user.id);
  };

  ws.on('close', finalize);
  ws.on('error', finalize);
}

server.on('upgrade', (request, socket, head) => {
  const origin = resolveRequestOrigin(request);
  const url = new URL(request.url || '/', origin);
  const pathname = url.pathname;

  if (pathname !== routePath('/ws/host') && pathname !== routePath('/ws/client') && pathname !== routePath('/ws/devices')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    if (pathname === routePath('/ws/host')) {
      registerHost(ws, request, url);
      return;
    }
    if (pathname === routePath('/ws/devices')) {
      registerDeviceStream(ws, request, url);
      return;
    }
    registerClient(ws, request, url);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] zterm traversal relay listening on http://${HOST}:${PORT}${BASE_PATH || ''}`);
  console.log(`  - health: http://${HOST}:${PORT}${routePath('/health')}`);
  console.log(`  - login page: http://${HOST}:${PORT}${routePath('/login')}`);
  console.log(`  - register: POST http://${HOST}:${PORT}${routePath('/api/auth/register')}`);
  console.log(`  - login: POST http://${HOST}:${PORT}${routePath('/api/auth/login')}`);
  console.log(`  - devices: GET http://${HOST}:${PORT}${routePath('/api/devices')}`);
  console.log(`  - devices ws: ws://${HOST}:${PORT}${routePath('/ws/devices')}?token=<access>&deviceId=<deviceId>`);
  console.log(`  - host ws: ws://${HOST}:${PORT}${routePath('/ws/host')}?token=<access>&hostId=<hostId>&deviceId=<deviceId>`);
  console.log(`  - client ws: ws://${HOST}:${PORT}${routePath('/ws/client')}?token=<access>&hostId=<hostId>`);
  console.log(`  - store: ${STORE_PATH}`);
  console.log(`  - turn: ${TURN_CONFIG ? TURN_CONFIG.url : 'disabled'}`);
});
