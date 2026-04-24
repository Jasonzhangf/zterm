/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import type {
  BufferSyncRequestPayload,
  ClientMessage,
  Host,
  HostConfigMessage,
  PasteImageStartPayload,
  ScheduleJobDraft,
  ServerMessage,
  Session,
  SessionScheduleState,
  SessionBufferState,
  StreamModePayload,
  TerminalViewportState,
  SessionState,
  TerminalBufferPayload,
  TerminalCell,
} from '../lib/types';
import { buildEmptyScheduleState } from '@zterm/shared';
import { buildBridgeUrl } from '../lib/bridge-url';
import { getResolvedSessionName } from '../lib/connection-target';
import { getDefaultTerminalViewportSize } from '../lib/default-terminal-viewport';
import {
  ACTIVE_HEAD_REFRESH_TICK_MS,
  DEFAULT_TERMINAL_CACHE_LINES,
  resolveTerminalCacheLines,
  resolveTerminalRefreshCadence,
} from '../lib/mobile-config';
import { drainRuntimeDebugEntries, getPendingRuntimeDebugEntryCount, isRuntimeDebugEnabled, runtimeDebug, setRuntimeDebugEnabled } from '../lib/runtime-debug';
import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  sessionBuffersEqual,
} from '../lib/terminal-buffer';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;
const POST_SUCCESS_NEXT_RETRY_DELAY_MS = 240;
const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;
const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;
const BUFFER_RENDER_COMMIT_INTERVAL_MS = 16;
const ACTIVE_TAIL_REFRESH_ACK_TIMEOUT_MS = 400;
const IDLE_SESSION_CAPTURE_INTERVAL_MS = 1000;

function resolveInitialViewportSize(
  viewportMap: Map<string, { cols: number; rows: number }>,
  sessionId: string,
) {
  const current = viewportMap.get(sessionId);
  if (current) {
    return current;
  }

  const fallback = getDefaultTerminalViewportSize();
  viewportMap.set(sessionId, fallback);
  return fallback;
}

function emitSessionStatus(sessionId: string, type: 'closed' | 'error', message?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_STATUS_EVENT, { detail: { sessionId, type, message } }));
}

function summarizeBufferPayload(payload: TerminalBufferPayload) {
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    viewportEndIndex: payload.viewportEndIndex,
    cols: payload.cols,
    rows: payload.rows,
    lineCount: payload.lines.length,
    firstLineIndex: payload.lines[0]?.index ?? null,
    lastLineIndex: payload.lines[payload.lines.length - 1]?.index ?? null,
  };
}

function summarizeSessions(sessions: Session[]) {
  return sessions.map((session) => ({
    id: session.id,
    state: session.state,
    revision: session.buffer.revision,
  }));
}

