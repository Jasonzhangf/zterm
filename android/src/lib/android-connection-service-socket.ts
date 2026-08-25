import {
  addAndroidConnectionServiceListener,
  readAndroidConnectionServiceSnapshot,
  sendAndroidConnectionCommand,
  type AndroidConnectionServiceChannelClosedEvent,
  type AndroidConnectionServiceChannelMessage,
  type AndroidConnectionServiceChannelOpenedEvent,
  type AndroidConnectionServiceErrorEvent,
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
  readonly transportOwnership = 'service' as const;
  readyState: number = WebSocket.CONNECTING;
  private openHandler: ((event?: Event) => void) | null = null;
  private messageHandler: ((event: BridgeSocketMessageLike) => void) | null = null;
  get onopen(): ((event?: Event) => void) | null { return this.openHandler; }
  set onopen(handler: ((event?: Event) => void) | null) {
    this.openHandler = handler;
    if (handler) this.scheduleOpenProjection();
  }
  get onmessage(): ((event: BridgeSocketMessageLike) => void) | null { return this.messageHandler; }
  set onmessage(handler: ((event: BridgeSocketMessageLike) => void) | null) {
    this.messageHandler = handler;
    if (handler) this.scheduleOpenProjection();
  }
  onerror: ((event?: Event) => void) | null = null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;

  private readonly targetKey: string;
  private disposed = false;
  private removeListeners: Array<() => Promise<void>> = [];
  private readyGeneration: string | null = null;
  private pendingGeneration: string | null = null;
  private readonly retiredGenerations = new Set<string>();
  private muxReadyGeneration: string | null = null;
  private projectedOpenGeneration: string | null = null;
  private muxReadyPayload: Record<string, unknown> | null = null;
  private muxReadyPayloadGeneration: string | null = null;
  private readySnapshot: AndroidConnectionServiceSnapshot | null = null;
  private readyChannelIds = new Set<string>();
  private projectedChannelIds = new Set<string>();
  private projectedChannelsGeneration: string | null = null;
  private openProjectionScheduled = false;

  constructor(target: AndroidConnectionServiceTarget) {
    this.targetKey = target.targetKey;
    this.readyState = WebSocket.CONNECTING;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('AndroidConnectionServiceTransportSocket is disposed');
    }
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
      addAndroidConnectionServiceListener('androidConnectionError', (error: AndroidConnectionServiceErrorEvent) => {
        if (this.disposed) {
          return;
        }
        if (error.targetKey !== this.targetKey) {
          return;
        }
        // Physical errors are retryable native-service facts. Snapshot
        // backoff/reconnect owns projection retirement so a transient error
        // cannot tear down channels while the service is still recovering.
      }),
    ]);
    this.removeListeners.push(...handles.map((handle) => () => handle.remove()));
    const snapshot = await readAndroidConnectionServiceSnapshot(this.targetKey);
    this.applySnapshot(snapshot);
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
    void sendAndroidConnectionCommand({ ...command, targetKey: this.targetKey });
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
    this.removeNativeListeners();
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
      return;
    }
    if (snapshot.state === 'resolving-target' || snapshot.state === 'connecting') {
      if (snapshot.generation && this.retiredGenerations.has(snapshot.generation)) return;
      if (this.readyGeneration) {
        if (!snapshot.generation || snapshot.generation === this.readyGeneration) return;
        this.retiredGenerations.add(this.readyGeneration);
        this.readyGeneration = null;
        this.muxReadyGeneration = null;
        this.muxReadyPayload = null;
        this.muxReadyPayloadGeneration = null;
        this.readySnapshot = null;
        this.readyChannelIds.clear();
        this.projectedChannelIds.clear();
        this.projectedChannelsGeneration = null;
      } else if (this.pendingGeneration && snapshot.generation && snapshot.generation !== this.pendingGeneration) {
        this.retiredGenerations.add(this.pendingGeneration);
      }
      this.readyState = WebSocket.CONNECTING;
      this.pendingGeneration = snapshot.generation;
      return;
    }
    if (snapshot.state === 'mux-ready' || snapshot.state === 'channels-ready' || snapshot.state === 'healthy') {
      if ((snapshot.generation != null && this.retiredGenerations.has(snapshot.generation))
        || (this.readyGeneration && snapshot.generation !== this.readyGeneration)
        || (this.pendingGeneration && snapshot.generation !== this.pendingGeneration)) return;
      const payload = isRecord(snapshot.muxReadyPayload)
        ? snapshot.muxReadyPayload
        : this.muxReadyPayloadGeneration === snapshot.generation ? this.muxReadyPayload : null;
      if (!snapshot.generation || !payload) return;
      this.readyGeneration = snapshot.generation;
      this.pendingGeneration = null;
      this.muxReadyPayload = { ...payload };
      this.muxReadyPayloadGeneration = snapshot.generation;
      this.readySnapshot = snapshot;
      this.readyChannelIds = new Set(snapshot.channels
        .filter((channel) => channel.state === 'open')
        .map((channel) => channel.channelId));
      if (this.readyState !== WebSocket.OPEN) {
        this.readyState = WebSocket.OPEN;
      }
      this.scheduleOpenProjection();
      return;
    }
    if (snapshot.state === 'authentication-error' || snapshot.state === 'terminal-error') {
      this.reportFailure(snapshot.error?.message || snapshot.state, {
        authFailure: snapshot.state === 'authentication-error',
      });
      return;
    }
    if (snapshot.state === 'backoff-reconnect') {
      const hadReadyGeneration = Boolean(this.readyGeneration);
      if (snapshot.generation && this.readyGeneration && snapshot.generation !== this.readyGeneration) return;
      this.readyState = WebSocket.CLOSED;
      const retiredGeneration = snapshot.generation || this.readyGeneration || this.pendingGeneration;
      if (retiredGeneration) this.retiredGenerations.add(retiredGeneration);
      this.readyGeneration = null;
      this.pendingGeneration = null;
      this.muxReadyGeneration = null;
      this.muxReadyPayload = null;
      this.muxReadyPayloadGeneration = null;
      this.projectedOpenGeneration = null;
      this.readySnapshot = null;
      this.readyChannelIds.clear();
      this.projectedChannelIds.clear();
      this.projectedChannelsGeneration = null;
      if (hadReadyGeneration) {
        this.onclose?.({ code: 1000, reason: 'service-reconnect' });
      }
    }
  }

  private dispatchServerFrame(frame: AndroidConnectionServiceServerFrame) {
    if (this.disposed || frame.targetKey !== this.targetKey) return;
    if (this.retiredGenerations.has(frame.generation)
      || (this.readyGeneration && frame.generation !== this.readyGeneration)
      || (!this.readyGeneration && this.pendingGeneration && frame.generation !== this.pendingGeneration)) return;
    if (frame.type === 'mux-ready') {
      if (this.muxReadyGeneration === frame.generation) return;
      this.readyGeneration = frame.generation;
      this.pendingGeneration = null;
      if (this.readyState !== WebSocket.OPEN) this.readyState = WebSocket.OPEN;
      this.muxReadyPayload = { ...frame.payload };
      this.muxReadyPayloadGeneration = frame.generation;
      this.scheduleOpenProjection();
      return;
    }
    if (this.readyState !== WebSocket.OPEN) {
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
    if (!this.acceptsReadyGeneration(event.targetKey, event.generation)) {
      return;
    }
    this.readySnapshot = event.snapshot;
    this.readyChannelIds.add(event.channelId);
    this.projectChannelOpened(
      event.generation,
      event.channelId,
      event.sessionName,
      event.snapshot,
    );
  }

  private dispatchChannelMessage(event: AndroidConnectionServiceChannelMessage) {
    if (!this.acceptsReadyGeneration(event.targetKey, event.generation)) {
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
    if (!this.acceptsReadyGeneration(event.targetKey, event.generation)) {
      return;
    }
    this.readyChannelIds.delete(event.channelId);
    this.projectedChannelIds.delete(event.channelId);
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
    this.removeNativeListeners();
    this.onclose?.({ code: 1000, reason });
  }

  private removeNativeListeners() {
    for (const remove of this.removeListeners.splice(0)) {
      void remove();
    }
  }

  private acceptsReadyGeneration(targetKey: string, generation: string) {
    return !this.disposed && targetKey === this.targetKey
      && this.readyState === WebSocket.OPEN && generation === this.readyGeneration;
  }

  private projectChannelOpened(
    generation: string,
    channelId: string,
    sessionName: string,
    snapshot: AndroidConnectionServiceSnapshot,
  ) {
    if (!this.onmessage || generation !== this.readyGeneration) return;
    if (this.projectedChannelsGeneration !== generation) {
      this.projectedChannelsGeneration = generation;
      this.projectedChannelIds.clear();
    }
    if (this.projectedChannelIds.has(channelId)) return;
    this.projectedChannelIds.add(channelId);
    this.onmessage({
      data: JSON.stringify({
        type: 'mux-channel-opened',
        payload: {
          channelId,
          sessionName,
          snapshot,
        },
      }),
    });
  }

  private scheduleOpenProjection() {
    if (this.openProjectionScheduled || this.disposed || !this.onopen) return;
    this.openProjectionScheduled = true;
    queueMicrotask(() => {
      this.openProjectionScheduled = false;
      if (this.disposed || this.readyState !== WebSocket.OPEN || !this.onopen) return;
      const generation = this.readyGeneration;
      if (!generation) return;
      if (this.projectedOpenGeneration !== generation) {
        this.projectedOpenGeneration = generation;
        this.onopen(new Event('open'));
      }
      if (this.onmessage && this.muxReadyGeneration !== generation
        && this.muxReadyPayloadGeneration === generation && this.muxReadyPayload) {
        this.muxReadyGeneration = generation;
        this.onmessage({ data: JSON.stringify({ type: 'mux-ready', payload: this.muxReadyPayload }) });
      }
      if (this.readySnapshot) {
        for (const channelId of this.readyChannelIds) {
          const channelSessionName = this.readySnapshot.channels.find(
            (channel) => channel.channelId === channelId,
          )?.sessionName;
          if (!channelSessionName) continue;
          this.projectChannelOpened(
            generation,
            channelId,
            channelSessionName,
            this.readySnapshot,
          );
        }
      }
    });
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
    case 'mux-target-message': {
      const payload = isRecord(frame.payload) ? frame.payload : {};
      if (!isRecord(payload.message)) return null;
      return {
        type: 'target-message' as const,
        ...(typeof payload.requestId === 'string' && payload.requestId ? { requestId: payload.requestId } : {}),
        message: payload.message,
      };
    }
    default:
      return null;
  }
}
