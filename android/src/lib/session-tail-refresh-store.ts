/**
 * Session tail-refresh store (T2b refs 收敛).
 *
 * Owns the four tail-refresh maps/sets that previously lived as separate
 * useRef bags in session-context-provider-runtime:
 * - pending input tail refresh marks (sessionId -> { requestedAt, localRevision }),
 *   marked when local input is sent and consumed once the applied buffer
 *   revision has advanced past the marked local revision
 * - pending connect tail refresh marks (Set semantics), marked on socket
 *   connected baseline and consumed on the first buffer apply that moves the
 *   tail or revision
 * - pending resume tail refresh marks (Set semantics), marked on explicit
 *   resume / active reentry and consumed like connect marks
 * - buffer-sync request debounce state, keyed per (sessionId, pull purpose)
 *   with the previously untyped `Map<string, any>` now pinned to
 *   {@link SessionSyncRequestDebounceState}
 *
 * The store only holds state; when to mark and when to consume stays with the
 * buffer/pull runtimes (pre-store trigger semantics unchanged). `deleteSession`
 * is the session-close teardown: it drops the three pending marks and
 * intentionally leaves debounce entries untouched — the pre-store close path
 * never cleared `lastSyncRequestAt`, and those entries are consulted without a
 * time bound by the same-revision overwrite authorization, so dropping them
 * here would change behavior for re-created session ids (same pattern as
 * session-heartbeat-store leaving terminal activity untouched). Debounce
 * entries are cleared only by their explicit reset paths
 * (`clearSyncRequest`, pull bookkeeping reset).
 *
 * No React dependency (same pattern as session-heartbeat-store.ts).
 */

import type { SessionPullPurpose } from '../contexts/session-pull-state-helpers';

export interface PendingInputTailRefreshState {
  requestedAt: number;
  localRevision: number;
}

export interface SessionSyncRequestDebounceState {
  sentAt: number;
  requestStartIndex: number;
  requestEndIndex: number;
  knownRevision: number;
  localStartIndex: number;
  localEndIndex: number;
  targetHeadRevision: number;
  repairSignature: string;
}

export interface VisibleNonGapRepairRequestState {
  requestedAt: number;
  requestStartIndex: number;
  requestEndIndex: number;
  tailEndIndex: number;
  targetRevision: number;
}

export interface SessionTailRefreshStore {
  /**
   * Mark that local input was sent and a tail refresh is expected.
   * `requestedAt` defaults to Date.now(). Returns true when the session was
   * not already marked (first pending input for this session).
   */
  markPendingInputTailRefresh: (sessionId: string, localRevision: number, requestedAt?: number) => boolean;
  /** Pending input tail refresh mark, or null when none is held. */
  readPendingInputTailRefresh: (sessionId: string) => PendingInputTailRefreshState | null;
  hasPendingInputTailRefresh: (sessionId: string) => boolean;
  /** Consume the pending input tail refresh mark. */
  clearPendingInputTailRefresh: (sessionId: string) => void;
  /** Mark that a connected baseline expects a tail refresh. */
  markPendingConnectTailRefresh: (sessionId: string) => void;
  hasPendingConnectTailRefresh: (sessionId: string) => boolean;
  /** Consume the pending connect tail refresh mark. */
  clearPendingConnectTailRefresh: (sessionId: string) => void;
  /** Mark that a resume/active-reentry expects a tail refresh. */
  markPendingResumeTailRefresh: (sessionId: string) => void;
  hasPendingResumeTailRefresh: (sessionId: string) => boolean;
  /** Consume the pending resume tail refresh mark. */
  clearPendingResumeTailRefresh: (sessionId: string) => void;
  /**
   * Drop all three pending marks for a session without touching debounce
   * state (inactive-drop / clear-tail-refresh / stream-truth reset paths).
   */
  clearPendingTailRefreshMarks: (sessionId: string) => void;
  /** Record the buffer-sync request debounce state for (sessionId, purpose). */
  recordSyncRequest: (
    sessionId: string,
    purpose: SessionPullPurpose,
    state: SessionSyncRequestDebounceState,
  ) => void;
  /** Last recorded buffer-sync request for (sessionId, purpose), or null. */
  readSyncRequest: (sessionId: string, purpose: SessionPullPurpose) => SessionSyncRequestDebounceState | null;
  hasSyncRequest: (sessionId: string, purpose: SessionPullPurpose) => boolean;
  /** Drop the recorded buffer-sync request for (sessionId, purpose). */
  clearSyncRequest: (sessionId: string, purpose: SessionPullPurpose) => void;
  /** Record the last defensive visible-window repair request for sparse non-gap refresh. */
  recordVisibleNonGapRepairRequest: (sessionId: string, state: VisibleNonGapRepairRequestState) => void;
  /** Last defensive visible-window repair request, or null when none is held. */
  readVisibleNonGapRepairRequest: (sessionId: string) => VisibleNonGapRepairRequestState | null;
  /** Drop defensive visible-window repair guard state for this session. */
  clearVisibleNonGapRepairRequest: (sessionId: string) => void;
  /**
   * Session-close teardown: drop the three pending marks. Intentionally leaves
   * debounce entries untouched (pre-store close semantics — see module doc).
   */
  deleteSession: (sessionId: string) => void;
}

