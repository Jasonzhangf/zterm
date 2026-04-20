import { useCallback, useEffect, useState } from 'react';
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
  const [drafts, setDrafts] = useState<SessionDraftMap>({});

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SESSION_DRAFTS);
      if (!stored) {
        return;
      }
      setDrafts(normalizeDraftMap(JSON.parse(stored)));
    } catch (error) {
      console.error('[useSessionDraftStorage] Failed to load drafts:', error);
    }
  }, []);

  const setDraft = useCallback((sessionId: string, value: string) => {
    setDrafts((current) => {
      const next = {
        ...current,
        [sessionId]: value,
      };
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.SESSION_DRAFTS, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const clearDraft = useCallback((sessionId: string) => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[sessionId];
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.SESSION_DRAFTS, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  const pruneDrafts = useCallback((validSessionIds: string[]) => {
    const valid = new Set(validSessionIds);
    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => valid.has(sessionId)),
      );
      if (Object.keys(next).length !== Object.keys(current).length && typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.SESSION_DRAFTS, JSON.stringify(next));
      }
      return Object.keys(next).length !== Object.keys(current).length ? next : current;
    });
  }, []);

  return {
    drafts,
    setDraft,
    clearDraft,
    pruneDrafts,
  };
}
