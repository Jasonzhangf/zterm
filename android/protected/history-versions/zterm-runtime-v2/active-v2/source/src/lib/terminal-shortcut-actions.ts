import type { TerminalShortcutAction } from './types';

const BUILT_IN_SHORTCUT_ACTIONS: TerminalShortcutAction[] = [
  { id: 'preset-top-scroll-esc', label: 'Esc', sequence: '\x1b', order: 0, row: 'top-scroll' },
  { id: 'preset-top-scroll-bksp', label: 'Bksp', sequence: '\x7f', order: 1, row: 'top-scroll' },
  { id: 'preset-top-scroll-tab', label: 'Tab', sequence: '\t', order: 2, row: 'top-scroll' },
  { id: 'preset-top-scroll-enter', label: 'Enter', sequence: '\r', order: 3, row: 'top-scroll' },
  { id: 'preset-top-scroll-space', label: 'Space', sequence: ' ', order: 4, row: 'top-scroll' },
  { id: 'preset-bottom-scroll-continue', label: '继续', sequence: '继续执行\r', order: 0, row: 'bottom-scroll' },
  { id: 'preset-bottom-scroll-paste', label: 'Paste', sequence: '\x16', order: 1, row: 'bottom-scroll' },
  { id: 'preset-bottom-scroll-shift-tab', label: 'S-Tab', sequence: '\x1b[Z', order: 2, row: 'bottom-scroll' },
  { id: 'preset-bottom-scroll-shift-enter', label: 'S-Enter', sequence: '\n', order: 3, row: 'bottom-scroll' },
];

const BUILT_IN_SHORTCUT_ACTION_IDS = new Set(
  BUILT_IN_SHORTCUT_ACTIONS.map((action) => action.id),
);

export function createDefaultShortcutActions() {
  return BUILT_IN_SHORTCUT_ACTIONS.map((action) => ({ ...action }));
}

export function isBuiltInShortcutAction(id: string) {
  return BUILT_IN_SHORTCUT_ACTION_IDS.has(id);
}