function syncRequestKey(sessionId: string, purpose: SessionPullPurpose) {
  return `${sessionId}:${purpose}`;
}

export function createSessionTailRefreshStore(): SessionTailRefreshStore {
  const pendingInputTailRefresh = new Map<string, PendingInputTailRefreshState>();
  const pendingConnectTailRefresh = new Set<string>();
  const pendingResumeTailRefresh = new Set<string>();
  const syncRequests = new Map<string, SessionSyncRequestDebounceState>();
  const visibleNonGapRepairRequests = new Map<string, VisibleNonGapRepairRequestState>();

  const clearPendingTailRefreshMarks = (sessionId: string) => {
    pendingInputTailRefresh.delete(sessionId);
    pendingConnectTailRefresh.delete(sessionId);
    pendingResumeTailRefresh.delete(sessionId);
  };

  return {
    markPendingInputTailRefresh: (sessionId, localRevision, requestedAt) => {
      const wasPending = pendingInputTailRefresh.has(sessionId);
      pendingInputTailRefresh.set(sessionId, {
        requestedAt: requestedAt ?? Date.now(),
        localRevision: Math.max(0, Math.floor(localRevision || 0)),
      });
      return !wasPending;
    },
    readPendingInputTailRefresh: (sessionId) => pendingInputTailRefresh.get(sessionId) || null,
    hasPendingInputTailRefresh: (sessionId) => pendingInputTailRefresh.has(sessionId),
    clearPendingInputTailRefresh: (sessionId) => {
      pendingInputTailRefresh.delete(sessionId);
    },
    markPendingConnectTailRefresh: (sessionId) => {
      pendingConnectTailRefresh.add(sessionId);
    },
    hasPendingConnectTailRefresh: (sessionId) => pendingConnectTailRefresh.has(sessionId),
    clearPendingConnectTailRefresh: (sessionId) => {
      pendingConnectTailRefresh.delete(sessionId);
    },
    markPendingResumeTailRefresh: (sessionId) => {
      pendingResumeTailRefresh.add(sessionId);
    },
    hasPendingResumeTailRefresh: (sessionId) => pendingResumeTailRefresh.has(sessionId),
    clearPendingResumeTailRefresh: (sessionId) => {
      pendingResumeTailRefresh.delete(sessionId);
    },
    clearPendingTailRefreshMarks,
    recordSyncRequest: (sessionId, purpose, state) => {
      syncRequests.set(syncRequestKey(sessionId, purpose), state);
    },
    readSyncRequest: (sessionId, purpose) => syncRequests.get(syncRequestKey(sessionId, purpose)) || null,
    hasSyncRequest: (sessionId, purpose) => syncRequests.has(syncRequestKey(sessionId, purpose)),
    clearSyncRequest: (sessionId, purpose) => {
      syncRequests.delete(syncRequestKey(sessionId, purpose));
    },
    recordVisibleNonGapRepairRequest: (sessionId, state) => {
      const requestStartIndex = Math.max(0, Math.floor(state.requestStartIndex || 0));
      const requestEndIndex = Math.max(requestStartIndex, Math.floor(state.requestEndIndex || requestStartIndex));
      visibleNonGapRepairRequests.set(sessionId, {
        requestedAt: Math.max(0, Math.floor(state.requestedAt || 0)),
        requestStartIndex,
        requestEndIndex,
        tailEndIndex: Math.max(0, Math.floor(state.tailEndIndex || 0)),
        targetRevision: Math.max(0, Math.floor(state.targetRevision || 0)),
      });
    },
    readVisibleNonGapRepairRequest: (sessionId) => visibleNonGapRepairRequests.get(sessionId) || null,
    clearVisibleNonGapRepairRequest: (sessionId) => {
      visibleNonGapRepairRequests.delete(sessionId);
    },
    deleteSession: (sessionId) => {
      clearPendingTailRefreshMarks(sessionId);
      visibleNonGapRepairRequests.delete(sessionId);
    },
  };
}
