import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import type { QuickAction, TerminalShortcutAction } from '../../lib/types';
import { DeviceClipboardPlugin, isNativeClipboardSupported } from '../../plugins/DeviceClipboardPlugin';
import {
  buildTerminalShortcutSequence,
  buildTerminalShortcutTokensFromSequence,
  resolveTerminalShortcutLabel,
  type TerminalShortcutToken,
} from '../../../../packages/shared/src/shortcuts/terminal-shortcut-composer';

const FLOATING_BUBBLE_SIZE = 48;
const FLOATING_BUBBLE_MARGIN = 10;
const FLOATING_BUBBLE_DRAG_THRESHOLD_PX = 8;
const QUICK_BAR_SIDE_PADDING = 6;
const QUICK_BAR_ROW_GAP = 4;
const QUICK_BAR_FIXED_COLUMNS = 3;
const FIXED_BUTTON_MIN_WIDTH = 48;
const FIXED_CLUSTER_PADDING_X = 3;
const REPEATABLE_ACTION_LONG_PRESS_MS = 420;
const REPEATABLE_ACTION_REPEAT_MS = 90;
const CLIPBOARD_HISTORY_STORAGE_KEY = 'zterm:clipboard-history';
const MAX_CLIPBOARD_HISTORY = 100;
const FLOATING_BUBBLE_POSITION_STORAGE_KEY = 'zterm:floating-bubble-position';

const SHORTCUT_PRESETS: ShortcutPreset[] = [
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

interface TerminalQuickBarProps {
  activeSessionId?: string | null;
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onSendSequence?: (sequence: string) => void;
  onImagePaste?: (sessionId: string, file: File) => Promise<void> | void;
  onFileAttach?: (sessionId: string, file: File) => Promise<void> | void;
  onRequestRemoteScreenshot?: (sessionId: string) => Promise<unknown> | void;
  keyboardVisible?: boolean;
  keyboardInsetPx?: number;
  onToggleKeyboard?: () => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange?: (value: string) => void;
  onSessionDraftSend?: (value: string) => void;
  onOpenScheduleComposer?: (text: string) => void;
  splitAvailable?: boolean;
  splitVisible?: boolean;
  onToggleSplitLayout?: () => void;
  onCycleSplitPane?: () => void;
  onEditorDomFocusChange?: (active: boolean) => void;
  onMeasuredHeightChange?: (height: number) => void;
  onOpenFileTransfer?: () => void;
  onToggleDebugOverlay?: () => void;
  debugOverlayVisible?: boolean;
  onToggleAbsoluteLineNumbers?: () => void;
  absoluteLineNumbersVisible?: boolean;
  remoteScreenshotStatus?: 'idle' | 'capturing' | 'transferring' | 'preview-ready' | 'saving' | 'failed';
  shortcutSmartSort?: boolean;
  shortcutFrequencyMap?: Record<string, number>;
  onShortcutUse?: (shortcutId: string) => void;
}

interface DraftQuickAction extends QuickAction {
  textInput: string;
}

type FloatingPanelTab = 'quick-actions' | 'clipboard';

interface DraftShortcutAction extends TerminalShortcutAction {}

type ShortcutToken = TerminalShortcutToken;

interface ShortcutPreset extends ShortcutToken {
  row?: 'top-scroll' | 'bottom-scroll';
}

type ShortcutEditorTab = 'keyboard' | 'common';
type ShortcutEditorMode = 'list' | 'form';
type ShortcutRow = 'top-scroll' | 'bottom-scroll';

const SHORTCUT_ROW_ORDER: ShortcutRow[] = ['top-scroll', 'bottom-scroll'];

const SHORTCUT_ROW_META: Record<
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

const SHORTCUT_KEYBOARD_TOKENS: ShortcutToken[] = [
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

const SHORTCUT_COMMON_TOKENS: ShortcutToken[] = [
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
  '\x1b',
  '\x7f',
  '\t',
  '\r',
  ' ',
  '\x1b[A',
  '\x1b[B',
  '\x1b[C',
  '\x1b[D',
  '\x1bOP',
  '\x1bOQ',
  '\x1bOR',
  '\x1bOS',
  '\x1b[15~',
  '\x1b[17~',
  '\x1b[18~',
  '\x1b[19~',
  '\x1b[20~',
  '\x1b[21~',
  '\x1b[23~',
  '\x1b[24~',
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

function editorInputStyle() {
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

function resolveShortcutTokenDisplayLabel(label: string) {
  return MOBILE_SHORTCUT_TOKEN_DISPLAY_LABELS[label] || label;
}

function resolveShortcutVisualLabel(label: string) {
  const normalized = resolveShortcutTokenDisplayLabel(label);
  return SHORTCUT_VISUAL_LABELS[label] || SHORTCUT_VISUAL_LABELS[normalized] || normalized;
}

function isSpaceShortcutLabel(label: string) {
  return resolveShortcutTokenDisplayLabel(label) === 'Space';
}

function shouldRenderShortcutKeycap(label: string) {
  const normalized = resolveShortcutTokenDisplayLabel(label);
  return isSpaceShortcutLabel(label) || Object.prototype.hasOwnProperty.call(SHORTCUT_VISUAL_LABELS, label) || Object.prototype.hasOwnProperty.call(SHORTCUT_VISUAL_LABELS, normalized);
}

function renderShortcutVisualNode(label: string, variant: 'button' | 'list' | 'token' = 'button') {
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
      <span
        data-shortcut-keycap="space"
        data-shortcut-space-visual="true"
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: spaceMetrics.width,
          height: spaceMetrics.height,
          borderRadius: variant === 'list' ? '10px' : '8px',
          border: `${metrics.borderWidth} solid currentColor`,
          boxSizing: 'border-box',
          verticalAlign: 'middle',
          backgroundColor: 'rgba(255,255,255,0.05)',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.12)',
        }}
      >
        <span
          style={{
            display: 'block',
            width: variant === 'list' ? '28px' : variant === 'token' ? '22px' : '20px',
            height: variant === 'list' ? '3px' : '2.5px',
            borderRadius: '999px',
            backgroundColor: 'currentColor',
            opacity: 0.92,
          }}
        />
      </span>
    );
  }

  return (
    <span
      data-shortcut-keycap={resolveShortcutTokenDisplayLabel(label)}
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: metrics.minWidth,
        height: metrics.height,
        padding: metrics.padding,
        borderRadius: metrics.radius,
        border: `${metrics.borderWidth} solid currentColor`,
        boxSizing: 'border-box',
        verticalAlign: 'middle',
        backgroundColor: 'rgba(255,255,255,0.05)',
        boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.12)',
        fontSize: metrics.fontSize,
        fontWeight: metrics.fontWeight,
        letterSpacing: resolveShortcutVisualLabel(label).length > 2 ? '-0.01em' : 0,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {resolveShortcutVisualLabel(label)}
    </span>
  );
}

function formatShortcutSequencePreview(label: string, sequence: string) {
  const tokens = buildTerminalShortcutTokensFromSequence(label, sequence, SHORTCUT_PRESETS);
  if (tokens.length > 0) {
    return tokens
      .map((token) => resolveShortcutVisualLabel(token.label))
      .join(tokens.length > 1 ? ' ' : '')
      .trim();
  }

  return formatSnippetPreview(sequence);
}

