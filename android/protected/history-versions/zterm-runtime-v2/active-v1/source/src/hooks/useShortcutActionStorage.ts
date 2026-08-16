import { useCallback, useEffect, useState } from 'react';
import type { TerminalShortcutAction } from '../lib/types';
import { DEFAULT_SHORTCUT_ACTIONS, STORAGE_KEYS } from '../lib/types';
import { createDefaultShortcutActions } from '../lib/terminal-shortcut-actions';
import { normalizeShortcutActions, sortShortcutActions } from '../lib/terminal-quickbar-logic';

function loadShortcutActions(input: unknown): TerminalShortcutAction[] {
  if (!Array.isArray(input)) {
    return DEFAULT_SHORTCUT_ACTIONS;
  }

  const filtered = input.filter((item): item is TerminalShortcutAction => {
    return Boolean(
      item
      && typeof item === 'object'
      && typeof (item as TerminalShortcutAction).id === 'string'
      && typeof (item as TerminalShortcutAction).label === 'string'
      && typeof (item as TerminalShortcutAction).sequence === 'string'
      && typeof (item as TerminalShortcutAction).order === 'number'
      && ((item as TerminalShortcutAction).row === 'top-scroll' || (item as TerminalShortcutAction).row === 'bottom-scroll'),
    );
  });

  return filtered.length > 0
    ? normalizeShortcutActions(filtered)
    : createDefaultShortcutActions();
}

export function useShortcutActionStorage() {
  const [shortcutActions, setShortcutActionsState] = useState<TerminalShortcutAction[]>(DEFAULT_SHORTCUT_ACTIONS);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SHORTCUT_ACTIONS);
      if (!stored) return;
      setShortcutActionsState(loadShortcutActions(JSON.parse(stored)));
    } catch (error) {
      console.error('[useShortcutActionStorage] Failed to load shortcut actions:', error);
    }
  }, []);

  const setShortcutActions = useCallback((nextShortcutActions: TerminalShortcutAction[]) => {
    const sorted = sortShortcutActions(nextShortcutActions);
    setShortcutActionsState(sorted);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.SHORTCUT_ACTIONS, JSON.stringify(sorted));
    }
  }, []);

  const resetShortcutActions = useCallback(() => {
    setShortcutActions(DEFAULT_SHORTCUT_ACTIONS);
  }, [setShortcutActions]);

  return {
    shortcutActions,
    setShortcutActions,
    resetShortcutActions,
  };
}
