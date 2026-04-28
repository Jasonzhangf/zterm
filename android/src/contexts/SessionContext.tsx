/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import type {
  BufferHeadPayload,
  BufferSyncRequestPayload,
  ClientMessage,
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  Host,
  HostConfigMessage,
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
  TerminalViewportState,
  SessionState,
  TerminalBufferPayload,
  TerminalCell,
  TerminalGapRange,
  TerminalWidthMode,
} from '../lib/types';
import { buildEmptyScheduleState } from '@zterm/shared';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from '../lib/bridge-settings';
import { getResolvedSessionName } from '../lib/connection-target';
import {
  ACTIVE_HEAD_REFRESH_TICK_MS,
  DEFAULT_TERMINAL_CACHE_LINES,
  resolveTerminalRequestWindowLines,
  resolveTerminalRefreshCadence,
} from '../lib/mobile-config';
import { drainRuntimeDebugEntries, getPendingRuntimeDebugEntryCount, isRuntimeDebugEnabled, runtimeDebug, setRuntimeDebugEnabled } from '../lib/runtime-debug';
import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  normalizeWireLines,
  sessionBuffersEqual,
} from '../lib/terminal-buffer';
import { resolveTraversalConfigFromHost } from '../lib/traversal/config';
import { TraversalSocket } from '../lib/traversal/socket';
import type { BridgeTransportSocket } from '../lib/traversal/types';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;
const SESSION_HANDSHAKE_TIMEOUT_MS = 4000;
const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;
const ACTIVE_TRANSPORT_STALE_ACTIVITY_MS = CLIENT_PING_INTERVAL_MS + 5000;
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

