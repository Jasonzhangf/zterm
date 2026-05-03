import { buildSessionConnectedUpdates, buildSessionScheduleListLoadingState, normalizeIncomingBufferPayload, normalizeTerminalCursorState } from './session-sync-helpers';
import { buildConnectedHeadRefreshPlan, hasSessionLocalWindow } from './session-sync-helpers';
import { setRuntimeDebugEnabled } from '../lib/runtime-debug';
import { isFileTransferMessage } from '../lib/file-transfer-message-runtime';
import type {
  ClientMessage,
  Host,
  ServerMessage,
  Session,
  SessionScheduleState,
  TerminalBufferPayload,
  TerminalCursorState,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface MutableRefObject<T> {
  current: T;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

interface FileTransferDispatcher {
  dispatch: (msg: Extract<ServerMessage, { type:
    | 'file-list-response'
    | 'file-list-error'
    | 'remote-screenshot-status'
    | 'file-download-chunk'
    | 'file-download-complete'
    | 'file-download-error'
    | 'file-upload-progress'
    | 'file-upload-complete'
    | 'file-upload-error'
  }>) => unknown;
}

export function handleSocketServerMessageRuntime(options: {
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
  runtimeDebug: RuntimeDebugFn;
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
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  fileTransferMessageRuntime: FileTransferDispatcher;
}) {
  const { params, msg } = options;
  const currentSession = options.refs.stateRef.current.sessions.find((item) => item.id === params.sessionId) || null;
  const shouldPromoteConnectedFromLiveBuffer =
    Boolean(currentSession)
    && currentSession!.state !== 'connected'
    && (msg.type === 'buffer-sync' || msg.type === 'buffer-head');

  switch (msg.type) {
    case 'connected':
      params.onConnected();
      break;
    case 'buffer-sync':
      if (shouldPromoteConnectedFromLiveBuffer) {
        params.onConnected();
      }
      options.refs.lastHeadRequestAtRef.current.set(params.sessionId, Date.now());
      options.settleSessionPullState(params.sessionId, msg.payload);
      options.runtimeDebug(`session.ws.${params.debugScope}.buffer-sync`, {
        sessionId: params.sessionId,
        payload: options.summarizeBufferPayload(msg.payload),
        activeSessionId: options.refs.stateRef.current.activeSessionId,
      });
      options.applyIncomingBufferSync(params.sessionId, normalizeIncomingBufferPayload(msg.payload));
      break;
    case 'buffer-head':
      if (shouldPromoteConnectedFromLiveBuffer) {
        params.onConnected();
      }
      options.handleBufferHead(
        params.sessionId,
        Math.max(0, Math.floor(msg.payload.revision || 0)),
        Math.max(0, Math.floor(msg.payload.latestEndIndex || 0)),
        Number.isFinite(msg.payload.availableStartIndex) ? Math.max(0, Math.floor(msg.payload.availableStartIndex || 0)) : undefined,
        Number.isFinite(msg.payload.availableEndIndex) ? Math.max(0, Math.floor(msg.payload.availableEndIndex || 0)) : undefined,
        normalizeTerminalCursorState(msg.payload.cursor),
      );
      break;
    case 'schedule-state':
      options.setScheduleStateForSession(params.sessionId, {
        sessionName: msg.payload.sessionName,
        jobs: msg.payload.jobs,
        loading: false,
        lastEvent: options.refs.scheduleStatesRef.current[params.sessionId]?.lastEvent,
      });
      break;
    case 'schedule-event':
      options.setScheduleStateForSession(params.sessionId, (current) => ({
        ...current,
        sessionName: msg.payload.sessionName,
        loading: false,
        lastEvent: msg.payload,
      }));
      break;
    case 'debug-control':
      setRuntimeDebugEnabled(Boolean(msg.payload.enabled));
      options.runtimeDebug('session.runtime-debug.control', {
        sessionId: params.sessionId,
        enabled: Boolean(msg.payload.enabled),
        reason: msg.payload.reason || 'remote-control',
      });
      break;
    case 'title':
      options.setSessionTitleSync(params.sessionId, msg.payload);
      break;
    case 'image-pasted':
    case 'file-attached':
      break;
    case 'file-list-response':
    case 'file-list-error':
    case 'remote-screenshot-status':
    case 'file-download-chunk':
    case 'file-download-complete':
    case 'file-download-error':
    case 'file-upload-progress':
    case 'file-upload-complete':
    case 'file-upload-error':
      if (isFileTransferMessage(msg)) {
        options.fileTransferMessageRuntime.dispatch(msg);
      }
      break;
    case 'error':
      params.onFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
      break;
    case 'closed':
      params.onFailure(msg.payload.reason || 'socket closed', true);
      break;
    case 'sessions':
      break;
    case 'pong':
      options.refs.lastPongAtRef.current.set(params.sessionId, Date.now());
      break;
  }
}

export function handleSocketConnectedBaselineRuntime(options: {
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
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  requestSessionBufferHead: (sessionId: string, ws?: BridgeTransportSocket | null, options?: { force?: boolean }) => boolean;
  incrementConnectedSync: () => void;
}) {
  const currentSession = options.refs.stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
  const hadLocalWindowBeforeConnected = hasSessionLocalWindow(
    currentSession,
    options.readSessionBufferSnapshot(options.sessionId),
  );
  options.applyTransportDiagnostics(options.sessionId, options.ws);
  options.updateSessionSync(options.sessionId, buildSessionConnectedUpdates());
  options.setScheduleStateForSession(options.sessionId, (current) => (
    buildSessionScheduleListLoadingState(current, options.sessionName)
  ));
  options.sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
    type: 'schedule-list',
    payload: { sessionName: options.sessionName },
  } satisfies ClientMessage));
  const connectedHeadRefreshPlan = buildConnectedHeadRefreshPlan({
    shouldLiveRefresh: options.isSessionTransportActive(options.sessionId),
    hadLocalWindowBeforeConnected,
  });
  if (connectedHeadRefreshPlan.shouldMarkPendingConnectTailRefresh) {
    options.refs.pendingConnectTailRefreshRef.current.add(options.sessionId);
  }
  if (connectedHeadRefreshPlan.shouldRequestHead) {
    options.requestSessionBufferHead(options.sessionId, options.ws, { force: true });
  }
  options.incrementConnectedSync();
}

export function finalizeSocketFailureBaselineRuntime(options: {
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
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
}) {
  if (!options.markCompleted()) {
    return {
      shouldContinue: false,
      manualClosed: false,
    };
  }

  options.cleanupSocket(options.sessionId);
  options.refs.pendingSessionTransportOpenIntentsRef.current.delete(options.sessionId);
  options.writeSessionTransportToken(options.sessionId, null);
  options.setScheduleStateForSession(options.sessionId, (current) => ({
    ...current,
    loading: false,
    error: options.message,
  }));

  const manualClosed = options.refs.manualCloseRef.current.has(options.sessionId);
  return {
    shouldContinue: !manualClosed,
    manualClosed,
  };
}
