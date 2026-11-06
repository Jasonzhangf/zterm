import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import type {
  BridgeServerMessage as ServerMessage,
  TerminalTransportServerFrame,
  TerminalTransportLane,
} from '@zterm/shared/protocol';
import { isTerminalMuxBulkMessageType } from '@zterm/shared/protocol';
import type { TerminalPerformanceTraceRecord } from '@zterm/shared/terminal/performance-trace';
import type {
  TerminalTransportSubscriber,
  TerminalSession,
  TerminalSessionTransport,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import {
  TRANSPORT_BACKPRESSURE_BUFFERED_BYTES,
  TRANSPORT_BACKPRESSURE_LOW_WATER_BYTES,
} from './terminal-runtime-types';
import type { RtcServerTransport } from './rtc-bridge';

export interface DaemonTransportConnection extends TerminalTransportConnection {
  deviceId?: string;
  id: string;
  wsAlive: boolean;
  lastInboundAt: number;
}

export interface TerminalTransportBackpressureSnapshot {
  kind: TerminalSessionTransport['kind'];
  ready: boolean;
  bufferedBytes: number;
  backpressure: boolean;
  lowWaterDrained: boolean;
  flowUnknown: boolean;
  backpressureCount: number;
  lastSendBytes: number;
  totalSendBytes: number;
  lastSendAt: number;
  lastSendError: string | null;
}

export interface TerminalTransportRuntimeDeps {
  sessions: Map<string, TerminalTransportSubscriber>;
  connections: Map<string, DaemonTransportConnection>;
  daemonRuntimeDebug: (scope: string, payload?: unknown) => void;
  summarizePayload: (message: ServerMessage) => Record<string, unknown> | null;
  recordPerformanceTrace?: (record: TerminalPerformanceTraceRecord) => void;
}

export interface TerminalTransportRuntime {
  createWebSocketSessionTransport: (ws: WebSocket) => TerminalSessionTransport;
  createRtcSessionTransport: (transport: RtcServerTransport) => TerminalSessionTransport;
  sendTransportMessage: (
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
    lane?: TerminalTransportLane,
  ) => void;
  sendText: (
    transport: TerminalSessionTransport | null | undefined,
    text: string,
    lane?: TerminalTransportLane,
  ) => void;
  sendTextLane: (
    transport: TerminalSessionTransport | null | undefined,
    text: string,
    lane: TerminalTransportLane,
  ) => void;
  sendMessage: (session: TerminalTransportSubscriber, message: ServerMessage) => void;
  broadcastRuntimeDebugControl: (enabled: boolean, reason: string, sessionId?: string) => void;
  createTransportConnection: (
    transport: TerminalSessionTransport,
    requestOrigin: string,
  ) => DaemonTransportConnection;
}

// Android sends the physical target heartbeat every 30s and declares failure
// after 3 misses; the daemon must not detach the subscriber before that client
// heartbeat contract can run.
export const TERMINAL_TRANSPORT_STALE_INBOUND_MS = 190_000;

export function estimateTransportMessageBytes(text: string) {
  return Buffer.byteLength(text, 'utf8');
}

function resolveServerFrameLane(message: TerminalTransportServerFrame): TerminalTransportLane {
  if (message.type === 'mux-channel-message') {
    return isTerminalMuxBulkMessageType(message.payload.message.type) ? 'bulk' : 'control';
  }
  if (message.type === 'mux-target-message') {
    return isTerminalMuxBulkMessageType(message.payload.message.type) ? 'bulk' : 'control';
  }
  return isTerminalMuxBulkMessageType(message.type) ? 'bulk' : 'control';
}

export function readTerminalTransportBackpressureSnapshot(
  transport: TerminalSessionTransport | null | undefined,
  lane: TerminalTransportLane = 'control',
): TerminalTransportBackpressureSnapshot | null {
  if (!transport) {
    return null;
  }
  const bufferedBytes = Math.max(
    0,
    Math.floor(
      transport.bufferedAmountForLane
        ? transport.bufferedAmountForLane(lane)
        : transport.bufferedAmount || 0,
    ),
  );
  const flowUnknown = !!transport.flowUnknown;
  const backpressure = bufferedBytes >= TRANSPORT_BACKPRESSURE_BUFFERED_BYTES;
  if (backpressure) {
    transport.backpressureCount = Math.max(0, Math.floor(transport.backpressureCount || 0)) + 1;
  } else {
    transport.backpressureCount = 0;
  }
  return {
    kind: transport.kind,
    ready: transport.readyState === WebSocket.OPEN,
    bufferedBytes,
    backpressure,
    lowWaterDrained: bufferedBytes <= TRANSPORT_BACKPRESSURE_LOW_WATER_BYTES,
    flowUnknown,
    backpressureCount: Math.max(0, Math.floor(transport.backpressureCount || 0)),
    lastSendBytes: Math.max(0, Math.floor(transport.lastSendBytes || 0)),
    totalSendBytes: Math.max(0, Math.floor(transport.totalSendBytes || 0)),
    lastSendAt: Math.max(0, Math.floor(transport.lastSendAt || 0)),
    lastSendError: transport.lastSendError || null,
  };
}

export function markTransportConnectionInboundActivity(
  connection: DaemonTransportConnection,
  now = Date.now(),
) {
  connection.wsAlive = true;
  connection.lastInboundAt = now;
}

export function markTransportConnectionPong(connection: DaemonTransportConnection) {
  // A WebSocket pong is a transport-frame liveness fact, not app-level client
  // heartbeat. It must not refresh the daemon stale transport grace period or
  // adaptive width lease, otherwise a dead native client can keep a tmux mirror
  // alive indefinitely by responding to ws ping frames automatically.
  connection.wsAlive = true;
}

export function createTerminalTransportRuntime(
  deps: TerminalTransportRuntimeDeps,
): TerminalTransportRuntime {
  function createWebSocketSessionTransport(ws: WebSocket): TerminalSessionTransport {
    return {
      kind: 'ws',
      requestOrigin: undefined,
      connectedSent: false,
      get readyState() {
        return ws.readyState;
      },
      get bufferedAmount() {
        return Math.max(0, Math.floor(ws.bufferedAmount || 0));
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

  function createRtcSessionTransport(transport: RtcServerTransport): TerminalSessionTransport {
    return {
      kind: 'rtc',
      requestOrigin: undefined,
      connectedSent: false,
      get readyState() {
        return transport.readyState;
      },
      get bufferedAmount() {
        return Math.max(0, Math.floor(transport.bufferedAmount || 0));
      },
      bufferedAmountForLane(lane) {
        return transport.bufferedAmountForLane
          ? transport.bufferedAmountForLane(lane)
          : Math.max(0, Math.floor(transport.bufferedAmount || 0));
      },
      isLaneOpen(lane) {
        return transport.isLaneOpen
          ? transport.isLaneOpen(lane)
          : lane === 'control' && transport.readyState === WebSocket.OPEN;
      },
      sendText(text: string, lane: TerminalTransportLane = 'control') {
        if (lane === 'bulk' && transport.bufferedAmountForLane) {
          transport.sendText(text, 'bulk');
          return;
        }
        transport.sendText(text);
      },
      close(reason?: string) {
        transport.close(reason);
      },
    };
  }

  function sendTransportMessage(
    transport: TerminalSessionTransport | null | undefined,
    message: TerminalTransportServerFrame,
    laneOverride?: TerminalTransportLane,
  ) {
    if (!transport || transport.readyState !== WebSocket.OPEN) {
      return;
    }
    const text = JSON.stringify(message);
    const bytes = estimateTransportMessageBytes(text);
    const lane: TerminalTransportLane = laneOverride ?? resolveServerFrameLane(message);
    try {
      transport.sendText(text, lane);
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.totalSendBytes = Math.max(0, Math.floor(transport.totalSendBytes || 0)) + bytes;
      transport.lastSendError = null;
      readTerminalTransportBackpressureSnapshot(transport, lane);
    } catch (error) {
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.lastSendError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  function sendText(
    transport: TerminalSessionTransport | null | undefined,
    text: string,
    lane: TerminalTransportLane = 'control',
  ) {
    sendTextLane(transport, text, lane);
  }

  function sendTextLane(
    transport: TerminalSessionTransport | null | undefined,
    text: string,
    lane: TerminalTransportLane,
  ) {
    if (!transport || transport.readyState !== WebSocket.OPEN) {
      return;
    }
    const bytes = estimateTransportMessageBytes(text);
    try {
      transport.sendText(text, lane);
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.totalSendBytes = Math.max(0, Math.floor(transport.totalSendBytes || 0)) + bytes;
      transport.lastSendError = null;
      readTerminalTransportBackpressureSnapshot(transport, lane);
    } catch (error) {
      transport.lastSendAt = Date.now();
      transport.lastSendBytes = bytes;
      transport.lastSendError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  function sendMessage(session: TerminalSession, message: ServerMessage) {
    if (session.transport && session.transport.readyState === WebSocket.OPEN) {
      if (message.type === 'buffer-sync' || message.type === 'connected') {
        deps.daemonRuntimeDebug('send', {
          sessionId: session.id,
          sessionName: session.sessionName,
          type: message.type,
          payloadSummary: deps.summarizePayload(message),
        });
      }
      if (message.type === 'buffer-sync') {
        const text = JSON.stringify(message);
        const traceId = `${session.id}:${Math.max(0, Math.floor(message.payload.revision || 0))}`;
        deps.recordPerformanceTrace?.({
          sessionId: session.id,
          traceId,
          mirrorRevision: Math.max(0, Math.floor(message.payload.revision || 0)),
          subscriberId: session.id,
          stage: 'send-start',
          at: Date.now(),
          bytes: estimateTransportMessageBytes(text),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0,
          transportKind: session.transport.kind,
        });
        sendTextLane(session.transport, text, isTerminalMuxBulkMessageType(message.type) ? 'bulk' : 'control');
        deps.recordPerformanceTrace?.({
          sessionId: session.id,
          traceId,
          mirrorRevision: Math.max(0, Math.floor(message.payload.revision || 0)),
          subscriberId: session.id,
          stage: 'send-done',
          at: Date.now(),
          bytes: estimateTransportMessageBytes(text),
          lineCount: Array.isArray(message.payload.lines) ? message.payload.lines.length : 0,
          transportKind: session.transport.kind,
        });
        return;
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

  function createTransportConnection(transport: TerminalSessionTransport, requestOrigin: string): DaemonTransportConnection {
    transport.requestOrigin = requestOrigin;
    transport.connectedSent = false;
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
      lastInboundAt: Date.now(),
      role: 'pending',
      boundSubscriberId: null,
    };
    deps.connections.set(connection.id, connection);
    return connection;
  }

  return {
    createWebSocketSessionTransport,
    createRtcSessionTransport,
    sendText,
    sendTextLane,
    sendTransportMessage,
    sendMessage,
    broadcastRuntimeDebugControl,
    createTransportConnection,
  };
}
