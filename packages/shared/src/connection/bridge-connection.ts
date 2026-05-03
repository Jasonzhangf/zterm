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
}

/**
 * Open a bridge connection to the daemon.
 *
 * Uses two-phase handshake (matching current daemon wire protocol):
 *   1. On WebSocket open → send `session-open` with hostConfig
 *   2. On receiving `session-ticket` → send `connect` with sessionTransportToken
 *   3. On receiving `connected` → connection is fully established
 *
 * Wire-compat note:
 * - `clientSessionId` remains client-owned identity
 * - `sessionTransportToken` / `session-ticket` remain attach-only wire fields
 * - daemon must not promote either into daemon-side client/session business truth
 */
export function openBridgeConnection(
  target: BridgeTarget,
  hostConfig: HostConfigMessage,
  handlers: BridgeConnectionHandlers = {},
  options: BridgeConnectionOptions = {},
  overrideUrl?: string,
) {
  const ws = new WebSocket(buildBridgeUrlFromTarget(target, overrideUrl));
  void options;

  ws.onopen = () => {
    handlers.onOpen?.();
    // Phase 1: request a session transport ticket
    ws.send(JSON.stringify({ type: 'session-open', payload: hostConfig }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as BridgeServerMessage;
      handlers.onMessage?.(message);
      switch (message.type) {
        case 'session-ticket': {
          // Phase 2: got the ticket, now send connect with the token
          const ticket = (message as { type: 'session-ticket'; payload: { clientSessionId: string; sessionTransportToken: string; sessionName: string } }).payload;
          const connectPayload: HostConfigMessage = {
            ...hostConfig,
            sessionTransportToken: ticket.sessionTransportToken,
          };
          ws.send(JSON.stringify({ type: 'connect', payload: connectPayload }));
          break;
        }
        case 'session-open-failed': {
          const payload = (message as { type: 'session-open-failed'; payload: { clientSessionId: string; message: string; code?: string } }).payload;
          handlers.onError?.(payload.message, payload.code);
          break;
        }
        case 'connected':
          handlers.onConnected?.((message as { type: 'connected'; payload: { sessionId: string } }).payload);
          break;
        case 'error':
          handlers.onError?.((message as { type: 'error'; payload: { message: string; code?: string } }).payload.message, (message as { type: 'error'; payload: { message: string; code?: string } }).payload.code);
          break;
        case 'title':
          handlers.onTitle?.((message as { type: 'title'; payload: string }).payload);
          break;
        case 'closed':
          handlers.onClosed?.((message as { type: 'closed'; payload: { reason: string } }).payload.reason);
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