interface SessionContextValue {
  state: SessionManagerState;
  scheduleStates: Record<string, SessionScheduleState>;
  sessionDebugMetrics: Record<string, SessionDebugOverlayMetrics | undefined>;
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
  updateSessionViewport: (sessionId: string, renderDemand: SessionRenderDemandState) => void;
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

interface SessionBufferHeadState {
  revision: number;
  latestEndIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  seenAt: number;
}

interface RevisionResetExpectation {
  revision: number;
  latestEndIndex: number;
  seenAt: number;
}

interface SessionReconnectDecisionOptions {
  hasSession: boolean;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
}

interface SessionWireStatsSnapshot {
  txBytes: number;
  rxBytes: number;
  renderCommits: number;
  pullRequests: number;
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

type SessionPullPurpose = 'tail-refresh' | 'reading-repair';

interface SessionPullState {
  purpose: SessionPullPurpose;
  startedAt: number;
  targetHeadRevision: number;
  targetStartIndex: number;
  targetEndIndex: number;
}

type SessionPullStates = Partial<Record<SessionPullPurpose, SessionPullState>>;

type SessionRenderDemandState = TerminalViewportState;

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
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

export function shouldReconnectActivatedSession(options: SessionReconnectDecisionOptions) {
  const transportClosed = (
    options.wsReadyState === null
    || options.wsReadyState === WebSocket.CLOSING
    || options.wsReadyState === WebSocket.CLOSED
  );
  return options.hasSession && transportClosed && !options.reconnectInFlight;
}

export function shouldReconnectQueuedActiveInput(options: {
  isActiveTarget: boolean;
  wsReadyState: number | null;
  reconnectInFlight: boolean;
}) {
  const transportClosed = (
    options.wsReadyState === null
    || options.wsReadyState === WebSocket.CLOSING
    || options.wsReadyState === WebSocket.CLOSED
  );
  return options.isActiveTarget && transportClosed && !options.reconnectInFlight;
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

function normalizeTerminalCursorState(
  input: TerminalBufferPayload['cursor'] | BufferHeadPayload['cursor'],
): TerminalCursorState | null {
  return input && typeof input === 'object'
    ? {
        rowIndex: typeof input.rowIndex === 'number' && Number.isFinite(input.rowIndex)
          ? Math.max(0, Math.floor(input.rowIndex))
          : 0,
        col: typeof input.col === 'number' && Number.isFinite(input.col)
          ? Math.max(0, Math.floor(input.col))
          : 0,
        visible: Boolean(input.visible),
      }
    : null;
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

  return {
    revision:
      typeof input.revision === 'number' && Number.isFinite(input.revision)
        ? input.revision
        : 0,
    startIndex,
    endIndex,
    availableStartIndex:
      typeof input.availableStartIndex === 'number' && Number.isFinite(input.availableStartIndex)
        ? Math.max(0, Math.floor(input.availableStartIndex))
        : undefined,
    availableEndIndex:
      typeof input.availableEndIndex === 'number' && Number.isFinite(input.availableEndIndex)
        ? Math.max(startIndex, Math.floor(input.availableEndIndex))
        : undefined,
    cols:
      typeof input.cols === 'number' && Number.isFinite(input.cols)
        ? Math.max(1, Math.floor(input.cols))
        : 80,
    rows,
    cursorKeysApp: Boolean(input.cursorKeysApp),
    cursor: normalizeTerminalCursorState(input.cursor),
    lines: Array.isArray(input.lines)
      ? normalizeWireLines(input.lines, typeof input.cols === 'number' && Number.isFinite(input.cols) ? Math.max(1, Math.floor(input.cols)) : 80)
          .map((line) => ({
            index: line.index,
            cells: normalizeTerminalCellRow(line.cells),
          }))
      : [],
  };
}

function buildBaseBufferSyncRequestPayload(
  session: Session,
): Pick<
  BufferSyncRequestPayload,
  'knownRevision' | 'localStartIndex' | 'localEndIndex'
> {
  return {
    knownRevision: Math.max(0, Math.floor(session.buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(session.buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(session.buffer.endIndex || 0)),
  };
}

function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const cacheLines = resolveTerminalRequestWindowLines(safeViewportRows);
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - cacheLines);
  return {
    requestStartIndex,
    requestEndIndex,
  };
}

function resolveVisibleViewportWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - safeViewportRows);
  return {
    requestStartIndex,
    requestEndIndex,
  };
}

function resolveDemandViewportRows(
  session: Session,
  renderDemand?: SessionRenderDemandState,
) {
  if (typeof renderDemand?.viewportRows === 'number' && Number.isFinite(renderDemand.viewportRows) && renderDemand.viewportRows > 0) {
    return Math.max(1, Math.floor(renderDemand.viewportRows));
  }
  if (typeof session.buffer.rows === 'number' && Number.isFinite(session.buffer.rows) && session.buffer.rows > 0) {
    return Math.max(1, Math.floor(session.buffer.rows));
  }
  throw new Error(`Session ${session.id} is missing viewportRows truth for buffer request`);
}

function mergeGapRanges(ranges: TerminalGapRange[]) {
  if (ranges.length <= 1) {
    return ranges;
  }
  const sorted = [...ranges]
    .map((range) => ({
      startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
      endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
    }))
    .filter((range) => range.endIndex > range.startIndex)
    .sort((left, right) => left.startIndex - right.startIndex);
  const merged: TerminalGapRange[] = [];
  for (const range of sorted) {
    const current = merged[merged.length - 1];
    if (!current || range.startIndex > current.endIndex) {
      merged.push({ ...range });
      continue;
    }
    current.endIndex = Math.max(current.endIndex, range.endIndex);
  }
  return merged;
}

function collectIntersectingGapRanges(
  gapRanges: TerminalGapRange[],
  startIndex: number,
  endIndex: number,
) {
  if (endIndex <= startIndex) {
    return [] as TerminalGapRange[];
  }
  return gapRanges
    .map((range) => ({
      startIndex: Math.max(startIndex, range.startIndex),
      endIndex: Math.min(endIndex, range.endIndex),
    }))
    .filter((range) => range.endIndex > range.startIndex);
}

function collectReadingRepairRanges(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  liveHead?: SessionBufferHeadState | null,
) {
  if (renderDemand?.mode !== 'reading') {
    return [] as TerminalGapRange[];
  }

  const viewportRows = resolveDemandViewportRows(session, renderDemand);
  const viewportEndIndex = Math.max(0, Math.floor(
    renderDemand.viewportEndIndex
    || session.buffer.bufferTailEndIndex
    || session.buffer.endIndex
    || 0,
  ));
  const { availableStartIndex } = resolveHeadAvailableBounds(session, liveHead);
  const requestWindow = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    availableStartIndex,
  );
  const requestStartIndex = requestWindow.requestStartIndex;
  const requestEndIndex = requestWindow.requestEndIndex;
  const localStartIndex = Math.max(0, Math.floor(session.buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(session.buffer.endIndex || 0));
  const missingRanges: TerminalGapRange[] = [];

  if (localStartIndex > requestStartIndex) {
    missingRanges.push({
      startIndex: requestStartIndex,
      endIndex: Math.min(localStartIndex, requestEndIndex),
    });
  }

  missingRanges.push(...collectIntersectingGapRanges(
    session.buffer.gapRanges,
    requestStartIndex,
    requestEndIndex,
  ));

  if (localEndIndex < requestEndIndex) {
    missingRanges.push({
      startIndex: Math.max(localEndIndex, requestStartIndex),
      endIndex: requestEndIndex,
    });
  }

  return mergeGapRanges(missingRanges);
}

function buildTailRefreshBufferSyncRequestPayload(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  options?: {
    liveHead?: SessionBufferHeadState | null;
    forceSameEndRefresh?: boolean;
    invalidLocalWindow?: boolean;
  },
): BufferSyncRequestPayload {
  const viewportRows = resolveDemandViewportRows(session, renderDemand);
  const viewportEndIndex = Math.max(0, Math.floor(
    session.daemonHeadEndIndex
    || renderDemand?.viewportEndIndex
    || session.buffer.bufferTailEndIndex
    || session.buffer.endIndex
    || 0,
  ));
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const { availableStartIndex } = resolveHeadAvailableBounds(session, options?.liveHead);
  const authoritativeHeadStartIndex = availableStartIndex;
  const localStartIndex = Math.max(0, Math.floor(session.buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(session.buffer.endIndex || 0));
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(session.buffer.revision || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const distanceToHead = Math.max(0, viewportEndIndex - localEndIndex);
  const invalidLocalWindow = Boolean(options?.invalidLocalWindow);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );
  let window: { requestStartIndex: number; requestEndIndex: number };

  if (!localHasWindow || invalidLocalWindow || distanceToHead > cacheLines) {
    window = resolveRequestedBufferWindow(
      viewportEndIndex,
      viewportRows,
      authoritativeHeadStartIndex,
    );
  } else if (localEndIndex < viewportEndIndex) {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, localEndIndex),
      requestEndIndex: viewportEndIndex,
    };
  } else if (sameEndRevisionAdvanced) {
    // sameEnd: revision advanced, end unchanged (style/cursor update).
    // Only request visible viewport — never full 3-screen cache.
    window = resolveVisibleViewportWindow(
      viewportEndIndex,
      viewportRows,
      authoritativeHeadStartIndex,
    );
  } else {
    window = {
      requestStartIndex: Math.max(authoritativeHeadStartIndex, localEndIndex),
      requestEndIndex: viewportEndIndex,
    };
  }
  return {
    ...buildBaseBufferSyncRequestPayload(session),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
  };
}

function buildReadingBufferSyncRequestPayload(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  liveHead?: SessionBufferHeadState | null,
): BufferSyncRequestPayload {
  const viewportRows = resolveDemandViewportRows(session, renderDemand);
  const viewportEndIndex = Math.max(0, Math.floor(
    renderDemand?.viewportEndIndex
    || session.buffer.bufferTailEndIndex
    || session.buffer.endIndex
    || 0,
  ));
  const { availableStartIndex } = resolveHeadAvailableBounds(session, liveHead);
  const window = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    availableStartIndex,
  );
  return {
    ...buildBaseBufferSyncRequestPayload(session),
    requestStartIndex: window.requestStartIndex,
    requestEndIndex: window.requestEndIndex,
    missingRanges: collectReadingRepairRanges(session, renderDemand, liveHead),
  };
}

