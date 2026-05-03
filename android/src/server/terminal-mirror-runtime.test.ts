import { describe, expect, it, vi } from 'vitest';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type { ClientSession, SessionMirror } from './terminal-runtime-types';

function createSession(id = 'session-1'): ClientSession {
  return {
    id,
    transportId: 'transport-1',
    transport: {
      kind: 'ws',
      readyState: 1,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    sessionName: 'demo',
    mirrorKey: null,
    wsAlive: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
    connectedSent: false,
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
    expect(session.connectedSent).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'connected' }),
    );
    expect(sendScheduleStateToSession).toHaveBeenCalledWith(session, 'demo');
  });

  it('stops recurring live sync when no subscriber keeps an attached transport', async () => {
    vi.useFakeTimers();
    try {
      const {
        runtime,
        sessions,
        mirrors,
        captureMirrorAuthoritativeBufferFromTmux,
      } = createRuntime();
      const session = createSession();
      sessions.set(session.id, session);

      await runtime.attachTmux(session, {
        name: 'demo',
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      const mirror = mirrors.get('demo');
      expect(mirror?.lifecycle).toBe('ready');
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      session.transport = null;
      session.connectedSent = false;

      vi.advanceTimersByTime(34);
      await Promise.resolve();
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts live sync when a new attached session reuses an already-ready mirror', async () => {
    vi.useFakeTimers();
    try {
      const {
        runtime,
        sessions,
        mirrors,
        captureMirrorAuthoritativeBufferFromTmux,
      } = createRuntime();
      const firstSession = createSession('session-1');
      sessions.set(firstSession.id, firstSession);

      await runtime.attachTmux(firstSession, {
        name: 'demo',
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      const mirror = mirrors.get('demo');
      expect(mirror?.lifecycle).toBe('ready');
      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(1);

      firstSession.transport = null;
      firstSession.connectedSent = false;

      const secondSession = createSession('session-2');
      secondSession.transportId = 'transport-2';
      sessions.set(secondSession.id, secondSession);

      await runtime.attachTmux(secondSession, {
        name: 'demo',
        sessionName: 'demo',
        cols: 120,
        rows: 40,
      });

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();

      expect(captureMirrorAuthoritativeBufferFromTmux).toHaveBeenCalledTimes(2);
      expect(secondSession.mirrorKey).toBe('demo');
      expect(secondSession.connectedSent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
