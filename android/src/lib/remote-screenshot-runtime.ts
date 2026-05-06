import type {
  ClientMessage,
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  RemoteScreenshotCapture,
  RemoteScreenshotRequestPayload,
  RemoteScreenshotStatusPayload,
} from './types';
import type { BridgeTransportSocket } from './traversal/types';

export interface PendingRemoteScreenshotRequest {
  fileName: string | null;
  chunks: Map<number, string>;
  totalBytes: number;
  phase: 'request-sent' | 'capturing' | 'transferring';
  timeoutId: number | null;
  onProgress?: (progress: RemoteScreenshotStatusPayload) => void;
  resolve: (capture: RemoteScreenshotCapture) => void;
  reject: (error: Error) => void;
}

export const REMOTE_SCREENSHOT_REQUEST_TIMEOUT_MS = 15000;

export function buildRemoteScreenshotCapture(
  fileName: string,
  chunks: Map<number, string>,
  totalBytes: number,
): RemoteScreenshotCapture {
  const ordered: string[] = [];
  const binaryParts: Uint8Array[] = [];
  let totalBinaryLength = 0;
  for (let index = 0; index < chunks.size; index += 1) {
    const chunk = chunks.get(index);
    if (!chunk) {
      throw new Error(`Remote screenshot missing chunk ${index}`);
    }
    ordered.push(chunk);
    try {
      const decoded = atob(chunk);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i += 1) {
        bytes[i] = decoded.charCodeAt(i);
      }
      binaryParts.push(bytes);
      totalBinaryLength += bytes.length;
    } catch (error) {
      throw new Error(
        `Remote screenshot chunk ${index} decode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const result: RemoteScreenshotCapture = {
    fileName,
    mimeType: 'image/png',
    dataBase64: ordered.join(''),
    totalBytes,
  };
  if (totalBinaryLength > 0) {
    const combined = new Uint8Array(totalBinaryLength);
    let offset = 0;
    for (const part of binaryParts) {
      combined.set(part, offset);
      offset += part.length;
    }
    result.dataBytes = combined;
  }

  return result;
}

export function createRemoteScreenshotRuntime(input?: {
  timeoutMs?: number;
  setTimeoutFn?: typeof window.setTimeout;
  clearTimeoutFn?: typeof window.clearTimeout;
  now?: () => number;
}) {
  const pendingRequests = new Map<string, PendingRemoteScreenshotRequest>();
  const timeoutMs = input?.timeoutMs ?? REMOTE_SCREENSHOT_REQUEST_TIMEOUT_MS;
  const setTimeoutFn = input?.setTimeoutFn ?? window.setTimeout.bind(window);
  const clearTimeoutFn = input?.clearTimeoutFn ?? window.clearTimeout.bind(window);
  const now = input?.now ?? (() => Date.now());

  const clearPendingTimeout = (pending: PendingRemoteScreenshotRequest) => {
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
      activePending.reject(new Error(`Remote screenshot timed out during ${activePending.phase}`));
    }, timeoutMs) as unknown as number;
    return true;
  };

  return {
    request(sessionId: string, options: {
      ws: BridgeTransportSocket;
      onProgress?: (progress: RemoteScreenshotStatusPayload) => void;
      sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
    }) {
      const targetSessionId = sessionId.trim();
      if (!targetSessionId) {
        throw new Error('No target session for remote screenshot');
      }
      const requestId = `rs-${now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<RemoteScreenshotCapture>((resolve, reject) => {
        const pending: PendingRemoteScreenshotRequest = {
          fileName: null,
          chunks: new Map(),
          totalBytes: 0,
          phase: 'request-sent',
          timeoutId: null,
          onProgress: options.onProgress,
          resolve,
          reject,
        };
        pendingRequests.set(requestId, pending);
        armPendingTimeout(requestId);

        try {
          const payload: RemoteScreenshotRequestPayload = { requestId };
          options.sendSocketPayload(targetSessionId, options.ws, JSON.stringify({
            type: 'remote-screenshot-request',
            payload,
          } satisfies ClientMessage));
        } catch (error) {
          pendingRequests.delete(requestId);
          clearPendingTimeout(pending);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    handleStatus(payload: RemoteScreenshotStatusPayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pending.phase = payload.phase;
      pending.fileName = payload.fileName || pending.fileName;
      pending.totalBytes = Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0));
      armPendingTimeout(payload.requestId);
      pending.onProgress?.({
        ...payload,
        fileName: payload.fileName || pending.fileName || undefined,
        totalBytes: Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0)),
      });
      return true;
    },

    handleChunk(payload: FileDownloadChunkPayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pending.phase = 'transferring';
      pending.fileName = payload.fileName || pending.fileName;
      pending.chunks.set(payload.chunkIndex, payload.dataBase64);
      armPendingTimeout(payload.requestId);
      pending.onProgress?.({
        requestId: payload.requestId,
        phase: 'transferring',
        fileName: payload.fileName || pending.fileName || undefined,
        receivedChunks: pending.chunks.size,
        totalChunks: Math.max(0, Math.floor(payload.totalChunks || 0)),
        totalBytes: pending.totalBytes,
      });
      return true;
    },

    handleComplete(payload: FileDownloadCompletePayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pendingRequests.delete(payload.requestId);
      clearPendingTimeout(pending);
      try {
        pending.resolve(buildRemoteScreenshotCapture(
          payload.fileName || pending.fileName || `remote-screenshot-${now()}.png`,
          pending.chunks,
          Math.max(0, Math.floor(payload.totalBytes || pending.totalBytes || 0)),
        ));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return true;
    },

    handleError(payload: FileDownloadErrorPayload) {
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) {
        return false;
      }
      pendingRequests.delete(payload.requestId);
      clearPendingTimeout(pending);
      pending.reject(new Error(payload.error || 'Remote screenshot download failed'));
      return true;
    },

    dispose(reason = 'Session provider disposed before remote screenshot completed') {
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
}
