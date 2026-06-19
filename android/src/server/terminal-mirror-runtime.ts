import type {
  ServerMessage,
  TerminalCell,
  TerminalCursorState,
} from '../lib/types';
import type { TerminalWidthMode } from './terminal-runtime-types';
import { summarizeIndexedLinesForDebug } from '../lib/terminal-buffer-debug';
import { sliceIndexedLines } from './canonical-buffer';
import { detachMirrorSubscriber, releaseMirrorSubscribers } from './mirror-lifecycle';
import { resolveTerminalLiveSyncDelay } from './terminal-performance-scheduler';
import { readTerminalTransportBackpressureSnapshot } from './terminal-transport-runtime';
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
    previousLines: TerminalCell[][],
  ) => Array<{ startIndex: number; endIndex: number }>;
  mirrorCursorEqual: (
    left: TerminalCursorState | null | undefined,
    right: TerminalCursorState | null | undefined,
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
  logTimePrefix: () => string;
  runTmux: (args: string[]) => { ok: true; stdout: string };
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
  resolveMirrorLiveSyncDelayForSubscriber: (
    mirror: SessionMirror,
    sessionId: string,
    sessions: Map<string, TerminalSession>,
    now: number,
    requestedDelayMs?: number,
  ) => { delayMs: number; lane: string; reason: string };
  startMirror: (mirror: SessionMirror, options?: { cols?: number; rows?: number; autoCommand?: string }) => Promise<void>;
  attachTmux: (session: TerminalSession, payload: TerminalAttachPayload) => Promise<void>;
  handleAdaptiveResize: (
    session: TerminalSession,
    payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' },
  ) => void;
  handleInput: (session: TerminalSession, data: string, shouldWrite?: () => boolean) => Promise<boolean>;
  reconcileMirrorAdaptiveWidth: (mirror: SessionMirror) => void;
  disposeLiveMirrorInputBatch: (sessionName: string, reason: string) => number;
}

const MIRROR_LIVE_SYNC_ACTIVE_MS = 33;
const MIRROR_LIVE_SYNC_IDLE_MS = 120;
// R6: at most one tmux resize per mirror per this many ms. Keyboard / rotation
// / pinch on the client can fire 50+ resize frames per second; we collapse
// them into a single tmux resize here.
const MIRROR_RESIZE_THROTTLE_MS = 250;
// R7: multi-sub safety. When 2+ subscribers of the same mirror have
// different widthMode values, we DO NOT resize tmux globally. Truncating the
// mirror to a sub's narrow cols would corrupt another sub's view. Each sub
// will instead receive a per-sub narrow mirror via buffer-sync truncation.
const MIRROR_RESIZE_MULTISUB_DIVERGENCE_BLOCK = 2;
// R14: head requests within this window reuse the last mirror state without
// triggering another capture. This stops sub N=8 clients hammering daemon
// with head requests after the head has just been broadcast.
const MIRROR_HEAD_REQUEST_CACHE_MS = 100;

export function resolvePerSubscriberTransportSnapshot(
  sessions: Map<string, TerminalSession>,
  sessionId: string,
) {
  const session = sessions.get(sessionId);
  return readTerminalTransportBackpressureSnapshot(session?.transport);
}

export function resolveMirrorLiveSyncDelayForSubscriber(
  mirror: SessionMirror,
  sessionId: string,
  sessions: Map<string, TerminalSession>,
  now: number,
  requestedDelayMs?: number,
) {
  const snapshot = resolvePerSubscriberTransportSnapshot(sessions, sessionId);
  return resolveTerminalLiveSyncDelay({
    requestedDelayMs,
    activeDelayMs: MIRROR_LIVE_SYNC_ACTIVE_MS,
    idleDelayMs: MIRROR_LIVE_SYNC_IDLE_MS,
    now,
    lastLiveActivityAt: mirror.lastLiveActivityAt || 0,
    consecutiveFailures: mirror.consecutiveFailures,
    subscriberCount: 1,
    transportBufferedBytes: snapshot?.bufferedBytes || 0,
    transportBackpressureCount: snapshot?.backpressureCount || 0,
    lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
    lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
    flushInFlight: mirror.flushInFlight,
  });
}

