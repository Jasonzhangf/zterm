import {
  buildEmptyScheduleState,
  formatBridgeEndpoint,
  getResolvedSessionName,
  openBridgeConnection,
  type BridgeServerMessage,
  type BufferSyncRequestPayload,
  type PasteImagePayload,
  type ScheduleJobDraft,
  type SessionScheduleState,
  type EditableHost,
  type Host,
  type HostConfigMessage,
  type BridgeTarget,
} from '@zterm/shared';

const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;
const DEFAULT_ACTIVE_CAPTURE_INTERVAL_MS = 33;
const IDLE_CAPTURE_INTERVAL_MS = 1000;

export interface ActiveBridgeTargetState {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
  autoCommand?: string;
}

export interface TerminalConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string;
  connectedSessionId: string;
  title: string;
  activeTarget: ActiveBridgeTargetState | null;
}

export type BridgeStreamMode = 'active' | 'idle';

export interface BridgeTransportController {
  getState: () => TerminalConnectionState;
  getScheduleState: () => SessionScheduleState;
  subscribe: (listener: () => void) => () => void;
  connect: (host: EditableHost | Host, handlers?: { onServerMessage?: (message: BridgeServerMessage) => void }) => void;
  disconnect: () => void;
  setActivityMode: (mode: BridgeStreamMode) => void;
  requestBufferSync: (payload: BufferSyncRequestPayload) => void;
  requestScheduleList: (sessionName: string) => void;
  upsertScheduleJob: (job: ScheduleJobDraft) => void;
  deleteScheduleJob: (jobId: string) => void;
  toggleScheduleJob: (jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (jobId: string) => void;
  sendInput: (data: string) => void;
  pasteImage: (payload: PasteImagePayload) => boolean;
  resizeTerminal: (cols: number, rows: number) => void;
  dispose: () => void;
}

const EMPTY_CONNECTION_STATE: TerminalConnectionState = {
  status: 'idle',
  error: '',
  connectedSessionId: '',
  title: '',
  activeTarget: null,
};

function normalizeTarget(host: EditableHost | Host): ActiveBridgeTargetState {
  return {
    name: host.name.trim(),
    bridgeHost: host.bridgeHost.trim(),
    bridgePort: host.bridgePort,
    sessionName: getResolvedSessionName(host),
    authToken: host.authToken?.trim() || undefined,
    autoCommand: host.autoCommand?.trim() || undefined,
  };
}

function buildHostConfig(host: EditableHost | Host, cols = 80, rows = 24): HostConfigMessage {
  const target = normalizeTarget(host);
  return {
    name: target.name,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    sessionName: target.sessionName,
    cols,
    rows,
    authToken: target.authToken,
    autoCommand: target.autoCommand,
    authType: host.authType,
    password: host.authType === 'password' ? host.password || undefined : undefined,
    privateKey: host.authType === 'key' ? host.privateKey || undefined : undefined,
  };
}

export function buildBridgeTargetKey(host: Pick<ActiveBridgeTargetState, 'bridgeHost' | 'bridgePort' | 'sessionName' | 'name'>) {
  return [
    formatBridgeEndpoint({ bridgeHost: host.bridgeHost, bridgePort: host.bridgePort }).toLowerCase(),
    (host.sessionName?.trim() || host.name?.trim() || '').toLowerCase(),
  ].join('::');
}

export function createIdleConnectionState(): TerminalConnectionState {
  return { ...EMPTY_CONNECTION_STATE };
}

export function createBridgeTransportController(): BridgeTransportController {
  const listeners = new Set<() => void>();
  let state: TerminalConnectionState = createIdleConnectionState();
  let scheduleState: SessionScheduleState = buildEmptyScheduleState('');
  let ws: WebSocket | null = null;
  let connectionToken = 0;
  let heartbeatId: number | null = null;
  let lastPongAt = 0;
  let viewport = { cols: 80, rows: 24 };
  let activityMode: BridgeStreamMode = 'active';
  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const setState = (nextState: TerminalConnectionState | ((current: TerminalConnectionState) => TerminalConnectionState)) => {
    state = typeof nextState === 'function' ? nextState(state) : nextState;
    emit();
  };

  const setScheduleState = (
    nextState:
      | SessionScheduleState
      | ((current: SessionScheduleState) => SessionScheduleState),
  ) => {
    scheduleState = typeof nextState === 'function' ? nextState(scheduleState) : nextState;
    emit();
  };

  const clearHeartbeat = () => {
    if (heartbeatId) {
      window.clearInterval(heartbeatId);
      heartbeatId = null;
    }
  };

  const closeSocket = (incrementToken = false) => {
    clearHeartbeat();
    if (incrementToken) {
      connectionToken += 1;
    }
    const socket = ws;
    ws = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  };

  const sendMessage = (message: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  };

  const disconnect = () => {
    closeSocket(true);
    setScheduleState(buildEmptyScheduleState(''));
    setState(createIdleConnectionState());
  };

  const setActivityMode = (mode: BridgeStreamMode) => {
    if (activityMode === mode) {
      return;
    }
    activityMode = mode;
    void sendMessage({
      type: 'stream-mode',
      payload: {
        mode,
        minCaptureIntervalMs: mode === 'active' ? DEFAULT_ACTIVE_CAPTURE_INTERVAL_MS : IDLE_CAPTURE_INTERVAL_MS,
      },
    });
  };

  return {
    getState: () => state,
    getScheduleState: () => scheduleState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: (host, handlers) => {
      const normalizedTarget = normalizeTarget(host);
      if (!normalizedTarget.bridgeHost) {
        setState((current) => ({ ...current, status: 'error', error: '先填写 bridge host 再连接。' }));
        return;
      }
      if (!normalizedTarget.sessionName) {
        setState((current) => ({ ...current, status: 'error', error: '先选择一个 session 再连接。' }));
        return;
      }

      closeSocket(true);
      const token = connectionToken;
      const bridgeTarget: BridgeTarget = {
        bridgeHost: normalizedTarget.bridgeHost,
        bridgePort: normalizedTarget.bridgePort,
        authToken: normalizedTarget.authToken,
      };
      const hostConfig = buildHostConfig(host, viewport.cols, viewport.rows);

      setState({
        status: 'connecting',
        error: '',
        connectedSessionId: '',
        title: normalizedTarget.sessionName,
        activeTarget: normalizedTarget,
      });
      setScheduleState({
        sessionName: normalizedTarget.sessionName,
        jobs: [],
        loading: true,
      });

      ws = openBridgeConnection(bridgeTarget, hostConfig, {
        onOpen: () => {
          if (token !== connectionToken) {
            return;
          }
          void sendMessage({
            type: 'stream-mode',
            payload: {
              mode: activityMode,
              minCaptureIntervalMs: activityMode === 'active' ? DEFAULT_ACTIVE_CAPTURE_INTERVAL_MS : IDLE_CAPTURE_INTERVAL_MS,
            },
          });
          clearHeartbeat();
          lastPongAt = Date.now();
          heartbeatId = window.setInterval(() => {
            if (token !== connectionToken) {
              clearHeartbeat();
              return;
            }
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              return;
            }
            if (Date.now() - lastPongAt > CLIENT_PONG_TIMEOUT_MS) {
              ws.close(4000, 'heartbeat timeout');
              clearHeartbeat();
              return;
            }
            ws.send(JSON.stringify({ type: 'ping' }));
          }, CLIENT_PING_INTERVAL_MS);
        },
        onConnected: ({ sessionId }) => {
          if (token !== connectionToken) {
            return;
          }
          setState((current) => ({
            ...current,
            status: 'connected',
            error: '',
            connectedSessionId: sessionId,
          }));
          sendMessage({ type: 'schedule-list', payload: { sessionName: normalizedTarget.sessionName } });
        },
        onError: (message) => {
          if (token !== connectionToken) {
            return;
          }
          setScheduleState((current) => ({
            ...current,
            loading: false,
            error: message,
          }));
          setState((current) => ({ ...current, status: 'error', error: message }));
        },
        onTitle: (title) => {
          if (token !== connectionToken) {
            return;
          }
          setState((current) => ({ ...current, title }));
        },
        onClosed: (reason) => {
          if (token !== connectionToken) {
            return;
          }
          clearHeartbeat();
          setScheduleState((current) => ({
            ...current,
            loading: false,
            error: reason || current.error,
          }));
          setState((current) => {
            if (current.status === 'error') {
              return current;
            }
            return {
              ...current,
              status: current.connectedSessionId ? 'idle' : 'error',
              error: reason || current.error,
            };
          });
        },
        onMessage: (message) => {
          if (token !== connectionToken) {
            return;
          }
          if (message.type === 'pong') {
            lastPongAt = Date.now();
          } else if (message.type === 'schedule-state') {
            setScheduleState({
              sessionName: message.payload.sessionName,
              jobs: message.payload.jobs,
              loading: false,
              lastEvent: scheduleState.lastEvent,
              error: '',
            });
          } else if (message.type === 'schedule-event') {
            setScheduleState((current) => ({
              ...current,
              sessionName: message.payload.sessionName,
              lastEvent: message.payload,
            }));
          }
          handlers?.onServerMessage?.(message);
        },
      });
    },
    disconnect,
    setActivityMode,
    requestBufferSync: (payload) => {
      void sendMessage({ type: 'buffer-sync-request', payload });
    },
    requestScheduleList: (sessionName) => {
      setScheduleState((current) => ({
        ...current,
        sessionName,
        loading: true,
        error: '',
      }));
      void sendMessage({ type: 'schedule-list', payload: { sessionName } });
    },
    upsertScheduleJob: (job) => {
      setScheduleState((current) => ({ ...current, loading: true, error: '' }));
      void sendMessage({ type: 'schedule-upsert', payload: { job } });
    },
    deleteScheduleJob: (jobId) => {
      setScheduleState((current) => ({ ...current, loading: true, error: '' }));
      void sendMessage({ type: 'schedule-delete', payload: { jobId } });
    },
    toggleScheduleJob: (jobId, enabled) => {
      setScheduleState((current) => ({ ...current, loading: true, error: '' }));
      void sendMessage({ type: 'schedule-toggle', payload: { jobId, enabled } });
    },
    runScheduleJobNow: (jobId) => {
      setScheduleState((current) => ({ ...current, loading: true, error: '' }));
      void sendMessage({ type: 'schedule-run-now', payload: { jobId } });
    },
    sendInput: (data) => {
      void sendMessage({ type: 'input', payload: data });
    },
    pasteImage: (payload) => sendMessage({ type: 'paste-image', payload }),
    resizeTerminal: (cols, rows) => {
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
        return;
      }
      const nextViewport = { cols: Math.floor(cols), rows: Math.floor(rows) };
      if (viewport.cols === nextViewport.cols && viewport.rows === nextViewport.rows) {
        return;
      }
      viewport = nextViewport;
      void sendMessage({ type: 'resize', payload: nextViewport });
    },
    dispose: () => {
      closeSocket(true);
      listeners.clear();
    },
  };
}
