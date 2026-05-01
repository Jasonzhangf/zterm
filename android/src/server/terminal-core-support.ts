import type {
  BufferSyncRequestPayload,
  TerminalCursorState,
} from '../lib/types';
import type { ClientSession } from './terminal-runtime-types';

export interface TerminalCoreSupportDeps {
  defaultSessionName: string;
  maxCapturedScrollbackLines: number;
}

export interface TerminalCoreSupport {
  resolveMirrorCacheLines: (rows: number) => number;
  sanitizeSessionName: (input?: string) => string;
  getMirrorKey: (sessionName: string) => string;
  mirrorCursorEqual: (
    left: TerminalCursorState | null | undefined,
    right: TerminalCursorState | null | undefined,
  ) => boolean;
  normalizeClientSessionId: (input?: string) => string;
  normalizeTerminalCols: (cols: number | undefined) => number;
  normalizeTerminalRows: (rows: number | undefined) => number;
  normalizeBufferSyncRequestPayload: (
    session: Pick<ClientSession, 'id'>,
    request: BufferSyncRequestPayload,
  ) => BufferSyncRequestPayload;
  normalizeSessionTransportToken: (input?: string) => string;
}

export function createTerminalCoreSupport(
  deps: TerminalCoreSupportDeps,
): TerminalCoreSupport {
  function resolveMirrorCacheLines(rows: number) {
    const paneRows = Math.max(1, Math.floor(rows || 1));
    if (!Number.isFinite(deps.maxCapturedScrollbackLines) || deps.maxCapturedScrollbackLines <= 0) {
      return paneRows;
    }
    return Math.max(paneRows, Math.floor(deps.maxCapturedScrollbackLines));
  }

  function sanitizeSessionName(input?: string) {
    const candidate = (input || deps.defaultSessionName).trim();
    const normalized = candidate.replace(/[^a-zA-Z0-9:_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return normalized || deps.defaultSessionName;
  }

  function getMirrorKey(sessionName: string) {
    return sanitizeSessionName(sessionName);
  }

  function mirrorCursorEqual(left: TerminalCursorState | null | undefined, right: TerminalCursorState | null | undefined) {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }
    return left.rowIndex === right.rowIndex && left.col === right.col && left.visible === right.visible;
  }

  function normalizeClientSessionId(input?: string) {
    const candidate = (input || '').trim();
    if (!candidate) {
      throw new Error('connect payload missing clientSessionId');
    }
    return candidate;
  }

  function normalizeTerminalCols(cols: number | undefined) {
    if (!Number.isFinite(cols) || cols! <= 0) {
      throw new Error('terminal cols must be a finite positive number');
    }
    return Math.max(1, Math.floor(cols!));
  }

  function normalizeTerminalRows(rows: number | undefined) {
    if (!Number.isFinite(rows) || rows! <= 0) {
      throw new Error('terminal rows must be a finite positive number');
    }
    return Math.max(1, Math.floor(rows!));
  }

  function normalizeBufferSyncRequestPayload(
    session: Pick<ClientSession, 'id'>,
    request: BufferSyncRequestPayload,
  ): BufferSyncRequestPayload {
    const localStartIndex = Number.isFinite(request.localStartIndex)
      ? Math.max(0, Math.floor(request.localStartIndex))
      : 0;
    if (!Number.isFinite(request.requestStartIndex) || !Number.isFinite(request.requestEndIndex)) {
      throw new Error(`buffer-sync-request missing request window for session ${session.id}`);
    }
    const requestStartIndex = Math.max(0, Math.floor(request.requestStartIndex));
    const requestEndIndex = Math.max(0, Math.floor(request.requestEndIndex));

    return {
      knownRevision: Number.isFinite(request.knownRevision)
        ? Math.max(0, Math.floor(request.knownRevision))
        : 0,
      localStartIndex,
      localEndIndex: Number.isFinite(request.localEndIndex)
        ? Math.max(localStartIndex, Math.floor(request.localEndIndex))
        : localStartIndex,
      requestStartIndex,
      requestEndIndex: Math.max(requestStartIndex, requestEndIndex),
      missingRanges: request.missingRanges,
    };
  }

  function normalizeSessionTransportToken(input?: string) {
    const token = (input || '').trim();
    if (!token) {
      throw new Error('connect payload missing sessionTransportToken');
    }
    return token;
  }

  return {
    resolveMirrorCacheLines,
    sanitizeSessionName,
    getMirrorKey,
    mirrorCursorEqual,
    normalizeClientSessionId,
    normalizeTerminalCols,
    normalizeTerminalRows,
    normalizeBufferSyncRequestPayload,
    normalizeSessionTransportToken,
  };
}
