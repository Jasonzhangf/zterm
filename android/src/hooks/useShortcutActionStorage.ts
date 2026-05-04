import { useCallback, useEffect, useState } from 'react';
import type { TerminalShortcutAction } from '../lib/types';
import { DEFAULT_SHORTCUT_ACTIONS, STORAGE_KEYS } from '../lib/types';
import { buildTerminalShortcutSequence, buildTerminalShortcutTokensFromSequence } from '../../../packages/shared/src/shortcuts/terminal-shortcut-composer';

const SHORTCUT_PRESETS = [
  { label: 'Esc', sequence: '\x1b', kind: 'key' as const },
  { label: 'Bksp', sequence: '\x7f', kind: 'key' as const },
  { label: 'Tab', sequence: '\t', kind: 'key' as const },
  { label: 'Enter', sequence: '\r', kind: 'key' as const },
  { label: 'Space', sequence: ' ', kind: 'key' as const },
  { label: '继续', sequence: '继续执行\r', kind: 'text' as const },
  { label: 'Paste', sequence: '\x16', kind: 'text' as const },
  { label: 'S-Tab', sequence: '\x1b[Z', kind: 'text' as const },
  { label: 'S-Enter', sequence: '\n', kind: 'text' as const },
  { label: '↑', sequence: '\x1b[A', kind: 'key' as const },
  { label: '↓', sequence: '\x1b[B', kind: 'key' as const },
  { label: '←', sequence: '\x1b[D', kind: 'key' as const },
  { label: '→', sequence: '\x1b[C', kind: 'key' as const },
];

const ROW_ORDER: Array<TerminalShortcutAction['row']> = ['top-scroll', 'bottom-scroll'];

function isSingleShortcutToken(token: { kind?: 'modifier' | 'key' | 'text'; sequence: string }) {
  if (token.kind === 'modifier') {
    return false;
  }
  if (token.kind === 'key') {
    return true;
  }
  if (token.kind === 'text') {
    return token.sequence.length === 1;
  }
  return token.sequence.length === 1 && !/[\x00-\x1f]/.test(token.sequence);
}

function inferShortcutRow(action: Pick<TerminalShortcutAction, 'label' | 'sequence'>): TerminalShortcutAction['row'] {
  const tokens = buildTerminalShortcutTokensFromSequence(action.label, action.sequence, SHORTCUT_PRESETS);
  const built = buildTerminalShortcutSequence(tokens);
  if (built.error) {
    return 'bottom-scroll';
  }
  if (tokens.length === 1 && isSingleShortcutToken(tokens[0])) {
    return 'top-scroll';
  }
  return 'bottom-scroll';
}

function sortShortcutActions(actions: TerminalShortcutAction[]) {
  return [...actions].sort((left, right) => {
    if (left.row !== right.row) {
      return ROW_ORDER.indexOf(left.row) - ROW_ORDER.indexOf(right.row);
    }
    return left.order - right.order;
  });
}

function normalizeShortcutRows(actions: TerminalShortcutAction[]) {
  const grouped = new Map<TerminalShortcutAction['row'], TerminalShortcutAction[]>();
  grouped.set('top-scroll', []);
  grouped.set('bottom-scroll', []);

  actions.forEach((action) => {
    const row = inferShortcutRow(action);
    grouped.get(row)?.push({
      ...action,
      row,
    });
  });

  return ROW_ORDER.flatMap((row) =>
    (grouped.get(row) || []).map((action, index) => ({
      ...action,
      row,
      order: index,
    })),
  );
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

  return filtered.length > 0 ? sortShortcutActions(normalizeShortcutRows(filtered)) : DEFAULT_SHORTCUT_ACTIONS;
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
