import type { Host, ServerMessage, Session, SessionBufferState, SessionScheduleState, TerminalBufferPayload, TerminalCursorState } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionBufferHeadState, SessionPullPurpose } from './session-sync-helpers';
import {
  applyIncomingBufferSyncRuntime,
  handleBufferHeadRuntime,
  requestSessionBufferHeadRuntime,
  requestSessionBufferSyncRuntime,
} from './session-context-buffer-runtime';
import {
  finalizeSocketFailureBaselineRuntime,
  handleSocketConnectedBaselineRuntime,
  handleSocketServerMessageRuntime,
} from './session-context-socket-message-runtime';

interface MutableRefObject<T> {
  current: T;
}

export function commitSessionBufferUpdateRuntime(options: {
  sessionId: string;
  nextBuffer: SessionBufferState;
  sessionBufferStoreRef: MutableRefObject<{
    setBuffer: (sessionId: string, buffer: SessionBufferState) => boolean;
  }>;
}) {
  const changed = options.sessionBufferStoreRef.current.setBuffer(options.sessionId, options.nextBuffer);
  if (!changed) {
    return false;
  }
  return true;
}

export function requestSessionBufferSyncOrchestrationRuntime(options: {
  sessionId: string;
  requestOptions?: {
    ws?: BridgeTransportSocket | null;
    reason?: string;
    purpose?: SessionPullPurpose;
    sessionOverride?: Session | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
  };
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, any>>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    sessionPullStateRef: MutableRefObject<Map<string, any>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  clearSessionPullState: (sessionId: string, purpose?: SessionPullPurpose) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, sendOptions?: any) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  return requestSessionBufferSyncRuntime(options as Parameters<typeof requestSessionBufferSyncRuntime>[0]);
}

export function requestSessionBufferHeadOrchestrationRuntime(options: {
  sessionId: string;
  ws?: BridgeTransportSocket | null;
  force?: boolean;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    sessionDebugMetricsStoreRef: MutableRefObject<{ recordRefreshRequest: (sessionId: string) => void }>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, sendOptions?: any) => void;
  resolveTerminalRefreshCadence: () => { headTickMs: number };
}) {
  return requestSessionBufferHeadRuntime(options as Parameters<typeof requestSessionBufferHeadRuntime>[0]);
}

export function handleBufferHeadOrchestrationRuntime(options: {
  sessionId: string;
  latestRevision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  cursor?: TerminalCursorState | null;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    sessionRevisionResetRef: MutableRefObject<Map<string, { revision: number; latestEndIndex: number; seenAt: number }>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, any>>;
    sessionBufferStoreRef: MutableRefObject<{ setBuffer: (sessionId: string, buffer: SessionBufferState) => boolean }>;
    sessionHeadStoreRef: MutableRefObject<{ setHead: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean }>;
  };
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState) => boolean;
  isSessionTransportActive: (sessionId: string) => boolean;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      reason?: string;
      purpose?: SessionPullPurpose;
      sessionOverride?: Session | null;
      liveHead?: SessionBufferHeadState | null;
      invalidLocalWindow?: boolean;
    },
  ) => boolean;
}) {
  handleBufferHeadRuntime(options as Parameters<typeof handleBufferHeadRuntime>[0]);
}

export function applyIncomingBufferSyncOrchestrationRuntime(options: {
  sessionId: string;
  payload: TerminalBufferPayload;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    sessionRevisionResetRef: MutableRefObject<Map<string, { revision: number; latestEndIndex: number; seenAt: number }>>;
    sessionBufferHeadsRef: MutableRefObject<Map<string, SessionBufferHeadState>>;
    pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
    pendingResumeTailRefreshRef: MutableRefObject<Set<string>>;
    sessionVisibleRangeRef: MutableRefObject<Map<string, any>>;
  };
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  resolveSessionCacheLines: (rows?: number | null) => number;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  commitSessionBufferUpdate: (sessionId: string, nextBuffer: SessionBufferState) => boolean;
  recordSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  requestSessionBufferSync: (
    sessionId: string,
    requestOptions?: {
      ws?: BridgeTransportSocket | null;
      reason?: string;
      purpose?: SessionPullPurpose;
      sessionOverride?: Session | null;
      liveHead?: SessionBufferHeadState | null;
      invalidLocalWindow?: boolean;
    },
  ) => boolean;
}) {
  applyIncomingBufferSyncRuntime(options as Parameters<typeof applyIncomingBufferSyncRuntime>[0]);
}

export function handleSocketServerMessageOrchestrationRuntime(options: {
  params: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
  };
  msg: ServerMessage;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    scheduleStatesRef: MutableRefObject<Record<string, SessionScheduleState>>;
    lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
    lastPongAtRef: MutableRefObject<Map<string, number>>;
  };
  settleSessionPullState: (sessionId: string, payload: TerminalBufferPayload) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  applyIncomingBufferSync: (sessionId: string, payload: TerminalBufferPayload) => void;
  handleBufferHead: (
    sessionId: string,
    latestRevision: number,
    latestEndIndex: number,
    availableStartIndex?: number,
    availableEndIndex?: number,
    cursor?: TerminalCursorState | null,
  ) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  fileTransferMessageRuntime: { dispatch: (msg: any) => unknown };
}) {
  handleSocketServerMessageRuntime(options as Parameters<typeof handleSocketServerMessageRuntime>[0]);
}

export function handleSocketConnectedBaselineOrchestrationRuntime(options: {
  sessionId: string;
  sessionName: string;
  ws: BridgeTransportSocket;
  refs: {
    stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null }>;
    pendingConnectTailRefreshRef: MutableRefObject<Set<string>>;
  };
  readSessionBufferSnapshot: (sessionId: string) => Session['buffer'];
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, sendOptions?: any) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  incrementConnectedSync: () => void;
}) {
  handleSocketConnectedBaselineRuntime(options as Parameters<typeof handleSocketConnectedBaselineRuntime>[0]);
}

export function finalizeSocketFailureBaselineOrchestrationRuntime(options: {
  sessionId: string;
  message: string;
  markCompleted: () => boolean;
  refs: {
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, unknown>>;
    manualCloseRef: MutableRefObject<Set<string>>;
  };
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
}) {
  return finalizeSocketFailureBaselineRuntime(options as Parameters<typeof finalizeSocketFailureBaselineRuntime>[0]);
}
