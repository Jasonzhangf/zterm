import type {
  ServerMessage,
  TerminalCell,
  TerminalCursorState,
} from '../lib/types';
import { summarizeIndexedLinesForDebug } from '../lib/terminal-buffer-debug';
import { sliceIndexedLines } from './canonical-buffer';
import { detachMirrorSubscriber, releaseMirrorSubscribers } from './mirror-lifecycle';
import type {
  TerminalSession,
  SessionMirror,
  TerminalAttachPayload,
  TerminalGeometry,
  TmuxPaneMetrics,
} from './terminal-runtime-types';

export interface TerminalMirrorRuntimeDeps {
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
  ensureTmuxSession: (sessionName: string, cols: number, rows: number) => void;
  captureMirrorAuthoritativeBufferFromTmux: (mirror: SessionMirror) => Promise<boolean>;
  mirrorBufferChanged: (
    mirror: SessionMirror,
    previousStartIndex: number,
    previousLines: TerminalCell[][],
  ) => Array<{ startIndex: number; endIndex: number }>;
  mirrorCursorEqual: (
    left: TerminalCursorState | null | undefined,
    right: TerminalCursorState | null | undefined,
  ) => boolean;
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean) => boolean;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean) => void;
  autoCommandDelayMs: number;
  waitMs: (delayMs: number) => Promise<void>;
  logTimePrefix: () => string;
  closeLogicalTerminalSession: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
}

