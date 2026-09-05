import type {
  TerminalPerformanceTraceRecord,
} from '@zterm/shared/terminal/performance-trace';
import type {
  BridgeServerMessage as ServerMessage,
} from '@zterm/shared/protocol';
import type {
  TerminalCell,
  TerminalCursorState,
} from '@zterm/shared/types';
import { summarizeIndexedLinesForDebug } from '@zterm/shared/terminal-buffer';
import { sliceIndexedLines } from './canonical-buffer';
import { buildRequestedRangeBufferPayload } from './buffer-sync-contract';
import { createDaemonBufferPublisherRuntime } from './daemon-buffer-publisher-runtime';
import { detachMirrorSubscriber, releaseMirrorSubscribers } from './mirror-lifecycle';
import { resolveTerminalLiveSyncDelay } from './terminal-performance-scheduler';
import type { DaemonInputQueueRuntime } from './daemon-input-queue-runtime';
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
  sendText: (transport: import('./terminal-runtime-types').TerminalSessionTransport | null | undefined, text: string) => void;
  recordPerformanceTrace?: (record: TerminalPerformanceTraceRecord) => void;
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
  getMirrorKey: (sessionName: string, backend?: 'tmux' | 'herdr') => string;
  normalizeTerminalCols: (cols: number | undefined) => number;
  normalizeTerminalRows: (rows: number | undefined) => number;
  resolveAttachGeometry: (options: {
    requestedGeometry: TerminalGeometry | null;
    currentMirrorGeometry: TerminalGeometry | null;
    existingTmuxGeometry: TerminalGeometry | null;
    previousSessionGeometry: TerminalGeometry;
  }) => TerminalGeometry;
  readTmuxPaneMetrics: (sessionName: string, backend?: 'tmux' | 'herdr') => TmuxPaneMetrics;
  resizeBackendSession?: (sessionName: string, geometry: TerminalGeometry, backend?: 'tmux' | 'herdr') => void;
  assertTmuxSessionExists: (sessionName: string, backend?: 'tmux' | 'herdr') => void;
  resolveTerminalSessionBackend?: (sessionName: string) => 'tmux' | 'herdr';
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
  writeToLiveMirror: (sessionName: string, payload: string, appendEnter: boolean, backend?: 'tmux' | 'herdr') => boolean;
  daemonInputQueue: DaemonInputQueueRuntime;
  writeToTmuxSession: (sessionName: string, payload: string, appendEnter: boolean, backend?: 'tmux' | 'herdr') => void;
  autoCommandDelayMs: number;
  waitMs: (delayMs: number) => Promise<void>;
  logTimePrefix: () => string;
  runTmux: (args: string[]) => { ok: true; stdout: string };
  buildExactTmuxSessionTarget: (sessionName: string) => string;
  closeTransportSubscriber: (session: TerminalSession, reason: string, notifyClient?: boolean) => void;
  getSessionMirror: (session: TerminalSession) => SessionMirror | null;
}

