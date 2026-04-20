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
  SessionBufferState,
  SessionSnapshot,
  SessionState,
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportUpdate,
} from '../lib/types';
import { STORAGE_KEYS } from '../lib/types';
import { buildBridgeUrl } from '../lib/bridge-url';
import { getResolvedSessionName } from '../lib/connection-target';
import { getDefaultTerminalViewportSize } from '../lib/default-terminal-viewport';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import {
  applyScrollbackUpdateToSessionBuffer,
  applySnapshotToSessionBuffer,
  applyViewportUpdateToSessionBuffer,
  buildScrollbackRecoveryRange,
  createSessionBufferState,
  isScrollbackUpdateContiguous,
  normalizeBufferLines,
  replaceSessionBufferLines,
  sessionBufferToHistory,
} from '../lib/terminal-buffer';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;
const POST_SUCCESS_NEXT_RETRY_DELAY_MS = 240;
const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;

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

interface SessionManagerState {
  sessions: Session[];
  activeSessionId: string | null;
  connectedCount: number;
}

type SessionAction =
  | { type: 'CREATE_SESSION'; session: Session; activate: boolean }
  | { type: 'UPDATE_SESSION'; id: string; updates: Partial<Session> }
  | { type: 'MOVE_SESSION'; id: string; toIndex: number }
  | { type: 'SET_SESSION_SNAPSHOT'; id: string; snapshot: TerminalSnapshot; cacheLines: number }
  | { type: 'APPLY_VIEWPORT_UPDATE'; id: string; update: TerminalViewportUpdate; cacheLines: number }
  | { type: 'APPLY_SCROLLBACK_UPDATE'; id: string; update: TerminalScrollbackUpdate; cacheLines: number }
  | { type: 'SET_SESSION_BUFFER_LINES'; id: string; lines: string[]; cacheLines: number }
  | { type: 'DELETE_SESSION'; id: string }
  | { type: 'SET_ACTIVE_SESSION'; id: string }
  | { type: 'SET_SESSION_STATE'; id: string; state: SessionState }
  | { type: 'SET_SESSION_TITLE'; id: string; title: string }
  | { type: 'BATCH_ACTIONS'; actions: SessionAction[] }
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
    case 'SET_SESSION_SNAPSHOT':
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== action.id) {
            return session;
          }
          const nextBuffer = applySnapshotToSessionBuffer(session.buffer, action.snapshot, action.cacheLines);
          return {
            ...session,
            buffer: nextBuffer,
            outputHistory: sessionBufferToHistory(nextBuffer, action.cacheLines),
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
          const nextBuffer = applyViewportUpdateToSessionBuffer(session.buffer, action.update, action.cacheLines);
          return {
            ...session,
            buffer: nextBuffer,
            outputHistory: session.outputHistory,
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
          const nextBuffer = applyScrollbackUpdateToSessionBuffer(session.buffer, action.update, action.cacheLines);
          return {
            ...session,
            buffer: nextBuffer,
            outputHistory: session.outputHistory,
          };
        }),
      };
    case 'SET_SESSION_BUFFER_LINES': {
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === action.id
            ? (() => {
                const nextBuffer = replaceSessionBufferLines(session.buffer, action.lines, action.cacheLines);
                return {
                  ...session,
                  buffer: nextBuffer,
                  outputHistory: sessionBufferToHistory(nextBuffer, action.cacheLines),
                };
              })()
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

function sessionReducer(state: SessionManagerState, action: SessionAction): SessionManagerState {
  if (action.type === 'BATCH_ACTIONS') {
    return action.actions.reduce(reduceSessionAction, state);
  }
  return reduceSessionAction(state, action);
}

interface SessionContextValue {
  state: SessionManagerState;
  createSession: (host: Host, options?: CreateSessionOptions) => string;
  closeSession: (id: string) => void;
  switchSession: (id: string) => void;
  moveSession: (id: string, toIndex: number) => void;
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
  buffer?: SessionBufferState;
  bufferLines?: string[];
  lineStartIndex?: number;
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
  nextDelayMs: number | null;
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
    nextDelayMs: null,
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
      sessionName: typeof item.sessionName === 'string' ? item.sessionName : 'zterm',
      authToken: typeof item.authToken === 'string' ? item.authToken : undefined,
      autoCommand: typeof item.autoCommand === 'string' ? item.autoCommand : undefined,
      customName: typeof item.customName === 'string' ? item.customName : undefined,
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      outputHistory: typeof item.outputHistory === 'string' ? item.outputHistory : '',
      buffer: item.buffer && typeof item.buffer === 'object'
        ? (() => {
            const updateKind: SessionBufferState['updateKind'] =
              item.buffer.updateKind === 'append'
              || item.buffer.updateKind === 'prepend'
              || item.buffer.updateKind === 'viewport'
                ? item.buffer.updateKind
                : 'replace';
            return {
              lines: Array.isArray(item.buffer.lines)
                ? item.buffer.lines.filter((line): line is string => typeof line === 'string')
                : [],
              lineStartIndex:
                typeof item.buffer.lineStartIndex === 'number' && Number.isFinite(item.buffer.lineStartIndex)
                  ? item.buffer.lineStartIndex
                  : typeof item.buffer.scrollbackStartIndex === 'number' && Number.isFinite(item.buffer.scrollbackStartIndex)
                    ? item.buffer.scrollbackStartIndex
                    : undefined,
              scrollbackStartIndex:
                typeof item.buffer.scrollbackStartIndex === 'number' && Number.isFinite(item.buffer.scrollbackStartIndex)
                  ? item.buffer.scrollbackStartIndex
                  : undefined,
              updateKind,
              revision:
                typeof item.buffer.revision === 'number' && Number.isFinite(item.buffer.revision)
                  ? item.buffer.revision
                  : 0,
              remoteSnapshot: item.buffer.remoteSnapshot && typeof item.buffer.remoteSnapshot === 'object'
                ? item.buffer.remoteSnapshot as TerminalSnapshot
                : undefined,
            };
          })()
        : createSessionBufferState({
            lines: Array.isArray(item.bufferLines)
              ? item.bufferLines.filter((line): line is string => typeof line === 'string')
              : typeof item.outputHistory === 'string'
                ? item.outputHistory.split('\n')
                : [],
            lineStartIndex:
              typeof item.lineStartIndex === 'number' && Number.isFinite(item.lineStartIndex)
                ? item.lineStartIndex
                : typeof item.scrollbackStartIndex === 'number' && Number.isFinite(item.scrollbackStartIndex)
                  ? item.scrollbackStartIndex
                  : undefined,
            scrollbackStartIndex:
              typeof item.scrollbackStartIndex === 'number' && Number.isFinite(item.scrollbackStartIndex)
                ? item.scrollbackStartIndex
                : undefined,
            remoteSnapshot: item.remoteSnapshot && typeof item.remoteSnapshot === 'object'
              ? item.remoteSnapshot as TerminalSnapshot
              : undefined,
            cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
          }),
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
    buffer: session.buffer,
    outputHistory: session.outputHistory,
    lineStartIndex: session.buffer.lineStartIndex,
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
  const pendingRangeSyncRef = useRef<Map<string, string>>(new Map());
  const pendingRenderActionsRef = useRef<SessionAction[]>([]);
  const pendingRenderFrameRef = useRef<number | null>(null);
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

  const flushQueuedRenderActions = useCallback(() => {
    pendingRenderFrameRef.current = null;
    if (pendingRenderActionsRef.current.length === 0) {
      return;
    }
    const actions = pendingRenderActionsRef.current;
    pendingRenderActionsRef.current = [];
    dispatch({ type: 'BATCH_ACTIONS', actions });
  }, []);

  const enqueueRenderAction = useCallback((action: SessionAction) => {
    pendingRenderActionsRef.current.push(action);
    if (pendingRenderFrameRef.current !== null) {
      return;
    }
    pendingRenderFrameRef.current = window.requestAnimationFrame(() => {
      flushQueuedRenderActions();
    });
  }, [flushQueuedRenderActions]);

  useEffect(() => () => {
    if (pendingRenderFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingRenderFrameRef.current);
      pendingRenderFrameRef.current = null;
    }
  }, []);

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
        const viewport = resolveInitialViewportSize(viewportSizeRef.current, nextSessionId);
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
          cols: viewport.cols,
          rows: viewport.rows,
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
              clearPendingRangeSync(nextSessionId);
              enqueueRenderAction({ type: 'SET_SESSION_SNAPSHOT', id: nextSessionId, snapshot: msg.payload, cacheLines: terminalCacheLines });
              break;
            case 'viewport-update':
              enqueueRenderAction({ type: 'APPLY_VIEWPORT_UPDATE', id: nextSessionId, update: msg.payload, cacheLines: terminalCacheLines });
              break;
            case 'scrollback-update':
              if (maybeRecoverScrollbackGap(nextSessionId, msg.payload)) {
                break;
              }
              if (msg.payload.mode === 'reset') {
                clearPendingRangeSync(nextSessionId);
              }
              enqueueRenderAction({ type: 'APPLY_SCROLLBACK_UPDATE', id: nextSessionId, update: msg.payload, cacheLines: terminalCacheLines });
              break;
            case 'title':
              enqueueRenderAction({ type: 'SET_SESSION_TITLE', id: nextSessionId, title: msg.payload });
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
      const viewport = resolveInitialViewportSize(viewportSizeRef.current, sessionId);
      const hostConfig: HostConfigMessage = {
        name: host.name,
        bridgeHost: host.bridgeHost,
        bridgePort: host.bridgePort,
        sessionName: getResolvedSessionName(host),
        cols: viewport.cols,
        rows: viewport.rows,
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
            clearPendingRangeSync(sessionId);
            enqueueRenderAction({ type: 'SET_SESSION_SNAPSHOT', id: sessionId, snapshot: msg.payload, cacheLines: terminalCacheLines });
            break;
          case 'viewport-update':
            enqueueRenderAction({ type: 'APPLY_VIEWPORT_UPDATE', id: sessionId, update: msg.payload, cacheLines: terminalCacheLines });
            break;
          case 'scrollback-update':
            if (maybeRecoverScrollbackGap(sessionId, msg.payload)) {
              break;
            }
            if (msg.payload.mode === 'reset') {
              clearPendingRangeSync(sessionId);
            }
            enqueueRenderAction({ type: 'APPLY_SCROLLBACK_UPDATE', id: sessionId, update: msg.payload, cacheLines: terminalCacheLines });
            break;
          case 'error':
            finalizeFailure(msg.payload.message, msg.payload.code !== 'unauthorized');
            break;
          case 'title':
            enqueueRenderAction({ type: 'SET_SESSION_TITLE', id: sessionId, title: msg.payload });
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
  }, [cleanupSocket, clearReconnectForSession, scheduleReconnect, terminalCacheLines, wsUrl]);

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
      buffer: options?.buffer || createSessionBufferState({
        lines: normalizeBufferLines(options?.bufferLines || options?.outputHistory?.split('\n') || [], terminalCacheLines),
        lineStartIndex: options?.lineStartIndex,
        scrollbackStartIndex: options?.scrollbackStartIndex,
        remoteSnapshot: options?.remoteSnapshot,
        cacheLines: terminalCacheLines,
      }),
      reconnectAttempt: 0,
      createdAt: options?.createdAt || Date.now(),
    };

    dispatch({ type: 'CREATE_SESSION', session, activate: options?.activate !== false });
    connectSession(sessionId, host, options?.activate !== false);
    return sessionId;
  }, [connectSession]);

  const closeSession = useCallback((id: string) => {
    manualCloseRef.current.add(id);
    pendingRangeSyncRef.current.delete(id);
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
    pendingRangeSyncRef.current.delete(id);
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

  const clearPendingRangeSync = useCallback((sessionId: string) => {
    pendingRangeSyncRef.current.delete(sessionId);
  }, []);

  const requestScrollbackRangeSync = useCallback((sessionId: string, startIndex: number, endIndex: number) => {
    const normalizedStart = Math.max(0, Math.floor(startIndex));
    const normalizedEnd = Math.max(normalizedStart, Math.floor(endIndex));
    const requestKey = `${normalizedStart}:${normalizedEnd}`;
    if (pendingRangeSyncRef.current.get(sessionId) === requestKey) {
      return;
    }

    pendingRangeSyncRef.current.set(sessionId, requestKey);
    sendMessage(sessionId, {
      type: 'request-scrollback-range',
      payload: {
        startIndex: normalizedStart,
        endIndex: normalizedEnd,
      },
    });
  }, [sendMessage]);

  const maybeRecoverScrollbackGap = useCallback((sessionId: string, update: TerminalScrollbackUpdate) => {
    if (update.mode === 'reset') {
      clearPendingRangeSync(sessionId);
      return false;
    }

    const session = stateRef.current.sessions.find((item) => item.id === sessionId);
    if (!session || isScrollbackUpdateContiguous(session.buffer, update)) {
      return false;
    }

    const recoveryRange = buildScrollbackRecoveryRange(session.buffer, update, terminalCacheLines);
    if (!recoveryRange) {
      return false;
    }

    requestScrollbackRangeSync(sessionId, recoveryRange.startIndex, recoveryRange.endIndex);
    return true;
  }, [clearPendingRangeSync, requestScrollbackRangeSync, terminalCacheLines]);

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
            buffer: snapshot.buffer,
            bufferLines: snapshot.bufferLines,
            lineStartIndex: snapshot.lineStartIndex,
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
    moveSession,
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
