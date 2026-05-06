import { buildEmptyScheduleState } from '@zterm/shared';
import { DEFAULT_TERMINAL_CACHE_LINES, resolveTerminalRequestWindowLines } from '../lib/mobile-config';
import type { BridgeSettings } from '../lib/bridge-settings';
import { resolveTraversalConfigFromHost } from '../lib/traversal/config';
import { TraversalSocket } from '../lib/traversal/socket';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { Host, Session, SessionBufferState, SessionScheduleState } from '../lib/types';
import type { SessionRenderBufferSnapshot } from '../lib/types';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { RecordSessionTxOptions } from './session-context-pull-runtime';
import {
  clearSessionPullState as clearSessionPullStateRuntime,
  isSessionTransportActivityStale as isSessionTransportActivityStaleRuntime,
  markPendingInputTailRefresh as markPendingInputTailRefreshRuntime,
  recordSessionRx as recordSessionRxRuntime,
  recordSessionTx as recordSessionTxRuntime,
  resetSessionTransportPullBookkeeping as resetSessionTransportPullBookkeepingRuntime,
  settleSessionPullState as settleSessionPullStateRuntime,
} from './session-context-pull-runtime';
import {
  clearSessionHandshakeTimeout as clearSessionHandshakeTimeoutRuntime,
  clearSessionHeartbeat as clearSessionHeartbeatRuntime,
  clearTailRefreshRuntime as clearTailRefreshRuntimeRuntime,
  setSessionHandshakeTimeout as setSessionHandshakeTimeoutRuntime,
  startSocketHeartbeat as startSocketHeartbeatRuntime,
} from './session-context-socket-runtime';
import {
  cleanupControlTransportSocket as cleanupControlTransportSocketRuntime,
  createSessionContextTransportAccessors,
} from './session-context-transport-runtime';
import type { SessionAction, SessionManagerState, SessionReconnectRuntime } from './session-context-core';
import type { SessionBufferHeadState, SessionPullPurpose } from './session-sync-helpers';
import { hasPendingSessionTransportOpenIntent, isPendingSessionTransportOpenIntentStale } from './session-context-open-intent-store';

export function applySessionActionRuntime(options: {
  stateRef: { current: SessionManagerState };
  action: SessionAction;
  reduceSessionAction: (state: SessionManagerState, action: SessionAction) => SessionManagerState;
  dispatch: React.Dispatch<SessionAction>;
}) {
  const nextState = options.reduceSessionAction(options.stateRef.current, options.action);
  if (nextState === options.stateRef.current) {
    return false;
  }
  options.stateRef.current = nextState;
  options.dispatch(options.action);
  return true;
}

export function readSessionBufferSnapshotRuntime(options: {
  sessionId: string;
  sessionBufferStoreRef: { current: { getSnapshot: (sessionId: string) => { buffer: SessionBufferState } } };
}): SessionBufferState {
  return options.sessionBufferStoreRef.current.getSnapshot(options.sessionId).buffer;
}

export function updateSessionSyncRuntime(options: {
  id: string;
  updates: Partial<Session>;
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({
    type: 'UPDATE_SESSION',
    id: options.id,
    updates: options.updates,
  });
}

export function setActiveSessionSyncRuntime(options: {
  id: string;
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'SET_ACTIVE_SESSION', id: options.id });
}

export function setLiveSessionsSyncRuntime(options: {
  ids: string[];
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'SET_LIVE_SESSIONS', ids: options.ids });
}

export function createSessionSyncRuntime(options: {
  session: Session;
  activate: boolean;
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'CREATE_SESSION', session: options.session, activate: options.activate });
}

export function deleteSessionSyncRuntime(options: {
  id: string;
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'DELETE_SESSION', id: options.id });
}

export function moveSessionSyncRuntime(options: {
  id: string;
  toIndex: number;
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'MOVE_SESSION', id: options.id, toIndex: options.toIndex });
}

export function setSessionTitleSyncRuntime(options: {
  id: string;
  title: string;
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'SET_SESSION_TITLE', id: options.id, title: options.title });
}

export function incrementConnectedSyncRuntime(options: {
  applySessionAction: (action: SessionAction) => void;
}) {
  options.applySessionAction({ type: 'INCREMENT_CONNECTED' });
}

export function createTransportInfraAccessorsRuntime(storeRef: Parameters<typeof createSessionContextTransportAccessors>[0]) {
  return createSessionContextTransportAccessors(storeRef);
}

export function readSessionTransportTokenRuntime(options: {
  sessionId: string;
  sessionAttachTokensRef: { current: Map<string, string> };
}) {
  return options.sessionAttachTokensRef.current.get(options.sessionId) || null;
}

export function writeSessionTransportTokenRuntime(options: {
  sessionId: string;
  token: string | null;
  sessionAttachTokensRef: { current: Map<string, string> };
}) {
  const normalized = typeof options.token === 'string' ? options.token.trim() : '';
  if (!normalized) {
    options.sessionAttachTokensRef.current.delete(options.sessionId);
    return null;
  }
  options.sessionAttachTokensRef.current.set(options.sessionId, normalized);
  return normalized;
}

