import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createRtcBridgeServer, type RtcServerTransport, type SignalMessage } from './rtc-bridge';
import type { ClientSession } from './terminal-runtime';
import type { DaemonTransportConnection } from './terminal-transport-runtime';

export interface TerminalBridgeRuntimeDeps {
  requiredAuthToken: string;
  sessions: Map<string, ClientSession>;
  connections: Map<string, DaemonTransportConnection>;
  wss: WebSocketServer;
  logTimePrefix: () => string;
  extractAuthToken: (rawUrl?: string) => string;
  resolveRequestOrigin: (request: IncomingMessage) => string;
  createWebSocketSessionTransport: (ws: WebSocket) => DaemonTransportConnection['transport'];
  createRtcSessionTransport: (transport: RtcServerTransport) => DaemonTransportConnection['transport'];
  createTransportConnection: (
    transport: DaemonTransportConnection['transport'],
    requestOrigin: string,
  ) => DaemonTransportConnection;
  detachSessionTransportOnly: (session: ClientSession, reason: string, transportId?: string) => void;
  handleMessage: (connection: DaemonTransportConnection, rawData: RawData, isBinary?: boolean) => Promise<void>;
}

export interface TerminalBridgeRuntime {
  rtcBridgeServer: ReturnType<typeof createRtcBridgeServer>;
  handleWebSocketConnection: (ws: WebSocket, request: IncomingMessage) => void;
  handleServerUpgrade: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
  handleRelaySignal: (
    peerId: string,
    message: SignalMessage,
    emitSignal: (message: SignalMessage) => void,
  ) => Promise<void>;
  closeRelayPeer: (peerId: string, reason: string) => void;
}

export function createTerminalBridgeRuntime(
  deps: TerminalBridgeRuntimeDeps,
): TerminalBridgeRuntime {
  const rtcBridgeServer = createRtcBridgeServer({
    onTransportOpen: (transport) => {
      const connection = deps.createTransportConnection(
        deps.createRtcSessionTransport(transport),
        transport.requestOrigin,
      );
      console.log(`[${deps.logTimePrefix()}] rtc transport ${connection.id} created`);
      return {
        onMessage: (_transportId, data, isBinary) => {
          connection.wsAlive = true;
          const boundSession = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
          if (boundSession) {
            boundSession.wsAlive = true;
          }
          void deps.handleMessage(connection, data, isBinary);
        },
        onClose: (_transportId, reason) => {
          console.log(`[${deps.logTimePrefix()}] rtc transport ${connection.id} closed: ${reason}`);
          const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
          if (session) {
            deps.detachSessionTransportOnly(session, reason, connection.transportId);
          }
          deps.connections.delete(connection.id);
        },
        onError: (_transportId, message) => {
          console.error(`[${deps.logTimePrefix()}] rtc transport ${connection.id} error: ${message}`);
          const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
          if (session) {
            deps.detachSessionTransportOnly(session, `rtc error: ${message}`, connection.transportId);
          }
          deps.connections.delete(connection.id);
        },
      };
    },
  });

  function handleWebSocketConnection(ws: WebSocket, request: IncomingMessage) {
    const providedToken = deps.extractAuthToken(request.url);
    if (deps.requiredAuthToken && providedToken !== deps.requiredAuthToken) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Unauthorized bridge token', code: 'unauthorized' } }));
      ws.close(4001, 'unauthorized');
      console.warn(`[${deps.logTimePrefix()}] unauthorized websocket from ${request.socket.remoteAddress || 'unknown'}`);
      return;
    }

    const connection = deps.createTransportConnection(
      deps.createWebSocketSessionTransport(ws),
      deps.resolveRequestOrigin(request),
    );
    console.log(`[${deps.logTimePrefix()}] websocket transport ${connection.id} created`);

    ws.on('pong', () => {
      connection.wsAlive = true;
      const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
      if (session) {
        session.wsAlive = true;
      }
    });

    ws.on('message', (rawData, isBinary) => {
      connection.wsAlive = true;
      const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
      if (session) {
        session.wsAlive = true;
      }
      void deps.handleMessage(connection, rawData, isBinary);
    });

    ws.on('close', () => {
      console.log(`[${deps.logTimePrefix()}] websocket transport ${connection.id} closed`);
      const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
      if (session) {
        deps.detachSessionTransportOnly(session, 'websocket closed', connection.transportId);
      }
      deps.connections.delete(connection.id);
    });

    ws.on('error', (error) => {
      console.error(`[${deps.logTimePrefix()}] websocket transport ${connection.id} error: ${error.message}`);
      const session = connection.boundSessionId ? deps.sessions.get(connection.boundSessionId) || null : null;
      if (session) {
        deps.detachSessionTransportOnly(session, `websocket error: ${error.message}`, connection.transportId);
      }
      deps.connections.delete(connection.id);
    });
  }

  function handleServerUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    const origin = deps.resolveRequestOrigin(request);
    const pathname = new URL(request.url || '/', origin).pathname;

    if (pathname === '/signal') {
      deps.wss.handleUpgrade(request, socket, head, (ws) => {
        const providedToken = deps.extractAuthToken(request.url);
        if (deps.requiredAuthToken && providedToken !== deps.requiredAuthToken) {
          ws.send(JSON.stringify({ type: 'rtc-error', payload: { message: 'Unauthorized bridge token' } }));
          ws.close(4001, 'unauthorized');
          return;
        }
        rtcBridgeServer.handleSignalConnection(ws, origin);
      });
      return;
    }

    if (pathname !== '/' && pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    deps.wss.handleUpgrade(request, socket, head, (ws) => {
      deps.wss.emit('connection', ws, request);
    });
  }

  async function handleRelaySignal(
    peerId: string,
    message: SignalMessage,
    emitSignal: (message: SignalMessage) => void,
  ) {
    await rtcBridgeServer.handleRelaySignal(peerId, 'relay-host', message, emitSignal);
  }

  function closeRelayPeer(peerId: string, reason: string) {
    rtcBridgeServer.closeRelayPeer(peerId, reason);
  }

  return {
    rtcBridgeServer,
    handleWebSocketConnection,
    handleServerUpgrade,
    handleRelaySignal,
    closeRelayPeer,
  };
}
