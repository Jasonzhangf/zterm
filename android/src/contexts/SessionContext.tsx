/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import type {
  ClientMessage,
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  Host,
  PasteImageStartPayload,
  AttachFileStartPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
  ScheduleJobDraft,
  ServerMessage,
  Session,
  SessionDebugOverlayMetrics,
  SessionScheduleState,
  SessionBufferState,
  TerminalCursorState,
  SessionState,
  TerminalBufferPayload,
  TerminalVisibleRange,
  TerminalWidthMode,
} from '../lib/types';
import { buildEmptyScheduleState } from '@zterm/shared';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from '../lib/bridge-settings';
import { getResolvedSessionName } from '../lib/connection-target';
import {
  ACTIVE_HEAD_REFRESH_TICK_MS,
  DEFAULT_TERMINAL_CACHE_LINES,
  resolveTerminalRefreshCadence,
  resolveTerminalRequestWindowLines,
} from '../lib/mobile-config';
import { drainRuntimeDebugEntries, getPendingRuntimeDebugEntryCount, isRuntimeDebugEnabled, runtimeDebug, setRuntimeDebugEnabled } from '../lib/runtime-debug';
import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  sessionBuffersEqual,
} from '../lib/terminal-buffer';
import {
  clearSessionSupersededSockets,
  createSessionTransportRuntimeStore,
  getSessionTargetControlTransport,
  getSessionTargetTransportRuntime,
  getSessionTransportHost,
  getSessionTransportRuntime,
  getSessionTransportSocket,
  getSessionTransportToken,
  getSessionTransportTargetKey,
  moveSessionTransportSocketToSuperseded,
  removeSessionTransportRuntime,
  setSessionTargetControlTransport,
  setSessionTransportToken,
  setSessionTransportSocket,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';
import { resolveTraversalConfigFromHost } from '../lib/traversal/config';
import { TraversalSocket } from '../lib/traversal/socket';
import type { BridgeTransportSocket } from '../lib/traversal/types';

import {
  buildActiveSessionRefreshPlan,
  buildReconnectHandshakeFailurePlan,
  buildTransportOpenConnectedEffectPlan,
  buildTransportOpenLiveFailureEffectPlan,
  buildConnectedHeadRefreshPlan,
  buildSessionConnectedUpdates,
  buildSessionConnectingLabelUpdates,
  buildSessionConnectionFields,
  buildSessionErrorUpdates,
  buildSessionIdleAfterReconnectBlockedUpdates,
  buildSessionReconnectAttemptProgressUpdates,
  buildSessionReconnectingFailureUpdates,
  buildSessionScheduleListLoadingState,
  buildSessionScheduleErrorState,
  buildSessionScheduleLoadingState,
  buildSessionTransportPrimeState,
  buildDefaultSessionVisibleRange,
  buildHostConfigMessage,
  createPendingSessionTransportOpenIntent,
  findReusableManagedSession,
  buildSessionBufferSyncRequestPayload,
  doesSessionPullStateCoverRequest,
  doesSessionPullStateMatchExactLocalSnapshot,
  getPrimarySessionPullState,
  hasActiveSessionPullState,
  hasImpossibleLocalWindow,
  hasSessionLocalWindow,
  normalizeIncomingBufferPayload,
  normalizeSessionVisibleRangeState,
  normalizeTerminalCursorState,
  orderSessionsForReconnect,
  shouldOpenManagedSessionTransport,
  visibleRangeStatesEqual,
  settleSessionPullStatesWithBufferSync,
  clearSessionPullStateEntry,
  shouldAutoReconnectSession,
  shouldCatchUpFollowTailAfterBufferApply,
  shouldPullFollowBuffer,
  shouldPullVisibleRangeBuffer,
  shouldReconnectQueuedActiveInput,
  type PendingSessionTransportOpenIntent,
  type QueueSessionTransportOpenIntentOptions as SessionTransportOpenIntentHelperOptions,
  type SessionBufferHeadState,
  type SessionPullPurpose,
  type SessionPullStates,
  type SessionVisibleRangeState,
} from './session-sync-helpers';
export { shouldReconnectActivatedSession, shouldReconnectQueuedActiveInput } from './session-sync-helpers';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;
const SESSION_HANDSHAKE_TIMEOUT_MS = 4000;
const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;
const ACTIVE_TRANSPORT_STALE_ACTIVITY_MS = CLIENT_PING_INTERVAL_MS + 5000;
const ACTIVE_TRANSPORT_PROBE_WAIT_MS = 1500;
const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;
const DEFAULT_TERMINAL_SESSION_VIEWPORT = {
  cols: 80,
  rows: 24,
} as const;

function emitSessionStatus(sessionId: string, type: 'closed' | 'error', message?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_STATUS_EVENT, { detail: { sessionId, type, message } }));
}

function summarizeBufferPayload(payload: TerminalBufferPayload) {
  const firstLine = payload.lines[0];
  const lastLine = payload.lines[payload.lines.length - 1];
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    cols: payload.cols,
    rows: payload.rows,
    lineCount: payload.lines.length,
    cursor: payload.cursor
      ? {
          rowIndex: payload.cursor.rowIndex,
          col: payload.cursor.col,
          visible: payload.cursor.visible,
        }
      : null,
    firstLineIndex: firstLine ? ('i' in firstLine ? firstLine.i : firstLine.index) : null,
    lastLineIndex: lastLine ? ('i' in lastLine ? lastLine.i : lastLine.index) : null,
  };
}

function summarizeSessions(sessions: Session[]) {
  return sessions.map((session) => ({
    id: session.id,
    state: session.state,
    revision: session.buffer.revision,
  }));
}

interface SessionManagerState {
  sessions: Session[];
  activeSessionId: string | null;
  connectedCount: number;
}

type SessionAction =
  | { type: 'CREATE_SESSION'; session: Session; activate: boolean }
  | { type: 'UPDATE_SESSION'; id: string; updates: Partial<Session> }
  | { type: 'MOVE_SESSION'; id: string; toIndex: number }
  | { type: 'SET_SESSION_BUFFER_SYNC'; id: string; payload: TerminalBufferPayload; cacheLines: number }
  | { type: 'DELETE_SESSION'; id: string }
  | { type: 'SET_ACTIVE_SESSION'; id: string }
  | { type: 'SET_SESSION_STATE'; id: string; state: SessionState }
  | { type: 'SET_SESSION_TITLE'; id: string; title: string }
  | { type: 'INCREMENT_CONNECTED' }
  | { type: 'DECREMENT_CONNECTED' };

const initialState: SessionManagerState = {
  sessions: [],
  activeSessionId: null,
  connectedCount: 0,
};

function reduceSessionAction(state: SessionManagerState, action: SessionAction): SessionManagerState {
  switch (action.type) {
    case 'CREATE_SESSION': {
      const nextSessions = [...state.sessions.filter((session) => session.id !== action.session.id), action.session];
      return {
        ...state,
        sessions: nextSessions,
        activeSessionId: action.activate ? action.session.id : state.activeSessionId || action.session.id,
      };
    }
    case 'UPDATE_SESSION':
      return {
        ...state,
        sessions: state.sessions.map((session) => (session.id === action.id ? { ...session, ...action.updates } : session)),
      };
    case 'MOVE_SESSION': {
      const currentIndex = state.sessions.findIndex((session) => session.id === action.id);
      if (currentIndex < 0) {
        return state;
      }
      const nextIndex = Math.max(0, Math.min(action.toIndex, state.sessions.length - 1));
      if (currentIndex === nextIndex) {
        return state;
      }
      const nextSessions = [...state.sessions];
      const [session] = nextSessions.splice(currentIndex, 1);
      nextSessions.splice(nextIndex, 0, session);
      return {
        ...state,
        sessions: nextSessions,
      };
    }
    case 'SET_SESSION_BUFFER_SYNC':
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== action.id) {
            return session;
          }
          const nextBuffer = applyBufferSyncToSessionBuffer(session.buffer, action.payload, action.cacheLines);
          return {
            ...session,
            buffer: nextBuffer,
          };
        }),
      };
    case 'DELETE_SESSION': {
      const nextSessions = state.sessions.filter((session) => session.id !== action.id);
      return {
        ...state,
        sessions: nextSessions,
        activeSessionId: state.activeSessionId === action.id ? (nextSessions[0]?.id || null) : state.activeSessionId,
      };
    }
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.id };
    case 'SET_SESSION_STATE':
      return {
        ...state,
        sessions: state.sessions.map((session) => (session.id === action.id ? { ...session, state: action.state } : session)),
      };
    case 'SET_SESSION_TITLE':
      return {
        ...state,
        sessions: state.sessions.map((session) => (session.id === action.id ? { ...session, title: action.title } : session)),
      };
    case 'INCREMENT_CONNECTED':
      return { ...state, connectedCount: state.connectedCount + 1 };
    case 'DECREMENT_CONNECTED':
      return { ...state, connectedCount: Math.max(0, state.connectedCount - 1) };
    default:
      return state;
  }
}

function sessionReducer(state: SessionManagerState, action: SessionAction): SessionManagerState {
  return reduceSessionAction(state, action);
}

function sessionDebugMetricsEqual(
  left: Record<string, SessionDebugOverlayMetrics | undefined>,
  right: Record<string, SessionDebugOverlayMetrics | undefined>,
) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftItem = left[key];
    const rightItem = right[key];
    if (!leftItem && !rightItem) {
      continue;
    }
    if (!leftItem || !rightItem) {
      return false;
    }
    if (
      leftItem.uplinkBps !== rightItem.uplinkBps
      || leftItem.downlinkBps !== rightItem.downlinkBps
      || leftItem.renderHz !== rightItem.renderHz
      || leftItem.pullHz !== rightItem.pullHz
      || leftItem.bufferPullActive !== rightItem.bufferPullActive
      || leftItem.status !== rightItem.status
      || leftItem.active !== rightItem.active
    ) {
      return false;
    }
  }
  return true;
}

