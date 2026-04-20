/**
 * SessionContext - 管理 Session 状态、重连和持久化
 */

import React, { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import type {
  ClientMessage,
  Host,
  HostConfigMessage,
  ServerMessage,
  Session,
  SessionSnapshot,
  SessionState,
  TerminalCell,
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportUpdate,
} from '../lib/types';
import { STORAGE_KEYS } from '../lib/types';
import { buildBridgeUrl } from '../lib/bridge-url';
import { getResolvedSessionName } from '../lib/connection-target';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';

const SESSION_STATUS_EVENT = 'wterm-mobile:session-status';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;
const POST_SUCCESS_NEXT_RETRY_DELAY_MS = 240;
const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;

function emitSessionStatus(sessionId: string, type: 'closed' | 'error', message?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_STATUS_EVENT, { detail: { sessionId, type, message } }));
}

interface SessionManagerState {
  sessions: Session[];
  activeSessionId: string | null;
  connectedCount: number;
}

type SessionAction =
  | { type: 'CREATE_SESSION'; session: Session; activate: boolean }
  | { type: 'UPDATE_SESSION'; id: string; updates: Partial<Session> }
  | { type: 'SET_SESSION_SNAPSHOT'; id: string; snapshot: TerminalSnapshot; cacheLines: number }
  | { type: 'APPLY_VIEWPORT_UPDATE'; id: string; update: TerminalViewportUpdate; cacheLines: number }
  | { type: 'APPLY_SCROLLBACK_UPDATE'; id: string; update: TerminalScrollbackUpdate; cacheLines: number }
  | { type: 'SET_SESSION_BUFFER_LINES'; id: string; lines: string[]; cacheLines: number }
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

function trimOutputHistory(history: string, cacheLines: number) {
  const lines = history.split('\n');
  if (lines.length <= cacheLines) {
    return history;
  }
  return lines.slice(lines.length - cacheLines).join('\n');
}

function normalizeBufferLines(lines: string[], cacheLines: number) {
  const normalized = lines.map((line) => (typeof line === 'string' ? line : String(line ?? '')));
  if (normalized.length <= cacheLines) {
    return normalized;
  }
  return normalized.slice(normalized.length - cacheLines);
}

function trimBufferWithScrollbackStart(
  lines: string[],
  scrollbackStartIndex: number | undefined,
  viewportRows: number,
  cacheLines: number,
) {
  const normalized = lines.map((line) => (typeof line === 'string' ? line : String(line ?? '')));
  const normalizedViewportRows = Math.max(0, viewportRows);
  if (normalized.length <= cacheLines) {
    return {
      lines: normalized,
      scrollbackStartIndex:
        scrollbackStartIndex !== undefined && normalized.length > normalizedViewportRows
          ? scrollbackStartIndex
          : undefined,
    };
  }

  const trimmedCount = normalized.length - cacheLines;
  const nextLines = normalized.slice(trimmedCount);
  const scrollbackCount = Math.max(0, normalized.length - normalizedViewportRows);
  const removedScrollbackCount = Math.min(trimmedCount, scrollbackCount);
  const nextScrollbackCount = Math.max(0, nextLines.length - normalizedViewportRows);

  return {
    lines: nextLines,
    scrollbackStartIndex:
      scrollbackStartIndex !== undefined && nextScrollbackCount > 0
        ? scrollbackStartIndex + removedScrollbackCount
        : undefined,
  };
}

function cellsToLine(cells: TerminalCell[]) {
  let line = '';
  for (const cell of cells) {
    if (cell.width === 0) {
      continue;
    }
    line += cell.char >= 32 ? String.fromCodePoint(cell.char) : ' ';
  }
  return line.replace(/\s+$/u, '');
}

function mergeIndexedScrollbackLines(
  currentLines: string[],
  currentStartIndex: number | undefined,
  incomingLines: string[],
  incomingStartIndex: number | undefined,
) {
  if (incomingLines.length === 0) {
    return {
      lines: currentLines,
      scrollbackStartIndex: currentStartIndex,
    };
  }

  if (incomingStartIndex === undefined) {
    return {
      lines: incomingLines,
      scrollbackStartIndex: undefined,
    };
  }

  if (currentLines.length === 0 || currentStartIndex === undefined) {
    return {
      lines: incomingLines,
      scrollbackStartIndex: incomingStartIndex,
    };
  }

  const merged = new Map<number, string>();
  currentLines.forEach((line, index) => merged.set(currentStartIndex + index, line));
  incomingLines.forEach((line, index) => merged.set(incomingStartIndex + index, line));

  const orderedIndexes = [...merged.keys()].sort((left, right) => left - right);
  return {
    lines: orderedIndexes.map((index) => merged.get(index) || ''),
    scrollbackStartIndex: orderedIndexes[0],
  };
}

