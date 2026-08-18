import type { BridgeTransportSocket } from '../lib/traversal/types';

export type SessionTargetNetworkProbeResult =
  | 'started'
  | 'deduped'
  | 'still-connecting'
  | 'terminal-socket'
  | 'send-failed'
  | 'generation-changed';

export type SessionTargetNetworkSignal =
  | {
    source: 'capacitor';
    connected: boolean;
    connectionType: string;
    /** Client network generation; present only when the platform signal is stamped by the network identity owner. */
    networkGeneration?: number;
    /** True when this very signal carries a network fingerprint change. */
    fingerprintChanged?: boolean;
  }
  | {
    source: 'window-online';
    connected: true;
    connectionType: 'unknown';
    networkGeneration?: number;
    fingerprintChanged?: boolean;
  }
  | {
    source: 'foreground-resume';
    networkGeneration?: number;
    fingerprintChanged?: boolean;
  };

export interface TargetNetworkProbeError01GenerationTimeout {
  type: 'TargetNetworkProbeError01GenerationTimeout';
  targetKey: string;
  socket: BridgeTransportSocket;
}

export interface TargetNetworkProbeError02SendFailure {
  type: 'TargetNetworkProbeError02SendFailure';
  targetKey: string;
  socket: BridgeTransportSocket;
}

export interface TargetNetworkProbeError03TerminalSocketState {
  type: 'TargetNetworkProbeError03TerminalSocketState';
  targetKey: string;
  socket: BridgeTransportSocket;
  readyState: number;
}

export interface TargetNetworkProbeError04NativeSnapshot {
  type: 'TargetNetworkProbeError04NativeSnapshot';
  message: string;
}

export type SessionTargetNetworkProbeFailure =
  | TargetNetworkProbeError01GenerationTimeout
  | TargetNetworkProbeError02SendFailure
  | TargetNetworkProbeError03TerminalSocketState
  | TargetNetworkProbeError04NativeSnapshot;

interface PendingSessionTargetNetworkProbe {
  socket: BridgeTransportSocket;
  timeout: ReturnType<typeof setTimeout>;
  onFailure: (failure: SessionTargetNetworkProbeFailure) => void;
}

export function createSessionTargetNetworkProbeRuntime(options: {
  probeTimeoutMs: number;
  now: () => number;
}) {
  if (!Number.isSafeInteger(options.probeTimeoutMs) || options.probeTimeoutMs <= 0) {
    throw new Error('target network probe timeout must be a positive safe integer');
  }
  if (typeof options.now !== 'function') {
    throw new Error('target network probe clock is required');
  }
  const pendingByTarget = new Map<string, PendingSessionTargetNetworkProbe>();
  const now = options.now;
  const probeTimeoutMs = options.probeTimeoutMs;

  const clearPending = (targetKey: string, expectedSocket?: BridgeTransportSocket) => {
    const pending = pendingByTarget.get(targetKey);
    if (!pending || (expectedSocket && pending.socket !== expectedSocket)) {
      return false;
    }
    clearTimeout(pending.timeout);
    pendingByTarget.delete(targetKey);
    return true;
  };

  const probe = (request: {
    targetKey: string;
    socket: BridgeTransportSocket;
    sendProbe: (socket: BridgeTransportSocket, sentAt: number) => void;
    onFailure: (failure: SessionTargetNetworkProbeFailure) => void;
  }): SessionTargetNetworkProbeResult => {
    const targetKey = request.targetKey.trim();
    if (request.socket.readyState === WebSocket.CONNECTING) {
      return 'still-connecting';
    }
    if (request.socket.readyState === WebSocket.CLOSING || request.socket.readyState === WebSocket.CLOSED) {
      request.onFailure({
        type: 'TargetNetworkProbeError03TerminalSocketState',
        targetKey,
        socket: request.socket,
        readyState: request.socket.readyState,
      });
      return 'terminal-socket';
    }
    if (request.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`unsupported target transport readyState: ${request.socket.readyState}`);
    }

    const current = pendingByTarget.get(targetKey);
    if (current?.socket === request.socket) {
      return 'deduped';
    }
    if (current) {
      clearPending(targetKey, current.socket);
    }

    const pending: PendingSessionTargetNetworkProbe = {
      socket: request.socket,
      onFailure: request.onFailure,
      timeout: setTimeout(() => {
        const active = pendingByTarget.get(targetKey);
        if (active !== pending) {
          return;
        }
        pendingByTarget.delete(targetKey);
        active.onFailure({
          type: 'TargetNetworkProbeError01GenerationTimeout',
          targetKey,
          socket: active.socket,
        });
      }, probeTimeoutMs),
    };
    pendingByTarget.set(targetKey, pending);

    try {
      request.sendProbe(request.socket, now());
    } catch {
      clearPending(targetKey, request.socket);
      request.onFailure({
        type: 'TargetNetworkProbeError02SendFailure',
        targetKey,
        socket: request.socket,
      });
      return 'send-failed';
    }
    return 'started';
  };

  return {
    probe,
    recordTargetActivity: (targetKey: string, socket: BridgeTransportSocket) => (
      clearPending(targetKey.trim(), socket)
    ),
    dispose: () => {
      for (const pending of pendingByTarget.values()) {
        clearTimeout(pending.timeout);
      }
      pendingByTarget.clear();
    },
  };
}

export type SessionTargetNetworkProbeRuntime = ReturnType<typeof createSessionTargetNetworkProbeRuntime>;
