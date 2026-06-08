import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalMessageRuntime } from './terminal-message-runtime';
import type {
  TerminalSession,
  TerminalSessionTransport,
  SessionMirror,
  TerminalTransportConnection,
} from './terminal-runtime-types';
import type { TerminalFileTransferRuntime } from './terminal-file-transfer-runtime';

function createTransport(): TerminalSessionTransport {
  return {
    kind: 'ws',
    readyState: 1,
    requestOrigin: 'http://127.0.0.1:3333',
    connectedSent: false,
    sendText: vi.fn(),
    close: vi.fn(),
  };
}

function createConnection(boundSessionId: string | null = null): TerminalTransportConnection {
  return {
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: boundSessionId ? 'session' : 'pending',
    boundSessionId,
  };
}

function createSession(id = 'session-1'): TerminalSession {
  return {
    id,
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    sessionName: 'demo',
    mirrorKey: 'demo',
    widthMode: 'mirror-fixed',
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createFileTransferRuntimeStub(): TerminalFileTransferRuntime {
  return {
    handlePasteImage: vi.fn(),
    handleFileListRequest: vi.fn(),
    handleFileCreateDirectoryRequest: vi.fn(),
    handleFileDownloadRequest: vi.fn(),
    handleRemoteScreenshotRequest: vi.fn(async () => {}),
    handleFileUploadStart: vi.fn(),
    handleFileUploadChunk: vi.fn(),
    handleFileUploadEnd: vi.fn(),
    handleBinaryPayload: vi.fn(),
  };
}

function createRuntime(options?: {
  mirror?: SessionMirror | null;
}) {
  const sessions = new Map<string, TerminalSession>();
  const sendTransportMessage = vi.fn();
  const sendMessage = vi.fn();
  const sendBufferHeadToSession = vi.fn();
  const refreshMirrorHeadForSession = vi.fn(async () => true);
  const handleInput = vi.fn();
  const closeSession = vi.fn();
  const handleClientDebugLog = vi.fn();
  const handleClientDebugSnapshot = vi.fn();
  const handleAdaptiveResize = vi.fn();
  const terminalFileTransferRuntime = createFileTransferRuntimeStub();

  const runtime = createTerminalMessageRuntime({
    sessions,
    sendTransportMessage,
    sendMessage,
    normalizeBufferSyncRequestPayload: (_session, request) => request,
    getSessionMirror: () => options?.mirror ?? null,
    sendBufferHeadToSession,
    refreshMirrorHeadForSession,
    handleInput,
    closeSession,
    terminalFileTransferRuntime,
    handleClientDebugLog,
    handleClientDebugSnapshot,
    controlRuntimeDeps: {
      sessions,
      mirrors: new Map<string, SessionMirror>(),
      issueSessionTransportToken: vi.fn(() => 'token'),
      consumeSessionTransportToken: vi.fn(() => true),
      scheduleEngine: {
        listBySession: vi.fn(() => []),
        upsert: vi.fn(),
        delete: vi.fn(),
        toggle: vi.fn(),
        runNow: vi.fn(async () => undefined),
        renameSession: vi.fn(),
        markSessionMissing: vi.fn(),
      },
      sendTransportMessage,
      sendMessage,
      sendScheduleStateToSession: vi.fn(),
      listTmuxSessions: vi.fn(() => []),
      createDetachedTmuxSession: vi.fn(() => 'demo'),
      renameTmuxSession: vi.fn(() => 'demo'),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
      sanitizeSessionName: vi.fn((input?: string) => input?.trim() || 'demo'),
      createTransportBoundSession: vi.fn(),
      bindConnectionToSession: vi.fn(),
      getMirrorKey: vi.fn((sessionName: string) => sessionName),
      attachTmux: vi.fn(async () => {}),
      handleAdaptiveResize,
      destroyMirror: vi.fn(),
    },
  });

  return {
    runtime,
    sessions,
    sendTransportMessage,
    sendMessage,
    sendBufferHeadToSession,
    refreshMirrorHeadForSession,
    handleClientDebugLog,
    handleClientDebugSnapshot,
    handleInput,
    closeSession,
    handleAdaptiveResize,
  };
}

describe('terminal message runtime explicit error truth', () => {
  it('does not echo legacy clientSessionId in session-ticket because daemon owns no client state', async () => {
    const { runtime, sendTransportMessage } = createRuntime();
    const connection = createConnection(null);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'session-open',
      payload: {
        clientSessionId: 'session-legacy',
      },
    })));

    expect(sendTransportMessage).toHaveBeenCalledWith(
      connection.transport,
      expect.objectContaining({
        type: 'session-ticket',
        payload: expect.not.objectContaining({
          clientSessionId: expect.anything(),
        }),
      }),
    );
  });

  it('returns explicit session_not_ready error for buffer-head-request when mirror is missing', async () => {
    const { runtime, sessions, sendMessage, sendBufferHeadToSession } = createRuntime({ mirror: null });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    expect(sendBufferHeadToSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'buffer-head-request requires a ready mirror',
        code: 'session_not_ready',
      },
    });
  });

  it('returns explicit session_not_ready error for buffer-sync-request when mirror is not ready', async () => {
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'booting',
      cols: 120,
      rows: 40,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
      bufferStartIndex: 0,
      bufferLines: [],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      adaptiveCols: new Map(),
      subscribers: new Set(),
    };
    const { runtime, sessions, sendMessage } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-sync-request',
      payload: {
        startIndex: 0,
        endIndex: 0,
      },
    })));

    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'buffer-sync-request requires a ready mirror',
        code: 'session_not_ready',
      },
    });
  });

  it('uses buffer-head-request as a pure head-read probe path', async () => {
    const mirror: SessionMirror = {
      key: 'demo',
      sessionName: 'demo',
      scratchBridge: null,
      lifecycle: 'ready',
      cols: 120,
      rows: 40,
      cursorKeysApp: false,
      revision: 0,
      lastScrollbackCount: -1,
      bufferStartIndex: 0,
      bufferLines: [],
      cursor: null,
      lastFlushStartedAt: 0,
      lastFlushCompletedAt: 0,
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      adaptiveCols: new Map(),
      subscribers: new Set(),
    };
    const { runtime, sessions, refreshMirrorHeadForSession, sendBufferHeadToSession } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    expect(refreshMirrorHeadForSession).not.toHaveBeenCalled();
    expect(sendBufferHeadToSession).toHaveBeenCalledWith(session, mirror);
  });

  it('routes debug-snapshot frames to the dedicated client debug snapshot handler', async () => {
    const { runtime, sessions, handleClientDebugSnapshot } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'debug-snapshot',
      payload: {
        snapshot: {
          source: 'session-transport-runtime-debug',
          keyboardInset: 320,
        },
      },
    })));

    expect(handleClientDebugSnapshot).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        snapshot: expect.objectContaining({
          keyboardInset: 320,
        }),
      }),
    );
  });

  it('routes adaptive-phone resize frames to daemon width owner without terminal input fallback', async () => {
    const { runtime, sessions, sendTransportMessage, handleInput, closeSession, handleAdaptiveResize } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'resize',
      payload: {
        cols: 72,
        rows: 24,
        widthMode: 'adaptive-phone',
      },
    })));

    expect(sendTransportMessage).not.toHaveBeenCalled();
    expect(handleInput).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(handleAdaptiveResize).toHaveBeenCalledWith(session, {
      cols: 72,
      widthMode: 'adaptive-phone',
    });
  });

  it('writes string input payloads to the attached session', async () => {
    const { runtime, sessions, handleInput, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'pwd\r',
    })));

    expect(handleInput).toHaveBeenCalledWith(session, 'pwd\r');
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('rejects object input payloads instead of writing object stringification to tmux', async () => {
    const { runtime, sessions, handleInput, sendMessage } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: {
        data: 'pwd\r',
        sentAt: Date.now(),
      },
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(session, {
      type: 'error',
      payload: {
        message: 'invalid input payload',
        code: 'input_invalid',
      },
    });
  });
});
