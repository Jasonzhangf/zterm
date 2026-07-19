import type {
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

export async function requestRemoteWindowTargetsRuntime(options: {
  sessionId: string;
  ensureSessionReady: (sessionId: string, timeoutMs?: number) => Promise<BridgeTransportSocket>;
  remoteWindowMessageRuntime: RemoteWindowMessageRuntimeLike;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
}) {
  const targetSessionId = options.sessionId.trim();
  if (!targetSessionId) {
    throw new Error('No target session for remote window catalog');
  }

  const ws = await options.ensureSessionReady(targetSessionId);
  return options.remoteWindowMessageRuntime.requestTargets(targetSessionId, {
    ws,
    sendSocketPayload: options.sendSocketPayload,
  });
}
