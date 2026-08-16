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

import type { SessionPullPurpose } from './session-pull-state-helpers';

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

export type VisibleNonGapRepairStatus = 'pending' | 'dispatched' | 'fulfilled' | 'superseded';

export interface VisibleNonGapRepairLedgerState extends VisibleNonGapRepairRequestState {
  status: VisibleNonGapRepairStatus;
  lastDispatchAt: number;
}

export interface VisibleNonGapRepairLedgerKey {
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
  /** Record a dispatched defensive visible-window repair request for sparse non-gap refresh. */
  recordVisibleNonGapRepairRequest: (sessionId: string, state: VisibleNonGapRepairRequestState) => void;
  /** Read the exact visible repair ledger entry, or null when absent. */
  readVisibleNonGapRepair: (
    sessionId: string,
    key: VisibleNonGapRepairLedgerKey,
  ) => VisibleNonGapRepairLedgerState | null;
  /** List all visible repair ledger entries for this session. */
  listVisibleNonGapRepairs: (sessionId: string) => VisibleNonGapRepairLedgerState[];
  /** Move an exact ledger entry back to pending when the request could not enter the wire. */
  markVisibleNonGapRepairPending: (sessionId: string, key: VisibleNonGapRepairLedgerKey) => void;
  /** Mark an exact ledger entry fulfilled after a complete visible-window authoritative response. */
  markVisibleNonGapRepairFulfilled: (
    sessionId: string,
    key: VisibleNonGapRepairLedgerKey,
    fulfilledAt?: number,
  ) => void;
  /** Compatibility read for the last recorded visible repair request. */
  readVisibleNonGapRepairRequest: (sessionId: string) => VisibleNonGapRepairLedgerState | null;
  /** Drop all defensive visible-window repair ledger state for this session. */
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
  const visibleNonGapRepairRequests = new Map<string, VisibleNonGapRepairLedgerState>();

  const visibleNonGapRepairKey = (sessionId: string, key: VisibleNonGapRepairLedgerKey) => {
    const requestStartIndex = Math.max(0, Math.floor(key.requestStartIndex || 0));
    const requestEndIndex = Math.max(requestStartIndex, Math.floor(key.requestEndIndex || requestStartIndex));
    const tailEndIndex = Math.max(0, Math.floor(key.tailEndIndex || 0));
    const targetRevision = Math.max(0, Math.floor(key.targetRevision || 0));
    return `${sessionId}:${requestStartIndex}:${requestEndIndex}:${tailEndIndex}:${targetRevision}`;
  };

  const normalizeVisibleNonGapRepairState = (
    state: VisibleNonGapRepairRequestState,
  ): VisibleNonGapRepairLedgerState => {
    const requestStartIndex = Math.max(0, Math.floor(state.requestStartIndex || 0));
    const requestEndIndex = Math.max(requestStartIndex, Math.floor(state.requestEndIndex || requestStartIndex));
    const tailEndIndex = Math.max(0, Math.floor(state.tailEndIndex || 0));
    const targetRevision = Math.max(0, Math.floor(state.targetRevision || 0));
    const requestedAt = Math.max(0, Math.floor(state.requestedAt || 0));
    return {
      requestedAt,
      requestStartIndex,
      requestEndIndex,
      tailEndIndex,
      targetRevision,
      status: 'dispatched',
      lastDispatchAt: requestedAt,
    };
  };

  const supersedeVisibleNonGapRepairKeys = (sessionId: string, key: string) => {
    for (const [entryKey, entry] of visibleNonGapRepairRequests.entries()) {
      if (entryKey === key || !entryKey.startsWith(`${sessionId}:`)) continue;
      if (entry.status !== 'fulfilled' && entry.status !== 'superseded') {
        visibleNonGapRepairRequests.set(entryKey, { ...entry, status: 'superseded' });
      }
    }
  };

  const evictVisibleNonGapRepairLedger = (sessionId: string) => {
    const entries = Array.from(visibleNonGapRepairRequests.entries())
      .filter(([key]) => key.startsWith(`${sessionId}:`));
    if (entries.length <= 64) return;

    const excess = entries.length - 64;
    const byRequestedAt = (
      left: [string, VisibleNonGapRepairLedgerState],
      right: [string, VisibleNonGapRepairLedgerState],
    ) => left[1].requestedAt - right[1].requestedAt;
    const terminalEntries = entries
      .filter(([, entry]) => entry.status === 'fulfilled' || entry.status === 'superseded')
      .sort(byRequestedAt);
    const removable = terminalEntries.slice(0, excess);
    const removedCount = removable.length;
    if (removedCount < excess) {
      const activeEntries = entries
        .filter(([, entry]) => entry.status !== 'fulfilled' && entry.status !== 'superseded')
        .sort(byRequestedAt);
      removable.push(...activeEntries.slice(0, excess - removedCount));
    }
    for (const [key] of removable) {
      visibleNonGapRepairRequests.delete(key);
    }
  };

