import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../lib/types';
import type {
  ClientSession,
  ClientSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { RtcServerTransport } from './rtc-bridge';

export interface DaemonTransportConnection extends TerminalTransportConnection {
  id: string;
  wsAlive: boolean;
}

export interface TerminalTransportRuntimeDeps {
  sessions: Map<string, ClientSession>;
  connections: Map<string, DaemonTransportConnection>;
  daemonRuntimeDebug: (scope: string, payload?: unknown) => void;
  summarizePayload: (message: ServerMessage) => Record<string, unknown> | null;
}

export interface TerminalTransportRuntime {
  createWebSocketSessionTransport: (ws: WebSocket) => ClientSessionTransport;
  createRtcSessionTransport: (transport: RtcServerTransport) => ClientSessionTransport;
  sendTransportMessage: (transport: ClientSessionTransport | null | undefined, message: ServerMessage) => void;
  sendMessage: (session: ClientSession, message: ServerMessage) => void;
  broadcastRuntimeDebugControl: (enabled: boolean, reason: string, sessionId?: string) => void;
  createTransportConnection: (
    transport: ClientSessionTransport,
    requestOrigin: string,
  ) => DaemonTransportConnection;
}

export function createTerminalTransportRuntime(
  deps: TerminalTransportRuntimeDeps,
): TerminalTransportRuntime {
  function createWebSocketSessionTransport(ws: WebSocket): ClientSessionTransport {
    return {
      kind: 'ws',
      get readyState() {
        return ws.readyState;
      },
      sendText(text: string) {
        ws.send(text);
      },
      close(reason?: string) {
        ws.close(1000, reason);
      },
      ping() {
        ws.ping();
      },
    };
  }

  function createRtcSessionTransport(transport: RtcServerTransport): ClientSessionTransport {
    return {
      kind: 'rtc',
      get readyState() {
        return transport.readyState;
      },
      sendText(text: string) {
        transport.sendText(text);
      },
      close(reason?: string) {
        transport.close(reason);
      },
    };
  }

  function sendTransportMessage(transport: ClientSessionTransport | null | undefined, message: ServerMessage) {
    if (!transport || transport.readyState !== WebSocket.OPEN) {
      return;
    }
    transport.sendText(JSON.stringify(message));
  }

  function sendMessage(session: ClientSession, message: ServerMessage) {
    if (session.transport && session.transport.readyState === WebSocket.OPEN) {
      if (message.type === 'buffer-sync' || message.type === 'connected') {
        deps.daemonRuntimeDebug('send', {
          sessionId: session.id,
          sessionName: session.sessionName,
          type: message.type,
          payload: deps.summarizePayload(message),
        });
      }
      sendTransportMessage(session.transport, message);
    }
  }

  function broadcastRuntimeDebugControl(enabled: boolean, reason: string, sessionId?: string) {
    for (const session of deps.sessions.values()) {
      if (sessionId && session.id !== sessionId) {
        continue;
      }
      sendMessage(session, {
        type: 'debug-control',
        payload: {
          enabled,
          reason,
        },
      });
    }
  }

  function createTransportConnection(transport: ClientSessionTransport, requestOrigin: string): DaemonTransportConnection {
    const connection: DaemonTransportConnection = {
      id: uuidv4(),
      transportId: uuidv4(),
      transport,
      closeTransport: (reason: string) => {
        if (transport.readyState < WebSocket.CLOSING) {
          transport.close(reason);
        }
      },
      requestOrigin,
      wsAlive: true,
      role: 'pending',
      boundSessionId: null,
    };
    deps.connections.set(connection.id, connection);
    return connection;
  }

  return {
    createWebSocketSessionTransport,
    createRtcSessionTransport,
    sendTransportMessage,
    sendMessage,
    broadcastRuntimeDebugControl,
    createTransportConnection,
  };
}
