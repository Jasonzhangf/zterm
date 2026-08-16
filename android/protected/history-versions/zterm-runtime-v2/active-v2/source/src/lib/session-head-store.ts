import { useSyncExternalStore } from 'react';
import type { SessionBufferHeadState } from '@zterm/shared/terminal/buffer-head-state';

export type { SessionBufferHeadState };

export interface SessionHeadState {
  daemonHeadRevision: number;
  daemonHeadEndIndex: number;
}

export interface SessionHeadStoreSnapshot extends SessionHeadState {
  revision: number;
}

export interface SessionHeadStore {
  /** Renderer-facing head metadata projection (versioned snapshot for useSyncExternalStore). */
  getSnapshot: (sessionId: string) => SessionHeadStoreSnapshot;
  /** Planner-facing daemon head truth. Null until a daemon head arrived on the live transport. */
  getLiveHead: (sessionId: string) => SessionBufferHeadState | null;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  /** Renderer head publish (session bootstrap / explicit metadata). Does not create live planner truth. */
  setHead: (sessionId: string, head: SessionHeadState) => boolean;
  /**
   * Single write per daemon head message arrival: records planner truth and,
   * unless publishRenderer is false, publishes the renderer head projection.
   * Returns whether the renderer-visible head changed (and was published).
   */
  setLiveHead: (
    sessionId: string,
    head: SessionBufferHeadState,
    options?: { publishRenderer?: boolean },
  ) => boolean;
  /**
   * Drop live planner truth (transport teardown) while keeping the last published
   * renderer head metadata. Does not notify renderer subscribers.
   */
  clearLiveHead: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
}

const EMPTY_HEAD: SessionHeadStoreSnapshot = {
  revision: 0,
  daemonHeadRevision: 0,
  daemonHeadEndIndex: 0,
};

interface InternalHeadRecord {
  snapshot: SessionHeadStoreSnapshot;
  liveHead: SessionBufferHeadState | null;
}

function normalizeIndex(value: number | null | undefined): number {
  return Math.max(0, Math.floor(value || 0));
}

function normalizeOptionalIndex(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

export function createSessionHeadStore(): SessionHeadStore {
  const records = new Map<string, InternalHeadRecord>();
  const listeners = new Map<string, Set<() => void>>();

  const getRecord = (sessionId: string): InternalHeadRecord => {
    return records.get(sessionId) || { snapshot: EMPTY_HEAD, liveHead: null };
  };

  const getSnapshot = (sessionId: string): SessionHeadStoreSnapshot => {
    return getRecord(sessionId).snapshot;
  };

  const getLiveHead = (sessionId: string): SessionBufferHeadState | null => {
    return getRecord(sessionId).liveHead;
  };

  const subscribe = (sessionId: string, listener: () => void) => {
    const set = listeners.get(sessionId) || new Set<() => void>();
    set.add(listener);
    listeners.set(sessionId, set);
    return () => {
      const current = listeners.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        listeners.delete(sessionId);
      }
    };
  };

  const notify = (sessionId: string) => {
    const set = listeners.get(sessionId);
    if (!set) {
      return;
    }
    for (const listener of Array.from(set)) {
      listener();
    }
  };

  const publishRendererHead = (
    sessionId: string,
    record: InternalHeadRecord,
    head: SessionHeadState,
  ): boolean => {
    const daemonHeadRevision = normalizeIndex(head.daemonHeadRevision);
    const daemonHeadEndIndex = normalizeIndex(head.daemonHeadEndIndex);
    if (
      record.snapshot.revision > 0
      && record.snapshot.daemonHeadRevision === daemonHeadRevision
      && record.snapshot.daemonHeadEndIndex === daemonHeadEndIndex
    ) {
      records.set(sessionId, record);
      return false;
    }
    records.set(sessionId, {
      ...record,
      snapshot: {
        revision: record.snapshot.revision + 1,
        daemonHeadRevision,
        daemonHeadEndIndex,
      },
    });
    notify(sessionId);
    return true;
  };

  const setHead = (sessionId: string, head: SessionHeadState) => {
    return publishRendererHead(sessionId, getRecord(sessionId), head);
  };

  const setLiveHead = (
    sessionId: string,
    head: SessionBufferHeadState,
    options?: { publishRenderer?: boolean },
  ) => {
    const record = getRecord(sessionId);
    const nextRecord: InternalHeadRecord = {
      ...record,
      liveHead: {
        revision: normalizeIndex(head.revision),
        latestEndIndex: normalizeIndex(head.latestEndIndex),
        availableStartIndex: normalizeOptionalIndex(head.availableStartIndex),
        availableEndIndex: normalizeOptionalIndex(head.availableEndIndex),
        seenAt: normalizeIndex(head.seenAt),
      },
    };
    if (options?.publishRenderer === false) {
      records.set(sessionId, nextRecord);
      return false;
    }
    return publishRendererHead(sessionId, nextRecord, {
      daemonHeadRevision: nextRecord.liveHead!.revision,
      daemonHeadEndIndex: nextRecord.liveHead!.latestEndIndex,
    });
  };

  const clearLiveHead = (sessionId: string) => {
    const record = records.get(sessionId);
    if (!record || !record.liveHead) {
      return;
    }
    records.set(sessionId, {
      ...record,
      liveHead: null,
    });
  };

  const deleteSession = (sessionId: string) => {
    records.delete(sessionId);
    notify(sessionId);
    listeners.delete(sessionId);
  };

  return {
    getSnapshot,
    getLiveHead,
    subscribe,
    setHead,
    setLiveHead,
    clearLiveHead,
    deleteSession,
  };
}

export function useSessionHeadSnapshot(store: SessionHeadStore, sessionId: string | null | undefined) {
  return useSyncExternalStore(
    (listener) => (sessionId ? store.subscribe(sessionId, listener) : () => undefined),
    () => (sessionId ? store.getSnapshot(sessionId) : EMPTY_HEAD),
    () => EMPTY_HEAD,
  );
}
