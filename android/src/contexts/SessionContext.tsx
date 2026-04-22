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
  SessionState,
  TerminalBufferPayload,
  TerminalCell,
} from '../lib/types';
import { STORAGE_KEYS } from '../lib/types';
import { buildBridgeUrl } from '../lib/bridge-url';
import { getResolvedSessionName } from '../lib/connection-target';
import { getDefaultTerminalViewportSize } from '../lib/default-terminal-viewport';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import { drainRuntimeDebugEntries, getPendingRuntimeDebugEntryCount, isRuntimeDebugEnabled, runtimeDebug } from '../lib/runtime-debug';
import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
} from '../lib/terminal-buffer';

const SESSION_STATUS_EVENT = 'zterm:session-status';

const RECONNECT_BASE_DELAY_MS = 1200;
const RECONNECT_MAX_DELAY_MS = 30000;
const POST_SUCCESS_NEXT_RETRY_DELAY_MS = 240;
const IMAGE_PASTE_READY_TIMEOUT_MS = 6000;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;
const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;

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
  const pendingInputQueueRef = useRef<Map<string, string[]>>(new Map());
  const restoreStartedRef = useRef(false);

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
  }, []);

  useEffect(() => {
    stateRef.current = state;
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
        runtimeDebug('session.ws.reconnect.onopen', {
          sessionId: nextSessionId,
          targetSessionName,
          viewport,
          activeSessionId: stateRef.current.activeSessionId,
        });
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
        runtimeDebug('session.ws.reconnect.connect-sent', {
          sessionId: nextSessionId,
          viewport,
        });
        flushRuntimeDebugLogs();

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
              runtimeDebug('session.ws.reconnect.connected', {
                sessionId: nextSessionId,
                activeSessionId: stateRef.current.activeSessionId,
              });
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
              flushPendingInputQueue(nextSessionId);
              dispatch({ type: 'INCREMENT_CONNECTED' });
              setTimeout(() => drainReconnectBucket(hostKey), POST_SUCCESS_NEXT_RETRY_DELAY_MS);
              break;
            case 'buffer-sync':
              runtimeDebug('session.ws.reconnect.buffer-sync', {
                sessionId: nextSessionId,
                payload: summarizeBufferPayload(msg.payload),
                activeSessionId: stateRef.current.activeSessionId,
              });
              dispatch({
                type: 'SET_SESSION_BUFFER_SYNC',
                id: nextSessionId,
                payload: normalizeIncomingBufferPayload(msg.payload),
                cacheLines: terminalCacheLines,
              });
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
      runtimeDebug('session.ws.connect.onopen', {
        sessionId,
        viewport,
        activeSessionId: stateRef.current.activeSessionId,
        activate,
      });
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
      runtimeDebug('session.ws.connect.connect-sent', {
        sessionId,
        viewport,
      });
      flushRuntimeDebugLogs();

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
            runtimeDebug('session.ws.connected', {
              sessionId,
              activeSessionId: stateRef.current.activeSessionId,
            });
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
          case 'buffer-sync':
            runtimeDebug('session.ws.buffer-sync', {
              sessionId,
              payload: summarizeBufferPayload(msg.payload),
              activeSessionId: stateRef.current.activeSessionId,
            });
            dispatch({
              type: 'SET_SESSION_BUFFER_SYNC',
              id: sessionId,
              payload: normalizeIncomingBufferPayload(msg.payload),
              cacheLines: terminalCacheLines,
            });
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
      buffer: options?.buffer || createSessionBufferState({
        lines: [],
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
    pendingInputQueueRef.current.delete(id);
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

  const sendInput = useCallback((data: string) => {
    const targetSessionId =
      stateRef.current.activeSessionId
      || stateRef.current.sessions.find((session) => session.state === 'connected')?.id
      || stateRef.current.sessions[0]?.id;

    if (!targetSessionId) {
      runtimeDebug('session.input.skip', {
        why: 'no-target-session',
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
      return;
    }

    runtimeDebug('session.input.queue', {
      sessionId: targetSessionId,
      size: data.length,
      preview: data.slice(0, 32),
    });
    enqueuePendingInput(targetSessionId, data);
  }, [enqueuePendingInput]);

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
      localStorage.removeItem(STORAGE_KEYS.OPEN_TABS);
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
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
