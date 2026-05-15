import { useCallback, useEffect, useRef } from 'react';
import { STORAGE_KEYS, type SessionDraftMap } from '../lib/types';

function normalizeDraftMap(input: unknown): SessionDraftMap {
  if (!input || typeof input !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([key, value]) => key.trim().length > 0 && typeof value === 'string'),
  ) as SessionDraftMap;
}

export function useSessionDraftStorage() {
  const draftsRef = useRef<SessionDraftMap>({});
  const persist = useCallback((next: SessionDraftMap) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.SESSION_DRAFTS, JSON.stringify(next));
    }
  }, []);

  // Stable callbacks — mutations write to ref, never trigger re-render.
  const setDraft = useCallback((sessionId: string, value: string) => {
    const next: SessionDraftMap = {
      ...draftsRef.current,
      [sessionId]: value,
    };
    draftsRef.current = next;
    persist(next);
  }, [persist]);

  const clearDraft = useCallback((sessionId: string) => {
    const next = { ...draftsRef.current };
    delete next[sessionId];
    draftsRef.current = next;
    persist(next);
  }, [persist]);

  const pruneDrafts = useCallback((validSessionIds: string[]) => {
    const valid = new Set(validSessionIds);
    const next = Object.fromEntries(
      Object.entries(draftsRef.current).filter(([sessionId]) => valid.has(sessionId)),
    );
    if (Object.keys(next).length !== Object.keys(draftsRef.current).length) {
      draftsRef.current = next;
      persist(next);
    }
  }, [persist]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SESSION_DRAFTS);
      if (stored) {
        draftsRef.current = normalizeDraftMap(JSON.parse(stored));
      }
    } catch (error) {
      console.error('[useSessionDraftStorage] Failed to load drafts:', error);
    }
  }, []);

  return {
    drafts: draftsRef.current,
    setDraft,
    clearDraft,
    pruneDrafts,
  };
}
