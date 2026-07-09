import { WebSocket } from 'ws';
import type { ServerMessage } from '../lib/types';
import { detachMirrorSubscriber } from './mirror-lifecycle';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type {
  TerminalSession,
  SessionMirror,
  TerminalAttachPayload,
  TerminalGeometry,
  TerminalTransportConnection,
  TerminalSessionTransport,
  TmuxPaneMetrics,
} from './terminal-runtime-types';

interface TerminalRuntimeDeps {
  defaultSessionName: string;
  defaultViewport: { cols: number; rows: number };
  sessions: Map<string, TerminalSession>;
  mirrors: Map<string, SessionMirror>;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  sendText: (transport: TerminalSessionTransport | null | undefined, text: string) => void;
  sendScheduleStateToSession: (session: TerminalSession, sessionName?: string) => void;
  buildConnectedPayload: (
    sessionId: string,
    requestOrigin?: string,
  ) => Extract<ServerMessage, { type: 'connected' }>['payload'];
  buildBufferHeadPayload: (
    sessionId: string,
    mirror: SessionMirror,
  ) => Extract<ServerMessage, { type: 'buffer-head' }>['payload'];
  buildChangedRangesBufferSyncPayload: (
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
  ) => Extract<ServerMessage, { type: 'buffer-sync' }>['payload'] | null;
  sanitizeSessionName: (input?: string) => string;
  getMirrorKey: (sessionName: string) => string;
  normalizeTerminalCols: (cols: number | undefined) => number;
  normalizeTerminalRows: (rows: number | undefined) => number;
  resolveAttachGeometry: (options: {
    requestedGeometry: TerminalGeometry | null;
    currentMirrorGeometry: TerminalGeometry | null;
    existingTmuxGeometry: TerminalGeometry | null;
    previousSessionGeometry: TerminalGeometry;
  }) => TerminalGeometry;
  readTmuxPaneMetrics: (sessionName: string) => TmuxPaneMetrics;
  assertTmuxSessionExists: (sessionName: string) => void;
  captureMirrorAuthoritativeBufferFromTmux: (mirror: SessionMirror) => Promise<boolean>;
  mirrorBufferChanged: (
    mirror: SessionMirror,
    previousStartIndex: number,
    previousLines: import('../lib/types').TerminalCell[][],
  ) => Array<{ startIndex: number; endIndex: number }>;
  mirrorCursorEqual: (
    left: import('../lib/types').TerminalCursorState | null | undefined,
    right: import('../lib/types').TerminalCursorState | null | undefined,
  ) => boolean;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  enqueueLiveMirrorInput: (
    sessionName: string,
    payload: string,
    appendEnter: boolean,
    shouldWrite?: () => boolean,
  ) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  autoCommandDelayMs: number;
  waitMs: (delayMs: number) => Promise<void>;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  daemonRuntimeDebug: (scope: string, payload?: unknown) => void;
  logTimePrefix: () => string;
}