function buildStreamModePayload(mode: 'active' | 'idle'): StreamModePayload {
  if (mode === 'idle') {
    return {
      mode,
      minCaptureIntervalMs: IDLE_SESSION_CAPTURE_INTERVAL_MS,
    };
  }

  const cadence = resolveTerminalRefreshCadence();
  return {
    mode,
    minCaptureIntervalMs: cadence.headTickMs,
  };
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

interface SessionContextValue {
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  createSession: (host: Host, options?: CreateSessionOptions) => string;
  closeSession: (id: string) => void;
  switchSession: (id: string) => void;
  moveSession: (id: string, toIndex: number) => void;
  renameSession: (id: string, name: string) => void;
  reconnectSession: (id: string) => void;
  reconnectAllSessions: () => void;
  resetSessionViewportToFollow: (id: string) => boolean;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (sessionId: string, data: string) => void;
  sendImagePaste: (sessionId: string, file: File) => Promise<void>;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  updateSessionViewport: (sessionId: string, renderDemand: SessionRenderDemandState) => void;
  requestScheduleList: (sessionId: string) => void;
  upsertScheduleJob: (sessionId: string, job: ScheduleJobDraft) => void;
  deleteScheduleJob: (sessionId: string, jobId: string) => void;
  toggleScheduleJob: (sessionId: string, jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (sessionId: string, jobId: string) => void;
  getSessionScheduleState: (sessionId: string) => SessionScheduleState;
  getActiveSession: () => Session | null;
  getSession: (id: string) => Session | null;
}

interface SessionProviderProps {
  children: React.ReactNode;
  wsUrl?: string;
  terminalCacheLines?: number;
}

interface CreateSessionOptions {
  activate?: boolean;
  customName?: string;
  buffer?: SessionBufferState;
  createdAt?: number;
  sessionId?: string;
}

interface ReconnectBucket {
  attempt: number;
  activeSessionId: string | null;
  pending: string[];
  timer: ReturnType<typeof setTimeout> | null;
  nextDelayMs: number | null;
}

interface SessionBufferHeadState {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

interface TailRefreshDemandState {
  reason: string;
  priority: number;
  expireAt: number | null;
}

interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

type SessionRenderDemandState = TerminalViewportState;

const SessionContext = createContext<SessionContextValue | null>(null);

function toHostKey(target: { bridgeHost: string; bridgePort: number }) {
  return `${target.bridgeHost.trim()}:${target.bridgePort}`;
}

function createReconnectBucket(): ReconnectBucket {
  return {
    attempt: 0,
    activeSessionId: null,
    pending: [],
    timer: null,
    nextDelayMs: null,
  };
}

function computeReconnectDelay(attempt: number) {
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

function getTailRefreshDemandPriority(reason: string) {
  switch (reason) {
    case 'input-tail-refresh':
      return 3;
    case 'active-head-refresh':
      return 2;
    default:
      return 1;
  }
}

function normalizeTerminalCellRow(input: unknown): TerminalCell[] {
  if (typeof input === 'string') {
    return Array.from(input).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }));
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((cell): cell is TerminalCell => Boolean(cell && typeof cell === 'object'))
    .map((cell) => ({
      char: typeof cell.char === 'number' ? cell.char : 32,
      fg: typeof cell.fg === 'number' ? cell.fg : 256,
      bg: typeof cell.bg === 'number' ? cell.bg : 256,
      flags: typeof cell.flags === 'number' ? cell.flags : 0,
      width: typeof cell.width === 'number' ? cell.width : 1,
    }));
}

function normalizeIncomingBufferPayload(input: TerminalBufferPayload): TerminalBufferPayload {
  const startIndex =
    typeof input.startIndex === 'number' && Number.isFinite(input.startIndex)
      ? Math.max(0, Math.floor(input.startIndex))
      : 0;
  const endIndex =
    typeof input.endIndex === 'number' && Number.isFinite(input.endIndex)
      ? Math.max(startIndex, Math.floor(input.endIndex))
      : startIndex;
  const rows =
    typeof input.rows === 'number' && Number.isFinite(input.rows)
      ? Math.max(1, Math.floor(input.rows))
      : 24;
  const viewportEndIndex =
    typeof input.viewportEndIndex === 'number' && Number.isFinite(input.viewportEndIndex)
      ? Math.max(startIndex, Math.floor(input.viewportEndIndex))
      : endIndex;

  return {
    revision:
      typeof input.revision === 'number' && Number.isFinite(input.revision)
        ? input.revision
        : 0,
    startIndex,
    endIndex,
    viewportEndIndex,
    cols:
      typeof input.cols === 'number' && Number.isFinite(input.cols)
        ? Math.max(1, Math.floor(input.cols))
        : 80,
    rows,
    cursorKeysApp: Boolean(input.cursorKeysApp),
    lines: Array.isArray(input.lines)
      ? input.lines
          .filter((line) => line && typeof line === 'object')
          .map((line) => ({
            index:
              typeof line.index === 'number' && Number.isFinite(line.index)
                ? Math.max(0, Math.floor(line.index))
                : 0,
            cells: normalizeTerminalCellRow(line.cells),
          }))
      : [],
  };
}

function buildBaseBufferSyncRequestPayload(
  session: Session,
  viewportRows: number,
  options?: { forceBootstrap?: boolean },
): Pick<
  BufferSyncRequestPayload,
  'knownRevision' | 'localStartIndex' | 'localEndIndex' | 'viewportRows'
> {
  const forceBootstrap = Boolean(options?.forceBootstrap);
  return {
    knownRevision: forceBootstrap ? 0 : Math.max(0, Math.floor(session.buffer.revision || 0)),
    localStartIndex: forceBootstrap ? 0 : Math.max(0, Math.floor(session.buffer.startIndex || 0)),
    localEndIndex: forceBootstrap ? 0 : Math.max(0, Math.floor(session.buffer.endIndex || 0)),
    viewportRows: Math.max(1, Math.floor(viewportRows || session.buffer.rows || 24)),
  };
}

function normalizeReadingMissingRanges(renderDemand?: SessionRenderDemandState) {
  if (renderDemand?.mode !== 'reading' || !Array.isArray(renderDemand.missingRanges) || renderDemand.missingRanges.length === 0) {
    return undefined;
  }
  const missingRanges = renderDemand.missingRanges.map((range) => ({
    startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
    endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
  })).filter((range) => range.endIndex > range.startIndex);
  return missingRanges.length > 0 ? missingRanges : undefined;
}

function hasGapInAbsoluteWindow(
  gapRanges: SessionBufferState['gapRanges'],
  startIndex: number,
  endIndex: number,
) {
  if (endIndex <= startIndex) {
    return false;
  }
  return gapRanges.some((range) => range.endIndex > startIndex && range.startIndex < endIndex);
}

function shouldBootstrapTailRefreshRequest(
  session: Session,
  renderDemand: SessionRenderDemandState,
  cacheLines: number,
) {
  const followWindowEndIndex = Math.max(0, Math.floor(renderDemand.viewportEndIndex || 0));
  const visibleWindowRows = Math.max(1, Math.floor(renderDemand.viewportRows || session.buffer.rows || 1));
  const visibleWindowStartIndex = Math.max(0, followWindowEndIndex - visibleWindowRows);
  const followCacheWindowStartIndex = Math.max(
    0,
    followWindowEndIndex - Math.max(1, Math.floor(cacheLines || 1)),
  );
  const missesVisibleFollowWindow = (
    session.buffer.startIndex > visibleWindowStartIndex
    || session.buffer.endIndex < followWindowEndIndex
    || hasGapInAbsoluteWindow(session.buffer.gapRanges, visibleWindowStartIndex, followWindowEndIndex)
  );

  return (
    session.buffer.revision <= 0
    || session.buffer.endIndex <= session.buffer.startIndex
    || session.buffer.lines.length === 0
    || missesVisibleFollowWindow
    || hasGapInAbsoluteWindow(session.buffer.gapRanges, followCacheWindowStartIndex, followWindowEndIndex)
  );
}

function buildTailRefreshBufferSyncRequestPayload(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  options?: { forceBootstrap?: boolean },
): BufferSyncRequestPayload {
  const viewportRows = Math.max(1, Math.floor(renderDemand?.viewportRows || session.buffer.rows || 24));
  return {
    ...buildBaseBufferSyncRequestPayload(session, viewportRows, options),
    viewportEndIndex: Math.max(0, Math.floor(session.buffer.bufferTailEndIndex || session.buffer.endIndex || 0)),
    mode: 'follow',
  };
}

function buildReadingBufferSyncRequestPayload(
  session: Session,
  renderDemand?: SessionRenderDemandState,
): BufferSyncRequestPayload {
  const viewportRows = Math.max(1, Math.floor(renderDemand?.viewportRows || session.buffer.rows || 24));
  const missingRanges = normalizeReadingMissingRanges(renderDemand);
  return {
    ...buildBaseBufferSyncRequestPayload(session, viewportRows),
    viewportEndIndex: Math.max(0, Math.floor(renderDemand?.viewportEndIndex || session.buffer.bufferTailEndIndex || session.buffer.endIndex || 0)),
    viewportRows,
    mode: 'reading',
    prefetch: Boolean(renderDemand?.prefetch && missingRanges && missingRanges.length > 0),
    missingRanges,
  };
}

function buildSessionBufferSyncRequestPayload(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  options?: {
    purpose?: 'tail-refresh' | 'reading-repair';
    forceBootstrap?: boolean;
  },
): BufferSyncRequestPayload {
  const purpose = options?.purpose || (renderDemand?.mode === 'reading' ? 'reading-repair' : 'tail-refresh');
  return purpose === 'reading-repair'
    ? buildReadingBufferSyncRequestPayload(session, renderDemand)
    : buildTailRefreshBufferSyncRequestPayload(session, renderDemand, { forceBootstrap: options?.forceBootstrap });
}

function buildHostConfigMessage(
  host: Host,
  sessionName: string,
  viewport: { cols: number; rows: number },
): HostConfigMessage {
  return {
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName,
    cols: viewport.cols,
    rows: viewport.rows,
    authToken: host.authToken,
    autoCommand: host.autoCommand,
    authType: host.authType,
    password: host.password,
    privateKey: host.privateKey,
  };
}

function buildFollowRenderDemandState(session: Session, previousRenderDemand?: SessionRenderDemandState): SessionRenderDemandState {
  return {
    mode: 'follow',
    viewportRows: Math.max(1, Math.floor(previousRenderDemand?.viewportRows || session.buffer.rows || 24)),
    viewportEndIndex: Math.max(0, Math.floor(session.buffer.bufferTailEndIndex || session.buffer.endIndex || 0)),
    prefetch: false,
    missingRanges: [],
  };
}

function normalizeSessionRenderDemandState(renderDemand: SessionRenderDemandState): SessionRenderDemandState {
  const missingRanges = Array.isArray(renderDemand.missingRanges)
    ? renderDemand.missingRanges
        .map((range) => ({
          startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
          endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
        }))
        .filter((range) => range.endIndex > range.startIndex)
    : [];
  return {
    mode: renderDemand.mode === 'reading' ? 'reading' : 'follow',
    viewportEndIndex: Math.max(0, Math.floor(renderDemand.viewportEndIndex || 0)),
    viewportRows: Math.max(1, Math.floor(renderDemand.viewportRows || 1)),
    prefetch: renderDemand.mode === 'reading' ? Boolean(renderDemand.prefetch && missingRanges.length > 0) : false,
    missingRanges: renderDemand.mode === 'reading' ? missingRanges : [],
  };
}

function renderDemandStatesEqual(left?: SessionRenderDemandState, right?: SessionRenderDemandState) {
  if (!left || !right) {
    return false;
  }
  if (
    left.mode !== right.mode
    || left.viewportEndIndex !== right.viewportEndIndex
    || left.viewportRows !== right.viewportRows
    || Boolean(left.prefetch) !== Boolean(right.prefetch)
  ) {
    return false;
  }
  const leftRanges = left.missingRanges || [];
  const rightRanges = right.missingRanges || [];
  if (leftRanges.length !== rightRanges.length) {
    return false;
  }
  for (let index = 0; index < leftRanges.length; index += 1) {
    if (
      leftRanges[index]?.startIndex !== rightRanges[index]?.startIndex
      || leftRanges[index]?.endIndex !== rightRanges[index]?.endIndex
    ) {
      return false;
    }
  }
  return true;
}

function orderSessionsForReconnect(sessions: Session[], activeSessionId: string | null) {
  if (!activeSessionId) {
    return sessions;
  }
  return [...sessions].sort((left, right) => {
    if (left.id === activeSessionId) {
      return -1;
    }
    if (right.id === activeSessionId) {
      return 1;
    }
    return 0;
  });
}

export function SessionProvider({ children, wsUrl, terminalCacheLines = DEFAULT_TERMINAL_CACHE_LINES }: SessionProviderProps) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [scheduleStates, setScheduleStates] = React.useState<Record<string, SessionScheduleState>>({});
  const stateRef = useRef(state);
  const scheduleStatesRef = useRef<Record<string, SessionScheduleState>>({});
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const pingIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const queuedBufferSyncTimers = useRef<Map<string, number>>(new Map());
  // renderer -> worker declarative demand only; never producer/tail truth
  const sessionRenderDemandRef = useRef<Map<string, SessionRenderDemandState>>(new Map());
  const lastPongAtRef = useRef<Map<string, number>>(new Map());
  const sessionHostRef = useRef<Map<string, Host>>(new Map());
  const viewportSizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const reconnectBucketsRef = useRef<Map<string, ReconnectBucket>>(new Map());
  const manualCloseRef = useRef<Set<string>>(new Set());
  const pendingInputQueueRef = useRef<Map<string, string[]>>(new Map());
  const pendingIncomingBufferPayloadsRef = useRef<Map<string, TerminalBufferPayload[]>>(new Map());
  const pendingIncomingBufferTimersRef = useRef<Map<string, number>>(new Map());
  const lastActivatedSessionIdRef = useRef<string | null>(null);
  const sessionBufferHeadsRef = useRef<Map<string, SessionBufferHeadState>>(new Map());
  const sessionRevisionResetRef = useRef<Map<string, RevisionResetExpectation>>(new Map());
  const pendingTailRefreshDemandRef = useRef<Map<string, TailRefreshDemandState>>(new Map());
  const lastTailRefreshRequestAtRef = useRef<Map<string, number>>(new Map());
  const lastHeadStalePingAtRef = useRef<Map<string, number>>(new Map());
  const pendingTailRefreshAckTimersRef = useRef<Map<string, number>>(new Map());
  const pendingTailRefreshAckNonceRef = useRef<Map<string, number>>(new Map());
  const lastStreamModeSignatureRef = useRef('');
  const armTailRefreshAckWatchdogRef = useRef<(sessionId: string) => void>(() => undefined);

  const resolveSessionCacheLines = useCallback((rows?: number | null) => {
    const viewportRows =
      typeof rows === 'number' && Number.isFinite(rows)
        ? Math.max(1, Math.floor(rows))
        : getDefaultTerminalViewportSize().rows;
    const threeScreenLines = resolveTerminalCacheLines(viewportRows);
    if (!Number.isFinite(terminalCacheLines) || terminalCacheLines <= 0) {
      return threeScreenLines;
    }
    return Math.max(threeScreenLines, Math.floor(terminalCacheLines));
  }, [terminalCacheLines]);

  const flushRuntimeDebugLogs = useCallback(() => {
    if (!isRuntimeDebugEnabled() || getPendingRuntimeDebugEntryCount() === 0) {
      return;
    }

    const activeWs = stateRef.current.activeSessionId
      ? wsRefs.current.get(stateRef.current.activeSessionId) || null
      : null;
    const fallbackWs = [...wsRefs.current.values()].find((ws) => ws.readyState === WebSocket.OPEN) || null;
    const targetWs =
      activeWs && activeWs.readyState === WebSocket.OPEN
        ? activeWs
        : fallbackWs;
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    const entries = drainRuntimeDebugEntries();
    if (entries.length === 0) {
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'debug-log',
      payload: { entries },
    } satisfies ClientMessage));
  }, [resolveSessionCacheLines]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    scheduleStatesRef.current = scheduleStates;
  }, [scheduleStates]);

  const setScheduleStateForSession = useCallback((
    sessionId: string,
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => {
    setScheduleStates((current) => {
      const fallback = buildEmptyScheduleState(
        stateRef.current.sessions.find((session) => session.id === sessionId)?.sessionName || '',
      );
      const resolvedCurrent = current[sessionId] || fallback;
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
  }, []);

  const clearQueuedBufferSync = useCallback((sessionId: string) => {
    const timer = queuedBufferSyncTimers.current.get(sessionId);
    if (timer) {
      window.clearTimeout(timer);
      queuedBufferSyncTimers.current.delete(sessionId);
    }
  }, []);

  const clearPendingIncomingBuffer = useCallback((sessionId: string) => {
    const timer = pendingIncomingBufferTimersRef.current.get(sessionId);
    if (timer) {
      window.clearTimeout(timer);
      pendingIncomingBufferTimersRef.current.delete(sessionId);
    }
    pendingIncomingBufferPayloadsRef.current.delete(sessionId);
  }, []);

  const clearPendingTailRefreshAck = useCallback((sessionId: string) => {
    const timer = pendingTailRefreshAckTimersRef.current.get(sessionId);
    if (timer) {
      window.clearTimeout(timer);
      pendingTailRefreshAckTimersRef.current.delete(sessionId);
    }
    pendingTailRefreshAckNonceRef.current.delete(sessionId);
  }, []);

  const clearTailRefreshRuntime = useCallback((sessionId: string) => {
    pendingTailRefreshDemandRef.current.delete(sessionId);
    sessionBufferHeadsRef.current.delete(sessionId);
    sessionRevisionResetRef.current.delete(sessionId);
    lastTailRefreshRequestAtRef.current.delete(sessionId);
    lastHeadStalePingAtRef.current.delete(sessionId);
  }, []);

  const markTailRefreshDemand = useCallback((sessionId: string, reason: string, ttlMs?: number | null) => {
    const nextPriority = getTailRefreshDemandPriority(reason);
    const current = pendingTailRefreshDemandRef.current.get(sessionId);
    if (current && current.priority > nextPriority) {
      return;
    }
    const expireAt =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
        ? Date.now() + ttlMs
        : null;
    pendingTailRefreshDemandRef.current.set(sessionId, {
      reason,
      priority: nextPriority,
      expireAt,
    });
  }, []);

  const startSocketHeartbeat = useCallback((
    sessionId: string,
    ws: WebSocket,
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

      ws.send(JSON.stringify({ type: 'ping' }));
    }, CLIENT_PING_INTERVAL_MS);
    pingIntervals.current.set(sessionId, pingInterval);
  }, []);

  function buildConnectedSessionUpdates(sessionId: string) {
    const currentSession = stateRef.current.sessions.find((item) => item.id === sessionId);
    const currentFollowResetToken = currentSession?.followResetToken || 0;
    return {
      state: 'connected' as const,
      followResetToken:
        stateRef.current.activeSessionId === sessionId
          ? currentFollowResetToken + 1
          : currentFollowResetToken,
      reconnectAttempt: 0,
      lastError: undefined,
    };
  }

  function openSocketConnectHandshake(options: {
    sessionId: string;
    host: Host;
    ws: WebSocket;
    debugScope: 'connect' | 'reconnect';
    activate?: boolean;
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string; viewport: { cols: number; rows: number } }) => void;
  }) {
    const sessionName = getResolvedSessionName(options.host);
    const viewport = resolveInitialViewportSize(viewportSizeRef.current, options.sessionId);
    runtimeDebug(`session.ws.${options.debugScope}.onopen`, {
      sessionId: options.sessionId,
      viewport,
      activeSessionId: stateRef.current.activeSessionId,
      ...(options.debugScope === 'connect'
        ? { activate: Boolean(options.activate) }
        : { targetSessionName: sessionName }),
    });
    options.onBeforeConnectSend?.({ sessionName, viewport });
    options.ws.send(JSON.stringify({
      type: 'connect',
      payload: buildHostConfigMessage(options.host, sessionName, viewport),
    }));
    options.ws.send(JSON.stringify({
      type: 'stream-mode',
      payload: buildStreamModePayload(
        stateRef.current.activeSessionId === options.sessionId ? 'active' : 'idle',
      ),
    } satisfies ClientMessage));
    runtimeDebug(`session.ws.${options.debugScope}.connect-sent`, {
      sessionId: options.sessionId,
      viewport,
    });
    flushRuntimeDebugLogs();
    startSocketHeartbeat(options.sessionId, options.ws, options.finalizeFailure);
  }

  const requestSessionBufferSync = useCallback((sessionId: string, options?: {
    ws?: WebSocket | null;
    reason?: string;
    purpose?: 'tail-refresh' | 'reading-repair';
    forceBootstrap?: boolean;
  }) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    const targetWs = options?.ws || wsRefs.current.get(sessionId);
    if (!session || !targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return false;
    }

    const renderDemand = sessionRenderDemandRef.current.get(sessionId);
    const forceBootstrap = Boolean(
      options?.forceBootstrap
      || (
        (options?.purpose || (renderDemand?.mode === 'reading' ? 'reading-repair' : 'tail-refresh')) === 'tail-refresh'
        && renderDemand
        && shouldBootstrapTailRefreshRequest(
          session,
          renderDemand,
          resolveSessionCacheLines(renderDemand.viewportRows),
        )
      )
    );
    const payload = buildSessionBufferSyncRequestPayload(
      session,
      renderDemand,
      {
        purpose: options?.purpose,
        forceBootstrap,
      },
    );

    runtimeDebug(forceBootstrap ? 'session.buffer.bootstrap-request' : 'session.buffer.request', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      reason: options?.reason || null,
      purpose: options?.purpose || null,
      forceBootstrap,
      payload,
    });
    targetWs.send(JSON.stringify({
      type: 'buffer-sync-request',
      payload,
    } satisfies ClientMessage));
    return true;
  }, []);

  const requestActiveTailRefresh = useCallback((sessionId: string, reason: string) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    const ws = wsRefs.current.get(sessionId) || null;
    if (
      !session
      || stateRef.current.activeSessionId !== sessionId
      || session.state !== 'connected'
      || !ws
      || ws.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    if (pendingTailRefreshAckTimersRef.current.has(sessionId)) {
      markTailRefreshDemand(sessionId, reason);
      return false;
    }

    const cadence = resolveTerminalRefreshCadence();
    const now = Date.now();
    const lastRequestedAt = lastTailRefreshRequestAtRef.current.get(sessionId) || 0;
    if (now - lastRequestedAt < cadence.minTailRefreshGapMs) {
      markTailRefreshDemand(sessionId, reason);
      return false;
    }

    clearQueuedBufferSync(sessionId);
    const requested = requestSessionBufferSync(sessionId, {
      ws,
      reason,
      purpose: 'tail-refresh',
    });
    if (!requested) {
      return false;
    }

    runtimeDebug('session.buffer.active-tail-refresh', {
      sessionId,
      reason,
      activeSessionId: stateRef.current.activeSessionId,
      localRevision: session.buffer.revision,
      localStartIndex: session.buffer.startIndex,
      localEndIndex: session.buffer.endIndex,
      cadence,
    });
    lastTailRefreshRequestAtRef.current.set(sessionId, now);
    ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    armTailRefreshAckWatchdogRef.current(sessionId);
    return true;
  }, [clearQueuedBufferSync, markTailRefreshDemand, requestSessionBufferSync]);

  const flushPendingIncomingBuffer = useCallback((sessionId: string) => {
    pendingIncomingBufferTimersRef.current.delete(sessionId);
    const pendingPayloads = pendingIncomingBufferPayloadsRef.current.get(sessionId);
    if (!pendingPayloads || pendingPayloads.length === 0) {
      pendingIncomingBufferPayloadsRef.current.delete(sessionId);
      return;
    }
    pendingIncomingBufferPayloadsRef.current.delete(sessionId);

    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    const revisionResetExpectation = sessionRevisionResetRef.current.get(sessionId) || null;
    const lowerRevisionPayload = revisionResetExpectation
      ? pendingPayloads.find((payload) => Math.max(0, Math.floor(payload.revision || 0)) <= Math.max(0, Math.floor(session.buffer.revision || 0)))
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

    for (const payload of pendingPayloads) {
      nextBuffer = applyBufferSyncToSessionBuffer(
        nextBuffer,
        payload,
        resolveSessionCacheLines(payload.rows || nextBuffer.rows),
      );
    }

    if (
      revisionResetExpectation
      && nextBuffer.revision >= 0
    ) {
      sessionRevisionResetRef.current.delete(sessionId);
    }

    if (sessionBuffersEqual(session.buffer, nextBuffer)) {
      return;
    }

    dispatch({
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: { buffer: nextBuffer },
    });
  }, [resolveSessionCacheLines]);

  const queueIncomingBufferSync = useCallback((sessionId: string, payload: TerminalBufferPayload) => {
    const pending = pendingIncomingBufferPayloadsRef.current.get(sessionId) || [];
    pending.push(payload);
    pendingIncomingBufferPayloadsRef.current.set(sessionId, pending);

    if (pendingIncomingBufferTimersRef.current.has(sessionId)) {
      return;
    }

    const timer = window.setTimeout(() => {
      flushPendingIncomingBuffer(sessionId);
    }, BUFFER_RENDER_COMMIT_INTERVAL_MS);
    pendingIncomingBufferTimersRef.current.set(sessionId, timer);
  }, [flushPendingIncomingBuffer]);

  const clearReconnectForSession = useCallback((sessionId: string) => {
    const host = sessionHostRef.current.get(sessionId);
    if (!host) {
      return;
    }

    const hostKey = toHostKey(host);
    const bucket = reconnectBucketsRef.current.get(hostKey);
    if (!bucket) {
      return;
    }

    bucket.pending = bucket.pending.filter((item) => item !== sessionId);
    if (bucket.activeSessionId === sessionId) {
      if (bucket.timer) {
        clearTimeout(bucket.timer);
        bucket.timer = null;
      }
      bucket.activeSessionId = null;
    }

    if (!bucket.timer && !bucket.activeSessionId && bucket.pending.length === 0) {
      reconnectBucketsRef.current.delete(hostKey);
    }
  }, []);

  const cleanupSocket = useCallback((sessionId: string, shouldClose = false) => {
    const ws = wsRefs.current.get(sessionId);
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (shouldClose && ws.readyState < WebSocket.CLOSING) {
        ws.close();
      }
      wsRefs.current.delete(sessionId);
    }

    clearHeartbeat(sessionId);
    clearQueuedBufferSync(sessionId);
    clearPendingIncomingBuffer(sessionId);
    clearPendingTailRefreshAck(sessionId);
    clearTailRefreshRuntime(sessionId);
    sessionRenderDemandRef.current.delete(sessionId);
  }, [clearHeartbeat, clearPendingIncomingBuffer, clearPendingTailRefreshAck, clearQueuedBufferSync, clearTailRefreshRuntime]);

  const drainReconnectBucket = useCallback((hostKey: string) => {
    const bucket = reconnectBucketsRef.current.get(hostKey);
    if (!bucket || bucket.timer || bucket.activeSessionId || bucket.pending.length === 0) {
      return;
    }

    const nextSessionId = bucket.pending.shift() || null;
    if (!nextSessionId) {
      reconnectBucketsRef.current.delete(hostKey);
      return;
    }

    const host = sessionHostRef.current.get(nextSessionId);
    if (!host) {
      bucket.activeSessionId = null;
      drainReconnectBucket(hostKey);
      return;
    }

    bucket.activeSessionId = nextSessionId;
    const delay = bucket.nextDelayMs ?? computeReconnectDelay(bucket.attempt);
    bucket.nextDelayMs = null;
    bucket.timer = setTimeout(() => {
      bucket.timer = null;

      const targetHost = sessionHostRef.current.get(nextSessionId);
      if (!targetHost) {
        bucket.activeSessionId = null;
        drainReconnectBucket(hostKey);
        return;
      }

      dispatch({
        type: 'UPDATE_SESSION',
        id: nextSessionId,
        updates: {
          state: 'reconnecting',
          reconnectAttempt: bucket.attempt + 1,
        },
      });

      const ws = new WebSocket(buildBridgeUrl(targetHost, wsUrl));
      runtimeDebug('session.ws.reconnect.opening', {
        sessionId: nextSessionId,
        host: targetHost.bridgeHost,
        port: targetHost.bridgePort,
        sessionName: getResolvedSessionName(targetHost),
      });
      wsRefs.current.set(nextSessionId, ws);
      dispatch({ type: 'UPDATE_SESSION', id: nextSessionId, updates: { ws } });
      lastPongAtRef.current.set(nextSessionId, Date.now());

      let completed = false;
      const markCompleted = () => {
        if (completed) {
          return false;
        }
        completed = true;
        return true;
      };
      const finalizeFailure = (message: string, retryable: boolean) => {
        const baseline = finalizeSocketFailureBaseline({
          sessionId: nextSessionId,
          message,
          markCompleted,
        });
        if (!baseline.shouldContinue) {
          bucket.activeSessionId = null;
          return;
        }

        if (!retryable) {
          bucket.activeSessionId = null;
          dispatch({
            type: 'UPDATE_SESSION',
            id: nextSessionId,
            updates: {
              state: 'error',
              lastError: message,
            },
          });
          emitSessionStatus(nextSessionId, 'error', message);
          drainReconnectBucket(hostKey);
          return;
        }

        bucket.attempt = Math.min(bucket.attempt + 1, 6);
        bucket.activeSessionId = null;
        if (!bucket.pending.includes(nextSessionId)) {
          bucket.pending.push(nextSessionId);
        }

        dispatch({
          type: 'UPDATE_SESSION',
          id: nextSessionId,
          updates: {
            state: 'reconnecting',
            lastError: message,
            reconnectAttempt: bucket.attempt,
            ws: null,
          },
        });
        emitSessionStatus(nextSessionId, 'error', message);
        drainReconnectBucket(hostKey);
      };

      ws.onopen = () => {
        openSocketConnectHandshake({
          sessionId: nextSessionId,
          host: targetHost,
          ws,
          debugScope: 'reconnect',
          finalizeFailure,
          onBeforeConnectSend: ({ sessionName }) => {
            dispatch({
              type: 'UPDATE_SESSION',
              id: nextSessionId,
              updates: {
                state: 'connecting',
                sessionName,
              },
            });
            setScheduleStateForSession(nextSessionId, {
              sessionName,
              jobs: [],
              loading: true,
            });
          },
        });
      };

      ws.onmessage = (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          handleSocketServerMessage({
            sessionId: nextSessionId,
            host: targetHost,
            ws,
            debugScope: 'reconnect',
            onConnected: () => {
              if (completed) return;
              completed = true;
              const connectedSessionName = getResolvedSessionName(targetHost);
              runtimeDebug('session.ws.reconnect.connected', {
                sessionId: nextSessionId,
                activeSessionId: stateRef.current.activeSessionId,
              });
              bucket.attempt = 0;
              bucket.activeSessionId = null;
              handleSocketConnectedBaseline({
                sessionId: nextSessionId,
                sessionName: connectedSessionName,
                ws,
                bootstrapReason: 'reconnect-open',
              });
              flushPendingInputQueue(nextSessionId);
              setTimeout(() => drainReconnectBucket(hostKey), POST_SUCCESS_NEXT_RETRY_DELAY_MS);
            },
            onFailure: finalizeFailure,
          }, msg);
        } catch (error) {
          finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
        }
      };

      ws.onerror = () => finalizeFailure('WebSocket error', true);
      ws.onclose = () => finalizeFailure('socket closed', true);
    }, delay);
  }, [cleanupSocket, clearPendingTailRefreshAck, requestSessionBufferSync, resolveSessionCacheLines, wsUrl]);

  const scheduleReconnect = useCallback((
    sessionId: string,
    message: string,
    retryable = true,
    options?: { immediate?: boolean; resetAttempt?: boolean },
  ) => {
    const host = sessionHostRef.current.get(sessionId);
    if (!host) {
      return;
    }

    const hostKey = toHostKey(host);
    const bucket = reconnectBucketsRef.current.get(hostKey) || createReconnectBucket();
    reconnectBucketsRef.current.set(hostKey, bucket);

    if (options?.resetAttempt) {
      bucket.attempt = 0;
    }
    if (options?.immediate) {
      bucket.nextDelayMs = 0;
    }

    if (!retryable) {
      dispatch({
        type: 'UPDATE_SESSION',
        id: sessionId,
        updates: {
          state: 'error',
          lastError: message,
          ws: null,
        },
      });
      emitSessionStatus(sessionId, 'error', message);
      return;
    }

    if (bucket.activeSessionId !== sessionId && !bucket.pending.includes(sessionId)) {
      bucket.pending.push(sessionId);
    }

    dispatch({
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: {
        state: 'reconnecting',
        lastError: message,
        ws: null,
      },
    });
    emitSessionStatus(sessionId, 'error', message);
    drainReconnectBucket(hostKey);
  }, [drainReconnectBucket]);

  const armTailRefreshAckWatchdog = useCallback((sessionId: string) => {
    clearPendingTailRefreshAck(sessionId);
    const nextNonce = (pendingTailRefreshAckNonceRef.current.get(sessionId) || 0) + 1;
    pendingTailRefreshAckNonceRef.current.set(sessionId, nextNonce);
    const timer = window.setTimeout(() => {
      const currentNonce = pendingTailRefreshAckNonceRef.current.get(sessionId);
      if (currentNonce !== nextNonce) {
        return;
      }

      const currentSession = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
      const currentWs = wsRefs.current.get(sessionId);
      const isStillActive = stateRef.current.activeSessionId === sessionId;
      if (!currentSession || currentSession.state !== 'connected' || !currentWs || currentWs.readyState !== WebSocket.OPEN || !isStillActive) {
        clearPendingTailRefreshAck(sessionId);
        return;
      }

      runtimeDebug('session.buffer.tail-refresh.timeout', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        revision: currentSession.buffer.revision,
        startIndex: currentSession.buffer.startIndex,
        endIndex: currentSession.buffer.endIndex,
      });
      cleanupSocket(sessionId, true);
      scheduleReconnect(sessionId, 'tail refresh timeout', true, { immediate: true, resetAttempt: true });
    }, ACTIVE_TAIL_REFRESH_ACK_TIMEOUT_MS);
    pendingTailRefreshAckTimersRef.current.set(sessionId, timer);
  }, [clearPendingTailRefreshAck, cleanupSocket, scheduleReconnect]);
  armTailRefreshAckWatchdogRef.current = armTailRefreshAckWatchdog;

  const connectSession = useCallback((sessionId: string, host: Host, activate: boolean) => {
    clearReconnectForSession(sessionId);
    cleanupSocket(sessionId, true);
    manualCloseRef.current.delete(sessionId);
    sessionHostRef.current.set(sessionId, { ...host, sessionName: getResolvedSessionName(host) });
    dispatch({
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: {
        hostId: host.id,
        connectionName: host.name,
        bridgeHost: host.bridgeHost,
        bridgePort: host.bridgePort,
        sessionName: getResolvedSessionName(host),
        authToken: host.authToken,
        autoCommand: host.autoCommand,
        state: 'connecting',
        reconnectAttempt: 0,
        lastError: undefined,
      },
    });
    setScheduleStateForSession(sessionId, {
      sessionName: getResolvedSessionName(host),
      jobs: [],
      loading: true,
    });
    if (activate) {
      dispatch({ type: 'SET_ACTIVE_SESSION', id: sessionId });
    }

    const ws = new WebSocket(buildBridgeUrl(host, wsUrl));
    runtimeDebug('session.ws.connect.opening', {
      sessionId,
      host: host.bridgeHost,
      port: host.bridgePort,
      sessionName: getResolvedSessionName(host),
      activate,
    });
    wsRefs.current.set(sessionId, ws);
    dispatch({ type: 'UPDATE_SESSION', id: sessionId, updates: { ws } });
    lastPongAtRef.current.set(sessionId, Date.now());

    let completed = false;
    const markCompleted = () => {
      if (completed) {
        return false;
      }
      completed = true;
      return true;
    };
    const finalizeFailure = (message: string, retryable: boolean) => {
      const baseline = finalizeSocketFailureBaseline({
        sessionId,
        message,
        markCompleted,
      });
      if (!baseline.shouldContinue) {
        return;
      }
      scheduleReconnect(sessionId, message, retryable);
    };

    ws.onopen = () => {
      openSocketConnectHandshake({
        sessionId,
        host,
        ws,
        debugScope: 'connect',
        activate,
        finalizeFailure,
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        handleSocketServerMessage({
          sessionId,
          host,
          ws,
          debugScope: 'connect',
          onConnected: () => {
            if (completed) return;
            completed = true;
            const connectedSessionName = getResolvedSessionName(host);
            runtimeDebug('session.ws.connected', {
              sessionId,
              activeSessionId: stateRef.current.activeSessionId,
            });
            handleSocketConnectedBaseline({
              sessionId,
              sessionName: connectedSessionName,
              ws,
              bootstrapReason: 'connect-open',
            });
          },
          onFailure: finalizeFailure,
        }, msg);
      } catch (error) {
        finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
      }
    };

    ws.onerror = () => finalizeFailure('WebSocket error', true);
    ws.onclose = () => finalizeFailure('socket closed', true);
  }, [armTailRefreshAckWatchdog, cleanupSocket, clearPendingTailRefreshAck, clearReconnectForSession, requestSessionBufferSync, resolveSessionCacheLines, scheduleReconnect, wsUrl]);

  const createSession = useCallback((host: Host, options?: CreateSessionOptions): string => {
    const sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const sessionName = getResolvedSessionName(host);
    const session: Session = {
      id: sessionId,
      hostId: host.id,
      connectionName: host.name,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      sessionName,
      authToken: host.authToken,
      autoCommand: host.autoCommand,
      title: options?.customName?.trim() || sessionName,
      ws: null,
      state: 'connecting',
      hasUnread: false,
      customName: options?.customName?.trim() || undefined,
      buffer: options?.buffer || createSessionBufferState({
        lines: [],
        cacheLines: resolveSessionCacheLines(getDefaultTerminalViewportSize().rows),
      }),
      followResetToken: 0,
      reconnectAttempt: 0,
      createdAt: options?.createdAt || Date.now(),
    };

    dispatch({ type: 'CREATE_SESSION', session, activate: options?.activate !== false });
    connectSession(sessionId, host, options?.activate !== false);
    return sessionId;
  }, [connectSession, resolveSessionCacheLines]);

  const closeSession = useCallback((id: string) => {
    manualCloseRef.current.add(id);
    pendingInputQueueRef.current.delete(id);
    clearReconnectForSession(id);

    const ws = wsRefs.current.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'close' }));
    }
    cleanupSocket(id, true);
    sessionHostRef.current.delete(id);
    viewportSizeRef.current.delete(id);
    setScheduleStates((current) => {
      if (!(id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
    dispatch({ type: 'DELETE_SESSION', id });
  }, [cleanupSocket, clearReconnectForSession]);

  const switchSession = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_SESSION', id }), []);

  const moveSession = useCallback((id: string, toIndex: number) => {
    dispatch({ type: 'MOVE_SESSION', id, toIndex });
  }, []);

  const renameSession = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    const current = stateRef.current.sessions.find((session) => session.id === id);
    if (!current) {
      return;
    }

    dispatch({
      type: 'UPDATE_SESSION',
      id,
      updates: {
        customName: trimmed || undefined,
        title: trimmed || current.sessionName,
      },
    });
  }, []);

  const reconnectSession = useCallback((id: string) => {
    clearReconnectForSession(id);
    const current = stateRef.current.sessions.find((session) => session.id === id);
    const knownHost = sessionHostRef.current.get(id);
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
    });
    console.debug('[SessionContext] reconnect session ->', {
      sessionId: id,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      sessionName: host.sessionName,
    });

    cleanupSocket(id, true);
    manualCloseRef.current.delete(id);
    sessionHostRef.current.set(id, { ...host, sessionName: getResolvedSessionName(host) });
    dispatch({
      type: 'UPDATE_SESSION',
      id,
      updates: {
        hostId: host.id,
        connectionName: host.name,
        bridgeHost: host.bridgeHost,
        bridgePort: host.bridgePort,
        sessionName: getResolvedSessionName(host),
        authToken: host.authToken,
        autoCommand: host.autoCommand,
        state: 'reconnecting',
        reconnectAttempt: 0,
        lastError: undefined,
        ws: null,
      },
    });

    if (stateRef.current.activeSessionId === id) {
      dispatch({ type: 'SET_ACTIVE_SESSION', id });
    }

    scheduleReconnect(id, 'manual reconnect', true, { immediate: true, resetAttempt: true });
  }, [cleanupSocket, clearReconnectForSession, scheduleReconnect]);

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

  const sendMessage = useCallback((sessionId: string, msg: ClientMessage) => {
    const ws = wsRefs.current.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const sendSessionStreamMode = useCallback((sessionId: string, mode: 'active' | 'idle', wsOverride?: WebSocket | null) => {
    const ws = wsOverride || wsRefs.current.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify({
      type: 'stream-mode',
      payload: buildStreamModePayload(mode),
    } satisfies ClientMessage));
    return true;
  }, []);

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

  const handleBufferHead = useCallback((sessionId: string, latestRevision: number, latestEndIndex: number) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    const ws = wsRefs.current.get(sessionId);
    if (!session || session.state !== 'connected' || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    sessionBufferHeadsRef.current.set(sessionId, {
      revision: latestRevision,
      latestEndIndex,
      seenAt: Date.now(),
    });
    if (stateRef.current.activeSessionId !== sessionId) {
      return;
    }

    const localRevision = Math.max(0, Math.floor(session.buffer.revision || 0));
    const localEndIndex = Math.max(0, Math.floor(session.buffer.endIndex || 0));
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

    if (!revisionResetDetected && localRevision >= latestRevision && localEndIndex >= latestEndIndex) {
      pendingTailRefreshDemandRef.current.delete(sessionId);
      return;
    }

    runtimeDebug('session.buffer.head', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      latestRevision,
      latestEndIndex,
      localRevision,
      localEndIndex,
      renderDemand: sessionRenderDemandRef.current.get(sessionId) || null,
    });
    markTailRefreshDemand(sessionId, 'active-head-refresh');
    requestActiveTailRefresh(sessionId, 'active-head-refresh');
  }, [markTailRefreshDemand, requestActiveTailRefresh]);

  const handleSocketServerMessage = useCallback((options: {
    sessionId: string;
    host: Host;
    ws: WebSocket;
    debugScope: 'connect' | 'reconnect';
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
  }, msg: ServerMessage) => {
    switch (msg.type) {
      case 'connected':
        options.onConnected();
        break;
      case 'buffer-sync':
        clearPendingTailRefreshAck(options.sessionId);
        {
          const currentSession = stateRef.current.sessions.find((item) => item.id === options.sessionId) || null;
          const localRevision = Math.max(0, Math.floor(currentSession?.buffer.revision || 0));
          const localEndIndex = Math.max(0, Math.floor(currentSession?.buffer.endIndex || 0));
          const incomingRevision = Math.max(0, Math.floor(msg.payload.revision || 0));
          const incomingEndIndex = Math.max(0, Math.floor(msg.payload.endIndex || 0));
          if (
            incomingRevision > localRevision
            || (incomingRevision === localRevision && incomingEndIndex > localEndIndex)
          ) {
            pendingTailRefreshDemandRef.current.delete(options.sessionId);
          }
        }
        runtimeDebug(`session.ws.${options.debugScope}.buffer-sync`, {
          sessionId: options.sessionId,
          payload: summarizeBufferPayload(msg.payload),
          activeSessionId: stateRef.current.activeSessionId,
        });
        queueIncomingBufferSync(options.sessionId, normalizeIncomingBufferPayload(msg.payload));
        break;
      case 'buffer-head':
        handleBufferHead(
          options.sessionId,
          Math.max(0, Math.floor(msg.payload.revision || 0)),
          Math.max(0, Math.floor(msg.payload.latestEndIndex || 0)),
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
        dispatch({ type: 'SET_SESSION_TITLE', id: options.sessionId, title: msg.payload });
        break;
      case 'image-pasted':
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
        clearPendingTailRefreshAck(options.sessionId);
        lastPongAtRef.current.set(options.sessionId, Date.now());
        break;
    }
  }, [clearPendingTailRefreshAck, handleBufferHead, queueIncomingBufferSync, setScheduleStateForSession]);

  const handleSocketConnectedBaseline = useCallback((options: {
    sessionId: string;
    sessionName: string;
    ws: WebSocket;
    bootstrapReason: 'connect-open' | 'reconnect-open';
  }) => {
    dispatch({
      type: 'UPDATE_SESSION',
      id: options.sessionId,
      updates: buildConnectedSessionUpdates(options.sessionId),
    });
    setScheduleStateForSession(options.sessionId, (current) => ({
      ...current,
      sessionName: options.sessionName,
      loading: true,
      error: undefined,
    }));
    options.ws.send(JSON.stringify({
      type: 'schedule-list',
      payload: { sessionName: options.sessionName },
    } satisfies ClientMessage));
    const isActive = stateRef.current.activeSessionId === options.sessionId;
    if (isActive) {
      requestSessionBufferSync(options.sessionId, {
        ws: options.ws,
        reason: options.bootstrapReason,
        purpose: 'tail-refresh',
      });
      options.ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
      armTailRefreshAckWatchdogRef.current(options.sessionId);
    }
    dispatch({ type: 'INCREMENT_CONNECTED' });
  }, [requestSessionBufferSync, setScheduleStateForSession]);

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
  }, [cleanupSocket, setScheduleStateForSession]);

  const resetSessionViewportToFollow = useCallback((sessionId: string) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    const ws = wsRefs.current.get(sessionId);
    if (!session || session.state !== 'connected' || !ws || ws.readyState !== WebSocket.OPEN) {
      runtimeDebug('session.buffer.follow-reset.skip', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        hasSession: Boolean(session),
        sessionState: session?.state ?? null,
        wsReadyState: ws?.readyState ?? null,
      });
      return false;
    }

    const followRenderDemand = buildFollowRenderDemandState(
      session,
      sessionRenderDemandRef.current.get(sessionId),
    );
    sessionRenderDemandRef.current.set(sessionId, followRenderDemand);

    const isActive = stateRef.current.activeSessionId === sessionId;
    clearQueuedBufferSync(sessionId);
    runtimeDebug('session.buffer.follow-reset', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      viewportRows: followRenderDemand.viewportRows,
      isActive,
      localRevision: session.buffer.revision,
      localStartIndex: session.buffer.startIndex,
      localEndIndex: session.buffer.endIndex,
    });
    if (isActive) {
      dispatch({
        type: 'UPDATE_SESSION',
        id: sessionId,
        updates: {
          followResetToken: (session.followResetToken || 0) + 1,
        },
      });
      requestSessionBufferSync(sessionId, {
        ws,
        reason: 'follow-reset',
        purpose: 'tail-refresh',
      });
      ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
      armTailRefreshAckWatchdog(sessionId);
    }
    return true;
  }, [armTailRefreshAckWatchdog, clearQueuedBufferSync, requestSessionBufferSync]);

  const scheduleReadingRepairRequest = useCallback((sessionId: string, options?: {
    delayMs?: number;
    reason?: string;
  }) => {
    clearQueuedBufferSync(sessionId);
    const timer = window.setTimeout(() => {
      queuedBufferSyncTimers.current.delete(sessionId);
      requestSessionBufferSync(sessionId, {
        reason: options?.reason || 'scheduled-reading-sync',
        purpose: 'reading-repair',
      });
    }, Math.max(0, options?.delayMs ?? 0));
    queuedBufferSyncTimers.current.set(sessionId, timer);
  }, [clearQueuedBufferSync, requestSessionBufferSync]);

  const applyActiveSessionRenderDemand = useCallback((sessionId: string, renderDemand: SessionRenderDemandState) => {
    if (renderDemand.mode === 'reading') {
      const cadence = resolveTerminalRefreshCadence();
      scheduleReadingRepairRequest(sessionId, {
        delayMs: cadence.readingSyncDelayMs,
        reason: 'scheduled-reading-sync',
      });
      return;
    }
    clearQueuedBufferSync(sessionId);
  }, [clearQueuedBufferSync, scheduleReadingRepairRequest]);

  const updateSessionViewport = useCallback((sessionId: string, renderDemand: SessionRenderDemandState) => {
    const normalized = normalizeSessionRenderDemandState(renderDemand);
    const previous = sessionRenderDemandRef.current.get(sessionId);
    if (renderDemandStatesEqual(previous, normalized)) {
      return;
    }
    sessionRenderDemandRef.current.set(sessionId, normalized);
    if (stateRef.current.activeSessionId !== sessionId) {
      return;
    }
    applyActiveSessionRenderDemand(sessionId, normalized);
  }, [applyActiveSessionRenderDemand]);

  useEffect(() => {
    const signature = JSON.stringify({
      activeSessionId: state.activeSessionId,
      sessionIds: state.sessions.map((session) => session.id),
    });
    if (lastStreamModeSignatureRef.current === signature) {
      return;
    }
    lastStreamModeSignatureRef.current = signature;
    for (const session of state.sessions) {
      sendSessionStreamMode(
        session.id,
        state.activeSessionId === session.id ? 'active' : 'idle',
      );
    }
  }, [sendSessionStreamMode, state.activeSessionId, state.sessions]);

  const exitReadingOnUserInput = useCallback((sessionId: string, session: Session) => {
    if (stateRef.current.activeSessionId !== sessionId) {
      return false;
    }

    const previousRenderDemand = sessionRenderDemandRef.current.get(sessionId);
    if (!previousRenderDemand || previousRenderDemand.mode !== 'reading') {
      return false;
    }

    const followRenderDemand = buildFollowRenderDemandState(session, previousRenderDemand);
    sessionRenderDemandRef.current.set(sessionId, followRenderDemand);
    clearQueuedBufferSync(sessionId);
    dispatch({
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: {
        followResetToken: (session.followResetToken || 0) + 1,
      },
    });
    runtimeDebug('session.buffer.input-follow-reset', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      previousRenderDemand,
      nextRenderDemand: followRenderDemand,
      localRevision: session.buffer.revision,
      localStartIndex: session.buffer.startIndex,
      localEndIndex: session.buffer.endIndex,
    });
    return true;
  }, [clearQueuedBufferSync]);

  useEffect(() => {
    if (!state.activeSessionId) {
      lastActivatedSessionIdRef.current = null;
      return;
    }
    if (lastActivatedSessionIdRef.current === state.activeSessionId) {
      return;
    }
    lastActivatedSessionIdRef.current = state.activeSessionId;
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
    if (activeSession) {
      sessionRenderDemandRef.current.set(
        state.activeSessionId,
        buildFollowRenderDemandState(activeSession, sessionRenderDemandRef.current.get(state.activeSessionId)),
      );
    }
    const currentActiveSession = state.sessions.find((session) => session.id === state.activeSessionId) || null;
    if (currentActiveSession?.state === 'connected') {
      resetSessionViewportToFollow(state.activeSessionId);
      return;
    }
    scheduleReadingRepairRequest(state.activeSessionId, {
      delayMs: 0,
      reason: 'active-session-sync',
    });
  }, [resetSessionViewportToFollow, scheduleReadingRepairRequest, state.activeSessionId, state.sessions]);

  const flushPendingInputQueue = useCallback((sessionId: string) => {
    const ws = wsRefs.current.get(sessionId);
    const queued = pendingInputQueueRef.current.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN || !queued || queued.length === 0) {
      return;
    }

    pendingInputQueueRef.current.delete(sessionId);
    for (const payload of queued) {
      ws.send(JSON.stringify({ type: 'input', payload }));
    }
  }, []);

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
    const timer = window.setInterval(() => {
      const activeSessionId = stateRef.current.activeSessionId;
      if (!activeSessionId) {
        return;
      }

      const session = stateRef.current.sessions.find((item) => item.id === activeSessionId) || null;
      const ws = wsRefs.current.get(activeSessionId) || null;
      if (
        !session
        || session.state !== 'connected'
        || !ws
        || ws.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      const headState = sessionBufferHeadsRef.current.get(activeSessionId) || null;
      const localRevision = Math.max(0, Math.floor(session.buffer.revision || 0));
      const localEndIndex = Math.max(0, Math.floor(session.buffer.endIndex || 0));
      const now = Date.now();
      const rawPendingDemand = pendingTailRefreshDemandRef.current.get(activeSessionId) || null;
      const pendingDemand =
        rawPendingDemand && rawPendingDemand.expireAt && rawPendingDemand.expireAt <= now
          ? (pendingTailRefreshDemandRef.current.delete(activeSessionId), null)
          : rawPendingDemand;
      const headAhead = Boolean(
        headState
        && (headState.revision > localRevision || headState.latestEndIndex > localEndIndex),
      );

      if (pendingDemand || headAhead) {
        requestActiveTailRefresh(
          activeSessionId,
          pendingDemand?.reason || 'active-head-refresh',
        );
        return;
      }

      if (!headState) {
        return;
      }

      const cadence = resolveTerminalRefreshCadence();
      const lastPingAt = lastHeadStalePingAtRef.current.get(activeSessionId) || 0;
      if (now - headState.seenAt < cadence.headStalePingMs || now - lastPingAt < cadence.headStalePingMs) {
        return;
      }

      runtimeDebug('session.buffer.head-stale-ping', {
        sessionId: activeSessionId,
        activeSessionId: stateRef.current.activeSessionId,
        headSeenAt: headState.seenAt,
        localRevision,
        localEndIndex,
        cadence,
      });
      lastHeadStalePingAtRef.current.set(activeSessionId, now);
      ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    }, ACTIVE_HEAD_REFRESH_TICK_MS);

    return () => window.clearInterval(timer);
  }, [requestActiveTailRefresh]);

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

    const ws = wsRefs.current.get(targetSessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      runtimeDebug('session.input.send', {
        sessionId: targetSessionId,
        size: data.length,
        preview: data.slice(0, 32),
      });
      ws.send(JSON.stringify({ type: 'input', payload: data }));
      if (stateRef.current.activeSessionId === targetSessionId && session.state === 'connected') {
        const forcedFollow = exitReadingOnUserInput(targetSessionId, session);
        markTailRefreshDemand(targetSessionId, 'input-tail-refresh', 420);
        requestActiveTailRefresh(targetSessionId, forcedFollow ? 'input-follow-reset' : 'input-tail-refresh');
      }
      return;
    }

    runtimeDebug('session.input.queue', {
      sessionId: targetSessionId,
      size: data.length,
      preview: data.slice(0, 32),
    });
    enqueuePendingInput(targetSessionId, data);
  }, [enqueuePendingInput, exitReadingOnUserInput, markTailRefreshDemand, requestActiveTailRefresh]);

  const ensureSessionReadyForPaste = useCallback(async (sessionId: string, timeoutMs = IMAGE_PASTE_READY_TIMEOUT_MS) => {
    const readReadyState = () => {
      const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
      const ws = wsRefs.current.get(sessionId) || null;
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

    ws.send(JSON.stringify({
      type: 'paste-image-start',
      payload,
    } satisfies ClientMessage));
    ws.send(fileBuffer);
  }, [ensureSessionReadyForPaste, sendMessage]);

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

  const getActiveSession = useCallback(
    () => stateRef.current.sessions.find((session) => session.id === stateRef.current.activeSessionId) || null,
    [],
  );

  const getSession = useCallback((id: string) => stateRef.current.sessions.find((session) => session.id === id) || null, []);

  const getSessionScheduleState = useCallback((sessionId: string) => {
    return scheduleStatesRef.current[sessionId]
      || buildEmptyScheduleState(stateRef.current.sessions.find((session) => session.id === sessionId)?.sessionName || '');
  }, []);

  useEffect(() => () => {
    for (const timer of queuedBufferSyncTimers.current.values()) {
      window.clearTimeout(timer);
    }
    for (const timer of pingIntervals.current.values()) {
      clearInterval(timer);
    }
    for (const bucket of reconnectBucketsRef.current.values()) {
      if (bucket.timer) {
        clearTimeout(bucket.timer);
      }
    }
    for (const ws of wsRefs.current.values()) {
      ws.close();
    }
  }, []);

  const value: SessionContextValue = {
    state,
    scheduleStates,
    createSession,
    closeSession,
    switchSession,
    moveSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    resetSessionViewportToFollow,
    sendMessage,
    sendInput,
    sendImagePaste,
    resizeTerminal,
    updateSessionViewport,
    requestScheduleList,
    upsertScheduleJob,
    deleteScheduleJob,
    toggleScheduleJob,
    runScheduleJobNow,
    getSessionScheduleState,
    getActiveSession,
    getSession,
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