function buildSessionBufferSyncRequestPayload(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  options?: {
    purpose?: 'tail-refresh' | 'reading-repair';
    forceSameEndRefresh?: boolean;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
  },
): BufferSyncRequestPayload {
  const purpose = options?.purpose || (renderDemand?.mode === 'reading' ? 'reading-repair' : 'tail-refresh');
  return purpose === 'reading-repair'
    ? buildReadingBufferSyncRequestPayload(session, renderDemand, options?.liveHead)
    : buildTailRefreshBufferSyncRequestPayload(session, renderDemand, options);
}

function buildHostConfigMessage(
  host: Host,
  sessionName: string,
  clientSessionId: string,
  terminalWidthMode: TerminalWidthMode,
): HostConfigMessage {
  return {
    clientSessionId,
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName,
    terminalWidthMode,
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
    viewportRows:
      typeof previousRenderDemand?.viewportRows === 'number' && Number.isFinite(previousRenderDemand.viewportRows) && previousRenderDemand.viewportRows > 0
        ? Math.max(1, Math.floor(previousRenderDemand.viewportRows))
        : resolveDemandViewportRows(session),
    viewportEndIndex: Math.max(0, Math.floor(
      session.daemonHeadEndIndex
      || session.buffer.bufferTailEndIndex
      || session.buffer.endIndex
      || 0,
    )),
  };
}

function normalizeSessionRenderDemandState(renderDemand: SessionRenderDemandState): SessionRenderDemandState {
  return {
    mode: renderDemand.mode === 'reading' ? 'reading' : 'follow',
    viewportEndIndex: Math.max(0, Math.floor(renderDemand.viewportEndIndex || 0)),
    viewportRows: Math.max(1, Math.floor(renderDemand.viewportRows || 1)),
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
  ) {
    return false;
  }
  return true;
}

function shouldPullFollowBuffer(
  session: Session,
  renderDemand?: SessionRenderDemandState,
) {
  const buffer = session.buffer;
  const viewportRows = resolveDemandViewportRows(session, renderDemand);
  const desiredEndIndex = Math.max(0, Math.floor(
    session.daemonHeadEndIndex
    || renderDemand?.viewportEndIndex
    || buffer.bufferTailEndIndex
    || buffer.endIndex
    || 0,
  ));
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const distanceToHead = Math.max(0, desiredEndIndex - localEndIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );

  if (!localHasWindow) {
    return true;
  }
  if (distanceToHead > cacheLines) {
    return true;
  }
  if (localEndIndex < desiredEndIndex) {
    return true;
  }
  if (sameEndRevisionAdvanced) {
    return true;
  }
  return false;
}

function shouldCatchUpFollowTailAfterBufferApply(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  options?: {
    forceSameEndRefresh?: boolean;
  },
) {
  const buffer = session.buffer;
  const viewportRows = resolveDemandViewportRows(session, renderDemand);
  const desiredEndIndex = Math.max(0, Math.floor(
    session.daemonHeadEndIndex
    || renderDemand?.viewportEndIndex
    || buffer.bufferTailEndIndex
    || buffer.endIndex
    || 0,
  ));
  const daemonRevision = Math.max(0, Math.floor(session.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));
  const localStartIndex = Math.max(0, Math.floor(buffer.startIndex || 0));
  const localEndIndex = Math.max(localStartIndex, Math.floor(buffer.endIndex || 0));
  const localHasWindow = localEndIndex > localStartIndex;
  const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
  const distanceToHead = Math.max(0, desiredEndIndex - localEndIndex);
  const sameEndRevisionAdvanced = (
    localHasWindow
    && distanceToHead === 0
    && daemonRevision > localRevision
  );

  return (
    !localHasWindow
    || distanceToHead > cacheLines
    || localEndIndex < desiredEndIndex
    || sameEndRevisionAdvanced
    || (Boolean(options?.forceSameEndRefresh) && daemonRevision > localRevision)
  );
}

