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
const REMOTE_SCREENSHOT_TIMEOUT_MS = 30000;

interface PendingRemoteScreenshot {
  fileName: string;
  chunks: Map<number, string>;
  totalBytes: number;
  phase: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
  onStatus: (status: { phase: string; fileName?: string; totalBytes?: number; errorMessage?: string }) => void;
  onChunk: (chunk: { requestId: string; fileName?: string; chunkIndex: number; dataBase64: string; totalChunks: number }) => void;
  onComplete: (result: { requestId: string; fileName: string; totalBytes: number; dataBase64Parts: string[] }) => void;
  onError: (error: Error) => void;
}

export interface RemoteScreenshotRequestOptions {
  requestId: string;
  onStatus: (status: { phase: string; fileName?: string; totalBytes?: number; errorMessage?: string }) => void;
  onChunk: (chunk: { requestId: string; fileName?: string; chunkIndex: number; dataBase64: string; totalChunks: number }) => void;
  onComplete: (result: { requestId: string; fileName: string; totalBytes: number; dataBase64Parts: string[] }) => void;
  onError: (error: Error) => void;
}
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
  requestBufferHead: () => void;
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
  requestRemoteScreenshot: (opts: RemoteScreenshotRequestOptions) => boolean;
  sendRawJson: (message: unknown) => boolean;
  onFileTransferMessage: (handler: (msg: unknown) => void) => () => void;
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
    clientSessionId: buildBridgeTargetKey(target),
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
  const pendingRemoteScreenshots = new Map<string, PendingRemoteScreenshot>();
  const fileTransferHandlers = new Set<(message: BridgeServerMessage) => void>();
  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const clearRemoteScreenshotTimeout = (pending: PendingRemoteScreenshot) => {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }
  };

  const armRemoteScreenshotTimeout = (requestId: string) => {
    const pending = pendingRemoteScreenshots.get(requestId);
    if (!pending) return;
    clearRemoteScreenshotTimeout(pending);
    pending.timeoutId = setTimeout(() => {
      pendingRemoteScreenshots.delete(requestId);
      pending.onError(new Error('Remote screenshot timed out'));
    }, REMOTE_SCREENSHOT_TIMEOUT_MS);
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
    activityMode = mode;
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
          } else if (message.type === 'remote-screenshot-status') {
            const payload = message.payload;
            const pending = pendingRemoteScreenshots.get(payload.requestId);
            if (pending) {
              pending.phase = payload.phase;
              pending.fileName = payload.fileName || pending.fileName;
              pending.totalBytes = Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0));
              armRemoteScreenshotTimeout(payload.requestId);
              pending.onStatus({
                phase: payload.phase,
                fileName: payload.fileName || pending.fileName || undefined,
                totalBytes: Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0)),
                errorMessage: payload.errorMessage,
              });
              if (payload.phase === 'failed') {
                pendingRemoteScreenshots.delete(payload.requestId);
                clearRemoteScreenshotTimeout(pending);
                pending.onError(new Error(payload.errorMessage || 'Remote screenshot failed'));
              }
            }
          } else if (message.type === 'file-download-chunk') {
            const payload = message.payload;
            const pending = pendingRemoteScreenshots.get(payload.requestId);
            if (pending) {
              pending.phase = 'transferring';
              pending.fileName = payload.fileName || pending.fileName;
              pending.chunks.set(payload.chunkIndex, payload.dataBase64);
              armRemoteScreenshotTimeout(payload.requestId);
              pending.onChunk({
                requestId: payload.requestId,
                fileName: payload.fileName || pending.fileName || undefined,
                chunkIndex: payload.chunkIndex,
                dataBase64: payload.dataBase64,
                totalChunks: payload.totalChunks,
              });
            }
          } else if (message.type === 'file-download-complete') {
            const payload = message.payload;
            const pending = pendingRemoteScreenshots.get(payload.requestId);
            if (pending) {
              pendingRemoteScreenshots.delete(payload.requestId);
              clearRemoteScreenshotTimeout(pending);
              const ordered: string[] = [];
              for (let index = 0; index < pending.chunks.size; index += 1) {
                const chunk = pending.chunks.get(index);
                if (chunk) ordered.push(chunk);
              }
              pending.onComplete({
                requestId: payload.requestId,
                fileName: payload.fileName || pending.fileName || `remote-screenshot-${Date.now()}.png`,
                totalBytes: Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0)),
                dataBase64Parts: ordered,
              });
            }
          } else if (message.type === 'file-download-error') {
            const payload = message.payload;
            const pending = pendingRemoteScreenshots.get(payload.requestId);
            if (pending) {
              pendingRemoteScreenshots.delete(payload.requestId);
              clearRemoteScreenshotTimeout(pending);
              pending.onError(new Error(payload.error || 'File download failed'));
            }
          }
          handlers?.onServerMessage?.(message);
          for (const ftHandler of fileTransferHandlers) {
            ftHandler(message);
          }
        },
      });
    },
    disconnect,
    setActivityMode,
    requestBufferHead: () => {
      void sendMessage({ type: 'buffer-head-request' });
    },
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
    requestRemoteScreenshot: (opts) => {
      const { requestId, onStatus, onChunk, onComplete, onError } = opts;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        onError(new Error('Not connected'));
        return false;
      }
      pendingRemoteScreenshots.set(requestId, {
        fileName: `remote-screenshot-${Date.now()}.png`,
        chunks: new Map(),
        totalBytes: 0,
        phase: 'request-sent',
        timeoutId: null,
        onStatus,
        onChunk,
        onComplete,
        onError,
      });
      armRemoteScreenshotTimeout(requestId);
      onStatus({ phase: 'request-sent' });
      return sendMessage({ type: 'remote-screenshot-request', payload: { requestId } });
    },
    sendRawJson: (message: unknown) => sendMessage(message),
    onFileTransferMessage: (handler: (msg: unknown) => void) => {
      const wrappedHandler = (message: BridgeServerMessage) => {
        const t = (message as { type: string }).type;
        if (
          t === 'file-list-response' ||
          t === 'file-list-error' ||
          t === 'file-download-chunk' ||
          t === 'file-download-complete' ||
          t === 'file-download-error' ||
          t === 'file-upload-progress' ||
          t === 'file-upload-complete' ||
          t === 'file-upload-error'
        ) {
          handler(message);
        }
      };
      // Store for later use via onServerMessage
      fileTransferHandlers.add(wrappedHandler);
      return () => { fileTransferHandlers.delete(wrappedHandler); };
    },
    dispose: () => {
      pendingRemoteScreenshots.forEach((pending) => {
        clearRemoteScreenshotTimeout(pending);
        pending.onError(new Error('Transport disposed'));
      });
      pendingRemoteScreenshots.clear();
      closeSocket(true);
      listeners.clear();
    },
  };
}
