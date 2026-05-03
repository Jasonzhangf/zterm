import { mobileTheme } from '../../lib/mobile-ui';
import type { QuickAction, TerminalShortcutAction } from '../../lib/types';
import {
  buildTerminalShortcutSequence,
  buildTerminalShortcutTokensFromSequence,
  resolveTerminalShortcutLabel,
  type TerminalShortcutToken,
} from '../../../../packages/shared/src/shortcuts/terminal-shortcut-composer';

export const FLOATING_BUBBLE_SIZE = 48;
export const FLOATING_BUBBLE_MARGIN = 10;
export const FLOATING_BUBBLE_DRAG_THRESHOLD_PX = 8;
export const QUICK_BAR_SIDE_PADDING = 6;
export const QUICK_BAR_ROW_GAP = 4;
export const QUICK_BAR_FIXED_COLUMNS = 3;
export const FIXED_BUTTON_MIN_WIDTH = 48;
export const FIXED_CLUSTER_PADDING_X = 3;
export const REPEATABLE_ACTION_LONG_PRESS_MS = 420;
export const REPEATABLE_ACTION_REPEAT_MS = 90;
export const CLIPBOARD_HISTORY_STORAGE_KEY = 'zterm:clipboard-history';
export const MAX_CLIPBOARD_HISTORY = 100;
export const FLOATING_BUBBLE_POSITION_STORAGE_KEY = 'zterm:floating-bubble-position';

export type FloatingPanelTab = 'quick-actions' | 'clipboard';
export type ShortcutToken = TerminalShortcutToken;
export type ShortcutEditorTab = 'keyboard' | 'common';
export type ShortcutEditorMode = 'list' | 'form';
export type ShortcutRow = 'top-scroll' | 'bottom-scroll';

export interface DraftQuickAction extends QuickAction {
  textInput: string;
}

export interface DraftShortcutAction extends TerminalShortcutAction {}

export interface ShortcutPreset extends ShortcutToken {
  row?: 'top-scroll' | 'bottom-scroll';
}

export const SHORTCUT_ROW_ORDER: ShortcutRow[] = ['top-scroll', 'bottom-scroll'];

export const SHORTCUT_ROW_META: Record<
  ShortcutRow,
  {
    title: string;
    summary: string;
    addLabel: string;
    formTag: string;
    formHint: string;
    inputPlaceholder: string;
  }
> = {
  'top-scroll': {
    title: '第二行（单按键）',
    summary: 'Esc / Tab / Enter / Space / 单个字符',
    addLabel: '+ 添加单按键',
    formTag: '当前编辑：第二行单按键',
    formHint: '这里只放单个按键，不支持 Ctrl / Shift 等组合。',
    inputPlaceholder: '输入单个字母/数字/符号',
  },
  'bottom-scroll': {
    title: '第三行（组合键）',
    summary: 'Ctrl + C / Shift + Tab / Continue / Paste',
    addLabel: '+ 添加组合键',
    formTag: '当前编辑：第三行组合键',
    formHint: '这里放组合键或复合动作，单按键请放到第二行。',
    inputPlaceholder: '输入组合键里的目标字符，例如 c',
  },
};

export const SHORTCUT_PRESETS: ShortcutPreset[] = [
  { label: 'Esc', sequence: '\x1b', kind: 'key', row: 'top-scroll' },
  { label: 'Bksp', sequence: '\x7f', kind: 'key', row: 'top-scroll' },
  { label: 'Tab', sequence: '\t', kind: 'key', row: 'top-scroll' },
  { label: 'Enter', sequence: '\r', kind: 'key', row: 'top-scroll' },
  { label: 'Space', sequence: ' ', kind: 'key', row: 'top-scroll' },
  { label: '继续', sequence: '继续执行\r', kind: 'text', row: 'bottom-scroll' },
  { label: 'Paste', sequence: '\x16', kind: 'text', row: 'bottom-scroll' },
  { label: 'S-Tab', sequence: '\x1b[Z', kind: 'text', row: 'bottom-scroll' },
  { label: 'S-Enter', sequence: '\n', kind: 'text', row: 'bottom-scroll' },
];

