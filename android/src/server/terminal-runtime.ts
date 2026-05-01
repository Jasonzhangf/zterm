import { WebSocket } from 'ws';
import type { ServerMessage } from '../lib/types';
import {
  attachClientSessionTransport,
  closeClientSession as removeLogicalClientSession,
  detachClientSessionTransport as markLogicalClientSessionTransportDetached,
} from './client-session-lifecycle';
import { detachMirrorSubscriber } from './mirror-lifecycle';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type {
  ClientSession,
  SessionMirror,
  TerminalAttachPayload,
  TerminalGeometry,
  TerminalTransportConnection,
  TmuxPaneMetrics,
} from './terminal-runtime-types';

interface TerminalRuntimeDeps {
  defaultSessionName: string;
  defaultViewport: { cols: number; rows: number };
  sessions: Map<string, ClientSession>;
  mirrors: Map<string, SessionMirror>;
  revokeSessionTransportTicket: (clientSessionId: string) => void;
  sendMessage: (session: ClientSession, message: ServerMessage) => void;
  sendScheduleStateToSession: (session: ClientSession, sessionName?: string) => void;
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
  sessions: () => Map<string, ClientSession>;
  mirrors: () => Map<string, SessionMirror>;
  getSession: (sessionId: string) => ClientSession | null;
  getMirrorByKey: (mirrorKey: string) => SessionMirror | null;
  createMirror: (sessionName: string) => SessionMirror;
  getClientMirror: (session: ClientSession) => SessionMirror | null;
  getOrCreateLogicalClientSession: (clientSessionId: string, requestOrigin: string) => ClientSession;
  bindTransportConnectionToLogicalSession: (
    connection: TerminalTransportConnection,
    session: ClientSession,
  ) => ClientSession;
  detachClientSessionTransportOnly: (session: ClientSession, reason: string, transportId?: string) => void;
  closeLogicalClientSession: (session: ClientSession, reason: string, notifyClient?: boolean) => void;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeLogicalSessions?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  ensureSessionReady: (session: ClientSession, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (session: ClientSession, mirror: SessionMirror) => void;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: { forceRevision?: boolean }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (session: ClientSession, payload: TerminalAttachPayload) => Promise<void>;
  handleInput: (session: ClientSession, data: string) => void;
}

export {
  type ClientSession,
  type SessionMirror,
  type TerminalAttachPayload,
  type TerminalGeometry,
  type TerminalTransportConnection,
  type TmuxPaneMetrics,
} from './terminal-runtime-types';
export { type ClientSessionTransport, type PendingBinaryTransfer } from './terminal-runtime-types';

export function createTerminalRuntime(deps: TerminalRuntimeDeps): TerminalRuntime {
  const sessions = deps.sessions;
  const mirrors = deps.mirrors;

  function createLogicalClientSession(clientSessionId: string, requestOrigin: string): ClientSession {
    const session: ClientSession = {
      id: clientSessionId,
      clientSessionId,
      transportId: null,
      readyTransportId: null,
      transport: null,
      closeTransport: undefined,
      transportRequestOrigin: requestOrigin,
      sessionName: deps.defaultSessionName,
      mirrorKey: null,
      wsAlive: false,
      pendingPasteImage: null,
      pendingAttachFile: null,
      logicalSessionBound: true,
    };
    sessions.set(session.id, session);
    return session;
  }

  function getSession(sessionId: string) {
    return sessions.get(sessionId) || null;
  }

  function getMirrorByKey(mirrorKey: string) {
    return mirrors.get(mirrorKey) || null;
  }

  function getClientMirror(session: ClientSession) {
    if (!session.mirrorKey) {
      return null;
    }
    return mirrors.get(session.mirrorKey) || null;
  }

  function getOrCreateLogicalClientSession(clientSessionId: string, requestOrigin: string) {
    const existing = sessions.get(clientSessionId) || null;
    if (existing) {
      existing.transportRequestOrigin = requestOrigin;
      existing.logicalSessionBound = true;
      return existing;
    }
    return createLogicalClientSession(clientSessionId, requestOrigin);
  }

  function bindTransportConnectionToLogicalSession(
    connection: TerminalTransportConnection,
    session: ClientSession,
  ) {
    const replacedTransportId = attachClientSessionTransport(
      session,
      connection.transportId,
      connection.closeTransport,
    ).replacedTransportId;
    if (
      replacedTransportId
      && session.transport
      && session.transport !== connection.transport
      && session.transport.readyState < WebSocket.CLOSING
    ) {
      try {
        session.transport.close('transport replaced by reconnect');
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to close replaced transport for ${session.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    session.transport = connection.transport;
    session.transportRequestOrigin = connection.requestOrigin;
    session.wsAlive = true;
    session.logicalSessionBound = true;
    connection.role = 'session';
    connection.boundSessionId = session.id;
    return session;
  }

  function detachClientSessionTransportOnly(session: ClientSession, reason: string, transportId?: string) {
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
    session.wsAlive = false;
    markLogicalClientSessionTransportDetached(sessions, session.id);
    deps.daemonRuntimeDebug('transport-detached', {
      sessionId: session.id,
      sessionName: session.sessionName,
      type: 'closed',
      payload: { reason },
    });
  }

  function closeLogicalClientSession(session: ClientSession, reason: string, notifyClient = false) {
    const current = sessions.get(session.id);
    if (!current || current !== session) {
      return;
    }
    const mirror = getClientMirror(session);
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
    session.transportId = null;
    session.readyTransportId = null;
    session.closeTransport = undefined;
    session.wsAlive = false;
    session.pendingPasteImage = null;
    session.pendingAttachFile = null;
    session.mirrorKey = null;
    deps.revokeSessionTransportTicket(session.id);
    removeLogicalClientSession(sessions, session.id);
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
    closeLogicalClientSession,
    getClientMirror,
  });

  return {
    sessions: () => sessions,
    mirrors: () => mirrors,
    getSession,
    getMirrorByKey,
    createMirror: mirrorRuntime.createMirror,
    getClientMirror,
    getOrCreateLogicalClientSession,
    bindTransportConnectionToLogicalSession,
    detachClientSessionTransportOnly,
    closeLogicalClientSession,
    destroyMirror: mirrorRuntime.destroyMirror,
    ensureSessionReady: mirrorRuntime.ensureSessionReady,
    sendBufferHeadToSession: mirrorRuntime.sendBufferHeadToSession,
    syncMirrorCanonicalBuffer: mirrorRuntime.syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync: mirrorRuntime.scheduleMirrorLiveSync,
    startMirror: mirrorRuntime.startMirror,
    attachTmux: mirrorRuntime.attachTmux,
    handleInput: mirrorRuntime.handleInput,
  };
}
