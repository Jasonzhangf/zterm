import {
  addAndroidConnectionServiceListener,
  readAndroidConnectionServiceSnapshot,
  sendAndroidConnectionCommand,
  type AndroidConnectionServiceChannelClosedEvent,
  type AndroidConnectionServiceChannelMessage,
  type AndroidConnectionServiceChannelOpenedEvent,
  type AndroidConnectionServiceServerFrame,
} from '../plugins/AndroidConnectionServicePlugin';
import type { BridgeTransportSocket, BridgeSocketCloseLike, BridgeSocketMessageLike } from './traversal/types';
import type { AndroidConnectionServiceSnapshot } from './android-connection-service-snapshot';
import type { AndroidConnectionServiceTarget } from './android-connection-service-commands';

/**
 * BridgeTransportSocket projection for the native AndroidConnectionService.
 *
 * The native service remains the only physical transport/heartbeat/reconnect
 * owner. This object only adapts typed service events into the existing
 * SessionContext BridgeTransportSocket shape so terminal channel logic can
 * consume the same mux frames. It never creates a WebSocket, schedules a
 * heartbeat, or probes/reconnects on its own.
 */
export class AndroidConnectionServiceTransportSocket implements BridgeTransportSocket {
  readonly bufferedAmount = 0;
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event?: Event) => void) | null = null;
  onmessage: ((event: BridgeSocketMessageLike) => void) | null = null;
  onerror: ((event?: Event) => void) | null = null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;

  private readonly targetKey: string;
  private disposed = false;
  private removeListeners: Array<() => Promise<void>> = [];

  constructor(target: AndroidConnectionServiceTarget, _sessionName: string) {
    this.targetKey = target.targetKey;
    this.readyState = WebSocket.CONNECTING;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('AndroidConnectionServiceTransportSocket is disposed');
    }
    const snapshot = await readAndroidConnectionServiceSnapshot();
    this.applySnapshot(snapshot);

    const handles = await Promise.all([
      addAndroidConnectionServiceListener('androidConnectionSnapshot', (snapshot) => {
        if (this.disposed) {
          return;
        }
        this.applySnapshot(snapshot);
      }),
      addAndroidConnectionServiceListener('androidConnectionServerFrame', (frame) => {
        if (this.disposed) {
          return;
        }
        this.dispatchServerFrame(frame);
      }),
      addAndroidConnectionServiceListener('androidConnectionChannelMessage', (event) => {
        if (this.disposed) {
          return;
        }
        this.dispatchChannelMessage(event);
      }),
      addAndroidConnectionServiceListener('androidConnectionChannelOpened', (event) => {
        if (this.disposed) {
          return;
        }
        this.dispatchChannelOpened(event);
      }),
      addAndroidConnectionServiceListener('androidConnectionChannelClosed', (event) => {
        if (this.disposed) {
          return;
        }
        this.dispatchChannelClosed(event);
      }),
    ]);
    this.removeListeners.push(...handles.map((handle) => () => handle.remove()));
  }

  send(data: string | ArrayBuffer): void {
    if (this.disposed) {
      throw new Error('AndroidConnectionServiceTransportSocket is disposed');
    }
    if (typeof data !== 'string') {
      throw new Error('AndroidConnectionServiceTransportSocket requires JSON string channel frames');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.reportFailure('invalid terminal channel frame', { authFailure: false });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.reportFailure('invalid terminal channel frame', { authFailure: false });
      return;
    }
    const command = mapFrameToCommand(parsed);
    if (!command) {
      this.reportFailure(`unsupported terminal channel frame: ${parsed.type}`, { authFailure: false });
      return;
    }
    void sendAndroidConnectionCommand(command);
  }

  close(_code?: number, _reason?: string): void {
    // A UI-originated close is projection-only. The service owns transport
    // release policy; this adapter only marks the local projection detached.
    this.dispose('ui-detach');
  }

  reportFailure(reason: string, options?: { authFailure?: boolean }): void {
    if (this.disposed) {
      return;
    }
    const event: BridgeSocketCloseLike = {
      code: options?.authFailure ? 4001 : 4000,
      reason,
    };
    this.disposed = true;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(event);
    this.onerror?.(new Event('error'));
  }

  getDiagnostics() {
    return {
      mode: 'websocket' as const,
      resolvedPath: 'tailscale' as const,
      resolvedEndpoint: '',
      stage: this.readyState === WebSocket.OPEN ? 'open' as const : 'closed' as const,
      attempts: [],
    };
  }

  private applySnapshot(snapshot: AndroidConnectionServiceSnapshot) {
    const isThisTarget = snapshot.target?.targetKey === this.targetKey;
    if (!isThisTarget) {
      this.readyState = WebSocket.CLOSED;
      return;
    }
    if (snapshot.state === 'mux-ready' || snapshot.state === 'channels-ready' || snapshot.state === 'healthy') {
      if (this.readyState !== WebSocket.OPEN) {
        this.readyState = WebSocket.OPEN;
        this.onopen?.(new Event('open'));
      }
      return;
    }
    if (snapshot.state === 'authentication-error' || snapshot.state === 'terminal-error') {
      this.reportFailure(snapshot.error?.message || snapshot.state, {
        authFailure: snapshot.state === 'authentication-error',
      });
      return;
    }
    if (snapshot.state === 'backoff-reconnect') {
      this.readyState = WebSocket.CLOSED;
    }
  }

  private dispatchServerFrame(frame: AndroidConnectionServiceServerFrame) {
    if (this.disposed || this.readyState !== WebSocket.OPEN) {
      return;
    }
    this.onmessage?.({
      data: JSON.stringify({
        type: frame.type,
        payload: frame.payload,
      }),
    });
  }

  private dispatchChannelOpened(event: AndroidConnectionServiceChannelOpenedEvent) {
    if (this.disposed) {
      return;
    }
    if (this.readyState !== WebSocket.OPEN) {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }
    this.onmessage?.({
      data: JSON.stringify({
        type: 'mux-channel-opened',
        payload: {
          channelId: event.channelId,
          snapshot: event.snapshot,
        },
      }),
    });
  }

  private dispatchChannelMessage(event: AndroidConnectionServiceChannelMessage) {
    if (this.disposed || this.readyState !== WebSocket.OPEN) {
      return;
    }
    this.onmessage?.({
      data: JSON.stringify({
        type: 'mux-channel-message',
        payload: {
          channelId: event.channelId,
          message: event.message,
        },
      }),
    });
  }

  private dispatchChannelClosed(event: AndroidConnectionServiceChannelClosedEvent) {
    if (this.disposed) {
      return;
    }
    this.onmessage?.({
      data: JSON.stringify({
        type: 'mux-channel-closed',
        payload: {
          channelId: event.channelId,
          reason: 'service-channel-closed',
        },
      }),
    });
  }

  private dispose(reason: string) {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.readyState = WebSocket.CLOSED;
    for (const remove of this.removeListeners.splice(0)) {
      void remove();
    }
    this.onclose?.({ code: 1000, reason });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapFrameToCommand(frame: Record<string, unknown>) {
  switch (frame.type) {
    case 'mux-channel-open': {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : '';
      const sessionName = typeof payload.sessionName === 'string' ? payload.sessionName : '';
      if (!channelId || !sessionName) {
        return null;
      }
      return {
        type: 'open-channel' as const,
        channelId,
        sessionName,
        ...(isRecord(payload.options) ? { options: payload.options } : {}),
      };
    }
    case 'mux-channel-message': {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : '';
      if (!channelId || !isRecord(payload.message)) {
        return null;
      }
      return {
        type: 'channel-message' as const,
        channelId,
        message: payload.message,
      };
    }
    case 'mux-channel-binary': {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : '';
      const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';
      if (!channelId || !dataBase64) {
        return null;
      }
      return {
        type: 'channel-binary' as const,
        channelId,
        dataBase64,
      };
    }
    case 'mux-channel-close': {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : '';
      if (!channelId) {
        return null;
      }
      return {
        type: 'close-channel' as const,
        channelId,
        reason: typeof payload.reason === 'string' && payload.reason ? payload.reason : 'user-close',
      };
    }
    default:
      return null;
  }
}