interface SessionContextValue {
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  getSessionDebugMetrics: (sessionId: string) => SessionDebugOverlayMetrics | null;
  createSession: (host: Host, options?: CreateSessionOptions) => string;
  closeSession: (id: string) => void;
  switchSession: (id: string) => void;
  moveSession: (id: string, toIndex: number) => void;
  renameSession: (id: string, name: string) => void;
  reconnectSession: (id: string) => void;
  reconnectAllSessions: () => void;
  resumeActiveSessionTransport: (id: string) => boolean;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (sessionId: string, data: string) => void;
  sendImagePaste: (sessionId: string, file: File) => Promise<void>;
  sendFileAttach: (sessionId: string, file: File) => Promise<void>;
  requestRemoteScreenshot: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => Promise<RemoteScreenshotCapture>;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  setTerminalWidthMode: (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalVisibleRange) => void;
  requestScheduleList: (sessionId: string) => void;
  upsertScheduleJob: (sessionId: string, job: ScheduleJobDraft) => void;
  deleteScheduleJob: (sessionId: string, jobId: string) => void;
  toggleScheduleJob: (sessionId: string, jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (sessionId: string, jobId: string) => void;
  getSessionScheduleState: (sessionId: string) => SessionScheduleState;
  getActiveSession: () => Session | null;
  getSession: (id: string) => Session | null;
  onFileTransferMessage: (handler: (msg: any) => void) => () => void;
  sendMessageRaw: (sessionId: string, msg: unknown) => void;
}

interface SessionProviderProps {
  children: React.ReactNode;
  wsUrl?: string;
  terminalCacheLines?: number;
  bridgeSettings?: BridgeSettings;
  appForegroundActive?: boolean;
}

interface CreateSessionOptions {
  activate?: boolean;
  connect?: boolean;
  customName?: string;
  buffer?: SessionBufferState;
  createdAt?: number;
  sessionId?: string;
}

interface SessionReconnectRuntime {
  attempt: number;
  timer: number | null;
  nextDelayMs: number | null;
  connecting: boolean;
}

interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

interface SessionWireStatsSnapshot {
  txBytes: number;
  rxBytes: number;
  renderCommits: number;
  refreshRequests: number;
}

interface PendingRemoteScreenshotRequest {
  fileName: string | null;
  chunks: Map<number, string>;
  totalBytes: number;
  phase: 'request-sent' | 'capturing' | 'transferring';
  timeoutId: number | null;
  onProgress?: (progress: RemoteScreenshotStatusPayload) => void;
  resolve: (capture: RemoteScreenshotCapture) => void;
  reject: (error: Error) => void;
}

type QueueSessionTransportOpenIntentOptions = Omit<
  SessionTransportOpenIntentHelperOptions,
  'resolvedSessionName' | 'clearHandshakeTimeout' | 'finalizeSocketFailureBaseline'
>;

type QueueSessionTransportOpenIntent = (options: QueueSessionTransportOpenIntentOptions) => void;

const SessionContext = createContext<SessionContextValue | null>(null);

const REMOTE_SCREENSHOT_REQUEST_TIMEOUT_MS = 15000;

function createSessionReconnectRuntime(): SessionReconnectRuntime {
  return {
    attempt: 0,
    timer: null,
    nextDelayMs: null,
    connecting: false,
  };
}

function computeReconnectDelay(attempt: number) {
  // First reconnect is immediate (0ms); subsequent attempts use exponential backoff.
  if (attempt <= 0) return 0;
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

export function SessionProvider({
  children,
  wsUrl,
  terminalCacheLines = DEFAULT_TERMINAL_CACHE_LINES,
  bridgeSettings = DEFAULT_BRIDGE_SETTINGS,
  appForegroundActive,
}: SessionProviderProps) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [scheduleStates, setScheduleStates] = useState<Record<string, SessionScheduleState>>({});
  const sessionDebugMetricsRef = useRef<Record<string, SessionDebugOverlayMetrics | undefined>>({});
  const stateRef = useRef(state);
  const scheduleStatesRef = useRef<Record<string, SessionScheduleState>>({});
  const transportRuntimeStoreRef = useRef(createSessionTransportRuntimeStore());
  const pingIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const handshakeTimeoutsRef = useRef<Map<string, number>>(new Map());
  // renderer -> worker visible range declaration only; never producer/tail truth
  const sessionVisibleRangeRef = useRef<Map<string, SessionVisibleRangeState>>(new Map());
  const lastPongAtRef = useRef<Map<string, number>>(new Map());
  const lastServerActivityAtRef = useRef<Map<string, number>>(new Map());
  const staleTransportProbeAtRef = useRef<Map<string, number>>(new Map());
  const viewportSizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const reconnectRuntimesRef = useRef<Map<string, SessionReconnectRuntime>>(new Map());
  const manualCloseRef = useRef<Set<string>>(new Set());
  const pendingInputQueueRef = useRef<Map<string, string[]>>(new Map());
  const lastActivatedSessionIdRef = useRef<string | null>(null);
  const sessionBufferHeadsRef = useRef<Map<string, SessionBufferHeadState>>(new Map());
  const sessionRevisionResetRef = useRef<Map<string, RevisionResetExpectation>>(new Map());
  const pendingInputTailRefreshRef = useRef<Map<string, { requestedAt: number; localRevision: number }>>(new Map());
  const pendingConnectTailRefreshRef = useRef<Set<string>>(new Set());
  const pendingResumeTailRefreshRef = useRef<Set<string>>(new Set());
  const lastHeadRequestAtRef = useRef<Map<string, number>>(new Map());
  const sessionWireStatsRef = useRef<Map<string, SessionWireStatsSnapshot>>(new Map());
  const sessionWireStatsPreviousRef = useRef<Map<string, { sample: SessionWireStatsSnapshot; at: number }>>(new Map());
  const sessionPullStateRef = useRef<Map<string, SessionPullStates>>(new Map());
  const pendingSessionTransportOpenIntentsRef = useRef<Map<string, PendingSessionTransportOpenIntent>>(new Map());
  const fileTransferListeners = useRef<Set<(msg: any) => void>>(new Set());
  const pendingRemoteScreenshotRequestsRef = useRef<Map<string, PendingRemoteScreenshotRequest>>(new Map());
  const foregroundActiveRef = useRef(appForegroundActive !== false);
  const handleSocketConnectedBaselineRef = useRef<null | ((options: {
    sessionId: string;
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => void)>(null);
  const finalizeSocketFailureBaselineRef = useRef<null | ((options: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => { shouldContinue: boolean; manualClosed: boolean })>(null);
  const flushPendingInputQueueRef = useRef<null | ((sessionId: string) => void)>(null);
  const queueSessionTransportOpenIntentRef = useRef<QueueSessionTransportOpenIntent | null>(null);
  const queueReconnectTransportOpenIntentRef = useRef<null | ((sessionId: string, host: Host) => void)>(null);
  const queueConnectTransportOpenIntentRef = useRef<null | ((sessionId: string, host: Host, activate: boolean) => void)>(null);
  const applyTransportOpenConnectedEffectsRef = useRef<null | ((options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => void)>(null);
  const applyTransportOpenLiveFailureEffectsRef = useRef<null | ((options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    message: string;
    retryable: boolean;
  }) => void)>(null);
  const handleReconnectBeforeConnectSendRef = useRef<null | ((sessionId: string, sessionName: string) => void)>(null);
  const handleReconnectHandshakeFailureRef = useRef<null | ((options: {
    sessionId: string;
    message: string;
    retryable: boolean;
  }) => void)>(null);
  const startReconnectAttemptRef = useRef<null | ((sessionId: string) => void)>(null);
  const scheduleReconnectRef = useRef<null | ((sessionId: string, message: string, retryable?: boolean, options?: {
    immediate?: boolean;
    resetAttempt?: boolean;
    force?: boolean;
  }) => void)>(null);

  const applySessionAction = useCallback((action: SessionAction) => {
    stateRef.current = reduceSessionAction(stateRef.current, action);
    dispatch(action);
  }, []);

  const updateSessionSync = useCallback((id: string, updates: Partial<Session>) => {
    applySessionAction({
      type: 'UPDATE_SESSION',
      id,
      updates,
    });
  }, [applySessionAction]);

  const setActiveSessionSync = useCallback((id: string) => {
    applySessionAction({ type: 'SET_ACTIVE_SESSION', id });
  }, [applySessionAction]);

  const createSessionSync = useCallback((session: Session, activate: boolean) => {
    applySessionAction({ type: 'CREATE_SESSION', session, activate });
  }, [applySessionAction]);

  const deleteSessionSync = useCallback((id: string) => {
    applySessionAction({ type: 'DELETE_SESSION', id });
  }, [applySessionAction]);

  const moveSessionSync = useCallback((id: string, toIndex: number) => {
    applySessionAction({ type: 'MOVE_SESSION', id, toIndex });
  }, [applySessionAction]);

  const setSessionTitleSync = useCallback((id: string, title: string) => {
    applySessionAction({ type: 'SET_SESSION_TITLE', id, title });
  }, [applySessionAction]);

  const incrementConnectedSync = useCallback(() => {
    applySessionAction({ type: 'INCREMENT_CONNECTED' });
  }, [applySessionAction]);

  const readSessionTransportSocket = useCallback((sessionId: string) => {
    return getSessionTransportSocket(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const readSessionTransportHost = useCallback((sessionId: string) => {
    return getSessionTransportHost(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const readSessionTransportRuntime = useCallback((sessionId: string) => {
    return getSessionTransportRuntime(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const readSessionTargetRuntime = useCallback((sessionId: string) => {
    return getSessionTargetTransportRuntime(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const readSessionTargetKey = useCallback((sessionId: string) => {
    return getSessionTransportTargetKey(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const readSessionTransportToken = useCallback((sessionId: string) => {
    return getSessionTransportToken(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const readSessionTargetControlSocket = useCallback((sessionId: string) => {
    return getSessionTargetControlTransport(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const writeSessionTransportHost = useCallback((sessionId: string, host: Host) => {
    return upsertSessionTransportRuntime(transportRuntimeStoreRef.current, sessionId, host);
  }, []);

  const writeSessionTransportSocket = useCallback((sessionId: string, socket: BridgeTransportSocket | null) => {
    return setSessionTransportSocket(transportRuntimeStoreRef.current, sessionId, socket);
  }, []);

  const writeSessionTransportToken = useCallback((sessionId: string, token: string | null) => {
    return setSessionTransportToken(transportRuntimeStoreRef.current, sessionId, token);
  }, []);

  const writeSessionTargetControlSocket = useCallback((sessionId: string, socket: BridgeTransportSocket | null) => {
    return setSessionTargetControlTransport(transportRuntimeStoreRef.current, sessionId, socket);
  }, []);

  const moveSessionTransportSocketAside = useCallback((sessionId: string) => {
    return moveSessionTransportSocketToSuperseded(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const clearSessionTransportRuntime = useCallback((sessionId: string) => {
    return removeSessionTransportRuntime(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const drainSessionSupersededSockets = useCallback((sessionId: string) => {
    return clearSessionSupersededSockets(transportRuntimeStoreRef.current, sessionId);
  }, []);

  const isSessionTransportActive = useCallback((sessionId: string) => {
    return stateRef.current.activeSessionId === sessionId;
  }, []);

  const hasPendingSessionTransportOpen = useCallback((sessionId: string) => {
    return pendingSessionTransportOpenIntentsRef.current.has(sessionId);
  }, []);

  const clearRemoteScreenshotTimeout = useCallback((pending: PendingRemoteScreenshotRequest) => {
    if (pending.timeoutId !== null) {
      window.clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }
  }, []);

  const armRemoteScreenshotTimeout = useCallback((requestId: string) => {
    const pending = pendingRemoteScreenshotRequestsRef.current.get(requestId);
    if (!pending) {
      return;
    }
    if (pending.timeoutId !== null) {
      window.clearTimeout(pending.timeoutId);
    }
    pending.timeoutId = window.setTimeout(() => {
      const activePending = pendingRemoteScreenshotRequestsRef.current.get(requestId);
      if (!activePending) {
        return;
      }
      pendingRemoteScreenshotRequestsRef.current.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error(`Remote screenshot timed out during ${activePending.phase}`));
    }, REMOTE_SCREENSHOT_REQUEST_TIMEOUT_MS);
  }, []);

  const isReconnectInFlight = useCallback((sessionId: string) => {
    const reconnectRuntime = reconnectRuntimesRef.current.get(sessionId) || null;
    if (!reconnectRuntime) {
      return false;
    }
    return reconnectRuntime.connecting || reconnectRuntime.timer !== null;
  }, []);

  const resolveSessionCacheLines = useCallback((rows?: number | null) => {
    const viewportRows =
      typeof rows === 'number' && Number.isFinite(rows)
        ? Math.max(1, Math.floor(rows))
        : DEFAULT_TERMINAL_SESSION_VIEWPORT.rows;
    const threeScreenLines = resolveTerminalRequestWindowLines(viewportRows);
    if (!Number.isFinite(terminalCacheLines) || terminalCacheLines <= 0) {
      return threeScreenLines;
    }
    return Math.min(
      DEFAULT_TERMINAL_CACHE_LINES,
      Math.max(threeScreenLines, Math.floor(terminalCacheLines)),
    );
  }, [terminalCacheLines]);

  const estimateWireBytes = useCallback((data: string | ArrayBuffer) => {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data).byteLength;
    }
    return data.byteLength;
  }, []);

  const ensureSessionWireStats = useCallback((sessionId: string) => {
    const current = sessionWireStatsRef.current.get(sessionId);
    if (current) {
      return current;
    }
    const initial: SessionWireStatsSnapshot = {
      txBytes: 0,
      rxBytes: 0,
      renderCommits: 0,
      refreshRequests: 0,
    };
    sessionWireStatsRef.current.set(sessionId, initial);
    return initial;
  }, []);

  const recordSessionTx = useCallback((sessionId: string, data: string | ArrayBuffer, options?: {
    pullPurpose?: SessionPullPurpose;
    targetHeadRevision?: number;
    targetStartIndex?: number;
    targetEndIndex?: number;
    requestKnownRevision?: number;
    requestLocalStartIndex?: number;
    requestLocalEndIndex?: number;
  }) => {
    const current = ensureSessionWireStats(sessionId);
    current.txBytes += estimateWireBytes(data);
    if (options?.pullPurpose) {
      current.refreshRequests += 1;
      const nextPullStates = {
        ...(sessionPullStateRef.current.get(sessionId) || {}),
        [options.pullPurpose]: {
          purpose: options.pullPurpose,
          startedAt: Date.now(),
          targetHeadRevision: Math.max(0, Math.floor(options.targetHeadRevision || 0)),
          targetStartIndex: Math.max(0, Math.floor(options.targetStartIndex || 0)),
          targetEndIndex: Math.max(0, Math.floor(options.targetEndIndex || 0)),
          requestKnownRevision: Math.max(0, Math.floor(options.requestKnownRevision || 0)),
          requestLocalStartIndex: Math.max(0, Math.floor(options.requestLocalStartIndex || 0)),
          requestLocalEndIndex: Math.max(0, Math.floor(options.requestLocalEndIndex || 0)),
        },
      } satisfies SessionPullStates;
      sessionPullStateRef.current.set(sessionId, nextPullStates);
    }
  }, [ensureSessionWireStats, estimateWireBytes]);

  const recordSessionRx = useCallback((sessionId: string, data: string | ArrayBuffer) => {
    const current = ensureSessionWireStats(sessionId);
    current.rxBytes += estimateWireBytes(data);
    lastServerActivityAtRef.current.set(sessionId, Date.now());
    staleTransportProbeAtRef.current.delete(sessionId);
  }, [ensureSessionWireStats, estimateWireBytes]);

  const recordSessionRenderCommit = useCallback((sessionId: string) => {
    const current = ensureSessionWireStats(sessionId);
    current.renderCommits += 1;
  }, [ensureSessionWireStats]);

  const markPendingInputTailRefresh = useCallback((sessionId: string, localRevision: number) => {
    pendingInputTailRefreshRef.current.set(sessionId, {
      requestedAt: Date.now(),
      localRevision: Math.max(0, Math.floor(localRevision || 0)),
    });
  }, []);

  const clearSessionPullState = useCallback((sessionId: string, purpose?: SessionPullPurpose) => {
    if (!purpose) {
      sessionPullStateRef.current.delete(sessionId);
      return;
    }
    const nextPullStates = clearSessionPullStateEntry(
      sessionPullStateRef.current.get(sessionId) || null,
      purpose,
    );
    if (!nextPullStates) {
      sessionPullStateRef.current.delete(sessionId);
      return;
    }
    sessionPullStateRef.current.set(sessionId, nextPullStates);
  }, []);

  const settleSessionPullState = useCallback((sessionId: string, payload: TerminalBufferPayload) => {
    const nextPullStates = settleSessionPullStatesWithBufferSync(
      sessionPullStateRef.current.get(sessionId) || null,
      payload,
    );
    if (!nextPullStates) {
      sessionPullStateRef.current.delete(sessionId);
      return;
    }
    sessionPullStateRef.current.set(sessionId, nextPullStates);
  }, []);

  const resetSessionTransportPullBookkeeping = useCallback((sessionId: string, reason: string) => {
    const pullStates = sessionPullStateRef.current.get(sessionId) || null;
    if (!pullStates || !hasActiveSessionPullState(pullStates)) {
      return;
    }
    runtimeDebug('session.buffer.pull.reset', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      reason,
      pullStates,
    });
    clearSessionPullState(sessionId);
  }, [clearSessionPullState]);

  const isSessionTransportActivityStale = useCallback((sessionId: string) => {
    const lastServerActivityAt = lastServerActivityAtRef.current.get(sessionId) || 0;
    if (lastServerActivityAt <= 0) {
      return false;
    }
    return Date.now() - lastServerActivityAt > ACTIVE_TRANSPORT_STALE_ACTIVITY_MS;
  }, []);

  const sendSocketPayload = useCallback((sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, options?: {
    pullPurpose?: SessionPullPurpose;
    targetHeadRevision?: number;
    targetStartIndex?: number;
    targetEndIndex?: number;
    requestKnownRevision?: number;
    requestLocalStartIndex?: number;
    requestLocalEndIndex?: number;
  }) => {
    recordSessionTx(sessionId, data, options);
    ws.send(data);
  }, [recordSessionTx]);

  const buildTraversalSocketForHost = useCallback((host: Host, transportRole: 'control' | 'session' = 'session') => {
    const traversal = resolveTraversalConfigFromHost(host, bridgeSettings);
    const overrideUrl = (() => {
      if (!wsUrl) {
        return undefined;
      }
      try {
        const parsed = new URL(wsUrl);
        parsed.searchParams.set('ztermTransport', transportRole);
        return parsed.toString();
      } catch {
        return wsUrl;
      }
    })();
    return new TraversalSocket(traversal.target, traversal.settings, { overrideUrl });
  }, [bridgeSettings, wsUrl]);

  const applyTransportDiagnostics = useCallback((sessionId: string, socket: BridgeTransportSocket) => {
    const diagnostics = socket.getDiagnostics();
    updateSessionSync(sessionId, {
      resolvedPath: diagnostics.resolvedPath,
      resolvedEndpoint: diagnostics.resolvedEndpoint,
      lastConnectStage: diagnostics.stage,
      lastError: diagnostics.reason || undefined,
    });
  }, [updateSessionSync]);

  const flushRuntimeDebugLogs = useCallback(() => {
    if (!isRuntimeDebugEnabled() || getPendingRuntimeDebugEntryCount() === 0) {
      return;
    }

    const activeWs = stateRef.current.activeSessionId
      ? readSessionTransportSocket(stateRef.current.activeSessionId) || null
      : null;
    const targetWs = activeWs && activeWs.readyState === WebSocket.OPEN ? activeWs : null;
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    const entries = drainRuntimeDebugEntries();
    if (entries.length === 0) {
      return;
    }

    const frame = JSON.stringify({
      type: 'debug-log',
      payload: { entries },
    } satisfies ClientMessage);
    sendSocketPayload(stateRef.current.activeSessionId || 'debug-log', targetWs, frame);
  }, [sendSocketPayload]);

  useEffect(() => {
    foregroundActiveRef.current = appForegroundActive !== false;
  }, [appForegroundActive]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    scheduleStatesRef.current = scheduleStates;
  }, [scheduleStates]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const nextMetrics: Record<string, SessionDebugOverlayMetrics | undefined> = {};

      for (const session of stateRef.current.sessions) {
        const current = sessionWireStatsRef.current.get(session.id) || {
          txBytes: 0,
          rxBytes: 0,
          renderCommits: 0,
          refreshRequests: 0,
        };
        const previous = sessionWireStatsPreviousRef.current.get(session.id);
        const deltaMs = previous ? Math.max(250, now - previous.at) : 1000;
        const deltaSeconds = deltaMs / 1000;
        const txBytesDelta = current.txBytes - (previous?.sample.txBytes || 0);
        const rxBytesDelta = current.rxBytes - (previous?.sample.rxBytes || 0);
        const renderDelta = current.renderCommits - (previous?.sample.renderCommits || 0);
        const pullDelta = current.refreshRequests - (previous?.sample.refreshRequests || 0);
        const pullStates = sessionPullStateRef.current.get(session.id) || null;
        const pullState = getPrimarySessionPullState(pullStates);
        const status: SessionDebugOverlayMetrics['status'] =
          session.state === 'error' ? 'error'
          : session.state === 'closed' ? 'closed'
          : session.state === 'reconnecting' ? 'reconnecting'
          : session.state === 'connecting' ? 'connecting'
          : pullState?.purpose === 'reading-repair' ? 'loading'
          : pullState ? 'refreshing'
          : 'waiting';

        nextMetrics[session.id] = {
          uplinkBps: Math.max(0, Math.round(txBytesDelta / deltaSeconds)),
          downlinkBps: Math.max(0, Math.round(rxBytesDelta / deltaSeconds)),
          renderHz: Math.max(0, Number((renderDelta / deltaSeconds).toFixed(1))),
          pullHz: Math.max(0, Number((pullDelta / deltaSeconds).toFixed(1))),
          bufferPullActive: hasActiveSessionPullState(pullStates),
          status,
          active: stateRef.current.activeSessionId === session.id,
          updatedAt: now,
        };

        sessionWireStatsPreviousRef.current.set(session.id, {
          sample: { ...current },
          at: now,
        });
      }

      const current = sessionDebugMetricsRef.current;
      if (!sessionDebugMetricsEqual(current, nextMetrics)) {
        sessionDebugMetricsRef.current = nextMetrics;
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, []);

  const setScheduleStateForSession = useCallback((
    sessionId: string,
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => {
    setScheduleStates((current) => {
      const emptyScheduleState = buildEmptyScheduleState(
        stateRef.current.sessions.find((session) => session.id === sessionId)?.sessionName || '',
      );
      const resolvedCurrent = current[sessionId] || emptyScheduleState;
      const resolved = typeof nextState === 'function' ? nextState(resolvedCurrent) : nextState;
      return {
        ...current,
        [sessionId]: resolved,
      };
    });
  }, []);

  const clearHeartbeat = useCallback((sessionId: string) => {
    const heartbeat = pingIntervals.current.get(sessionId);
    if (heartbeat) {
      clearInterval(heartbeat);
      pingIntervals.current.delete(sessionId);
    }
    lastPongAtRef.current.delete(sessionId);
    lastServerActivityAtRef.current.delete(sessionId);
  }, []);

  const clearSessionHandshakeTimeout = useCallback((sessionId: string) => {
    const timerId = handshakeTimeoutsRef.current.get(sessionId);
    if (typeof timerId === 'number') {
      window.clearTimeout(timerId);
      handshakeTimeoutsRef.current.delete(sessionId);
    }
  }, []);

  const setSessionHandshakeTimeout = useCallback((sessionId: string, callback: () => void, delayMs: number) => {
    clearSessionHandshakeTimeout(sessionId);
    const timerId = window.setTimeout(() => {
      handshakeTimeoutsRef.current.delete(sessionId);
      callback();
    }, delayMs);
    handshakeTimeoutsRef.current.set(sessionId, timerId);
    return timerId;
  }, [clearSessionHandshakeTimeout]);

  const clearTailRefreshRuntime = useCallback((sessionId: string) => {
    sessionBufferHeadsRef.current.delete(sessionId);
    sessionRevisionResetRef.current.delete(sessionId);
    lastHeadRequestAtRef.current.delete(sessionId);
  }, []);

  const startSocketHeartbeat = useCallback((
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
  ) => {
    const pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const lastPongAt = lastPongAtRef.current.get(sessionId) || 0;
      if (Date.now() - lastPongAt > CLIENT_PONG_TIMEOUT_MS) {
        finalizeFailure('heartbeat timeout', true);
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
        return;
      }

      sendSocketPayload(sessionId, ws, JSON.stringify({ type: 'ping' }));
    }, CLIENT_PING_INTERVAL_MS);
    pingIntervals.current.set(sessionId, pingInterval);
  }, [sendSocketPayload]);

  const cleanupControlSocket = useCallback((sessionId: string, shouldClose = false) => {
    const controlSocket = readSessionTargetControlSocket(sessionId);
    if (!controlSocket) {
      return;
    }
    controlSocket.onopen = null;
    controlSocket.onmessage = null;
    controlSocket.onerror = null;
    controlSocket.onclose = null;
    if (shouldClose && controlSocket.readyState < WebSocket.CLOSING) {
      controlSocket.close();
    }
    writeSessionTargetControlSocket(sessionId, null);
  }, [readSessionTargetControlSocket, writeSessionTargetControlSocket]);

  const openSessionTransportByIntentRef = useRef<null | ((intent: PendingSessionTransportOpenIntent) => void)>(null);

  const handleControlTransportMessage = useCallback((options: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
  }, msg: ServerMessage) => {
    switch (msg.type) {
      case 'session-ticket': {
        const payload = msg.payload;
        const intent = pendingSessionTransportOpenIntentsRef.current.get(payload.clientSessionId) || null;
        if (!intent) {
          return;
        }
        if (payload.clientSessionId !== intent.sessionId) {
          return;
        }
        clearSessionHandshakeTimeout(payload.clientSessionId);
        writeSessionTransportToken(payload.clientSessionId, payload.sessionTransportToken);
        pendingSessionTransportOpenIntentsRef.current.delete(payload.clientSessionId);
        openSessionTransportByIntentRef.current?.(intent);
        return;
      }
      case 'session-open-failed': {
        const payload = msg.payload;
        const intent = pendingSessionTransportOpenIntentsRef.current.get(payload.clientSessionId) || null;
        if (!intent) {
          return;
        }
        clearSessionHandshakeTimeout(payload.clientSessionId);
        pendingSessionTransportOpenIntentsRef.current.delete(payload.clientSessionId);
        writeSessionTransportToken(payload.clientSessionId, null);
        intent.finalizeFailure(payload.message, false);
        return;
      }
      case 'error': {
        const intent = pendingSessionTransportOpenIntentsRef.current.get(options.sessionId) || null;
        if (intent) {
          clearSessionHandshakeTimeout(options.sessionId);
          pendingSessionTransportOpenIntentsRef.current.delete(options.sessionId);
          writeSessionTransportToken(options.sessionId, null);
          intent.finalizeFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
        }
        return;
      }
      case 'pong':
        return;
      default:
        return;
    }
  }, [clearSessionHandshakeTimeout, writeSessionTransportToken]);

  const failPendingControlTargetIntents = useCallback((sessionId: string, message: string, retryable: boolean) => {
    const targetRuntime = readSessionTargetRuntime(sessionId);
    const targetSessionIds = targetRuntime?.sessionIds || [sessionId];
    for (const targetSessionId of targetSessionIds) {
      const pending = pendingSessionTransportOpenIntentsRef.current.get(targetSessionId) || null;
      if (!pending) {
        continue;
      }
      clearSessionHandshakeTimeout(targetSessionId);
      pendingSessionTransportOpenIntentsRef.current.delete(targetSessionId);
      writeSessionTransportToken(targetSessionId, null);
      pending.finalizeFailure(message, retryable);
    }
  }, [clearSessionHandshakeTimeout, readSessionTargetRuntime, writeSessionTransportToken]);

  const ensureControlTransportForSessionOpen = useCallback((intent: PendingSessionTransportOpenIntent) => {
    const { sessionId, host } = intent;
    const existingControlSocket = readSessionTargetControlSocket(sessionId);
    const flushPendingSessionOpens = (anchorSessionId: string, socket: BridgeTransportSocket) => {
      const targetRuntime = readSessionTargetRuntime(anchorSessionId);
      const targetSessionIds = targetRuntime?.sessionIds || [anchorSessionId];
      for (const targetSessionId of targetSessionIds) {
        const pendingIntent = pendingSessionTransportOpenIntentsRef.current.get(targetSessionId) || null;
        if (!pendingIntent) {
          continue;
        }
        const pendingSessionName = getResolvedSessionName(pendingIntent.host);
        sendSocketPayload(targetSessionId, socket, JSON.stringify({
          type: 'session-open',
          payload: buildHostConfigMessage(
            pendingIntent.host,
            pendingSessionName,
            targetSessionId,
            bridgeSettings.terminalWidthMode,
          ),
        } satisfies ClientMessage));
        runtimeDebug('session.control.session-open-sent', {
          sessionId: targetSessionId,
          targetKey: readSessionTargetKey(targetSessionId),
          sessionName: pendingSessionName,
        });
        clearSessionHandshakeTimeout(targetSessionId);
        setSessionHandshakeTimeout(targetSessionId, () => {
          failPendingControlTargetIntents(targetSessionId, 'session open timeout', true);
        }, SESSION_HANDSHAKE_TIMEOUT_MS);
      }
    };

    if (existingControlSocket && existingControlSocket.readyState === WebSocket.OPEN) {
      flushPendingSessionOpens(sessionId, existingControlSocket);
      return;
    }

    if (existingControlSocket && existingControlSocket.readyState === WebSocket.CONNECTING) {
      return;
    }

    const controlSocket = buildTraversalSocketForHost(host, 'control');
    writeSessionTargetControlSocket(sessionId, controlSocket);
    runtimeDebug('session.control.opening', {
      sessionId,
      targetKey: readSessionTargetKey(sessionId),
      host: host.bridgeHost,
      port: host.bridgePort,
      sessionName: getResolvedSessionName(host),
    });
    controlSocket.onopen = () => {
      applyTransportDiagnostics(sessionId, controlSocket);
      runtimeDebug('session.control.open', {
        sessionId,
        targetKey: readSessionTargetKey(sessionId),
      });
      flushPendingSessionOpens(sessionId, controlSocket);
    };
    controlSocket.onmessage = (event) => {
      try {
        recordSessionRx(sessionId, event.data);
        if (typeof event.data !== 'string') {
          return;
        }
        const msg = JSON.parse(event.data) as ServerMessage;
        handleControlTransportMessage({
          sessionId,
          host,
          ws: controlSocket,
        }, msg);
      } catch (error) {
        failPendingControlTargetIntents(sessionId, error instanceof Error ? error.message : 'control transport parse error', true);
      }
    };
    controlSocket.onerror = () => {
      cleanupControlSocket(sessionId);
      failPendingControlTargetIntents(sessionId, controlSocket.getDiagnostics().reason || 'control transport error', true);
    };
    controlSocket.onclose = () => {
      cleanupControlSocket(sessionId);
      failPendingControlTargetIntents(sessionId, controlSocket.getDiagnostics().reason || 'control transport closed', true);
    };
  }, [
    applyTransportDiagnostics,
    bridgeSettings.terminalWidthMode,
    buildTraversalSocketForHost,
    clearSessionHandshakeTimeout,
    cleanupControlSocket,
    failPendingControlTargetIntents,
    handleControlTransportMessage,
    readSessionTargetControlSocket,
    readSessionTargetRuntime,
    readSessionTargetKey,
    sendSocketPayload,
    setSessionHandshakeTimeout,
    writeSessionTargetControlSocket,
  ]);

  function openSocketConnectHandshake(options: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    activate?: boolean;
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
  }) {
    const sessionName = getResolvedSessionName(options.host);
    runtimeDebug(`session.ws.${options.debugScope}.onopen`, {
      sessionId: options.sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      ...(options.debugScope === 'connect'
        ? { activate: Boolean(options.activate) }
        : { targetSessionName: sessionName }),
    });
    options.onBeforeConnectSend?.({ sessionName });
    const sessionTransportToken = readSessionTransportToken(options.sessionId);
    sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
      type: 'connect',
      payload: buildHostConfigMessage(
        options.host,
        sessionName,
        options.sessionId,
        bridgeSettings.terminalWidthMode,
        sessionTransportToken,
      ),
    }));
    runtimeDebug(`session.ws.${options.debugScope}.connect-sent`, {
      sessionId: options.sessionId,
      tmuxViewportFromUiShell: false,
    });
    flushRuntimeDebugLogs();
    startSocketHeartbeat(options.sessionId, options.ws, options.finalizeFailure);
  }

  const primeSessionTransportSocket = useCallback((sessionId: string, ws: BridgeTransportSocket) => {
    writeSessionTransportSocket(sessionId, ws);
    updateSessionSync(sessionId, { ws: null });
    lastPongAtRef.current.set(sessionId, Date.now());
  }, [updateSessionSync, writeSessionTransportSocket]);

  const bindSessionTransportSocketLifecycle = useCallback((options: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    activate?: boolean;
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
    onConnected: () => void;
  }) => {
    const { sessionId, host, ws, debugScope, activate, finalizeFailure, onBeforeConnectSend, onConnected } = options;

    ws.onopen = () => {
      applyTransportDiagnostics(sessionId, ws);
      openSocketConnectHandshake({
        sessionId,
        host,
        ws,
        debugScope,
        activate,
        finalizeFailure,
        onBeforeConnectSend,
      });
      clearSessionHandshakeTimeout(sessionId);
      setSessionHandshakeTimeout(sessionId, () => {
        finalizeFailure('session handshake timeout', true);
      }, SESSION_HANDSHAKE_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      try {
        recordSessionRx(sessionId, event.data);
        if (typeof event.data !== 'string') {
          return;
        }
        const msg: ServerMessage = JSON.parse(event.data);
        handleSocketServerMessage({
          sessionId,
          host,
          ws,
          debugScope,
          onConnected,
          onFailure: finalizeFailure,
        }, msg);
      } catch (error) {
        finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
      }
    };

    ws.onerror = () => finalizeFailure(ws.getDiagnostics().reason || 'transport error', true);
    ws.onclose = () => finalizeFailure(ws.getDiagnostics().reason || 'socket closed', true);
  }, [
    applyTransportDiagnostics,
    clearSessionHandshakeTimeout,
    recordSessionRx,
    setSessionHandshakeTimeout,
  ]);

  const requestSessionBufferSync = useCallback((sessionId: string, options?: {
    ws?: BridgeTransportSocket | null;
    reason?: string;
    purpose?: SessionPullPurpose;
    sessionOverride?: Session | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
  }) => {
    const session = options?.sessionOverride || stateRef.current.sessions.find((item) => item.id === sessionId);
    const targetWs = options?.ws || readSessionTransportSocket(sessionId);
    if (!session || !targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return false;
    }

    const visibleRange = sessionVisibleRangeRef.current.get(sessionId);
    const requestPurpose = options?.purpose || 'tail-refresh';
    const liveHead = sessionBufferHeadsRef.current.get(sessionId) || null;
    const effectiveSession = liveHead
      ? {
          ...session,
          daemonHeadRevision: liveHead.revision,
          daemonHeadEndIndex: liveHead.latestEndIndex,
        }
      : session;
    const payload = buildSessionBufferSyncRequestPayload(
      effectiveSession,
      visibleRange,
      {
        purpose: options?.purpose,
        forceSameEndRefresh:
          pendingInputTailRefreshRef.current.has(sessionId)
          || pendingConnectTailRefreshRef.current.has(sessionId)
          || pendingResumeTailRefreshRef.current.has(sessionId),
        liveHead: options?.liveHead || liveHead || null,
        invalidLocalWindow: Boolean(options?.invalidLocalWindow),
      },
    );
    const inFlightPull = (sessionPullStateRef.current.get(sessionId) || null)?.[requestPurpose] || null;
    if (inFlightPull) {
      if (
        requestPurpose === 'tail-refresh'
        && doesSessionPullStateMatchExactLocalSnapshot(inFlightPull, payload)
      ) {
        return false;
      }
      if (
        requestPurpose === 'reading-repair'
        && doesSessionPullStateMatchExactLocalSnapshot(inFlightPull, payload)
      ) {
        return false;
      }
      const targetHeadRevision = Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0));
      if (
        doesSessionPullStateCoverRequest(inFlightPull, payload)
        || doesSessionPullStateMatchExactLocalSnapshot(inFlightPull, payload)
      ) {
        return false;
      }
      runtimeDebug('session.buffer.pull.superseded', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        reason: options?.reason || null,
        purpose: requestPurpose,
        previous: inFlightPull,
        next: {
          targetHeadRevision,
          requestStartIndex: payload.requestStartIndex,
          requestEndIndex: payload.requestEndIndex,
        },
      });
      clearSessionPullState(sessionId, requestPurpose);
    }

    runtimeDebug('session.buffer.request', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
        reason: options?.reason || null,
        purpose: requestPurpose,
        payload,
      });
    const requestTargetStartIndex = Math.max(0, Math.floor(payload.requestStartIndex || 0));
    const requestTargetEndIndex = Math.max(requestTargetStartIndex, Math.floor(
      requestPurpose === 'reading-repair'
        ? (payload.requestEndIndex || 0)
        : (
          effectiveSession.daemonHeadEndIndex
          || payload.requestEndIndex
          || effectiveSession.buffer.bufferTailEndIndex
          || effectiveSession.buffer.endIndex
          || 0
        ),
    ));
    sendSocketPayload(sessionId, targetWs, JSON.stringify({
      type: 'buffer-sync-request',
      payload,
    } satisfies ClientMessage), {
      pullPurpose: requestPurpose,
      targetHeadRevision: Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)),
      targetStartIndex: requestTargetStartIndex,
      targetEndIndex: requestTargetEndIndex,
      requestKnownRevision: Math.max(0, Math.floor(payload.knownRevision || 0)),
      requestLocalStartIndex: Math.max(0, Math.floor(payload.localStartIndex || 0)),
      requestLocalEndIndex: Math.max(0, Math.floor(payload.localEndIndex || 0)),
    });
    return true;
  }, [clearSessionPullState, sendSocketPayload]);

  const requestSessionBufferHead = useCallback((sessionId: string, ws?: BridgeTransportSocket | null, options?: {
    force?: boolean;
  }) => {
    const targetWs = ws || readSessionTransportSocket(sessionId) || null;
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    if (
      !session
      || (session.state !== 'connected' && session.state !== 'connecting' && session.state !== 'reconnecting')
      || !targetWs
      || targetWs.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    const cadence = resolveTerminalRefreshCadence();
    const now = Date.now();
    const lastRequestedAt = lastHeadRequestAtRef.current.get(sessionId) || 0;
    const minHeadGapMs = cadence.headTickMs;
    if (!options?.force && now - lastRequestedAt < minHeadGapMs) {
      return false;
    }
    lastHeadRequestAtRef.current.set(sessionId, now);
    const current = ensureSessionWireStats(sessionId);
    current.refreshRequests += 1;
    sendSocketPayload(sessionId, targetWs, JSON.stringify({ type: 'buffer-head-request' } satisfies ClientMessage));
    return true;
  }, [ensureSessionWireStats, sendSocketPayload]);

  const applyIncomingBufferSync = useCallback((sessionId: string, payload: TerminalBufferPayload) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    const revisionResetExpectation = sessionRevisionResetRef.current.get(sessionId) || null;
    const lowerRevisionPayload = revisionResetExpectation
      && Math.max(0, Math.floor(payload.revision || 0)) <= Math.max(0, Math.floor(session.buffer.revision || 0))
      ? payload
      : null;

    let nextBuffer = (
      revisionResetExpectation && lowerRevisionPayload
        ? createSessionBufferState({
            lines: [],
            startIndex: 0,
            endIndex: 0,
            bufferTailEndIndex: 0,
            cols: lowerRevisionPayload.cols,
            rows: lowerRevisionPayload.rows,
            cursorKeysApp: lowerRevisionPayload.cursorKeysApp,
            cursor: lowerRevisionPayload.cursor,
            revision: 0,
            cacheLines: resolveSessionCacheLines(lowerRevisionPayload.rows || session.buffer.rows),
          })
        : session.buffer
    );

    if (revisionResetExpectation && lowerRevisionPayload) {
      runtimeDebug('session.buffer.revision-reset.apply', {
        sessionId,
        expectation: revisionResetExpectation,
        localRevision: session.buffer.revision,
        incomingRevision: lowerRevisionPayload.revision,
        incomingStartIndex: lowerRevisionPayload.startIndex,
        incomingEndIndex: lowerRevisionPayload.endIndex,
      });
    }

    nextBuffer = applyBufferSyncToSessionBuffer(
      nextBuffer,
      payload,
      resolveSessionCacheLines(payload.rows || nextBuffer.rows),
    );

    if (
      revisionResetExpectation
      && nextBuffer.revision >= 0
    ) {
      sessionRevisionResetRef.current.delete(sessionId);
    }

    const liveHead = sessionBufferHeadsRef.current.get(sessionId) || null;
    const inputTailRefresh = pendingInputTailRefreshRef.current.get(sessionId) || null;
    if (
      inputTailRefresh
      && (
        nextBuffer.revision > Math.max(0, Math.floor(inputTailRefresh.localRevision || 0))
        && (!liveHead || nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
      )
    ) {
      pendingInputTailRefreshRef.current.delete(sessionId);
    }
    if (
      pendingConnectTailRefreshRef.current.has(sessionId)
      && (
        nextBuffer.endIndex !== session.buffer.endIndex
        || nextBuffer.revision > Math.max(0, Math.floor(session.buffer.revision || 0))
        || (liveHead && nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
      )
    ) {
      pendingConnectTailRefreshRef.current.delete(sessionId);
    }
    if (
      pendingResumeTailRefreshRef.current.has(sessionId)
      && (
        nextBuffer.endIndex !== session.buffer.endIndex
        || nextBuffer.revision > Math.max(0, Math.floor(session.buffer.revision || 0))
        || (liveHead && nextBuffer.revision >= Math.max(0, Math.floor(liveHead.revision || 0)))
      )
    ) {
      pendingResumeTailRefreshRef.current.delete(sessionId);
    }

    if (sessionBuffersEqual(session.buffer, nextBuffer)) {
      runtimeDebug('session.buffer.apply.noop', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        incoming: summarizeBufferPayload(payload),
        localRevision: session.buffer.revision,
        localStartIndex: session.buffer.startIndex,
        localEndIndex: session.buffer.endIndex,
      });
      return;
    }

    stateRef.current = reduceSessionAction(stateRef.current, {
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: { buffer: nextBuffer },
    });
    dispatch({
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: { buffer: nextBuffer },
    });
    runtimeDebug('session.buffer.applied', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      previousRevision: session.buffer.revision,
      previousStartIndex: session.buffer.startIndex,
      previousEndIndex: session.buffer.endIndex,
      nextRevision: nextBuffer.revision,
      nextStartIndex: nextBuffer.startIndex,
      nextEndIndex: nextBuffer.endIndex,
      nextHeadStartIndex: nextBuffer.bufferHeadStartIndex,
      nextTailEndIndex: nextBuffer.bufferTailEndIndex,
      updateKind: nextBuffer.updateKind,
      gapRangeCount: nextBuffer.gapRanges.length,
      lineCount: nextBuffer.lines.length,
    });
    recordSessionRenderCommit(sessionId);

    if (!isSessionTransportActive(sessionId)) {
      return;
    }

    const nextSession: Session = {
      ...session,
      buffer: nextBuffer,
      daemonHeadRevision: liveHead?.revision ?? session.daemonHeadRevision,
      daemonHeadEndIndex: liveHead?.latestEndIndex ?? session.daemonHeadEndIndex,
    };
    const visibleRange = sessionVisibleRangeRef.current.get(sessionId) || buildDefaultSessionVisibleRange(nextSession);

    if (shouldCatchUpFollowTailAfterBufferApply(nextSession, visibleRange, {
      forceSameEndRefresh:
        pendingInputTailRefreshRef.current.has(sessionId)
        || pendingConnectTailRefreshRef.current.has(sessionId)
        || pendingResumeTailRefreshRef.current.has(sessionId),
    })) {
      requestSessionBufferSync(sessionId, {
        reason: 'buffer-sync-catchup',
        purpose: 'tail-refresh',
        sessionOverride: nextSession,
      });
      return;
    }

    if (!shouldPullVisibleRangeBuffer(nextSession, visibleRange, liveHead)) {
      return;
    }

    requestSessionBufferSync(sessionId, {
      reason: 'buffer-sync-visible-range-repair-catchup',
      purpose: 'reading-repair',
      sessionOverride: nextSession,
    });
  }, [
    isSessionTransportActive,
    recordSessionRenderCommit,
    requestSessionBufferSync,
    resolveSessionCacheLines,
  ]);

  const clearReconnectForSession = useCallback((sessionId: string) => {
    const reconnectRuntime = reconnectRuntimesRef.current.get(sessionId);
    if (!reconnectRuntime) {
      return;
    }
    if (reconnectRuntime.timer) {
      clearTimeout(reconnectRuntime.timer);
    }
    reconnectRuntimesRef.current.delete(sessionId);
  }, []);

  const clearSupersededSockets = useCallback((sessionId: string, shouldClose = true) => {
    const superseded = drainSessionSupersededSockets(sessionId);
    if (superseded.length === 0) {
      return;
    }
    if (shouldClose) {
      for (const ws of superseded) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState < WebSocket.CLOSING) {
          ws.close();
        }
      }
    }
  }, []);

  const cleanupSocket = useCallback((sessionId: string, shouldClose = false) => {
    const ws = readSessionTransportSocket(sessionId);
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (shouldClose && ws.readyState < WebSocket.CLOSING) {
        ws.close();
      } else if (!shouldClose) {
        moveSessionTransportSocketAside(sessionId);
      }
      writeSessionTransportSocket(sessionId, null);
    }

    if (shouldClose) {
      clearSupersededSockets(sessionId, true);
    }

    clearHeartbeat(sessionId);
    clearSessionHandshakeTimeout(sessionId);
    clearTailRefreshRuntime(sessionId);
    clearSessionPullState(sessionId);
    staleTransportProbeAtRef.current.delete(sessionId);
  }, [clearHeartbeat, clearSessionHandshakeTimeout, clearSessionPullState, clearSupersededSockets, clearTailRefreshRuntime, moveSessionTransportSocketAside, readSessionTransportSocket, writeSessionTransportSocket]);

  const openSessionTransportByIntent = useCallback((intent: PendingSessionTransportOpenIntent) => {
    const { sessionId, host, debugScope, activate, finalizeFailure, onBeforeConnectSend, onConnected } = intent;
    const sessionTransportToken = readSessionTransportToken(sessionId);
    if (!sessionTransportToken) {
      finalizeFailure('missing session transport token', true);
      return;
    }

    cleanupSocket(sessionId, false);
    const ws = buildTraversalSocketForHost(host, 'session');
    runtimeDebug(`session.ws.${debugScope}.opening`, {
      sessionId,
      host: host.bridgeHost,
      port: host.bridgePort,
      sessionName: getResolvedSessionName(host),
      activate: Boolean(activate),
    });
    primeSessionTransportSocket(sessionId, ws);

    bindSessionTransportSocketLifecycle({
      sessionId,
      host,
      ws,
      debugScope,
      activate,
      finalizeFailure,
      onBeforeConnectSend,
      onConnected: () => {
        writeSessionTransportToken(sessionId, null);
        onConnected(ws);
      },
    });
  }, [
    bindSessionTransportSocketLifecycle,
    buildTraversalSocketForHost,
    cleanupSocket,
    primeSessionTransportSocket,
    readSessionTransportToken,
    writeSessionTransportToken,
  ]);
  openSessionTransportByIntentRef.current = openSessionTransportByIntent;

  const startReconnectAttempt = useCallback((sessionId: string) => {
    if (manualCloseRef.current.has(sessionId)) {
      reconnectRuntimesRef.current.delete(sessionId);
      return;
    }
    const reconnectRuntime = reconnectRuntimesRef.current.get(sessionId);
    const targetHost = readSessionTransportHost(sessionId);
    if (!reconnectRuntime || !targetHost) {
      reconnectRuntimesRef.current.delete(sessionId);
      return;
    }
    if (reconnectRuntime.timer || reconnectRuntime.connecting) {
      return;
    }

    const delay = reconnectRuntime.nextDelayMs ?? computeReconnectDelay(reconnectRuntime.attempt);
    reconnectRuntime.nextDelayMs = null;
    reconnectRuntime.timer = window.setTimeout(() => {
      if (manualCloseRef.current.has(sessionId)) {
        reconnectRuntimesRef.current.delete(sessionId);
        return;
      }
      const liveRuntime = reconnectRuntimesRef.current.get(sessionId);
      if (!liveRuntime) {
        return;
      }
      liveRuntime.timer = null;
      liveRuntime.connecting = true;

      const liveHost = readSessionTransportHost(sessionId);
      if (!liveHost) {
        liveRuntime.connecting = false;
        reconnectRuntimesRef.current.delete(sessionId);
        return;
      }

      updateSessionSync(sessionId, buildSessionReconnectAttemptProgressUpdates(liveRuntime.attempt + 1));
      writeSessionTransportToken(sessionId, null);
      queueReconnectTransportOpenIntentRef.current?.(sessionId, liveHost);
    }, delay);
  }, [
    updateSessionSync,
    writeSessionTransportToken,
  ]);
  startReconnectAttemptRef.current = startReconnectAttempt;

  const scheduleReconnect = useCallback((
    sessionId: string,
    message: string,
    retryable = true,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => {
    if (manualCloseRef.current.has(sessionId)) {
      reconnectRuntimesRef.current.delete(sessionId);
      return;
    }
    if (!readSessionTransportHost(sessionId)) {
      return;
    }

    if (!retryable) {
      reconnectRuntimesRef.current.delete(sessionId);
      updateSessionSync(sessionId, buildSessionErrorUpdates(message, { includeWsNull: true }));
      emitSessionStatus(sessionId, 'error', message);
      return;
    }

    if (!shouldAutoReconnectSession({
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      force: options?.force,
    })) {
      reconnectRuntimesRef.current.delete(sessionId);
      updateSessionSync(sessionId, buildSessionIdleAfterReconnectBlockedUpdates(message));
      emitSessionStatus(sessionId, 'error', message);
      return;
    }

    const reconnectRuntime = reconnectRuntimesRef.current.get(sessionId) || createSessionReconnectRuntime();
    if (options?.resetAttempt) {
      reconnectRuntime.attempt = 0;
    }
    if (options?.immediate) {
      reconnectRuntime.nextDelayMs = 0;
    }
    reconnectRuntimesRef.current.set(sessionId, reconnectRuntime);

    updateSessionSync(sessionId, buildSessionReconnectingFailureUpdates(
      message,
      reconnectRuntime.attempt,
    ));
    emitSessionStatus(sessionId, 'error', message);
    startReconnectAttemptRef.current?.(sessionId);
  }, [readSessionTransportHost, updateSessionSync]);
  scheduleReconnectRef.current = scheduleReconnect;

  const queueSessionTransportOpenIntent = useCallback((options: QueueSessionTransportOpenIntentOptions) => {
    const pendingIntent = createPendingSessionTransportOpenIntent({
      ...options,
      resolvedSessionName: getResolvedSessionName(options.host),
      clearHandshakeTimeout: () => clearSessionHandshakeTimeout(options.sessionId),
      finalizeSocketFailureBaseline: (baselineOptions) => (
        finalizeSocketFailureBaselineRef.current?.(baselineOptions) || null
      ),
    });

    pendingSessionTransportOpenIntentsRef.current.set(options.sessionId, pendingIntent);
    ensureControlTransportForSessionOpen(pendingIntent);
  }, [
    clearSessionHandshakeTimeout,
    ensureControlTransportForSessionOpen,
  ]);
  queueSessionTransportOpenIntentRef.current = queueSessionTransportOpenIntent;

  const applyTransportOpenConnectedEffects = useCallback((options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => {
    const connectedEffectPlan = buildTransportOpenConnectedEffectPlan(options.debugScope);
    runtimeDebug(connectedEffectPlan.debugEvent, {
      sessionId: options.sessionId,
      activeSessionId: stateRef.current.activeSessionId,
    });
    if (connectedEffectPlan.clearSupersededSockets) {
      clearSupersededSockets(options.sessionId, true);
    }
    handleSocketConnectedBaselineRef.current?.({
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      ws: options.ws,
    });
    if (connectedEffectPlan.flushPendingInputQueue) {
      flushPendingInputQueueRef.current?.(options.sessionId);
    }
  }, [clearSupersededSockets]);
  applyTransportOpenConnectedEffectsRef.current = applyTransportOpenConnectedEffects;

  const applyTransportOpenLiveFailureEffects = useCallback((options: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    message: string;
    retryable: boolean;
  }) => {
    const liveFailureEffectPlan = buildTransportOpenLiveFailureEffectPlan(options.debugScope);
    cleanupSocket(options.sessionId);
    if (liveFailureEffectPlan.clearPendingIntent) {
      pendingSessionTransportOpenIntentsRef.current.delete(options.sessionId);
    }
    if (liveFailureEffectPlan.clearTransportToken) {
      writeSessionTransportToken(options.sessionId, null);
    }
    if (liveFailureEffectPlan.clearSupersededSockets) {
      clearSupersededSockets(options.sessionId, true);
    }
    if (liveFailureEffectPlan.clearScheduleErrorState) {
      setScheduleStateForSession(options.sessionId, (current) => buildSessionScheduleErrorState(current, options.message));
    }
    if (liveFailureEffectPlan.scheduleReconnect) {
      scheduleReconnectRef.current?.(options.sessionId, options.message, options.retryable);
    }
  }, [
    cleanupSocket,
    clearSupersededSockets,
    writeSessionTransportToken,
  ]);
  applyTransportOpenLiveFailureEffectsRef.current = applyTransportOpenLiveFailureEffects;

  const handleReconnectBeforeConnectSend = useCallback((sessionId: string, sessionName: string) => {
    updateSessionSync(sessionId, buildSessionConnectingLabelUpdates(sessionName));
    setScheduleStateForSession(sessionId, buildSessionScheduleLoadingState(sessionName));
  }, [updateSessionSync]);
  handleReconnectBeforeConnectSendRef.current = handleReconnectBeforeConnectSend;

  const handleReconnectHandshakeFailure = useCallback((options: {
    sessionId: string;
    message: string;
    retryable: boolean;
  }) => {
    const currentReconnectRuntime = reconnectRuntimesRef.current.get(options.sessionId) || null;
    if (currentReconnectRuntime) {
      currentReconnectRuntime.connecting = false;
    }
    clearSupersededSockets(options.sessionId, true);
    const reconnectHandshakeFailurePlan = buildReconnectHandshakeFailurePlan({
      retryable: options.retryable,
      currentAttempt: currentReconnectRuntime?.attempt || 0,
    });
    if (reconnectHandshakeFailurePlan.action === 'terminal-error') {
      reconnectRuntimesRef.current.delete(options.sessionId);
      updateSessionSync(options.sessionId, buildSessionErrorUpdates(options.message));
      emitSessionStatus(options.sessionId, 'error', options.message);
      return;
    }
    const nextReconnectRuntime = reconnectRuntimesRef.current.get(options.sessionId) || createSessionReconnectRuntime();
    nextReconnectRuntime.attempt = reconnectHandshakeFailurePlan.nextAttempt;
    nextReconnectRuntime.connecting = false;
    reconnectRuntimesRef.current.set(options.sessionId, nextReconnectRuntime);
    updateSessionSync(options.sessionId, buildSessionReconnectingFailureUpdates(
      options.message,
      nextReconnectRuntime.attempt,
    ));
    emitSessionStatus(options.sessionId, 'error', options.message);
    startReconnectAttemptRef.current?.(options.sessionId);
  }, [clearSupersededSockets, updateSessionSync]);
  handleReconnectHandshakeFailureRef.current = handleReconnectHandshakeFailure;

  const buildReconnectTransportOpenIntentOptions = useCallback((sessionId: string, host: Host): QueueSessionTransportOpenIntentOptions => ({
    sessionId,
    host,
    debugScope: 'reconnect',
    onBeforeConnectSend: ({ sessionName }) => {
      handleReconnectBeforeConnectSendRef.current?.(sessionId, sessionName);
    },
    onHandshakeFailure: (message, retryable, stage) => {
      if (stage === 'handshake') {
        handleReconnectHandshakeFailureRef.current?.({
          sessionId,
          message,
          retryable,
        });
        return;
      }
      applyTransportOpenLiveFailureEffectsRef.current?.({
        sessionId,
        debugScope: 'reconnect',
        message,
        retryable,
      });
    },
    onHandshakeConnected: (ws, connectedSessionName) => {
      reconnectRuntimesRef.current.delete(sessionId);
      applyTransportOpenConnectedEffectsRef.current?.({
        sessionId,
        debugScope: 'reconnect',
        sessionName: connectedSessionName,
        ws,
      });
    },
  }), []);

  const buildConnectTransportOpenIntentOptions = useCallback((
    sessionId: string,
    host: Host,
    activate: boolean,
  ): QueueSessionTransportOpenIntentOptions => ({
    sessionId,
    host,
    debugScope: 'connect',
    activate,
    onHandshakeFailure: (message, retryable, stage) => {
      if (stage === 'live') {
        applyTransportOpenLiveFailureEffectsRef.current?.({
          sessionId,
          debugScope: 'connect',
          message,
          retryable,
        });
        return;
      }
      scheduleReconnectRef.current?.(sessionId, message, retryable);
    },
    onHandshakeConnected: (ws, connectedSessionName) => {
      applyTransportOpenConnectedEffectsRef.current?.({
        sessionId,
        debugScope: 'connect',
        sessionName: connectedSessionName,
        ws,
      });
    },
  }), []);

  const queueReconnectTransportOpenIntent = useCallback((sessionId: string, host: Host) => {
    queueSessionTransportOpenIntentRef.current?.(
      buildReconnectTransportOpenIntentOptions(sessionId, host),
    );
  }, [buildReconnectTransportOpenIntentOptions]);
  queueReconnectTransportOpenIntentRef.current = queueReconnectTransportOpenIntent;

  const queueConnectTransportOpenIntent = useCallback((sessionId: string, host: Host, activate: boolean) => {
    queueSessionTransportOpenIntentRef.current?.(
      buildConnectTransportOpenIntentOptions(sessionId, host, activate),
    );
  }, [buildConnectTransportOpenIntentOptions]);
  queueConnectTransportOpenIntentRef.current = queueConnectTransportOpenIntent;

  const connectSession = useCallback((sessionId: string, host: Host, activate: boolean) => {
    const primeState = buildSessionTransportPrimeState(host, 'connect');
    clearReconnectForSession(sessionId);
    cleanupSocket(sessionId, false);
    manualCloseRef.current.delete(sessionId);
    writeSessionTransportHost(sessionId, primeState.transportHost);
    writeSessionTransportToken(sessionId, null);
    updateSessionSync(sessionId, primeState.sessionUpdates);
    setScheduleStateForSession(sessionId, buildSessionScheduleLoadingState(primeState.resolvedSessionName));
    if (activate) {
      setActiveSessionSync(sessionId);
    }
    queueConnectTransportOpenIntentRef.current?.(sessionId, host, activate);
  }, [
    cleanupSocket,
    clearReconnectForSession,
    setActiveSessionSync,
    updateSessionSync,
    writeSessionTransportToken,
  ]);

  const createSession = useCallback((host: Host, options?: CreateSessionOptions): string => {
    const resolvedSessionName = getResolvedSessionName(host);
    const existingSession = findReusableManagedSession({
      sessions: stateRef.current.sessions,
      host,
      resolvedSessionName,
      activeSessionId: stateRef.current.activeSessionId,
    });
    const shouldActivate = options?.activate !== false;
    const shouldConnect = options?.connect !== false;

    if (existingSession) {
      if (
        host.id !== existingSession.hostId
        || host.name !== existingSession.connectionName
        || host.bridgeHost !== existingSession.bridgeHost
        || host.bridgePort !== existingSession.bridgePort
        || resolvedSessionName !== existingSession.sessionName
        || host.authToken !== existingSession.authToken
        || host.autoCommand !== existingSession.autoCommand
        || (options?.customName?.trim() && (
          options.customName.trim() !== (existingSession.customName || '')
          || options.customName.trim() !== existingSession.title
        ))
      ) {
        const title = options?.customName?.trim() || existingSession.title || resolvedSessionName;
        updateSessionSync(existingSession.id, {
          ...buildSessionConnectionFields(host, resolvedSessionName),
          customName: options?.customName?.trim() || existingSession.customName,
          title,
        });
      }

      if (shouldActivate && stateRef.current.activeSessionId !== existingSession.id) {
        setActiveSessionSync(existingSession.id);
      }

      if (shouldConnect) {
        const currentTransport = readSessionTransportSocket(existingSession.id);
        const shouldReconnectExisting = shouldOpenManagedSessionTransport({
          readyState: currentTransport?.readyState ?? null,
          hasPendingOpenIntent: pendingSessionTransportOpenIntentsRef.current.has(existingSession.id),
          sessionState: existingSession.state,
        });
        if (shouldReconnectExisting) {
          connectSession(existingSession.id, host, shouldActivate);
        }
      }

      runtimeDebug('session.create.reuse-existing', {
        requestedSessionId: options?.sessionId || null,
        reusedSessionId: existingSession.id,
        bridgeHost: host.bridgeHost,
        bridgePort: host.bridgePort,
        sessionName: resolvedSessionName,
        activeSessionId: stateRef.current.activeSessionId,
      });
      return existingSession.id;
    }

    const sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const session: Session = {
      id: sessionId,
      hostId: host.id,
      connectionName: host.name,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      sessionName: resolvedSessionName,
      authToken: host.authToken,
      autoCommand: host.autoCommand,
      title: options?.customName?.trim() || resolvedSessionName,
      ws: null,
      state: shouldConnect ? 'connecting' : 'closed',
      hasUnread: false,
      customName: options?.customName?.trim() || undefined,
      buffer: options?.buffer || createSessionBufferState({
        lines: [],
        cols: DEFAULT_TERMINAL_SESSION_VIEWPORT.cols,
        rows: DEFAULT_TERMINAL_SESSION_VIEWPORT.rows,
        cacheLines: resolveSessionCacheLines(DEFAULT_TERMINAL_SESSION_VIEWPORT.rows),
      }),
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
      reconnectAttempt: 0,
      createdAt: options?.createdAt || Date.now(),
    };

    createSessionSync(session, shouldActivate);
    if (shouldConnect) {
      connectSession(sessionId, host, shouldActivate);
    }
    return sessionId;
  }, [connectSession, createSessionSync, resolveSessionCacheLines, setActiveSessionSync, updateSessionSync]);

  const closeSession = useCallback((id: string) => {
    manualCloseRef.current.add(id);
    pendingInputQueueRef.current.delete(id);
    pendingSessionTransportOpenIntentsRef.current.delete(id);
    clearReconnectForSession(id);
    const transportRuntime = readSessionTransportRuntime(id);
    const targetRuntime = readSessionTargetRuntime(id);

    const ws = readSessionTransportSocket(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendSocketPayload(id, ws, JSON.stringify({ type: 'close' }));
    }
    runtimeDebug('session.close', {
      sessionId: id,
      targetKey: transportRuntime?.targetKey || null,
      targetSessionCount: targetRuntime?.sessionIds.length || 0,
    });
    cleanupSocket(id, false);
    writeSessionTransportToken(id, null);
    clearSessionTransportRuntime(id);
    viewportSizeRef.current.delete(id);
    pendingInputTailRefreshRef.current.delete(id);
    pendingConnectTailRefreshRef.current.delete(id);
    pendingResumeTailRefreshRef.current.delete(id);
    sessionVisibleRangeRef.current.delete(id);
    sessionWireStatsRef.current.delete(id);
    sessionWireStatsPreviousRef.current.delete(id);
    if (id in sessionDebugMetricsRef.current) {
      const nextMetrics = { ...sessionDebugMetricsRef.current };
      delete nextMetrics[id];
      sessionDebugMetricsRef.current = nextMetrics;
    }
    setScheduleStates((current) => {
      if (!(id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
    deleteSessionSync(id);
  }, [cleanupSocket, clearReconnectForSession, clearSessionTransportRuntime, deleteSessionSync, readSessionTargetRuntime, readSessionTransportRuntime, readSessionTransportSocket, sendSocketPayload, writeSessionTransportToken]);

  const moveSession = useCallback((id: string, toIndex: number) => {
    moveSessionSync(id, toIndex);
  }, [moveSessionSync]);

  const renameSession = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    const current = stateRef.current.sessions.find((session) => session.id === id);
    if (!current) {
      return;
    }

    updateSessionSync(id, {
      customName: trimmed || undefined,
      title: trimmed || current.sessionName,
    });
  }, [updateSessionSync]);

  const reconnectSession = useCallback((id: string) => {
    clearReconnectForSession(id);
    const current = stateRef.current.sessions.find((session) => session.id === id);
    const knownHost = readSessionTransportHost(id);
    const targetKey = readSessionTargetKey(id);
    const targetRuntime = readSessionTargetRuntime(id);
    if (!current && !knownHost) {
      return;
    }

    const host: Host = knownHost || {
      id: current!.hostId,
      createdAt: current!.createdAt,
      name: current!.connectionName,
      bridgeHost: current!.bridgeHost,
      bridgePort: current!.bridgePort,
      sessionName: current!.sessionName,
      authToken: current!.authToken,
      authType: 'password',
      tags: [],
      pinned: false,
      autoCommand: current!.autoCommand,
    };

    runtimeDebug('session.reconnect.one', {
      sessionId: id,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      sessionName: host.sessionName,
      activeSessionId: stateRef.current.activeSessionId,
      targetKey,
      targetSessionCount: targetRuntime?.sessionIds.length || 0,
    });

    const primeState = buildSessionTransportPrimeState(host, 'reconnect');
    cleanupSocket(id, false);
    manualCloseRef.current.delete(id);
    writeSessionTransportHost(id, primeState.transportHost);
    updateSessionSync(id, primeState.sessionUpdates);

    if (stateRef.current.activeSessionId === id) {
      setActiveSessionSync(id);
    }

    scheduleReconnect(id, 'manual reconnect', true, { immediate: true, resetAttempt: true, force: true });
  }, [cleanupSocket, clearReconnectForSession, readSessionTargetKey, readSessionTargetRuntime, readSessionTransportHost, scheduleReconnect, setActiveSessionSync, updateSessionSync, writeSessionTransportHost]);

  const reconnectAllSessions = useCallback(() => {
    runtimeDebug('session.reconnect.all', {
      activeSessionId: stateRef.current.activeSessionId,
      sessions: summarizeSessions(stateRef.current.sessions),
    });
    const orderedSessions = orderSessionsForReconnect(
      stateRef.current.sessions,
      stateRef.current.activeSessionId,
    );
    for (const session of orderedSessions) {
      reconnectSession(session.id);
    }
  }, [reconnectSession]);

  const probeOrReconnectStaleSessionTransport = useCallback((sessionId: string, ws: BridgeTransportSocket, reason: 'active-reentry' | 'active-tick' | 'input') => {
    const lastActivityAt = lastServerActivityAtRef.current.get(sessionId) || 0;
    const lastProbeAt = staleTransportProbeAtRef.current.get(sessionId) || 0;
    if (lastProbeAt <= 0 || lastProbeAt <= lastActivityAt) {
      runtimeDebug(`session.transport.${reason}.probe`, {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        lastServerActivityAt: lastActivityAt,
      });
      resetSessionTransportPullBookkeeping(sessionId, `${reason}-probe`);
      staleTransportProbeAtRef.current.set(sessionId, Date.now());
      requestSessionBufferHead(sessionId, ws, { force: true });
      return 'probed' as const;
    }

    const probeAgeMs = Math.max(0, Date.now() - lastProbeAt);
    if (probeAgeMs < ACTIVE_TRANSPORT_PROBE_WAIT_MS) {
      runtimeDebug(`session.transport.${reason}.probe-wait`, {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        lastServerActivityAt: lastActivityAt,
        lastProbeAt,
        probeAgeMs,
      });
      return 'waiting' as const;
    }

    runtimeDebug(`session.transport.${reason}.reconnect-after-probe`, {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      lastServerActivityAt: lastActivityAt,
      lastProbeAt,
      probeAgeMs,
    });
    reconnectSession(sessionId);
    return 'reconnecting' as const;
  }, [reconnectSession, requestSessionBufferHead, resetSessionTransportPullBookkeeping]);

  const ensureActiveSessionFresh = useCallback((options: {
    sessionId: string;
    source: 'active-resume' | 'active-reentry' | 'active-tick';
    forceHead?: boolean;
    markResumeTail?: boolean;
    allowReconnectIfUnavailable?: boolean;
  }) => {
    const session = stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
    const transportRuntime = readSessionTransportRuntime(options.sessionId);
    const targetRuntime = readSessionTargetRuntime(options.sessionId);
    const ws = readSessionTransportSocket(options.sessionId) || null;
    const isActive = stateRef.current.activeSessionId === options.sessionId;
    const sessionState = session?.state ?? null;
    const reconnectInFlight = isReconnectInFlight(options.sessionId);
    const pendingTransportOpen = hasPendingSessionTransportOpen(options.sessionId);

    const transportStale = session ? isSessionTransportActivityStale(options.sessionId) : false;
    const refreshPlan = buildActiveSessionRefreshPlan({
      hasSession: Boolean(session),
      isActive,
      sessionState,
      wsReadyState: ws?.readyState ?? null,
      reconnectInFlight,
      pendingTransportOpen,
      allowReconnectIfUnavailable: options.allowReconnectIfUnavailable,
      transportStale,
      source: options.source,
    });

    if (refreshPlan.action === 'skip') {
      runtimeDebug(`session.transport.${options.source}.skip`, {
        sessionId: options.sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        hasSession: Boolean(session),
        isActive,
        sessionState,
        wsReadyState: ws?.readyState ?? null,
        targetKey: transportRuntime?.targetKey || null,
        targetSessionCount: targetRuntime?.sessionIds.length || 0,
        reason: refreshPlan.reason,
      });
      return false;
    }

    runtimeDebug(`session.transport.${options.source}`, {
      sessionId: options.sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      localRevision: session?.buffer.revision ?? null,
      localStartIndex: session?.buffer.startIndex ?? null,
      localEndIndex: session?.buffer.endIndex ?? null,
      transportStale,
      targetKey: transportRuntime?.targetKey || null,
      targetSessionCount: targetRuntime?.sessionIds.length || 0,
      plan: refreshPlan.action,
    });

    if (refreshPlan.action === 'probe-stale-transport') {
      if (ws) {
        probeOrReconnectStaleSessionTransport(options.sessionId, ws, refreshPlan.probeReason);
        return true;
      }
      return false;
    }

    if (refreshPlan.action === 'request-head') {
      if (refreshPlan.resetPullBookkeeping) {
        resetSessionTransportPullBookkeeping(options.sessionId, options.source);
      }
      if (options.markResumeTail) {
        pendingResumeTailRefreshRef.current.add(options.sessionId);
      }
      requestSessionBufferHead(options.sessionId, ws, { force: options.forceHead });
      return true;
    }

    if (refreshPlan.action === 'reconnect') {
      reconnectSession(options.sessionId);
      return true;
    }
    return false;
  }, [
    hasPendingSessionTransportOpen,
    isReconnectInFlight,
    isSessionTransportActivityStale,
    probeOrReconnectStaleSessionTransport,
    readSessionTargetRuntime,
    readSessionTransportRuntime,
    reconnectSession,
    requestSessionBufferHead,
    resetSessionTransportPullBookkeeping,
  ]);

  const switchSession = useCallback((id: string) => {
    lastActivatedSessionIdRef.current = id;
    setActiveSessionSync(id);
    ensureActiveSessionFresh({
      sessionId: id,
      source: 'active-reentry',
      forceHead: true,
      allowReconnectIfUnavailable: true,
    });
  }, [ensureActiveSessionFresh, setActiveSessionSync]);

  const sendMessage = useCallback((sessionId: string, msg: ClientMessage) => {
    const ws = readSessionTransportSocket(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendSocketPayload(sessionId, ws, JSON.stringify(msg));
    }
  }, [sendSocketPayload]);

  const requestScheduleList = useCallback((sessionId: string) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    if (!session) {
      return;
    }
    setScheduleStateForSession(sessionId, (current) => ({
      ...current,
      sessionName: session.sessionName,
      loading: true,
      error: undefined,
    }));
    sendMessage(sessionId, {
      type: 'schedule-list',
      payload: { sessionName: session.sessionName },
    });
  }, [sendMessage, setScheduleStateForSession]);

  const upsertScheduleJob = useCallback((sessionId: string, job: ScheduleJobDraft) => {
    setScheduleStateForSession(sessionId, (current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));
    sendMessage(sessionId, { type: 'schedule-upsert', payload: { job } });
  }, [sendMessage, setScheduleStateForSession]);

  const deleteScheduleJob = useCallback((sessionId: string, jobId: string) => {
    setScheduleStateForSession(sessionId, (current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));
    sendMessage(sessionId, { type: 'schedule-delete', payload: { jobId } });
  }, [sendMessage, setScheduleStateForSession]);

  const toggleScheduleJob = useCallback((sessionId: string, jobId: string, enabled: boolean) => {
    setScheduleStateForSession(sessionId, (current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));
    sendMessage(sessionId, { type: 'schedule-toggle', payload: { jobId, enabled } });
  }, [sendMessage, setScheduleStateForSession]);

  const runScheduleJobNow = useCallback((sessionId: string, jobId: string) => {
    setScheduleStateForSession(sessionId, (current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));
    sendMessage(sessionId, { type: 'schedule-run-now', payload: { jobId } });
  }, [sendMessage, setScheduleStateForSession]);

  const handleBufferHead = useCallback((
    sessionId: string,
    latestRevision: number,
    latestEndIndex: number,
    availableStartIndex?: number,
    availableEndIndex?: number,
    cursor?: TerminalCursorState | null,
  ) => {
    let session = stateRef.current.sessions.find((item) => item.id === sessionId);
    const ws = readSessionTransportSocket(sessionId);
    if (
      !session
      || (session.state !== 'connected' && session.state !== 'connecting' && session.state !== 'reconnecting')
      || !ws
      || ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    sessionBufferHeadsRef.current.set(sessionId, {
      revision: latestRevision,
      latestEndIndex,
      availableStartIndex: Number.isFinite(availableStartIndex) ? Math.max(0, Math.floor(availableStartIndex || 0)) : undefined,
      availableEndIndex: Number.isFinite(availableEndIndex) ? Math.max(0, Math.floor(availableEndIndex || 0)) : undefined,
        seenAt: Date.now(),
      });
    // Rate-limit: stamp now so the next 33ms tick is skipped,
    // breaking the tight head→sync→head→sync loop.
    lastHeadRequestAtRef.current.set(sessionId, Date.now());
    const normalizedCursor = normalizeTerminalCursorState(cursor);
    const cursorChanged = (
      (session.buffer.cursor?.rowIndex ?? null) !== (normalizedCursor?.rowIndex ?? null)
      || (session.buffer.cursor?.col ?? null) !== (normalizedCursor?.col ?? null)
      || (session.buffer.cursor?.visible ?? null) !== (normalizedCursor?.visible ?? null)
    );
    if (cursorChanged) {
      const nextBuffer = {
        ...session.buffer,
        cursor: normalizedCursor,
      };
      const nextSession = {
        ...session,
        buffer: nextBuffer,
      };
      updateSessionSync(sessionId, { buffer: nextBuffer });
      session = nextSession;
    }
    const liveHead = sessionBufferHeadsRef.current.get(sessionId) || null;
    if (
      session.daemonHeadRevision !== latestRevision
      || session.daemonHeadEndIndex !== latestEndIndex
    ) {
      updateSessionSync(sessionId, {
        daemonHeadRevision: latestRevision,
        daemonHeadEndIndex: latestEndIndex,
      });
    }
    if (!isSessionTransportActive(sessionId)) {
      return;
    }

    const localRevision = Math.max(0, Math.floor(session.buffer.revision || 0));
    const localEndIndex = Math.max(0, Math.floor(session.buffer.endIndex || 0));
    const localWindowInvalid = hasImpossibleLocalWindow(session, liveHead);
    const revisionResetDetected = latestRevision < localRevision;
    if (revisionResetDetected) {
      sessionRevisionResetRef.current.set(sessionId, {
        revision: latestRevision,
        latestEndIndex,
        seenAt: Date.now(),
      });
      runtimeDebug('session.buffer.revision-reset.detected', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        latestRevision,
        latestEndIndex,
        localRevision,
        localEndIndex,
      });
    } else {
      sessionRevisionResetRef.current.delete(sessionId);
    }

      runtimeDebug('session.buffer.head', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        latestRevision,
        latestEndIndex,
        availableStartIndex: liveHead?.availableStartIndex ?? null,
        availableEndIndex: liveHead?.availableEndIndex ?? null,
        cursor: normalizedCursor,
        localRevision,
        localEndIndex,
        localWindowInvalid,
      visibleRange: sessionVisibleRangeRef.current.get(sessionId) || null,
    });

    const demandSession: Session = {
      ...session,
      daemonHeadRevision: latestRevision,
      daemonHeadEndIndex: latestEndIndex,
    };
    if (localWindowInvalid && liveHead) {
      runtimeDebug('session.buffer.window.invalid', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        latestRevision,
        latestEndIndex,
        availableStartIndex: liveHead.availableStartIndex ?? null,
        availableEndIndex: liveHead.availableEndIndex ?? null,
        localStartIndex: session.buffer.startIndex,
        localEndIndex: session.buffer.endIndex,
        localBufferHeadStartIndex: session.buffer.bufferHeadStartIndex,
        localBufferTailEndIndex: session.buffer.bufferTailEndIndex,
      });
    }
    const visibleRange = sessionVisibleRangeRef.current.get(sessionId) || buildDefaultSessionVisibleRange(session);
    const needsTailRefresh = revisionResetDetected || localWindowInvalid || shouldPullFollowBuffer(demandSession, visibleRange);
    if (needsTailRefresh) {
      requestSessionBufferSync(sessionId, {
        reason:
          revisionResetDetected ? 'buffer-head-revision-reset'
          : localWindowInvalid ? 'buffer-head-invalid-local-window'
          : 'buffer-head-update',
        purpose: 'tail-refresh',
        sessionOverride: demandSession,
        liveHead,
        invalidLocalWindow: localWindowInvalid,
      });
      return;
    }

    const needsReadingRepair = shouldPullVisibleRangeBuffer(demandSession, visibleRange, liveHead);
    if (!needsReadingRepair) {
      return;
    }

    requestSessionBufferSync(sessionId, {
      reason: 'buffer-head-visible-range-repair',
      purpose: 'reading-repair',
      sessionOverride: demandSession,
    });
  }, [clearSessionPullState, isSessionTransportActive, requestSessionBufferSync, resolveSessionCacheLines]);

  function buildRemoteScreenshotCapture(
    fileName: string,
    chunks: Map<number, string>,
    totalBytes: number,
  ): RemoteScreenshotCapture {
    const ordered: string[] = [];
    const binaryParts: Uint8Array[] = [];
    let totalBinaryLength = 0;
    for (let index = 0; index < chunks.size; index += 1) {
      const chunk = chunks.get(index);
      if (!chunk) {
        throw new Error(`Remote screenshot missing chunk ${index}`);
      }
      ordered.push(chunk);
      try {
        const decoded = atob(chunk);
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i += 1) {
          bytes[i] = decoded.charCodeAt(i);
        }
        binaryParts.push(bytes);
        totalBinaryLength += bytes.length;
      } catch {
        // chunk decode failed — will fall back to full-string decode in caller
      }
    }

    const result: RemoteScreenshotCapture = {
      fileName,
      mimeType: 'image/png',
      dataBase64: ordered.join(''),
      totalBytes,
    };

    if (binaryParts.length === chunks.size && totalBinaryLength > 0) {
      const combined = new Uint8Array(totalBinaryLength);
      let offset = 0;
      for (const part of binaryParts) {
        combined.set(part, offset);
        offset += part.length;
      }
      result.dataBytes = combined;
    }

    return result;
  }

  const handleSocketServerMessage = useCallback((options: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
  }, msg: ServerMessage) => {
    const currentSession = stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
    const shouldPromoteConnectedFromLiveBuffer =
      Boolean(currentSession)
      && currentSession!.state !== 'connected'
      && (msg.type === 'buffer-sync' || msg.type === 'buffer-head');

    switch (msg.type) {
      case 'connected':
        options.onConnected();
        break;
      case 'buffer-sync':
        if (shouldPromoteConnectedFromLiveBuffer) {
          options.onConnected();
        }
        // Rate-limit: stamp now so the next 33ms tick is skipped.
        lastHeadRequestAtRef.current.set(options.sessionId, Date.now());
        settleSessionPullState(options.sessionId, msg.payload);
        runtimeDebug(`session.ws.${options.debugScope}.buffer-sync`, {
          sessionId: options.sessionId,
          payload: summarizeBufferPayload(msg.payload),
          activeSessionId: stateRef.current.activeSessionId,
        });
        applyIncomingBufferSync(options.sessionId, normalizeIncomingBufferPayload(msg.payload));
        break;
      case 'buffer-head':
        if (shouldPromoteConnectedFromLiveBuffer) {
          options.onConnected();
        }
        handleBufferHead(
          options.sessionId,
          Math.max(0, Math.floor(msg.payload.revision || 0)),
          Math.max(0, Math.floor(msg.payload.latestEndIndex || 0)),
          Number.isFinite(msg.payload.availableStartIndex) ? Math.max(0, Math.floor(msg.payload.availableStartIndex || 0)) : undefined,
          Number.isFinite(msg.payload.availableEndIndex) ? Math.max(0, Math.floor(msg.payload.availableEndIndex || 0)) : undefined,
          normalizeTerminalCursorState(msg.payload.cursor),
        );
        break;
      case 'schedule-state':
        setScheduleStateForSession(options.sessionId, {
          sessionName: msg.payload.sessionName,
          jobs: msg.payload.jobs,
          loading: false,
          lastEvent: scheduleStatesRef.current[options.sessionId]?.lastEvent,
        });
        break;
      case 'schedule-event':
        setScheduleStateForSession(options.sessionId, (current) => ({
          ...current,
          sessionName: msg.payload.sessionName,
          loading: false,
          lastEvent: msg.payload,
        }));
        break;
      case 'debug-control':
        setRuntimeDebugEnabled(Boolean(msg.payload.enabled));
        runtimeDebug('session.runtime-debug.control', {
          sessionId: options.sessionId,
          enabled: Boolean(msg.payload.enabled),
          reason: msg.payload.reason || 'remote-control',
        });
        break;
      case 'title':
        setSessionTitleSync(options.sessionId, msg.payload);
        break;
      case 'image-pasted':
        break;
      case 'file-attached':
        break;
      case 'file-list-response':
      case 'file-list-error':
      case 'remote-screenshot-status':
        if (msg.type === 'remote-screenshot-status') {
          const payload = msg.payload as RemoteScreenshotStatusPayload;
          const pending = pendingRemoteScreenshotRequestsRef.current.get(payload.requestId);
          if (pending) {
            pending.phase = payload.phase;
            pending.fileName = payload.fileName || pending.fileName;
            pending.totalBytes = Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0));
            armRemoteScreenshotTimeout(payload.requestId);
            pending.onProgress?.({
              ...payload,
              fileName: payload.fileName || pending.fileName || undefined,
              totalBytes: Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0)),
            });
          }
        }
        for (const listener of fileTransferListeners.current) {
          try { listener(msg); } catch (listenerError) { console.error('[SessionContext] fileTransfer listener error (status):', listenerError); }
        }
        break;
      case 'file-download-chunk': {
        const payload = msg.payload as FileDownloadChunkPayload;
        const pending = pendingRemoteScreenshotRequestsRef.current.get(payload.requestId);
        if (pending) {
          pending.phase = 'transferring';
          pending.fileName = payload.fileName || pending.fileName;
          pending.chunks.set(payload.chunkIndex, payload.dataBase64);
          armRemoteScreenshotTimeout(payload.requestId);
          pending.onProgress?.({
            requestId: payload.requestId,
            phase: 'transferring',
            fileName: payload.fileName || pending.fileName || undefined,
            receivedChunks: pending.chunks.size,
            totalChunks: Math.max(0, Math.floor(payload.totalChunks || 0)),
            totalBytes: pending.totalBytes,
          });
        }
        for (const listener of fileTransferListeners.current) {
          try { listener(msg); } catch (listenerError) { console.error('[SessionContext] fileTransfer listener error (chunk):', listenerError); }
        }
        break;
      }
      case 'file-download-complete': {
        const payload = msg.payload as FileDownloadCompletePayload;
        const pending = pendingRemoteScreenshotRequestsRef.current.get(payload.requestId);
        if (pending) {
          pendingRemoteScreenshotRequestsRef.current.delete(payload.requestId);
          clearRemoteScreenshotTimeout(pending);
          try {
            pending.resolve(buildRemoteScreenshotCapture(
              payload.fileName || pending.fileName || `remote-screenshot-${Date.now()}.png`,
              pending.chunks,
              Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0)),
            ));
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
        for (const listener of fileTransferListeners.current) {
          try { listener(msg); } catch (listenerError) { console.error('[SessionContext] fileTransfer listener error (complete):', listenerError); }
        }
        break;
      }
      case 'file-download-error': {
        const payload = msg.payload as FileDownloadErrorPayload;
        const pending = pendingRemoteScreenshotRequestsRef.current.get(payload.requestId);
        if (pending) {
          pendingRemoteScreenshotRequestsRef.current.delete(payload.requestId);
          clearRemoteScreenshotTimeout(pending);
          pending.reject(new Error(payload.error || 'Remote screenshot download failed'));
        }
        for (const listener of fileTransferListeners.current) {
          try { listener(msg); } catch (listenerError) { console.error('[SessionContext] fileTransfer listener error (error):', listenerError); }
        }
        break;
      }
      case 'file-upload-progress':
      case 'file-upload-complete':
      case 'file-upload-error':
        for (const listener of fileTransferListeners.current) {
          try { listener(msg); } catch (listenerError) { console.error('[SessionContext] fileTransfer listener error (upload):', listenerError); }
        }
        break;
      case 'error':
        options.onFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
        break;
      case 'closed':
        options.onFailure(msg.payload.reason || 'socket closed', true);
        break;
      case 'sessions':
        break;
      case 'pong':
        lastPongAtRef.current.set(options.sessionId, Date.now());
        break;
    }
  }, [applyIncomingBufferSync, buildRemoteScreenshotCapture, handleBufferHead, setScheduleStateForSession, settleSessionPullState]);

  const handleSocketConnectedBaseline = useCallback((options: {
    sessionId: string;
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => {
    const currentSession = stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
    const hadLocalWindowBeforeConnected = hasSessionLocalWindow(currentSession);
    applyTransportDiagnostics(options.sessionId, options.ws);
    updateSessionSync(options.sessionId, buildSessionConnectedUpdates());
    setScheduleStateForSession(options.sessionId, (current) => (
      buildSessionScheduleListLoadingState(current, options.sessionName)
    ));
    sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
      type: 'schedule-list',
      payload: { sessionName: options.sessionName },
    } satisfies ClientMessage));
    const connectedHeadRefreshPlan = buildConnectedHeadRefreshPlan({
      shouldLiveRefresh: isSessionTransportActive(options.sessionId),
      hadLocalWindowBeforeConnected,
    });
    if (connectedHeadRefreshPlan.shouldMarkPendingConnectTailRefresh) {
      pendingConnectTailRefreshRef.current.add(options.sessionId);
    }
    if (connectedHeadRefreshPlan.shouldRequestHead) {
      requestSessionBufferHead(options.sessionId, options.ws, { force: true });
    }
    incrementConnectedSync();
  }, [applyTransportDiagnostics, incrementConnectedSync, isSessionTransportActive, requestSessionBufferHead, setScheduleStateForSession]);
  handleSocketConnectedBaselineRef.current = handleSocketConnectedBaseline;

  const finalizeSocketFailureBaseline = useCallback((options: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => {
    if (!options.markCompleted()) {
      return {
        shouldContinue: false,
        manualClosed: false,
      };
    }

    cleanupSocket(options.sessionId);
    pendingSessionTransportOpenIntentsRef.current.delete(options.sessionId);
    writeSessionTransportToken(options.sessionId, null);
    setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      loading: false,
      error: options.message,
    }));

    const manualClosed = manualCloseRef.current.has(options.sessionId);
    return {
      shouldContinue: !manualClosed,
      manualClosed,
    };
  }, [cleanupSocket, setScheduleStateForSession, writeSessionTransportToken]);
  finalizeSocketFailureBaselineRef.current = finalizeSocketFailureBaseline;

  const resumeActiveSessionTransport = useCallback((sessionId: string) => {
    return ensureActiveSessionFresh({
      sessionId,
      source: 'active-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  }, [ensureActiveSessionFresh]);

  const updateSessionViewport = useCallback((sessionId: string, visibleRange: TerminalVisibleRange) => {
    const normalized = normalizeSessionVisibleRangeState(visibleRange);
    const previous = sessionVisibleRangeRef.current.get(sessionId);
    if (visibleRangeStatesEqual(previous, normalized)) {
      return;
    }
    sessionVisibleRangeRef.current.set(sessionId, normalized);
    if (!isSessionTransportActive(sessionId)) {
      return;
    }
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    const liveHead = sessionBufferHeadsRef.current.get(sessionId) || null;
    if (!session || !shouldPullVisibleRangeBuffer(session, normalized, liveHead)) {
      return;
    }
    requestSessionBufferSync(sessionId, {
      reason: 'viewport-visible-range-demand',
      purpose: 'reading-repair',
      sessionOverride: session,
    });
  }, [isSessionTransportActive, requestSessionBufferSync]);

  useEffect(() => {
    if (!state.activeSessionId) {
      lastActivatedSessionIdRef.current = null;
      return;
    }
    if (lastActivatedSessionIdRef.current === state.activeSessionId) {
      return;
    }
    lastActivatedSessionIdRef.current = state.activeSessionId;
    ensureActiveSessionFresh({
      sessionId: state.activeSessionId,
      source: 'active-reentry',
      forceHead: true,
      allowReconnectIfUnavailable: true,
    });
  }, [ensureActiveSessionFresh, state.activeSessionId, state.sessions]);

  const flushPendingInputQueue = useCallback((sessionId: string) => {
    const ws = readSessionTransportSocket(sessionId);
    const queued = pendingInputQueueRef.current.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN || !queued || queued.length === 0) {
      return;
    }

    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    pendingInputQueueRef.current.delete(sessionId);
    for (const payload of queued) {
      sendSocketPayload(sessionId, ws, JSON.stringify({ type: 'input', payload }));
    }
    if (session) {
      markPendingInputTailRefresh(sessionId, session.buffer.revision);
    }
    requestSessionBufferHead(sessionId, ws, { force: true });
  }, [markPendingInputTailRefresh, requestSessionBufferHead, sendSocketPayload]);
  flushPendingInputQueueRef.current = flushPendingInputQueue;

  const enqueuePendingInput = useCallback((sessionId: string, payload: string) => {
    const current = pendingInputQueueRef.current.get(sessionId) || [];
    pendingInputQueueRef.current.set(sessionId, [...current, payload]);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      flushRuntimeDebugLogs();
    }, CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [flushRuntimeDebugLogs]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (!foregroundActiveRef.current) {
          scheduleNext();
          return;
        }
        const activeSessionId = stateRef.current.activeSessionId;
        if (!activeSessionId) {
          scheduleNext();
          return;
        }
        ensureActiveSessionFresh({
          sessionId: activeSessionId,
          source: 'active-tick',
          allowReconnectIfUnavailable: false,
        });
        scheduleNext();
      }, ACTIVE_HEAD_REFRESH_TICK_MS);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [ensureActiveSessionFresh]);

  const sendInput = useCallback((sessionId: string, data: string) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      runtimeDebug('session.input.skip', {
        why: 'no-target-session',
        size: data.length,
      });
      return;
    }

    const session = stateRef.current.sessions.find((item) => item.id === targetSessionId) || null;
    if (!session) {
      runtimeDebug('session.input.skip', {
        why: 'missing-session',
        sessionId: targetSessionId,
        size: data.length,
      });
      return;
    }

    const ws = readSessionTransportSocket(targetSessionId);
    const transportStale = isSessionTransportActivityStale(targetSessionId);
    const isActiveTarget = stateRef.current.activeSessionId === targetSessionId;
    const reconnectInFlight = isReconnectInFlight(targetSessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      runtimeDebug('session.input.send', {
        sessionId: targetSessionId,
        size: data.length,
        preview: data.slice(0, 32),
        transportStale,
      });
      markPendingInputTailRefresh(targetSessionId, session.buffer.revision);
      sendSocketPayload(targetSessionId, ws, JSON.stringify({ type: 'input', payload: data }));
      requestSessionBufferHead(targetSessionId, ws, { force: true });
      if (transportStale && isActiveTarget && !reconnectInFlight) {
        probeOrReconnectStaleSessionTransport(targetSessionId, ws, 'input');
      }
      return;
    }

    runtimeDebug('session.input.queue', {
      sessionId: targetSessionId,
      why: transportStale ? 'stale-open-transport' : 'transport-unavailable',
      size: data.length,
      preview: data.slice(0, 32),
      isActiveTarget,
      reconnectInFlight,
      wsReadyState: ws?.readyState ?? null,
    });
    enqueuePendingInput(targetSessionId, data);
    if (hasPendingSessionTransportOpen(targetSessionId)) {
      return;
    }
    const shouldForceReconnect = transportStale
      ? isActiveTarget && !reconnectInFlight
      : shouldReconnectQueuedActiveInput({
          isActiveTarget,
          wsReadyState: ws?.readyState ?? null,
          reconnectInFlight,
        });
    if (shouldForceReconnect) {
      reconnectSession(targetSessionId);
    }
  }, [enqueuePendingInput, hasPendingSessionTransportOpen, isReconnectInFlight, isSessionTransportActivityStale, markPendingInputTailRefresh, probeOrReconnectStaleSessionTransport, reconnectSession, requestSessionBufferHead]);

  const ensureSessionReadyForPaste = useCallback(async (sessionId: string, timeoutMs = IMAGE_PASTE_READY_TIMEOUT_MS) => {
    const readReadyState = () => {
      const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
      const ws = readSessionTransportSocket(sessionId) || null;
      const ready =
        Boolean(session) &&
        session?.state === 'connected' &&
        Boolean(ws) &&
        ws?.readyState === WebSocket.OPEN;
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
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const current = readReadyState();
      if (current.ready && current.ws) {
        return current.ws;
      }
    }

    const latest = readReadyState();
    const stateLabel = latest.session?.state || 'missing';
    throw new Error(`Active session is not ready yet (${stateLabel})`);
  }, []);

  const sendImagePaste = useCallback(async (sessionId: string, file: File) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      throw new Error('No target session for image paste');
    }

    const ws = await ensureSessionReadyForPaste(targetSessionId);
    const fileBuffer = await file.arrayBuffer();
    const payload: PasteImageStartPayload = {
      name: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      byteLength: fileBuffer.byteLength,
      pasteSequence: '\x16',
    };

    sendSocketPayload(targetSessionId, ws, JSON.stringify({
      type: 'paste-image-start',
      payload,
    } satisfies ClientMessage));
    sendSocketPayload(targetSessionId, ws, fileBuffer);
  }, [armRemoteScreenshotTimeout, ensureSessionReadyForPaste, sendSocketPayload]);