export const SHORTCUT_KEYBOARD_TOKENS: ShortcutToken[] = [
  { label: 'Ctrl', sequence: '__CTRL__', kind: 'modifier' },
  { label: 'Option', sequence: '__OPTION__', kind: 'modifier' },
  { label: 'Command', sequence: '__COMMAND__', kind: 'modifier' },
  { label: 'Shift', sequence: '__SHIFT__', kind: 'modifier' },
  { label: 'Tab', sequence: '\t', kind: 'key' },
  { label: 'Esc', sequence: '\x1b', kind: 'key' },
  { label: 'Return', sequence: '\r', kind: 'key' },
  { label: 'Space', sequence: ' ', kind: 'key' },
  { label: 'Delete', sequence: '\x7f', kind: 'key' },
  { label: 'F1', sequence: '\x1bOP', kind: 'key' },
  { label: 'F2', sequence: '\x1bOQ', kind: 'key' },
  { label: 'F3', sequence: '\x1bOR', kind: 'key' },
  { label: ',', sequence: ',', kind: 'text' },
  { label: '.', sequence: '.', kind: 'text' },
  { label: '/', sequence: '/', kind: 'text' },
  { label: 'F4', sequence: '\x1bOS', kind: 'key' },
  { label: 'F5', sequence: '\x1b[15~', kind: 'key' },
  { label: 'F6', sequence: '\x1b[17~', kind: 'key' },
  { label: '-', sequence: '-', kind: 'text' },
  { label: '↑', sequence: '\x1b[A', kind: 'key' },
  { label: '+', sequence: '+', kind: 'text' },
  { label: 'F7', sequence: '\x1b[18~', kind: 'key' },
  { label: 'F8', sequence: '\x1b[19~', kind: 'key' },
  { label: 'F9', sequence: '\x1b[20~', kind: 'key' },
  { label: '←', sequence: '\x1b[D', kind: 'key' },
  { label: '↓', sequence: '\x1b[B', kind: 'key' },
  { label: '→', sequence: '\x1b[C', kind: 'key' },
  { label: 'F10', sequence: '\x1b[21~', kind: 'key' },
  { label: 'F11', sequence: '\x1b[23~', kind: 'key' },
  { label: 'F12', sequence: '\x1b[24~', kind: 'key' },
];

export const SHORTCUT_COMMON_TOKENS: ShortcutToken[] = [
  { label: '继续', sequence: '继续执行\r', kind: 'text' },
  { label: 'Cmd+V', sequence: '\x16', kind: 'text' },
  { label: 'Bksp', sequence: '\x7f', kind: 'key' },
  { label: 'Esc', sequence: '\x1b', kind: 'key' },
  { label: 'Tab', sequence: '\t', kind: 'key' },
  { label: 'Enter', sequence: '\r', kind: 'key' },
  { label: 'Space', sequence: ' ', kind: 'key' },
  { label: 'S-Tab', sequence: '\x1b[Z', kind: 'key' },
  { label: 'S-Enter', sequence: '\n', kind: 'key' },
  { label: '↑', sequence: '\x1b[A', kind: 'key' },
  { label: '↓', sequence: '\x1b[B', kind: 'key' },
  { label: '←', sequence: '\x1b[D', kind: 'key' },
  { label: '→', sequence: '\x1b[C', kind: 'key' },
];

const SIMPLE_SHORTCUT_PRESET_SEQUENCES = new Set([
  '\x1b', '\x7f', '\t', '\r', ' ',
  '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D',
  '\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS',
  '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~',
]);

const MOBILE_SHORTCUT_TOKEN_DISPLAY_LABELS: Record<string, string> = {
  Option: 'Opt',
  Command: 'Cmd',
  Return: 'Enter',
  Delete: 'Del',
};