function mergeSnapshotIntoBufferLines(snapshot: TerminalSnapshot, cacheLines: number) {
  const viewportLines = snapshot.viewport.map(cellsToLine);
  if (snapshot.scrollbackLines) {
    return trimBufferWithScrollbackStart(
      [...snapshot.scrollbackLines, ...viewportLines],
      snapshot.scrollbackStartIndex,
      snapshot.rows,
      cacheLines,
    );
  }

  return trimBufferWithScrollbackStart(viewportLines, undefined, snapshot.rows, cacheLines);
}

function createBlankCell(): TerminalCell {
  return {
    char: 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function applyViewportUpdate(previous: TerminalSnapshot | undefined, update: TerminalViewportUpdate): TerminalSnapshot {
  const viewport =
    previous && previous.cols === update.cols && previous.rows === update.rows
      ? previous.viewport.map((row) => row.map((cell) => ({ ...cell })))
      : Array.from({ length: update.rows }, () =>
          Array.from({ length: update.cols }, () => createBlankCell()),
        );

  for (const patch of update.rowsPatch) {
    if (patch.row < 0 || patch.row >= viewport.length) {
      continue;
    }
    viewport[patch.row] = patch.cells.map((cell) => ({ ...cell }));
  }

  return {
    cols: update.cols,
    rows: update.rows,
    viewport,
    cursor: update.cursor,
    cursorKeysApp: update.cursorKeysApp,
    scrollbackLines: previous?.scrollbackLines,
    scrollbackStartIndex: previous?.scrollbackStartIndex,
  };
}

function incrementBufferRevision(session: Session) {
  return (session.bufferRevision || 0) + 1;
}

function sessionReducer(state: SessionManagerState, action: SessionAction): SessionManagerState {
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
    case 'SET_SESSION_SNAPSHOT':
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== action.id) {
            return session;
          }
          const nextBuffer = mergeSnapshotIntoBufferLines(action.snapshot, action.cacheLines);
          return {
            ...session,
            remoteSnapshot: action.snapshot,
            bufferLines: nextBuffer.lines,
            scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
            bufferUpdateKind: 'replace',
            bufferRevision: incrementBufferRevision(session),
            outputHistory: trimOutputHistory(nextBuffer.lines.join('\n'), action.cacheLines),
          };
        }),
      };
    case 'APPLY_VIEWPORT_UPDATE':
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== action.id) {
            return session;
          }
          const currentScrollbackLines = session.remoteSnapshot?.scrollbackLines?.slice() || [];
          const nextSnapshot = applyViewportUpdate(session.remoteSnapshot, action.update);
          nextSnapshot.scrollbackLines = currentScrollbackLines;
          nextSnapshot.scrollbackStartIndex = session.scrollbackStartIndex;
          const nextBuffer = mergeSnapshotIntoBufferLines(nextSnapshot, action.cacheLines);
          return {
            ...session,
            remoteSnapshot: nextSnapshot,
            bufferLines: nextBuffer.lines,
            scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
            bufferUpdateKind: 'viewport',
            bufferRevision: incrementBufferRevision(session),
            outputHistory: trimOutputHistory(nextBuffer.lines.join('\n'), action.cacheLines),
          };
        }),
      };
    case 'APPLY_SCROLLBACK_UPDATE':
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== action.id) {
            return session;
          }

          const viewportLineCount = session.remoteSnapshot?.rows || 0;
          const currentScrollback = session.remoteSnapshot?.scrollbackLines?.slice() || [];
          const viewportLines = session.remoteSnapshot?.viewport?.map(cellsToLine) || [];

          let nextScrollback = currentScrollback;
          let nextScrollbackStartIndex = session.scrollbackStartIndex;
          let kind: Session['bufferUpdateKind'] = 'append';

          if (action.update.mode === 'reset') {
            nextScrollback = action.update.lines.slice();
            nextScrollbackStartIndex = action.update.startIndex;
            kind = 'replace';
          } else {
            const merged = mergeIndexedScrollbackLines(
              currentScrollback,
              session.scrollbackStartIndex,
              action.update.lines,
              action.update.startIndex,
            );
            nextScrollback = merged.lines;
            nextScrollbackStartIndex = merged.scrollbackStartIndex;
            kind = action.update.mode === 'prepend' ? 'prepend' : 'append';
          }

          if (action.update.startIndex === undefined) {
            if (action.update.mode === 'prepend') {
              nextScrollback = [...action.update.lines, ...currentScrollback];
              kind = 'prepend';
            } else if (action.update.mode === 'append') {
              nextScrollback = [...currentScrollback, ...action.update.lines];
              kind = 'append';
            }
            nextScrollbackStartIndex = undefined;
          }

          const nextBuffer = trimBufferWithScrollbackStart(
            [...nextScrollback, ...viewportLines],
            nextScrollbackStartIndex,
            viewportLineCount,
            action.cacheLines,
          );
          const nextSnapshot = session.remoteSnapshot
            ? {
                ...session.remoteSnapshot,
                scrollbackLines: nextScrollback,
                scrollbackStartIndex: nextScrollbackStartIndex,
              }
            : session.remoteSnapshot;
          return {
            ...session,
            remoteSnapshot: nextSnapshot,
            bufferLines: nextBuffer.lines,
            scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
            bufferUpdateKind: kind,
            bufferRevision: incrementBufferRevision(session),
            outputHistory: trimOutputHistory(nextBuffer.lines.join('\n'), action.cacheLines),
          };
        }),
      };
    case 'SET_SESSION_BUFFER_LINES': {
      const nextBuffer = trimBufferWithScrollbackStart(action.lines, undefined, 0, action.cacheLines);
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === action.id
            ? {
                ...session,
                bufferLines: nextBuffer.lines,
                scrollbackStartIndex: nextBuffer.scrollbackStartIndex,
                bufferUpdateKind: 'replace',
                bufferRevision: incrementBufferRevision(session),
                outputHistory: trimOutputHistory(nextBuffer.lines.join('\n'), action.cacheLines),
              }
            : session,
        ),
      };
    }
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

