import { WebSocket } from 'ws';
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
}

interface RelayHostEnvelope {
  type: 'relay-ready' | 'relay-signal' | 'relay-peer-close' | 'relay-error';
  peerId?: string;
  reason?: string;
  message?: SignalMessage;
  hostId?: string;
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

      nextSocket.on('open', () => {
        console.log(`[${new Date().toISOString()}] traversal relay host online: ${config.hostId} -> ${wsUrl.origin}`);
      });

      nextSocket.on('message', async (rawData) => {
        try {
          const envelope = JSON.parse(String(rawData)) as RelayHostEnvelope;
          if (envelope.type === 'relay-ready') {
            console.log(`[${new Date().toISOString()}] traversal relay ready for host ${envelope.hostId || config.hostId}`);
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
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, 'relay host client disposed');
      }
      socket = null;
    },
  };
}
