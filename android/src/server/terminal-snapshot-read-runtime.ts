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
} from './terminal-source-adapter';
import type { SessionMirror } from './terminal-runtime-types';

export interface TerminalSnapshotReadRuntimeDeps {
  resolveExistingSession: (
    request: TerminalSnapshotRequestPayload,
  ) => TerminalSessionIdentityResolution;
  readExistingMirror: (
    session: ResolvedTerminalSession,
  ) => SessionMirror | undefined;
  buildBufferHeadPayload: typeof buildBufferHeadPayload;
  buildRequestedRangeBufferPayload: typeof buildRequestedRangeBufferPayload;
  sendSnapshotResult: (result: TerminalSnapshotResultPayload) => void;
}

export interface TerminalSnapshotReadRuntime {
  handleRequest: (
    request: TerminalSnapshotRequestPayload,
  ) => TerminalSnapshotResultPayload;
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

function copyMirrorSnapshot(mirror: SessionMirror): BufferSyncMirrorSnapshot {
  return {
    revision: mirror.revision,
    bufferStartIndex: mirror.bufferStartIndex,
    bufferLines: mirror.bufferLines.map((line) =>
      line.map((cell) => ({ ...cell }))),
    cols: mirror.cols,
    rows: mirror.rows,
    cursorKeysApp: mirror.cursorKeysApp,
    cursor: mirror.cursor ? { ...mirror.cursor } : mirror.cursor,
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
    handleRequest(request) {
      const resolution = deps.resolveExistingSession(request);
      if (!resolution.ok) {
        return sendResult(deps, {
          status: 'failed',
          code: resolution.code,
        });
      }

      const mirror = deps.readExistingMirror(resolution.session);
      if (!mirror) {
        return sendResult(deps, {
          status: 'unavailable',
          reason: 'mirror_not_present',
        });
      }
      if (mirror.lifecycle !== 'ready') {
        return sendResult(deps, {
          status: 'unavailable',
          reason: 'mirror_not_ready',
        });
      }

      const snapshot = copyMirrorSnapshot(mirror);
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

      const identity = resolution.session.identity;
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