export interface TerminalRuntime {
  sessions: () => Map<string, TerminalSession>;
  mirrors: () => Map<string, SessionMirror>;
  getSession: (sessionId: string) => TerminalSession | null;
  getMirrorByKey: (mirrorKey: string) => SessionMirror | null;
  createMirror: (sessionName: string) => SessionMirror;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
  createTransportBoundSession: (connection: TerminalTransportConnection) => TerminalSession;
  bindConnectionToSession: (connection: TerminalTransportConnection, session: TerminalSession) => TerminalSession;
  detachSessionTransportOnly: (session: TerminalSession, reason: string, transportId?: string) => void;
  closeSession: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeTransportSubscribers?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
  ensureSessionReady: (session: TerminalSession, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (session: TerminalSession, mirror: SessionMirror) => void;
  refreshMirrorHeadForSession: (session: TerminalSession, mirror: SessionMirror) => Promise<boolean>;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: { forceRevision?: boolean }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (session: TerminalSession, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize: (
    session: TerminalSession,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready'; message: string };
  handleInput: (session: TerminalSession, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
}

export {
  type TerminalSession,
  type SessionMirror,
  type TerminalAttachPayload,
  type TerminalGeometry,
  type TerminalTransportConnection,
  type TmuxPaneMetrics,
} from './terminal-runtime-types';
export { type TerminalSessionTransport, type PendingBinaryTransfer } from './terminal-runtime-types';

export function createTerminalRuntime(deps: TerminalRuntimeDeps): TerminalRuntime {
  const sessions = deps.sessions;
  const mirrors = deps.mirrors;

  function createTransportBoundSession(connection: TerminalTransportConnection): TerminalSession {
    connection.transport.requestOrigin = connection.requestOrigin;
    connection.transport.connectedSent = false;
    const session: TerminalSession = {
      id: connection.transportId,
      transportId: connection.transportId,
      transport: connection.transport,
      closeTransport: connection.closeTransport,
      sessionName: deps.defaultSessionName,
      mirrorKey: null,
      pendingPasteImage: null,
      pendingAttachFile: null,
    };
    sessions.set(session.id, session);
    connection.role = 'session';
    connection.boundSessionId = session.id;
    return session;
  }

  function getSession(sessionId: string) {
    return sessions.get(sessionId) || null;
  }

  function getMirrorByKey(mirrorKey: string) {
    return mirrors.get(mirrorKey) || null;
  }

  function getSessionMirror(session: TerminalSession) {
    if (!session.mirrorKey) {
      return null;
    }
    return mirrors.get(session.mirrorKey) || null;
  }

  function bindConnectionToSession(
    connection: TerminalTransportConnection,
    session: TerminalSession,
  ) {
    session.id = connection.transportId;
    session.transportId = connection.transportId;
    session.transport = connection.transport;
    session.closeTransport = connection.closeTransport;
    connection.transport.requestOrigin = connection.requestOrigin;
    connection.transport.connectedSent = false;
    connection.role = 'session';
    connection.boundSessionId = session.id;
    const mirror = getSessionMirror(session);
    if (mirror?.lifecycle === 'ready') {
      mirrorRuntime.scheduleMirrorLiveSync(mirror, 0);
    }
    return session;
  }

  function detachSessionTransportOnly(session: TerminalSession, reason: string, transportId?: string) {
    const current = sessions.get(session.id);
    if (!current || current !== session) {
      return;
    }
    if (transportId && session.transportId !== transportId) {
      return;
    }
    session.transport = null;
    session.closeTransport = undefined;
    session.pendingPasteImage = null;
    session.pendingAttachFile = null;
    deps.daemonRuntimeDebug('transport-detached', {
      sessionId: session.id,
      sessionName: session.sessionName,
      type: 'closed',
      payload: { reason },
    });
    const mirror = getSessionMirror(session);
    if (mirror) {
      const detachResult = detachMirrorSubscriber(mirror.subscribers, session.id);
      mirror.subscribers = detachResult.nextSubscribers;
      // R3: this transport is going away, so any pending input items for its
      // mirror must NOT survive into a future attach. We deliberately drop
      // the in-queue items here; in-flight tmux spawn (if any) resolves
      // naturally because shouldWrite() will return false on the next check.
      deps.disposeLiveMirrorInputBatch(mirror.sessionName, `detach:${reason}`);
      // R10: do not force a 0-delay capture after detach. If peers are still
      // attached, their own live sync loop will catch the new mirror state.
      // Forcing immediate capture here caused tmux to thrash on every
      // tab switch / reconnect.
      if (mirror.subscribers.size > 0) {
        mirrorRuntime.scheduleMirrorLiveSync(mirror);
      }
    }
    session.mirrorKey = null;
    sessions.delete(session.id);
  }

  function closeSession(session: TerminalSession, reason: string, notifyClient = false) {
    const current = sessions.get(session.id);
    if (!current || current !== session) {
      return;
    }
    const mirror = getSessionMirror(session);
    if (mirror) {
      const detachResult = detachMirrorSubscriber(mirror.subscribers, session.id);
      mirror.subscribers = detachResult.nextSubscribers;
      // R3: drop the input queue for this mirror before the session is gone.
      deps.disposeLiveMirrorInputBatch(mirror.sessionName, `close:${reason}`);
      // R10: do not force a 0-delay capture after close. If peers are still
      // attached, their own live sync loop will catch the new mirror state.
      if (mirror.subscribers.size > 0) {
        mirrorRuntime.scheduleMirrorLiveSync(mirror);
      }
    }

    if (notifyClient) {
      deps.sendMessage(session, { type: 'closed', payload: { reason } });
    }

    if (session.transport && session.transport.readyState < WebSocket.CLOSING) {
      try {
        session.transport.close(reason);
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to close client transport for ${session.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    session.transport = null;
    session.closeTransport = undefined;
    session.pendingPasteImage = null;
    session.pendingAttachFile = null;
    session.mirrorKey = null;
    sessions.delete(session.id);
  }

  const mirrorRuntime = createTerminalMirrorRuntime({
    defaultViewport: deps.defaultViewport,
    sessions,
    mirrors,
  sendMessage: deps.sendMessage,
  sendText: deps.sendText,
  sendScheduleStateToSession: deps.sendScheduleStateToSession,
    buildConnectedPayload: deps.buildConnectedPayload,
    buildBufferHeadPayload: deps.buildBufferHeadPayload,
    buildChangedRangesBufferSyncPayload: deps.buildChangedRangesBufferSyncPayload,
    sanitizeSessionName: deps.sanitizeSessionName,
    getMirrorKey: deps.getMirrorKey,
    normalizeTerminalCols: deps.normalizeTerminalCols,
    normalizeTerminalRows: deps.normalizeTerminalRows,
    resolveAttachGeometry: deps.resolveAttachGeometry,
    readTmuxPaneMetrics: deps.readTmuxPaneMetrics,
    assertTmuxSessionExists: deps.assertTmuxSessionExists,
    captureMirrorAuthoritativeBufferFromTmux: deps.captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: deps.mirrorBufferChanged,
    mirrorCursorEqual: deps.mirrorCursorEqual,
    writeToLiveMirror: deps.writeToLiveMirror,
    enqueueLiveMirrorInput: deps.enqueueLiveMirrorInput,
    disposeLiveMirrorInputBatch: deps.disposeLiveMirrorInputBatch,
    writeToTmuxSession: deps.writeToTmuxSession,
    autoCommandDelayMs: deps.autoCommandDelayMs,
    waitMs: deps.waitMs,
    logTimePrefix: deps.logTimePrefix,
    runTmux: deps.runTmux,
    closeTransportSubscriber: closeSession,
    getSessionMirror,
  });

  return {
    sessions: () => sessions,
    mirrors: () => mirrors,
    getSession,
    getMirrorByKey,
    createMirror: mirrorRuntime.createMirror,
    getSessionMirror,
    createTransportBoundSession,
    bindConnectionToSession,
    detachSessionTransportOnly,
    closeSession,
    destroyMirror: mirrorRuntime.destroyMirror,
    disposeLiveMirrorInputBatch: (sessionName, reason) =>
      mirrorRuntime.disposeLiveMirrorInputBatch(sessionName, reason),
    ensureSessionReady: mirrorRuntime.ensureSessionReady,
    sendBufferHeadToSession: mirrorRuntime.sendBufferHeadToSession,
    refreshMirrorHeadForSession: mirrorRuntime.refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer: mirrorRuntime.syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync: mirrorRuntime.scheduleMirrorLiveSync,
    startMirror: mirrorRuntime.startMirror,
    attachTmux: mirrorRuntime.attachTmux,
    handleAdaptiveResize: mirrorRuntime.handleAdaptiveResize,
    handleInput: mirrorRuntime.handleInput,
  };
}
