import type {
  Session,
  RemoteWindowStreamTargetsResponsePayload,
} from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';

interface RemoteWindowMessageRuntimeLike {
  requestTargets: (
    sessionId: string,
    options: {
      ws: BridgeTransportSocket;
      request?: { includeAppWindows?: boolean; includeIterm2?: boolean };
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
}

function formatSocketReadyState(ws: BridgeTransportSocket | null) {
  if (!ws) {
    return 'missing';
  }
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return `unknown:${ws.readyState}`;
  }
}

export function resolveRemoteWindowCatalogTransport(options: {
  sessionId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
}) {
  const targetSessionId = options.sessionId.trim();
  const session = options.sessions.find((item) => item.id === targetSessionId) || null;
  if (!session) {
    throw new Error('Remote window catalog session no longer exists');
  }
  const ws = options.readSessionTransportSocket(targetSessionId) || null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }
  throw new Error(
    `Remote window catalog transport is not open (session=${session.state || 'missing'}, socket=${formatSocketReadyState(ws)})`,
  );
}

export async function requestRemoteWindowTargetsRuntime(options: {
  sessionId: string;
  sessions: Session[];
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  remoteWindowMessageRuntime: RemoteWindowMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for remote window catalog');
  }

  const ws = resolveRemoteWindowCatalogTransport({
    sessionId: targetSessionId,
    sessions: options.sessions,
    readSessionTransportSocket: options.readSessionTransportSocket,
  });
  return options.remoteWindowMessageRuntime.requestTargets(targetSessionId, {
    ws,
    sendSocketPayload: options.sendSocketPayload,
  });
}
