import type { Session } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

const pendingInputHeadRefreshes = new Map<string, {
  ws: BridgeTransportSocket;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
}>();

function scheduleInputHeadRefresh(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
}) {
  const alreadyPending = pendingInputHeadRefreshes.has(options.sessionId);
  pendingInputHeadRefreshes.set(options.sessionId, {
    ws: options.ws,
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
    pending.requestSessionBufferHead(options.sessionId, pending.ws, { force: true });
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
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  probeOrReconnectStaleSessionTransport: (sessionId: string, ws: BridgeTransportSocket, reason: 'input' | 'active-tick' | 'active-reentry') => void;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string) => boolean;
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
  const runtimeActiveSessionId = options.refs.stateRef.current.activeSessionId;
  const isActiveTarget = runtimeActiveSessionId === targetSessionId;
  const isExplicitInputTarget = true;
  const reconnectInFlight = options.isReconnectInFlight(targetSessionId);

  if (ws && ws.readyState === WebSocket.OPEN) {
    const localRevision = options.readSessionBufferSnapshot(targetSessionId).revision;
    options.runtimeDebug('session.input.send', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      transportStale,
    });
    const isFirstPendingInputTailRefresh = options.markPendingInputTailRefresh(
      targetSessionId,
      localRevision,
    );
    options.sendSocketPayload(
      targetSessionId,
      ws,
      JSON.stringify({ type: 'input', payload: options.data }),
    );
    if (isFirstPendingInputTailRefresh) {
      scheduleInputHeadRefresh({
        sessionId: targetSessionId,
        ws,
        requestSessionBufferHead: options.requestSessionBufferHead,
      });
    }
    if (transportStale && !reconnectInFlight) {
      options.probeOrReconnectStaleSessionTransport(targetSessionId, ws, 'input');
    }
    // Input path keeps transport input synchronous and moves head refresh to a
    // coalesced microtask so refresh work cannot block key dispatch.
    return;
  }

  options.runtimeDebug('session.input.transport-unavailable', {
    sessionId: targetSessionId,
    why: transportStale ? 'stale-open-transport' : 'transport-unavailable',
    size: options.data.length,
    preview: options.data.slice(0, 32),
    isActiveTarget,
    runtimeActiveSessionId,
    explicitInputTarget: isExplicitInputTarget,
    reconnectInFlight,
    wsReadyState: ws?.readyState ?? null,
  });
  const shouldForceReconnect = transportStale
    ? isExplicitInputTarget && !reconnectInFlight
    : options.shouldReconnectQueuedActiveInput({
        isActiveTarget: isExplicitInputTarget,
        wsReadyState: ws?.readyState ?? null,
        reconnectInFlight,
      });
  const pendingTransportOpen = options.hasPendingSessionTransportOpen(targetSessionId);
  const pendingTransportOpenStale = pendingTransportOpen
    ? options.isPendingSessionTransportOpenStale(targetSessionId)
    : false;
  const shouldReconnectPastStalePendingOpen =
    pendingTransportOpenStale && isExplicitInputTarget;
  const shouldReconnectNow =
    shouldForceReconnect || shouldReconnectPastStalePendingOpen;
  if (pendingTransportOpen && !pendingTransportOpenStale && !shouldReconnectNow) {
    options.runtimeDebug('session.input.drop.pending-transport-open', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      wsReadyState: ws?.readyState ?? null,
      reconnectInFlight,
    });
    return;
  }
  if (shouldReconnectNow) {
    if (pendingTransportOpenStale) {
      options.runtimeDebug('session.input.reconnect.stale-pending-transport-open', {
        sessionId: targetSessionId,
        size: options.data.length,
        preview: options.data.slice(0, 32),
        wsReadyState: ws?.readyState ?? null,
        reconnectInFlight,
      });
    }
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