const SHORTCUT_VISUAL_LABELS: Record<string, string> = {
  Esc: 'Esc',
  Tab: 'Tab',
  Enter: '↩',
  Return: '↩',
  Space: 'Space',
  Bksp: '⌫',
  Delete: '⌫',
  Ctrl: 'Ctrl',
  Control: 'Ctrl',
  Shift: 'Shift',
  Option: 'Opt',
  Opt: 'Opt',
  Alt: 'Alt',
  Command: 'Cmd',
  Cmd: 'Cmd',
  'S-Tab': '⇧ Tab',
  'S-Enter': '⇧ ↩',
};

export function editorInputStyle() {
  return {
    width: '100%',
    minHeight: '44px',
    padding: '10px 12px',
    borderRadius: '14px',
    border: '1px solid rgba(255,255,255,0.12)',
    backgroundColor: '#1f2437',
    color: '#fff',
    fontSize: '14px',
  } as const;
}

export function lightEditorInputStyle() {
  return {
    ...editorInputStyle(),
    backgroundColor: '#f4f6fb',
    border: '1px solid rgba(23, 27, 45, 0.1)',
    color: mobileTheme.colors.lightText,
  } as const;
}

export function resolveShortcutTokenDisplayLabel(label: string) {
  return MOBILE_SHORTCUT_TOKEN_DISPLAY_LABELS[label] || label;
}

export function resolveShortcutVisualLabel(label: string) {
  const normalized = resolveShortcutTokenDisplayLabel(label);
  return SHORTCUT_VISUAL_LABELS[label] || SHORTCUT_VISUAL_LABELS[normalized] || normalized;
}

export function isSpaceShortcutLabel(label: string) {
  return resolveShortcutTokenDisplayLabel(label) === 'Space';
}

export function shouldRenderShortcutKeycap(label: string) {
  const normalized = resolveShortcutTokenDisplayLabel(label);
  return isSpaceShortcutLabel(label) || Object.prototype.hasOwnProperty.call(SHORTCUT_VISUAL_LABELS, label) || Object.prototype.hasOwnProperty.call(SHORTCUT_VISUAL_LABELS, normalized);
}

export function renderShortcutVisualNode(label: string, variant: 'button' | 'list' | 'token' = 'button') {
  if (!shouldRenderShortcutKeycap(label)) {
    return resolveShortcutVisualLabel(label);
  }

  const metrics = variant === 'list'
    ? { minWidth: '44px', height: '30px', padding: '0 12px', borderWidth: '2px', fontSize: '18px', fontWeight: 800, radius: '10px' }
    : variant === 'token'
      ? { minWidth: '34px', height: '24px', padding: '0 8px', borderWidth: '1.8px', fontSize: '13px', fontWeight: 800, radius: '8px' }
      : { minWidth: '30px', height: '22px', padding: '0 8px', borderWidth: '1.8px', fontSize: '13px', fontWeight: 800, radius: '8px' };

  if (isSpaceShortcutLabel(label)) {
    const spaceMetrics = variant === 'list'
      ? { width: '52px', height: '20px' }
      : variant === 'token'
        ? { width: '40px', height: '18px' }
        : { width: '38px', height: '16px' };

    return (
      <span data-shortcut-keycap="space" data-shortcut-space-visual="true" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: spaceMetrics.width, height: spaceMetrics.height, borderRadius: variant === 'list' ? '10px' : '8px', border: `${metrics.borderWidth} solid currentColor`, boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.12)' }}>
        <span style={{ display: 'block', width: variant === 'list' ? '28px' : variant === 'token' ? '22px' : '20px', height: variant === 'list' ? '3px' : '2.5px', borderRadius: '999px', backgroundColor: 'currentColor', opacity: 0.92 }} />
      </span>
    );
  }

  return (
    <span data-shortcut-keycap={resolveShortcutTokenDisplayLabel(label)} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: metrics.minWidth, height: metrics.height, padding: metrics.padding, borderRadius: metrics.radius, border: `${metrics.borderWidth} solid currentColor`, boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.12)', fontSize: metrics.fontSize, fontWeight: metrics.fontWeight, letterSpacing: resolveShortcutVisualLabel(label).length > 2 ? '-0.01em' : 0, lineHeight: 1, whiteSpace: 'nowrap' }}>
      {resolveShortcutVisualLabel(label)}
    </span>
  );
}

