import type { BridgeServerMessage, BufferSyncRequestPayload, PasteImagePayload, TerminalBufferPayload, TerminalCell, TerminalSnapshot } from '@zterm/shared';

export interface LocalTmuxConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string;
  connectedSessionId: string;
  title: string;
  activeTarget: { sessionName: string; title?: string } | null;
}

export type LocalTmuxActivityMode = 'active' | 'idle';

export interface LocalTmuxTransportController {
  getState: () => LocalTmuxConnectionState;
  subscribe: (listener: () => void) => () => void;
  connect: (
    target: { sessionName: string; title?: string },
    handlers?: { onServerMessage?: (message: BridgeServerMessage) => void },
  ) => void;
  disconnect: () => void;
  setActivityMode: (mode: LocalTmuxActivityMode) => void;
  requestBufferSync: (_payload: BufferSyncRequestPayload) => void;
  sendInput: (data: string) => void;
  pasteImage: (_payload: PasteImagePayload) => boolean;
  resizeTerminal: (cols: number, rows: number) => void;
  dispose: () => void;
}

const EMPTY_STATE: LocalTmuxConnectionState = {
  status: 'idle',
  error: '',
  connectedSessionId: '',
  title: '',
  activeTarget: null,
};

interface LocalTmuxSnapshotMessage {
  type: 'snapshot';
  payload: TerminalSnapshot;
}

function createClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `local-${crypto.randomUUID()}`;
  }
  return `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function textLineToCells(line: string): TerminalCell[] {
  return Array.from(line).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  }));
}

function snapshotToBufferSyncPayload(snapshot: TerminalSnapshot, revision: number): TerminalBufferPayload {
  const scrollbackStartIndex = Number.isFinite(snapshot.scrollbackStartIndex)
    ? Math.max(0, Math.floor(snapshot.scrollbackStartIndex || 0))
    : 0;
  const indexedLines = [
    ...(snapshot.scrollbackLines || []).map((line, offset) => ({
      index: scrollbackStartIndex + offset,
      cells: textLineToCells(line),
    })),
    ...snapshot.viewport.map((cells, offset) => ({
      index: scrollbackStartIndex + (snapshot.scrollbackLines?.length || 0) + offset,
      cells,
    })),
  ];
  const endIndex = scrollbackStartIndex + indexedLines.length;

  return {
    revision,
    startIndex: scrollbackStartIndex,
    endIndex,
    viewportEndIndex: endIndex,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursorKeysApp: snapshot.cursorKeysApp,
    lines: indexedLines,
  };
}

export function createLocalTmuxTransportController(): LocalTmuxTransportController {
  const listeners = new Set<() => void>();
  let state: LocalTmuxConnectionState = { ...EMPTY_STATE };
  const clientId = createClientId();
  let viewport = { cols: 80, rows: 24 };
  let activityMode: LocalTmuxActivityMode = 'active';
  let unsubscribe: (() => void) | null = null;
  let revision = 0;
  let serverMessageHandler: ((message: BridgeServerMessage) => void) | undefined;

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const setState = (nextState: LocalTmuxConnectionState | ((current: LocalTmuxConnectionState) => LocalTmuxConnectionState)) => {
    state = typeof nextState === 'function' ? nextState(state) : nextState;
    emit();
  };

  const close = () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const disconnect = () => {
    close();
    void window.ztermMac.localTmux.disconnect(clientId);
    setState({ ...EMPTY_STATE });
  };

  const setActivityMode = (mode: LocalTmuxActivityMode) => {
    if (activityMode === mode) {
      return;
    }
    activityMode = mode;
    void window.ztermMac.localTmux.setActivityMode(clientId, mode);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: (target, handlers) => {
      close();
      revision = 0;
      serverMessageHandler = handlers?.onServerMessage;
      setState({
        status: 'connecting',
        error: '',
        connectedSessionId: '',
        title: target.title || target.sessionName,
        activeTarget: target,
      });

      unsubscribe = window.ztermMac.localTmux.subscribe((payload) => {
        if (payload.clientId !== clientId) {
          return;
        }

        const message = payload.message as BridgeServerMessage | LocalTmuxSnapshotMessage;
        if (message.type === 'snapshot') {
          revision += 1;
          serverMessageHandler?.({ type: 'buffer-sync', payload: snapshotToBufferSyncPayload(message.payload, revision) });
          return;
        }

        serverMessageHandler?.(message as BridgeServerMessage);

        switch (message.type) {
          case 'connected':
            setState((current) => ({
              ...current,
              status: 'connected',
              error: '',
              connectedSessionId: message.payload.sessionId,
            }));
            break;
          case 'title':
            setState((current) => ({ ...current, title: message.payload }));
            break;
          case 'closed':
            setState((current) => ({
              ...current,
              status: 'idle',
              error: message.payload.reason || '',
            }));
            break;
          case 'error':
            setState((current) => ({
              ...current,
              status: 'error',
              error: message.payload.message,
            }));
            break;
          default:
            break;
        }
      });

      void window.ztermMac.localTmux.connect({
        clientId,
        sessionName: target.sessionName,
        cols: viewport.cols,
        rows: viewport.rows,
        mode: activityMode,
      }).catch((error) => {
        setState((current) => ({
          ...current,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      void window.ztermMac.localTmux.setActivityMode(clientId, activityMode);
    },
    disconnect,
    setActivityMode,
    requestBufferSync: (payload) => {
      void window.ztermMac.localTmux.requestBufferSync(clientId, payload)
        .then((response) => {
          if (!response) {
            return;
          }
          serverMessageHandler?.({ type: 'buffer-sync', payload: response });
        })
        .catch((error) => {
          setState((current) => ({
            ...current,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    sendInput: (data) => {
      void window.ztermMac.localTmux.sendInput(clientId, data);
    },
    pasteImage: () => false,
    resizeTerminal: (cols, rows) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
        return;
      }
      viewport = { cols: Math.floor(cols), rows: Math.floor(rows) };
      void window.ztermMac.localTmux.resize(clientId, viewport.cols, viewport.rows);
    },
    dispose: () => {
      disconnect();
      listeners.clear();
    },
  };
}
