import { buildBridgeUrlFromTarget } from './bridge-url';
import type { HostConfigMessage, BridgeServerMessage } from './protocol';
import type { BridgeTarget } from './tmux-sessions';

export interface BridgeConnectionHandlers {
  onOpen?: () => void;
  onConnected?: (payload: { sessionId: string }) => void;
  onError?: (message: string, code?: string) => void;
  onTitle?: (title: string) => void;
  onClosed?: (reason: string) => void;
  onMessage?: (message: BridgeServerMessage) => void;
}

export interface BridgeConnectionOptions {
  initialStreamMode?: 'active' | 'idle';
}

export function openBridgeConnection(
  target: BridgeTarget,
  hostConfig: HostConfigMessage,
  handlers: BridgeConnectionHandlers = {},
  options: BridgeConnectionOptions = {},
  overrideUrl?: string,
) {
  const ws = new WebSocket(buildBridgeUrlFromTarget(target, overrideUrl));
  const initialStreamMode = options.initialStreamMode || 'active';

  ws.onopen = () => {
    handlers.onOpen?.();
    ws.send(JSON.stringify({ type: 'connect', payload: hostConfig }));
    ws.send(JSON.stringify({ type: 'stream-mode', payload: { mode: initialStreamMode } }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as BridgeServerMessage;
      handlers.onMessage?.(message);
      switch (message.type) {
        case 'connected':
          handlers.onConnected?.(message.payload);
          break;
        case 'error':
          handlers.onError?.(message.payload.message, message.payload.code);
          break;
        case 'title':
          handlers.onTitle?.(message.payload);
          break;
        case 'closed':
          handlers.onClosed?.(message.payload.reason);
          break;
        default:
          break;
      }
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  ws.onerror = () => {
    handlers.onError?.('WebSocket error while connecting');
  };

  ws.onclose = (event) => {
    handlers.onClosed?.(event.reason || 'Bridge connection closed');
  };

  return ws;
}
