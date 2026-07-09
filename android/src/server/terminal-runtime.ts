import { WebSocket } from 'ws';
import type { ServerMessage } from '../lib/types';
import { detachMirrorSubscriber } from './mirror-lifecycle';
import { createTerminalMirrorRuntime } from './terminal-mirror-runtime';
import type {
  TerminalTransportSubscriber,
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
  sessions: Map<string, TerminalTransportSubscriber>;
  mirrors: Map<string, SessionMirror>;
  sendMessage: (session: TerminalTransportSubscriber, message: ServerMessage) => void;
  sendText: (transport: TerminalSessionTransport | null | undefined, text: string) => void;
  sendScheduleStateToSession: (session: TerminalTransportSubscriber, sessionName?: string) => void;
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
  sessions: () => Map<string, TerminalTransportSubscriber>;
  mirrors: () => Map<string, SessionMirror>;
  getTransportSubscriber: (subscriberId: string) => TerminalTransportSubscriber | null;
  getMirrorByKey: (mirrorKey: string) => SessionMirror | null;
  createMirror: (sessionName: string) => SessionMirror;
  getSubscriberMirror: (subscriber: TerminalTransportSubscriber) => SessionMirror | null;
  createTransportSubscriber: (connection: TerminalTransportConnection) => TerminalTransportSubscriber;
  bindConnectionToSubscriber: (
    connection: TerminalTransportConnection,
    subscriber: TerminalTransportSubscriber,
  ) => TerminalTransportSubscriber;
  detachSubscriberTransportOnly: (subscriber: TerminalTransportSubscriber, reason: string, transportId?: string) => void;
  closeTransportSubscriber: (subscriber: TerminalTransportSubscriber, reason: string, notifyClient?: boolean) => void;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeTransportSubscribers?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
  ensureSessionReady: (subscriber: TerminalTransportSubscriber, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (subscriber: TerminalTransportSubscriber, mirror: SessionMirror) => void;
  refreshMirrorHeadForSession: (subscriber: TerminalTransportSubscriber, mirror: SessionMirror) => Promise<boolean>;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: { forceRevision?: boolean }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (subscriber: TerminalTransportSubscriber, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize: (
    subscriber: TerminalTransportSubscriber,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready'; message: string };
  refreshAdaptiveWidthLeaseHeartbeat: (subscriber: TerminalTransportSubscriber) => void;
  handleInput: (subscriber: TerminalTransportSubscriber, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
}

export {
  type TerminalTransportSubscriber,
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

  function createTransportSubscriber(connection: TerminalTransportConnection): TerminalTransportSubscriber {
    connection.transport.requestOrigin = connection.requestOrigin;
    connection.transport.connectedSent = false;
    const subscriber: TerminalTransportSubscriber = {
      id: connection.transportId,
      transportId: connection.transportId,
      transport: connection.transport,
      closeTransport: connection.closeTransport,
      sessionName: deps.defaultSessionName,
      mirrorKey: null,
      adaptiveWidthCols: null,
      adaptiveWidthHeartbeatAt: 0,
      pendingPasteImage: null,
      pendingAttachFile: null,
    };
    sessions.set(subscriber.id, subscriber);
    connection.role = 'session';
    connection.boundSubscriberId = subscriber.id;
    return subscriber;
  }

  function getTransportSubscriber(subscriberId: string) {
    return sessions.get(subscriberId) || null;
  }

  function getMirrorByKey(mirrorKey: string) {
    return mirrors.get(mirrorKey) || null;
  }

  function getSubscriberMirror(subscriber: TerminalTransportSubscriber) {
    if (!subscriber.mirrorKey) {
      return null;
    }
    return mirrors.get(subscriber.mirrorKey) || null;
  }

  function bindConnectionToSubscriber(
    connection: TerminalTransportConnection,
    subscriber: TerminalTransportSubscriber,
  ) {
    subscriber.id = connection.transportId;
    subscriber.transportId = connection.transportId;
    subscriber.transport = connection.transport;
    subscriber.closeTransport = connection.closeTransport;
    connection.transport.requestOrigin = connection.requestOrigin;
    connection.transport.connectedSent = false;
    connection.role = 'session';
    connection.boundSubscriberId = subscriber.id;
    const mirror = getSubscriberMirror(subscriber);
    if (mirror?.lifecycle === 'ready') {
      mirrorRuntime.scheduleMirrorLiveSync(mirror, 0);
    }
    return subscriber;
  }

  function detachSubscriberTransportOnly(subscriber: TerminalTransportSubscriber, reason: string, transportId?: string) {
    const current = sessions.get(subscriber.id);
    if (!current || current !== subscriber) {
      return;
    }
    if (transportId && subscriber.transportId !== transportId) {
      return;
    }
    subscriber.transport = null;
    subscriber.closeTransport = undefined;
    subscriber.pendingPasteImage = null;
    subscriber.pendingAttachFile = null;
    deps.daemonRuntimeDebug('transport-detached', {
      sessionId: subscriber.id,
      sessionName: subscriber.sessionName,
      type: 'closed',
      payload: { reason },
    });
    const mirror = getSubscriberMirror(subscriber);
    if (mirror) {
      mirrorRuntime.releaseAdaptiveWidthLease(subscriber, `detach:${reason}`);
      const detachResult = detachMirrorSubscriber(mirror.subscribers, subscriber.id);
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
    subscriber.mirrorKey = null;
    sessions.delete(subscriber.id);
  }

  function closeTransportSubscriber(subscriber: TerminalTransportSubscriber, reason: string, notifyClient = false) {
    const current = sessions.get(subscriber.id);
    if (!current || current !== subscriber) {
      return;
    }
    const mirror = getSubscriberMirror(subscriber);
    if (mirror) {
      mirrorRuntime.releaseAdaptiveWidthLease(subscriber, `close:${reason}`);
      const detachResult = detachMirrorSubscriber(mirror.subscribers, subscriber.id);
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
      deps.sendMessage(subscriber, { type: 'closed', payload: { reason } });
    }

    if (subscriber.transport && subscriber.transport.readyState < WebSocket.CLOSING) {
      try {
        subscriber.transport.close(reason);
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to close transport subscriber ${subscriber.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    subscriber.transport = null;
    subscriber.closeTransport = undefined;
    subscriber.pendingPasteImage = null;
    subscriber.pendingAttachFile = null;
    subscriber.mirrorKey = null;
    sessions.delete(subscriber.id);
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
    closeTransportSubscriber,
    getSessionMirror: getSubscriberMirror,
  });

  return {
    sessions: () => sessions,
    mirrors: () => mirrors,
    getTransportSubscriber,
    getMirrorByKey,
    createMirror: mirrorRuntime.createMirror,
    getSubscriberMirror,
    createTransportSubscriber,
    bindConnectionToSubscriber,
    detachSubscriberTransportOnly,
    closeTransportSubscriber,
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
    refreshAdaptiveWidthLeaseHeartbeat: mirrorRuntime.refreshAdaptiveWidthLeaseHeartbeat,
    handleInput: mirrorRuntime.handleInput,
  };
}
