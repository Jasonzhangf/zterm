import type {
  ClientMessage,
  RemoteWindowStreamErrorPayload,
  RemoteWindowStreamRequestPayload,
  RemoteWindowStreamTargetsResponsePayload,
  ServerMessage,
} from './types';
import type { BridgeTransportSocket } from './traversal/types';

export type RemoteWindowControlMessage = Extract<
  ServerMessage,
  { type: 'remote-window-targets-response' } | { type: 'remote-window-error' }
>;

interface PendingRemoteWindowTargetsRequest {
  timeoutId: number | null;
  resolve: (payload: RemoteWindowStreamTargetsResponsePayload) => void;
  reject: (error: Error) => void;
}

export const REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS = 15000;

export function isRemoteWindowControlMessage(msg: ServerMessage): msg is RemoteWindowControlMessage {
  return msg.type === 'remote-window-targets-response' || msg.type === 'remote-window-error';
}

function buildRemoteWindowError(payload: RemoteWindowStreamErrorPayload) {
  const message = payload.message || payload.code || 'remote window request failed';
  const error = new Error(message);
  error.name = payload.code || 'remote_window_error';
  return error;
}

export function createRemoteWindowMessageRuntime(input?: {
  timeoutMs?: number;
  setTimeoutFn?: typeof window.setTimeout;
  clearTimeoutFn?: typeof window.clearTimeout;
  now?: () => number;
}) {
  const pendingRequests = new Map<string, PendingRemoteWindowTargetsRequest>();
  const timeoutMs = input?.timeoutMs ?? REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS;
  const setTimeoutFn = input?.setTimeoutFn ?? window.setTimeout.bind(window);
  const clearTimeoutFn = input?.clearTimeoutFn ?? window.clearTimeout.bind(window);
  const now = input?.now ?? (() => Date.now());

  const clearPendingTimeout = (pending: PendingRemoteWindowTargetsRequest) => {
    if (pending.timeoutId !== null) {
      clearTimeoutFn(pending.timeoutId);
      pending.timeoutId = null;
    }
  };

  const armPendingTimeout = (requestId: string) => {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }
    clearPendingTimeout(pending);
    pending.timeoutId = setTimeoutFn(() => {
      const activePending = pendingRequests.get(requestId);
      if (!activePending) {
        return;
      }
      pendingRequests.delete(requestId);
      activePending.timeoutId = null;
      activePending.reject(new Error('Remote window target catalog timed out'));
    }, timeoutMs) as unknown as number;
    return true;
  };

  const runtime = {
    requestTargets(sessionId: string, options: {
      ws: BridgeTransportSocket;
      request?: Omit<RemoteWindowStreamRequestPayload, 'requestId'>;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId) {
        throw new Error('No target session for remote window catalog');
      }
      const requestId = `rw-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteWindowStreamTargetsResponsePayload>((resolve, reject) => {
        const pending: PendingRemoteWindowTargetsRequest = {
          timeoutId: null,
          resolve,
          reject,
        };
        pendingRequests.set(requestId, pending);
        armPendingTimeout(requestId);

        try {
          const payload: RemoteWindowStreamRequestPayload = {
            requestId,
            includeAppWindows: options.request?.includeAppWindows ?? true,
            includeIterm2: options.request?.includeIterm2 ?? true,
          };
          options.sendSocketPayload(targetSessionId, options.ws, JSON.stringify({
            type: 'remote-window-targets-request',
            payload,
          } satisfies ClientMessage));
        } catch (error) {
          pendingRequests.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    handleTargetsResponse(payload: RemoteWindowStreamTargetsResponsePayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pendingRequests.delete(payload.requestId);
      clearPendingTimeout(pending);
      pending.resolve(payload);
      return true;
    },

    handleError(payload: RemoteWindowStreamErrorPayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pendingRequests.delete(payload.requestId);
      clearPendingTimeout(pending);
      pending.reject(buildRemoteWindowError(payload));
      return true;
    },

    dispatch(msg: RemoteWindowControlMessage) {
      if (msg.type === 'remote-window-targets-response') {
        return runtime.handleTargetsResponse(msg.payload);
      }
      return runtime.handleError(msg.payload);
    },

    dispose(reason = 'Session provider disposed before remote window request completed') {
      for (const pending of pendingRequests.values()) {
        clearPendingTimeout(pending);
        pending.reject(new Error(reason));
      }
      pendingRequests.clear();
    },

    getPendingCount() {
      return pendingRequests.size;
    },
  };

  return runtime;
}