export function isSessionTransportActiveRuntime(options: {
  sessionId: string;
  stateRef: { current: SessionManagerState };
}) {
  return (
    options.stateRef.current.activeSessionId === options.sessionId
    || options.stateRef.current.liveSessionIds.includes(options.sessionId)
  );
}

export function hasPendingSessionTransportOpenRuntime(options: {
  sessionId: string;
  pendingSessionTransportOpenIntentsRef: { current: Map<string, unknown> };
}) {
  return hasPendingSessionTransportOpenIntent(
    options.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof hasPendingSessionTransportOpenIntent>[0],
    options.sessionId,
  );
}

export function isPendingSessionTransportOpenStaleRuntime(options: {
  sessionId: string;
  pendingSessionTransportOpenIntentsRef: { current: Map<string, unknown> };
  now?: number;
  staleAfterMs?: number;
}) {
  return isPendingSessionTransportOpenIntentStale(
    options.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof isPendingSessionTransportOpenIntentStale>[0],
    options.sessionId,
    options.now,
    options.staleAfterMs,
  );
}

export function isReconnectInFlightRuntime(options: {
  sessionId: string;
  reconnectRuntimesRef: { current: Map<string, SessionReconnectRuntime> };
}) {
  const reconnectRuntime = options.reconnectRuntimesRef.current.get(options.sessionId) || null;
  if (!reconnectRuntime) {
    return false;
  }
  return reconnectRuntime.connecting || reconnectRuntime.timer !== null;
}

export function resolveSessionCacheLinesRuntime(options: {
  rows?: number | null;
  terminalCacheLines: number;
  defaultRows: number;
}) {
  const viewportRows =
    typeof options.rows === 'number' && Number.isFinite(options.rows)
      ? Math.max(1, Math.floor(options.rows))
      : options.defaultRows;
  const threeScreenLines = resolveTerminalRequestWindowLines(viewportRows);
  if (!Number.isFinite(options.terminalCacheLines) || options.terminalCacheLines <= 0) {
    return threeScreenLines;
  }
  return Math.min(
    DEFAULT_TERMINAL_CACHE_LINES,
    Math.max(threeScreenLines, Math.floor(options.terminalCacheLines)),
  );
}

export function getSessionRenderBufferSnapshotRuntime(options: {
  sessionId: string;
  sessionRenderStoreRef: { current: { getSnapshot: (sessionId: string) => { buffer: SessionRenderBufferSnapshot } } };
}): SessionRenderBufferSnapshot {
  return options.sessionRenderStoreRef.current.getSnapshot(options.sessionId).buffer;
}

export function recordSessionTxInfraRuntime(options: {
  sessionId: string;
  data: string | ArrayBuffer;
  refs: {
    sessionDebugMetricsStoreRef: { current: unknown };
    sessionPullStateRef: { current: Map<string, unknown> };
  };
  recordOptions?: RecordSessionTxOptions;
}) {
  recordSessionTxRuntime(options as Parameters<typeof recordSessionTxRuntime>[0]);
}

export function recordSessionRxInfraRuntime(options: {
  sessionId: string;
  data: string | ArrayBuffer;
  refs: {
    sessionDebugMetricsStoreRef: { current: unknown };
    lastServerActivityAtRef: { current: Map<string, number> };
    staleTransportProbeAtRef: { current: Map<string, number> };
  };
}) {
  recordSessionRxRuntime(options as Parameters<typeof recordSessionRxRuntime>[0]);
}

export function recordSessionRxBytesOnlyInfraRuntime(options: {
  sessionId: string;
  data: string | ArrayBuffer;
  refs: {
    sessionDebugMetricsStoreRef: { current: { recordRxBytes: (sessionId: string, data: string | ArrayBuffer) => void } };
  };
}) {
  options.refs.sessionDebugMetricsStoreRef.current.recordRxBytes(options.sessionId, options.data);
}

export function getSessionRenderBufferStoreRuntime(options: {
  sessionRenderGateRef: { current: { getRenderStore: () => SessionRenderBufferStore } };
}) {
  return options.sessionRenderGateRef.current.getRenderStore();
}

export function markPendingInputTailRefreshInfraRuntime(options: {
  sessionId: string;
  localRevision: number;
  pendingInputTailRefreshRef: { current: Map<string, { requestedAt: number; localRevision: number }> };
}) {
  markPendingInputTailRefreshRuntime(options);
}

export function clearSessionPullStateInfraRuntime(options: {
  sessionId: string;
  sessionPullStateRef: { current: Map<string, unknown> };
  purpose?: SessionPullPurpose;
}) {
  clearSessionPullStateRuntime(options as Parameters<typeof clearSessionPullStateRuntime>[0]);
}

export function settleSessionPullStateInfraRuntime(options: {
  sessionId: string;
  payload: import('../lib/types').TerminalBufferPayload;
  sessionPullStateRef: { current: Map<string, unknown> };
}) {
  settleSessionPullStateRuntime(options as Parameters<typeof settleSessionPullStateRuntime>[0]);
}

