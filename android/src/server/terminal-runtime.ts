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
  TmuxPaneMetrics,
} from './terminal-runtime-types';

interface TerminalRuntimeDeps {
  defaultSessionName: string;
  defaultViewport: { cols: number; rows: number };
  sessions: Map<string, TerminalSession>;
  mirrors: Map<string, SessionMirror>;
  sendMessage: (session: TerminalSession, message: ServerMessage) => void;
  sendScheduleStateToSession: (session: TerminalSession, sessionName?: string) => void;
  buildConnectedPayload: (
    sessionId: string,
    requestOrigin?: string,
  ) => Extract<ServerMessage, { type: 'connected' }>['payload'];
  buildBufferHeadPayload: (
    sessionId: string,
    mirror: SessionMirror,
  ) => Extract<ServerMessage, { type: 'buffer-head' }>['payload'];
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
  ensureTmuxSession: (sessionName: string, cols: number, rows: number) => void;
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
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  autoCommandDelayMs: number;
  waitMs: (delayMs: number) => Promise<void>;
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
    options?: { closeLogicalSessions?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  ensureSessionReady: (session: TerminalSession, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (session: TerminalSession, mirror: SessionMirror) => void;
  refreshMirrorHeadForSession: (session: TerminalSession, mirror: SessionMirror) => Promise<boolean>;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: { forceRevision?: boolean }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (session: TerminalSession, payload: TerminalAttachPayload) => Promise<void>;
  handleInput: (session: TerminalSession, data: string) => void;
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
    sendScheduleStateToSession: deps.sendScheduleStateToSession,
    buildConnectedPayload: deps.buildConnectedPayload,
    buildBufferHeadPayload: deps.buildBufferHeadPayload,
    sanitizeSessionName: deps.sanitizeSessionName,
    getMirrorKey: deps.getMirrorKey,
    normalizeTerminalCols: deps.normalizeTerminalCols,
    normalizeTerminalRows: deps.normalizeTerminalRows,
    resolveAttachGeometry: deps.resolveAttachGeometry,
    readTmuxPaneMetrics: deps.readTmuxPaneMetrics,
    ensureTmuxSession: deps.ensureTmuxSession,
    captureMirrorAuthoritativeBufferFromTmux: deps.captureMirrorAuthoritativeBufferFromTmux,
    mirrorBufferChanged: deps.mirrorBufferChanged,
    mirrorCursorEqual: deps.mirrorCursorEqual,
    writeToLiveMirror: deps.writeToLiveMirror,
    writeToTmuxSession: deps.writeToTmuxSession,
    autoCommandDelayMs: deps.autoCommandDelayMs,
    waitMs: deps.waitMs,
    logTimePrefix: deps.logTimePrefix,
    closeLogicalTerminalSession: closeSession,
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
    ensureSessionReady: mirrorRuntime.ensureSessionReady,
    sendBufferHeadToSession: mirrorRuntime.sendBufferHeadToSession,
    refreshMirrorHeadForSession: mirrorRuntime.refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer: mirrorRuntime.syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync: mirrorRuntime.scheduleMirrorLiveSync,
    startMirror: mirrorRuntime.startMirror,
    attachTmux: mirrorRuntime.attachTmux,
    handleInput: mirrorRuntime.handleInput,
  };
}
