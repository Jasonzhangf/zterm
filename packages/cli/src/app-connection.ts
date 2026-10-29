import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import {
  APP_PROTOCOL_VERSION,
  type AppClientFrame,
  type AppReadyPayload,
  type AppServerFrame,
  validateAppServerFrame,
} from '../../shared/src/connection/app-protocol.js';
import {
  AppCliError,
  buildLocalAppUrl,
  type LocalAppDaemonConfig,
} from './app-target-resolution.js';

type PendingRequest = {
  resolve: (frame: AppServerFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  allowedTypes: ReadonlySet<AppServerFrame['type']>;
  expectedMessageId?: string;
};

type SettlementContract = {
  allowedTypes: ReadonlySet<AppServerFrame['type']>;
  expectedMessageId?: string;
};

/**
 * Bind each outgoing request to the response frame type(s) that may legitimately settle it.
 * A same-requestId frame of any other type must not resolve the request, otherwise a stray
 * `app-pong`/`app-status-result` could be reported as a successful send.
 */
function settlementFor(frame: AppClientFrame): SettlementContract {
  switch (frame.type) {
    case 'app-send-message':
    case 'app-send-file-start':
    case 'app-send-file-chunk':
    case 'app-send-file-commit':
      return { allowedTypes: new Set(['app-send-result']), expectedMessageId: frame.payload.messageId };
    case 'app-ack':
    case 'app-consume':
    case 'app-status':
      return { allowedTypes: new Set(['app-status-result']) };
    case 'app-ping':
      return { allowedTypes: new Set(['app-pong']) };
    default:
      return { allowedTypes: new Set() };
  }
}

const CONNECT_TIMEOUT_MS = 10_000;

export interface AppClientConnectionOptions {
  config: LocalAppDaemonConfig;
  signal?: AbortSignal;
  clientInstanceId?: string;
  requestTimeoutMs?: number;
  onEvent?: (frame: AppServerFrame) => void;
  createWebSocket?: (url: string, authToken: string) => WebSocket;
}

export class AppClientConnection {
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly onEvent?: (frame: AppServerFrame) => void;
  private closed = false;
  readonly ready: AppReadyPayload;

  private constructor(
    ws: WebSocket,
    ready: AppReadyPayload,
    requestTimeoutMs: number,
    onEvent?: (frame: AppServerFrame) => void,
  ) {
    this.ws = ws;
    this.ready = ready;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onEvent = onEvent;

    ws.on('message', (raw) => {
      try {
        const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'));
        const frame = validateAppServerFrame(parsed);
        this.handleServerFrame(frame);
      } catch {
        this.rejectAllPending(new AppCliError('invalid_frame', 'local /app returned an invalid frame'));
      }
    });

    ws.on('close', (_code, reason) => {
      this.closed = true;
      this.onEvent?.({
        type: 'app-connection-state',
        payload: {
          requestId: `event-${randomUUID()}`,
          state: 'disconnected',
          daemonHostId: this.ready.daemonHostId,
          code: _code,
          reason: reason.toString(),
        },
      });
      this.rejectAllPending(new AppCliError('result_unknown', `local /app connection closed: ${reason.toString() || 'no reason'}`));
    });
    ws.on('error', (error) => {
      this.closed = true;
      this.onEvent?.({
        type: 'app-connection-state',
        payload: {
          requestId: `event-${randomUUID()}`,
          state: 'disconnected',
          daemonHostId: this.ready.daemonHostId,
          code: 1006,
          reason: error.message,
        },
      });
      this.rejectAllPending(new AppCliError('result_unknown', `local /app connection failed: ${error.message}`));
    });
  }

  private handleServerFrame(frame: AppServerFrame) {
    if (frame.type === 'app-inbound-message' || frame.type === 'app-inbound-file' || frame.type === 'app-connection-state') {
        this.onEvent?.(frame);
        return;
    }
    if (frame.type === 'app-error' && frame.payload.requestId === undefined) {
      this.onEvent?.(frame);
      return;
    }
      const requestId = 'payload' in frame && frame.payload && typeof frame.payload === 'object'
        ? (frame.payload as { requestId?: unknown }).requestId
        : undefined;
      if (typeof requestId !== 'string') return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      if (frame.type !== 'app-error') {
        if (!pending.allowedTypes.has(frame.type)) {
          this.settleReject(requestId, pending, new AppCliError(
            'unexpected_response_type',
            `local /app returned ${frame.type} while waiting for ${[...pending.allowedTypes].join('/')}`,
          ));
          return;
        }
        if (pending.expectedMessageId !== undefined) {
          const responseMessageId = (frame.payload as { messageId?: unknown }).messageId;
          if (responseMessageId !== pending.expectedMessageId) {
            this.settleReject(requestId, pending, new AppCliError(
              'response_id_mismatch',
              `local /app returned a response for messageId ${String(responseMessageId)} while waiting for ${pending.expectedMessageId}`,
            ));
            return;
          }
        }
      }
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(frame);
  }

  private settleReject(requestId: string, pending: PendingRequest, error: AppCliError) {
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private rejectAllPending(error: AppCliError) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  static async connect(options: AppClientConnectionOptions): Promise<AppClientConnection> {
    const createSocket = options.createWebSocket ?? ((url: string, authToken: string) => new WebSocket(url, {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    const ws = createSocket(buildLocalAppUrl(options.config), options.config.authToken);
    let connectTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      if (options.signal?.aborted) throw new AppCliError('cancelled', 'operation cancelled');
      await Promise.race([
        once(ws, 'open').then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          connectTimeout = setTimeout(() => {
            reject(new AppCliError('unreachable', 'local /app connection timed out'));
          }, options.requestTimeoutMs ?? CONNECT_TIMEOUT_MS);
          connectTimeout.unref?.();
          ws.once('unexpected-response', (_request, response) => {
            if (connectTimeout) {
              clearTimeout(connectTimeout);
              connectTimeout = null;
            }
            response.resume();
            reject(new AppCliError(
              response.statusCode === 401 ? 'unauthorized' : 'unreachable',
              `local /app upgrade rejected with HTTP ${response.statusCode}`,
            ));
          });
          ws.once('error', (error) => reject(new AppCliError('unreachable', `cannot connect to local daemon /app: ${error.message}`)));
          options.signal?.addEventListener('abort', () => reject(new AppCliError('cancelled', 'operation cancelled')), { once: true });
        }),
      ]);
    } catch (error) {
      if (connectTimeout) {
        clearTimeout(connectTimeout);
        connectTimeout = null;
      }
      try {
        ws.terminate();
      } catch {
        // Ignore a socket that never opened.
      }
      throw error;
    }

    const requestId = `hello-${randomUUID()}`;
    const timeoutMs = options.requestTimeoutMs ?? 30_000;
    const ready = await new Promise<AppReadyPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new AppCliError('result_unknown', 'local /app handshake timed out'));
      }, timeoutMs);
      timer.unref?.();
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8'));
          const frame = validateAppServerFrame(parsed);
          if (frame.type === 'app-ready' && frame.payload.requestId === requestId) {
            cleanup();
            resolve(frame.payload);
          }
          if (frame.type === 'app-error' && frame.payload.requestId === requestId) {
            cleanup();
            reject(new AppCliError(frame.payload.code, frame.payload.message));
          }
        } catch {
          cleanup();
          reject(new AppCliError('invalid_frame', 'local /app returned an invalid handshake frame'));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new AppCliError('result_unknown', 'local /app closed during handshake'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        ws.removeListener('close', onClose);
      };
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.send(JSON.stringify({
        type: 'app-hello',
        payload: {
          protocolVersion: APP_PROTOCOL_VERSION,
          requestId,
          role: 'local',
          clientInstanceId: options.clientInstanceId ?? `cli-${randomUUID()}`,
          deviceId: options.config.deviceId,
          daemonHostId: options.config.daemonHostId,
          capabilities: {},
        },
      }));
    });

    if (ready.daemonHostId !== options.config.daemonHostId || ready.deviceId !== options.config.deviceId) {
      ws.close(4003, 'local identity mismatch');
      throw new AppCliError('local_identity_mismatch', 'local daemon identity does not match the configured identity');
    }
    return new AppClientConnection(ws, ready, timeoutMs, options.onEvent);
  }

  request(frame: AppClientFrame): Promise<AppServerFrame> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AppCliError('result_unknown', 'local /app connection is closed'));
    }
    const requestId = 'requestId' in frame.payload ? frame.payload.requestId : '';
    if (!requestId) {
      return Promise.reject(new AppCliError('invalid_frame', 'requestId is required', 2));
    }
    return new Promise<AppServerFrame>((resolve, reject) => {
      const contract = settlementFor(frame);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AppCliError('result_unknown', 'local /app request timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer, allowedTypes: contract.allowedTypes, expectedMessageId: contract.expectedMessageId });
      this.ws.send(JSON.stringify(frame), (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(new AppCliError('result_unknown', `local /app send failed: ${error.message}`));
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(1000, 'cli close');
    } catch {
      // Ignore a socket that is already closed.
    }
  }

  get isClosed() {
    return this.closed;
  }
}
