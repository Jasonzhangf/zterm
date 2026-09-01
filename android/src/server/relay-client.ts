import { WebSocket } from 'ws';
import type { RelayEndpointCandidate, RelayTmuxSessionSnapshot } from '@zterm/shared/relay-directory';
import type { SignalMessage } from './rtc-bridge';

interface TraversalRelayRuntimeConfig {
  relayUrl: string;
  username: string;
  password: string;
  hostId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  daemonVersion: string;
}

interface CreateTraversalRelayHostClientOptions {
  config: TraversalRelayRuntimeConfig | null;
  handleRelaySignal: (peerId: string, message: SignalMessage, emitSignal: (message: SignalMessage) => void) => Promise<void>;
  closeRelayPeer: (peerId: string, reason: string) => void;
  listEndpointCandidates: (now: string) => RelayEndpointCandidate[];
  listTerminalSessionCatalog: () => Array<Pick<RelayTmuxSessionSnapshot, 'name' | 'cwd'>>;
  now?: () => string;
}

interface RelayHostEnvelope {
  type: 'relay-ready' | 'relay-signal' | 'relay-peer-close' | 'relay-error' | 'directory-update';
  peerId?: string;
  reason?: string;
  message?: SignalMessage;
  hostId?: string;
  directory?: {
    endpoints?: RelayEndpointCandidate[];
    sessions?: RelayTmuxSessionSnapshot[];
    publishedAt?: string;
  };
}

interface RelayDirectoryPublisherSocket {
  readyState: number;
  send: (payload: string) => void;
}

/**
 * daemon 与 relay 之间无应用层心跳，Mac 睡眠/网络切换后 WS 可能半开：
 * 服务端目录里 connected 标记残留（客户端会把它当在线，导致死实例长期显示）。
 * 解法：daemon 定期 publish directory-update 维持服务端 lastSeenAt 新鲜，
 * 并用 ping/pong 检测半开连接——超时未收到 pong 则 terminate 触发重连，
 * 服务端对断开连接会在短时间内标 disconnected，客户端按新鲜度过滤即可消除死实例。
 */
export const DIRECTORY_PUBLISH_INTERVAL_MS = 60_000;

export interface RelayHostDirectoryPublishLoopOptions {
  socket: { readyState: number; ping: () => void; terminate: () => void };
  publish: () => boolean;
  intervalMs?: number;
  pongTimeoutMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
}

export function createRelayHostDirectoryPublishLoop(options: RelayHostDirectoryPublishLoopOptions) {
  const intervalMs = options.intervalMs ?? DIRECTORY_PUBLISH_INTERVAL_MS;
  const pongTimeoutMs = options.pongTimeoutMs ?? DIRECTORY_PUBLISH_INTERVAL_MS * 2;
  let lastPongAt = options.now ? options.now() : Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    markPong() {
      lastPongAt = options.now ? options.now() : Date.now();
    },
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        if (options.socket.readyState !== 1) {
          return;
        }
        const now = options.now ? options.now() : Date.now();
        if (now - lastPongAt > pongTimeoutMs) {
          options.warn?.(
            `[${new Date().toISOString()}] traversal relay host pong timeout (${pongTimeoutMs}ms); terminating half-open socket`,
          );
          options.socket.terminate();
          return;
        }
        options.socket.ping();
        options.publish();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
  };
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function withTrailingSlash(url: URL) {
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function buildHttpUrl(base: string, relativePath: string) {
  const normalized = withTrailingSlash(new URL(base));
  return new URL(relativePath, normalized);
}

function buildWsUrl(base: string, relativePath: string) {
  const url = buildHttpUrl(base, relativePath);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  return url;
}

export function buildRelayTmuxSessionSnapshots(
  sessionCatalog: Array<Pick<RelayTmuxSessionSnapshot, 'name' | 'cwd'>>,
  now: string,
): RelayTmuxSessionSnapshot[] {
  const seen = new Set<string>();
  const sessions: RelayTmuxSessionSnapshot[] = [];
  for (const entry of sessionCatalog) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    sessions.push({
      name,
      ...(typeof entry.cwd === 'string' && entry.cwd.trim() ? { cwd: entry.cwd.trim() } : {}),
      updatedAt: now,
    });
  }
  return sessions;
}

export function buildRelayDirectoryUpdateEnvelope(options: {
  endpoints: RelayEndpointCandidate[];
  sessionCatalog: Array<Pick<RelayTmuxSessionSnapshot, 'name' | 'cwd'>>;
  now: string;
}): RelayHostEnvelope {
  return {
    type: 'directory-update',
    directory: {
      endpoints: options.endpoints,
      sessions: buildRelayTmuxSessionSnapshots(options.sessionCatalog, options.now),
      publishedAt: options.now,
    },
  };
}

export function publishRelayDirectoryUpdate(options: {
  socket: RelayDirectoryPublisherSocket;
  listEndpointCandidates: (now: string) => RelayEndpointCandidate[];
  listTerminalSessionCatalog: () => Array<Pick<RelayTmuxSessionSnapshot, 'name' | 'cwd'>>;
  now: () => string;
}) {
  try {
    const now = options.now();
    const envelope = buildRelayDirectoryUpdateEnvelope({
      endpoints: options.listEndpointCandidates(now),
      sessionCatalog: options.listTerminalSessionCatalog(),
      now,
    });
    if (options.socket.readyState === WebSocket.OPEN) {
      options.socket.send(JSON.stringify(envelope));
    }
    return { ok: true as const, envelope };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options.socket.readyState === WebSocket.OPEN) {
      options.socket.send(JSON.stringify({
        type: 'relay-error',
        reason: `directory-update failed: ${reason}`,
      } satisfies RelayHostEnvelope));
    }
    return { ok: false as const, reason };
  }
}

