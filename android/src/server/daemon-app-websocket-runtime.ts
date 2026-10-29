import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  APP_CAPABILITIES,
  APP_PROTOCOL_VERSION,
  APP_STREAM_OUTBOUND_QUEUE_BYTES,
  AppProtocolError,
  appErrorPayload,
  validateAppClientFrame,
  type AppClientFrame,
  type AppHelloPayload,
  type AppReadyPayload,
  type AppServerFrame,
} from '@zterm/shared/app-protocol';
import type { AppLink, DaemonAppMessagingRuntime } from './daemon-app-messaging-runtime';

export interface DaemonAppGatewayOptions {
  requiredAuthToken: string;
  daemonHostId: string;
  deviceId: string;
  messaging: DaemonAppMessagingRuntime;
  slowConsumerGraceMs?: number;
  log?: (message: string) => void;
}

export interface DaemonAppGateway {
  handleServerUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  dispose: () => void;
}

export function assertDaemonAppHelloAdmission(input: {
  hello: AppHelloPayload;
  deviceId: string;
  daemonHostId: string;
  remoteLoopback: boolean;
}) {
  if (!input.deviceId || !input.daemonHostId) {
    throw new AppProtocolError({
      code: 'missing_identity',
      message: 'daemon device identity is not configured; set zterm.android.relay.deviceId',
      stage: 'admission',
      requestId: input.hello.requestId,
    });
  }
  if (input.hello.role === 'local') {
    if (!input.remoteLoopback) {
      throw new AppProtocolError({ code: 'forbidden_role', message: 'local role requires a loopback connection', stage: 'admission', requestId: input.hello.requestId });
    }
    if (input.hello.daemonHostId !== input.daemonHostId || input.hello.deviceId !== input.deviceId) {
      throw new AppProtocolError({ code: 'forbidden_role', message: 'local role identity does not match this daemon', stage: 'admission', requestId: input.hello.requestId });
    }
  }
}

const APP_PATH = '/app';
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SLOW_CONSUMER_GRACE_MS = 20_000;

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization?.trim() || '';
  return authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
}

function tokensEqual(left: string, right: string) {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function rejectUpgrade(socket: Duplex, status: 401 | 404, message: string) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Length: 0\r\n\r\n',
  );
  socket.destroy();
}

function rawText(rawData: RawData): string {
  if (typeof rawData === 'string') return rawData;
  if (Buffer.isBuffer(rawData)) return rawData.toString('utf8');
  if (Array.isArray(rawData)) return Buffer.concat(rawData).toString('utf8');
  return Buffer.from(rawData as ArrayBuffer).toString('utf8');
}

