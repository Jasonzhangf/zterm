import {
  buildConnectedHeadRefreshPlan,
  buildSessionClosedUpdates,
  buildSessionConnectedUpdates,
  buildSessionScheduleListLoadingState,
} from './session-transport-open-helpers';
import { hasSessionLocalWindow } from './session-buffer-planner-helpers';
import { normalizeIncomingBufferPayload, normalizeTerminalCursorState } from './session-wire-helpers';
import { runtimeDebugPrechecked, setRuntimeDebugEnabled } from '../lib/runtime-debug';
import { isFileTransferMessage } from '../lib/file-transfer-message-runtime';
import { isRemoteWindowControlMessage, type RemoteWindowControlMessage } from '../lib/remote-window-message-runtime';
import { handleTerminalInputAck } from './session-context-input-runtime';
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
import { deletePendingSessionTransportOpenIntent } from './session-context-open-intent-store';

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

interface RemoteWindowMessageDispatcher {
  dispatch: (msg: RemoteWindowControlMessage) => unknown;
}

function isTerminalSessionMissingCode(code?: string) {
  return code === 'tmux_session_killed';
}

function isRetryableTerminalAttachCode(code?: string) {
  return code === 'tmux_session_unavailable';
}

export function handleSocketServerMessageRuntime(options: {
  params: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    rawFrameBytes?: number;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
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
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer?: (sessionId: string) => boolean;
  summarizeBufferPayload: (payload: TerminalBufferPayload) => Record<string, unknown>;
  applyIncomingBufferSync: (sessionId: string, payload: TerminalBufferPayload) => void;
  handleBufferHead: (
    sessionId: string,
    latestRevision: number,
    latestEndIndex: number,
    availableStartIndex?: number,
    availableEndIndex?: number,
    cursor?: TerminalCursorState | null,
    cursorKeysApp?: boolean,
  ) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  fileTransferMessageRuntime: FileTransferDispatcher;
  remoteWindowMessageRuntime?: RemoteWindowMessageDispatcher;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
}) {
  const { params, msg } = options;
  const currentSession = options.refs.stateRef.current.sessions.find((item) => item.id === params.sessionId) || null;
  const shouldPromoteConnectedFromLiveBuffer =
    Boolean(currentSession)
    && currentSession!.state !== 'connected'
    && (msg.type === 'buffer-sync' || msg.type === 'buffer-head');
  const shouldAcceptLiveBufferPayload = options.shouldAcceptSessionLiveBuffer
    ? options.shouldAcceptSessionLiveBuffer(params.sessionId)
    : options.isSessionTransportActive(params.sessionId);

  switch (msg.type) {
    case 'connected':
      options.updateSessionSync(params.sessionId, buildSessionConnectedUpdates({
        daemonHostId: msg.payload.daemonHostId,
        reliableInputSupported: msg.payload.capabilities?.reliableInput?.version === 1,
      }));
      if (currentSession?.state !== 'connected') {
        params.onConnected();
      }
      break;
    case 'buffer-sync':
      if (!shouldAcceptLiveBufferPayload) {
        options.runtimeDebug(`session.ws.${params.debugScope}.buffer-sync.inactive-drop`, {
          sessionId: params.sessionId,
          activeSessionId: options.refs.stateRef.current.activeSessionId,
          lineCount: Array.isArray(msg.payload.lines) ? msg.payload.lines.length : 0,
          revision: msg.payload.revision,
          startIndex: msg.payload.startIndex,
          endIndex: msg.payload.endIndex,
        });
        break;
      }
      if (shouldPromoteConnectedFromLiveBuffer) {
        params.onConnected();
      }
      runtimeDebugPrechecked('terminal.performance.trace', {
        sessionId: params.sessionId,
        traceId: `${params.sessionId}:${Math.max(0, Math.floor(msg.payload.revision || 0))}`,
        mirrorRevision: Math.max(0, Math.floor(msg.payload.revision || 0)),
        subscriberId: params.sessionId,
        stage: 'client-rx',
        at: Date.now(),
        bytes: Number.isFinite(params.rawFrameBytes)
          ? Math.max(0, Math.floor(params.rawFrameBytes || 0))
          : 0,
        lineCount: Array.isArray(msg.payload.lines) ? msg.payload.lines.length : 0,
      });
      options.settleSessionPullState(params.sessionId, msg.payload);
      options.runtimeDebug(`session.ws.${params.debugScope}.buffer-sync`, {
        sessionId: params.sessionId,
        payload: options.summarizeBufferPayload(msg.payload),
        activeSessionId: options.refs.stateRef.current.activeSessionId,
      });
      options.applyIncomingBufferSync(params.sessionId, normalizeIncomingBufferPayload(msg.payload));
      break;
    case 'buffer-head':
      if (!shouldAcceptLiveBufferPayload) {
        options.runtimeDebug(`session.ws.${params.debugScope}.buffer-head.inactive-drop`, {
          sessionId: params.sessionId,
          activeSessionId: options.refs.stateRef.current.activeSessionId,
          revision: msg.payload.revision,
          latestEndIndex: msg.payload.latestEndIndex,
          availableStartIndex: msg.payload.availableStartIndex ?? null,
          availableEndIndex: msg.payload.availableEndIndex ?? null,
        });
        break;
      }
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
        typeof msg.payload.cursorKeysApp === 'boolean' ? msg.payload.cursorKeysApp : undefined,
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
    case 'schedule-error':
      options.setScheduleStateForSession(params.sessionId, (current) => ({
        ...current,
        sessionName: msg.payload.sessionName || current.sessionName,
        loading: false,
        error: msg.payload.message,
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
    case 'remote-window-targets-response':
    case 'remote-window-stream-started':
    case 'remote-window-stream-ice-candidate':
    case 'remote-window-stream-status':
    case 'remote-window-input-result':
    case 'remote-window-error':
      if (options.remoteWindowMessageRuntime && isRemoteWindowControlMessage(msg)) {
        options.remoteWindowMessageRuntime.dispatch(msg);
      }
      break;
    case 'input-ack':
      handleTerminalInputAck(params.sessionId, msg.payload);
      break;
    case 'error':
      if (isRetryableTerminalAttachCode(msg.payload.code)) {
        options.runtimeDebug(`session.ws.${params.debugScope}.remote-session-unavailable`, {
          sessionId: params.sessionId,
          code: msg.payload.code,
          message: msg.payload.message,
          activeSessionId: options.refs.stateRef.current.activeSessionId,
        });
        params.onFailure(msg.payload.message, true);
        break;
      }
      if (isTerminalSessionMissingCode(msg.payload.code)) {
        options.runtimeDebug(`session.ws.${params.debugScope}.remote-session-missing`, {
          sessionId: params.sessionId,
          code: msg.payload.code,
          message: msg.payload.message,
          activeSessionId: options.refs.stateRef.current.activeSessionId,
        });
        params.ws.onopen = null;
        params.ws.onmessage = null;
        params.ws.onerror = null;
        params.ws.onclose = null;
        params.onClosed(msg.payload.message || msg.payload.code);
        break;
      }
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
    lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
    connectedBaselineBurstGuardRef: MutableRefObject<Set<string>>;
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
  requestSessionBufferHead: (
    sessionId: string,
    ws?: BridgeTransportSocket | null,
    options?: { force?: boolean; trackProbe?: boolean },
  ) => boolean;
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
    shouldLiveRefresh: true,
    hadLocalWindowBeforeConnected,
  });
  if (connectedHeadRefreshPlan.shouldMarkPendingConnectTailRefresh) {
    options.refs.pendingConnectTailRefreshRef.current.add(options.sessionId);
  }
  if (connectedHeadRefreshPlan.shouldRequestHead) {
    options.requestSessionBufferHead(options.sessionId, options.ws, {
      force: true,
      trackProbe: false,
    });
  }
  options.refs.lastConnectedBaselineAtRef.current.set(options.sessionId, Date.now());
  options.refs.connectedBaselineBurstGuardRef.current.add(options.sessionId);
  queueMicrotask(() => {
    options.refs.connectedBaselineBurstGuardRef.current.delete(options.sessionId);
  });
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
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
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
  deletePendingSessionTransportOpenIntent(
    options.refs.pendingSessionTransportOpenIntentsRef.current as Parameters<typeof deletePendingSessionTransportOpenIntent>[0],
    options.sessionId,
  );
  options.writeSessionTransportToken(options.sessionId, null);
  options.updateSessionSync(
    options.sessionId,
    buildSessionClosedUpdates(options.message),
  );
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