export interface TerminalMirrorRuntime {
  createMirror: (sessionName: string) => SessionMirror;
  destroyMirror: (
    mirror: SessionMirror,
    reason: string,
    options?: { closeTransportSubscribers?: boolean; notifyClientClose?: boolean; releaseCode?: string },
  ) => void;
  destroyMirrorIfUnsubscribed: (mirror: SessionMirror, reason: string) => boolean;
  ensureSessionReady: (session: TerminalSession, mirror: SessionMirror) => void;
  sendBufferHeadToSession: (session: TerminalSession, mirror: SessionMirror) => void;
  enqueueRangeBufferSyncResponse: (
    session: TerminalSession,
    mirror: SessionMirror,
    request: import('@zterm/shared/types').BufferSyncRequestPayload,
  ) => 'queued' | 'missing-subscriber' | 'transport-not-open';
  flushPendingSubscriberBufferSync: (
    mirror: SessionMirror,
    sessionId: string,
  ) => 'sent'
    | 'no-pending'
    | 'missing-subscriber'
    | 'transport-not-open'
    | 'backpressured'
    | 'send-error'
    | 'stale-transport';
  refreshMirrorHeadForSession: (session: TerminalSession, mirror: SessionMirror) => Promise<boolean>;
  syncMirrorCanonicalBuffer: (mirror: SessionMirror, options?: {
    forceRevision?: boolean;
    requestPostFlushIfBusy?: boolean;
  }) => Promise<boolean>;
  scheduleMirrorLiveSync: (mirror: SessionMirror, delayMs?: number) => void;
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (session: TerminalSession, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize: (
    session: TerminalSession,
    payload: { cols?: number; rows?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string };
  restorePersistedAdaptiveWidthBaselines: (sessionNames: string[]) => number;
  refreshAdaptiveWidthLeaseHeartbeat: (session: TerminalSession) => void;
  releaseAdaptiveWidthLease: (session: TerminalSession, reason: string) => void;
  handleInput: (session: TerminalSession, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string, backend?: 'tmux' | 'herdr') => number;
}

const MIRROR_LIVE_SYNC_ACTIVE_MS = 33;
const MIRROR_LIVE_SYNC_IDLE_MS = 120;
// Cap for quiet-capture backoff (120 -> 240 -> 480 -> 500ms). External tmux
// writes are detected within this window while an idle terminal stops paying
// a full 1305-line capture at 30fps.
const QUIET_CAPTURE_MAX_DELAY_MS = 500;
const ADAPTIVE_WIDTH_LEASE_TTL_MS = 65000;

export function createTerminalMirrorRuntime(deps: TerminalMirrorRuntimeDeps): TerminalMirrorRuntime {
  const sessions = deps.sessions;
  const mirrors = deps.mirrors;
  const pendingPostFlushImmediateSyncMirrors = new WeakSet<SessionMirror>();

  function isTmuxSessionUnavailableError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /no server running|can(?:'t| not) find session|no such session|session .*not found|wezterm session not found/i.test(message);
  }

  function writeMirrorBaselineGeometry(mirror: SessionMirror, geometry: { cols: number; rows: number }) {
    mirror.baselineCols = deps.normalizeTerminalCols(geometry.cols);
    mirror.baselineRows = deps.normalizeTerminalRows(geometry.rows);
  }

  function stopMirrorLiveSync(mirror: SessionMirror) {
    if (mirror.liveSyncTimer) {
      clearTimeout(mirror.liveSyncTimer);
      mirror.liveSyncTimer = null;
    }
  }

  function resolveMirrorLiveSyncDelay(mirror: SessionMirror, requestedDelayMs?: number) {
    const now = Date.now();
    return resolveTerminalLiveSyncDelay({
      requestedDelayMs,
      activeDelayMs: MIRROR_LIVE_SYNC_ACTIVE_MS,
      idleDelayMs: MIRROR_LIVE_SYNC_IDLE_MS,
      now,
      lastLiveActivityAt: mirror.lastLiveActivityAt || 0,
      consecutiveFailures: mirror.consecutiveFailures,
      subscriberCount: countReadyBodySubscribedSubscribers(mirror),
      // Backpressure is handled per-subscriber in broadcastChangedRangesBufferSyncToSubscribers.
      // Mirror-level capture cadence must not be dragged down by a single slow subscriber.
      lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
      lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
      flushInFlight: mirror.flushInFlight,
    }).delayMs;
  }

  function countReadyBodySubscribedSubscribers(mirror: SessionMirror) {
    let count = 0;
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || session.bodySubscribed === false) {
        continue;
      }
      if (!session.transport || session.transport.readyState !== 1) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  function createMirror(sessionName: string, backend: 'tmux' | 'herdr' = 'tmux'): SessionMirror {
    const mirror: SessionMirror = {
      key: deps.getMirrorKey(sessionName, backend),
      sessionName,
      backend,
      scratchBridge: null,
      lifecycle: 'idle',
      cols: deps.defaultViewport.cols,
      rows: deps.defaultViewport.rows,
      baselineCols: deps.defaultViewport.cols,
      baselineRows: deps.defaultViewport.rows,
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
      lastCaptureDurationMs: 0,
      lastCanonicalizeDurationMs: 0,
      flushInFlight: false,
      flushPromise: null,
      quietFlushStreak: 0,
      lastFlushHadContentChanges: false,
      pendingStableCaptureSnapshot: null,
      pendingPerformanceTraceCapture: null,
      adaptiveWidthBaselineGeometry: null,
      adaptiveWidthAppliedCols: null,
      adaptiveWidthAppliedRows: null,
      adaptiveWidthLeaseTimer: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      subscribers: new Set(),
    };
    mirrors.set(mirror.key, mirror);
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
      closeTransportSubscribers?: boolean;
      notifyClientClose?: boolean;
      releaseCode?: string;
    },
  ) {
    if (mirror.lifecycle === 'destroyed') {
      return;
    }

    // R3: drop any pending input items for the dying mirror before subscribers
    // are released or the mirror record is removed. Items already in flight
    // resolve through their own tmux spawn; queued items must NOT survive.
      deps.daemonInputQueue.disposeLiveMirrorInputBatch(mirror.sessionName, `destroy:${reason}`, mirror.backend);

    mirror.lifecycle = 'destroyed';

    if (options?.closeTransportSubscribers) {
      const subscriberIds = Array.from(mirror.subscribers);
      for (const sessionId of subscriberIds) {
        const client = sessions.get(sessionId);
        if (!client) {
          continue;
        }
        deps.closeTransportSubscriber(client, reason, Boolean(options.notifyClientClose));
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
    mirror.lastLiveActivityAt = 0;
    mirror.lastHeadBroadcastAt = 0;
    mirror.lastCaptureDurationMs = 0;
    mirror.lastCanonicalizeDurationMs = 0;
    mirror.lastScrollbackCount = -1;
    mirror.flushInFlight = false;
    mirror.flushPromise = null;
    pendingPostFlushImmediateSyncMirrors.delete(mirror);
    mirror.pendingStableCaptureSnapshot = null;
    mirror.pendingPerformanceTraceCapture = null;
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    mirror.adaptiveWidthBaselineGeometry = null;
    mirror.adaptiveWidthAppliedCols = null;
    mirror.adaptiveWidthAppliedRows = null;
    stopMirrorLiveSync(mirror);
    mirrors.delete(mirror.key);
  }

  function destroyMirrorIfUnsubscribed(mirror: SessionMirror, reason: string) {
    if (mirror.subscribers.size > 0) {
      return false;
    }
    destroyMirror(mirror, reason, {
      closeTransportSubscribers: false,
      releaseCode: 'no_subscribers',
    });
    return true;
  }

  function ensureSessionReady(session: TerminalSession, mirror: SessionMirror) {
    session.sessionName = mirror.sessionName;
    if (!session.transport || session.connectedSent) {
      return;
    }
    session.connectedSent = true;
    session.transport.connectedSent = true;
    deps.sendMessage(session, {
      type: 'connected',
      payload: deps.buildConnectedPayload(session.id, session.transport.requestOrigin),
    });
    deps.sendScheduleStateToSession(session, mirror.sessionName);
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });
  }
  const bufferPublisher = createDaemonBufferPublisherRuntime({
    sessions,
    sendMessage: deps.sendMessage,
    sendText: deps.sendText,
    recordPerformanceTrace: deps.recordPerformanceTrace,
    buildBufferHeadPayload: deps.buildBufferHeadPayload,
    buildChangedRangesBufferSyncPayload: deps.buildChangedRangesBufferSyncPayload,
    ensureSessionReady,
    buildRequestedRangeBufferPayload,
  });
  function announceMirrorSubscribersReady(mirror: SessionMirror) {
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session) {
        continue;
      }
      ensureSessionReady(session, mirror);
    }
  }

  async function refreshMirrorHeadForSession(session: TerminalSession, mirror: SessionMirror) {
    if (mirror.lifecycle !== 'ready') {
      return false;
    }
    const captured = await syncMirrorCanonicalBuffer(mirror);
    if (!captured) {
      return false;
    }
    bufferPublisher.sendBufferHeadToSession(session, mirror);
    return true;
  }

  async function syncMirrorCanonicalBuffer(
    mirror: SessionMirror,
    options?: { forceRevision?: boolean; requestPostFlushIfBusy?: boolean },
  ) {
    if (mirror.lifecycle !== 'ready') {
      return false;
    }
    if (mirror.flushPromise) {
      if (options?.requestPostFlushIfBusy) {
        pendingPostFlushImmediateSyncMirrors.add(mirror);
      }
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
        if (mirror.lifecycle !== 'ready' || mirrors.get(mirror.key) !== mirror) {
          return false;
        }
        writeMirrorBaselineGeometry(mirror, {
          cols: mirror.cols,
          rows: mirror.rows,
        });
        mirror.consecutiveFailures = 0;
        const changedRanges = deps.mirrorBufferChanged(mirror, previousStartIndex, previousLines);
        const cursorChanged = !deps.mirrorCursorEqual(previousCursor, mirror.cursor);
        const cursorKeysAppChanged = previousCursorKeysApp !== mirror.cursorKeysApp;
        const hasLiveActivity = forceRevision || changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged;
        // Content-change truth drives the quiet-capture backoff. Cursor-only
        // changes (head broadcasts) do NOT keep the capture loop hot: an idle
        // terminal must not pay a full tmux capture every 33ms just to confirm
        // the same 1305 lines.
        mirror.lastFlushHadContentChanges = forceRevision || changedRanges.length > 0;
        if (hasLiveActivity) {
          mirror.revision += 1;
          mirror.lastLiveActivityAt = Date.now();
        }
        if (hasLiveActivity) {
          const captureTrace = mirror.pendingPerformanceTraceCapture;
          const committedAt = Date.now();
          for (const subscriberId of mirror.subscribers) {
            const traceBase = {
              sessionId: subscriberId,
              traceId: `${subscriberId}:${Math.max(0, Math.floor(mirror.revision || 0))}`,
              mirrorRevision: Math.max(0, Math.floor(mirror.revision || 0)),
              subscriberId,
            };
            if (captureTrace) {
              deps.recordPerformanceTrace?.({
                ...traceBase,
                stage: 'capture-start',
                at: captureTrace.captureStartedAt,
                lineCount: captureTrace.capturedLineCount,
              });
              deps.recordPerformanceTrace?.({
                ...traceBase,
                stage: 'capture-done',
                at: captureTrace.captureDoneAt,
                lineCount: captureTrace.capturedLineCount,
              });
              deps.recordPerformanceTrace?.({
                ...traceBase,
                stage: 'canonicalize-done',
                at: captureTrace.canonicalizeDoneAt,
                lineCount: captureTrace.canonicalLineCount,
              });
            }
            deps.recordPerformanceTrace?.({
              ...traceBase,
              stage: 'mirror-commit',
              at: committedAt,
              lineCount: mirror.bufferLines.length,
            });
          }
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
          bufferPublisher.broadcastChangedRangesBufferSyncToSubscribers(
            mirror,
            forceRevision
              ? [{ startIndex: mirror.bufferStartIndex, endIndex: mirror.bufferStartIndex + mirror.bufferLines.length }]
              : changedRanges,
          );
          return true;
        }
        if (cursorChanged || cursorKeysAppChanged) {
          bufferPublisher.broadcastBufferHeadToSubscribers(mirror);
        }
        bufferPublisher.flushPendingBufferSyncToSubscribers(mirror);
        return true;
      })
      .catch((error) => {
        if (mirror.lifecycle === 'destroyed' || mirrors.get(mirror.key) !== mirror) {
          return false;
        }
        mirror.consecutiveFailures += 1;
        const isInvalidTarget = isTmuxSessionUnavailableError(error);
        const failureMsg = `[${deps.logTimePrefix()}] canonical mirror refresh failed for ${mirror.sessionName} (streak=${mirror.consecutiveFailures}): ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (isInvalidTarget) {
          console.error(`${failureMsg} -> mirror released (code=tmux_session_unavailable)`);
          destroyMirror(
            mirror,
            `Tmux session unavailable: ${error instanceof Error ? error.message : String(error)}`,
            {
              closeTransportSubscribers: false,
              releaseCode: 'tmux_session_unavailable',
            },
          );
          return false;
        }
        if (mirror.consecutiveFailures >= 10) {
          mirror.lifecycle = 'failed';
          stopMirrorLiveSync(mirror);
          console.error(`${failureMsg} -> mirror isolated (lifecycle=failed)`);
        } else {
          console.error(failureMsg);
        }
        return false;
      })
      .finally(() => {
        if (mirror.lifecycle === 'destroyed' || mirrors.get(mirror.key) !== mirror) {
          return;
        }
        mirror.lastFlushCompletedAt = Date.now();
        mirror.flushInFlight = false;
        mirror.flushPromise = null;
        if (pendingPostFlushImmediateSyncMirrors.delete(mirror)) {
          scheduleMirrorLiveSync(mirror, 0);
        }
      });

    mirror.flushPromise = capturePromise;
    return capturePromise;
  }

  function resolvePostFlushSyncDelayMs(mirror: SessionMirror) {
    if (mirror.lastFlushHadContentChanges) {
      mirror.quietFlushStreak = 0;
      return MIRROR_LIVE_SYNC_ACTIVE_MS;
    }
    mirror.quietFlushStreak += 1;
    // Quiet backoff: 120ms -> 240ms -> 480ms -> capped 500ms. An idle terminal
    // still gets re-polled (external tmux writes are detected within ~0.5s)
    // but stops burning a full-buffer tmux capture at 30fps.
    return Math.min(
      QUIET_CAPTURE_MAX_DELAY_MS,
      MIRROR_LIVE_SYNC_IDLE_MS * 2 ** Math.max(0, Math.min(mirror.quietFlushStreak - 1, 3)),
    );
  }

  function scheduleMirrorLiveSync(mirror: SessionMirror, delayMs = MIRROR_LIVE_SYNC_ACTIVE_MS) {
    if (mirror.lifecycle !== 'ready') {
      return;
    }
    if (countReadyBodySubscribedSubscribers(mirror) === 0) {
      stopMirrorLiveSync(mirror);
      return;
    }
    const effectiveDelay = resolveMirrorLiveSyncDelay(mirror, delayMs);
    stopMirrorLiveSync(mirror);
    mirror.liveSyncTimer = setTimeout(() => {
      mirror.liveSyncTimer = null;
      if (mirror.lifecycle !== 'ready' || countReadyBodySubscribedSubscribers(mirror) === 0) {
        return;
      }
      void syncMirrorCanonicalBuffer(mirror, {
        requestPostFlushIfBusy: delayMs === 0,
      }).finally(() => {
        if (
          mirror.lifecycle !== 'ready'
          || mirror.liveSyncTimer
          || countReadyBodySubscribedSubscribers(mirror) === 0
        ) {
          return;
        }
        const postFlushDelay = resolvePostFlushSyncDelayMs(mirror);
        scheduleMirrorLiveSync(mirror, postFlushDelay);
      });
    }, Math.max(0, effectiveDelay));
  }

  function resolveActiveAdaptiveWidthLeases(mirror: SessionMirror, now = Date.now()) {
    const leases: Array<{ subscriberId: string; cols: number; rows: number; expiresAt: number }> = [];
    for (const subscriberId of mirror.subscribers) {
      const subscriber = sessions.get(subscriberId);
      if (!subscriber || !subscriber.transport || subscriber.transport.readyState !== 1) {
        continue;
      }
      if (!subscriber.adaptiveWidthCols || subscriber.adaptiveWidthCols <= 0) {
        continue;
      }
      const expiresAt = (subscriber.adaptiveWidthHeartbeatAt || 0) + ADAPTIVE_WIDTH_LEASE_TTL_MS;
      if (expiresAt <= now) {
        continue;
      }
      leases.push({
        subscriberId,
        cols: deps.normalizeTerminalCols(subscriber.adaptiveWidthCols),
        rows: deps.normalizeTerminalRows(subscriber.adaptiveWidthRows || mirror.rows),
        expiresAt,
      });
    }
    leases.sort((left, right) => left.cols - right.cols || left.expiresAt - right.expiresAt);
    return leases;
  }

  function scheduleAdaptiveWidthLeaseExpiry(mirror: SessionMirror) {
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    const leases = resolveActiveAdaptiveWidthLeases(mirror);
    if (leases.length === 0) {
      return;
    }
    const nextExpiresAt = Math.min(...leases.map((lease) => lease.expiresAt));
    const delayMs = Math.max(1, nextExpiresAt - Date.now() + 1);
    mirror.adaptiveWidthLeaseTimer = setTimeout(() => {
      mirror.adaptiveWidthLeaseTimer = null;
      reconcileAdaptiveWidthLeases(mirror, 'lease-expired');
    }, delayMs);
    mirror.adaptiveWidthLeaseTimer.unref?.();
  }

  function clearAdaptiveWidthLeaseAggregate(mirror: SessionMirror, reason = 'clear') {
    if (mirror.adaptiveWidthLeaseTimer) {
      clearTimeout(mirror.adaptiveWidthLeaseTimer);
      mirror.adaptiveWidthLeaseTimer = null;
    }
    if (mirror.adaptiveWidthAppliedCols !== null) {
      releaseAdaptiveTmuxWidth(mirror, reason);
    }
    mirror.adaptiveWidthAppliedCols = null;
    mirror.adaptiveWidthBaselineGeometry = null;
  }

  function readCurrentTmuxGeometry(sessionName: string, backend: 'tmux' | 'herdr' = 'tmux'): TerminalGeometry | null {
    try {
      const metrics = deps.readTmuxPaneMetrics(sessionName, backend);
      return {
        cols: deps.normalizeTerminalCols(metrics.paneCols),
        rows: deps.normalizeTerminalRows(metrics.paneRows),
      };
    } catch (error) {
      console.error(
        `[${deps.logTimePrefix()}] adaptive width failed to read tmux geometry for ${sessionName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  function applyAdaptiveTmuxWidth(mirror: SessionMirror, targetCols: number, targetRows: number, reason: string) {
    const cols = deps.normalizeTerminalCols(targetCols);
    if (!mirror.adaptiveWidthBaselineGeometry) {
      mirror.adaptiveWidthBaselineGeometry =
        readCurrentTmuxGeometry(mirror.sessionName, mirror.backend) || {
          cols: deps.normalizeTerminalCols(mirror.baselineCols || mirror.cols),
          rows: deps.normalizeTerminalRows(mirror.baselineRows || mirror.rows),
        };
    }
    if (mirror.adaptiveWidthAppliedCols === cols && mirror.adaptiveWidthAppliedRows === targetRows) {
      return;
    }
    if (deps.resizeBackendSession) {
      deps.resizeBackendSession(mirror.sessionName, {
        cols,
        rows: targetRows,
      }, mirror.backend);
    } else {
      deps.runTmux(['resize-window', '-t', deps.buildExactTmuxSessionTarget(mirror.sessionName), '-x', String(cols)]);
    }
    mirror.adaptiveWidthAppliedCols = cols;
    mirror.adaptiveWidthAppliedRows = targetRows;
    console.log(`[${deps.logTimePrefix()}] adaptive width applied`, {
      sessionName: mirror.sessionName,
      cols,
      reason,
    });
  }

  function releaseAdaptiveTmuxWidth(mirror: SessionMirror, reason: string) {
    const baseline = mirror.adaptiveWidthBaselineGeometry;
    if (baseline) {
      if (deps.resizeBackendSession) {
        deps.resizeBackendSession(mirror.sessionName, {
          cols: deps.normalizeTerminalCols(baseline.cols),
          rows: deps.normalizeTerminalRows(baseline.rows),
        }, mirror.backend);
      } else {
        deps.runTmux(['resize-window', '-t', deps.buildExactTmuxSessionTarget(mirror.sessionName), '-x', String(deps.normalizeTerminalCols(baseline.cols))]);
      }
    }
    if (mirror.backend === 'tmux') {
      deps.runTmux(['set-window-option', '-u', '-t', deps.buildExactTmuxSessionTarget(mirror.sessionName), 'window-size']);
    }
    console.log(`[${deps.logTimePrefix()}] adaptive width released`, {
      sessionName: mirror.sessionName,
      restoredCols: baseline?.cols ?? null,
      reason,
    });
  }

  function reconcileAdaptiveWidthLeases(mirror: SessionMirror, reason: string) {
    void reason;
    const now = Date.now();
    for (const subscriberId of mirror.subscribers) {
      const subscriber = sessions.get(subscriberId);
      if (!subscriber?.adaptiveWidthCols) {
        continue;
      }
      const expiresAt = (subscriber.adaptiveWidthHeartbeatAt || 0) + ADAPTIVE_WIDTH_LEASE_TTL_MS;
      if (expiresAt <= now) {
        subscriber.adaptiveWidthCols = null;
        subscriber.adaptiveWidthHeartbeatAt = 0;
      }
    }
    const leases = resolveActiveAdaptiveWidthLeases(mirror);
    if (leases.length === 0) {
      clearAdaptiveWidthLeaseAggregate(mirror, reason);
      return;
    }

    const targetCols = leases[0].cols;
    if (
      mirror.adaptiveWidthAppliedCols !== targetCols
      || mirror.adaptiveWidthAppliedRows !== leases[0].rows
    ) {
      if (mirror.lifecycle === 'ready') {
        applyAdaptiveTmuxWidth(mirror, targetCols, leases[0].rows, reason);
        scheduleMirrorLiveSync(mirror, 0);
      }
    }
    scheduleAdaptiveWidthLeaseExpiry(mirror);
  }

  function updateAdaptiveWidthLease(
    session: TerminalSession,
    mirror: SessionMirror,
    payload: { cols?: number; rows?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
    reason: string,
  ): { ok: true } | { ok: false; code: 'adaptive_width_cols_invalid'; message: string } {
    if (payload.widthMode !== 'adaptive-phone') {
      releaseAdaptiveWidthLease(session, reason);
      return { ok: true };
    }
    if (typeof payload.cols !== 'number' || !Number.isFinite(payload.cols) || payload.cols <= 0) {
      releaseAdaptiveWidthLease(session, `${reason}-invalid-cols`);
      return {
        ok: false,
        code: 'adaptive_width_cols_invalid',
        message: 'adaptive-phone width lease requires finite positive cols',
      };
    }
    const cols = deps.normalizeTerminalCols(payload.cols);
    session.adaptiveWidthCols = cols;
    session.adaptiveWidthRows = typeof payload.rows === 'number' && Number.isFinite(payload.rows)
      ? deps.normalizeTerminalRows(payload.rows)
      : deps.normalizeTerminalRows(mirror.rows);
    session.adaptiveWidthHeartbeatAt = Date.now();
    reconcileAdaptiveWidthLeases(mirror, reason);
    return { ok: true };
  }

  function restorePersistedAdaptiveWidthBaselines(sessionNames: string[]) {
    void sessionNames;
    return 0;
  }

  async function startMirror(
    mirror: SessionMirror,
    options?: { cols?: number; rows?: number; autoCommand?: string },
  ) {
    if (mirror.lifecycle === 'ready' || mirror.lifecycle === 'booting') {
      return;
    }

    mirror.lifecycle = 'booting';

    try {
      deps.assertTmuxSessionExists(mirror.sessionName, mirror.backend);
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
          payload: { message: `Tmux session unavailable: ${message}`, code: 'tmux_session_unavailable' },
        });
      }
      return;
    }

    mirror.lifecycle = 'ready';
    reconcileAdaptiveWidthLeases(mirror, 'mirror-ready');

    if (countReadyBodySubscribedSubscribers(mirror) === 0) {
      announceMirrorSubscribersReady(mirror);
      return;
    }

    try {
      await deps.waitMs(80);
      if (mirror.lifecycle !== 'ready' || mirrors.get(mirror.key) !== mirror || mirror.subscribers.size === 0) {
        return;
      }
      const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
      if (mirror.lifecycle !== 'ready' || mirrors.get(mirror.key) !== mirror || mirror.subscribers.size === 0) {
        return;
      }
      if (!captured) {
        if (!mirrors.has(mirror.key)) {
          return;
        }
        throw new Error('Failed to capture canonical tmux buffer during initial sync');
      }
      announceMirrorSubscribersReady(mirror);
      scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
    } catch (error) {
      if (isTmuxSessionUnavailableError(error)) {
        console.error(
          `[${deps.logTimePrefix()}] initial buffer sync released unavailable tmux target for ${mirror.sessionName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        destroyMirror(
          mirror,
          `Tmux session unavailable: ${error instanceof Error ? error.message : String(error)}`,
          {
            closeTransportSubscribers: false,
            releaseCode: 'tmux_session_unavailable',
          },
        );
        return;
      }
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
          deps.writeToTmuxSession(mirror.sessionName, command, true, mirror.backend);
          scheduleMirrorLiveSync(mirror, 0);
        }
      }, deps.autoCommandDelayMs);
    }
  }

  async function attachTmux(session: TerminalSession, payload: TerminalAttachPayload) {
    const nextSessionName = deps.sanitizeSessionName(payload.sessionName);
    const requestedBackend = payload.backend
      || session.backend
      || deps.resolveTerminalSessionBackend?.(nextSessionName);
    if (!requestedBackend) {
      throw new Error(`terminal session backend resolver unavailable for ${nextSessionName}`);
    }
    if (session.backend && session.backend !== requestedBackend) {
      throw new Error(`session backend changed after channel allocation: ${session.backend} -> ${requestedBackend}`);
    }
    session.backend = requestedBackend;
    const nextMirrorKey = deps.getMirrorKey(nextSessionName, requestedBackend);
    const existingMirror = mirrors.get(nextMirrorKey) || null;
    if (existingMirror && existingMirror.backend !== requestedBackend) {
      throw new Error(`session name ${nextSessionName} is already owned by ${existingMirror.backend}`);
    }
    const existingTmuxGeometry = existingMirror
      ? null
      : (() => {
        try {
          const metrics = deps.readTmuxPaneMetrics(nextSessionName, requestedBackend);
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
      requestedGeometry: payload.widthMode === 'adaptive-phone'
        ? null
        : typeof payload.cols === 'number'
          && Number.isFinite(payload.cols)
          && payload.cols > 0
          ? {
              cols: payload.cols,
              rows: typeof payload.rows === 'number' ? payload.rows : deps.defaultViewport.rows,
            }
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
    const movingBetweenMirrors = Boolean(previousMirror && previousMirror.key !== nextMirrorKey);
    if (previousMirror) {
      if (movingBetweenMirrors) {
        releaseAdaptiveWidthLease(session, 'move-mirror');
      }
      const detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
      previousMirror.subscribers = detachResult.nextSubscribers;
      if (movingBetweenMirrors) {
        if (!destroyMirrorIfUnsubscribed(previousMirror, `subscriber moved: ${session.id}`)) {
          scheduleMirrorLiveSync(previousMirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
        }
      }
    }

    session.sessionName = nextSessionName;
    session.mirrorKey = nextMirrorKey;
    session.connectedSent = false;
    if (session.transport) {
      session.transport.connectedSent = false;
    }

    let mirror = existingMirror;
    if (!mirror) {
      mirror = createMirror(nextSessionName, session.backend);
    }
    mirror.subscribers.add(session.id);
    if (payload.widthMode === 'adaptive-phone') {
      const leaseResult = updateAdaptiveWidthLease(session, mirror, payload, 'attach');
      if (!leaseResult.ok) {
        deps.sendMessage(session, {
          type: 'error',
          payload: { message: leaseResult.message, code: leaseResult.code },
        });
      }
    } else {
      releaseAdaptiveWidthLease(session, 'attach-non-adaptive');
    }
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });

    if (mirror.lifecycle === 'ready') {
      ensureSessionReady(session, mirror);
      scheduleMirrorLiveSync(mirror, 0);
      return;
    }

    await startMirror(mirror, { cols: requestedCols, rows: requestedRows, autoCommand: payload.autoCommand });
  }

  function handleAdaptiveResize(
    session: TerminalSession,
    payload: { cols?: number; rows?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ): { ok: true } | { ok: false; code: 'session_not_ready' | 'adaptive_width_cols_invalid'; message: string } {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return {
        ok: false,
        code: 'session_not_ready',
        message: 'resize requires an attached mirror',
      };
    }
    const leaseResult = updateAdaptiveWidthLease(session, mirror, payload, 'resize');
    if (!leaseResult.ok) {
      return leaseResult;
    }
    scheduleMirrorLiveSync(mirror, 0);
    return { ok: true };
  }

  function refreshAdaptiveWidthLeaseHeartbeat(session: TerminalSession) {
    if (!session.adaptiveWidthCols || !session.mirrorKey) {
      return;
    }
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return;
    }
    session.adaptiveWidthHeartbeatAt = Date.now();
    scheduleAdaptiveWidthLeaseExpiry(mirror);
  }

  function releaseAdaptiveWidthLease(session: TerminalSession, reason: string) {
    const mirror = deps.getSessionMirror(session);
    const hadLease = Boolean(session.adaptiveWidthCols);
    session.adaptiveWidthCols = null;
    session.adaptiveWidthRows = null;
    session.adaptiveWidthHeartbeatAt = 0;
    if (!mirror || !hadLease) {
      return;
    }
    reconcileAdaptiveWidthLeases(mirror, reason);
  }

  async function handleInput(
    session: TerminalSession,
    data: string,
    shouldWrite?: () => boolean,
  ) {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return false;
    }
    if (mirror.lifecycle === 'failed') {
      mirror.lifecycle = 'ready';
      mirror.consecutiveFailures = 0;
      console.log(`[${deps.logTimePrefix()}] mirror ${mirror.sessionName} recovered from failed by input`);
    }
    if (mirror.lifecycle === 'ready') {
      mirror.consecutiveFailures = 0;
      const wrote = await deps.daemonInputQueue.enqueueLiveMirrorInput(
        mirror.sessionName,
        data,
        false,
        shouldWrite,
        mirror.backend,
      );
      if (wrote) {
        mirror.lastLiveActivityAt = Date.now();
        scheduleMirrorLiveSync(mirror, 0);
        return true;
      }
    }
    return false;
  }

  return {
    createMirror,
    destroyMirror,
    destroyMirrorIfUnsubscribed,
    ensureSessionReady,
    sendBufferHeadToSession: bufferPublisher.sendBufferHeadToSession,
    enqueueRangeBufferSyncResponse: bufferPublisher.enqueueRangeBufferSyncResponse,
    flushPendingSubscriberBufferSync: bufferPublisher.flushPendingSubscriberBufferSync,
    refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync,
    startMirror,
    attachTmux,
    handleAdaptiveResize,
    restorePersistedAdaptiveWidthBaselines,
    refreshAdaptiveWidthLeaseHeartbeat,
    releaseAdaptiveWidthLease,
    handleInput,
    disposeLiveMirrorInputBatch: (sessionName, reason, backend) =>
      deps.daemonInputQueue.disposeLiveMirrorInputBatch(sessionName, `destroy:${reason}`, backend),
  };
}
