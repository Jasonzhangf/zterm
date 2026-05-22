import type { Session } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
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
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => void;
  readSessionBufferSnapshot: (sessionId: string) => { revision: number };
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  probeOrReconnectStaleSessionTransport: (sessionId: string, ws: BridgeTransportSocket, reason: 'input' | 'active-tick' | 'active-reentry') => void;
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
  const runtimeActiveSessionId = options.refs.stateRef.current.activeSessionId;
  const isActiveTarget = runtimeActiveSessionId === targetSessionId;
  const isExplicitInputTarget = true;
  const reconnectInFlight = options.isReconnectInFlight(targetSessionId);

  if (ws && ws.readyState === WebSocket.OPEN && !transportStale) {
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
    // Input path: send only. Tail-refresh marker set above; head pull & transport health
    // are owned by the dedicated heartbeat/refresh loop, not by each keystroke.
    return;
  }

  if (ws && ws.readyState === WebSocket.OPEN && transportStale) {
    options.runtimeDebug('session.input.drop.stale-open-transport', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      runtimeActiveSessionId,
      reconnectInFlight,
    });
    if (!reconnectInFlight) {
      options.reconnectSession(targetSessionId);
    }
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
  if (pendingTransportOpen && !shouldForceReconnect) {
    options.runtimeDebug('session.input.drop.pending-transport-open', {
      sessionId: targetSessionId,
      size: options.data.length,
      preview: options.data.slice(0, 32),
      wsReadyState: ws?.readyState ?? null,
      reconnectInFlight,
    });
    return;
  }
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
