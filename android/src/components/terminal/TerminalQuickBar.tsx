import { useEffect, useMemo, useRef, useState } from 'react';
import { mobileTheme } from '../../lib/mobile-ui';
import type { QuickAction, TerminalShortcutAction } from '../../lib/types';

const FLOATING_BUBBLE_SIZE = 48;
const FLOATING_BUBBLE_MARGIN = 10;
const FLOATING_BUBBLE_LONG_PRESS_MS = 260;
const QUICK_BAR_SIDE_PADDING = 6;
const QUICK_BAR_ROW_GAP = 4;
const CLIPBOARD_HISTORY_STORAGE_KEY = 'zterm:clipboard-history';
const MAX_CLIPBOARD_HISTORY = 100;
const FLOATING_BUBBLE_POSITION_STORAGE_KEY = 'zterm:floating-bubble-position';

const SHORTCUT_PRESETS: ShortcutPreset[] = [
  { label: '继续', sequence: '继续执行\r', row: 'top-scroll' },
  { label: 'Esc', sequence: '\x1b', row: 'top-scroll' },
  { label: 'Tab', sequence: '\t', row: 'top-scroll' },
  { label: 'Bksp', sequence: '\x7f', row: 'top-scroll' },
  { label: 'Enter', sequence: '\r', row: 'bottom-scroll' },
  { label: 'Space', sequence: ' ', row: 'bottom-scroll' },
  { label: '↑', sequence: '\x1b[A', row: 'bottom-scroll' },
  { label: '↓', sequence: '\x1b[B', row: 'bottom-scroll' },
  { label: '←', sequence: '\x1b[D', row: 'bottom-scroll' },
  { label: '→', sequence: '\x1b[C', row: 'bottom-scroll' },
  { label: 'Paste', sequence: '\x16', row: 'bottom-scroll' },
  { label: 'S-Tab', sequence: '\x1b[Z', row: 'bottom-scroll' },
  { label: 'S-Enter', sequence: '\n', row: 'bottom-scroll' },
];

const BASE_ACTIONS = [
  { id: 'image', label: '图', sequence: '' },
  { id: 'continue', label: '继续', sequence: '继续执行\r' },
  { id: 'esc', label: 'Esc', sequence: '\x1b' },
  { id: 'tab', label: 'Tab', sequence: '\t' },
  { id: 'enter', label: 'Enter', sequence: '\r' },
  { id: 'left', label: '←', sequence: '\x1b[D' },
  { id: 'up', label: '↑', sequence: '\x1b[A' },
  { id: 'down', label: '↓', sequence: '\x1b[B' },
  { id: 'right', label: '→', sequence: '\x1b[C' },
  { id: 'space', label: 'Space', sequence: ' ' },
  { id: 'backspace', label: 'Bksp', sequence: '\x7f' },
  { id: 'shift-tab', label: 'S-Tab', sequence: '\x1b[Z' },
  { id: 'shift-enter', label: 'S-Enter', sequence: '\n' },
  { id: 'paste', label: 'Paste', sequence: '\x16' },
  { id: 'keyboard', label: 'IME', sequence: '' },
];

interface TerminalQuickBarProps {
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onSendSequence?: (sequence: string) => void;
  onImagePaste?: (file: File) => Promise<void> | void;
  keyboardVisible?: boolean;
  keyboardInsetPx?: number;
  onToggleKeyboard?: () => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange?: (value: string) => void;
  onSessionDraftSend?: (value: string) => void;
}

interface DraftQuickAction extends QuickAction {
  textInput: string;
}

type FloatingPanelTab = 'quick-actions' | 'clipboard';

interface DraftShortcutAction extends TerminalShortcutAction {}

interface ShortcutToken {
  label: string;
  sequence: string;
}

interface ShortcutPreset extends ShortcutToken {
  row?: 'top-scroll' | 'bottom-scroll';
}

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

function createDraftActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `quick-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toDraftActions(actions: QuickAction[]): DraftQuickAction[] {
  return actions.map((action) => ({
    ...action,
    textInput: action.sequence,
  }));
}

function normalizeDraftActions(actions: DraftQuickAction[]): QuickAction[] {
  return actions.map(({ textInput, ...action }, index) => ({
    ...action,
    order: index,
    sequence: textInput,
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
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_CLIPBOARD_HISTORY);
}

function dedupeClipboardHistory(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))).slice(0, MAX_CLIPBOARD_HISTORY);
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
  } catch {
    return { x: null, y: null };
  }
}

function createShortcutActionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `shortcut-action-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function sortShortcutActions(actions: TerminalShortcutAction[]) {
  return [...actions].sort((left, right) => {
    if (left.row !== right.row) {
      return left.row.localeCompare(right.row);
    }
    return left.order - right.order;
  });
}

function normalizeShortcutActions(actions: DraftShortcutAction[]): TerminalShortcutAction[] {
  const grouped = new Map<'top-scroll' | 'bottom-scroll', DraftShortcutAction[]>();
  grouped.set('top-scroll', []);
  grouped.set('bottom-scroll', []);
  actions.forEach((action) => {
    grouped.get(action.row)?.push(action);
  });

  return (['top-scroll', 'bottom-scroll'] as const).flatMap((row) =>
    (grouped.get(row) || []).map((action, index) => ({
      ...action,
      order: index,
      row,
    })),
  );
}

function encodeCtrlKey(letter: string) {
  const upper = letter.toUpperCase();
  const code = upper.charCodeAt(0);
  if (code < 65 || code > 90) {
    return '';
  }
  return String.fromCharCode(code - 64);
}

