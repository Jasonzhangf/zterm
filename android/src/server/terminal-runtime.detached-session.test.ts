import { describe, expect, it, vi } from 'vitest';
import { createTerminalRuntime } from './terminal-runtime';
import type { TerminalSession, SessionMirror, TerminalTransportConnection } from './terminal-runtime-types';

function createTransportConnection(id: string): TerminalTransportConnection {
  return {
    transportId: id,
    transport: {
      kind: 'ws',
      readyState: 1,
      requestOrigin: undefined,
      connectedSent: false,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: 'pending',
    boundSessionId: null,
  };
}

function createDeps() {
  const sessions = new Map<string, TerminalSession>();
  const mirrors = new Map<string, SessionMirror>();
  return {
    sessions,
    mirrors,
    runtime: createTerminalRuntime({
      defaultSessionName: 'default',
      defaultViewport: { cols: 120, rows: 40 },
      sessions,
      mirrors,
      sendMessage: vi.fn(),
      sendScheduleStateToSession: vi.fn(),
      buildConnectedPayload: (sessionId: string) => ({ sessionId }),
      buildBufferHeadPayload: (sessionId: string, mirror: SessionMirror) => ({
        sessionId,
        revision: mirror.revision,
        latestEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
      }),
      buildChangedRangesBufferSyncPayload: (mirror: SessionMirror) => ({
        revision: mirror.revision,
        startIndex: mirror.bufferStartIndex,
        endIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        availableStartIndex: mirror.bufferStartIndex,
        availableEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
        cols: mirror.cols,
        rows: mirror.rows,
        cursorKeysApp: mirror.cursorKeysApp,
        cursor: mirror.cursor,
        lines: [],
      }),
      sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
      getMirrorKey: (sessionName: string) => sessionName,
      normalizeTerminalCols: (cols: number | undefined) => cols || 120,
      normalizeTerminalRows: (rows: number | undefined) => rows || 40,
      resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) => (
        requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry
      ),
      readTmuxPaneMetrics: () => ({
        paneId: '%1',
        tmuxAvailableLineCountHint: 0,
        paneRows: 40,
        paneCols: 120,
        alternateOn: false,
      }),
      ensureTmuxSession: vi.fn(),
      captureMirrorAuthoritativeBufferFromTmux: vi.fn(async () => true),
      mirrorBufferChanged: vi.fn(() => []),
      mirrorCursorEqual: vi.fn(() => true),
      writeToLiveMirror: vi.fn(() => true),
      writeToTmuxSession: vi.fn(),
      autoCommandDelayMs: 0,
      waitMs: async () => {},
      daemonRuntimeDebug: vi.fn(),
      logTimePrefix: () => '2026-05-03 00:00:00',
    }),
  };
}

describe('terminal runtime detached transport cleanup', () => {
  it('removes detached transport-bound sessions from runtime maps and mirror subscribers', () => {
    const { runtime, sessions, mirrors } = createDeps();
    const connection = createTransportConnection('transport-1');
    const session = runtime.createTransportBoundSession(connection);
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 120,
      rows: 40,
      cursorKeysApp: false,
      revision: 1,
      lastScrollbackCount: 0,
      bufferStartIndex: 0,
      bufferLines: [],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      subscribers: new Set([session.id]),
    };

    mirrors.set(mirror.key, mirror);
    session.sessionName = mirror.sessionName;
    session.mirrorKey = mirror.key;

    expect(sessions.has(session.id)).toBe(true);
    expect(mirror.subscribers.has(session.id)).toBe(true);

    runtime.detachSessionTransportOnly(session, 'websocket closed', connection.transportId);

    expect(sessions.has(session.id)).toBe(false);
    expect(session.transport).toBeNull();
    expect(session.mirrorKey).toBeNull();
    expect(mirror.subscribers.has(session.id)).toBe(false);
  });
});