  const listVisibleNonGapRepairsForSession = (sessionId: string) => {
    const prefix = `${sessionId}:`;
    return Array.from(visibleNonGapRepairRequests.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => entry);
  };

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
      const next = normalizeVisibleNonGapRepairState(state);
      const key = visibleNonGapRepairKey(sessionId, next);
      visibleNonGapRepairRequests.set(key, {
        ...next,
        status: 'dispatched',
        lastDispatchAt: next.requestedAt,
      });
      supersedeVisibleNonGapRepairKeys(sessionId, key);
      evictVisibleNonGapRepairLedger(sessionId);
    },
    readVisibleNonGapRepair: (sessionId, key) =>
      visibleNonGapRepairRequests.get(visibleNonGapRepairKey(sessionId, key)) || null,
    listVisibleNonGapRepairs: (sessionId) =>
      listVisibleNonGapRepairsForSession(sessionId),
    markVisibleNonGapRepairPending: (sessionId, key) => {
      const entryKey = visibleNonGapRepairKey(sessionId, key);
      const previous = visibleNonGapRepairRequests.get(entryKey);
      visibleNonGapRepairRequests.set(entryKey, {
        requestedAt: previous?.requestedAt ?? Date.now(),
        requestStartIndex: Math.max(0, Math.floor(key.requestStartIndex || 0)),
        requestEndIndex: Math.max(
          Math.max(0, Math.floor(key.requestStartIndex || 0)),
          Math.floor(key.requestEndIndex || key.requestStartIndex || 0),
        ),
        tailEndIndex: Math.max(0, Math.floor(key.tailEndIndex || 0)),
        targetRevision: Math.max(0, Math.floor(key.targetRevision || 0)),
        status: 'pending',
        lastDispatchAt: previous?.lastDispatchAt || 0,
      });
      supersedeVisibleNonGapRepairKeys(sessionId, entryKey);
      evictVisibleNonGapRepairLedger(sessionId);
    },
    markVisibleNonGapRepairFulfilled: (sessionId, key, fulfilledAt) => {
      const entryKey = visibleNonGapRepairKey(sessionId, key);
      const previous = visibleNonGapRepairRequests.get(entryKey);
      const now = Math.max(0, Math.floor(fulfilledAt ?? Date.now()));
      visibleNonGapRepairRequests.set(entryKey, {
        requestedAt: previous?.requestedAt ?? now,
        requestStartIndex: Math.max(0, Math.floor(key.requestStartIndex || 0)),
        requestEndIndex: Math.max(
          Math.max(0, Math.floor(key.requestStartIndex || 0)),
          Math.floor(key.requestEndIndex || key.requestStartIndex || 0),
        ),
        tailEndIndex: Math.max(0, Math.floor(key.tailEndIndex || 0)),
        targetRevision: Math.max(0, Math.floor(key.targetRevision || 0)),
        status: 'fulfilled',
        lastDispatchAt: previous?.lastDispatchAt || 0,
      });
      evictVisibleNonGapRepairLedger(sessionId);
    },
    readVisibleNonGapRepairRequest: (sessionId) => {
      const matching = listVisibleNonGapRepairsForSession(sessionId).sort((left, right) => left.requestedAt - right.requestedAt);
      return matching[matching.length - 1] || null;
    },
    clearVisibleNonGapRepairRequest: (sessionId) => {
      for (const key of visibleNonGapRepairRequests.keys()) {
        if (key.startsWith(`${sessionId}:`)) {
          visibleNonGapRepairRequests.delete(key);
        }
      }
    },
    deleteSession: (sessionId) => {
      clearPendingTailRefreshMarks(sessionId);
      for (const key of visibleNonGapRepairRequests.keys()) {
        if (key.startsWith(`${sessionId}:`)) {
          visibleNonGapRepairRequests.delete(key);
        }
      }
    },
  };
}