export function resetSessionTransportPullBookkeepingInfraRuntime(options: {
  sessionId: string;
  reason: string;
  activeSessionId: string | null;
  sessionPullStateRef: { current: Map<string, unknown> };
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  resetSessionTransportPullBookkeepingRuntime(options as Parameters<typeof resetSessionTransportPullBookkeepingRuntime>[0]);
}

export function isSessionTransportActivityStaleInfraRuntime(options: {
  sessionId: string;
  lastServerActivityAtRef: { current: Map<string, number> };
  staleActivityMs: number;
}) {
  return isSessionTransportActivityStaleRuntime(options);
}

export function sendSocketPayloadInfraRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  data: string | ArrayBuffer;
  recordSessionTx: (sessionId: string, data: string | ArrayBuffer, options?: RecordSessionTxOptions) => void;
  recordOptions?: RecordSessionTxOptions;
}) {
  options.recordSessionTx(options.sessionId, options.data, options.recordOptions);
  options.ws.send(options.data);
}

export function buildTraversalSocketForHostRuntime(options: {
  host: Host;
  bridgeSettings: BridgeSettings;
  wsUrl?: string;
  transportRole?: 'control' | 'session';
}) {
  const traversal = resolveTraversalConfigFromHost(options.host, options.bridgeSettings);
  const overrideUrl = (() => {
    if (!options.wsUrl) {
      return undefined;
    }
    try {
      const parsed = new URL(options.wsUrl);
      parsed.searchParams.set('ztermTransport', options.transportRole || 'session');
      return parsed.toString();
    } catch {
      return options.wsUrl;
    }
  })();
  return new TraversalSocket(traversal.target, traversal.settings, { overrideUrl });
}

export function applyTransportDiagnosticsRuntime(options: {
  sessionId: string;
  socket: BridgeTransportSocket;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
}) {
  const diagnostics = options.socket.getDiagnostics();
  options.updateSessionSync(options.sessionId, {
    resolvedPath: diagnostics.resolvedPath,
    resolvedEndpoint: diagnostics.resolvedEndpoint,
    lastConnectStage: diagnostics.stage,
    lastError: diagnostics.reason || undefined,
  });
}

export function setScheduleStateForSessionRuntime(options: {
  sessionId: string;
  nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState);
  setScheduleStates: React.Dispatch<React.SetStateAction<Record<string, SessionScheduleState>>>;
  stateRef: { current: SessionManagerState };
}) {
  options.setScheduleStates((current) => {
    const emptyScheduleState = buildEmptyScheduleState(
      options.stateRef.current.sessions.find((session) => session.id === options.sessionId)?.sessionName || '',
    );
    const resolvedCurrent = current[options.sessionId] || emptyScheduleState;
    const resolved = typeof options.nextState === 'function' ? options.nextState(resolvedCurrent) : options.nextState;
    return {
      ...current,
      [options.sessionId]: resolved,
    };
  });
}

export function clearHeartbeatRuntime(options: {
  sessionId: string;
  pingIntervalsRef: { current: Map<string, ReturnType<typeof setInterval>> };
  lastPongAtRef: { current: Map<string, number> };
  lastServerActivityAtRef: { current: Map<string, number> };
}) {
  clearSessionHeartbeatRuntime(options);
}

export function clearSessionHandshakeTimeoutInfraRuntime(options: {
  sessionId: string;
  handshakeTimeoutsRef: { current: Map<string, number> };
}) {
  clearSessionHandshakeTimeoutRuntime(options);
}

export function setSessionHandshakeTimeoutInfraRuntime(options: {
  sessionId: string;
  callback: () => void;
  delayMs: number;
  handshakeTimeoutsRef: { current: Map<string, number> };
}) {
  return setSessionHandshakeTimeoutRuntime(options);
}

export function clearTailRefreshRuntimeInfra(options: {
  sessionId: string;
  sessionBufferHeadsRef: { current: Map<string, SessionBufferHeadState> };
  sessionRevisionResetRef: { current: Map<string, { revision: number; latestEndIndex: number; seenAt: number }> };
  lastHeadRequestAtRef: { current: Map<string, number> };
  pendingInputTailRefreshRef?: { current: Map<string, { requestedAt: number; localRevision: number }> };
  pendingConnectTailRefreshRef?: { current: Set<string> };
  pendingResumeTailRefreshRef?: { current: Set<string> };
}) {
  clearTailRefreshRuntimeRuntime(options);
}

export function startSocketHeartbeatInfraRuntime(options: {
  sessionId: string;
  ws: BridgeTransportSocket;
  finalizeFailure: (message: string, retryable: boolean) => void;
  pingIntervalsRef: { current: Map<string, ReturnType<typeof setInterval>> };
  lastPongAtRef: { current: Map<string, number> };
  clientPingIntervalMs: number;
  clientPongTimeoutMs: number;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  startSocketHeartbeatRuntime(options);
}

export function cleanupControlSocketRuntime(options: {
  sessionId: string;
  shouldClose?: boolean;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
}) {
  cleanupControlTransportSocketRuntime(options);
}
