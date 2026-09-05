import { WebSocket } from 'ws';
import { detachMirrorSubscriber } from './mirror-lifecycle';
import { createTerminalMirrorRuntime, type TerminalMirrorRuntimeDeps } from './terminal-mirror-runtime';
import type {
  TerminalTransportSubscriber,
  SessionMirror,
  TerminalAttachPayload,
  TerminalTransportConnection,
} from './terminal-runtime-types';

// Single deps truth: mirror runtime owns the field list; this runtime only adds
// what the subscriber lifecycle itself needs. closeTransportSubscriber /
// getSessionMirror are provided internally when wiring the mirror runtime.
type TerminalRuntimeDeps = Omit<
  TerminalMirrorRuntimeDeps,
  'closeTransportSubscriber' | 'getSessionMirror'
> & {
  defaultSessionName: string;
  daemonRuntimeDebug: (scope: string, payload?: unknown) => void;
};

export interface TerminalRuntime {
  sessions: () => Map<string, TerminalTransportSubscriber>;
  mirrors: () => Map<string, SessionMirror>;
  getTransportSubscriber: (subscriberId: string) => TerminalTransportSubscriber | null;
  getMirrorByKey: (mirrorKey: string) => SessionMirror | null;
  createMirror: (sessionName: string, backend?: 'tmux' | 'herdr') => SessionMirror;
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
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string, backend?: 'tmux' | 'herdr') => number;
  ensureSessionReady: (subscriber: TerminalTransportSubscriber, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (subscriber: TerminalTransportSubscriber, mirror: SessionMirror) => void;
  refreshMirrorHeadForSession: (subscriber: TerminalTransportSubscriber, mirror: SessionMirror) => Promise<boolean>;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: { forceRevision?: boolean }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (subscriber: TerminalTransportSubscriber, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize: (
    subscriber: TerminalTransportSubscriber,
    payload: { cols?: number; rows?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string };
  restorePersistedAdaptiveWidthBaselines: (sessionNames: string[]) => number;
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
      connectedSent: false,
      muxChannelId: null,
      muxParentTransportId: null,
      sessionName: deps.defaultSessionName,
      backend: 'tmux',
      mirrorKey: null,
      bodySubscribed: true,
      adaptiveWidthCols: null,
      adaptiveWidthRows: null,
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
    subscriber.connectedSent = false;
    subscriber.muxChannelId = null;
    subscriber.muxParentTransportId = null;
    subscriber.bodySubscribed = true;
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
      // The input batch is mirror-scoped and may contain queued writes from
      // parallel subscribers. This transport going away must not evict their
      // items; stale items are filtered by their shouldWrite() guard during
      // flush, and mirror destroy is the owner that evicts the whole batch.
      // R10: do not force a 0-delay capture after detach. If peers are still
      // attached, their own live sync loop will catch the new mirror state.
      // Forcing immediate capture here caused tmux to thrash on every
      // tab switch / reconnect.
      if (mirror.subscribers.size > 0) {
        mirrorRuntime.scheduleMirrorLiveSync(mirror);
      } else {
        mirrorRuntime.destroyMirrorIfUnsubscribed(mirror, `transport detached: ${reason}`);
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
      // See detachSubscriberTransportOnly: mirror-scoped input must survive a
      // single subscriber close while peers remain. destroyMirror owns the
      // actual batch eviction when the mirror truth goes away.
      // R10: do not force a 0-delay capture after close. If peers are still
      // attached, their own live sync loop will catch the new mirror state.
      if (mirror.subscribers.size > 0) {
        mirrorRuntime.scheduleMirrorLiveSync(mirror);
      } else {
        mirrorRuntime.destroyMirrorIfUnsubscribed(mirror, `subscriber closed: ${reason}`);
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

  const { defaultSessionName: _defaultSessionName, daemonRuntimeDebug: _debug, ...mirrorDeps } = deps;
  const mirrorRuntime = createTerminalMirrorRuntime({
    ...mirrorDeps,
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
    disposeLiveMirrorInputBatch: (sessionName, reason, backend) =>
      mirrorRuntime.disposeLiveMirrorInputBatch(sessionName, reason, backend),
    ensureSessionReady: mirrorRuntime.ensureSessionReady,
    sendBufferHeadToSession: mirrorRuntime.sendBufferHeadToSession,
    refreshMirrorHeadForSession: mirrorRuntime.refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer: mirrorRuntime.syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync: mirrorRuntime.scheduleMirrorLiveSync,
    startMirror: mirrorRuntime.startMirror,
    attachTmux: mirrorRuntime.attachTmux,
    handleAdaptiveResize: mirrorRuntime.handleAdaptiveResize,
    restorePersistedAdaptiveWidthBaselines: mirrorRuntime.restorePersistedAdaptiveWidthBaselines,
    refreshAdaptiveWidthLeaseHeartbeat: mirrorRuntime.refreshAdaptiveWidthLeaseHeartbeat,
    handleInput: mirrorRuntime.handleInput,
  };
}
