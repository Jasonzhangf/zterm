import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appendTerminalDataToSessionBuffer,
  applyScrollbackUpdateToSessionBuffer,
  applySnapshotToSessionBuffer,
  applyViewportUpdateToSessionBuffer,
  createSessionBufferState,
  openBridgeConnection,
  type BridgeServerMessage,
  type EditableHost,
  type Host,
  type HostConfigMessage,
  type SessionBufferState,
  type BridgeTarget,
} from '@zterm/shared';

const TERMINAL_CACHE_LINES = 1200;
const CLIENT_PING_INTERVAL_MS = 30000;
const CLIENT_PONG_TIMEOUT_MS = 70000;

export interface ActiveBridgeTargetState {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authToken?: string;
  autoCommand?: string;
}

export interface BridgeTerminalState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  error: string;
  connectedSessionId: string;
  title: string;
  buffer: SessionBufferState;
  activeTarget: ActiveBridgeTargetState | null;
}

const EMPTY_BUFFER = () => createSessionBufferState({ cacheLines: TERMINAL_CACHE_LINES });

function normalizeTarget(host: EditableHost | Host): ActiveBridgeTargetState {
  const sessionName = host.sessionName.trim() || host.name.trim();
  return {
    name: host.name.trim(),
    bridgeHost: host.bridgeHost.trim(),
    bridgePort: host.bridgePort,
    sessionName,
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

export function useBridgeTerminalSession() {
  const wsRef = useRef<WebSocket | null>(null);
  const connectionTokenRef = useRef(0);
  const heartbeatRef = useRef<number | null>(null);
  const lastPongAtRef = useRef(0);
  const viewportRef = useRef({ cols: 80, rows: 24 });
  const [state, setState] = useState<BridgeTerminalState>({
    status: 'idle',
    error: '',
    connectedSessionId: '',
    title: '',
    buffer: EMPTY_BUFFER(),
    activeTarget: null,
  });

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const closeSocket = useCallback((incrementToken = false) => {
    clearHeartbeat();
    if (incrementToken) {
      connectionTokenRef.current += 1;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState < WebSocket.CLOSING) {
      ws.close();
    }
  }, [clearHeartbeat]);

  const sendMessage = useCallback((message: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  const disconnect = useCallback(() => {
    closeSocket(true);
    setState({
      status: 'idle',
      error: '',
      connectedSessionId: '',
      title: '',
      buffer: EMPTY_BUFFER(),
      activeTarget: null,
    });
  }, [closeSocket]);

  const handleServerMessage = useCallback((token: number, message: BridgeServerMessage) => {
    if (token !== connectionTokenRef.current) {
      return;
    }

    switch (message.type) {
      case 'connected':
        lastPongAtRef.current = Date.now();
        setState((current) => ({
          ...current,
          status: 'connected',
          error: '',
          connectedSessionId: message.payload.sessionId,
        }));
        break;
      case 'snapshot':
        setState((current) => ({
          ...current,
          buffer: applySnapshotToSessionBuffer(current.buffer, message.payload, TERMINAL_CACHE_LINES),
        }));
        break;
      case 'viewport-update':
        setState((current) => ({
          ...current,
          buffer: applyViewportUpdateToSessionBuffer(current.buffer, message.payload, TERMINAL_CACHE_LINES),
        }));
        break;
      case 'scrollback-update':
        setState((current) => ({
          ...current,
          buffer: applyScrollbackUpdateToSessionBuffer(current.buffer, message.payload, TERMINAL_CACHE_LINES),
        }));
        break;
      case 'data':
        setState((current) => ({
          ...current,
          buffer: appendTerminalDataToSessionBuffer(current.buffer, message.payload, TERMINAL_CACHE_LINES),
        }));
        break;
      case 'title':
        setState((current) => ({ ...current, title: message.payload }));
        break;
      case 'error':
        setState((current) => ({
          ...current,
          status: 'error',
          error: message.payload.message,
        }));
        break;
      case 'closed':
        setState((current) => {
          if (current.status === 'error') {
            return current;
          }
          return {
            ...current,
            status: 'idle',
            error: message.payload.reason || current.error,
          };
        });
        break;
      case 'pong':
        lastPongAtRef.current = Date.now();
        break;
      case 'sessions':
      case 'image-pasted':
        break;
      default:
        break;
    }
  }, []);

  const connect = useCallback((host: EditableHost | Host) => {
    const normalizedTarget = normalizeTarget(host);
    if (!normalizedTarget.bridgeHost) {
      setState((current) => ({ ...current, status: 'error', error: '先填写 bridge host 再连接。' }));
      return;
    }
    if (!normalizedTarget.sessionName) {
      setState((current) => ({ ...current, status: 'error', error: '先填写 session name 或 connection name。' }));
      return;
    }

    closeSocket(true);
    const token = connectionTokenRef.current;
    const target: BridgeTarget = {
      bridgeHost: normalizedTarget.bridgeHost,
      bridgePort: normalizedTarget.bridgePort,
      authToken: normalizedTarget.authToken,
    };

    setState({
      status: 'connecting',
      error: '',
      connectedSessionId: '',
      title: normalizedTarget.sessionName,
      buffer: EMPTY_BUFFER(),
      activeTarget: normalizedTarget,
    });

    const hostConfig = buildHostConfig(host, viewportRef.current.cols, viewportRef.current.rows);
    const ws = openBridgeConnection(target, hostConfig, {
      onOpen: () => {
        if (token !== connectionTokenRef.current) {
          return;
        }
        clearHeartbeat();
        lastPongAtRef.current = Date.now();
        heartbeatRef.current = window.setInterval(() => {
          if (token !== connectionTokenRef.current) {
            clearHeartbeat();
            return;
          }
          const socket = wsRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            return;
          }
          if (Date.now() - lastPongAtRef.current > CLIENT_PONG_TIMEOUT_MS) {
            socket.close(4000, 'heartbeat timeout');
            clearHeartbeat();
            return;
          }
          socket.send(JSON.stringify({ type: 'ping' }));
        }, CLIENT_PING_INTERVAL_MS);
      },
      onConnected: ({ sessionId }) => {
        if (token !== connectionTokenRef.current) {
          return;
        }
        setState((current) => ({
          ...current,
          status: 'connected',
          error: '',
          connectedSessionId: sessionId,
        }));
      },
      onError: (message) => {
        if (token !== connectionTokenRef.current) {
          return;
        }
        setState((current) => ({ ...current, status: 'error', error: message }));
      },
      onTitle: (title) => {
        if (token !== connectionTokenRef.current) {
          return;
        }
        setState((current) => ({ ...current, title }));
      },
      onClosed: (reason) => {
        if (token !== connectionTokenRef.current) {
          return;
        }
        clearHeartbeat();
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
      onMessage: (message) => handleServerMessage(token, message),
    });

    wsRef.current = ws;
  }, [clearHeartbeat, closeSocket, handleServerMessage]);

  const sendInput = useCallback((data: string) => {
    void sendMessage({ type: 'input', payload: data });
  }, [sendMessage]);

  const resizeTerminal = useCallback((cols: number, rows: number) => {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    const nextViewport = { cols: Math.floor(cols), rows: Math.floor(rows) };
    if (viewportRef.current.cols === nextViewport.cols && viewportRef.current.rows === nextViewport.rows) {
      return;
    }
    viewportRef.current = nextViewport;
    void sendMessage({ type: 'resize', payload: nextViewport });
  }, [sendMessage]);

  useEffect(() => () => {
    closeSocket(true);
  }, [closeSocket]);

  return {
    state,
    connect,
    disconnect,
    sendInput,
    resizeTerminal,
  };
}
