import { useCallback, useEffect, useState } from 'react';
import type { QuickAction } from '../lib/types';
import { DEFAULT_QUICK_ACTIONS, STORAGE_KEYS } from '../lib/types';

function sortQuickActions(actions: QuickAction[]) {
  return [...actions].sort((left, right) => left.order - right.order);
}

export function useQuickActionStorage() {
  const [quickActions, setQuickActionsState] = useState<QuickAction[]>(DEFAULT_QUICK_ACTIONS);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(STORAGE_KEYS.QUICK_ACTIONS);
      if (!stored) return;

      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        setQuickActionsState(sortQuickActions(parsed));
      }
    } catch (error) {
      console.error('[useQuickActionStorage] Failed to load quick actions:', error);
    }
  }, []);

  const setQuickActions = useCallback((nextQuickActions: QuickAction[]) => {
    const sorted = sortQuickActions(nextQuickActions);
    setQuickActionsState(sorted);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.QUICK_ACTIONS, JSON.stringify(sorted));
    }
  }, []);

  const resetQuickActions = useCallback(() => {
    setQuickActions(DEFAULT_QUICK_ACTIONS);
  }, [setQuickActions]);

  return {
    quickActions,
    setQuickActions,
    resetQuickActions,
  };
}
