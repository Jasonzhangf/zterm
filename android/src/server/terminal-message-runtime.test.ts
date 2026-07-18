import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES } from '@zterm/shared/terminal/input-chunking';
import { createTerminalMessageRuntime } from './terminal-message-runtime';
import type { TerminalMessageRuntimeDeps } from './terminal-message-runtime';
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

function createConnection(boundSubscriberId: string | null = null): TerminalTransportConnection {
  return {
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    requestOrigin: 'http://127.0.0.1:3333',
    role: boundSubscriberId ? 'session' : 'pending',
    boundSubscriberId,
  };
}

function bindSessionToConnection(session: TerminalSession, connection: TerminalTransportConnection) {
  session.id = connection.transportId;
  session.transportId = connection.transportId;
  session.transport = connection.transport;
  session.closeTransport = connection.closeTransport;
  connection.boundSubscriberId = session.id;
  connection.role = 'session';
}

function createSession(id = 'session-1'): TerminalSession {
  return {
    id,
    transportId: 'transport-1',
    transport: createTransport(),
    closeTransport: vi.fn(),
    sessionName: 'demo',
    mirrorKey: 'demo',
    bodySubscribed: true,
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createReadyMirror(): SessionMirror {
  return {
    key: 'demo',
    sessionName: 'demo',
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 120,
    rows: 40,
    cursorKeysApp: false,
    revision: 3,
    lastScrollbackCount: 0,
    bufferStartIndex: 0,
    bufferLines: [],
    cursor: null,
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt: 0,
    lastHeadBroadcastAt: 0,
    flushInFlight: false,
    flushPromise: null,
    liveSyncTimer: null,
    consecutiveFailures: 0,
    subscribers: new Set(),
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
  const scheduleMirrorLiveSync = vi.fn();
  const refreshMirrorHeadForSession = vi.fn(async () => true);
  const handleInput = vi.fn(async () => true) as unknown as ReturnType<typeof vi.fn> & TerminalMessageRuntimeDeps['handleInput'];
  const closeSession = vi.fn();
  const handleClientDebugLog = vi.fn();
  const handleClientDebugSnapshot = vi.fn();
  const handleAdaptiveResize = vi.fn();
  const daemonRuntimeDebug = vi.fn();
  const terminalFileTransferRuntime = createFileTransferRuntimeStub();

  const runtime = createTerminalMessageRuntime({
    sessions,
    sendTransportMessage,
    sendMessage,
    normalizeBufferSyncRequestPayload: (_session, request) => request,
    getSessionMirror: () => options?.mirror ?? null,
    sendBufferHeadToSession,
    scheduleMirrorLiveSync,
    refreshMirrorHeadForSession,
    handleInput,
    closeSession,
    terminalFileTransferRuntime,
    handleClientDebugLog,
    handleClientDebugSnapshot,
    daemonRuntimeDebug,
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
      closeDetachedTerminalSession: vi.fn(),
      renameTmuxSession: vi.fn(() => 'demo'),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
      sanitizeSessionName: vi.fn((input?: string) => input?.trim() || 'demo'),
      createTransportSubscriber: vi.fn(),
      bindConnectionToSubscriber: vi.fn(),
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
    scheduleMirrorLiveSync,
    refreshMirrorHeadForSession,
    handleClientDebugLog,
    handleClientDebugSnapshot,
    handleInput,
    closeSession,
    handleAdaptiveResize,
    daemonRuntimeDebug,
  };
}

describe('terminal message runtime explicit error truth', () => {
  it('updates physical body subscription without closing the transport, and resubscribe sends head truth plus live demand', async () => {
    const mirror = createReadyMirror();
    const { runtime, sessions, sendBufferHeadToSession, scheduleMirrorLiveSync } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'body-subscription',
      payload: { version: 1, subscribed: false },
    })));

    expect(session.bodySubscribed).toBe(false);
    expect(connection.transport.close).not.toHaveBeenCalled();
    expect(sendBufferHeadToSession).not.toHaveBeenCalled();
    expect(scheduleMirrorLiveSync).toHaveBeenCalledWith(mirror, 0);
    scheduleMirrorLiveSync.mockClear();

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'body-subscription',
      payload: { version: 1, subscribed: true },
    })));

    expect(session.bodySubscribed).toBe(true);
    expect(connection.transport.close).not.toHaveBeenCalled();
    expect(sendBufferHeadToSession).toHaveBeenCalledWith(session, mirror);
    expect(scheduleMirrorLiveSync).toHaveBeenCalledWith(mirror, 0);
  });

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
      lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
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

  it('allows explicit buffer-sync range reads while physical body subscription is disabled', async () => {
    const mirror = createReadyMirror();
    mirror.bufferLines = [[{
      char: 97,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }]];
    mirror.revision = 4;
    const { runtime, sessions, sendMessage, sendBufferHeadToSession, scheduleMirrorLiveSync } = createRuntime({ mirror });
    const session = createSession();
    session.bodySubscribed = false;
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-sync-request',
      payload: {
        knownRevision: 4,
        localStartIndex: 0,
        localEndIndex: 0,
        requestStartIndex: 0,
        requestEndIndex: 1,
      },
    })));

    expect(sendBufferHeadToSession).not.toHaveBeenCalled();
    expect(scheduleMirrorLiveSync).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(session, expect.objectContaining({
      type: 'buffer-sync',
      payload: expect.objectContaining({
        revision: 4,
        startIndex: 0,
        endIndex: 1,
        availableStartIndex: 0,
        availableEndIndex: 1,
      }),
    }));
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
      lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
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

  it('sends a buffer-head immediately for each head request without cache window suppression', async () => {
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
      lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      flushInFlight: false,
      flushPromise: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set(),
    };
    const { runtime, sessions, sendBufferHeadToSession } = createRuntime({ mirror });
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'buffer-head-request',
      payload: {},
    })));

    expect(sendBufferHeadToSession).toHaveBeenCalledTimes(2);
    expect(sendBufferHeadToSession).toHaveBeenNthCalledWith(
      1,
      session,
      mirror,
    );
    expect(sendBufferHeadToSession).toHaveBeenNthCalledWith(
      2,
      session,
      mirror,
    );
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

  it('routes resize frames as compatibility no-op without terminal input fallback', async () => {
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

  it('surfaces resize session_not_ready failures instead of silently accepting them', async () => {
    const { runtime, sessions, sendMessage, handleAdaptiveResize } = createRuntime();
    const session = createSession();
    sessions.set(session.id, session);
    const connection = createConnection(session.id);
    handleAdaptiveResize.mockReturnValueOnce({
      ok: false,
      code: 'session_not_ready',
      message: 'resize requires an attached mirror',
    });

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'resize',
      payload: {
        cols: 72,
        widthMode: 'adaptive-phone',
      },
    })));

    expect(sendMessage).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: 'error',
        payload: {
          message: 'resize requires an attached mirror',
          code: 'session_not_ready',
        },
      }),
    );
  });

  it('writes string input payloads to the attached session', async () => {
    const { runtime, sessions, handleInput, sendMessage, daemonRuntimeDebug } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'pwd\r',
    })));

    expect(handleInput).toHaveBeenCalledWith(session, 'pwd\r', expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'error' }),
    );
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-receive', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      bytes: 4,
      queueDepth: 0,
    }));
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-write', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      sessionName: 'demo',
      bytes: 4,
      queueDepth: 0,
    }));
    expect(JSON.stringify(daemonRuntimeDebug.mock.calls)).not.toContain('pwd');
  });

  it('accepts input payloads at the daemon frame byte limit', async () => {
    const { runtime, sessions, handleInput, sendMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    const payload = 'a'.repeat(TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload,
    })));

    expect(handleInput).toHaveBeenCalledWith(session, payload, expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('rejects input payloads over the daemon frame byte limit before tmux write', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage, daemonRuntimeDebug } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    const payload = 'a'.repeat(TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES + 1);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload,
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: {
        message: `input payload exceeds ${TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES} bytes; client must chunk`,
        code: 'input_too_large',
      },
    });
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-drop', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      reason: 'input_too_large',
      bytes: TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES + 1,
      max: TERMINAL_INPUT_DAEMON_FRAME_MAX_BYTES,
    }));
    expect(JSON.stringify(daemonRuntimeDebug.mock.calls)).not.toContain(payload.slice(0, 32));
  });

  it('rejects object input payloads instead of writing object stringification to tmux', async () => {
    const { runtime, sessions, handleInput, sendMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

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

  it('drops input when the bound session was detached before dispatch reaches tmux', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);
    sessions.delete(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'late-after-detach\r',
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires an attached session transport', code: 'session_required' },
    });
  });

  it('drops input when the current session transport no longer matches the message transport', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage, daemonRuntimeDebug } = createRuntime();
    const session = createSession();
    session.transportId = 'transport-2';
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'late-from-old-transport\r',
    })));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires the current attached session transport', code: 'input_stale_transport' },
    });
    expect(daemonRuntimeDebug).toHaveBeenCalledWith('input-drop', expect.objectContaining({
      transportId: connection.transportId,
      sessionId: session.id,
      reason: 'input_stale_transport',
      bytes: 24,
      queueDepth: 0,
    }));
    expect(JSON.stringify(daemonRuntimeDebug.mock.calls)).not.toContain('late-from-old-transport');
  });

  it('drops plain text input when the current session transport no longer matches the message transport', async () => {
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    const session = createSession();
    session.transportId = 'transport-2';
    sessions.set(session.id, session);
    const connection = createConnection(session.id);

    await runtime.handleMessage(connection, Buffer.from('plain-late-from-old-transport\r'));

    expect(handleInput).not.toHaveBeenCalled();
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires the current attached session transport', code: 'input_stale_transport' },
    });
  });

  it('drops queued input when transport/session becomes stale before async tmux write drains', async () => {
    let allowWrite = false;
    const { runtime, sessions, handleInput, sendTransportMessage } = createRuntime();
    handleInput.mockImplementation(async (_session, _data, shouldWrite?: () => boolean) => {
      await Promise.resolve();
      return shouldWrite ? shouldWrite() : allowWrite;
    });

    const session = createSession();
    const connection = createConnection(session.id);
    bindSessionToConnection(session, connection);
    sessions.set(session.id, session);

    const pending = runtime.handleMessage(connection, Buffer.from(JSON.stringify({
      type: 'input',
      payload: 'delayed\r',
    })));

    sessions.delete(session.id);
    allowWrite = false;
    await pending;

    expect(handleInput).toHaveBeenCalledWith(session, 'delayed\r', expect.any(Function));
    expect(sendTransportMessage).toHaveBeenCalledWith(connection.transport, {
      type: 'error',
      payload: { message: 'input requires the current attached session transport', code: 'input_stale_transport' },
    });
  });
});