export interface TerminalMirrorRuntime {
  createMirror: (sessionName: string) => SessionMirror;
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

const MIRROR_LIVE_SYNC_INTERVAL_MS = 33;

export function createTerminalMirrorRuntime(deps: TerminalMirrorRuntimeDeps): TerminalMirrorRuntime {
  const sessions = deps.sessions;
  const mirrors = deps.mirrors;

  function stopMirrorLiveSync(mirror: SessionMirror) {
    if (mirror.liveSyncTimer) {
      clearTimeout(mirror.liveSyncTimer);
      mirror.liveSyncTimer = null;
    }
  }

  function createMirror(sessionName: string): SessionMirror {
    const mirror: SessionMirror = {
      key: sessionName,
      sessionName,
      scratchBridge: null,
      lifecycle: 'idle',
      cols: deps.defaultViewport.cols,
      rows: deps.defaultViewport.rows,
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
      pendingStableCaptureSnapshot: null,
      liveSyncTimer: null,
      subscribers: new Set(),
    };
    mirrors.set(sessionName, mirror);
    return mirror;
  }

  function releaseMirrorForSubscribers(
    mirror: SessionMirror,
    reason: string,
    code = 'tmux_session_unavailable',
  ) {
    const releasedSessionIds = releaseMirrorSubscribers(sessions, mirror.subscribers);
    for (const sessionId of releasedSessionIds) {
      const client = sessions.get(sessionId);
      if (!client) {
        continue;
      }
      client.pendingPasteImage = null;
      client.pendingAttachFile = null;
      deps.sendMessage(client, { type: 'error', payload: { message: reason, code } });
    }
  }

  function destroyMirror(
    mirror: SessionMirror,
    reason: string,
    options?: {
      closeLogicalSessions?: boolean;
      notifyClientClose?: boolean;
      releaseCode?: string;
    },
  ) {
    if (mirror.lifecycle === 'destroyed') {
      return;
    }

    mirror.lifecycle = 'destroyed';

    if (options?.closeLogicalSessions) {
      const subscriberIds = Array.from(mirror.subscribers);
      for (const sessionId of subscriberIds) {
        const client = sessions.get(sessionId);
        if (!client) {
          continue;
        }
        deps.closeLogicalTerminalSession(client, reason, Boolean(options.notifyClientClose));
      }
    } else {
      releaseMirrorForSubscribers(mirror, reason, options?.releaseCode || 'tmux_session_unavailable');
    }
    mirror.subscribers.clear();
    mirror.scratchBridge = null;
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    mirror.lastFlushStartedAt = 0;
    mirror.lastFlushCompletedAt = 0;
    mirror.lastScrollbackCount = -1;
    mirror.flushInFlight = false;
    mirror.flushPromise = null;
    mirror.pendingStableCaptureSnapshot = null;
    stopMirrorLiveSync(mirror);
    mirrors.delete(mirror.key);
  }

  function ensureSessionReady(session: TerminalSession, mirror: SessionMirror) {
    session.sessionName = mirror.sessionName;
    if (!session.transport || session.transport.connectedSent) {
      return;
    }
    session.transport.connectedSent = true;
    deps.sendMessage(session, {
      type: 'connected',
      payload: deps.buildConnectedPayload(session.id, session.transport.requestOrigin),
    });
    deps.sendScheduleStateToSession(session, mirror.sessionName);
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });
  }

  function announceMirrorSubscribersReady(mirror: SessionMirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      ensureSessionReady(session, mirror);
    }
  }

  function broadcastBufferHeadToSubscribers(mirror: SessionMirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || !session.transport || session.transport.readyState !== 1) {
        continue;
      }
      ensureSessionReady(session, mirror);
      deps.sendMessage(session, {
        type: 'buffer-head',
        payload: deps.buildBufferHeadPayload(session.id, mirror),
      });
    }
  }

  function broadcastChangedRangesBufferSyncToSubscribers(
    mirror: SessionMirror,
    changedRanges: Array<{ startIndex: number; endIndex: number }>,
  ) {
    const payload = deps.buildChangedRangesBufferSyncPayload(mirror, changedRanges);
    if (!payload) {
      return;
    }
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || !session.transport || session.transport.readyState !== 1) {
        continue;
      }
      ensureSessionReady(session, mirror);
      deps.sendMessage(session, {
        type: 'buffer-sync',
        payload,
      });
    }
  }

  function sendBufferHeadToSession(session: TerminalSession, mirror: SessionMirror) {
    if (!session.transport || session.transport.readyState !== 1) {
      return;
    }
    ensureSessionReady(session, mirror);
    deps.sendMessage(session, {
      type: 'buffer-head',
      payload: deps.buildBufferHeadPayload(session.id, mirror),
    });
  }

  async function refreshMirrorHeadForSession(session: TerminalSession, mirror: SessionMirror) {
    if (mirror.lifecycle !== 'ready') {
      return false;
    }
    const captured = await syncMirrorCanonicalBuffer(mirror);
    if (!captured) {
      return false;
    }
    sendBufferHeadToSession(session, mirror);
    return true;
  }

  async function syncMirrorCanonicalBuffer(
    mirror: SessionMirror,
    options?: { forceRevision?: boolean },
  ) {
    if (mirror.lifecycle !== 'ready') {
      return false;
    }
    if (mirror.flushPromise) {
      return mirror.flushPromise;
    }

    const previousStartIndex = mirror.bufferStartIndex;
    const previousLines = mirror.bufferLines.slice();
    const previousCursor = mirror.cursor ? { ...mirror.cursor } : null;
    const previousCursorKeysApp = mirror.cursorKeysApp;
    const forceRevision = Boolean(options?.forceRevision);

    mirror.lastFlushStartedAt = Date.now();
    mirror.flushInFlight = true;
    const capturePromise = deps.captureMirrorAuthoritativeBufferFromTmux(mirror)
      .then((captured) => {
        if (!captured) {
          throw new Error('tmux capture returned no canonical buffer');
        }
        const changedRanges = deps.mirrorBufferChanged(mirror, previousStartIndex, previousLines);
        const cursorChanged = !deps.mirrorCursorEqual(previousCursor, mirror.cursor);
        const cursorKeysAppChanged = previousCursorKeysApp !== mirror.cursorKeysApp;
        if (forceRevision || changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged) {
          mirror.revision += 1;
        }
        if (changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged || forceRevision) {
          const firstRange = changedRanges[0] || null;
          const lastRange = changedRanges[changedRanges.length - 1] || null;
          console.debug(`[${deps.logTimePrefix()}] mirror.flush.inspect`, {
            sessionName: mirror.sessionName,
            revision: mirror.revision,
            previousStartIndex,
            previousEndIndex: previousStartIndex + previousLines.length,
            nextStartIndex: mirror.bufferStartIndex,
            nextEndIndex: mirror.bufferStartIndex + mirror.bufferLines.length,
            changedRangeCount: changedRanges.length,
            firstChangedRange: firstRange,
            lastChangedRange: lastRange,
            cursorChanged,
            cursorKeysAppChanged,
            forceRevision,
            changedLinePreview: firstRange
              ? summarizeIndexedLinesForDebug(
                  sliceIndexedLines(
                    mirror.bufferStartIndex,
                    mirror.bufferLines,
                    firstRange.startIndex,
                    Math.min(firstRange.endIndex, firstRange.startIndex + 6),
                  ),
                )
              : [],
          });
        }
        if (changedRanges.length > 0 || forceRevision) {
          broadcastChangedRangesBufferSyncToSubscribers(
            mirror,
            forceRevision
              ? [{ startIndex: mirror.bufferStartIndex, endIndex: mirror.bufferStartIndex + mirror.bufferLines.length }]
              : changedRanges,
          );
          return true;
        }
        if (cursorChanged || cursorKeysAppChanged) {
          broadcastBufferHeadToSubscribers(mirror);
        }
        return true;
      })
      .catch((error) => {
        console.error(
          `[${deps.logTimePrefix()}] canonical mirror refresh failed for ${mirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      })
      .finally(() => {
        mirror.lastFlushCompletedAt = Date.now();
        mirror.flushInFlight = false;
        mirror.flushPromise = null;
      });

    mirror.flushPromise = capturePromise;
    return capturePromise;
  }

  function scheduleMirrorLiveSync(mirror: SessionMirror, delayMs = MIRROR_LIVE_SYNC_INTERVAL_MS) {
    if (mirror.lifecycle !== 'ready') {
      return;
    }
    stopMirrorLiveSync(mirror);
    mirror.liveSyncTimer = setTimeout(() => {
      mirror.liveSyncTimer = null;
      if (mirror.lifecycle !== 'ready') {
        return;
      }
      void syncMirrorCanonicalBuffer(mirror).finally(() => {
        if (mirror.lifecycle !== 'ready' || mirror.liveSyncTimer) {
          return;
        }
        scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_INTERVAL_MS);
      });
    }, Math.max(0, delayMs));
  }

  async function startMirror(
    mirror: SessionMirror,
    options?: { cols?: number; rows?: number; autoCommand?: string },
  ) {
    if (mirror.lifecycle === 'ready' || mirror.lifecycle === 'booting') {
      return;
    }

    mirror.lifecycle = 'booting';
    mirror.lastScrollbackCount = -1;
    mirror.bufferLines = [];
    mirror.bufferStartIndex = 0;
    mirror.cursor = null;
    const targetCols = deps.normalizeTerminalCols(options?.cols ?? mirror.cols);
    const targetRows = deps.normalizeTerminalRows(options?.rows ?? mirror.rows);
    mirror.cols = targetCols;
    mirror.rows = targetRows;

    try {
      deps.ensureTmuxSession(mirror.sessionName, targetCols, targetRows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mirror.lifecycle = 'failed';
      for (const sessionId of mirror.subscribers) {
        const session = sessions.get(sessionId);
        if (!session) {
          continue;
        }
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: `Failed to start tmux session: ${message}`, code: 'tmux_start_failed' },
        });
      }
      return;
    }

    mirror.lifecycle = 'ready';

    try {
      await deps.waitMs(80);
      const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
      if (!captured) {
        throw new Error('Failed to capture canonical tmux buffer during initial sync');
      }
      announceMirrorSubscribersReady(mirror);
      scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_INTERVAL_MS);
    } catch (error) {
      mirror.lifecycle = 'failed';
      console.error(
        `[${deps.logTimePrefix()}] initial buffer sync failed for ${mirror.sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      for (const sessionId of mirror.subscribers) {
        const subscriber = sessions.get(sessionId);
        if (!subscriber) {
          continue;
        }
        deps.sendMessage(subscriber, {
          type: 'error',
          payload: {
            message: `Initial canonical sync failed: ${error instanceof Error ? error.message : String(error)}`,
            code: 'initial_buffer_sync_failed',
          },
        });
      }
    }

    if (options?.autoCommand?.trim()) {
      const command = options.autoCommand.endsWith('\r') ? options.autoCommand.slice(0, -1) : options.autoCommand;
      setTimeout(() => {
        if (mirror.lifecycle === 'ready') {
          deps.writeToTmuxSession(mirror.sessionName, command, true);
          scheduleMirrorLiveSync(mirror, 0);
        }
      }, deps.autoCommandDelayMs);
    }
  }

  async function attachTmux(session: TerminalSession, payload: TerminalAttachPayload) {
    const nextSessionName = deps.sanitizeSessionName(payload.sessionName);
    const nextMirrorKey = deps.getMirrorKey(nextSessionName);
    const existingMirror = mirrors.get(nextMirrorKey) || null;
    const existingTmuxGeometry = existingMirror
      ? null
      : (() => {
        try {
          const metrics = deps.readTmuxPaneMetrics(nextSessionName);
          return {
            cols: metrics.paneCols,
            rows: metrics.paneRows,
          };
        } catch (metricsError) {
          console.warn(
            '[server] readTmuxPaneMetrics failed:',
            metricsError instanceof Error ? metricsError.message : metricsError,
          );
          return null;
        }
      })();
    const requestedGeometry = deps.resolveAttachGeometry({
      requestedGeometry:
        typeof payload.cols === 'number'
        && Number.isFinite(payload.cols)
        && typeof payload.rows === 'number'
        && Number.isFinite(payload.rows)
          ? { cols: payload.cols, rows: payload.rows }
          : null,
      currentMirrorGeometry: existingMirror
        ? { cols: existingMirror.cols, rows: existingMirror.rows }
        : null,
      existingTmuxGeometry,
      previousSessionGeometry: deps.defaultViewport,
    });
    const requestedCols = deps.normalizeTerminalCols(requestedGeometry.cols);
    const requestedRows = deps.normalizeTerminalRows(requestedGeometry.rows);

    const previousMirror = deps.getSessionMirror(session);
    if (previousMirror) {
      const detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
      previousMirror.subscribers = detachResult.nextSubscribers;
    }

    session.sessionName = nextSessionName;
    session.mirrorKey = nextMirrorKey;
    if (session.transport) {
      session.transport.connectedSent = false;
    }

    let mirror = existingMirror;
    if (!mirror) {
      mirror = createMirror(nextSessionName);
    }
    mirror.subscribers.add(session.id);
    if (mirror.lifecycle !== 'ready') {
      mirror.cols = requestedCols;
      mirror.rows = requestedRows;
    }
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });

    if (mirror.lifecycle === 'ready') {
      ensureSessionReady(session, mirror);
      return;
    }

    await startMirror(mirror, { cols: requestedCols, rows: requestedRows, autoCommand: payload.autoCommand });
  }

  function handleInput(session: TerminalSession, data: string) {
    const mirror = deps.getSessionMirror(session);
    if (mirror?.lifecycle === 'ready') {
      deps.writeToLiveMirror(mirror.sessionName, data, false);
      scheduleMirrorLiveSync(mirror, 0);
    }
  }

  return {
    createMirror,
    destroyMirror,
    ensureSessionReady,
    sendBufferHeadToSession,
    refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync,
    startMirror,
    attachTmux,
    handleInput,
  };
}
