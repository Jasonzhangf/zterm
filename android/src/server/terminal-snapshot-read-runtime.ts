import type {
  TerminalSnapshotRequestPayload,
  TerminalSnapshotResultPayload,
} from '@zterm/shared/protocol';
import type { BufferSyncRequestPayload } from '@zterm/shared/types';
import type {
  BufferSyncMirrorSnapshot,
  buildBufferHeadPayload,
  buildRequestedRangeBufferPayload,
} from './buffer-sync-contract';
import type {
  ResolvedTerminalSession,
  TerminalSessionIdentityResolution,
  TerminalSourceMirrorSnapshot,
} from './terminal-source-adapter';

export interface TerminalSnapshotReadRuntimeDeps {
  resolveExistingSession: (
    request: TerminalSnapshotRequestPayload,
  ) => TerminalSessionIdentityResolution;
  captureSessionSnapshot: (
    session: ResolvedTerminalSession,
  ) => Promise<TerminalSourceMirrorSnapshot>;
  buildBufferHeadPayload: typeof buildBufferHeadPayload;
  buildRequestedRangeBufferPayload: typeof buildRequestedRangeBufferPayload;
  sendSnapshotResult: (result: TerminalSnapshotResultPayload) => void;
}

export interface TerminalSnapshotReadRuntime {
  handleRequest: (
    request: TerminalSnapshotRequestPayload,
  ) => Promise<TerminalSnapshotResultPayload>;
}

function clampMaxLines(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(1, Math.floor(value)),
  );
}

function copySnapshot(snapshot: TerminalSourceMirrorSnapshot): BufferSyncMirrorSnapshot {
  return {
    revision: snapshot.revision,
    bufferStartIndex: snapshot.bufferStartIndex,
    bufferLines: snapshot.bufferLines.map((line) =>
      line.map((cell) => ({ ...cell }))),
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursorKeysApp: snapshot.cursorKeysApp,
    cursor: snapshot.cursor ? { ...snapshot.cursor } : snapshot.cursor,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function sendResult(
  deps: TerminalSnapshotReadRuntimeDeps,
  result: TerminalSnapshotResultPayload,
): TerminalSnapshotResultPayload {
  const immutableResult = deepFreeze(result);
  deps.sendSnapshotResult(immutableResult);
  return immutableResult;
}

export function createTerminalSnapshotReadRuntime(
  deps: TerminalSnapshotReadRuntimeDeps,
): TerminalSnapshotReadRuntime {
  return {
    async handleRequest(request) {
      const resolution = deps.resolveExistingSession(request);
      if (!resolution.ok) {
        return sendResult(deps, {
          status: 'failed',
          code: resolution.code,
        });
      }

      const session = resolution.session;
      const snapshot = copySnapshot(await deps.captureSessionSnapshot(session));
      const postCaptureResolution = deps.resolveExistingSession(request);
      if (!postCaptureResolution.ok) {
        return sendResult(deps, {
          status: 'failed',
          code: postCaptureResolution.code,
        });
      }
      if (
        postCaptureResolution.session.identity.stableId !== session.identity.stableId
        || postCaptureResolution.session.identity.backend !== session.identity.backend
      ) {
        return sendResult(deps, {
          status: 'failed',
          code: 'session_identity_mismatch',
        });
      }

      const availableStartIndex = Math.max(
        0,
        Math.floor(snapshot.bufferStartIndex || 0),
      );
      const availableEndIndex = Math.max(
        availableStartIndex,
        snapshot.bufferStartIndex + snapshot.bufferLines.length,
      );
      const lineCount = Math.min(
        Math.max(0, availableEndIndex - availableStartIndex),
        clampMaxLines(request.maxLines),
      );
      const requestStartIndex = availableEndIndex - lineCount;
      const bodyRequest: BufferSyncRequestPayload = {
        knownRevision: snapshot.revision,
        localStartIndex: requestStartIndex,
        localEndIndex: requestStartIndex,
        requestStartIndex,
        requestEndIndex: availableEndIndex,
        targetHeadRevision: snapshot.revision,
      };

      const identity = session.identity;
      const head = deps.buildBufferHeadPayload(identity.stableId, snapshot);
      const body = deps.buildRequestedRangeBufferPayload(snapshot, bodyRequest);
      return sendResult(deps, {
        status: 'available',
        backend: identity.backend,
        stableId: identity.stableId,
        head,
        body,
      });
    },
  };
}