interface SessionContextValue {
  state: SessionManagerState;
  createSession: (host: Host, options?: CreateSessionOptions) => string;
  closeSession: (id: string) => void;
  switchSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  reconnectSession: (id: string) => void;
  reconnectAllSessions: () => void;
  sendMessage: (sessionId: string, msg: ClientMessage) => void;
  sendInput: (data: string) => void;
  sendImagePaste: (file: File) => Promise<void>;
  resizeTerminal: (cols: number, rows: number) => void;
  updateSessionBufferLines: (sessionId: string, lines: string[]) => void;
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
  outputHistory?: string;
  bufferLines?: string[];
  scrollbackStartIndex?: number;
  remoteSnapshot?: TerminalSnapshot;
  createdAt?: number;
  sessionId?: string;
}

interface ReconnectBucket {
  attempt: number;
  activeSessionId: string | null;
  pending: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

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
  };
}

function computeReconnectDelay(attempt: number) {
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read image file'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected file reader result'));
        return;
      }
      const [, dataBase64 = ''] = result.split(',', 2);
      resolve(dataBase64);
    };
    reader.readAsDataURL(file);
  });
}

function normalizeRestoredSnapshots(input: unknown): SessionSnapshot[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is SessionSnapshot => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : crypto.randomUUID(),
      hostId: typeof item.hostId === 'string' ? item.hostId : crypto.randomUUID(),
      connectionName: typeof item.connectionName === 'string' ? item.connectionName : 'Recovered',
      bridgeHost: typeof item.bridgeHost === 'string' ? item.bridgeHost : '',
      bridgePort: typeof item.bridgePort === 'number' && Number.isFinite(item.bridgePort) ? item.bridgePort : 3333,
      sessionName: typeof item.sessionName === 'string' ? item.sessionName : 'wterm-mobile',
      authToken: typeof item.authToken === 'string' ? item.authToken : undefined,
      autoCommand: typeof item.autoCommand === 'string' ? item.autoCommand : undefined,
      customName: typeof item.customName === 'string' ? item.customName : undefined,
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      outputHistory: typeof item.outputHistory === 'string' ? item.outputHistory : '',
      bufferLines: Array.isArray(item.bufferLines)
        ? item.bufferLines.filter((line): line is string => typeof line === 'string')
        : typeof item.outputHistory === 'string'
          ? item.outputHistory.split('\n')
          : [],
      scrollbackStartIndex:
        typeof item.scrollbackStartIndex === 'number' && Number.isFinite(item.scrollbackStartIndex)
          ? item.scrollbackStartIndex
          : undefined,
      remoteSnapshot: item.remoteSnapshot && typeof item.remoteSnapshot === 'object'
        ? item.remoteSnapshot as TerminalSnapshot
        : undefined,
    }))
    .filter((item) => item.bridgeHost.trim().length > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function toSessionSnapshot(session: Session): SessionSnapshot {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
    bufferLines: session.bufferLines,
    scrollbackStartIndex: session.scrollbackStartIndex,
  };
}

