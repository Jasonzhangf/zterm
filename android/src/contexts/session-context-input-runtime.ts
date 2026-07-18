import type { Session } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import {
  TERMINAL_INPUT_CHUNK_BYTES,
  getTerminalInputUtf8ByteLength,
  splitTerminalInputUtf8Chunks,
} from '@zterm/shared/terminal/input-chunking';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

const TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES = 128 * 1024;

const pendingInputHeadRefreshes = new Map<string, {
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
}>();

function scheduleInputHeadRefresh(options: {
  sessionId: string;
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
}) {
  const alreadyPending = pendingInputHeadRefreshes.has(options.sessionId);
  pendingInputHeadRefreshes.set(options.sessionId, {
    readSessionTransportResource: options.readSessionTransportResource,
    readSessionTransportSocket: options.readSessionTransportSocket,
    requestSessionBufferHead: options.requestSessionBufferHead,
  });
  if (alreadyPending) {
    return;
  }
  queueMicrotask(() => {
    const pending = pendingInputHeadRefreshes.get(options.sessionId) || null;
    pendingInputHeadRefreshes.delete(options.sessionId);
    if (!pending) {
      return;
    }
    const currentResource = pending.readSessionTransportResource(options.sessionId);
    const currentWs = currentResource.socket || pending.readSessionTransportSocket(options.sessionId);
    pending.requestSessionBufferHead(
      options.sessionId,
      currentWs,
      { force: true },
    );
  });
}

export function sendInputThroughSessionTransport(options: {
  sessionId: string;
  data: string;
  refs: {
    sessionsRef: { current: Array<{ id: string }> };
    stateRef: { current: { activeSessionId: string | null } };
  };
  runtimeDebug: RuntimeDebugFn;
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  isReconnectInFlight: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    options.runtimeDebug('session.input.skip', {
      why: 'no-target-session',
      size: options.data.length,
    });
    return;
  }

  const session = options.refs.sessionsRef.current.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    options.runtimeDebug('session.input.skip', {
      why: 'missing-session',
      sessionId: targetSessionId,
      size: options.data.length,
    });
    return;
  }

  const resource = options.readSessionTransportResource(targetSessionId);
  const ws = resource.socket;
  const runtimeActiveSessionId = options.refs.stateRef.current.activeSessionId;
  const isActiveTarget = runtimeActiveSessionId === targetSessionId;
  const isExplicitInputTarget = true;
  const reconnectInFlight = options.isReconnectInFlight(targetSessionId);

  if (ws && ws.readyState === WebSocket.OPEN) {
    const bufferedBytes = Number.isFinite(ws.bufferedAmount)
      ? Math.max(0, Math.floor(ws.bufferedAmount || 0))
      : 0;
    if (bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES) {
      options.runtimeDebug('session.input.drop.backpressured-transport', {
        sessionId: targetSessionId,
        size: options.data.length,
        bufferedBytes,
        thresholdBytes: TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES,
        reconnectInFlight,
      });
      if (ws.readyState < WebSocket.CLOSING) {
        ws.close(4000, 'input backpressure');
      }
      return;
    }
    const localRevision = options.readSessionBufferSnapshot(targetSessionId).revision;
    const inputChunks = splitTerminalInputUtf8Chunks(options.data, TERMINAL_INPUT_CHUNK_BYTES);
    options.runtimeDebug('session.input.send', {
      sessionId: targetSessionId,
      size: options.data.length,
      bytes: getTerminalInputUtf8ByteLength(options.data),
      chunks: inputChunks.length,
      maxChunkBytes: TERMINAL_INPUT_CHUNK_BYTES,
      preview: options.data.slice(0, 32),
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
    });
    const isFirstPendingInputTailRefresh = options.markPendingInputTailRefresh(
      targetSessionId,
      localRevision,
    );
    for (const chunk of inputChunks) {
      options.sendSocketPayload(
        targetSessionId,
        ws,
        JSON.stringify({ type: 'input', payload: chunk }),
      );
    }
    if (isFirstPendingInputTailRefresh) {
      scheduleInputHeadRefresh({
        sessionId: targetSessionId,
        readSessionTransportResource: options.readSessionTransportResource,
        readSessionTransportSocket: options.readSessionTransportSocket,
        requestSessionBufferHead: options.requestSessionBufferHead,
      });
    }
    // Input path keeps transport input synchronous and moves head refresh to a
    // coalesced microtask so refresh work cannot block key dispatch.
    return;
  }

  options.runtimeDebug('session.input.transport-unavailable', {
    sessionId: targetSessionId,
    why: 'transport-unavailable',
    size: options.data.length,
    preview: options.data.slice(0, 32),
    isActiveTarget,
    runtimeActiveSessionId,
    explicitInputTarget: isExplicitInputTarget,
    reconnectInFlight,
    resourceTargetKey: resource.targetKey,
    resourceSocketState: resource.socketState,
    wsReadyState: ws?.readyState ?? null,
  });
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(targetSessionId);
  const pendingTransportOpenStale = pendingTransportOpen
    ? options.isPendingSessionTransportOpenStale(targetSessionId)
    : false;
  if (pendingTransportOpen) {
    options.runtimeDebug('session.input.drop.pending-transport-open', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      wsReadyState: ws?.readyState ?? null,
      reconnectInFlight,
      pendingTransportOpenStale,
      resourceTargetKey: resource.targetKey,
      resourceSocketState: resource.socketState,
    });
  }
}

export async function ensureSessionReadyForTransfer(options: {
  sessionId: string;
  timeoutMs: number;
  sessionsRef: MutableRefObject<Session[]>;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
}) {
  const readReadyState = () => {
    const session = options.sessionsRef.current.find((item) => item.id === options.sessionId) || null;
    const ws = options.readSessionTransportSocket(options.sessionId) || null;
    const ready =
      Boolean(session)
      && session?.state === 'connected'
      && Boolean(ws)
      && ws?.readyState === WebSocket.OPEN;
    return {
      session,
      ws,
      ready,
    };
  };

  const initial = readReadyState();
  if (initial.ready && initial.ws) {
    return initial.ws;
  }

  if (!initial.session) {
    throw new Error('Active session no longer exists');
  }

  if (initial.session.state !== 'connecting' && initial.session.state !== 'reconnecting') {
    throw new Error(`Active session is not ready yet (${initial.session.state || 'missing'})`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const current = readReadyState();
    if (current.ready && current.ws) {
      return current.ws;
    }
  }

  const latest = readReadyState();
  const stateLabel = latest.session?.state || 'missing';
  throw new Error(`Active session is not ready yet (${stateLabel})`);
}