export function formatSnippetPreview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 24);
}

export function formatShortcutSequencePreview(label: string, sequence: string) {
  const tokens = buildTerminalShortcutTokensFromSequence(label, sequence, SHORTCUT_PRESETS);
  if (tokens.length > 0) {
    return tokens.map((token) => resolveShortcutVisualLabel(token.label)).join(tokens.length > 1 ? ' ' : '').trim();
  }
  return formatSnippetPreview(sequence);
}

export function resolveShortcutDisplayMeta(label: string, sequence: string) {
  const normalizedLabel = resolveShortcutTokenDisplayLabel(label || '');
  const visualLabel = resolveShortcutVisualLabel(label || '');
  const preview = formatShortcutSequencePreview(label || '', sequence);
  const titleUsesKeycap = Boolean(label) && shouldRenderShortcutKeycap(label);

  if (!label) {
    return { title: '未命名', subtitle: preview || '(空)', titleUsesKeycap: false, titleSourceLabel: '' };
  }
  if (titleUsesKeycap) {
    return {
      title: visualLabel,
      subtitle: isSpaceShortcutLabel(label) ? normalizedLabel : '',
      titleUsesKeycap: true,
      titleSourceLabel: normalizedLabel,
    };
  }
  return {
    title: label,
    subtitle: preview || '(空)',
    titleUsesKeycap: false,
    titleSourceLabel: label,
  };
}

export function createDraftActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `quick-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function toDraftActions(actions: QuickAction[]): DraftQuickAction[] {
  return actions.map((action) => ({ ...action, textInput: action.sequence.replace(/\r/g, '\n') }));
}

export function normalizeDraftActions(actions: DraftQuickAction[]): QuickAction[] {
  return actions.map(({ textInput, ...action }, index) => ({ ...action, order: index, sequence: textInput.replace(/\r?\n/g, '\r') }));
}

export function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex || toIndex < 0 || toIndex >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export function moveShortcutActionWithinRow(
  actions: DraftShortcutAction[],
  row: ShortcutRow,
  fromIndex: number,
  toIndex: number,
) {
  const rowItems = actions.filter((action) => action.row === row);
  if (fromIndex === toIndex || toIndex < 0 || toIndex >= rowItems.length) {
    return actions;
  }
  const movedRowItems = moveItem(rowItems, fromIndex, toIndex);
  const rowQueues = new Map<string, DraftShortcutAction[]>();
  rowQueues.set(row, [...movedRowItems]);
  return actions.map((action) => (action.row !== row ? action : rowQueues.get(row)?.shift() || action));
}

export function blurCurrentTarget(target: EventTarget | null) {
  if (target instanceof HTMLButtonElement) {
    target.blur();
  }
}

export function normalizeClipboardHistory(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is string => typeof item === 'string').filter((item) => item.length > 0).slice(0, MAX_CLIPBOARD_HISTORY);
}

export function dedupeClipboardHistory(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.length > 0))).slice(0, MAX_CLIPBOARD_HISTORY);
}

export function readStoredBubblePosition() {
  if (typeof window === 'undefined') {
    return { x: null, y: null } as { x: number | null; y: number | null };
  }
  try {
    const raw = localStorage.getItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY);
    if (!raw) {
      return { x: null, y: null };
    }
    const parsed = JSON.parse(raw) as Partial<{ x: number; y: number }>;
    const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null;
    const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null;
    return { x, y };
  } catch (error) {
    console.warn('[TerminalQuickBar] Failed to read stored floating bubble position:', error);
    return { x: null, y: null };
  }
}

export function bubbleViewportRectWithInset(keyboardInsetPx: number) {
  if (typeof window === 'undefined') {
    return { width: FLOATING_BUBBLE_SIZE, height: FLOATING_BUBBLE_SIZE };
  }
  const visualViewport = window.visualViewport;
  const viewportWidth = Math.round(visualViewport?.width || window.innerWidth || FLOATING_BUBBLE_SIZE);
  const viewportHeight = Math.round(visualViewport?.height || Math.max(FLOATING_BUBBLE_SIZE, (window.innerHeight || FLOATING_BUBBLE_SIZE) - Math.max(0, keyboardInsetPx)));
  return {
    width: Math.max(viewportWidth, FLOATING_BUBBLE_SIZE + FLOATING_BUBBLE_MARGIN * 2),
    height: Math.max(viewportHeight, FLOATING_BUBBLE_SIZE + FLOATING_BUBBLE_MARGIN * 2),
  };
}

export function resolveOverlayViewportMetrics(keyboardInsetPx: number) {
  if (typeof window === 'undefined') {
    return { sheetHeightPx: null as number | null, bottomInsetPx: Math.max(0, Math.round(keyboardInsetPx || 0)) };
  }
  const layoutHeight = Math.max(0, Math.round(window.innerHeight || 0));
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return { sheetHeightPx: Math.max(320, layoutHeight - 16), bottomInsetPx: Math.max(0, Math.round(keyboardInsetPx || 0)) };
  }
  const visibleBottom = Math.max(0, Math.round((visualViewport.height || 0) + (visualViewport.offsetTop || 0)));
  const occludedBottom = Math.max(0, layoutHeight - visibleBottom);
  const bottomInsetPx = Math.max(occludedBottom, Math.max(0, Math.round(keyboardInsetPx || 0)));
  return { sheetHeightPx: Math.max(320, visibleBottom - 16), bottomInsetPx };
}

export function createShortcutActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `shortcut-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function normalizeSequenceForImmediateSend(value: string) {
  const normalized = value.replace(/\r?\n/g, '\r');
  if (!normalized.trim()) {
    return '';
  }
  return /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
}