async function login(config: TraversalRelayRuntimeConfig) {
  const loginUrl = buildHttpUrl(config.relayUrl, 'api/auth/login');
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: config.username,
      password: config.password,
    }),
  });
  if (!response.ok) {
    throw new Error(`relay login failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { accessToken?: string };
  const accessToken = asString(payload.accessToken);
  if (!accessToken) {
    throw new Error('relay login response missing accessToken');
  }
  return accessToken;
}

export function createTraversalRelayHostClient(options: CreateTraversalRelayHostClientOptions) {
  const config = options.config;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let publishLoop: ReturnType<typeof createRelayHostDirectoryPublishLoop> | null = null;
  let disposed = false;

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(delayMs: number) {
    if (disposed || !config) {
      return;
    }
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  async function connect() {
    if (disposed || !config) {
      return;
    }
    try {
      const accessToken = await login(config);
      const wsUrl = buildWsUrl(config.relayUrl, 'ws/host');
      wsUrl.searchParams.set('token', accessToken);
      wsUrl.searchParams.set('hostId', config.hostId);
      wsUrl.searchParams.set('deviceId', config.deviceId);
      if (config.deviceName) {
        wsUrl.searchParams.set('deviceName', config.deviceName);
      }
      if (config.platform) {
        wsUrl.searchParams.set('platform', config.platform);
      }
      if (config.appVersion) {
        wsUrl.searchParams.set('appVersion', config.appVersion);
      }
      if (config.daemonVersion) {
        wsUrl.searchParams.set('daemonVersion', config.daemonVersion);
      }
      const nextSocket = new WebSocket(wsUrl);
      socket = nextSocket;
      publishLoop?.stop();
      publishLoop = createRelayHostDirectoryPublishLoop({
        socket: nextSocket,
        publish: () => {
          const publishResult = publishRelayDirectoryUpdate({
            socket: nextSocket,
            listEndpointCandidates: options.listEndpointCandidates,
            listTerminalSessionCatalog: options.listTerminalSessionCatalog,
            now: options.now || (() => new Date().toISOString()),
          });
          if (!publishResult.ok) {
            console.warn(`[${new Date().toISOString()}] traversal relay directory publish failed: ${publishResult.reason}`);
          }
          return publishResult.ok;
        },
        warn: (message) => console.warn(message),
      });

      nextSocket.on('open', () => {
        publishLoop?.markPong();
        console.log(`[${new Date().toISOString()}] traversal relay host online: ${config.hostId} -> ${wsUrl.origin}`);
      });

      nextSocket.on('pong', () => {
        publishLoop?.markPong();
      });

      nextSocket.on('message', async (rawData) => {
        try {
          const envelope = JSON.parse(String(rawData)) as RelayHostEnvelope;
          if (envelope.type === 'relay-ready') {
            console.log(`[${new Date().toISOString()}] traversal relay ready for host ${envelope.hostId || config.hostId}`);
            const publishResult = publishRelayDirectoryUpdate({
              socket: nextSocket,
              listEndpointCandidates: options.listEndpointCandidates,
              listTerminalSessionCatalog: options.listTerminalSessionCatalog,
              now: options.now || (() => new Date().toISOString()),
            });
            if (publishResult.ok) {
              console.log(
                `[${new Date().toISOString()}] traversal relay directory published: host=${config.hostId} endpoints=${publishResult.envelope.directory?.endpoints?.length || 0} sessions=${publishResult.envelope.directory?.sessions?.length || 0}`,
              );
            } else {
              console.warn(`[${new Date().toISOString()}] traversal relay directory publish failed: ${publishResult.reason}`);
            }
            publishLoop?.start();
            return;
          }
          if (envelope.type === 'relay-peer-close' && envelope.peerId) {
            options.closeRelayPeer(envelope.peerId, envelope.reason || 'relay peer closed');
            return;
          }
          if (envelope.type === 'relay-signal' && envelope.peerId && envelope.message) {
            await options.handleRelaySignal(envelope.peerId, envelope.message, (message) => {
              if (nextSocket.readyState !== WebSocket.OPEN) {
                return;
              }
              nextSocket.send(JSON.stringify({
                type: 'relay-signal',
                peerId: envelope.peerId,
                message,
              } satisfies RelayHostEnvelope));
            });
            return;
          }
          if (envelope.type === 'relay-error') {
            console.warn(`[${new Date().toISOString()}] traversal relay host error: ${envelope.reason || 'unknown error'}`);
          }
        } catch (error) {
          console.warn(`[${new Date().toISOString()}] traversal relay host parse error: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      nextSocket.on('close', (code, reasonBuffer) => {
        if (socket === nextSocket) {
          socket = null;
        }
        publishLoop?.stop();
        publishLoop = null;
        const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf-8') : String(reasonBuffer || '');
        console.warn(`[${new Date().toISOString()}] traversal relay host websocket closed (${code} ${reason})`);
        scheduleReconnect(2000);
      });

      nextSocket.on('error', (error) => {
        console.warn(`[${new Date().toISOString()}] traversal relay host websocket error: ${error.message}`);
      });
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] traversal relay host connect failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect(3000);
    }
  }

  return {
    enabled: Boolean(config),
    start() {
      if (!config) {
        return;
      }
      void connect();
    },
    dispose() {
      disposed = true;
      clearReconnectTimer();
      publishLoop?.stop();
      publishLoop = null;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, 'relay host client disposed');
      }
      socket = null;
    },
  };
}
