import { useEffect, useState } from 'react';
import type { TerminalShortcutAction } from '../lib/types';
import { DEFAULT_SHORTCUT_ACTIONS, STORAGE_KEYS } from '../lib/types';

function sortShortcutActions(actions: TerminalShortcutAction[]) {
  return [...actions].sort((left, right) => {
    if (left.row !== right.row) {
      return left.row.localeCompare(right.row);
    }
    return left.order - right.order;
  });
}

function migrateLegacyQuickBarLayout(actions: TerminalShortcutAction[]) {
  const hasLegacyTopTab = actions.some((action) => action.id === 'shortcut-tab' && action.row === 'top-scroll');
  const hasLegacyBottomPaste = actions.some((action) => action.id === 'shortcut-paste' && action.row === 'bottom-scroll');

  if (!hasLegacyTopTab && !hasLegacyBottomPaste) {
    return actions;
  }

  const topIds = ['shortcut-continue', 'shortcut-esc', 'shortcut-backspace', 'shortcut-paste'];
  const bottomIds = ['shortcut-tab', 'shortcut-enter', 'shortcut-space', 'shortcut-shift-tab', 'shortcut-shift-enter'];

  const migrated = actions.map((action) => {
    if (topIds.includes(action.id)) {
      return {
        ...action,
        row: 'top-scroll' as const,
        order: topIds.indexOf(action.id),
      };
    }
    if (bottomIds.includes(action.id)) {
      return {
        ...action,
        row: 'bottom-scroll' as const,
        order: bottomIds.indexOf(action.id),
      };
    }
    return action;
  });

  return migrated;
}

function normalizeShortcutActions(input: unknown): TerminalShortcutAction[] {
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

  return filtered.length > 0 ? sortShortcutActions(migrateLegacyQuickBarLayout(filtered)) : DEFAULT_SHORTCUT_ACTIONS;
}

export function useShortcutActionStorage() {
  const [shortcutActions, setShortcutActionsState] = useState<TerminalShortcutAction[]>(DEFAULT_SHORTCUT_ACTIONS);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SHORTCUT_ACTIONS);
      if (!stored) return;
      setShortcutActionsState(normalizeShortcutActions(JSON.parse(stored)));
    } catch (error) {
      console.error('[useShortcutActionStorage] Failed to load shortcut actions:', error);
    }
  }, []);

  const setShortcutActions = (nextShortcutActions: TerminalShortcutAction[]) => {
    const sorted = sortShortcutActions(nextShortcutActions);
    setShortcutActionsState(sorted);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.SHORTCUT_ACTIONS, JSON.stringify(sorted));
    }
  };

  return {
    shortcutActions,
    setShortcutActions,
    resetShortcutActions: () => setShortcutActions(DEFAULT_SHORTCUT_ACTIONS),
  };
}