export function isSingleShortcutToken(token: ShortcutToken) {
  if (token.kind === 'modifier') return false;
  if (token.kind === 'key') return true;
  if (token.kind === 'text') return token.sequence.length === 1;
  if (SIMPLE_SHORTCUT_PRESET_SEQUENCES.has(token.sequence)) return true;
  return token.sequence.length === 1 && !/[\x00-\x1f]/.test(token.sequence);
}

export function validateShortcutTokensForRow(
  row: ShortcutRow,
  tokens: ShortcutToken[],
  built: ReturnType<typeof buildTerminalShortcutSequence>,
) {
  if (tokens.length === 0 || built.error) {
    return '';
  }
  if (row === 'top-scroll') {
    if (tokens.some((token) => token.kind === 'modifier')) {
      return '第二行只支持单按键，不支持 Ctrl / Shift 等组合。';
    }
    if (tokens.length !== 1 || !isSingleShortcutToken(tokens[0])) {
      return '第二行只支持单个按键。';
    }
    return '';
  }
  if (tokens.length === 1 && isSingleShortcutToken(tokens[0])) {
    return '第三行用于组合键或复合动作，单按键请放到第二行。';
  }
  return '';
}

export function inferShortcutRow(label: string, sequence: string): ShortcutRow {
  const tokens = buildTerminalShortcutTokensFromSequence(label, sequence, SHORTCUT_PRESETS);
  const built = buildTerminalShortcutSequence(tokens);
  return validateShortcutTokensForRow('top-scroll', tokens, built) ? 'bottom-scroll' : 'top-scroll';
}

export function sortShortcutActions(actions: TerminalShortcutAction[]) {
  return [...actions].sort((left, right) => {
    if (left.row !== right.row) {
      return SHORTCUT_ROW_ORDER.indexOf(left.row) - SHORTCUT_ROW_ORDER.indexOf(right.row);
    }
    return left.order - right.order;
  });
}

export function normalizeShortcutActions(actions: DraftShortcutAction[]): TerminalShortcutAction[] {
  const grouped = new Map<ShortcutRow, DraftShortcutAction[]>();
  grouped.set('top-scroll', []);
  grouped.set('bottom-scroll', []);
  actions.forEach((action) => {
    const row = inferShortcutRow(action.label, action.sequence);
    grouped.get(row)?.push({ ...action, row });
  });
  return SHORTCUT_ROW_ORDER.flatMap((row) =>
    (grouped.get(row) || []).map((action, index) => ({ ...action, order: index, row })),
  );
}