function resolveShortcutDisplayMeta(label: string, sequence: string) {
  const normalizedLabel = resolveShortcutTokenDisplayLabel(label || '');
  const visualLabel = resolveShortcutVisualLabel(label || '');
  const preview = formatShortcutSequencePreview(label || '', sequence);
  const titleUsesKeycap = Boolean(label) && shouldRenderShortcutKeycap(label);

  if (!label) {
    return {
      title: '未命名',
      subtitle: preview || '(空)',
      titleUsesKeycap: false,
      titleSourceLabel: '',
    };
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

function createDraftActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `quick-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toDraftActions(actions: QuickAction[]): DraftQuickAction[] {
  return actions.map((action) => ({
    ...action,
    textInput: action.sequence.replace(/\r/g, '\n'),
  }));
}

function normalizeDraftActions(actions: DraftQuickAction[]): QuickAction[] {
  return actions.map(({ textInput, ...action }, index) => ({
    ...action,
    order: index,
    sequence: textInput.replace(/\r?\n/g, '\r'),
  }));
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex || toIndex < 0 || toIndex >= items.length) {
    return items;
  }

  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function moveShortcutActionWithinRow(
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

  return actions.map((action) => {
    if (action.row !== row) {
      return action;
    }
    return rowQueues.get(row)?.shift() || action;
  });
}

function blurCurrentTarget(target: EventTarget | null) {
  if (target instanceof HTMLButtonElement) {
    target.blur();
  }
}

function normalizeClipboardHistory(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is string => typeof item === 'string')
    .filter((item) => item.length > 0)
    .slice(0, MAX_CLIPBOARD_HISTORY);
}

function dedupeClipboardHistory(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.length > 0))).slice(0, MAX_CLIPBOARD_HISTORY);
}

function readStoredBubblePosition() {
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

function bubbleViewportRectWithInset(keyboardInsetPx: number) {
  if (typeof window === 'undefined') {
    return {
      width: FLOATING_BUBBLE_SIZE,
      height: FLOATING_BUBBLE_SIZE,
    };
  }

  const visualViewport = window.visualViewport;
  const viewportWidth = Math.round(visualViewport?.width || window.innerWidth || FLOATING_BUBBLE_SIZE);
  const viewportHeight = Math.round(
    visualViewport?.height || Math.max(FLOATING_BUBBLE_SIZE, (window.innerHeight || FLOATING_BUBBLE_SIZE) - Math.max(0, keyboardInsetPx)),
  );

  return {
    width: Math.max(viewportWidth, FLOATING_BUBBLE_SIZE + FLOATING_BUBBLE_MARGIN * 2),
    height: Math.max(viewportHeight, FLOATING_BUBBLE_SIZE + FLOATING_BUBBLE_MARGIN * 2),
  };
}

function resolveOverlayViewportMetrics(keyboardInsetPx: number) {
  if (typeof window === 'undefined') {
    return {
      sheetHeightPx: null as number | null,
      bottomInsetPx: Math.max(0, Math.round(keyboardInsetPx || 0)),
    };
  }

  const layoutHeight = Math.max(0, Math.round(window.innerHeight || 0));
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return {
      sheetHeightPx: Math.max(320, layoutHeight - 16),
      bottomInsetPx: Math.max(0, Math.round(keyboardInsetPx || 0)),
    };
  }

  const visibleBottom = Math.max(
    0,
    Math.round((visualViewport.height || 0) + (visualViewport.offsetTop || 0)),
  );
  const occludedBottom = Math.max(0, layoutHeight - visibleBottom);
  const bottomInsetPx = Math.max(
    occludedBottom,
    Math.max(0, Math.round(keyboardInsetPx || 0)),
  );

  return {
    sheetHeightPx: Math.max(320, visibleBottom - 16),
    bottomInsetPx,
  };
}

function createShortcutActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `shortcut-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeSequenceForImmediateSend(value: string) {
  const normalized = value.replace(/\r?\n/g, '\r');
  if (!normalized.trim()) {
    return '';
  }
  return /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
}

function isSingleShortcutToken(token: ShortcutToken) {
  if (token.kind === 'modifier') {
    return false;
  }
  if (token.kind === 'key') {
    return true;
  }
  if (token.kind === 'text') {
    return token.sequence.length === 1;
  }
  if (SIMPLE_SHORTCUT_PRESET_SEQUENCES.has(token.sequence)) {
    return true;
  }
  return token.sequence.length === 1 && !/[\x00-\x1f]/.test(token.sequence);
}

function validateShortcutTokensForRow(
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

function inferShortcutRow(label: string, sequence: string): ShortcutRow {
  const tokens = buildTerminalShortcutTokensFromSequence(label, sequence, SHORTCUT_PRESETS);
  const built = buildTerminalShortcutSequence(tokens);
  return validateShortcutTokensForRow('top-scroll', tokens, built) ? 'bottom-scroll' : 'top-scroll';
}

function sortShortcutActions(actions: TerminalShortcutAction[]) {
  return [...actions].sort((left, right) => {
    if (left.row !== right.row) {
      return SHORTCUT_ROW_ORDER.indexOf(left.row) - SHORTCUT_ROW_ORDER.indexOf(right.row);
    }
    return left.order - right.order;
  });
}

function normalizeShortcutActions(actions: DraftShortcutAction[]): TerminalShortcutAction[] {
  const grouped = new Map<ShortcutRow, DraftShortcutAction[]>();
  grouped.set('top-scroll', []);
  grouped.set('bottom-scroll', []);
  actions.forEach((action) => {
    const row = inferShortcutRow(action.label, action.sequence);
    grouped.get(row)?.push({
      ...action,
      row,
    });
  });

  return SHORTCUT_ROW_ORDER.flatMap((row) =>
    (grouped.get(row) || []).map((action, index) => ({
      ...action,
      order: index,
      row,
    })),
  );
}

export function TerminalQuickBar({
  activeSessionId,
  quickActions,
  shortcutActions,
  keyboardVisible = false,
  keyboardInsetPx = 0,
  onImagePaste,
  onFileAttach,
  onRequestRemoteScreenshot,
  onToggleKeyboard,
  onQuickActionsChange,
  onShortcutActionsChange,
  onSendSequence,
  sessionDraft,
  onSessionDraftChange,
  onSessionDraftSend,
  onOpenScheduleComposer,
  splitAvailable = false,
  splitVisible = false,
  onToggleSplitLayout,
  onCycleSplitPane,
  onEditorDomFocusChange,
  onMeasuredHeightChange,
  onOpenFileTransfer,
  onToggleDebugOverlay,
  debugOverlayVisible,
  onToggleAbsoluteLineNumbers,
  absoluteLineNumbersVisible,
  remoteScreenshotStatus = 'idle',
  shortcutSmartSort = false,
  shortcutFrequencyMap,
  onShortcutUse,
}: TerminalQuickBarProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
  const [shortcutEditorMode, setShortcutEditorMode] = useState<ShortcutEditorMode>('list');
  const [floatingMenuOpen, setFloatingMenuOpen] = useState(false);
  const [floatingPanelTab, setFloatingPanelTab] = useState<FloatingPanelTab>('quick-actions');
  const [draftActions, setDraftActions] = useState<DraftQuickAction[]>(() => toDraftActions(quickActions));
  const [draftShortcutActions, setDraftShortcutActions] = useState<DraftShortcutAction[]>(() => sortShortcutActions(shortcutActions));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftTextInput, setDraftTextInput] = useState('');
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [draftShortcutLabel, setDraftShortcutLabel] = useState('');
  const [draftShortcutSequence, setDraftShortcutSequence] = useState('');
  const [draftShortcutRow, setDraftShortcutRow] = useState<ShortcutRow>('top-scroll');
  const [draftShortcutTokens, setDraftShortcutTokens] = useState<ShortcutToken[]>([]);
  const [shortcutEditorTab, setShortcutEditorTab] = useState<ShortcutEditorTab>('keyboard');
  const [draftShortcutTextInput, setDraftShortcutTextInput] = useState('');
  const [clipboardHistory, setClipboardHistory] = useState<string[]>([]);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [floatingBubblePosition, setFloatingBubblePosition] = useState<{ x: number | null; y: number | null }>(() => readStoredBubblePosition());
  const [repeatingActionId, setRepeatingActionId] = useState<string | null>(null);
  const suppressKeyboardClickRef = useRef(false);
  const suppressBubbleClickRef = useRef(false);
  const suppressActionClickRef = useRef<string | null>(null);
  const repeatLongPressTimerRef = useRef<number | null>(null);
  const repeatIntervalTimerRef = useRef<number | null>(null);
  const pressedRepeatableActionIdRef = useRef<string | null>(null);
  const floatingBubbleDragRef = useRef({
    pointerId: -1,
    active: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    width: FLOATING_BUBBLE_SIZE,
    height: FLOATING_BUBBLE_SIZE,
  });
  const floatingBubbleTouchDragRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    width: FLOATING_BUBBLE_SIZE,
    height: FLOATING_BUBBLE_SIZE,
  });
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const floatingPanelRef = useRef<HTMLDivElement | null>(null);
  const floatingBubbleRef = useRef<HTMLButtonElement | null>(null);
  const shortcutEditorScrollRef = useRef<HTMLDivElement | null>(null);
  const domEditorFocusTimerRef = useRef<number | null>(null);

  const sortedQuickActions = useMemo(() => quickActions.slice().sort((a, b) => a.order - b.order), [quickActions]);
  const sortedShortcutActions = useMemo(() => {
    if (!shortcutSmartSort || !shortcutFrequencyMap) return sortShortcutActions(shortcutActions);
    const freq = shortcutFrequencyMap;
    return [...shortcutActions].sort((left, right) => {
      if (left.row !== right.row) {
        return SHORTCUT_ROW_ORDER.indexOf(left.row) - SHORTCUT_ROW_ORDER.indexOf(right.row);
      }
      const lf = freq[left.id] || 0;
      const rf = freq[right.id] || 0;
      if (lf !== rf) return rf - lf; // higher frequency first
      return left.order - right.order; // fallback to manual order
    });
  }, [shortcutActions, shortcutSmartSort, shortcutFrequencyMap]);
  const draftShortcutBuild = useMemo(() => buildTerminalShortcutSequence(draftShortcutTokens), [draftShortcutTokens]);
  const draftShortcutRowError = useMemo(
    () => validateShortcutTokensForRow(draftShortcutRow, draftShortcutTokens, draftShortcutBuild),
    [draftShortcutBuild, draftShortcutRow, draftShortcutTokens],
  );
  const draftShortcutEffectiveError = draftShortcutBuild.error || draftShortcutRowError;
  const floatingPanelBottomPx = 124;
  const floatingBubbleBottomPx = 72;
  const editingIndex = editingId ? draftActions.findIndex((action) => action.id === editingId) : -1;
  const editingShortcutIndex = editingShortcutId ? draftShortcutActions.findIndex((action) => action.id === editingShortcutId) : -1;
  const draftShortcutRowMeta = SHORTCUT_ROW_META[draftShortcutRow];
  const availableKeyboardShortcutTokens = useMemo(
    () => (draftShortcutRow === 'top-scroll' ? SHORTCUT_KEYBOARD_TOKENS.filter((token) => token.kind !== 'modifier') : SHORTCUT_KEYBOARD_TOKENS),
    [draftShortcutRow],
  );
  const availableCommonShortcutTokens = useMemo(
    () => (draftShortcutRow === 'top-scroll' ? SHORTCUT_COMMON_TOKENS.filter(isSingleShortcutToken) : SHORTCUT_COMMON_TOKENS),
    [draftShortcutRow],
  );
  const [overlayViewportMetrics, setOverlayViewportMetrics] = useState(() => resolveOverlayViewportMetrics(keyboardInsetPx));
  const overlaySheetHeightStyle = overlayViewportMetrics.sheetHeightPx !== null
    ? `${overlayViewportMetrics.sheetHeightPx}px`
    : 'calc(100dvh - 16px)';
  const overlayBottomInsetStyle = `${overlayViewportMetrics.bottomInsetPx}px`;
  const appendToDraft = (value: string) => {
    onSessionDraftChange?.(`${sessionDraft || ''}${value}`);
  };

  const sendSessionDraft = () => {
    const payload = normalizeSequenceForImmediateSend(sessionDraft);
    if (!payload) {
      return;
    }
    onSessionDraftSend?.(payload);
  };

  const sendQuickActionNow = (value: string) => {
    const payload = normalizeSequenceForImmediateSend(value);
    if (!payload) {
      return;
    }
    onSendSequence?.(payload);
  };

  const clearRepeatLongPressTimer = useCallback(() => {
    if (repeatLongPressTimerRef.current !== null) {
      window.clearTimeout(repeatLongPressTimerRef.current);
      repeatLongPressTimerRef.current = null;
    }
  }, []);

  const stopRepeatingAction = useCallback(() => {
    clearRepeatLongPressTimer();
    pressedRepeatableActionIdRef.current = null;
    if (repeatIntervalTimerRef.current !== null) {
      window.clearInterval(repeatIntervalTimerRef.current);
      repeatIntervalTimerRef.current = null;
    }
    setRepeatingActionId(null);
  }, [clearRepeatLongPressTimer]);

  const triggerActionSequence = useCallback((action: { id: string; label: string; sequence: string }) => {
    if (action.id === 'keyboard') {
      onToggleKeyboard?.();
      return;
    }
    if (action.id === 'image-attach') {
      imageInputRef.current?.click();
      return;
    }
    if (action.id === 'sync-settings') {
      onOpenFileTransfer?.();
      return;
    }
    if (action.id === 'debug-overlay') {
      onToggleDebugOverlay?.();
      return;
    }
    if (action.id === 'line-numbers') {
      onToggleAbsoluteLineNumbers?.();
      return;
    }
    if (action.id === 'remote-screenshot') {
      if (!activeSessionId) {
        alert('当前没有可用的目标 session');
        return;
      }
      void Promise.resolve(onRequestRemoteScreenshot?.(activeSessionId)).catch((error) => {
        alert(error instanceof Error ? error.message : '远程截图失败');
      });
      return;
    }
    if (action.id === 'file-transfer') {
      onOpenFileTransfer?.();
      return;
    }
    if (action.id === 'paste' || (action.label === 'Paste' && action.sequence === '\x16')) {
      void handleClipboardPaste();
      return;
    }
    if (action.id.startsWith('shortcut-editor')) {
      openShortcutEditor();
      return;
    }
    onSendSequence?.(action.sequence);
    onShortcutUse?.(action.id);
  }, [
    activeSessionId,
    onOpenFileTransfer,
    onRequestRemoteScreenshot,
    onSendSequence,
    onShortcutUse,
    onToggleAbsoluteLineNumbers,
    onToggleDebugOverlay,
    onToggleKeyboard,
  ]);

  const isRepeatableAction = useCallback((action: { id: string; label: string; sequence: string }) => {
    if (!action.sequence) {
      return false;
    }
    if (
      action.id === 'keyboard'
      || action.id === 'image-attach'
      || action.id === 'file-attach'
      || action.id === 'file-transfer'
      || action.id === 'sync-settings'
      || action.id === 'remote-screenshot'
      || action.id === 'debug-overlay'
      || action.id === 'paste'
    ) {
      return false;
    }
    if (action.id.startsWith('shortcut-editor')) {
      return false;
    }
    return true;
  }, []);

  const startRepeatingAction = useCallback((action: { id: string; label: string; sequence: string }) => {
    stopRepeatingAction();
    suppressActionClickRef.current = action.id;
    setRepeatingActionId(action.id);
    triggerActionSequence(action);
    repeatIntervalTimerRef.current = window.setInterval(() => {
      triggerActionSequence(action);
    }, REPEATABLE_ACTION_REPEAT_MS);
  }, [stopRepeatingAction, triggerActionSequence]);

  const persistDraftActions = (nextActions: DraftQuickAction[]) => {
    const normalized = normalizeDraftActions(nextActions);
    onQuickActionsChange?.(normalized);
    setDraftActions(toDraftActions(normalized));
  };

  const persistShortcutActions = (nextActions: DraftShortcutAction[]) => {
    const normalized = normalizeShortcutActions(nextActions);
    onShortcutActionsChange?.(normalized);
    setDraftShortcutActions(sortShortcutActions(normalized));
  };

  const persistClipboardHistory = (nextItems: string[]) => {
    const normalized = dedupeClipboardHistory(nextItems);
    setClipboardHistory(normalized);
    if (typeof window !== 'undefined') {
      localStorage.setItem(CLIPBOARD_HISTORY_STORAGE_KEY, JSON.stringify(normalized));
    }
  };

  const cleanupEmptyDraftActions = (actions: DraftQuickAction[]) =>
    actions.filter((action) => action.label.trim().length > 0 || action.textInput.trim().length > 0);

  const openEditor = (mode: 'list' | 'create' | 'edit' = 'list', action?: DraftQuickAction) => {
    setDraftActions(toDraftActions(sortedQuickActions));
    setFloatingMenuOpen(false);
    if (mode === 'edit' && action) {
      setEditingId(action.id);
      setDraftLabel(action.label);
      setDraftTextInput(action.textInput);
    } else if (mode === 'create') {
      const nextId = createDraftActionId();
      const nextActions = [
        ...toDraftActions(sortedQuickActions),
        {
          id: nextId,
          label: '',
          textInput: '',
          sequence: '',
          order: sortedQuickActions.length,
        },
      ];
      persistDraftActions(nextActions);
      setDraftActions(nextActions);
      setEditingId(nextId);
      setDraftLabel('');
      setDraftTextInput('');
    } else {
      setEditingId(null);
      setDraftLabel('');
      setDraftTextInput('');
    }
    setEditorOpen(true);
  };

  const closeEditor = () => {
    const cleaned = cleanupEmptyDraftActions(draftActions);
    if (cleaned.length !== draftActions.length) {
      persistDraftActions(cleaned);
    }
    setEditorOpen(false);
    setEditingId(null);
    setDraftLabel('');
    setDraftTextInput('');
  };

  const openDraftForm = (action?: DraftQuickAction) => {
    if (action) {
      setEditingId(action.id);
      setDraftLabel(action.label);
      setDraftTextInput(action.textInput);
      return;
    }

    const nextId = createDraftActionId();
    const nextAction: DraftQuickAction = {
      id: nextId,
      label: '',
      textInput: '',
      sequence: '',
      order: draftActions.length,
    };
    const nextActions = [...draftActions, nextAction];
    persistDraftActions(nextActions);
    setEditingId(nextId);
    setDraftLabel('');
    setDraftTextInput('');
  };

  const updateEditingAction = (nextLabel: string, nextTextInput: string) => {
    if (!editingId) {
      return;
    }

    const nextActions = draftActions.map((action) =>
      action.id === editingId
        ? {
            ...action,
            label: nextLabel,
            textInput: nextTextInput,
            sequence: nextTextInput.replace(/\r?\n/g, '\r'),
          }
        : action,
    );
    persistDraftActions(nextActions);
  };

  const screenshotToolLabel = useMemo(() => {
    switch (remoteScreenshotStatus) {
      case 'capturing':
        return '截图中';
      case 'transferring':
        return '传图中';
      case 'preview-ready':
        return '预览中';
      case 'saving':
        return '保存中';
      case 'failed':
        return '截图失败';
      default:
        return '截图';
    }
  }, [remoteScreenshotStatus]);

  const toolRowActions = useMemo(() => ([
    { id: 'file-transfer', label: '文件', sequence: '' },
    { id: 'image-attach', label: '图片', sequence: '' },
    { id: 'sync-settings', label: '同步', sequence: '' },
    { id: 'remote-screenshot', label: screenshotToolLabel, sequence: '' },
    { id: 'line-numbers', label: '行号', sequence: '' },
  ]), [screenshotToolLabel]);

  const topFixedActions = useMemo(() => ([
    { id: 'debug-overlay', label: '状态', sequence: '' },
    { id: 'arrow-up', label: '↑', sequence: '\x1b[A' },
    { id: 'keyboard', label: '键盘', sequence: '' },
  ]), []);

  const bottomFixedActions = useMemo(() => ([
    { id: 'arrow-left', label: '←', sequence: '\x1b[D' },
    { id: 'arrow-down', label: '↓', sequence: '\x1b[B' },
    { id: 'arrow-right', label: '→', sequence: '\x1b[C' },
  ]), []);

  const topScrollActions = useMemo(
    () => buildVisibleShortcutRowActions('top-scroll', sortedShortcutActions),
    [sortedShortcutActions],
  );

  const bottomScrollActions = useMemo(
    () => buildVisibleShortcutRowActions('bottom-scroll', sortedShortcutActions),
    [sortedShortcutActions],
  );

  const topShortcutEditorEntry = useMemo(() => ({ id: 'shortcut-editor-top', label: '+', sequence: '' }), []);
  const bottomShortcutEditorEntry = useMemo(() => ({ id: 'shortcut-editor-bottom', label: '+', sequence: '' }), []);

  const clampFloatingBubblePosition = (nextX: number, nextY: number, width: number, height: number) => {
    const viewport = bubbleViewportRectWithInset(keyboardInsetPx);
    const maxX = Math.max(FLOATING_BUBBLE_MARGIN, viewport.width - width - FLOATING_BUBBLE_MARGIN);
    const maxY = Math.max(FLOATING_BUBBLE_MARGIN, viewport.height - height - FLOATING_BUBBLE_MARGIN);
    return {
      x: Math.min(Math.max(FLOATING_BUBBLE_MARGIN, nextX), maxX),
      y: Math.min(Math.max(FLOATING_BUBBLE_MARGIN, nextY), maxY),
    };
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const rescueBubblePosition = () => {
      setFloatingBubblePosition((current) => {
        if (current.x === null || current.y === null) {
          return current;
        }

        const bubbleWidth = floatingBubbleRef.current?.offsetWidth || FLOATING_BUBBLE_SIZE;
        const bubbleHeight = floatingBubbleRef.current?.offsetHeight || FLOATING_BUBBLE_SIZE;
        const clamped = clampFloatingBubblePosition(current.x, current.y, bubbleWidth, bubbleHeight);
        if (clamped.x === current.x && clamped.y === current.y) {
          return current;
        }
        return clamped;
      });
    };

    rescueBubblePosition();
    window.addEventListener('resize', rescueBubblePosition);
    window.visualViewport?.addEventListener('resize', rescueBubblePosition);

    return () => {
      window.removeEventListener('resize', rescueBubblePosition);
      window.visualViewport?.removeEventListener('resize', rescueBubblePosition);
    };
  }, [keyboardInsetPx]);

  const scrollTrackShellStyle = {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: '12px',
    backgroundColor: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
  } as const;

  const fixedClusterStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${QUICK_BAR_FIXED_COLUMNS}, minmax(${FIXED_BUTTON_MIN_WIDTH}px, 1fr))`,
    gap: `${QUICK_BAR_ROW_GAP}px`,
    flexShrink: 0,
    alignItems: 'center',
    padding: `2px ${FIXED_CLUSTER_PADDING_X}px`,
    borderRadius: '12px',
    backgroundColor: 'rgba(59, 74, 108, 0.95)',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.03)',
    width: `${QUICK_BAR_FIXED_COLUMNS * FIXED_BUTTON_MIN_WIDTH + (QUICK_BAR_FIXED_COLUMNS - 1) * QUICK_BAR_ROW_GAP + FIXED_CLUSTER_PADDING_X * 2}px`,
  } as const;

  const scrollTrackStyle = {
    width: '100%',
    minWidth: 0,
    display: 'flex',
    gap: `${QUICK_BAR_ROW_GAP}px`,
    overflowX: 'auto',
    overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    touchAction: 'pan-x',
    scrollbarWidth: 'none',
    padding: '3px 4px',
  } as const;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const stored = localStorage.getItem(CLIPBOARD_HISTORY_STORAGE_KEY);
      if (!stored) {
        return;
      }
      setClipboardHistory(normalizeClipboardHistory(JSON.parse(stored)));
    } catch (error) {
      console.error('[TerminalQuickBar] Failed to load clipboard history:', error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      if (floatingBubblePosition.x === null || floatingBubblePosition.y === null) {
        localStorage.removeItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY);
        return;
      }
      localStorage.setItem(FLOATING_BUBBLE_POSITION_STORAGE_KEY, JSON.stringify(floatingBubblePosition));
    } catch (error) {
      console.error('[TerminalQuickBar] Failed to persist floating bubble position:', error);
    }
  }, [floatingBubblePosition]);

  useEffect(() => {
    if (!floatingMenuOpen || typeof document === 'undefined') {
      return;
    }

    const closeIfOutside = (event: PointerEvent | MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (floatingPanelRef.current?.contains(target) || floatingBubbleRef.current?.contains(target)) {
        return;
      }
      setFloatingMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
    };
  }, [floatingMenuOpen]);

  useEffect(() => {
    if (!shortcutEditorOpen || !shortcutEditorScrollRef.current) {
      return;
    }

    const scrollElement = shortcutEditorScrollRef.current;
    const resetScroll = () => {
      scrollElement.scrollTop = 0;
    };

    resetScroll();
    const rafId = window.requestAnimationFrame(resetScroll);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [editingShortcutId, shortcutEditorMode, shortcutEditorOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncOverlayViewportMetrics = () => {
      const nextMetrics = resolveOverlayViewportMetrics(keyboardInsetPx);
      setOverlayViewportMetrics((current) => (
        current.sheetHeightPx === nextMetrics.sheetHeightPx
        && current.bottomInsetPx === nextMetrics.bottomInsetPx
          ? current
          : nextMetrics
      ));
    };

    syncOverlayViewportMetrics();
    window.addEventListener('resize', syncOverlayViewportMetrics);
    window.visualViewport?.addEventListener('resize', syncOverlayViewportMetrics);
    window.visualViewport?.addEventListener('scroll', syncOverlayViewportMetrics);

    return () => {
      window.removeEventListener('resize', syncOverlayViewportMetrics);
      window.visualViewport?.removeEventListener('resize', syncOverlayViewportMetrics);
      window.visualViewport?.removeEventListener('scroll', syncOverlayViewportMetrics);
    };
  }, [keyboardInsetPx]);

  useEffect(() => () => {
    if (domEditorFocusTimerRef.current !== null) {
      window.clearTimeout(domEditorFocusTimerRef.current);
      domEditorFocusTimerRef.current = null;
    }
  }, []);

  const captureSystemClipboard = async () => {
    try {
      setClipboardBusy(true);
      setClipboardError(null);
      const text = await (async () => {
        if (isNativeClipboardSupported()) {
          const result = await DeviceClipboardPlugin.readText();
          return typeof result.value === 'string' ? result.value : '';
        }
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
          throw new Error('当前环境不支持读取系统剪贴板');
        }
        return navigator.clipboard.readText();
      })();
      if (text.length === 0) {
        setClipboardError('系统剪贴板当前为空');
        return;
      }
      persistClipboardHistory([text, ...clipboardHistory]);
    } catch (error) {
      setClipboardError(error instanceof Error ? error.message : '读取系统剪贴板失败');
    } finally {
      setClipboardBusy(false);
    }
  };

  const handleClipboardPaste = async () => {
    try {
      setClipboardBusy(true);
      setClipboardError(null);
      const text = await (async () => {
        if (isNativeClipboardSupported()) {
          const result = await DeviceClipboardPlugin.readText();
          return typeof result.value === 'string' ? result.value : '';
        }
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
          throw new Error('当前环境不支持读取系统剪贴板');
        }
        return navigator.clipboard.readText();
      })();
      if (text.length === 0) {
        setClipboardError('系统剪贴板当前为空');
        return;
      }
      persistClipboardHistory([text, ...clipboardHistory]);
      onSendSequence?.(text);
    } catch (error) {
      setClipboardError(error instanceof Error ? error.message : '读取系统剪贴板失败');
    } finally {
      setClipboardBusy(false);
    }
  };

  const buildShortcutTokensFromSequence = (label: string, sequence: string): ShortcutToken[] => {
    return buildTerminalShortcutTokensFromSequence(label, sequence, SHORTCUT_PRESETS);
  };

  const syncDraftShortcutTokens = (tokens: ShortcutToken[]) => {
    const built = buildTerminalShortcutSequence(tokens);
    setDraftShortcutTokens(tokens);
    setDraftShortcutSequence(built.sequence);
  };

  const resetShortcutForm = () => {
    setEditingShortcutId(null);
    setDraftShortcutLabel('');
    setDraftShortcutSequence('');
    setDraftShortcutRow('top-scroll');
    setDraftShortcutTokens([]);
    setShortcutEditorTab('keyboard');
    setDraftShortcutTextInput('');
  };

  const openShortcutEditor = () => {
    setDraftShortcutActions(sortShortcutActions(shortcutActions));
    setFloatingMenuOpen(false);
    resetShortcutForm();
    setShortcutEditorMode('list');
    setShortcutEditorOpen(true);
  };

  const openShortcutForm = (row: ShortcutRow, action?: DraftShortcutAction) => {
    setDraftShortcutActions(sortShortcutActions(shortcutActions));
    setFloatingMenuOpen(false);
    setShortcutEditorTab('keyboard');
    setDraftShortcutTextInput('');
    if (action) {
      setEditingShortcutId(action.id);
      setDraftShortcutLabel(action.label);
      setDraftShortcutRow(action.row);
      syncDraftShortcutTokens(buildShortcutTokensFromSequence(action.label, action.sequence));
    } else {
      setEditingShortcutId(null);
      setDraftShortcutLabel('');
      setDraftShortcutRow(row);
      syncDraftShortcutTokens([]);
    }
    setShortcutEditorMode('form');
    setShortcutEditorOpen(true);
  };

  const backToShortcutList = () => {
    resetShortcutForm();
    setShortcutEditorMode('list');
  };

  const closeShortcutEditor = () => {
    setShortcutEditorOpen(false);
    setShortcutEditorMode('list');
    resetShortcutForm();
  };

  const appendShortcutToken = (token: ShortcutToken, row?: 'top-scroll' | 'bottom-scroll') => {
    setDraftShortcutTokens((current) => {
      const next = [...current, token];
      const built = buildTerminalShortcutSequence(next);
      setDraftShortcutSequence(built.sequence);
      return next;
    });
    if (row) {
      setDraftShortcutRow(row);
    }
  };

  const removeShortcutToken = (index: number) => {
    setDraftShortcutTokens((current) => {
      const next = current.filter((_, tokenIndex) => tokenIndex !== index);
      const built = buildTerminalShortcutSequence(next);
      setDraftShortcutSequence(built.sequence);
      return next;
    });
  };

  const clearShortcutTokens = () => {
    setDraftShortcutTokens([]);
    setDraftShortcutSequence('');
  };

  const saveShortcutForm = () => {
    const nextSequence = draftShortcutBuild.sequence;
    if (!nextSequence || draftShortcutEffectiveError) {
      return;
    }

    const nextLabel = resolveTerminalShortcutLabel(draftShortcutLabel, draftShortcutBuild.preview);

    const nextActions = editingShortcutId
      ? draftShortcutActions.map((action) =>
          action.id === editingShortcutId
            ? { ...action, label: nextLabel, sequence: nextSequence, row: draftShortcutRow }
            : action,
        )
      : [
          ...draftShortcutActions,
          {
            id: createShortcutActionId(),
            label: nextLabel,
            sequence: nextSequence,
            row: draftShortcutRow,
            order: draftShortcutActions.filter((action) => action.row === draftShortcutRow).length,
          },
        ];

    persistShortcutActions(nextActions);
    backToShortcutList();
  };

  const appendShortcutTextInput = () => {
    const value = draftShortcutTextInput.trim();
    if (!value) {
      return;
    }
    appendShortcutToken({
      label: value,
      sequence: value,
      kind: 'text',
    });
    setDraftShortcutTextInput('');
  };

  const renderBaseActionButton = (action: { id: string; label: string; sequence: string }, options?: { fixed?: boolean; compact?: boolean }) => {
    const compact = options?.compact ?? false;
    const fixed = options?.fixed ?? false;
    const repeatable = isRepeatableAction(action);
    const repeatActive = repeatingActionId === action.id;
    const actionDisplayLabel = resolveShortcutVisualLabel(action.label);
    const actionUsesSpaceBarVisual = isSpaceShortcutLabel(action.label);
    return (
      <button
        key={action.id}
        tabIndex={-1}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          blurCurrentTarget(event.currentTarget);
          if (action.id !== 'keyboard') {
            if (!repeatable) {
              return;
            }
            clearRepeatLongPressTimer();
            pressedRepeatableActionIdRef.current = action.id;
            repeatLongPressTimerRef.current = window.setTimeout(() => {
              repeatLongPressTimerRef.current = null;
              if (pressedRepeatableActionIdRef.current !== action.id) {
                return;
              }
              startRepeatingAction(action);
            }, REPEATABLE_ACTION_LONG_PRESS_MS);
            return;
          }
          suppressKeyboardClickRef.current = true;
          onToggleKeyboard?.();
          window.setTimeout(() => {
            suppressKeyboardClickRef.current = false;
          }, 220);
        }}
        onPointerUp={() => {
          clearRepeatLongPressTimer();
          pressedRepeatableActionIdRef.current = null;
        }}
        onPointerCancel={() => {
          clearRepeatLongPressTimer();
          pressedRepeatableActionIdRef.current = null;
        }}
        onPointerLeave={() => {
          clearRepeatLongPressTimer();
          pressedRepeatableActionIdRef.current = null;
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          blurCurrentTarget(event.currentTarget);
          if (repeatActive) {
            stopRepeatingAction();
            suppressActionClickRef.current = null;
            return;
          }
          if (suppressActionClickRef.current === action.id) {
            suppressActionClickRef.current = null;
            return;
          }
          if (action.id === 'keyboard') {
            if (suppressKeyboardClickRef.current) {
              return;
            }
          }
          if (repeatingActionId) {
            stopRepeatingAction();
          }
          triggerActionSequence(action);
        }}
        onFocus={(event) => event.currentTarget.blur()}
        aria-label={action.label}
        aria-pressed={repeatActive}
        style={{
          minHeight: compact ? '32px' : '34px',
          width: fixed ? '100%' : undefined,
          minWidth: actionUsesSpaceBarVisual
            ? '58px'
            : actionDisplayLabel.length > 3
              ? '58px'
              : actionDisplayLabel.length > 1
                ? '48px'
                : '34px',
          padding: fixed ? '0 6px' : '0 10px',
          border: 'none',
          outline: 'none',
          borderRadius: '10px',
          backgroundColor:
            repeatActive
              ? 'rgba(113, 164, 255, 0.28)'
              : action.id === 'keyboard' && keyboardVisible
              ? 'rgba(31,214,122,0.18)'
              : action.id === 'debug-overlay' && debugOverlayVisible
              ? 'rgba(31,214,122,0.18)'
              : action.id === 'line-numbers' && absoluteLineNumbersVisible
              ? 'rgba(31,214,122,0.18)'
              : action.id === 'remote-screenshot' && remoteScreenshotStatus !== 'idle'
              ? 'rgba(113, 164, 255, 0.18)'
              : fixed
                ? 'rgba(22, 28, 41, 0.92)'
                : 'rgba(31, 38, 53, 0.82)',
          color:
            repeatActive
              ? '#bcd3ff'
              : action.id === 'keyboard' && keyboardVisible
              ? mobileTheme.colors.accent
              : action.id === 'debug-overlay' && debugOverlayVisible
              ? mobileTheme.colors.accent
              : action.id === 'line-numbers' && absoluteLineNumbersVisible
              ? mobileTheme.colors.accent
              : action.id === 'remote-screenshot' && remoteScreenshotStatus !== 'idle'
              ? '#8db7ff'
              : '#fff',
          fontSize: fixed ? '13px' : action.id === 'continue' ? '11px' : actionDisplayLabel.length > 3 ? '11px' : '14px',
          fontWeight: 700,
          cursor: 'pointer',
          flexShrink: 0,
          appearance: 'none',
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          boxShadow:
            repeatActive
              ? 'inset 0 0 0 1px rgba(141,183,255,0.55)'
              : action.id === 'remote-screenshot' && remoteScreenshotStatus !== 'idle'
              ? 'inset 0 0 0 1px rgba(141,183,255,0.42)'
              : 'none',
        }}
      >
        {renderShortcutVisualNode(action.label, 'button')}
      </button>
    );
  };

  useEffect(() => () => {
    stopRepeatingAction();
    suppressActionClickRef.current = null;
  }, [stopRepeatingAction]);

  useEffect(() => {
    const host = rootRef.current;
    if (!host) {
      return;
    }

    const syncHeight = () => {
      onMeasuredHeightChange?.(Math.max(0, Math.round(host.getBoundingClientRect().height || host.offsetHeight || 0)));
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(host);
    window.addEventListener('resize', syncHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncHeight);
    };
  }, [keyboardInsetPx, keyboardVisible, onMeasuredHeightChange]);

  const quickBarAllowsTarget = (target: HTMLElement | null) => {
    return Boolean(target?.closest('[data-quickbar-allow-pointer="true"],input,textarea,button,select,label'));
  };

  const blockShellEvent = (event: React.SyntheticEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (quickBarAllowsTarget(target)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
  };

  return (
    <div
      ref={rootRef}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target) {
          return;
        }
        if (target instanceof HTMLInputElement && target.type === 'file') {
          return;
        }
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          onEditorDomFocusChange?.(true);
        }
      }}
      onBlurCapture={() => {
        if (domEditorFocusTimerRef.current !== null) {
          window.clearTimeout(domEditorFocusTimerRef.current);
        }
        domEditorFocusTimerRef.current = window.setTimeout(() => {
          domEditorFocusTimerRef.current = null;
          const activeElement = document.activeElement;
          const stillFocused =
            rootRef.current?.contains(activeElement)
            && (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement)
            && !(activeElement instanceof HTMLInputElement && activeElement.type === 'file');
          onEditorDomFocusChange?.(Boolean(stillFocused));
        }, 0);
      }}
      onPointerDownCapture={(event) => {
        blockShellEvent(event);
      }}
      onTouchStartCapture={(event) => {
        blockShellEvent(event);
      }}
      onMouseDownCapture={(event) => {
        blockShellEvent(event);
      }}
      onClickCapture={(event) => {
        blockShellEvent(event);
      }}
      style={{
        padding: floatingMenuOpen ? '0' : `8px 0 calc(${mobileTheme.safeArea.bottom} + 6px)`,
        position: 'relative',
        backgroundColor: floatingMenuOpen ? 'transparent' : 'rgba(11, 15, 24, 0.88)',
        borderTop: floatingMenuOpen ? 'none' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (!file) {
            return;
          }
          const targetSessionId = activeSessionId || null;
          if (!targetSessionId) {
            alert('当前没有可用的目标 session');
            return;
          }
          try {
            await onImagePaste?.(targetSessionId, file);
          } catch (error) {
            alert(error instanceof Error ? error.message : '传图片失败');
          }
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (!file) {
            return;
          }
          const targetSessionId = activeSessionId || null;
          if (!targetSessionId) {
            alert('当前没有可用的目标 session');
            return;
          }
          try {
            await onFileAttach?.(targetSessionId, file);
          } catch (error) {
            alert(error instanceof Error ? error.message : '传文件失败');
          }
        }}
      />
      {editorOpen && (
        <div
          data-quickbar-allow-pointer="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 120,
            backgroundColor: 'rgba(8, 10, 18, 0.78)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'flex-end',
            paddingBottom: overlayBottomInsetStyle,
          }}
        >
          <div
            style={{
              width: '100%',
              height: overlaySheetHeightStyle,
              maxHeight: overlaySheetHeightStyle,
              borderRadius: '26px 26px 0 0',
              backgroundColor: '#f7f8fb',
              color: mobileTheme.colors.lightText,
              boxShadow: '0 -20px 50px rgba(0,0,0,0.28)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 18px 12px',
                borderBottom: '1px solid rgba(23, 27, 45, 0.08)',
                backgroundColor: '#fff',
              }}
            >
              <div
                style={{
                  width: '42px',
                  height: '5px',
                  borderRadius: '999px',
                  backgroundColor: 'rgba(23, 27, 45, 0.15)',
                  margin: '0 auto 12px',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  onClick={closeEditor}
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '999px',
                    border: 'none',
                    backgroundColor: '#eef2f8',
                    color: mobileTheme.colors.lightText,
                    fontSize: '20px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  aria-label="Close shortcut editor"
                >
                  ×
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '20px', fontWeight: 800 }}>快捷输入设置</div>
                </div>
              </div>
            </div>

            <div
              data-testid="quick-action-editor-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                padding: '16px',
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                overscrollBehaviorY: 'contain',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>当前快捷输入</div>
                </div>
                <button
                  onClick={() => openDraftForm()}
                  style={{
                    minHeight: '38px',
                    padding: '0 14px',
                    borderRadius: '999px',
                    border: 'none',
                    backgroundColor: 'rgba(22, 119, 255, 0.12)',
                    color: '#1677ff',
                    fontWeight: 800,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  + 添加
                </button>
              </div>

              <div
                style={{
                  borderRadius: '20px',
                  backgroundColor: '#fff',
                  border: '1px solid rgba(23, 27, 45, 0.08)',
                  overflow: 'hidden',
                }}
              >
                {draftActions.length === 0 ? (
                  <div style={{ height: '12px' }} />
                ) : (
                  draftActions.map((action, index) => (
                    <div
                      key={action.id}
                      style={{
                        padding: '14px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        borderTop: index === 0 ? 'none' : '1px solid rgba(23, 27, 45, 0.08)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '17px', fontWeight: 600 }}>{action.label || '未命名'}</div>
                        <div
                          style={{
                            fontSize: '12px',
                            color: mobileTheme.colors.lightMuted,
                            marginTop: '4px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {formatSnippetPreview(action.textInput) || '(空文本)'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <button
                          onClick={() => persistDraftActions(moveItem(draftActions, index, index - 1))}
                          disabled={index === 0}
                          style={overlayIconButton(index === 0)}
                          aria-label={`Move ${action.label} up`}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => persistDraftActions(moveItem(draftActions, index, index + 1))}
                          disabled={index === draftActions.length - 1}
                          style={overlayIconButton(index === draftActions.length - 1)}
                          aria-label={`Move ${action.label} down`}
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => openDraftForm(action)}
                          style={overlayTextButton('#eef2f8', mobileTheme.colors.lightText)}
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => {
                            persistDraftActions(draftActions.filter((item) => item.id !== action.id));
                            if (editingId === action.id) {
                              setEditingId(null);
                              setDraftLabel('');
                              setDraftTextInput('');
                            }
                          }}
                          style={overlayTextButton('rgba(255, 124, 146, 0.12)', mobileTheme.colors.danger)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {(editingId !== null || draftActions.length === 0) && (
                <div
                  style={{
                    borderRadius: '20px',
                    backgroundColor: '#fff',
                    border: '1px solid rgba(23, 27, 45, 0.08)',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 700 }}>
                      {editingIndex >= 0 ? '编辑快捷输入' : '新增快捷输入'}
                    </div>
                  </div>

                  <input
                    value={draftLabel}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setDraftLabel(nextValue);
                      updateEditingAction(nextValue, draftTextInput);
                    }}
                    placeholder="显示名称"
                    style={lightEditorInputStyle()}
                  />
                  <textarea
                    value={draftTextInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setDraftTextInput(nextValue);
                      updateEditingAction(draftLabel, nextValue);
                    }}
                    placeholder="保存好的字符串，例如：git status"
                    style={{
                      ...lightEditorInputStyle(),
                      minHeight: '96px',
                      resize: 'vertical',
                      whiteSpace: 'pre-wrap',
                    }}
                  />

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      onClick={closeEditor}
                      style={{
                        width: '100%',
                        minHeight: '44px',
                        border: 'none',
                        borderRadius: '14px',
                        backgroundColor: '#eef2f8',
                        color: mobileTheme.colors.lightText,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      完成
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {shortcutEditorOpen && (
        <div
          data-quickbar-allow-pointer="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 121,
            backgroundColor: 'rgba(8, 10, 18, 0.78)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'flex-end',
            paddingBottom: overlayBottomInsetStyle,
          }}
        >
          <div
            style={{
              width: '100%',
              height: overlaySheetHeightStyle,
              maxHeight: overlaySheetHeightStyle,
              borderRadius: '26px 26px 0 0',
              backgroundColor: '#f7f8fb',
              color: mobileTheme.colors.lightText,
              boxShadow: '0 -20px 50px rgba(0,0,0,0.28)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 18px 12px',
                borderBottom: '1px solid rgba(23, 27, 45, 0.08)',
                backgroundColor: '#fff',
              }}
            >
              <div
                style={{
                  width: '42px',
                  height: '5px',
                  borderRadius: '999px',
                  backgroundColor: 'rgba(23, 27, 45, 0.15)',
                  margin: '0 auto 12px',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {shortcutEditorMode === 'form' ? (
                  <button
                    onClick={backToShortcutList}
                    style={{
                      width: '34px',
                      height: '34px',
                      borderRadius: '999px',
                      border: 'none',
                      backgroundColor: '#eef2f8',
                      color: mobileTheme.colors.lightText,
                      fontSize: '20px',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                    aria-label="返回快捷键列表"
                  >
                    ‹
                  </button>
                ) : (
                  <div style={{ width: '34px', height: '34px', flexShrink: 0 }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '20px', fontWeight: 800, textAlign: 'center' }}>
                    {shortcutEditorMode === 'form'
                      ? (editingShortcutIndex >= 0 ? '编辑快捷键' : '添加快捷键')
                      : '快捷按键设置'}
                  </div>
                </div>
                <button
                  onClick={closeShortcutEditor}
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '999px',
                    border: 'none',
                    backgroundColor: '#eef2f8',
                    color: mobileTheme.colors.lightText,
                    fontSize: '20px',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  aria-label="关闭快捷键设置"
                >
                  ×
                </button>
              </div>
            </div>

            <div
              ref={shortcutEditorScrollRef}
              data-testid="shortcut-editor-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                padding: '16px',
                overflowY: 'auto',
                overflowX: 'hidden',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                overscrollBehaviorY: 'contain',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              {shortcutEditorMode === 'list' ? (
                <div
                  data-testid="shortcut-editor-list"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                    minHeight: 'max-content',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>当前滚动快捷键</div>
                    <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, marginTop: '4px' }}>
                      三行分开管理：第一行工具栏，第二行只放单按键，第三行只放组合键 / 复合动作。
                    </div>
                  </div>

                  {SHORTCUT_ROW_ORDER.map((row) => {
                    const rowMeta = SHORTCUT_ROW_META[row];
                    const rowActions = draftShortcutActions.filter((action) => action.row === row);
                    return (
                      <div
                        key={row}
                        style={{
                          borderRadius: '20px',
                          backgroundColor: '#fff',
                          border: '1px solid rgba(23, 27, 45, 0.08)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            padding: '16px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '12px',
                            backgroundColor: '#fff',
                          }}
                        >
                          <div>
                            <div style={{ fontSize: '16px', fontWeight: 800 }}>{rowMeta.title}</div>
                            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, marginTop: '4px' }}>
                              {rowMeta.summary}
                            </div>
                          </div>
                          <button
                            onClick={() => openShortcutForm(row)}
                            style={{
                              minHeight: '38px',
                              padding: '0 14px',
                              borderRadius: '999px',
                              border: 'none',
                              backgroundColor: 'rgba(22, 119, 255, 0.12)',
                              color: '#1677ff',
                              fontWeight: 800,
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            {rowMeta.addLabel}
                          </button>
                        </div>

                        {rowActions.length === 0 ? (
                          <div
                            style={{
                              padding: '0 16px 18px',
                              fontSize: '13px',
                              color: mobileTheme.colors.lightMuted,
                            }}
                          >
                            当前还没有内容，点右侧按钮进入详情页添加。
                          </div>
                        ) : (
                          rowActions.map((action, index) => {
                            const displayMeta = resolveShortcutDisplayMeta(action.label, action.sequence);
                            return (
                              <div
                                key={action.id}
                                style={{
                                  padding: '12px 14px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '10px',
                                  borderTop: '1px solid rgba(23, 27, 45, 0.08)',
                                }}
                              >
                                <button
                                  onClick={() => openShortcutForm(row, action)}
                                  aria-label={`查看 ${action.label || '未命名快捷键'} 详情`}
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    border: 'none',
                                    background: 'transparent',
                                    padding: 0,
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: displayMeta.titleUsesKeycap ? '28px' : '16px',
                                      lineHeight: displayMeta.titleUsesKeycap ? 1 : 1.2,
                                      fontWeight: displayMeta.titleUsesKeycap ? 700 : 600,
                                      color: mobileTheme.colors.lightText,
                                    }}
                                  >
                                    {displayMeta.titleUsesKeycap
                                      ? renderShortcutVisualNode(displayMeta.titleSourceLabel, 'list')
                                      : displayMeta.title}
                                  </div>
                                  {displayMeta.subtitle ? (
                                    <div
                                      style={{
                                        fontSize: '12px',
                                        color: mobileTheme.colors.lightMuted,
                                        marginTop: displayMeta.titleUsesKeycap ? '4px' : '3px',
                                        lineHeight: 1.2,
                                      }}
                                    >
                                      {displayMeta.subtitle}
                                    </div>
                                  ) : null}
                                </button>
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'flex-end',
                                    gap: '6px',
                                    flexWrap: 'wrap',
                                    flexShrink: 0,
                                  }}
                                >
                                  <button
                                    onClick={() => openShortcutForm(row, action)}
                                    style={compactOverlayTextButton('rgba(22, 119, 255, 0.12)', '#1677ff')}
                                    aria-label={`编辑 ${action.label || '未命名快捷键'}`}
                                  >
                                    编辑
                                  </button>
                                  <button
                                    onClick={() => persistShortcutActions(moveShortcutActionWithinRow(draftShortcutActions, row, index, index - 1))}
                                    disabled={index === 0}
                                    style={compactOverlayIconButton(index === 0)}
                                    aria-label={`上移 ${action.label}`}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    onClick={() => persistShortcutActions(moveShortcutActionWithinRow(draftShortcutActions, row, index, index + 1))}
                                    disabled={index === rowActions.length - 1}
                                    style={compactOverlayIconButton(index === rowActions.length - 1)}
                                    aria-label={`下移 ${action.label}`}
                                  >
                                    ↓
                                  </button>
                                  <button
                                    onClick={() => persistShortcutActions(draftShortcutActions.filter((item) => item.id !== action.id))}
                                    style={compactOverlayTextButton('rgba(255, 124, 146, 0.12)', mobileTheme.colors.danger)}
                                    aria-label={`删除 ${action.label}`}
                                  >
                                    删除
                                  </button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  style={{
                    borderRadius: '24px',
                    backgroundColor: '#fff',
                    border: '1px solid rgba(23, 27, 45, 0.08)',
                    padding: '18px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                  }}
                >
                  <input
                    value={draftShortcutLabel}
                    onChange={(event) => setDraftShortcutLabel(event.target.value)}
                    placeholder="快捷键名称 / 显示名称"
                    style={lightEditorInputStyle()}
                  />
                  <div
                    style={{
                      borderRadius: '16px',
                      backgroundColor: '#eef2f8',
                      padding: '12px 14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 800, color: '#1677ff' }}>{draftShortcutRowMeta.formTag}</div>
                    <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
                      {draftShortcutRowMeta.formHint}
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '8px',
                      borderRadius: '18px',
                      backgroundColor: '#eef2f5',
                      padding: '6px',
                    }}
                  >
                    <button
                      onClick={() => setShortcutEditorTab('keyboard')}
                      style={{
                        minHeight: '44px',
                        borderRadius: '14px',
                        border: 'none',
                        backgroundColor: shortcutEditorTab === 'keyboard' ? '#ffffff' : 'transparent',
                        color: shortcutEditorTab === 'keyboard' ? '#1677ff' : mobileTheme.colors.lightText,
                        fontWeight: 800,
                        cursor: 'pointer',
                        boxShadow: shortcutEditorTab === 'keyboard' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      }}
                    >
                      键盘按键
                    </button>
                    <button
                      onClick={() => setShortcutEditorTab('common')}
                      style={{
                        minHeight: '44px',
                        borderRadius: '14px',
                        border: 'none',
                        backgroundColor: shortcutEditorTab === 'common' ? '#ffffff' : 'transparent',
                        color: shortcutEditorTab === 'common' ? '#1677ff' : mobileTheme.colors.lightText,
                        fontWeight: 800,
                        cursor: 'pointer',
                        boxShadow: shortcutEditorTab === 'common' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                      }}
                    >
                      系统操作
                    </button>
                  </div>
                  <textarea
                    value={draftShortcutBuild.preview || draftShortcutSequence}
                    readOnly
                    placeholder={draftShortcutRow === 'top-scroll' ? '点击下方按钮选择单个按键' : '点击下方按钮组合快捷键'}
                    style={{
                      ...lightEditorInputStyle(),
                      minHeight: '74px',
                      whiteSpace: 'pre-wrap',
                    }}
                  />

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                    {draftShortcutTokens.length === 0 ? (
                      <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>当前还没有加入特殊键</div>
                    ) : (
                      draftShortcutTokens.map((token, index) => (
                        <button
                          key={`${token.label}-${index}`}
                          onClick={() => removeShortcutToken(index)}
                          style={floatingPillButton('rgba(22, 119, 255, 0.08)', '#1677ff')}
                        >
                          {token.label} ×
                        </button>
                      ))
                    )}
                    <button
                      onClick={clearShortcutTokens}
                      disabled={draftShortcutTokens.length === 0}
                      style={floatingPillButton(draftShortcutTokens.length === 0 ? '#f3f5f9' : '#eef2f8', draftShortcutTokens.length === 0 ? '#c3cad7' : mobileTheme.colors.lightText)}
                    >
                      清空
                    </button>
                  </div>

                  {draftShortcutEffectiveError ? (
                    <div style={{ fontSize: '12px', color: mobileTheme.colors.danger, lineHeight: 1.5 }}>
                      {draftShortcutEffectiveError}
                    </div>
                  ) : null}

                  {shortcutEditorTab === 'keyboard' ? (
                    <>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          value={draftShortcutTextInput}
                          onChange={(event) => setDraftShortcutTextInput(event.target.value)}
                          placeholder={draftShortcutRowMeta.inputPlaceholder}
                          style={{
                            ...lightEditorInputStyle(),
                            minHeight: '40px',
                            flex: 1,
                          }}
                        />
                        <button
                          onClick={appendShortcutTextInput}
                          style={{
                            minWidth: '84px',
                            minHeight: '40px',
                            border: 'none',
                            borderRadius: '14px',
                            backgroundColor: 'rgba(22, 119, 255, 0.12)',
                            color: '#1677ff',
                            fontWeight: 800,
                            cursor: 'pointer',
                          }}
                        >
                          加入
                        </button>
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
                          gap: '6px',
                        }}
                      >
                        {availableKeyboardShortcutTokens.map((token) => (
                          <button
                            key={`${token.label}-${token.sequence}`}
                            onClick={() => appendShortcutToken(token)}
                            aria-label={token.label}
                            style={shortcutTokenGridButton(
                              token.kind === 'modifier',
                              draftShortcutTokens.some((current) => current.label === token.label && current.sequence === token.sequence),
                            )}
                          >
                            <span
                              style={{
                                display: 'block',
                                width: '100%',
                                lineHeight: 1.1,
                                textAlign: 'center',
                              }}
                            >
                              {renderShortcutVisualNode(token.label, 'token')}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                        gap: '6px',
                      }}
                    >
                      {availableCommonShortcutTokens.map((token) => (
                        <button
                          key={`${token.label}-${token.sequence}`}
                          onClick={() => appendShortcutToken(token)}
                          style={shortcutTokenGridButton(
                            false,
                            draftShortcutTokens.some((current) => current.label === token.label && current.sequence === token.sequence),
                          )}
                        >
                          {token.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={saveShortcutForm}
                    disabled={!draftShortcutBuild.sequence || Boolean(draftShortcutEffectiveError)}
                    style={{
                      width: '100%',
                      minHeight: '52px',
                      border: 'none',
                      borderRadius: '16px',
                      backgroundColor: '#1677ff',
                      color: '#fff',
                      fontWeight: 800,
                      fontSize: '18px',
                      cursor: !draftShortcutBuild.sequence || draftShortcutEffectiveError ? 'not-allowed' : 'pointer',
                      opacity: !draftShortcutBuild.sequence || draftShortcutEffectiveError ? 0.55 : 1,
                      marginTop: '6px',
                    }}
                  >
                    {editingShortcutIndex >= 0 ? '保存快捷键' : '添加快捷键'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {floatingMenuOpen && !editorOpen && (
        <>
          <div
            data-quickbar-allow-pointer="true"
            onClick={() => setFloatingMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 129,
              backgroundColor: 'rgba(5, 8, 14, 0.18)',
            }}
          />
          <div
            ref={floatingPanelRef}
            data-quickbar-allow-pointer="true"
            style={{
              position: 'fixed',
              right: '12px',
              bottom: `calc(${floatingPanelBottomPx + Math.max(0, keyboardInsetPx)}px + env(safe-area-inset-bottom, 0px))`,
              zIndex: 130,
              width: 'min(320px, calc(100vw - 24px))',
              maxHeight: `min(560px, calc(100dvh - ${Math.max(180, keyboardInsetPx + 72)}px))`,
              borderRadius: '22px',
              backgroundColor: 'rgba(23, 27, 45, 0.96)',
              color: '#fff',
              boxShadow: '0 20px 50px rgba(0,0,0,0.32)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div
              style={{
                padding: '14px 14px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                flexDirection: 'column',
              gap: '10px',
            }}
          >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 800 }}>快捷输入</div>
                  <div style={{ marginTop: '2px', fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>
                    外点关闭，右侧可直接进入定时发送
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFloatingMenuOpen(false)}
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '999px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    color: '#fff',
                    fontSize: '18px',
                    fontWeight: 800,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  aria-label="关闭快捷输入"
                >
                  ×
                </button>
              </div>

              <div
                style={{
                  borderRadius: '18px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  backgroundColor: 'rgba(14, 19, 31, 0.88)',
                  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.02)',
                  padding: '8px',
                }}
              >
                <textarea
                  value={sessionDraft}
                  onChange={(event) => onSessionDraftChange?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      sendSessionDraft();
                    }
                  }}
                  placeholder="预输入内容，按 session 持久化"
                  style={{
                    width: '100%',
                    minHeight: '148px',
                    maxHeight: '220px',
                    resize: 'vertical',
                    padding: '12px 14px',
                    borderRadius: '14px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    color: '#fff',
                    fontSize: '14px',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.5,
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                <button
                  onClick={() => {
                    const trimmed = sessionDraft.trim();
                    if (!trimmed) {
                      return;
                    }
                    const nextAction: QuickAction = {
                      id: createDraftActionId(),
                      label: trimmed.slice(0, 12) || '新片段',
                      sequence: sessionDraft.replace(/\r?\n/g, '\r'),
                      order: sortedQuickActions.length,
                    };
                    onQuickActionsChange?.([...sortedQuickActions, nextAction]);
                  }}
                  style={{
                    flex: 1,
                    minHeight: '40px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '14px',
                    backgroundColor: 'rgba(31, 38, 53, 0.82)',
                    color: '#fff',
                    fontWeight: 700,
                  }}
                >
                  加为快捷输入
                </button>
                <button
                  onClick={() => {
                    setFloatingMenuOpen(false);
                    onOpenScheduleComposer?.(sessionDraft);
                  }}
                  disabled={!activeSessionId}
                  style={{
                    width: '88px',
                    minHeight: '40px',
                    border: '1px solid rgba(113, 164, 255, 0.24)',
                    borderRadius: '14px',
                    backgroundColor: 'rgba(113, 164, 255, 0.12)',
                    color: '#8db7ff',
                    fontWeight: 800,
                    opacity: !activeSessionId ? 0.45 : 1,
                    cursor: !activeSessionId ? 'not-allowed' : 'pointer',
                  }}
                >
                  定时
                </button>
                <button
                  onClick={() => {
                    sendSessionDraft();
                  }}
                  style={{
                    width: '88px',
                    minHeight: '40px',
                    border: '1px solid rgba(31,214,122,0.18)',
                    borderRadius: '14px',
                    backgroundColor: 'rgba(31,214,122,0.18)',
                    color: mobileTheme.colors.accent,
                    fontWeight: 800,
                  }}
                  >
                    发送
                  </button>
              </div>

              {splitAvailable && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
                  <button
                    type="button"
                    onClick={() => {
                      onToggleSplitLayout?.();
                      setFloatingMenuOpen(false);
                    }}
                    style={{
                      flex: 1,
                      minHeight: '40px',
                      border: '1px solid rgba(113, 164, 255, 0.24)',
                      borderRadius: '14px',
                      backgroundColor: splitVisible ? 'rgba(113, 164, 255, 0.18)' : 'rgba(31, 38, 53, 0.82)',
                      color: splitVisible ? '#8db7ff' : '#fff',
                      fontWeight: 800,
                    }}
                  >
                    {splitVisible ? '关闭分屏' : '开启分屏'}
                  </button>
                  {splitVisible && (
                    <button
                      type="button"
                      onClick={() => {
                        onCycleSplitPane?.();
                        setFloatingMenuOpen(false);
                      }}
                      style={{
                        width: '110px',
                        minHeight: '40px',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '14px',
                        backgroundColor: 'rgba(22, 28, 41, 0.92)',
                        color: '#fff',
                        fontWeight: 700,
                      }}
                    >
                      切换副屏
                    </button>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '8px', flex: 1, minWidth: 0 }}>
                  <button
                    onClick={() => setFloatingPanelTab('quick-actions')}
                    style={floatingPillButton(
                      floatingPanelTab === 'quick-actions' ? 'rgba(31,214,122,0.18)' : 'rgba(31, 38, 53, 0.82)',
                      floatingPanelTab === 'quick-actions' ? mobileTheme.colors.accent : '#fff',
                    )}
                  >
                    快捷列表
                  </button>
                  <button
                    onClick={() => setFloatingPanelTab('clipboard')}
                    style={floatingPillButton(
                      floatingPanelTab === 'clipboard' ? 'rgba(31,214,122,0.18)' : 'rgba(31, 38, 53, 0.82)',
                      floatingPanelTab === 'clipboard' ? mobileTheme.colors.accent : '#fff',
                    )}
                  >
                    剪贴板
                  </button>
                </div>
                <button
                  onClick={() => openEditor('list')}
                  style={floatingPillButton('rgba(22, 28, 41, 0.92)', '#fff')}
                >
                  管理
                </button>
              </div>
            </div>

            <div
              data-testid="floating-quick-menu-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                padding: '10px',
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                touchAction: 'pan-y',
                maxHeight: `${10 * 50}px`,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {floatingPanelTab === 'quick-actions' ? (
                sortedQuickActions.length === 0 ? (
                  <div style={{ height: '8px' }} />
                ) : (
                  sortedQuickActions.map((action) => {
                    const draftAction = {
                      ...action,
                      textInput: action.sequence,
                    };
                    return (
                      <div
                        key={action.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <button
                          onClick={() => {
                            sendQuickActionNow(action.sequence);
                          }}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            minHeight: '42px',
                            border: 'none',
                            borderRadius: '14px',
                            backgroundColor: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            padding: '0 14px',
                            textAlign: 'left',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '10px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{action.label || '未命名'}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', flexShrink: 0 }}>
                            {formatSnippetPreview(action.sequence) || '(空)'}
                          </span>
                        </button>
                        <button
                          onClick={() => openEditor('edit', draftAction)}
                          style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '12px',
                            border: 'none',
                            backgroundColor: 'rgba(255,255,255,0.1)',
                            color: '#fff',
                            fontSize: '16px',
                            cursor: 'pointer',
                            flexShrink: 0,
                          }}
                          aria-label={`Edit ${action.label || 'quick action'}`}
                        >
                          ✎
                        </button>
                      </div>
                    );
                  })
                )
              ) : (
                <>
                  <button
                    onClick={() => {
                      void captureSystemClipboard();
                    }}
                    style={{
                      minHeight: '40px',
                      border: 'none',
                      borderRadius: '14px',
                      backgroundColor: 'rgba(255,255,255,0.12)',
                      color: '#fff',
                      fontWeight: 800,
                    }}
                  >
                    {clipboardBusy ? '读取中…' : '读取系统剪贴板'}
                  </button>
                  {clipboardError && (
                    <div style={{ fontSize: '12px', color: 'rgba(255, 173, 96, 0.92)', lineHeight: 1.4 }}>
                      {clipboardError}
                    </div>
                  )}
                  {clipboardHistory.length === 0 ? (
                    <div style={{ height: '8px' }} />
                  ) : (
                    clipboardHistory.map((entry, index) => (
                      <button
                        key={`${index}-${entry.slice(0, 12)}`}
                        onClick={() => appendToDraft(entry)}
                        style={{
                          width: '100%',
                          minHeight: '46px',
                          border: 'none',
                          borderRadius: '14px',
                          backgroundColor: 'rgba(255,255,255,0.08)',
                          color: '#fff',
                          padding: '10px 14px',
                          textAlign: 'left',
                          fontWeight: 600,
                          lineHeight: 1.35,
                        }}
                      >
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                          Clipboard #{index + 1}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {entry}
                        </div>
                      </button>
                    ))
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {!editorOpen && !shortcutEditorOpen && (
        <button
          ref={floatingBubbleRef}
          data-quickbar-allow-pointer="true"
          type="button"
          tabIndex={-1}
          onFocus={(event) => event.currentTarget.blur()}
          onPointerDown={(event) => {
            if (event.pointerType === 'touch') {
              return;
            }
            event.preventDefault();
            blurCurrentTarget(event.currentTarget);
            event.currentTarget.setPointerCapture(event.pointerId);
            const rect = event.currentTarget.getBoundingClientRect();
            floatingBubbleDragRef.current = {
              pointerId: event.pointerId,
              active: false,
              startX: event.clientX,
              startY: event.clientY,
              originX: rect.left,
              originY: rect.top,
              width: rect.width || FLOATING_BUBBLE_SIZE,
              height: rect.height || FLOATING_BUBBLE_SIZE,
            };
          }}
          onPointerMove={(event) => {
            if (event.pointerType === 'touch') {
              return;
            }
            const drag = floatingBubbleDragRef.current;
            if (drag.pointerId !== event.pointerId) {
              return;
            }
            const deltaX = event.clientX - drag.startX;
            const deltaY = event.clientY - drag.startY;
            if (!drag.active && Math.hypot(deltaX, deltaY) >= FLOATING_BUBBLE_DRAG_THRESHOLD_PX) {
              drag.active = true;
              suppressBubbleClickRef.current = true;
            }
            if (!drag.active) {
              return;
            }
            event.preventDefault();
            setFloatingBubblePosition(
              clampFloatingBubblePosition(
                drag.originX + deltaX,
                drag.originY + deltaY,
                drag.width,
                drag.height,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (event.pointerType === 'touch') {
              return;
            }
            if (floatingBubbleDragRef.current.pointerId === event.pointerId) {
              if (floatingBubbleDragRef.current.active) {
                suppressBubbleClickRef.current = true;
                window.setTimeout(() => {
                  suppressBubbleClickRef.current = false;
                }, 180);
              }
              floatingBubbleDragRef.current.active = false;
              floatingBubbleDragRef.current.pointerId = -1;
            }
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => {
            if (event.pointerType === 'touch') {
              return;
            }
            floatingBubbleDragRef.current.active = false;
            floatingBubbleDragRef.current.pointerId = -1;
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch (error) {
              console.warn('[TerminalQuickBar] Failed to release floating bubble pointer capture:', error);
            }
          }}
          onClick={() => {
            if (suppressBubbleClickRef.current) {
              return;
            }
            setFloatingMenuOpen((current) => !current);
          }}
          onTouchStart={(event) => {
            event.stopPropagation();
            const touch = event.touches[0];
            if (!touch) {
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            floatingBubbleTouchDragRef.current = {
              active: false,
              moved: false,
              startX: touch.clientX,
              startY: touch.clientY,
              originX: rect.left,
              originY: rect.top,
              width: rect.width || FLOATING_BUBBLE_SIZE,
              height: rect.height || FLOATING_BUBBLE_SIZE,
            };
          }}
          onTouchMove={(event) => {
            const touch = event.touches[0];
            const drag = floatingBubbleTouchDragRef.current;
            if (!touch) {
              return;
            }
            const deltaX = touch.clientX - drag.startX;
            const deltaY = touch.clientY - drag.startY;
            if (!drag.active && Math.hypot(deltaX, deltaY) >= FLOATING_BUBBLE_DRAG_THRESHOLD_PX) {
              drag.active = true;
              suppressBubbleClickRef.current = true;
            }
            if (!drag.active) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            drag.moved = true;
            setFloatingBubblePosition(
              clampFloatingBubblePosition(
                drag.originX + deltaX,
                drag.originY + deltaY,
                drag.width,
                drag.height,
              ),
            );
          }}
          onTouchEnd={() => {
            if (floatingBubbleTouchDragRef.current.active) {
              suppressBubbleClickRef.current = true;
              window.setTimeout(() => {
                suppressBubbleClickRef.current = false;
              }, 180);
            }
            floatingBubbleTouchDragRef.current.active = false;
            floatingBubbleTouchDragRef.current.moved = false;
          }}
          onTouchCancel={() => {
            floatingBubbleTouchDragRef.current.active = false;
            floatingBubbleTouchDragRef.current.moved = false;
          }}
          style={{
            position: 'fixed',
            right: floatingBubblePosition.x === null ? `${FLOATING_BUBBLE_MARGIN}px` : 'auto',
            bottom: floatingBubblePosition.y === null
              ? `calc(${floatingBubbleBottomPx + Math.max(0, keyboardInsetPx)}px + env(safe-area-inset-bottom, 0px))`
              : 'auto',
            left: floatingBubblePosition.x === null ? 'auto' : `${floatingBubblePosition.x}px`,
            top: floatingBubblePosition.y === null ? 'auto' : `${floatingBubblePosition.y}px`,
            zIndex: 128,
            width: `${FLOATING_BUBBLE_SIZE}px`,
            height: `${FLOATING_BUBBLE_SIZE}px`,
            borderRadius: '999px',
            border: '1px solid rgba(255,255,255,0.12)',
            background: floatingMenuOpen ? 'rgba(31,214,122,0.18)' : 'rgba(18, 24, 38, 0.72)',
            color: floatingMenuOpen ? mobileTheme.colors.accent : '#fff',
            fontSize: '20px',
            fontWeight: 800,
            boxShadow: '0 8px 18px rgba(0,0,0,0.24)',
            transform: 'none',
            touchAction: 'none',
          }}
          aria-label="Toggle floating quick menu"
        >
          ⌘
        </button>
      )}

      {!floatingMenuOpen && (
        <div data-testid="terminal-quickbar-shell-rows">
          <div
            data-quickbar-shell-row="true"
            style={{
              minHeight: '40px',
              display: 'flex',
              alignItems: 'stretch',
              gap: `${QUICK_BAR_ROW_GAP}px`,
              padding: `0 ${QUICK_BAR_SIDE_PADDING}px`,
              marginBottom: `${QUICK_BAR_ROW_GAP}px`,
            }}
          >
            <div data-testid="quickbar-fixed-cluster-top" style={fixedClusterStyle}>
              {topFixedActions.map((action) => renderBaseActionButton(action, { fixed: true, compact: true }))}
            </div>
            <div style={scrollTrackShellStyle}>
              <div data-quickbar-scroll-track="true" style={scrollTrackStyle}>
                {topScrollActions.map((action) => renderBaseActionButton(action, { compact: true }))}
                {renderBaseActionButton(topShortcutEditorEntry, { compact: true })}
              </div>
            </div>
          </div>

          <div
            data-quickbar-shell-row="true"
            style={{
              minHeight: '40px',
              display: 'flex',
              alignItems: 'stretch',
              gap: `${QUICK_BAR_ROW_GAP}px`,
              padding: `2px ${QUICK_BAR_SIDE_PADDING}px 4px`,
              backgroundColor: 'rgba(255,255,255,0.02)',
            }}
          >
            <div data-testid="quickbar-fixed-cluster-bottom" style={fixedClusterStyle}>
              {bottomFixedActions.map((action) => renderBaseActionButton(action, { fixed: true, compact: true }))}
            </div>
            <div style={scrollTrackShellStyle}>
              <div data-quickbar-scroll-track="true" style={scrollTrackStyle}>
                {bottomScrollActions.map((action) => renderBaseActionButton(action, { compact: true }))}
                {renderBaseActionButton(bottomShortcutEditorEntry, { compact: true })}
              </div>
            </div>
          </div>

          <div
            data-quickbar-shell-row="true"
            style={{
              display: 'flex',
              alignItems: 'stretch',
              padding: `2px ${QUICK_BAR_SIDE_PADDING}px 4px`,
            }}
          >
            <div style={scrollTrackShellStyle}>
              <div data-testid="quickbar-tool-row" data-quickbar-scroll-track="true" style={scrollTrackStyle}>
                {toolRowActions.map((action) => renderBaseActionButton(action))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSnippetPreview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 24);
}

function lightEditorInputStyle() {
  return {
    ...editorInputStyle(),
    backgroundColor: '#f4f6fb',
    border: '1px solid rgba(23, 27, 45, 0.1)',
    color: mobileTheme.colors.lightText,
  } as const;
}

function buildVisibleShortcutRowActions(
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

  SHORTCUT_PRESETS
    .filter((preset) => preset.row === row)
    .forEach((preset) => {
      const customAction = customBySequence.get(preset.sequence);
      if (customAction) {
        visibleActions.push({
          id: customAction.id,
          label: customAction.label,
          sequence: customAction.sequence,
        });
        consumedSequences.add(customAction.sequence);
        return;
      }
      visibleActions.push({
        id: `preset-${row}-${preset.label}-${preset.sequence}`,
        label: preset.label,
        sequence: preset.sequence,
      });
      consumedSequences.add(preset.sequence);
    });

  customRowActions.forEach((action) => {
    if (consumedSequences.has(action.sequence)) {
      return;
    }
    visibleActions.push({
      id: action.id,
      label: action.label,
      sequence: action.sequence,
    });
    consumedSequences.add(action.sequence);
  });

  return visibleActions;
}

function overlayIconButton(disabled: boolean) {
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

function compactOverlayIconButton(disabled: boolean) {
  return {
    ...overlayIconButton(disabled),
    width: '30px',
    height: '30px',
    fontSize: '16px',
  } as const;
}

function overlayTextButton(backgroundColor: string, color: string) {
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

function compactOverlayTextButton(backgroundColor: string, color: string) {
  return {
    ...overlayTextButton(backgroundColor, color),
    minHeight: '30px',
    padding: '0 10px',
    fontSize: '14px',
  } as const;
}

function floatingPillButton(backgroundColor: string, color: string) {
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

function shortcutTokenGridButton(isModifier: boolean, active: boolean) {
  return {
    minHeight: '62px',
    borderRadius: '14px',
    border: active ? '1px solid rgba(22, 119, 255, 0.28)' : '1px solid rgba(23, 27, 45, 0.12)',
    backgroundColor: active
      ? 'rgba(22, 119, 255, 0.10)'
      : isModifier
        ? '#ffffff'
        : '#f7f9fc',
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