export function createDaemonAppGateway(options: DaemonAppGatewayOptions): DaemonAppGateway {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<WebSocket>();
  const log = options.log ?? (() => undefined);

  function sendRawError(ws: WebSocket, error: AppProtocolError, requestId?: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'app-error',
      payload: appErrorPayload({
        code: error.code,
        stage: error.stage,
        message: error.message,
        requestId: error.requestId ?? requestId,
      }),
    }));
  }

  function handleConnection(ws: WebSocket, request: IncomingMessage) {
    connections.add(ws);
    let link: AppLink | null = null;
    let helloSeen = false;
    let pendingBytes = 0;
    let overLimitSince: number | null = null;
    let lastAckProgressAt: number | null = null;
    let slowConsumerTimer: ReturnType<typeof setTimeout> | null = null;
    let slowConsumerClosed = false;
    const pendingMessages = new Map<string, { bytes: number; enqueuedAt: number }>();
    const pendingWrite = (frame: AppServerFrame, bytes: number) => {
      if (frame.type === 'app-connection-state' || (frame.type === 'app-error' && frame.payload.requestId === undefined)) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(frame));
        }
        return;
      }
      if (frame.type === 'app-inbound-message' || frame.type === 'app-inbound-file') {
        trackPendingInbound(frame, bytes);
      }
      const text = JSON.stringify(frame);
      ws.send(text, (error) => {
        if (error) {
          ws.close(1011, 'send failed');
        }
      });
    };

    const slowConsumerGraceMs = options.slowConsumerGraceMs ?? SLOW_CONSUMER_GRACE_MS;
    const remoteLoopback = isLoopbackAddress(request.socket.remoteAddress);
    const handshakeTimer = setTimeout(() => {
      if (helloSeen || ws.readyState !== WebSocket.OPEN) return;
      sendRawError(ws, new AppProtocolError({ code: 'invalid_frame', message: 'app handshake timed out', stage: 'admission' }));
      ws.close(4003, 'handshake timeout');
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    function clearSlowConsumerTimer() {
      if (slowConsumerTimer) {
        clearTimeout(slowConsumerTimer);
        slowConsumerTimer = null;
      }
    }

    function oldestPendingMessage(): { bytes: number; enqueuedAt: number } | null {
      let oldest: { bytes: number; enqueuedAt: number } | null = null;
      for (const pending of pendingMessages.values()) {
        if (!oldest || pending.enqueuedAt < oldest.enqueuedAt) oldest = pending;
      }
      return oldest;
    }

    function scheduleSlowConsumerCheck() {
      clearSlowConsumerTimer();
      if (slowConsumerClosed || ws.readyState !== WebSocket.OPEN) return;
      if (pendingBytes <= APP_STREAM_OUTBOUND_QUEUE_BYTES) {
        overLimitSince = null;
        return;
      }
      const oldest = oldestPendingMessage();
      if (!oldest) {
        overLimitSince = null;
        return;
      }
      const currentTime = Date.now();
      if (overLimitSince === null) overLimitSince = currentTime;
      const eligibleAt = Math.max(
        oldest.enqueuedAt,
        overLimitSince,
        lastAckProgressAt ?? 0,
      );
      const delayMs = Math.max(0, eligibleAt + slowConsumerGraceMs - currentTime);
      slowConsumerTimer = setTimeout(checkSlowConsumer, delayMs);
      slowConsumerTimer.unref?.();
    }

    function checkSlowConsumer() {
      slowConsumerTimer = null;
      if (slowConsumerClosed || ws.readyState !== WebSocket.OPEN) return;
      if (pendingBytes <= APP_STREAM_OUTBOUND_QUEUE_BYTES) {
        overLimitSince = null;
        return;
      }
      const oldest = oldestPendingMessage();
      if (!oldest) {
        overLimitSince = null;
        return;
      }
      const currentTime = Date.now();
      if (overLimitSince === null) overLimitSince = currentTime;
      const eligibleAt = Math.max(
        oldest.enqueuedAt,
        overLimitSince,
        lastAckProgressAt ?? 0,
      );
      if (currentTime - eligibleAt < slowConsumerGraceMs) {
        scheduleSlowConsumerCheck();
        return;
      }
      slowConsumerClosed = true;
      clearSlowConsumerTimer();
      sendRawError(ws, new AppProtocolError({
        code: 'slow_consumer',
        stage: 'publish',
        message: 'local app stream has unacknowledged inbound data beyond the slow-consumer grace period',
      }));
      ws.close(4008, 'slow_consumer');
    }

    function inboundPendingKey(frame: AppServerFrame): string | null {
      if (frame.type === 'app-inbound-message') {
        return `${frame.payload.senderDaemonHostId}\u0000${frame.payload.messageId}`;
      }
      if (frame.type === 'app-inbound-file') {
        return `${frame.payload.senderDaemonHostId}\u0000${frame.payload.messageId}`;
      }
      return null;
    }

    function trackPendingInbound(frame: AppServerFrame, bytes: number) {
      if (!link || link.role !== 'local') return;
      const key = inboundPendingKey(frame);
      if (!key) return;
      if (pendingMessages.has(key)) return;
      const currentTime = Date.now();
      pendingMessages.set(key, { bytes, enqueuedAt: currentTime });
      pendingBytes += bytes;
      if (pendingBytes > APP_STREAM_OUTBOUND_QUEUE_BYTES && overLimitSince === null) {
        overLimitSince = currentTime;
      }
      if (pendingBytes > APP_STREAM_OUTBOUND_QUEUE_BYTES) scheduleSlowConsumerCheck();
    }

    function acknowledgePending(senderDaemonHostId: string | undefined, messageId: string) {
      let key: string | null = null;
      if (senderDaemonHostId) {
        const candidate = `${senderDaemonHostId}\u0000${messageId}`;
        if (pendingMessages.has(candidate)) key = candidate;
      } else {
        const matches = [...pendingMessages.keys()].filter((entry) => entry.endsWith(`\u0000${messageId}`));
        if (matches.length === 1) key = matches[0]!;
      }
      if (key === null) return;
      const pending = pendingMessages.get(key);
      if (!pending) return;
      pendingMessages.delete(key);
      pendingBytes = Math.max(0, pendingBytes - pending.bytes);
      lastAckProgressAt = Date.now();
      if (pendingBytes <= APP_STREAM_OUTBOUND_QUEUE_BYTES) {
        overLimitSince = null;
        clearSlowConsumerTimer();
        return;
      }
      overLimitSince = lastAckProgressAt;
      scheduleSlowConsumerCheck();
    }

    function enqueue(frame: AppServerFrame): boolean {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const text = JSON.stringify(frame);
      const bytes = Buffer.byteLength(text, 'utf8');
      pendingWrite(frame, bytes);
      return true;
    }

    function closeLink(reason: string, code = 1000) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    }

    async function acceptHello(hello: AppHelloPayload) {
      if (helloSeen) {
        throw new AppProtocolError({ code: 'invalid_frame', message: 'app-hello may only be sent once', stage: 'admission', requestId: hello.requestId });
      }
      assertDaemonAppHelloAdmission({
        hello,
        deviceId: options.deviceId,
        daemonHostId: options.daemonHostId,
        remoteLoopback,
      });
    const initError = options.messaging.getInitializationError();
    if (initError) {
      throw new AppProtocolError({
        code: 'storage_error',
        message: `app messaging is unavailable: ${initError.message}`,
        stage: 'admission',
        requestId: hello.requestId,
      });
    }
      helloSeen = true;
      clearTimeout(handshakeTimer);
      const connectionId = `app-${randomUUID()}`;
      link = {
        id: connectionId,
        role: hello.role,
        deviceId: hello.deviceId,
        daemonHostId: hello.daemonHostId,
        clientInstanceId: hello.clientInstanceId,
        send: enqueue,
        close: closeLink,
      };
      const ready: AppReadyPayload = {
        requestId: hello.requestId,
        protocolVersion: APP_PROTOCOL_VERSION,
        deviceId: options.deviceId,
        daemonHostId: options.daemonHostId,
        capabilities: APP_CAPABILITIES,
      };
      ws.send(JSON.stringify({ type: 'app-ready', payload: ready }));
      if (hello.role === 'local') {
        await options.messaging.subscribeLocal(link);
        enqueue({
          type: 'app-connection-state',
          payload: {
            requestId: `event-${randomUUID()}`,
            state: 'connected',
            daemonHostId: options.daemonHostId,
          },
        });
      }
    }

    ws.on('message', (rawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText(rawData));
      } catch {
        sendRawError(ws, new AppProtocolError({ code: 'invalid_frame', message: 'frame is not valid JSON', stage: 'frame' }));
        ws.close(4003, 'invalid frame');
        return;
      }
      let frame: AppClientFrame;
      try {
        frame = validateAppClientFrame(parsed);
      } catch (error) {
        if (error instanceof AppProtocolError) {
          sendRawError(ws, error);
          if (error.code === 'invalid_frame' || error.code === 'invalid_version') {
            ws.close(4003, error.code);
          }
          return;
        }
        sendRawError(ws, new AppProtocolError({ code: 'invalid_frame', message: 'frame validation failed', stage: 'frame' }));
        ws.close(4003, 'invalid frame');
        return;
      }

      if (frame.type === 'app-hello') {
        void acceptHello(frame.payload).catch((error: unknown) => {
          if (error instanceof AppProtocolError) {
            sendRawError(ws, error, frame.payload.requestId);
          }
          ws.close(4003, 'admission rejected');
        });
        return;
      }
      if (!link || !helloSeen) {
        sendRawError(ws, new AppProtocolError({ code: 'invalid_frame', message: 'app-hello must be the first frame', stage: 'admission' }));
        ws.close(4003, 'hello required');
        return;
      }
      void options.messaging.handleFrame(link, frame)
        .then((result) => {
          if (result.settled && result.messageId) {
            acknowledgePending(result.senderDaemonHostId, result.messageId);
          }
        })
        .catch((error: unknown) => {
          log(`app frame handling failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      clearSlowConsumerTimer();
      if (link) options.messaging.revokeLink(link.id);
      connections.delete(ws);
    });
    ws.on('error', (error) => {
      clearTimeout(handshakeTimer);
      clearSlowConsumerTimer();
      if (link) options.messaging.revokeLink(link.id);
      connections.delete(ws);
      log(`app websocket error: ${error.message}`);
    });
  }

  return {
    handleServerUpgrade(request, socket, head) {
      let pathname: string;
      try {
        pathname = new URL(request.url || '/', 'ws://localhost').pathname;
      } catch {
        rejectUpgrade(socket, 404, 'Not Found');
        return true;
      }
      if (pathname !== APP_PATH) return false;
      if (!options.requiredAuthToken) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return true;
      }
      if (!tokensEqual(bearerToken(request), options.requiredAuthToken)) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return true;
      }
      wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, request));
      return true;
    },

    dispose() {
      for (const ws of [...connections]) {
        try {
          ws.close(1001, 'daemon dispose');
        } catch {
          // Ignore sockets that are already closed.
        }
      }
      connections.clear();
      wss.close();
    },
  };
}
