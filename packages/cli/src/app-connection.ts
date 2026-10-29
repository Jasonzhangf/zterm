import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import {
  APP_PROTOCOL_VERSION,
  type AppClientFrame,
  type AppReadyPayload,
  type AppServerFrame,
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
};

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
      let frame: AppServerFrame;
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as AppServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'app-inbound-message' || frame.type === 'app-inbound-file' || frame.type === 'app-connection-state') {
        this.onEvent?.(frame);
        return;
      }
      const requestId = 'payload' in frame && frame.payload && typeof frame.payload === 'object'
        ? (frame.payload as { requestId?: unknown }).requestId
        : undefined;
      if (typeof requestId !== 'string') return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(frame);
    });

    ws.on('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new AppCliError('result_unknown', 'local /app connection closed before a correlated result'));
      }
      this.pending.clear();
    });
    ws.on('error', (error) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new AppCliError('result_unknown', `local /app connection failed: ${error.message}`));
      }
      this.pending.clear();
    });
  }

  static async connect(options: AppClientConnectionOptions): Promise<AppClientConnection> {
    const createSocket = options.createWebSocket ?? ((url: string, authToken: string) => new WebSocket(url, {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    const ws = createSocket(buildLocalAppUrl(options.config), options.config.authToken);
    let authFailure: AppCliError | null = null;
    ws.once('unexpected-response', (_request, response) => {
      authFailure = new AppCliError(
        response.statusCode === 401 ? 'unauthorized' : 'unreachable',
        `local /app upgrade rejected with HTTP ${response.statusCode}`,
      );
    });
    try {
      if (options.signal?.aborted) throw new AppCliError('cancelled', 'operation cancelled');
      await Promise.race([
        once(ws, 'open').then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          ws.once('error', (error) => reject(new AppCliError('unreachable', `cannot connect to local daemon /app: ${error.message}`)));
          options.signal?.addEventListener('abort', () => reject(new AppCliError('cancelled', 'operation cancelled')), { once: true });
        }),
      ]);
    } catch (error) {
      if (authFailure) throw authFailure;
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
        let frame: AppServerFrame;
        try {
          frame = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as AppServerFrame;
        } catch {
          return;
        }
        if (frame.type === 'app-ready' && frame.payload.requestId === requestId) {
          cleanup();
          resolve(frame.payload);
        }
        if (frame.type === 'app-error' && frame.payload.requestId === requestId) {
          cleanup();
          reject(new AppCliError(frame.payload.code, frame.payload.message));
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
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new AppCliError('result_unknown', 'local /app request timed out'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
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