function shouldPullReadingBuffer(
  session: Session,
  renderDemand?: SessionRenderDemandState,
  liveHead?: SessionBufferHeadState | null,
) {
  return collectReadingRepairRanges(session, renderDemand, liveHead).length > 0;
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

function resolveHeadAvailableBounds(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
) {
  const availableEndIndex = Math.max(0, Math.floor(
    liveHead?.availableEndIndex
    ?? liveHead?.latestEndIndex
    ?? session.daemonHeadEndIndex
    ?? session.buffer.bufferTailEndIndex
    ?? session.buffer.endIndex
    ?? 0,
  ));
  const availableStartIndex = Math.max(0, Math.min(
    availableEndIndex,
    Math.floor(
      liveHead?.availableStartIndex
      ?? session.buffer.bufferHeadStartIndex
      ?? 0
    ),
  ));
  return {
    availableStartIndex,
    availableEndIndex,
  };
}

function hasImpossibleLocalWindow(
  session: Session,
  liveHead?: SessionBufferHeadState | null,
) {
  const { availableEndIndex } = resolveHeadAvailableBounds(session, liveHead);
  const localStartIndex = Math.max(0, Math.floor(session.buffer.startIndex || 0));
  const localEndIndex = Math.max(0, Math.floor(session.buffer.endIndex || 0));
  const localHeadStartIndex = Math.max(0, Math.floor(session.buffer.bufferHeadStartIndex || 0));
  const localTailEndIndex = Math.max(0, Math.floor(session.buffer.bufferTailEndIndex || 0));

  return (
    localStartIndex > availableEndIndex
    || localEndIndex > availableEndIndex
    || localHeadStartIndex > availableEndIndex
    || localTailEndIndex > availableEndIndex
  );
}

function hasActiveSessionPullState(pullStates?: SessionPullStates | null) {
  return Boolean(pullStates?.['tail-refresh'] || pullStates?.['reading-repair']);
}

function getPrimarySessionPullState(pullStates?: SessionPullStates | null) {
  return pullStates?.['reading-repair'] || pullStates?.['tail-refresh'] || null;
}

function clearSessionPullStateEntry(
  pullStates: SessionPullStates | null | undefined,
  purpose: SessionPullPurpose,
) {
  if (!pullStates || !pullStates[purpose]) {
    return pullStates || null;
  }
  const next = { ...pullStates };
  delete next[purpose];
  return hasActiveSessionPullState(next) ? next : null;
}

function doesBufferSyncSatisfyPullState(
  pullState: SessionPullState,
  payload: TerminalBufferPayload,
) {
  const payloadRevision = Math.max(0, Math.floor(payload.revision || 0));
  const payloadStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const payloadEndIndex = Math.max(payloadStartIndex, Math.floor(payload.endIndex || 0));
  return (
    payloadRevision >= pullState.targetHeadRevision
    && payloadStartIndex <= pullState.targetStartIndex
    && payloadEndIndex >= pullState.targetEndIndex
  );
}

function settleSessionPullStatesWithBufferSync(
  pullStates: SessionPullStates | null | undefined,
  payload: TerminalBufferPayload,
) {
  if (!pullStates || !hasActiveSessionPullState(pullStates)) {
    return null;
  }

  const activePulls = Object.values(pullStates)
    .filter((item): item is SessionPullState => Boolean(item))
    .sort((left, right) => left.startedAt - right.startedAt);

  if (activePulls.length === 0) {
    return null;
  }

  if ((payload.lines?.length || 0) === 0) {
    return clearSessionPullStateEntry(pullStates, activePulls[0]!.purpose);
  }

  let next: SessionPullStates | null = pullStates;
  for (const pullState of activePulls) {
    if (!doesBufferSyncSatisfyPullState(pullState, payload)) {
      continue;
    }
    next = clearSessionPullStateEntry(next, pullState.purpose);
  }
  return next;
}

function doesSessionPullStateCoverRequest(
  pullState: SessionPullState,
  payload: BufferSyncRequestPayload,
) {
  return (
    pullState.targetStartIndex <= Math.max(0, Math.floor(payload.requestStartIndex || 0))
    && pullState.targetEndIndex >= Math.max(0, Math.floor(payload.requestEndIndex || 0))
  );
}

export function SessionProvider({
  children,
  wsUrl,
  terminalCacheLines = DEFAULT_TERMINAL_CACHE_LINES,
  bridgeSettings = DEFAULT_BRIDGE_SETTINGS,
}: SessionProviderProps) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [scheduleStates, setScheduleStates] = useState<Record<string, SessionScheduleState>>({});
  const [sessionDebugMetrics, setSessionDebugMetrics] = useState<Record<string, SessionDebugOverlayMetrics | undefined>>({});
  const stateRef = useRef(state);
  const scheduleStatesRef = useRef<Record<string, SessionScheduleState>>({});
  const wsRefs = useRef<Map<string, BridgeTransportSocket>>(new Map());
  const pingIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const handshakeTimeoutsRef = useRef<Map<string, number>>(new Map());
  // renderer -> worker declarative demand only; never producer/tail truth
  const sessionRenderDemandRef = useRef<Map<string, SessionRenderDemandState>>(new Map());
  const lastPongAtRef = useRef<Map<string, number>>(new Map());
  const lastServerActivityAtRef = useRef<Map<string, number>>(new Map());
  const sessionHostRef = useRef<Map<string, Host>>(new Map());
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
  const fileTransferListeners = useRef<Set<(msg: any) => void>>(new Set());
  const pendingRemoteScreenshotRequestsRef = useRef<Map<string, PendingRemoteScreenshotRequest>>(new Map());
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

  const isSessionTransportActive = useCallback((sessionId: string) => {
    return stateRef.current.activeSessionId === sessionId;
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
      pullRequests: 0,
    };
    sessionWireStatsRef.current.set(sessionId, initial);
    return initial;
  }, []);

  const recordSessionTx = useCallback((sessionId: string, data: string | ArrayBuffer, options?: {
    pullPurpose?: SessionPullPurpose;
    targetHeadRevision?: number;
    targetStartIndex?: number;
    targetEndIndex?: number;
  }) => {
    const current = ensureSessionWireStats(sessionId);
    current.txBytes += estimateWireBytes(data);
    if (options?.pullPurpose) {
      current.pullRequests += 1;
      const nextPullStates = {
        ...(sessionPullStateRef.current.get(sessionId) || {}),
        [options.pullPurpose]: {
          purpose: options.pullPurpose,
          startedAt: Date.now(),
          targetHeadRevision: Math.max(0, Math.floor(options.targetHeadRevision || 0)),
          targetStartIndex: Math.max(0, Math.floor(options.targetStartIndex || 0)),
          targetEndIndex: Math.max(0, Math.floor(options.targetEndIndex || 0)),
        },
      } satisfies SessionPullStates;
      sessionPullStateRef.current.set(sessionId, nextPullStates);
    }
  }, [ensureSessionWireStats, estimateWireBytes]);

  const recordSessionRx = useCallback((sessionId: string, data: string | ArrayBuffer) => {
    const current = ensureSessionWireStats(sessionId);
    current.rxBytes += estimateWireBytes(data);
    lastServerActivityAtRef.current.set(sessionId, Date.now());
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
  }) => {
    recordSessionTx(sessionId, data, options);
    ws.send(data);
  }, [recordSessionTx]);

  const buildTraversalSocketForHost = useCallback((host: Host) => {
    const traversal = resolveTraversalConfigFromHost(host, bridgeSettings);
    return new TraversalSocket(traversal.target, traversal.settings, { overrideUrl: wsUrl });
  }, [bridgeSettings, wsUrl]);

  const applyTransportDiagnostics = useCallback((sessionId: string, socket: BridgeTransportSocket) => {
    const diagnostics = socket.getDiagnostics();
    dispatch({
      type: 'UPDATE_SESSION',
      id: sessionId,
      updates: {
        resolvedPath: diagnostics.resolvedPath,
        resolvedEndpoint: diagnostics.resolvedEndpoint,
        lastConnectStage: diagnostics.stage,
        lastError: diagnostics.reason || undefined,
      },
    });
  }, []);

  const flushRuntimeDebugLogs = useCallback(() => {
    if (!isRuntimeDebugEnabled() || getPendingRuntimeDebugEntryCount() === 0) {
      return;
    }

    const activeWs = stateRef.current.activeSessionId
      ? wsRefs.current.get(stateRef.current.activeSessionId) || null
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
          pullRequests: 0,
        };
        const previous = sessionWireStatsPreviousRef.current.get(session.id);
        const deltaMs = previous ? Math.max(250, now - previous.at) : 1000;
        const deltaSeconds = deltaMs / 1000;
        const txBytesDelta = current.txBytes - (previous?.sample.txBytes || 0);
        const rxBytesDelta = current.rxBytes - (previous?.sample.rxBytes || 0);
        const renderDelta = current.renderCommits - (previous?.sample.renderCommits || 0);
        const pullDelta = current.pullRequests - (previous?.sample.pullRequests || 0);
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
          updatedAt: now,
        };

        sessionWireStatsPreviousRef.current.set(session.id, {
          sample: { ...current },
          at: now,
        });
      }

      setSessionDebugMetrics(nextMetrics);
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

  function buildConnectedSessionUpdates(sessionId: string) {
    void sessionId;
    return {
      state: 'connected' as const,
      reconnectAttempt: 0,
      lastError: undefined,
    };
  }

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
    sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
      type: 'connect',
      payload: buildHostConfigMessage(
        options.host,
        sessionName,
        options.sessionId,
        bridgeSettings.terminalWidthMode,
      ),
    }));
    runtimeDebug(`session.ws.${options.debugScope}.connect-sent`, {
      sessionId: options.sessionId,
      tmuxViewportFromUiShell: false,
    });
    flushRuntimeDebugLogs();
    startSocketHeartbeat(options.sessionId, options.ws, options.finalizeFailure);
  }

  const requestSessionBufferSync = useCallback((sessionId: string, options?: {
    ws?: BridgeTransportSocket | null;
    reason?: string;
    purpose?: SessionPullPurpose;
    sessionOverride?: Session | null;
    liveHead?: SessionBufferHeadState | null;
    invalidLocalWindow?: boolean;
  }) => {
    const session = options?.sessionOverride || stateRef.current.sessions.find((item) => item.id === sessionId);
    const targetWs = options?.ws || wsRefs.current.get(sessionId);
    if (!session || !targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return false;
    }

    const renderDemand = sessionRenderDemandRef.current.get(sessionId);
    const requestPurpose = options?.purpose || (renderDemand?.mode === 'reading' ? 'reading-repair' : 'tail-refresh');
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
      renderDemand,
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
      const targetHeadRevision = Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0));
      if (doesSessionPullStateCoverRequest(inFlightPull, payload)) {
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
    sendSocketPayload(sessionId, targetWs, JSON.stringify({
      type: 'buffer-sync-request',
      payload,
    } satisfies ClientMessage), {
      pullPurpose: requestPurpose,
      targetHeadRevision: Math.max(0, Math.floor(effectiveSession.daemonHeadRevision || 0)),
      targetStartIndex: Math.max(0, Math.floor(payload.requestStartIndex || 0)),
      targetEndIndex: Math.max(0, Math.floor(
        effectiveSession.daemonHeadEndIndex
        || payload.requestEndIndex
        || effectiveSession.buffer.bufferTailEndIndex
        || effectiveSession.buffer.endIndex
        || 0
      )),
    });
    return true;
  }, [clearSessionPullState, sendSocketPayload]);

  const requestSessionBufferHead = useCallback((sessionId: string, ws?: BridgeTransportSocket | null, options?: {
    force?: boolean;
  }) => {
    const targetWs = ws || wsRefs.current.get(sessionId) || null;
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
    if (!options?.force && now - lastRequestedAt < cadence.headTickMs) {
      return false;
    }
    lastHeadRequestAtRef.current.set(sessionId, now);
    sendSocketPayload(sessionId, targetWs, JSON.stringify({ type: 'buffer-head-request' } satisfies ClientMessage));
    return true;
  }, [sendSocketPayload]);

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
    const renderDemand = sessionRenderDemandRef.current.get(sessionId) || buildFollowRenderDemandState(nextSession);

    if (shouldCatchUpFollowTailAfterBufferApply(nextSession, renderDemand, {
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

    if (renderDemand.mode !== 'reading' || !shouldPullReadingBuffer(nextSession, renderDemand, liveHead)) {
      return;
    }

    requestSessionBufferSync(sessionId, {
      reason: 'buffer-sync-reading-repair-catchup',
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
    clearSessionHandshakeTimeout(sessionId);
    clearTailRefreshRuntime(sessionId);
    clearSessionPullState(sessionId);
  }, [clearHeartbeat, clearSessionHandshakeTimeout, clearSessionPullState, clearTailRefreshRuntime]);

  const startReconnectAttempt = useCallback((sessionId: string) => {
    const reconnectRuntime = reconnectRuntimesRef.current.get(sessionId);
    const targetHost = sessionHostRef.current.get(sessionId);
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
      const liveRuntime = reconnectRuntimesRef.current.get(sessionId);
      if (!liveRuntime) {
        return;
      }
      liveRuntime.timer = null;
      liveRuntime.connecting = true;

      const liveHost = sessionHostRef.current.get(sessionId);
      if (!liveHost) {
        liveRuntime.connecting = false;
        reconnectRuntimesRef.current.delete(sessionId);
        return;
      }

      dispatch({
        type: 'UPDATE_SESSION',
        id: sessionId,
        updates: {
          state: 'reconnecting',
          reconnectAttempt: liveRuntime.attempt + 1,
        },
      });

      const ws = buildTraversalSocketForHost(liveHost);
      runtimeDebug('session.ws.reconnect.opening', {
        sessionId,
        host: liveHost.bridgeHost,
        port: liveHost.bridgePort,
        sessionName: getResolvedSessionName(liveHost),
      });
      wsRefs.current.set(sessionId, ws);
      dispatch({ type: 'UPDATE_SESSION', id: sessionId, updates: { ws: null } });
      lastPongAtRef.current.set(sessionId, Date.now());

      let completed = false;
      const clearHandshakeTimeout = () => {
        clearSessionHandshakeTimeout(sessionId);
      };
      const markCompleted = () => {
        if (completed) {
          return false;
        }
        completed = true;
        return true;
      };
      const finalizeFailure = (message: string, retryable: boolean) => {
        clearHandshakeTimeout();
        const baseline = finalizeSocketFailureBaselineRef.current?.({
          sessionId,
          message,
          markCompleted,
        });
        if (!baseline) {
          reconnectRuntimesRef.current.delete(sessionId);
          return;
        }
        const currentReconnectRuntime = reconnectRuntimesRef.current.get(sessionId) || null;
        if (currentReconnectRuntime) {
          currentReconnectRuntime.connecting = false;
        }
        if (!baseline.shouldContinue) {
          reconnectRuntimesRef.current.delete(sessionId);
          return;
        }

        if (!retryable) {
          reconnectRuntimesRef.current.delete(sessionId);
          dispatch({
            type: 'UPDATE_SESSION',
            id: sessionId,
            updates: {
              state: 'error',
              lastError: message,
            },
          });
          emitSessionStatus(sessionId, 'error', message);
          return;
        }

        const nextReconnectRuntime = reconnectRuntimesRef.current.get(sessionId) || createSessionReconnectRuntime();
        nextReconnectRuntime.attempt = Math.min(nextReconnectRuntime.attempt + 1, 6);
        nextReconnectRuntime.connecting = false;
        reconnectRuntimesRef.current.set(sessionId, nextReconnectRuntime);

        dispatch({
          type: 'UPDATE_SESSION',
          id: sessionId,
          updates: {
            state: 'reconnecting',
            lastError: message,
            reconnectAttempt: nextReconnectRuntime.attempt,
            ws: null,
          },
        });
        emitSessionStatus(sessionId, 'error', message);
        startReconnectAttempt(sessionId);
      };

      ws.onopen = () => {
        applyTransportDiagnostics(sessionId, ws);
        openSocketConnectHandshake({
          sessionId,
          host: liveHost,
          ws,
          debugScope: 'reconnect',
          finalizeFailure,
          onBeforeConnectSend: ({ sessionName }) => {
            dispatch({
              type: 'UPDATE_SESSION',
              id: sessionId,
              updates: {
                state: 'connecting',
                sessionName,
              },
            });
            setScheduleStateForSession(sessionId, {
              sessionName,
              jobs: [],
              loading: true,
            });
          },
        });
        clearHandshakeTimeout();
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
            host: liveHost,
            ws,
            debugScope: 'reconnect',
            onConnected: () => {
              if (completed) return;
              completed = true;
              clearHandshakeTimeout();
              const connectedSessionName = getResolvedSessionName(liveHost);
              runtimeDebug('session.ws.reconnect.connected', {
                sessionId,
                activeSessionId: stateRef.current.activeSessionId,
              });
              reconnectRuntimesRef.current.delete(sessionId);
              handleSocketConnectedBaselineRef.current?.({
                sessionId,
                sessionName: connectedSessionName,
                ws,
              });
              flushPendingInputQueueRef.current?.(sessionId);
            },
            onFailure: finalizeFailure,
          }, msg);
        } catch (error) {
          finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
        }
      };

      ws.onerror = () => finalizeFailure(ws.getDiagnostics().reason || 'transport error', true);
      ws.onclose = () => finalizeFailure(ws.getDiagnostics().reason || 'socket closed', true);
    }, delay);
  }, [
    applyTransportDiagnostics,
    buildTraversalSocketForHost,
    clearSessionHandshakeTimeout,
    recordSessionRx,
    setSessionHandshakeTimeout,
  ]);

  const scheduleReconnect = useCallback((
    sessionId: string,
    message: string,
    retryable = true,
    options?: { immediate?: boolean; resetAttempt?: boolean },
  ) => {
    if (!sessionHostRef.current.get(sessionId)) {
      return;
    }

    if (!retryable) {
      reconnectRuntimesRef.current.delete(sessionId);
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

    const reconnectRuntime = reconnectRuntimesRef.current.get(sessionId) || createSessionReconnectRuntime();
    if (options?.resetAttempt) {
      reconnectRuntime.attempt = 0;
    }
    if (options?.immediate) {
      reconnectRuntime.nextDelayMs = 0;
    }
    reconnectRuntimesRef.current.set(sessionId, reconnectRuntime);

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
    startReconnectAttempt(sessionId);
  }, [startReconnectAttempt]);

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

    const ws = buildTraversalSocketForHost(host);
    runtimeDebug('session.ws.connect.opening', {
      sessionId,
      host: host.bridgeHost,
      port: host.bridgePort,
      sessionName: getResolvedSessionName(host),
      activate,
    });
    wsRefs.current.set(sessionId, ws);
    dispatch({ type: 'UPDATE_SESSION', id: sessionId, updates: { ws: null } });
    lastPongAtRef.current.set(sessionId, Date.now());

    let completed = false;
    const clearHandshakeTimeout = () => {
      clearSessionHandshakeTimeout(sessionId);
    };
    const markCompleted = () => {
      if (completed) {
        return false;
      }
      completed = true;
      return true;
    };
    const finalizeFailure = (message: string, retryable: boolean) => {
      clearHandshakeTimeout();
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
      applyTransportDiagnostics(sessionId, ws);
      openSocketConnectHandshake({
        sessionId,
        host,
        ws,
        debugScope: 'connect',
        activate,
        finalizeFailure,
      });
      clearHandshakeTimeout();
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
          debugScope: 'connect',
          onConnected: () => {
            if (completed) return;
            completed = true;
            clearHandshakeTimeout();
            const connectedSessionName = getResolvedSessionName(host);
            runtimeDebug('session.ws.connected', {
              sessionId,
              activeSessionId: stateRef.current.activeSessionId,
            });
            handleSocketConnectedBaseline({
              sessionId,
              sessionName: connectedSessionName,
              ws,
            });
          },
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
    buildTraversalSocketForHost,
    cleanupSocket,
    clearReconnectForSession,
    clearSessionHandshakeTimeout,
    recordSessionRx,
    requestSessionBufferSync,
    resolveSessionCacheLines,
    scheduleReconnect,
    setSessionHandshakeTimeout,
    wsUrl,
  ]);

  const createSession = useCallback((host: Host, options?: CreateSessionOptions): string => {
    const sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const sessionName = getResolvedSessionName(host);
    const shouldConnect = options?.connect !== false;
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

    dispatch({ type: 'CREATE_SESSION', session, activate: options?.activate !== false });
    if (shouldConnect) {
      connectSession(sessionId, host, options?.activate !== false);
    }
    return sessionId;
  }, [connectSession, resolveSessionCacheLines]);

  const closeSession = useCallback((id: string) => {
    manualCloseRef.current.add(id);
    pendingInputQueueRef.current.delete(id);
    clearReconnectForSession(id);

    const ws = wsRefs.current.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendSocketPayload(id, ws, JSON.stringify({ type: 'close' }));
    }
    cleanupSocket(id, true);
    sessionHostRef.current.delete(id);
    viewportSizeRef.current.delete(id);
    pendingInputTailRefreshRef.current.delete(id);
    pendingConnectTailRefreshRef.current.delete(id);
    pendingResumeTailRefreshRef.current.delete(id);
    sessionRenderDemandRef.current.delete(id);
    sessionWireStatsRef.current.delete(id);
    sessionWireStatsPreviousRef.current.delete(id);
    setSessionDebugMetrics((current) => {
      if (!(id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
    setScheduleStates((current) => {
      if (!(id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[id];
      return next;
    });
    dispatch({ type: 'DELETE_SESSION', id });
  }, [cleanupSocket, clearReconnectForSession, sendSocketPayload]);

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
    const ws = wsRefs.current.get(sessionId);
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
      session = nextSession;
    }
    const liveHead = sessionBufferHeadsRef.current.get(sessionId) || null;
    if (
      session.daemonHeadRevision !== latestRevision
      || session.daemonHeadEndIndex !== latestEndIndex
    ) {
      dispatch({
        type: 'UPDATE_SESSION',
        id: sessionId,
        updates: {
          daemonHeadRevision: latestRevision,
          daemonHeadEndIndex: latestEndIndex,
        },
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
      renderDemand: sessionRenderDemandRef.current.get(sessionId) || null,
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
    const renderDemand = sessionRenderDemandRef.current.get(sessionId) || buildFollowRenderDemandState(session);
    const needsTailRefresh = revisionResetDetected || localWindowInvalid || shouldPullFollowBuffer(demandSession, renderDemand);
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

    if (renderDemand.mode !== 'reading') {
      return;
    }

    const needsReadingRepair = shouldPullReadingBuffer(demandSession, renderDemand, liveHead);
    if (!needsReadingRepair) {
      return;
    }

    requestSessionBufferSync(sessionId, {
      reason: 'buffer-head-reading-repair',
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
    for (let index = 0; index < chunks.size; index += 1) {
      const chunk = chunks.get(index);
      if (!chunk) {
        throw new Error(`Remote screenshot missing chunk ${index}`);
      }
      ordered.push(chunk);
    }

    return {
      fileName,
      mimeType: 'image/png',
      dataBase64: ordered.join(''),
      totalBytes,
    };
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
        dispatch({ type: 'SET_SESSION_TITLE', id: options.sessionId, title: msg.payload });
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
          try { listener(msg); } catch { /* listener error */ }
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
          try { listener(msg); } catch { /* listener error */ }
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
          try { listener(msg); } catch { /* listener error */ }
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
          try { listener(msg); } catch { /* listener error */ }
        }
        break;
      }
      case 'file-upload-progress':
      case 'file-upload-complete':
      case 'file-upload-error':
        for (const listener of fileTransferListeners.current) {
          try { listener(msg); } catch { /* listener error */ }
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
    const hadLocalWindowBeforeConnected =
      Boolean(currentSession)
      && Math.max(0, Math.floor(currentSession!.buffer.endIndex || 0))
        > Math.max(0, Math.floor(currentSession!.buffer.startIndex || 0))
      && Math.max(0, Math.floor(currentSession!.buffer.revision || 0)) > 0;
    applyTransportDiagnostics(options.sessionId, options.ws);
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
    sendSocketPayload(options.sessionId, options.ws, JSON.stringify({
      type: 'schedule-list',
      payload: { sessionName: options.sessionName },
    } satisfies ClientMessage));
    const shouldLiveRefresh = isSessionTransportActive(options.sessionId);
    if (shouldLiveRefresh) {
      if (hadLocalWindowBeforeConnected) {
        pendingConnectTailRefreshRef.current.add(options.sessionId);
      }
      requestSessionBufferHead(options.sessionId, options.ws, { force: true });
    }
    dispatch({ type: 'INCREMENT_CONNECTED' });
  }, [applyTransportDiagnostics, isSessionTransportActive, requestSessionBufferHead, setScheduleStateForSession]);
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
  finalizeSocketFailureBaselineRef.current = finalizeSocketFailureBaseline;

  const resumeActiveSessionTransport = useCallback((sessionId: string) => {
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    const ws = wsRefs.current.get(sessionId) || null;
    const isActive = stateRef.current.activeSessionId === sessionId;
    if (
      !session
      || session.state !== 'connected'
      || !ws
      || ws.readyState !== WebSocket.OPEN
      || !isActive
    ) {
      runtimeDebug('session.transport.resume-active.skip', {
        sessionId,
        activeSessionId: stateRef.current.activeSessionId,
        hasSession: Boolean(session),
        sessionState: session?.state ?? null,
        wsReadyState: ws?.readyState ?? null,
        isActive,
      });
      return false;
    }

    runtimeDebug('session.transport.resume-active', {
      sessionId,
      activeSessionId: stateRef.current.activeSessionId,
      localRevision: session.buffer.revision,
      localStartIndex: session.buffer.startIndex,
      localEndIndex: session.buffer.endIndex,
      transportStale: isSessionTransportActivityStale(sessionId),
    });
    resetSessionTransportPullBookkeeping(sessionId, 'active-resume');
    pendingResumeTailRefreshRef.current.add(sessionId);
    requestSessionBufferHead(sessionId, ws, { force: true });
    return true;
  }, [isSessionTransportActivityStale, requestSessionBufferHead, resetSessionTransportPullBookkeeping]);

  const updateSessionViewport = useCallback((sessionId: string, renderDemand: SessionRenderDemandState) => {
    const normalized = normalizeSessionRenderDemandState(renderDemand);
    const previous = sessionRenderDemandRef.current.get(sessionId);
    if (renderDemandStatesEqual(previous, normalized)) {
      return;
    }
    sessionRenderDemandRef.current.set(sessionId, normalized);
    if (!isSessionTransportActive(sessionId) || normalized.mode !== 'reading') {
      return;
    }
    const session = stateRef.current.sessions.find((item) => item.id === sessionId) || null;
    const liveHead = sessionBufferHeadsRef.current.get(sessionId) || null;
    if (!session || !shouldPullReadingBuffer(session, normalized, liveHead)) {
      return;
    }
    requestSessionBufferSync(sessionId, {
      reason: 'viewport-reading-demand',
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
    const activeSessionId = state.activeSessionId;
    const activeSession = state.sessions.find((item) => item.id === activeSessionId) || null;
    const ws = wsRefs.current.get(activeSessionId) || null;
    if (
      activeSession
      && ws
      && ws.readyState === WebSocket.OPEN
      && isSessionTransportActivityStale(activeSessionId)
      && !isReconnectInFlight(activeSessionId)
    ) {
      runtimeDebug('session.transport.active-reentry.stale', {
        sessionId: activeSessionId,
        activeSessionId: stateRef.current.activeSessionId,
        lastServerActivityAt: lastServerActivityAtRef.current.get(activeSessionId) || 0,
      });
      reconnectSession(activeSessionId);
      return;
    }
    resetSessionTransportPullBookkeeping(activeSessionId, 'active-reentry');
    if (requestSessionBufferHead(activeSessionId, ws, { force: true })) {
      return;
    }
    if (shouldReconnectActivatedSession({
      hasSession: Boolean(activeSession),
      wsReadyState: ws?.readyState ?? null,
      reconnectInFlight: isReconnectInFlight(activeSessionId),
    })) {
      reconnectSession(activeSessionId);
    }
  }, [isReconnectInFlight, isSessionTransportActivityStale, reconnectSession, requestSessionBufferHead, resetSessionTransportPullBookkeeping, state.activeSessionId, state.sessions]);

  const flushPendingInputQueue = useCallback((sessionId: string) => {
    const ws = wsRefs.current.get(sessionId);
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
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          scheduleNext();
          return;
        }
        const activeSessionId = stateRef.current.activeSessionId;
        if (!activeSessionId) {
          scheduleNext();
          return;
        }
        const session = stateRef.current.sessions.find((item) => item.id === activeSessionId) || null;
        const ws = wsRefs.current.get(activeSessionId) || null;
        if (
          !session
          || !ws
          || ws.readyState !== WebSocket.OPEN
        ) {
          scheduleNext();
          return;
        }

        if (
          isSessionTransportActivityStale(activeSessionId)
          && !isReconnectInFlight(activeSessionId)
        ) {
          runtimeDebug('session.transport.active-tick.stale', {
            sessionId: activeSessionId,
            activeSessionId: stateRef.current.activeSessionId,
            lastServerActivityAt: lastServerActivityAtRef.current.get(activeSessionId) || 0,
          });
          reconnectSession(activeSessionId);
          scheduleNext();
          return;
        }

        requestSessionBufferHead(activeSessionId, ws);
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
  }, [isReconnectInFlight, isSessionTransportActivityStale, reconnectSession, requestSessionBufferHead]);

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
    const transportStale = isSessionTransportActivityStale(targetSessionId);
    if (ws && ws.readyState === WebSocket.OPEN && !transportStale) {
      runtimeDebug('session.input.send', {
        sessionId: targetSessionId,
        size: data.length,
        preview: data.slice(0, 32),
      });
      markPendingInputTailRefresh(targetSessionId, session.buffer.revision);
      sendSocketPayload(targetSessionId, ws, JSON.stringify({ type: 'input', payload: data }));
      requestSessionBufferHead(targetSessionId, ws, { force: true });
      return;
    }

    runtimeDebug('session.input.queue', {
      sessionId: targetSessionId,
      why: transportStale ? 'stale-open-transport' : 'transport-unavailable',
      size: data.length,
      preview: data.slice(0, 32),
    });
    enqueuePendingInput(targetSessionId, data);
    const isActiveTarget = stateRef.current.activeSessionId === targetSessionId;
    const reconnectInFlight = isReconnectInFlight(targetSessionId);
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
  }, [enqueuePendingInput, isReconnectInFlight, isSessionTransportActivityStale, markPendingInputTailRefresh, reconnectSession, requestSessionBufferHead]);

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
    }
  }, [cleanupSocket, clearRemoteScreenshotTimeout, clearSessionHandshakeTimeout]);

  const value: SessionContextValue = {
    state,
    scheduleStates,
    sessionDebugMetrics,
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
      const ws = wsRefs.current.get(sessionId);
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
