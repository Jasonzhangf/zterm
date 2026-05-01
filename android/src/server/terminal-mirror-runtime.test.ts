import { describe, expect, it, vi } from 'vitest';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type { ClientSession, SessionMirror } from './terminal-runtime-types';

function createSession(id = 'session-1'): ClientSession {
  return {
    id,
    clientSessionId: id,
    transportId: 'transport-1',
    readyTransportId: null,
    transport: {
      kind: 'ws',
      readyState: 1,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    transportRequestOrigin: 'http://127.0.0.1:3333',
    sessionName: 'demo',
    mirrorKey: null,
    wsAlive: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
    logicalSessionBound: true,
  };
}

function createRuntime() {
  const sessions = new Map<string, ClientSession>();
  const mirrors = new Map<string, SessionMirror>();
  const ensureTmuxSession = vi.fn();
  const captureMirrorAuthoritativeBufferFromTmux = vi.fn(async (mirror: SessionMirror) => {
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    mirror.cursorKeysApp = false;
    return true;
  });
  const sendMessage = vi.fn();
  const sendScheduleStateToSession = vi.fn();

  const runtime = createTerminalMirrorRuntime({
    defaultViewport: { cols: 120, rows: 40 },
    sessions,
    mirrors,
    sendMessage,
    sendScheduleStateToSession,
    buildConnectedPayload: (sessionId: string) => ({ sessionId }),
    buildBufferHeadPayload: () => ({
      sessionId: 'session-1',
      revision: 1,
      latestEndIndex: 0,
      availableStartIndex: 0,
      availableEndIndex: 0,
      cursor: null,
    }),
    sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
    getMirrorKey: (sessionName: string) => sessionName,
    normalizeTerminalCols: (cols?: number) => cols || 120,
    normalizeTerminalRows: (rows?: number) => rows || 40,
    resolveAttachGeometry: ({ requestedGeometry, currentMirrorGeometry, existingTmuxGeometry, previousSessionGeometry }) =>
      requestedGeometry || currentMirrorGeometry || existingTmuxGeometry || previousSessionGeometry,
    readTmuxPaneMetrics: () => ({
      paneId: '%1',
      tmuxAvailableLineCountHint: 0,
      paneRows: 40,
      paneCols: 120,
      alternateOn: false,
    }),
    ensureTmuxSession,
    captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: () => [],
    mirrorCursorEqual: () => true,
    writeToLiveMirror: () => true,
    writeToTmuxSession: vi.fn(),
    autoCommandDelayMs: 0,
    waitMs: async () => {},
    logTimePrefix: () => '2026-05-01 00:00:00',
    closeLogicalClientSession: vi.fn(),
    getClientMirror: (session: ClientSession) => (session.mirrorKey ? mirrors.get(session.mirrorKey) || null : null),
  });

  return {
    runtime,
    sessions,
    mirrors,
    ensureTmuxSession,
    captureMirrorAuthoritativeBufferFromTmux,
    sendMessage,
    sendScheduleStateToSession,
  };
}

describe('terminal mirror runtime lifecycle truth', () => {
  it('creates new mirrors as idle so attach can boot them exactly once', async () => {
    const { runtime, mirrors } = createRuntime();
    const mirror = runtime.createMirror('demo');
    expect(mirror.lifecycle).toBe('idle');
    expect(mirrors.get('demo')?.lifecycle).toBe('idle');
  });

  it('attachTmux boots a newly created mirror and marks session ready', async () => {
    const { runtime, sessions, mirrors, ensureTmuxSession, captureMirrorAuthoritativeBufferFromTmux, sendMessage, sendScheduleStateToSession } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);

    await runtime.attachTmux(session, {
      name: 'demo',
      sessionName: 'demo',
      cols: 120,
      rows: 40,
    });

    const mirror = mirrors.get('demo');
    expect(mirror).toBeTruthy();
    expect(mirror?.lifecycle).toBe('ready');
    expect(ensureTmuxSession).toHaveBeenCalledTimes(1);
    expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
    expect(session.mirrorKey).toBe('demo');
    expect(session.readyTransportId).toBe('transport-1');
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'connected' }),
    );
    expect(sendScheduleStateToSession).toHaveBeenCalledWith(session, 'demo');
  });
});
