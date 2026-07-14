import {
  applyBufferSyncToSessionBuffer,
  createTmuxSession,
  createSessionBufferState,
  fetchTmuxSessions,
  killTmuxSession,
  openBridgeConnection,
  type BridgeServerMessage,
  type SessionBufferState,
  type TerminalRenderBufferProjection,
} from '@zterm/shared';

export interface WindowsTerminalTarget {
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
}

export interface WindowsTerminalSnapshot {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string;
  sessionId: string;
  buffer: SessionBufferState;
}

export interface WindowsTerminalSession {
  getSnapshot: () => WindowsTerminalSnapshot;
  subscribe: (listener: () => void) => () => void;
  connect: (target: WindowsTerminalTarget) => void;
  disconnect: () => void;
  sendInput: (data: string) => boolean;
  requestVisibleRange: (input: { startIndex?: number; endIndex?: number }) => boolean;
  dispose: () => void;
}

export interface WindowsSessionControlSnapshot {
  status: 'idle' | 'loading' | 'error';
  error: string;
  sessions: string[];
}

export interface WindowsSessionControl {
  getSnapshot: () => WindowsSessionControlSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: (target: Pick<WindowsTerminalTarget, 'bridgeHost' | 'bridgePort' | 'authToken'>) => Promise<string[]>;
  create: (target: Pick<WindowsTerminalTarget, 'bridgeHost' | 'bridgePort' | 'authToken'>, sessionName: string) => Promise<string[]>;
  close: (target: Pick<WindowsTerminalTarget, 'bridgeHost' | 'bridgePort' | 'authToken'>, sessionName: string) => Promise<string[]>;
}

const CACHE_LINES = 3000;

function emptyBuffer() {
  return createSessionBufferState({ lines: [], cols: 80, rows: 24, cacheLines: CACHE_LINES });
}

export function projectWindowsTerminalBuffer(buffer: SessionBufferState): TerminalRenderBufferProjection {
  return {
    lines: buffer.lines,
    gapRanges: buffer.gapRanges,
    startIndex: buffer.startIndex,
    endIndex: buffer.endIndex,
    viewportEndIndex: buffer.bufferTailEndIndex,
    cols: buffer.cols,
    rows: buffer.rows,
    cursorKeysApp: buffer.cursorKeysApp,
    revision: buffer.revision,
  };
}

export function canRequestWindowsVisibleRange(snapshot: WindowsTerminalSnapshot) {
  return snapshot.status === 'connected' && snapshot.buffer.revision > 0;
}

function sortSessions(sessions: string[]) {
  return Array.from(new Set(sessions.map((session) => session.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function normalizeControlTarget(target: Pick<WindowsTerminalTarget, 'bridgeHost' | 'bridgePort' | 'authToken'>) {
  return {
    bridgeHost: target.bridgeHost.trim(),
    bridgePort: target.bridgePort,
    authToken: target.authToken,
  };
}

export function normalizeWindowsNewSessionName(input: string) {
  return input.trim();
}

export function createWindowsSessionControl(): WindowsSessionControl {
  const listeners = new Set<() => void>();
  let snapshot: WindowsSessionControlSnapshot = { status: 'idle', error: '', sessions: [] };
  const emit = () => listeners.forEach((listener) => listener());
  const update = (next: Partial<WindowsSessionControlSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    emit();
  };
  const run = async (operation: () => Promise<string[]>) => {
    update({ status: 'loading', error: '' });
    try {
      const sessions = sortSessions(await operation());
      update({ status: 'idle', error: '', sessions });
      return sessions;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      update({ status: 'error', error: message });
      throw error;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: (target) => run(() => fetchTmuxSessions(normalizeControlTarget(target))),
    create: (target, sessionName) => {
      const normalized = normalizeWindowsNewSessionName(sessionName);
      if (!normalized) return Promise.reject(new Error('Session name is required'));
      return run(() => createTmuxSession(normalizeControlTarget(target), normalized));
    },
    close: (target, sessionName) => {
      const normalized = normalizeWindowsNewSessionName(sessionName);
      if (!normalized) return Promise.reject(new Error('Session name is required'));
      return run(() => killTmuxSession(normalizeControlTarget(target), normalized));
    },
  };
}

export function createWindowsTerminalSession(): WindowsTerminalSession {
  const listeners = new Set<() => void>();
  let socket: WebSocket | null = null;
  let generation = 0;
  let snapshot: WindowsTerminalSnapshot = { status: 'idle', error: '', sessionId: '', buffer: emptyBuffer() };
  const emit = () => listeners.forEach((listener) => listener());
  const update = (next: Partial<WindowsTerminalSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    emit();
  };
  const disconnect = () => {
    generation += 1;
    const current = socket;
    socket = null;
    if (current && current.readyState < WebSocket.CLOSING) current.close(1000, 'windows shell disconnect');
    snapshot = { status: 'idle', error: '', sessionId: '', buffer: emptyBuffer() };
    emit();
  };
  const handleMessage = (message: BridgeServerMessage) => {
    if (message.type !== 'buffer-sync') return;
    update({ buffer: applyBufferSyncToSessionBuffer(snapshot.buffer, message.payload, CACHE_LINES) });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: (target) => {
      disconnect();
      const currentGeneration = generation;
      update({ status: 'connecting' });
      const openRequestId = crypto.randomUUID();
      socket = openBridgeConnection({
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        authToken: target.authToken,
      }, {
        openRequestId,
        sessionName: target.sessionName,
        cols: 80,
        rows: 24,
      }, {
        onConnected: ({ sessionId }) => {
          if (generation !== currentGeneration) return;
          update({ status: 'connected', error: '', sessionId });
        },
        onMessage: (message) => {
          if (generation === currentGeneration) handleMessage(message);
        },
        onError: (message) => {
          if (generation === currentGeneration) update({ status: 'error', error: message });
        },
        onClosed: (reason) => {
          if (generation === currentGeneration && snapshot.status !== 'idle') update({ status: 'error', error: reason });
        },
      });
    },
    disconnect,
    sendInput: (data) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(data);
      return true;
    },
    requestVisibleRange: ({ startIndex, endIndex }) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (!canRequestWindowsVisibleRange(snapshot)) return false;
      const requestStartIndex = Math.max(0, Math.floor(startIndex ?? snapshot.buffer.startIndex));
      const requestEndIndex = Math.max(requestStartIndex, Math.floor(endIndex ?? snapshot.buffer.endIndex));
      socket.send(JSON.stringify({
        type: 'buffer-sync-request',
        payload: {
          knownRevision: snapshot.buffer.revision,
          localStartIndex: snapshot.buffer.startIndex,
          localEndIndex: snapshot.buffer.endIndex,
          requestStartIndex,
          requestEndIndex,
          missingRanges: snapshot.buffer.gapRanges,
        },
      }));
      return true;
    },
    dispose: () => {
      disconnect();
      listeners.clear();
    },
  };
}