export function createTerminalMirrorRuntime(deps: TerminalMirrorRuntimeDeps): TerminalMirrorRuntime {
  const sessions = deps.sessions;
  const mirrors = deps.mirrors;

  function isTmuxSessionUnavailableError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /no server running|can(?:'t| not) find session|no such session|session .*not found/i.test(message);
  }

  function resolveMirrorBaselineCols(mirror: SessionMirror) {
    const baselineCols = mirror.baselineCols;
    if (typeof baselineCols === 'number' && Number.isFinite(baselineCols) && baselineCols > 0) {
      return deps.normalizeTerminalCols(baselineCols);
    }
    return deps.normalizeTerminalCols(mirror.cols);
  }

  function resolveMirrorBaselineRows(mirror: SessionMirror) {
    const baselineRows = mirror.baselineRows;
    if (typeof baselineRows === 'number' && Number.isFinite(baselineRows) && baselineRows > 0) {
      return deps.normalizeTerminalRows(baselineRows);
    }
    return deps.normalizeTerminalRows(mirror.rows);
  }

  function writeMirrorBaselineGeometry(mirror: SessionMirror, geometry: { cols: number; rows: number }) {
    mirror.baselineCols = deps.normalizeTerminalCols(geometry.cols);
    mirror.baselineRows = deps.normalizeTerminalRows(geometry.rows);
  }

  function refreshMirrorGeometryFromTmux(mirror: SessionMirror) {
    const metrics = deps.readTmuxPaneMetrics(mirror.sessionName);
    const geometry = {
      cols: metrics.paneCols,
      rows: metrics.paneRows,
    };
    writeMirrorBaselineGeometry(mirror, geometry);
    mirror.cols = deps.normalizeTerminalCols(geometry.cols);
    mirror.rows = deps.normalizeTerminalRows(geometry.rows);
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
      subscriberCount: mirror.subscribers.size,
      // Backpressure is handled per-subscriber in broadcastChangedRangesBufferSyncToSubscribers.
      // Mirror-level capture cadence must not be dragged down by a single slow subscriber.
      transportBufferedBytes: 0,
      transportBackpressureCount: 0,
      lastCaptureDurationMs: mirror.lastCaptureDurationMs || 0,
      lastCanonicalizeDurationMs: mirror.lastCanonicalizeDurationMs || 0,
      flushInFlight: mirror.flushInFlight,
    }).delayMs;
  }

  function createMirror(sessionName: string): SessionMirror {
    const mirror: SessionMirror = {
      key: sessionName,
      sessionName,
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
      lastResizeAt: 0,
      lastCaptureDurationMs: 0,
      lastCanonicalizeDurationMs: 0,
      flushInFlight: false,
      flushPromise: null,
      pendingStableCaptureSnapshot: null,
      liveSyncTimer: null,
      consecutiveFailures: 0,
      adaptiveCols: new Map(),
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

    // R3: drop any pending input items for the dying mirror before subscribers
    // are released or the mirror record is removed. Items already in flight
    // resolve through their own tmux spawn; queued items must NOT survive.
    deps.disposeLiveMirrorInputBatch(mirror.sessionName, `destroy:${reason}`);

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
    mirror.lastLiveActivityAt = 0;
    mirror.lastHeadBroadcastAt = 0;
    mirror.lastResizeAt = 0;
    mirror.lastCaptureDurationMs = 0;
    mirror.lastCanonicalizeDurationMs = 0;
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
  function reconcileMirrorAdaptiveWidth(mirror: SessionMirror) {
    const baselineCols = resolveMirrorBaselineCols(mirror);
    const baselineRows = resolveMirrorBaselineRows(mirror);
    // R7: enumerate widthMode across all subscribers. If 2+ different
    // widthMode values are present, refuse to mutate tmux; each sub gets its
    // own narrow mirror at consume time (renderer / buffer-sync truncation).
    const widthModes = new Set<TerminalWidthMode>();
    for (const sessionId of mirror.subscribers) {
      const sub = sessions.get(sessionId);
      if (sub) {
        widthModes.add(sub.widthMode);
      }
    }
    if (widthModes.size >= MIRROR_RESIZE_MULTISUB_DIVERGENCE_BLOCK) {
      return;
    }
    let minCols = 0;
    for (const entry of mirror.adaptiveCols.values()) {
      if (entry.widthMode === 'adaptive-phone' && entry.cols > 0) {
        if (minCols === 0 || entry.cols < minCols) {
          minCols = entry.cols;
        }
      }
    }
    if (minCols === 0) {
      try {
        deps.runTmux(['set-window-option', '-t', mirror.sessionName, 'window-size', 'latest']);
        refreshMirrorGeometryFromTmux(mirror);
      } catch (error) {
        console.warn(
          `[${deps.logTimePrefix()}] failed to release tmux window-size ownership for ${mirror.sessionName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    const targetCols = minCols > 0
      ? Math.min(deps.normalizeTerminalCols(minCols), baselineCols)
      : baselineCols;
    const targetRows = baselineRows;
    if (targetCols === mirror.cols && targetRows === mirror.rows) {
      return;
    }
    // R6: throttle tmux resize. Capture the last-requested timestamp and
    // bail if another resize landed within MIRROR_RESIZE_THROTTLE_MS.
    const now = Date.now();
    if (
      mirror.lastResizeAt > 0
      && now - mirror.lastResizeAt < MIRROR_RESIZE_THROTTLE_MS
    ) {
      return;
    }
    mirror.lastResizeAt = now;
    try {
      deps.runTmux(['resize-window', '-t', mirror.sessionName, '-x', String(targetCols)]);
      mirror.cols = targetCols;
      mirror.rows = targetRows;
    } catch (error) {
      console.warn(`[${deps.logTimePrefix()}] failed to resize tmux window for ${mirror.sessionName}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // R14: head broadcast dedup. Multiple subs / multiple requests within the
    // cache window share the same broadcast timestamp; we still send to the
    // whole fanout but only build the payload once. lastHeadBroadcastAt is the
    // truth for the next dedup window.
    const now = Date.now();
    if (
      mirror.lastHeadBroadcastAt > 0
      && now - mirror.lastHeadBroadcastAt < MIRROR_HEAD_REQUEST_CACHE_MS
    ) {
      return;
    }
    mirror.lastHeadBroadcastAt = now;
    // R5: pre-build the typed payload once, dispatch through sendMessage.
    // sendMessage owns the per-sub transport and runtime-debug surface that
    // tests still expect; we just stop paying N JSON.stringify per fanout.
    type HeadMessage = Extract<ServerMessage, { type: 'buffer-head' }>;
    const perSubMessages: Array<{ sessionId: string; message: HeadMessage }> = [];
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || !session.transport || session.transport.readyState !== 1) {
        continue;
      }
      const snapshot = readTerminalTransportBackpressureSnapshot(session.transport);
      if (snapshot && snapshot.backpressure) {
        continue;
      }
      ensureSessionReady(session, mirror);
      perSubMessages.push({
        sessionId,
        message: {
          type: 'buffer-head',
          payload: deps.buildBufferHeadPayload(session.id, mirror),
        },
      });
    }
    for (const item of perSubMessages) {
      const session = sessions.get(item.sessionId);
      if (!session) continue;
      deps.sendMessage(session, item.message);
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
    // R5: pre-serialize once, fan out via sendText to avoid N×JSON.stringify per sub.
    // sendText owns transport open-check + lastSendAt; runtime-debug is skipped for
    // high-frequency buffer-sync to keep CPU low at high subscriber counts.
    const text = JSON.stringify({ type: 'buffer-sync', payload });
    const now = Date.now();
    for (const sessionId of mirror.subscribers) {
      const session = sessions.get(sessionId);
      if (!session || !session.transport || session.transport.readyState !== 1) {
        continue;
      }
      // Per-subscriber cadence: a slow subscriber must not slow the whole mirror.
      // Healthy subscribers still receive this diff immediately; only the slow peer's
      // own transport pressure is considered for its lane decision.
      const decision = resolveMirrorLiveSyncDelayForSubscriber(mirror, sessionId, sessions, now, 0);
      if (decision.lane === 'slow' && decision.reason === 'transport-backpressure') {
        continue;
      }
      ensureSessionReady(session, mirror);
      deps.sendText(session.transport, text);
    }
  }

  function sendBufferHeadToSession(session: TerminalSession, mirror: SessionMirror) {
    if (!session.transport || session.transport.readyState !== 1) {
      return;
    }
    // R1+R2: a single sub's head request no longer takes a private fast path
    // that bypasses the dedup'd broadcast. If the mirror just broadcast a head
    // within the cache window we skip; otherwise we run the same broadcast
    // path which serves all healthy subs in one pass with one stringify.
    const now = Date.now();
    if (
      mirror.lastHeadBroadcastAt > 0
      && now - mirror.lastHeadBroadcastAt < MIRROR_HEAD_REQUEST_CACHE_MS
    ) {
      return;
    }
    broadcastBufferHeadToSubscribers(mirror);
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
        if (mirror.adaptiveCols.size === 0) {
          writeMirrorBaselineGeometry(mirror, {
            cols: mirror.cols,
            rows: mirror.rows,
          });
        }
        mirror.consecutiveFailures = 0;
        const changedRanges = deps.mirrorBufferChanged(mirror, previousStartIndex, previousLines);
        const cursorChanged = !deps.mirrorCursorEqual(previousCursor, mirror.cursor);
        const cursorKeysAppChanged = previousCursorKeysApp !== mirror.cursorKeysApp;
        const hasLiveActivity = forceRevision || changedRanges.length > 0 || cursorChanged || cursorKeysAppChanged;
        if (hasLiveActivity) {
          mirror.revision += 1;
          mirror.lastLiveActivityAt = Date.now();
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
              closeLogicalSessions: false,
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
        mirror.lastFlushCompletedAt = Date.now();
        mirror.flushInFlight = false;
        mirror.flushPromise = null;
      });

    mirror.flushPromise = capturePromise;
    return capturePromise;
  }

  function scheduleMirrorLiveSync(mirror: SessionMirror, delayMs = MIRROR_LIVE_SYNC_ACTIVE_MS) {
    if (mirror.lifecycle !== 'ready') {
      return;
    }
    if (mirror.subscribers.size === 0) {
      stopMirrorLiveSync(mirror);
      return;
    }
    const effectiveDelay = resolveMirrorLiveSyncDelay(mirror, delayMs);
    stopMirrorLiveSync(mirror);
    mirror.liveSyncTimer = setTimeout(() => {
      mirror.liveSyncTimer = null;
      if (mirror.lifecycle !== 'ready' || mirror.subscribers.size === 0) {
        return;
      }
      void syncMirrorCanonicalBuffer(mirror).finally(() => {
        if (mirror.lifecycle !== 'ready' || mirror.liveSyncTimer) {
          return;
        }
        scheduleMirrorLiveSync(mirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
      });
    }, Math.max(0, effectiveDelay));
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
      deps.assertTmuxSessionExists(mirror.sessionName);
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

    try {
      await deps.waitMs(80);
      const captured = await syncMirrorCanonicalBuffer(mirror, { forceRevision: true });
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
            closeLogicalSessions: false,
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
          ? {
              cols: payload.cols,
              rows: existingMirror?.rows
                || existingTmuxGeometry?.rows
                || deps.defaultViewport.rows,
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
      const detachResult = detachMirrorSubscriber(previousMirror.subscribers, session.id);
      previousMirror.subscribers = detachResult.nextSubscribers;
      previousMirror.adaptiveCols.delete(session.id);
      if (movingBetweenMirrors) {
        reconcileMirrorAdaptiveWidth(previousMirror);
        scheduleMirrorLiveSync(previousMirror, MIRROR_LIVE_SYNC_ACTIVE_MS);
      }
    }

    session.sessionName = nextSessionName;
    session.mirrorKey = nextMirrorKey;
    if (session.transport) {
      session.transport.connectedSent = false;
    }

    let mirror = existingMirror;
    if (!mirror) {
      mirror = createMirror(nextSessionName);
      writeMirrorBaselineGeometry(mirror, existingTmuxGeometry || { cols: requestedCols, rows: requestedRows });
      mirror.cols = resolveMirrorBaselineCols(mirror);
      mirror.rows = resolveMirrorBaselineRows(mirror);
    }
    mirror.subscribers.add(session.id);
    const clientWidthMode = payload.widthMode || 'mirror-fixed';
    session.widthMode = clientWidthMode;
    if (clientWidthMode === 'adaptive-phone' && requestedCols > 0) {
      mirror.adaptiveCols.set(session.id, { cols: requestedCols, widthMode: clientWidthMode });
    } else {
      mirror.adaptiveCols.delete(session.id);
    }
    reconcileMirrorAdaptiveWidth(mirror);
    if (mirror.lifecycle !== 'ready') {
      mirror.cols = requestedCols;
      mirror.rows = resolveMirrorBaselineRows(mirror);
    }
    deps.sendMessage(session, { type: 'title', payload: mirror.sessionName });

    if (mirror.lifecycle === 'ready') {
      ensureSessionReady(session, mirror);
      scheduleMirrorLiveSync(mirror, 0);
      return;
    }

    await startMirror(mirror, { cols: requestedCols, rows: requestedRows, autoCommand: payload.autoCommand });
  }

  function handleAdaptiveResize(session: TerminalSession, payload: { cols?: number; widthMode?: 'adaptive-phone' | 'mirror-fixed' }) {
    const mirror = deps.getSessionMirror(session);
    if (!mirror) {
      return;
    }
    const nextWidthMode = payload.widthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
    session.widthMode = nextWidthMode;
    if (nextWidthMode === 'adaptive-phone' && Number.isFinite(payload.cols) && (payload.cols || 0) > 0) {
      mirror.adaptiveCols.set(session.id, {
        cols: deps.normalizeTerminalCols(payload.cols),
        widthMode: nextWidthMode,
      });
    } else {
      mirror.adaptiveCols.delete(session.id);
    }
    reconcileMirrorAdaptiveWidth(mirror);
    scheduleMirrorLiveSync(mirror, 0);
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
      const wrote = await deps.enqueueLiveMirrorInput(mirror.sessionName, data, false, shouldWrite);
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
    ensureSessionReady,
    sendBufferHeadToSession,
    refreshMirrorHeadForSession,
    syncMirrorCanonicalBuffer,
    scheduleMirrorLiveSync,
    resolveMirrorLiveSyncDelayForSubscriber,
    startMirror,
    attachTmux,
    handleAdaptiveResize,
    handleInput,
    reconcileMirrorAdaptiveWidth,
    disposeLiveMirrorInputBatch: (sessionName, reason) =>
      deps.disposeLiveMirrorInputBatch(sessionName, `destroy:${reason}`),
  };
}