export function buildVisibleShortcutRowActions(
  row: ShortcutRow,
  shortcutActions: TerminalShortcutAction[],
) {
  const customRowActions = shortcutActions.filter((action) => action.row === row);
  const customBySequence = new Map<string, { id: string; label: string; sequence: string }>();
  customRowActions.forEach((action) => {
    if (!customBySequence.has(action.sequence)) {
      customBySequence.set(action.sequence, action);
    }
  });
  const visibleActions: Array<{ id: string; label: string; sequence: string }> = [];
  const consumedSequences = new Set<string>();
  SHORTCUT_PRESETS.filter((preset) => preset.row === row).forEach((preset) => {
    const customAction = customBySequence.get(preset.sequence);
    if (customAction) {
      visibleActions.push({ id: customAction.id, label: customAction.label, sequence: customAction.sequence });
      consumedSequences.add(customAction.sequence);
      return;
    }
    visibleActions.push({ id: `preset-${row}-${preset.label}-${preset.sequence}`, label: preset.label, sequence: preset.sequence });
    consumedSequences.add(preset.sequence);
  });
  customRowActions.forEach((action) => {
    if (consumedSequences.has(action.sequence)) {
      return;
    }
    visibleActions.push({ id: action.id, label: action.label, sequence: action.sequence });
    consumedSequences.add(action.sequence);
  });
  return visibleActions;
}

export function overlayIconButton(disabled: boolean) {
  return {
    width: '32px',
    height: '32px',
    borderRadius: '999px',
    border: 'none',
    backgroundColor: disabled ? '#f3f5f9' : '#eef2f8',
    color: disabled ? '#c3cad7' : mobileTheme.colors.lightText,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 700,
    flexShrink: 0,
  } as const;
}

export function compactOverlayIconButton(disabled: boolean) {
  return {
    ...overlayIconButton(disabled),
    width: '30px',
    height: '30px',
    fontSize: '16px',
  } as const;
}

export function overlayTextButton(backgroundColor: string, color: string) {
  return {
    minHeight: '34px',
    padding: '0 12px',
    borderRadius: '999px',
    border: 'none',
    backgroundColor,
    color,
    cursor: 'pointer',
    fontWeight: 700,
    flexShrink: 0,
  } as const;
}

export function compactOverlayTextButton(backgroundColor: string, color: string) {
  return {
    ...overlayTextButton(backgroundColor, color),
    minHeight: '30px',
    padding: '0 10px',
    fontSize: '14px',
  } as const;
}

export function floatingPillButton(backgroundColor: string, color: string) {
  return {
    minHeight: '34px',
    padding: '0 12px',
    borderRadius: '999px',
    border: 'none',
    backgroundColor,
    color,
    cursor: 'pointer',
    fontWeight: 700,
    flexShrink: 0,
  } as const;
}

export function shortcutTokenGridButton(isModifier: boolean, active: boolean) {
  return {
    minHeight: '62px',
    borderRadius: '14px',
    border: active ? '1px solid rgba(22, 119, 255, 0.28)' : '1px solid rgba(23, 27, 45, 0.12)',
    backgroundColor: active ? 'rgba(22, 119, 255, 0.10)' : isModifier ? '#ffffff' : '#f7f9fc',
    color: active ? '#1677ff' : mobileTheme.colors.lightText,
    cursor: 'pointer',
    fontWeight: 700,
    fontSize: '12px',
    padding: '6px 4px',
    textAlign: 'center',
    boxShadow: active ? '0 4px 10px rgba(22, 119, 255, 0.08)' : 'none',
    overflow: 'hidden',
  } as const;
}

export function resolvePresetShortcutTokens(label: string, sequence: string) {
  return buildTerminalShortcutTokensFromSequence(label, sequence, SHORTCUT_PRESETS);
}

export function resolveShortcutComposerLabelFromSequence(sequence: string) {
  return resolveTerminalShortcutLabel('', sequence);
}