export function SessionProvider({ children, wsUrl, terminalCacheLines = DEFAULT_TERMINAL_CACHE_LINES }: SessionProviderProps) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const stateRef = useRef(state);
  const wsRefs = useRef<Map<string, WebSocket>>(new Map());
  const pingIntervals = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const lastPongAtRef = useRef<Map<string, number>>(new Map());
  const sessionHostRef = useRef<Map<string, Host>>(new Map());
  const viewportSizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const reconnectBucketsRef = useRef<Map<string, ReconnectBucket>>(new Map());
  const manualCloseRef = useRef<Set<string>>(new Set());
  const restoreStartedRef = useRef(false);
  const streamModeRef = useRef<Map<string, 'active' | 'idle'>>(new Map());
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPersistedTabsPayloadRef = useRef('');
  const lastPersistedActiveSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    stateRef.current = state;
    if (typeof window === 'undefined') {
      return;
    }

    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      try {
        const tabsPayload = JSON.stringify(state.sessions.map(toSessionSnapshot));
        if (tabsPayload !== lastPersistedTabsPayloadRef.current) {
          localStorage.setItem(STORAGE_KEYS.OPEN_TABS, tabsPayload);
          lastPersistedTabsPayloadRef.current = tabsPayload;
        }

        if (state.activeSessionId) {
          if (state.activeSessionId !== lastPersistedActiveSessionIdRef.current) {
            localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, state.activeSessionId);
            lastPersistedActiveSessionIdRef.current = state.activeSessionId;
          }
        } else if (lastPersistedActiveSessionIdRef.current !== null) {
          localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
          lastPersistedActiveSessionIdRef.current = null;
        }
      } catch (error) {
        console.error('[SessionProvider] Failed to persist sessions:', error);
      }
    }, 900);

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [state]);

  const clearHeartbeat = useCallback((sessionId: string) => {
    const heartbeat = pingIntervals.current.get(sessionId);
    if (heartbeat) {
      clearInterval(heartbeat);
      pingIntervals.current.delete(sessionId);
    }
    lastPongAtRef.current.delete(sessionId);
  }, []);

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
    if (bucket.activeSessionId === sessionId && bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
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
    streamModeRef.current.delete(sessionId);
  }, [clearHeartbeat]);

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
    const delay = computeReconnectDelay(bucket.attempt);
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
      wsRefs.current.set(nextSessionId, ws);
      dispatch({ type: 'UPDATE_SESSION', id: nextSessionId, updates: { ws } });
      lastPongAtRef.current.set(nextSessionId, Date.now());

      let completed = false;
      const finalizeFailure = (message: string, retryable: boolean) => {
        if (completed) {
          return;
        }
        completed = true;
        cleanupSocket(nextSessionId);

        if (manualCloseRef.current.has(nextSessionId)) {
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
        const targetSessionName = getResolvedSessionName(targetHost);
        dispatch({
          type: 'UPDATE_SESSION',
          id: nextSessionId,
          updates: {
            state: 'connecting',
            sessionName: targetSessionName,
          },
        });

        const hostConfig: HostConfigMessage = {
          name: targetHost.name,
          bridgeHost: targetHost.bridgeHost,
          bridgePort: targetHost.bridgePort,
          sessionName: targetSessionName,
          authToken: targetHost.authToken,
          autoCommand: targetHost.autoCommand,
          authType: targetHost.authType,
          password: targetHost.password,
          privateKey: targetHost.privateKey,
        };
        ws.send(JSON.stringify({ type: 'connect', payload: hostConfig }));
        const desiredMode: 'active' | 'idle' = stateRef.current.activeSessionId === nextSessionId ? 'active' : 'idle';
        ws.send(JSON.stringify({ type: 'stream-mode', payload: { mode: desiredMode } }));
        streamModeRef.current.set(nextSessionId, desiredMode);

        const pingInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }

          const lastPongAt = lastPongAtRef.current.get(nextSessionId) || 0;
          if (Date.now() - lastPongAt > CLIENT_PONG_TIMEOUT_MS) {
            finalizeFailure('heartbeat timeout', true);
            if (ws.readyState < WebSocket.CLOSING) {
              ws.close();
            }
            return;
          }

          ws.send(JSON.stringify({ type: 'ping' }));
        }, CLIENT_PING_INTERVAL_MS);
        pingIntervals.current.set(nextSessionId, pingInterval);
      };

      ws.onmessage = (event) => {
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          switch (msg.type) {
            case 'connected':
              if (completed) return;
              completed = true;
              bucket.attempt = 0;
              bucket.activeSessionId = null;
              dispatch({
                type: 'UPDATE_SESSION',
                id: nextSessionId,
                updates: {
                  state: 'connected',
                  reconnectAttempt: 0,
                  lastError: undefined,
                },
              });
              dispatch({ type: 'INCREMENT_CONNECTED' });
              setTimeout(() => drainReconnectBucket(hostKey), POST_SUCCESS_NEXT_RETRY_DELAY_MS);
              break;
            case 'snapshot':
              dispatch({ type: 'SET_SESSION_SNAPSHOT', id: nextSessionId, snapshot: msg.payload, cacheLines: terminalCacheLines });
              break;
            case 'viewport-update':
              dispatch({ type: 'APPLY_VIEWPORT_UPDATE', id: nextSessionId, update: msg.payload, cacheLines: terminalCacheLines });
              break;
            case 'scrollback-update':
              dispatch({ type: 'APPLY_SCROLLBACK_UPDATE', id: nextSessionId, update: msg.payload, cacheLines: terminalCacheLines });
              break;
            case 'title':
              dispatch({ type: 'SET_SESSION_TITLE', id: nextSessionId, title: msg.payload });
              break;
            case 'image-pasted':
              break;
            case 'error':
              finalizeFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
              break;
            case 'closed':
              finalizeFailure(msg.payload.reason || 'socket closed', true);
              break;
            case 'sessions':
              break;
            case 'pong':
              lastPongAtRef.current.set(nextSessionId, Date.now());
              break;
          }
        } catch (error) {
          finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
        }
      };

      ws.onerror = () => finalizeFailure('WebSocket error', true);
      ws.onclose = () => finalizeFailure('socket closed', true);
    }, delay);
  }, [cleanupSocket, terminalCacheLines, wsUrl]);

  const scheduleReconnect = useCallback((sessionId: string, message: string, retryable = true) => {
    const host = sessionHostRef.current.get(sessionId);
    if (!host) {
      return;
    }

    const hostKey = toHostKey(host);
    const bucket = reconnectBucketsRef.current.get(hostKey) || createReconnectBucket();
    reconnectBucketsRef.current.set(hostKey, bucket);

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

  const connectSession = useCallback((sessionId: string, host: Host, activate: boolean) => {
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
    if (activate) {
      dispatch({ type: 'SET_ACTIVE_SESSION', id: sessionId });
    }

    const ws = new WebSocket(buildBridgeUrl(host, wsUrl));
    wsRefs.current.set(sessionId, ws);
    dispatch({ type: 'UPDATE_SESSION', id: sessionId, updates: { ws } });
    lastPongAtRef.current.set(sessionId, Date.now());

    let completed = false;
    const finalizeFailure = (message: string, retryable: boolean) => {
      if (completed) {
        return;
      }
      completed = true;
      cleanupSocket(sessionId);
      if (manualCloseRef.current.has(sessionId)) {
        return;
      }
      scheduleReconnect(sessionId, message, retryable);
    };

    ws.onopen = () => {
      const hostConfig: HostConfigMessage = {
        name: host.name,
        bridgeHost: host.bridgeHost,
        bridgePort: host.bridgePort,
        sessionName: getResolvedSessionName(host),
        authToken: host.authToken,
        autoCommand: host.autoCommand,
        authType: host.authType,
        password: host.password,
        privateKey: host.privateKey,
      };
      ws.send(JSON.stringify({ type: 'connect', payload: hostConfig }));
      const desiredMode: 'active' | 'idle' = stateRef.current.activeSessionId === sessionId || activate ? 'active' : 'idle';
      sendStreamMode(sessionId, desiredMode);

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
    };

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'connected':
            if (completed) return;
            completed = true;
            dispatch({
              type: 'UPDATE_SESSION',
              id: sessionId,
              updates: {
                state: 'connected',
                reconnectAttempt: 0,
                lastError: undefined,
              },
            });
            dispatch({ type: 'INCREMENT_CONNECTED' });
            break;
          case 'snapshot':
            dispatch({ type: 'SET_SESSION_SNAPSHOT', id: sessionId, snapshot: msg.payload, cacheLines: terminalCacheLines });
            break;
          case 'viewport-update':
            dispatch({ type: 'APPLY_VIEWPORT_UPDATE', id: sessionId, update: msg.payload, cacheLines: terminalCacheLines });
            break;
          case 'scrollback-update':
            dispatch({ type: 'APPLY_SCROLLBACK_UPDATE', id: sessionId, update: msg.payload, cacheLines: terminalCacheLines });
            break;
          case 'error':
            finalizeFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
            break;
          case 'title':
            dispatch({ type: 'SET_SESSION_TITLE', id: sessionId, title: msg.payload });
            break;
          case 'image-pasted':
            break;
          case 'closed':
            finalizeFailure(msg.payload.reason || 'socket closed', true);
            break;
          case 'sessions':
            break;
          case 'pong':
            lastPongAtRef.current.set(sessionId, Date.now());
            break;
        }
      } catch (error) {
        finalizeFailure(error instanceof Error ? error.message : 'parse error', true);
      }
    };

    ws.onerror = () => finalizeFailure('WebSocket error', true);
    ws.onclose = () => finalizeFailure('socket closed', true);
  }, [cleanupSocket, scheduleReconnect, terminalCacheLines, wsUrl]);

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
      outputHistory: options?.outputHistory || '',
      bufferLines: normalizeBufferLines(options?.bufferLines || options?.outputHistory?.split('\n') || [], terminalCacheLines),
      scrollbackStartIndex: options?.scrollbackStartIndex,
      remoteSnapshot: options?.remoteSnapshot,
      bufferUpdateKind: 'replace',
      bufferRevision: 0,
      reconnectAttempt: 0,
      createdAt: options?.createdAt || Date.now(),
    };

    dispatch({ type: 'CREATE_SESSION', session, activate: options?.activate !== false });
    connectSession(sessionId, host, options?.activate !== false);
    return sessionId;
  }, [connectSession]);

  const closeSession = useCallback((id: string) => {
    manualCloseRef.current.add(id);
    clearReconnectForSession(id);

    const ws = wsRefs.current.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'close' }));
    }
    cleanupSocket(id, true);
    sessionHostRef.current.delete(id);
    viewportSizeRef.current.delete(id);
    dispatch({ type: 'DELETE_SESSION', id });
  }, [cleanupSocket, clearReconnectForSession]);

  const switchSession = useCallback((id: string) => dispatch({ type: 'SET_ACTIVE_SESSION', id }), []);

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

    console.debug('[SessionContext] reconnect session ->', {
      sessionId: id,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      sessionName: host.sessionName,
    });

    connectSession(id, host, stateRef.current.activeSessionId === id);
  }, [connectSession]);

  const reconnectAllSessions = useCallback(() => {
    for (const session of stateRef.current.sessions) {
      reconnectSession(session.id);
    }
  }, [reconnectSession]);

  const sendMessage = useCallback((sessionId: string, msg: ClientMessage) => {
    const ws = wsRefs.current.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const sendStreamMode = useCallback((sessionId: string, desiredMode: 'active' | 'idle') => {
    const ws = wsRefs.current.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify({ type: 'stream-mode', payload: { mode: desiredMode } }));
    streamModeRef.current.set(sessionId, desiredMode);
  }, []);

  useEffect(() => {
    for (const session of state.sessions) {
      const ws = wsRefs.current.get(session.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const desiredMode: 'active' | 'idle' = state.activeSessionId === session.id ? 'active' : 'idle';
      if (streamModeRef.current.get(session.id) === desiredMode) {
        continue;
      }
      sendStreamMode(session.id, desiredMode);
    }
  }, [sendStreamMode, state.activeSessionId, state.sessions]);

  const sendInput = useCallback((data: string) => {
    const targetSessionId =
      stateRef.current.activeSessionId
      || stateRef.current.sessions.find((session) => session.state === 'connected')?.id
      || stateRef.current.sessions[0]?.id;

    if (targetSessionId) {
      sendMessage(targetSessionId, { type: 'input', payload: data });
    }
  }, [sendMessage]);

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
      reconnectSession(sessionId);
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
  }, [reconnectSession]);

  const sendImagePaste = useCallback(async (file: File) => {
    const sessionId = stateRef.current.activeSessionId;
    if (!sessionId) {
      throw new Error('No active session for image paste');
    }

    await ensureSessionReadyForPaste(sessionId);

    const dataBase64 = await fileToBase64(file);
    sendMessage(sessionId, {
      type: 'paste-image',
      payload: {
        name: file.name || 'upload',
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
        pasteSequence: '\x16',
      },
    });
  }, [ensureSessionReadyForPaste, sendMessage]);

  const resizeTerminal = useCallback((cols: number, rows: number) => {
    if (stateRef.current.activeSessionId) {
      const sessionId = stateRef.current.activeSessionId;
      const previous = viewportSizeRef.current.get(sessionId);
      if (previous && previous.cols === cols && previous.rows === rows) {
        return;
      }
      viewportSizeRef.current.set(sessionId, { cols, rows });
      sendMessage(sessionId, { type: 'resize', payload: { cols, rows } });
    }
  }, [sendMessage]);

  const updateSessionBufferLines = useCallback((sessionId: string, lines: string[]) => {
    dispatch({ type: 'SET_SESSION_BUFFER_LINES', id: sessionId, lines, cacheLines: terminalCacheLines });
  }, [terminalCacheLines]);

  const getActiveSession = useCallback(
    () => stateRef.current.sessions.find((session) => session.id === stateRef.current.activeSessionId) || null,
    [],
  );

  const getSession = useCallback((id: string) => stateRef.current.sessions.find((session) => session.id === id) || null, []);

  useEffect(() => {
    if (typeof window === 'undefined' || restoreStartedRef.current) {
      return;
    }

    restoreStartedRef.current = true;
    try {
      const rawSnapshots = localStorage.getItem(STORAGE_KEYS.OPEN_TABS);
      const activeSessionId = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
      const snapshots = normalizeRestoredSnapshots(rawSnapshots ? JSON.parse(rawSnapshots) : []);

      for (const snapshot of snapshots) {
        createSession(
          {
            id: snapshot.hostId,
            createdAt: snapshot.createdAt,
            name: snapshot.connectionName,
            bridgeHost: snapshot.bridgeHost,
            bridgePort: snapshot.bridgePort,
            sessionName: snapshot.sessionName,
            authToken: snapshot.authToken,
            authType: 'password',
            tags: [],
            pinned: false,
            autoCommand: snapshot.autoCommand,
          },
          {
            sessionId: snapshot.sessionId,
            createdAt: snapshot.createdAt,
            customName: snapshot.customName,
            outputHistory: snapshot.outputHistory,
            bufferLines: snapshot.bufferLines,
            scrollbackStartIndex: snapshot.scrollbackStartIndex,
            remoteSnapshot: snapshot.remoteSnapshot,
            activate: snapshot.sessionId === activeSessionId,
          },
        );
      }
    } catch (error) {
      console.error('[SessionProvider] Failed to restore sessions:', error);
    }
  }, [createSession]);

  useEffect(() => () => {
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
    createSession,
    closeSession,
    switchSession,
    renameSession,
    reconnectSession,
    reconnectAllSessions,
    sendMessage,
    sendInput,
    sendImagePaste,
    resizeTerminal,
    updateSessionBufferLines,
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