  const sendFileAttach = useCallback(async (sessionId: string, file: File) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      throw new Error('No target session for file attach');
    }

    const ws = await ensureSessionReadyForPaste(targetSessionId);
    const fileBuffer = await file.arrayBuffer();
    const payload: AttachFileStartPayload = {
      name: file.name || 'attachment',
      mimeType: file.type || 'application/octet-stream',
      byteLength: fileBuffer.byteLength,
    };

    sendSocketPayload(targetSessionId, ws, JSON.stringify({
      type: 'attach-file-start',
      payload,
    } satisfies ClientMessage));
    sendSocketPayload(targetSessionId, ws, fileBuffer);
  }, [ensureSessionReadyForPaste, sendSocketPayload]);

  const requestRemoteScreenshot = useCallback(async (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
  ) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      throw new Error('No target session for remote screenshot');
    }

    const ws = await ensureSessionReadyForPaste(targetSessionId);
    const requestId = `rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return await new Promise<RemoteScreenshotCapture>((resolve, reject) => {
      pendingRemoteScreenshotRequestsRef.current.set(requestId, {
        fileName: null,
        chunks: new Map(),
        totalBytes: 0,
        phase: 'request-sent',
        timeoutId: null,
        onProgress,
        resolve,
        reject,
      });
      armRemoteScreenshotTimeout(requestId);

      const payload: RemoteScreenshotRequestPayload = { requestId };
      sendSocketPayload(targetSessionId, ws, JSON.stringify({
        type: 'remote-screenshot-request',
        payload,
      } satisfies ClientMessage));
    });
  }, [ensureSessionReadyForPaste, sendSocketPayload]);

  const resizeTerminal = useCallback((sessionId: string, cols: number, rows: number) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      return;
    }

    const previous = viewportSizeRef.current.get(targetSessionId);
    if (previous && previous.cols === cols && previous.rows === rows) {
      return;
    }
    viewportSizeRef.current.set(targetSessionId, { cols, rows });
    sendMessage(targetSessionId, { type: 'resize', payload: { cols, rows } });
  }, [sendMessage]);

  const setTerminalWidthMode = useCallback((sessionId: string, mode: TerminalWidthMode, cols?: number | null) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      return;
    }
    const normalizedMode: TerminalWidthMode = mode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
    const payload =
      normalizedMode === 'adaptive-phone' && typeof cols === 'number' && Number.isFinite(cols) && cols > 0
        ? { mode: normalizedMode, cols: Math.max(1, Math.floor(cols)) }
        : { mode: normalizedMode };
    sendMessage(targetSessionId, { type: 'terminal-width-mode', payload });
  }, [sendMessage]);

  const getActiveSession = useCallback(
    () => stateRef.current.sessions.find((session) => session.id === stateRef.current.activeSessionId) || null,
    [],
  );

  const getSession = useCallback((id: string) => stateRef.current.sessions.find((session) => session.id === id) || null, []);

  const getSessionScheduleState = useCallback((sessionId: string) => {
    return scheduleStatesRef.current[sessionId]
      || buildEmptyScheduleState(stateRef.current.sessions.find((session) => session.id === sessionId)?.sessionName || '');
  }, []);

  const getSessionDebugMetrics = useCallback((sessionId: string) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    const metrics = sessionDebugMetricsRef.current[sessionId] || null;
    const fallbackStatus: SessionDebugOverlayMetrics['status'] =
      session?.state === 'error' ? 'error'
      : session?.state === 'closed' ? 'closed'
      : session?.state === 'reconnecting' ? 'reconnecting'
      : session?.state === 'connecting' ? 'connecting'
      : 'waiting';
    if (!metrics) {
      return session
        ? {
            uplinkBps: 0,
            downlinkBps: 0,
            renderHz: 0,
            pullHz: 0,
            bufferPullActive: false,
            status: fallbackStatus,
            active: stateRef.current.activeSessionId === sessionId,
            updatedAt: Date.now(),
          }
        : null;
    }
    if (metrics.active === (stateRef.current.activeSessionId === sessionId)) {
      return metrics;
    }
    return {
      ...metrics,
      active: stateRef.current.activeSessionId === sessionId,
    };
  }, []);

  useEffect(() => () => {
    for (const pending of pendingRemoteScreenshotRequestsRef.current.values()) {
      clearRemoteScreenshotTimeout(pending);
      pending.reject(new Error('Session provider disposed before remote screenshot completed'));
    }
    pendingRemoteScreenshotRequestsRef.current.clear();
    for (const timer of pingIntervals.current.values()) {
      clearInterval(timer);
    }
    for (const sessionId of handshakeTimeoutsRef.current.keys()) {
      clearSessionHandshakeTimeout(sessionId);
    }
    for (const reconnectRuntime of reconnectRuntimesRef.current.values()) {
      if (reconnectRuntime.timer) {
        clearTimeout(reconnectRuntime.timer);
      }
    }
    for (const session of stateRef.current.sessions) {
      manualCloseRef.current.add(session.id);
      cleanupSocket(session.id, true);
      cleanupControlSocket(session.id, true);
    }
  }, [cleanupControlSocket, cleanupSocket, clearRemoteScreenshotTimeout, clearSessionHandshakeTimeout]);

  const value: SessionContextValue = {
    state,
    scheduleStates,
    getSessionDebugMetrics,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    resumeActiveSessionTransport,
    sendMessage,
    sendInput,
    sendImagePaste,
    sendFileAttach,
    requestRemoteScreenshot,
    resizeTerminal,
    setTerminalWidthMode,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getActiveSession,
    getSession,
    onFileTransferMessage: (handler: (msg: any) => void) => {
      fileTransferListeners.current.add(handler);
      return () => { fileTransferListeners.current.delete(handler); };
    },
    sendMessageRaw: (sessionId: string, msg: unknown) => {
      const ws = readSessionTransportSocket(sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendSocketPayload(sessionId, ws, JSON.stringify(msg));
      }
    },
  };

  return React.createElement(SessionContext.Provider, { value }, children);
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return context;
}

export { SESSION_STATUS_EVENT };
