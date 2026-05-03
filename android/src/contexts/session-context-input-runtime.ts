import type { Session } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

export function enqueuePendingInput(options: {
  sessionId: string;
  payload: string;
  pendingInputQueueRef: MutableRefObject<Map<string, string[]>>;
}) {
  const current = options.pendingInputQueueRef.current.get(options.sessionId) || [];
  options.pendingInputQueueRef.current.set(options.sessionId, [...current, options.payload]);
}

export function flushPendingInputQueue(options: {
  sessionId: string;
  refs: {
    pendingInputQueueRef: MutableRefObject<Map<string, string[]>>;
    sessionsRef: MutableRefObject<Session[]>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => void;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws: BridgeTransportSocket, options?: { force?: boolean }) => void;
}) {
  const ws = options.readSessionTransportSocket(options.sessionId);
  const queued = options.refs.pendingInputQueueRef.current.get(options.sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN || !queued || queued.length === 0) {
    return;
  }

  const session = options.refs.sessionsRef.current.find((item) => item.id === options.sessionId) || null;
  options.refs.pendingInputQueueRef.current.delete(options.sessionId);
  for (const payload of queued) {
    options.sendSocketPayload(options.sessionId, ws, JSON.stringify({ type: 'input', payload }));
  }
  if (session) {
    options.markPendingInputTailRefresh(
      options.sessionId,
      options.readSessionBufferSnapshot(options.sessionId).revision,
    );
  }
  options.requestSessionBufferHead(options.sessionId, ws, { force: true });
}

export function sendInputThroughSessionTransport(options: {
  sessionId: string;
  data: string;
  refs: {
    sessionsRef: MutableRefObject<Session[]>;
    stateRef: MutableRefObject<{ activeSessionId: string | null }>;
  };
  runtimeDebug: RuntimeDebugFn;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => void;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws: BridgeTransportSocket, options?: { force?: boolean }) => void;
  probeOrReconnectStaleSessionTransport: (sessionId: string, ws: BridgeTransportSocket, reason: 'input' | 'active-tick' | 'active-reentry') => void;
  enqueuePendingInput: (sessionId: string, payload: string) => void;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  shouldReconnectQueuedActiveInput: (options: {
    isActiveTarget: boolean;
    wsReadyState: number | null;
    reconnectInFlight: boolean;
  }) => boolean;
  reconnectSession: (sessionId: string) => void;
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

  const ws = options.readSessionTransportSocket(targetSessionId);
  const transportStale = options.isSessionTransportActivityStale(targetSessionId);
  const isActiveTarget = options.refs.stateRef.current.activeSessionId === targetSessionId;
  const reconnectInFlight = options.isReconnectInFlight(targetSessionId);

  if (ws && ws.readyState === WebSocket.OPEN) {
    options.runtimeDebug('session.input.send', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      transportStale,
    });
    options.markPendingInputTailRefresh(
      targetSessionId,
      options.readSessionBufferSnapshot(targetSessionId).revision,
    );
    options.sendSocketPayload(
      targetSessionId,
      ws,
      JSON.stringify({ type: 'input', payload: options.data }),
    );
    options.requestSessionBufferHead(targetSessionId, ws, { force: true });
    if (transportStale && isActiveTarget && !reconnectInFlight) {
      options.probeOrReconnectStaleSessionTransport(targetSessionId, ws, 'input');
    }
    return;
  }

  options.runtimeDebug('session.input.queue', {
    sessionId: targetSessionId,
    why: transportStale ? 'stale-open-transport' : 'transport-unavailable',
    size: options.data.length,
    preview: options.data.slice(0, 32),
    isActiveTarget,
    reconnectInFlight,
    wsReadyState: ws?.readyState ?? null,
  });
  options.enqueuePendingInput(targetSessionId, options.data);
  if (options.hasPendingSessionTransportOpen(targetSessionId)) {
    return;
  }
  const shouldForceReconnect = transportStale
    ? isActiveTarget && !reconnectInFlight
    : options.shouldReconnectQueuedActiveInput({
        isActiveTarget,
        wsReadyState: ws?.readyState ?? null,
        reconnectInFlight,
      });
  if (shouldForceReconnect) {
    options.reconnectSession(targetSessionId);
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