export function TerminalQuickBar({
  quickActions,
  shortcutActions,
  keyboardVisible = false,
  keyboardInsetPx = 0,
  onImagePaste,
  onToggleKeyboard,
  onQuickActionsChange,
  onShortcutActionsChange,
  onSendSequence,
  sessionDraft,
  onSessionDraftChange,
  onSessionDraftSend,
}: TerminalQuickBarProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
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
  const [draftShortcutRow, setDraftShortcutRow] = useState<'top-scroll' | 'bottom-scroll'>('bottom-scroll');
  const [draftShortcutTokens, setDraftShortcutTokens] = useState<ShortcutToken[]>([]);
  const [clipboardHistory, setClipboardHistory] = useState<string[]>([]);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [floatingBubblePosition, setFloatingBubblePosition] = useState<{ x: number | null; y: number | null }>(() => readStoredBubblePosition());
  const suppressKeyboardClickRef = useRef(false);
  const suppressBubbleClickRef = useRef(false);
  const floatingBubblePressTimerRef = useRef<number | null>(null);
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
  const floatingBubbleTouchTimerRef = useRef<number | null>(null);
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

  const sortedQuickActions = useMemo(() => quickActions.slice().sort((a, b) => a.order - b.order), [quickActions]);
  const sortedShortcutActions = useMemo(() => sortShortcutActions(shortcutActions), [shortcutActions]);
  const floatingPanelBottomPx = Math.max(124, keyboardInsetPx + 18);
  const floatingBubbleBottomPx = Math.max(72, keyboardInsetPx + 18);
  const editingIndex = editingId ? draftActions.findIndex((action) => action.id === editingId) : -1;
  const editingShortcutIndex = editingShortcutId ? draftShortcutActions.findIndex((action) => action.id === editingShortcutId) : -1;

  const appendToDraft = (value: string) => {
    onSessionDraftChange?.(`${sessionDraft || ''}${value}`);
  };

  const sendSessionDraft = () => {
    const normalized = sessionDraft.replace(/\r?\n/g, '\r');
    if (!normalized.trim()) {
      return;
    }
    const payload = /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
    onSessionDraftSend?.(payload);
  };

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
            sequence: nextTextInput,
          }
        : action,
    );
    persistDraftActions(nextActions);
  };

  const topFixedActions = useMemo(
    () => BASE_ACTIONS.filter((action) => ['image', 'keyboard'].includes(action.id)),
    [],
  );

  const topScrollActions = useMemo(
    () => sortedShortcutActions.filter((action) => action.row === 'top-scroll'),
    [sortedShortcutActions],
  );

  const bottomFixedActions = useMemo(
    () => BASE_ACTIONS.filter((action) => ['left', 'up', 'down', 'right'].includes(action.id)),
    [],
  );

  const bottomScrollActions = useMemo(
    () => sortedShortcutActions.filter((action) => action.row === 'bottom-scroll'),
    [sortedShortcutActions],
  );

  const shortcutEditorEntry = useMemo(() => ({ id: 'shortcut-editor', label: '按键', sequence: '' }), []);

  const clearFloatingBubblePressTimer = () => {
    if (floatingBubblePressTimerRef.current) {
      window.clearTimeout(floatingBubblePressTimerRef.current);
      floatingBubblePressTimerRef.current = null;
    }
  };

  const clearFloatingBubbleTouchTimer = () => {
    if (floatingBubbleTouchTimerRef.current) {
      window.clearTimeout(floatingBubbleTouchTimerRef.current);
      floatingBubbleTouchTimerRef.current = null;
    }
  };

  const clampFloatingBubblePosition = (nextX: number, nextY: number, width: number, height: number) => {
    if (typeof window === 'undefined') {
      return { x: nextX, y: nextY };
    }

    const maxX = Math.max(FLOATING_BUBBLE_MARGIN, window.innerWidth - width - FLOATING_BUBBLE_MARGIN);
    const maxY = Math.max(FLOATING_BUBBLE_MARGIN, window.innerHeight - height - FLOATING_BUBBLE_MARGIN);
    return {
      x: Math.min(Math.max(FLOATING_BUBBLE_MARGIN, nextX), maxX),
      y: Math.min(Math.max(FLOATING_BUBBLE_MARGIN, nextY), maxY),
    };
  };

  const fixedClusterStyle = {
    display: 'flex',
    gap: `${QUICK_BAR_ROW_GAP}px`,
    flexShrink: 0,
    alignItems: 'center',
    padding: '2px 4px',
    borderRadius: '12px',
    backgroundColor: 'rgba(59, 74, 108, 0.95)',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.03)',
  } as const;

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

  const captureSystemClipboard = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      setClipboardError('当前环境不支持读取系统剪贴板');
      return;
    }

    try {
      setClipboardBusy(true);
      setClipboardError(null);
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
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

  const buildShortcutTokensFromSequence = (label: string, sequence: string): ShortcutToken[] => {
    const matchedPreset = SHORTCUT_PRESETS.find((preset) => preset.sequence === sequence)
      || (sequence.length === 1 && label.startsWith('Ctrl+') ? { label, sequence } : null);

    if (matchedPreset) {
      return [{ label: matchedPreset.label, sequence: matchedPreset.sequence }];
    }

    return sequence
      ? [{ label: label || '已有序列', sequence }]
      : [];
  };

  const syncDraftShortcutTokens = (tokens: ShortcutToken[]) => {
    setDraftShortcutTokens(tokens);
    setDraftShortcutSequence(tokens.map((token) => token.sequence).join(''));
  };

  const openShortcutEditor = (action?: DraftShortcutAction) => {
    setDraftShortcutActions(sortShortcutActions(shortcutActions));
    setFloatingMenuOpen(false);
    if (action) {
      setEditingShortcutId(action.id);
      setDraftShortcutLabel(action.label);
      setDraftShortcutRow(action.row);
      syncDraftShortcutTokens(buildShortcutTokensFromSequence(action.label, action.sequence));
    } else {
      setEditingShortcutId(null);
      setDraftShortcutLabel('');
      setDraftShortcutRow('bottom-scroll');
      syncDraftShortcutTokens([]);
    }
    setShortcutEditorOpen(true);
  };

  const closeShortcutEditor = () => {
    setShortcutEditorOpen(false);
    setEditingShortcutId(null);
    setDraftShortcutLabel('');
    setDraftShortcutSequence('');
    setDraftShortcutRow('bottom-scroll');
    setDraftShortcutTokens([]);
  };

  const appendShortcutToken = (token: ShortcutToken, row?: 'top-scroll' | 'bottom-scroll') => {
    setDraftShortcutLabel((current) => current || token.label);
    setDraftShortcutTokens((current) => {
      const next = [...current, token];
      setDraftShortcutSequence(next.map((item) => item.sequence).join(''));
      return next;
    });
    if (row) {
      setDraftShortcutRow(row);
    }
  };

  const removeShortcutToken = (index: number) => {
    setDraftShortcutTokens((current) => {
      const next = current.filter((_, tokenIndex) => tokenIndex !== index);
      setDraftShortcutSequence(next.map((item) => item.sequence).join(''));
      return next;
    });
  };

  const clearShortcutTokens = () => {
    setDraftShortcutTokens([]);
    setDraftShortcutSequence('');
  };

  const saveShortcutForm = () => {
    const nextSequence = draftShortcutTokens.map((token) => token.sequence).join('');
    if (!nextSequence) {
      return;
    }

    const nextLabel = draftShortcutLabel.trim() || draftShortcutTokens.map((token) => token.label).join(' ') || '新按键';

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
    closeShortcutEditor();
  };

  const applyShortcutPreset = (preset: ShortcutPreset) => {
    appendShortcutToken({ label: preset.label, sequence: preset.sequence }, preset.row);
  };

  const renderBaseActionButton = (action: { id: string; label: string; sequence: string }, options?: { fixed?: boolean; compact?: boolean }) => {
    const compact = options?.compact ?? false;
    const fixed = options?.fixed ?? false;
    return (
      <button
        key={action.id}
        tabIndex={-1}
        onPointerDown={(event) => {
          blurCurrentTarget(event.currentTarget);
          if (action.id !== 'keyboard') {
            return;
          }
          event.preventDefault();
          suppressKeyboardClickRef.current = true;
          onToggleKeyboard?.();
          window.setTimeout(() => {
            suppressKeyboardClickRef.current = false;
          }, 220);
        }}
        onClick={(event) => {
          blurCurrentTarget(event.currentTarget);
          if (action.id === 'keyboard') {
            if (suppressKeyboardClickRef.current) {
              return;
            }
            onToggleKeyboard?.();
            return;
          }
          if (action.id === 'image') {
            imageInputRef.current?.click();
            return;
          }
          if (action.id === 'shortcut-editor') {
            openShortcutEditor();
            return;
          }
          onSendSequence?.(action.sequence);
        }}
        style={{
          minHeight: compact ? '32px' : '34px',
          minWidth: fixed ? '38px' : action.label.length > 4 ? '58px' : action.label.length > 2 ? '48px' : '34px',
          padding: fixed ? '0 8px' : '0 10px',
          border: 'none',
          borderRadius: '10px',
          backgroundColor:
            action.id === 'keyboard' && keyboardVisible
              ? 'rgba(31,214,122,0.18)'
              : fixed
                ? 'rgba(22, 28, 41, 0.92)'
                : 'rgba(31, 38, 53, 0.82)',
          color: action.id === 'keyboard' && keyboardVisible ? mobileTheme.colors.accent : '#fff',
          fontSize: action.id === 'continue' ? '11px' : action.label.length > 3 ? '11px' : '14px',
          fontWeight: 700,
          cursor: 'pointer',
          flexShrink: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {action.label}
      </button>
    );
  };

  return (
    <div
      onPointerDownCapture={(event) => {
        event.stopPropagation();
        if (!(event.target as HTMLElement | null)?.closest('button,input,textarea,label,[data-quickbar-scroll-track="true"]')) {
          event.preventDefault();
        }
      }}
      onTouchStartCapture={(event) => {
        event.stopPropagation();
        if (!(event.target as HTMLElement | null)?.closest('button,input,textarea,label,[data-quickbar-scroll-track="true"]')) {
          event.preventDefault();
        }
      }}
      style={{
        padding: `6px 0 ${mobileTheme.safeArea.bottom}`,
        position: 'relative',
        backgroundColor: 'rgba(11, 15, 24, 0.88)',
        borderTop: '1px solid rgba(255,255,255,0.08)',
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
          try {
            await onImagePaste?.(file);
          } catch (error) {
            alert(error instanceof Error ? error.message : 'Failed to paste image');
          }
        }}
      />
      {editorOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 120,
            backgroundColor: 'rgba(8, 10, 18, 0.78)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'flex-end',
            paddingBottom: `${Math.max(0, keyboardInsetPx)}px`,
          }}
        >
          <div
            style={{
              width: '100%',
              maxHeight: `calc(100dvh - ${Math.max(16, keyboardInsetPx + 16)}px)`,
              borderRadius: '26px 26px 0 0',
              backgroundColor: '#f7f8fb',
              color: mobileTheme.colors.lightText,
              boxShadow: '0 -20px 50px rgba(0,0,0,0.28)',
              display: 'flex',
              flexDirection: 'column',
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
              style={{
                padding: '16px',
                overflowY: 'auto',
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
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 121,
            backgroundColor: 'rgba(8, 10, 18, 0.78)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'flex-end',
            paddingBottom: `${Math.max(0, keyboardInsetPx)}px`,
          }}
        >
          <div
            style={{
              width: '100%',
              maxHeight: `calc(100dvh - ${Math.max(16, keyboardInsetPx + 16)}px)`,
              borderRadius: '26px 26px 0 0',
              backgroundColor: '#f7f8fb',
              color: mobileTheme.colors.lightText,
              boxShadow: '0 -20px 50px rgba(0,0,0,0.28)',
              display: 'flex',
              flexDirection: 'column',
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
                >
                  ×
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '20px', fontWeight: 800 }}>快捷按键设置</div>
                </div>
              </div>
            </div>

            <div
              style={{
                padding: '16px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>当前滚动快捷键</div>
                  <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, marginTop: '4px' }}>特殊键和组合序列都从这里生成，不依赖输入法。</div>
                </div>
                <button
                  onClick={() => openShortcutEditor()}
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
                {draftShortcutActions.length === 0 ? (
                  <div style={{ height: '12px' }} />
                ) : (
                  draftShortcutActions.map((action, index) => (
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
                        <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, marginTop: '4px' }}>
                          {action.row === 'top-scroll' ? '上栏滚动区' : '下栏滚动区'} · {formatSnippetPreview(action.sequence) || '(空)'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <button
                          onClick={() => persistShortcutActions(moveItem(draftShortcutActions, index, index - 1))}
                          disabled={index === 0}
                          style={overlayIconButton(index === 0)}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => persistShortcutActions(moveItem(draftShortcutActions, index, index + 1))}
                          disabled={index === draftShortcutActions.length - 1}
                          style={overlayIconButton(index === draftShortcutActions.length - 1)}
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => openShortcutEditor(action)}
                          style={overlayTextButton('#eef2f8', mobileTheme.colors.lightText)}
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => persistShortcutActions(draftShortcutActions.filter((item) => item.id !== action.id))}
                          style={overlayTextButton('rgba(255, 124, 146, 0.12)', mobileTheme.colors.danger)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

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
                <div style={{ fontSize: '16px', fontWeight: 700 }}>
                  {editingShortcutIndex >= 0 ? '编辑快捷按键' : '新增快捷按键'}
                </div>
                <input
                  value={draftShortcutLabel}
                  onChange={(event) => setDraftShortcutLabel(event.target.value)}
                  placeholder="显示名称"
                  style={lightEditorInputStyle()}
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => setDraftShortcutRow('top-scroll')}
                    style={floatingPillButton(
                      draftShortcutRow === 'top-scroll' ? 'rgba(22, 119, 255, 0.12)' : '#eef2f8',
                      draftShortcutRow === 'top-scroll' ? '#1677ff' : mobileTheme.colors.lightText,
                    )}
                  >
                    上栏
                  </button>
                  <button
                    onClick={() => setDraftShortcutRow('bottom-scroll')}
                    style={floatingPillButton(
                      draftShortcutRow === 'bottom-scroll' ? 'rgba(22, 119, 255, 0.12)' : '#eef2f8',
                      draftShortcutRow === 'bottom-scroll' ? '#1677ff' : mobileTheme.colors.lightText,
                    )}
                  >
                    下栏
                  </button>
                </div>
                <textarea
                  value={draftShortcutSequence}
                  readOnly
                  placeholder="点击下方特殊键按钮生成序列"
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

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {SHORTCUT_PRESETS.map((preset) => (
                    <button
                      key={`${preset.label}-${preset.row || 'any'}`}
                      onClick={() => applyShortcutPreset(preset)}
                      style={floatingPillButton('rgba(22, 119, 255, 0.08)', '#1677ff')}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => (
                    <button
                      key={`ctrl-${letter}`}
                      onClick={() => appendShortcutToken({ label: `Ctrl+${letter}`, sequence: encodeCtrlKey(letter) })}
                      style={floatingPillButton('#eef2f8', mobileTheme.colors.lightText)}
                    >
                      Ctrl+{letter}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={closeShortcutEditor}
                    style={{
                      flex: 1,
                      minHeight: '44px',
                      border: 'none',
                      borderRadius: '14px',
                      backgroundColor: '#eef2f8',
                      color: mobileTheme.colors.lightText,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    取消
                  </button>
                  <button
                    onClick={saveShortcutForm}
                    style={{
                      flex: 1,
                      minHeight: '44px',
                      border: 'none',
                      borderRadius: '14px',
                      backgroundColor: '#1677ff',
                      color: '#fff',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    {editingShortcutIndex >= 0 ? '应用修改' : '添加快捷按键'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {floatingMenuOpen && !editorOpen && (
        <>
          <div
            onClick={() => setFloatingMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 129,
              backgroundColor: 'rgba(5, 8, 14, 0.18)',
            }}
          />
          <div
            style={{
              position: 'fixed',
              right: '12px',
              bottom: `calc(${floatingPanelBottomPx}px + env(safe-area-inset-bottom, 0px))`,
              zIndex: 130,
              width: 'min(320px, calc(100vw - 24px))',
              maxHeight: `min(560px, calc(100dvh - ${Math.max(180, keyboardInsetPx + 72)}px))`,
              borderRadius: '22px',
              backgroundColor: 'rgba(23, 27, 45, 0.96)',
              color: '#fff',
              boxShadow: '0 20px 50px rgba(0,0,0,0.32)',
              display: 'flex',
              flexDirection: 'column',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '16px', fontWeight: 800 }}>预输入</div>
                </div>
                <button
                  onClick={() => openEditor('create')}
                  style={floatingPillButton('rgba(31,214,122,0.18)', mobileTheme.colors.accent)}
                >
                  + 添加
                </button>
                <button
                  onClick={() => openEditor('list')}
                  style={floatingPillButton('rgba(255,255,255,0.1)', '#fff')}
                >
                  管理
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
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
                    flex: 1,
                    minHeight: '108px',
                    maxHeight: '180px',
                    resize: 'vertical',
                    padding: '10px 12px',
                    borderRadius: '14px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    color: '#fff',
                    fontSize: '14px',
                    whiteSpace: 'pre-wrap',
                  }}
                />
                <div style={{ width: '92px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <button
                    onClick={() => {
                      const trimmed = sessionDraft.trim();
                      if (!trimmed) {
                        return;
                      }
                      const nextAction: QuickAction = {
                        id: createDraftActionId(),
                        label: trimmed.slice(0, 12) || '新片段',
                        sequence: sessionDraft,
                        order: sortedQuickActions.length,
                      };
                      onQuickActionsChange?.([...sortedQuickActions, nextAction]);
                    }}
                    style={{
                      flex: 1,
                      minHeight: '50px',
                      border: 'none',
                      borderRadius: '12px',
                      backgroundColor: 'rgba(255,255,255,0.12)',
                      color: '#fff',
                      fontWeight: 700,
                    }}
                  >
                    加为快捷输入
                  </button>
                  <button
                    onClick={() => {
                      sendSessionDraft();
                    }}
                    style={{
                      flex: 1,
                      minHeight: '50px',
                      border: 'none',
                      borderRadius: '12px',
                      backgroundColor: 'rgba(31,214,122,0.18)',
                      color: mobileTheme.colors.accent,
                      fontWeight: 800,
                    }}
                  >
                    发送
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setFloatingPanelTab('quick-actions')}
                  style={floatingPillButton(
                    floatingPanelTab === 'quick-actions' ? 'rgba(31,214,122,0.18)' : 'rgba(255,255,255,0.08)',
                    floatingPanelTab === 'quick-actions' ? mobileTheme.colors.accent : '#fff',
                  )}
                >
                  快捷列表
                </button>
                <button
                  onClick={() => setFloatingPanelTab('clipboard')}
                  style={floatingPillButton(
                    floatingPanelTab === 'clipboard' ? 'rgba(31,214,122,0.18)' : 'rgba(255,255,255,0.08)',
                    floatingPanelTab === 'clipboard' ? mobileTheme.colors.accent : '#fff',
                  )}
                >
                  剪贴板
                </button>
              </div>
            </div>

            <div
              style={{
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
                            appendToDraft(action.sequence);
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

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: `${QUICK_BAR_ROW_GAP}px`,
          padding: `0 ${QUICK_BAR_SIDE_PADDING}px`,
          marginBottom: `${QUICK_BAR_ROW_GAP}px`,
        }}
      >
        {!editorOpen && (
          <button
            type="button"
            onPointerDown={(event) => {
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
              clearFloatingBubblePressTimer();
              floatingBubblePressTimerRef.current = window.setTimeout(() => {
                floatingBubbleDragRef.current.active = true;
                suppressBubbleClickRef.current = true;
              }, FLOATING_BUBBLE_LONG_PRESS_MS);
            }}
            onPointerMove={(event) => {
              const drag = floatingBubbleDragRef.current;
              if (drag.pointerId !== event.pointerId || !drag.active) {
                return;
              }
              event.preventDefault();
              setFloatingBubblePosition(
                clampFloatingBubblePosition(
                  drag.originX + (event.clientX - drag.startX),
                  drag.originY + (event.clientY - drag.startY),
                  drag.width,
                  drag.height,
                ),
              );
            }}
            onPointerUp={(event) => {
              clearFloatingBubblePressTimer();
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
              clearFloatingBubblePressTimer();
              floatingBubbleDragRef.current.active = false;
              floatingBubbleDragRef.current.pointerId = -1;
              try {
                event.currentTarget.releasePointerCapture(event.pointerId);
              } catch {}
            }}
            onClick={() => {
              if (suppressBubbleClickRef.current) {
                return;
              }
              setFloatingMenuOpen((current) => !current);
            }}
            onTouchStart={(event) => {
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
              clearFloatingBubbleTouchTimer();
              floatingBubbleTouchTimerRef.current = window.setTimeout(() => {
                floatingBubbleTouchDragRef.current.active = true;
                suppressBubbleClickRef.current = true;
              }, FLOATING_BUBBLE_LONG_PRESS_MS);
            }}
            onTouchMove={(event) => {
              const touch = event.touches[0];
              const drag = floatingBubbleTouchDragRef.current;
              if (!touch || !drag.active) {
                return;
              }
              event.preventDefault();
              drag.moved = true;
              setFloatingBubblePosition(
                clampFloatingBubblePosition(
                  drag.originX + (touch.clientX - drag.startX),
                  drag.originY + (touch.clientY - drag.startY),
                  drag.width,
                  drag.height,
                ),
              );
            }}
            onTouchEnd={() => {
              clearFloatingBubbleTouchTimer();
              if (floatingBubbleTouchDragRef.current.active) {
                suppressBubbleClickRef.current = true;
                window.setTimeout(() => {
                  suppressBubbleClickRef.current = false;
                }, 180);
              }
              floatingBubbleTouchDragRef.current.active = false;
            }}
            onTouchCancel={() => {
              clearFloatingBubbleTouchTimer();
              floatingBubbleTouchDragRef.current.active = false;
            }}
            style={{
              position: 'fixed',
              right: floatingBubblePosition.x === null ? `${FLOATING_BUBBLE_MARGIN}px` : 'auto',
              bottom: floatingBubblePosition.y === null ? `calc(${floatingBubbleBottomPx}px + env(safe-area-inset-bottom, 0px))` : 'auto',
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
        <div style={fixedClusterStyle}>
          {topFixedActions.map((action) => renderBaseActionButton(action, { fixed: true }))}
        </div>
        <div style={scrollTrackShellStyle}>
          <div data-quickbar-scroll-track="true" style={scrollTrackStyle}>
            {topScrollActions.map((action) => renderBaseActionButton(action))}
          </div>
        </div>
      </div>

      <div
        style={{
          minHeight: '40px',
          display: 'flex',
          alignItems: 'center',
          gap: `${QUICK_BAR_ROW_GAP}px`,
          padding: `2px ${QUICK_BAR_SIDE_PADDING}px 4px`,
          backgroundColor: 'rgba(255,255,255,0.02)',
        }}
      >
        <div style={fixedClusterStyle}>
          {bottomFixedActions.map((action) => renderBaseActionButton(action, { fixed: true, compact: true }))}
        </div>
        <div style={scrollTrackShellStyle}>
          <div data-quickbar-scroll-track="true" style={scrollTrackStyle}>
            {bottomScrollActions.map((action) => renderBaseActionButton(action, { compact: true }))}
            {renderBaseActionButton(shortcutEditorEntry, { compact: true })}
          </div>
        </div>
      </div>
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
