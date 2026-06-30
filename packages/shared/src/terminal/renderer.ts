// Shared terminal renderer helpers — pure functions, no React/page/context/plugin deps
// Extracted from TerminalView.tsx to keep renderer truth in a single shared module.

import type { TerminalCell } from '../connection/types';
import type { TerminalThemePreset } from './theme';
import {
  buildBlockBackground,
  isBlockShadeCodePoint,
  isSolidBlockBackground,
  normalizeTerminalCell,
  resolveDimmedTerminalForeground,
  resolveTerminalCellColors,
} from './cell-render';

// ─── Constants ──────────────────────────────────────────────

export const DEFAULT_ROWS = 24;

export const FLAG_BOLD = 0x01;
export const FLAG_DIM = 0x02;
export const FLAG_ITALIC = 0x04;
export const FLAG_UNDERLINE = 0x08;
export const FLAG_INVISIBLE = 0x40;
export const FLAG_STRIKETHROUGH = 0x80;

export const NORMAL_CURSOR_KEYS = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
} as const;

export const APP_CURSOR_KEYS = {
  ArrowUp: '\x1bOA',
  ArrowDown: '\x1bOB',
  ArrowRight: '\x1bOC',
  ArrowLeft: '\x1bOD',
} as const;

export const TERMINAL_FONT_STACK = [
  '"Sarasa Mono SC"',
  '"Sarasa Term SC"',
  '"Noto Sans Mono CJK SC"',
  '"SF Mono"',
  '"Monaco"',
  '"Roboto Mono"',
  '"Menlo"',
  '"Consolas"',
  'ui-monospace',
  'monospace',
].join(', ');

export const OVERSCAN_ROWS = 4;
export const TAB_SWIPE_LOCK_THRESHOLD_PX = 18;
export const TAB_SWIPE_TRIGGER_THRESHOLD_PX = 72;

// ─── Cell style ─────────────────────────────────────────────

export function terminalCellStyle(
  inputCell: TerminalCell,
  rowHeight: string,
  cellWidthPx: number,
  theme: TerminalThemePreset,
  cursorActive = false,
) {
  const cell = normalizeTerminalCell(inputCell);
  const colors = resolveTerminalCellColors(cell, theme, { cursorActive });
  const renderedForeground = (cell.flags & FLAG_DIM)
    ? resolveDimmedTerminalForeground(colors.fg, colors.bg, theme.background)
    : colors.fg;
  const safeCellWidthPx = Math.max(1, Number.isFinite(cellWidthPx) ? cellWidthPx : 1);
  const style: Record<string, string> = {
    display: 'inline-block',
    height: rowHeight,
    lineHeight: rowHeight,
    verticalAlign: 'top',
    overflow: 'hidden',
    whiteSpace: 'pre',
    width: cell.width === 2 ? `${safeCellWidthPx * 2}px` : cell.width === 0 ? '0px' : `${safeCellWidthPx}px`,
    letterSpacing: '0',
    fontKerning: 'none',
    fontVariantLigatures: 'none',
    fontFeatureSettings: '"liga" 0, "calt" 0',
    textRendering: 'optimizeSpeed',
    boxSizing: 'border-box',
  };

  if (cell.width === 0) {
    return style;
  }

  if (isBlockShadeCodePoint(cell.char)) {
    const blockBackground = buildBlockBackground(cell.char, colors.fg, colors.bg, theme.background);
    style.background = blockBackground;
    style.backgroundColor = isSolidBlockBackground(blockBackground) ? blockBackground : colors.bg;
    style.color = 'transparent';
  } else {
    style.color = renderedForeground;
    style.background = colors.bg;
    style.backgroundColor = colors.bg;
  }
  if (cell.flags & FLAG_BOLD) style.fontWeight = '700';
  if (cell.flags & FLAG_ITALIC) style.fontStyle = 'italic';
  if (cell.flags & FLAG_INVISIBLE) style.visibility = 'hidden';

  const decorations: string[] = [];
  if (cell.flags & FLAG_UNDERLINE) decorations.push('underline');
  if (cell.flags & FLAG_STRIKETHROUGH) decorations.push('line-through');
  if (decorations.length > 0) {
    style.textDecoration = decorations.join(' ');
  }

  return style;
}

// ─── Viewport measurement ───────────────────────────────────

export function measureTerminalViewport(
  host: HTMLDivElement,
  fontSize: number,
  rowHeight: string,
) {
  if (typeof document === 'undefined') {
    return {
      cols: 80,
      rows: DEFAULT_ROWS,
      resolvedRowHeight: rowHeight,
      resolvedCellWidthPx: Math.max(1, fontSize * 0.62),
    };
  }

  const measureProbeRect = (text: string) => {
    const probe = document.createElement('span');
    probe.textContent = text;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = TERMINAL_FONT_STACK;
    probe.style.fontSize = `${fontSize}px`;
    probe.style.lineHeight = rowHeight;
    host.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return rect;
  };

  const latinRect = measureProbeRect('W');
  const cjkRect = measureProbeRect('你');
  const hostWidthPx = Math.max(1, Math.floor(host.clientWidth || 0));
  const fallbackCellWidthPx = Math.max(1, fontSize * 0.62);
  const resolveMeasuredGlyphWidth = (widthPx: number, fallbackPx: number) => {
    if (!Number.isFinite(widthPx) || widthPx <= 0) {
      return fallbackPx;
    }
    // Some WebView/jsdom/layout states can report the whole terminal width for
    // the hidden glyph probe. A terminal cell can never be the full viewport.
    if (widthPx >= hostWidthPx * 0.25) {
      return fallbackPx;
    }
    return widthPx;
  };

  const latinWidthPx = resolveMeasuredGlyphWidth(latinRect.width, fallbackCellWidthPx);
  const cjkHalfWidthPx = Math.max(
    1,
    resolveMeasuredGlyphWidth(cjkRect.width, latinWidthPx * 2) / 2,
  );
  const cellWidthPx = Math.max(latinWidthPx, cjkHalfWidthPx);
  const measuredRowHeight = Math.max(1, Math.ceil(latinRect.height || parseInt(rowHeight, 10) || 17));

  return {
    cols: Math.max(1, Math.floor(host.clientWidth / cellWidthPx)),
    rows: Math.max(1, Math.floor(host.clientHeight / measuredRowHeight)),
    resolvedRowHeight: `${measuredRowHeight}px`,
    resolvedCellWidthPx: cellWidthPx,
  };
}

// ─── Gap detection ──────────────────────────────────────────

// ─── Scroll helpers ─────────────────────────────────────────

export function resolveDomBottomScrollTop(host: HTMLDivElement, targetScrollTop: number) {
  const safeTargetScrollTop = Math.max(0, targetScrollTop);
  const domBottomScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
  return Math.min(domBottomScrollTop, safeTargetScrollTop);
}

export function isScrollAtBottom(host: HTMLDivElement | null, scrollTop: number, localBottomScrollTop: number) {
  const safeScrollTop = Math.max(0, scrollTop);
  const safeLocalBottomScrollTop = Math.max(0, localBottomScrollTop);
  if (!host) return safeScrollTop >= safeLocalBottomScrollTop - 1;
  const domScrollHeight = host.scrollHeight;
  const domClientHeight = host.clientHeight;
  const domScrollable = Number.isFinite(domScrollHeight)
    && Number.isFinite(domClientHeight)
    && domScrollHeight > domClientHeight + 1;
  if (!domScrollable) return safeScrollTop >= safeLocalBottomScrollTop - 1;
  const domBottomDistance = Math.max(0, (domScrollHeight - domClientHeight) - safeScrollTop);
  return domBottomDistance <= 1 || safeScrollTop >= safeLocalBottomScrollTop - 1;
}

export function resolveFollowScrollSyncTarget(
  host: HTMLDivElement,
  nextRenderBottomIndex: number,
  resolveScrollTopForRenderBottomIndex: (nextRenderBottomIndex: number) => number,
) {
  return resolveDomBottomScrollTop(
    host,
    Math.max(0, resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex)),
  );
}

export function commitProgrammaticTerminalScroll(
  host: HTMLDivElement,
  nextTarget: number,
  options: {
    ignoredProgrammaticScrollTopRef: { current: number | null };
    suppressProgrammaticScrollRef: { current: boolean };
    lastSettledScrollTopRef: { current: number };
    hasSettledFollowFrameRef: { current: boolean };
  },
) {
  options.ignoredProgrammaticScrollTopRef.current = nextTarget;
  options.suppressProgrammaticScrollRef.current = true;
  if (Math.abs(host.scrollTop - nextTarget) > 1) {
    host.scrollTop = nextTarget;
  }
  options.suppressProgrammaticScrollRef.current = false;
  options.lastSettledScrollTopRef.current = nextTarget;
  options.hasSettledFollowFrameRef.current = true;
}

export function shouldQueueFollowRealignFromObservedScroll(
  host: HTMLDivElement,
  options: {
    lastSettledScrollTopRef: { current: number };
    maxScrollTop: number;
  },
) {
  const observedScrollTop = Math.max(0, host.scrollTop);
  const upwardAwayFromSettledBottom = observedScrollTop < options.lastSettledScrollTopRef.current - 1;
  const stillAtBottom = isScrollAtBottom(host, observedScrollTop, options.maxScrollTop);
  return !upwardAwayFromSettledBottom && !stillAtBottom;
}

export function markUserScrollIntent(userScrollIntentDeadlineRef: { current: number }, durationMs = 250) {
  userScrollIntentDeadlineRef.current = Date.now() + Math.max(16, durationMs);
}

export function hasRecentUserScrollIntent(userScrollIntentDeadlineRef: { current: number }) {
  return userScrollIntentDeadlineRef.current > Date.now();
}

// ─── Guard helpers ──────────────────────────────────────────

export function handleRecentViewportLayoutScrollGuard(options: {
  recentViewportLayoutChangeRef: { current: boolean };
  clearRecentViewportLayoutChange: () => void;
  queueFollowVisualRealign: (options?: { guardPendingFollowDrift?: boolean; renderBottomIndex?: number }) => void;
}) {
  if (!options.recentViewportLayoutChangeRef.current) return false;
  options.clearRecentViewportLayoutChange();
  options.queueFollowVisualRealign({ guardPendingFollowDrift: true });
  return true;
}

export function handlePendingFollowScrollGuard(
  host: HTMLDivElement,
  options: {
    pendingFollowScrollSyncRef: { current: boolean };
    pendingFollowRenderBottomIndexRef: { current: number | null };
    pendingFollowViewportRealignRef: { current: boolean };
    lastSettledScrollTopRef: { current: number };
    queueFollowVisualRealign: (options?: { guardPendingFollowDrift?: boolean; renderBottomIndex?: number }) => void;
    cancelPendingFollowScrollSync: () => void;
  },
) {
  if (options.pendingFollowScrollSyncRef.current && options.pendingFollowRenderBottomIndexRef.current !== null) {
    options.queueFollowVisualRealign({
      renderBottomIndex: options.pendingFollowRenderBottomIndexRef.current,
      guardPendingFollowDrift: true,
    });
    return true;
  }
  if (options.pendingFollowViewportRealignRef.current) {
    options.queueFollowVisualRealign({ guardPendingFollowDrift: true });
    return true;
  }
  if (!options.pendingFollowScrollSyncRef.current) return false;
  const scrollTopUnchanged = Math.abs(host.scrollTop - options.lastSettledScrollTopRef.current) <= 1;
  if (scrollTopUnchanged) return true;
  options.cancelPendingFollowScrollSync();
  return false;
}

export function handleIgnoredProgrammaticScrollGuard(
  host: HTMLDivElement,
  options: {
    ignoredProgrammaticScrollTopRef: { current: number | null };
    lastSettledScrollTopRef: { current: number };
  },
) {
  const ignoredTarget = options.ignoredProgrammaticScrollTopRef.current;
  if (ignoredTarget === null) return false;
  options.ignoredProgrammaticScrollTopRef.current = null;
  if (Math.abs(host.scrollTop - ignoredTarget) <= 1) {
    options.lastSettledScrollTopRef.current = host.scrollTop;
    return true;
  }
  return false;
}

// ─── Signal helpers ─────────────────────────────────────────

export function consumeFollowResetSignal(options: {
  refreshActive: boolean;
  wasActiveRef: { current: boolean };
  previousInputResetEpochRef: { current: number };
  previousFollowResetEpochRef: { current: number };
  inputResetEpoch: number;
  followResetEpoch: number;
}) {
  const becameActive = options.refreshActive && !options.wasActiveRef.current;
  options.wasActiveRef.current = options.refreshActive;
  const inputResetChanged = options.previousInputResetEpochRef.current !== options.inputResetEpoch;
  const followResetChanged = options.previousFollowResetEpochRef.current !== options.followResetEpoch;
  options.previousInputResetEpochRef.current = options.inputResetEpoch;
  options.previousFollowResetEpochRef.current = options.followResetEpoch;
  if (!options.refreshActive) return false;
  return becameActive || inputResetChanged || followResetChanged;
}

export function consumeViewportRefreshSignal(options: {
  refreshActive: boolean;
  previousRefreshActiveRef: { current: boolean };
  previousRefreshSessionIdRef: { current: string | null };
  sessionId: string | null;
}) {
  const becameActive = options.refreshActive && !options.previousRefreshActiveRef.current;
  const sessionChanged = options.previousRefreshSessionIdRef.current !== options.sessionId;
  options.previousRefreshActiveRef.current = options.refreshActive;
  options.previousRefreshSessionIdRef.current = options.sessionId;
  if (!options.refreshActive) return false;
  return becameActive || sessionChanged;
}

export function applySessionSwitchRenderReset(options: {
  sessionId: string | null;
  previousSessionIdRef: { current: string | null };
  followVisualBottomIndex: number;
  setReadingMode: (next: boolean) => void;
  setRenderBottomIndex: (next: number) => void;
  pendingImmediateFollowScrollSyncRef: { current: boolean };
  lastReportedViewportRef: { current: string };
  previousRefreshSessionIdRef: { current: string | null };
  previousInputResetEpochRef: { current: number };
  previousFollowResetEpochRef: { current: number };
  inputResetEpoch: number;
  followResetEpoch: number;
}) {
  if (options.previousSessionIdRef.current === options.sessionId) return false;
  options.previousSessionIdRef.current = options.sessionId;
  options.setReadingMode(false);
  options.setRenderBottomIndex(options.followVisualBottomIndex);
  options.pendingImmediateFollowScrollSyncRef.current = true;
  options.lastReportedViewportRef.current = '';
  options.previousRefreshSessionIdRef.current = options.sessionId;
  options.previousInputResetEpochRef.current = options.inputResetEpoch;
  options.previousFollowResetEpochRef.current = options.followResetEpoch;
  return true;
}

// ─── Keyboard input ─────────────────────────────────────────

export function resolveTerminalCtrlChord(event: KeyboardEvent) {
  if (event.altKey || event.metaKey) return null;
  if (!event.ctrlKey || event.key.length !== 1) return null;
  if (event.key === ' ') return '\x00';
  const code = event.key.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}

function resolveModifiedPrintableKeyboardInput(event: KeyboardEvent) {
  if (event.ctrlKey && event.altKey && event.key.length === 1) {
    return `\x1b${event.key}`;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
    return `\x1b${event.key}`;
  }
  return null;
}

export function resolveTerminalKeyboardInput(
  event: KeyboardEvent,
  cursorKeysApp: boolean,
) {
  const modifiedPrintable = resolveModifiedPrintableKeyboardInput(event);
  if (modifiedPrintable) {
    return modifiedPrintable;
  }
  const arrows = cursorKeysApp ? APP_CURSOR_KEYS : NORMAL_CURSOR_KEYS;
  if (event.key in arrows) {
    return arrows[event.key as keyof typeof arrows];
  }
  switch (event.key) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Tab': return '\t';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
    case 'Delete': return '\x1b[3~';
    case 'Insert': return '\x1b[2~';
    case 'Escape': return '\x1b';
    default: return null;
  }
}

export function createTerminalDomInputController({
  input,
  sessionIdRef,
  onInputRef,
  focusTerminalRef,
  cursorKeysAppRef,
  normalizeCommittedText,
}: {
  input: HTMLTextAreaElement;
  sessionIdRef: { current: string | null };
  onInputRef: { current: ((sessionId: string, data: string) => void) | undefined };
  focusTerminalRef: { current: () => void };
  cursorKeysAppRef: { current: boolean };
  normalizeCommittedText: (text: string) => string;
}) {
  let composing = false;
  // FIX: track sessionId at composition start
  let compositionStartSessionId: string | null = null;
  let flushTimer: number | null = null;
  let flushRetryTimer: number | null = null;

  const sendTerminalInput = (value: string) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;
    onInputRef.current?.(currentSessionId, value);
  };

  const clearScheduledFlush = () => {
    if (flushTimer !== null) { window.clearTimeout(flushTimer); flushTimer = null; }
    if (flushRetryTimer !== null) { window.clearTimeout(flushRetryTimer); flushRetryTimer = null; }
  };

  const resetDomInput = () => { input.value = ''; };
  const focusTerminal = () => { focusTerminalRef.current(); };

  const flushDomInputValue = () => {
    if (!input.value) return;
    const targetSessionId = compositionStartSessionId ?? sessionIdRef.current;
    if (!targetSessionId) return;
    if (composing) return; // still composing — compositionend will flush
    const normalized = normalizeCommittedText(input.value).replace(/\n/g, '\r');
    onInputRef.current?.(targetSessionId, normalized);
    resetDomInput();
    focusTerminal();
  };

  const scheduleFlushDomInputValue = () => {
    clearScheduledFlush();
    flushTimer = window.setTimeout(() => { flushTimer = null; flushDomInputValue(); }, 0);
    // FIX: removed 32ms retry timer — compositionend now flushes directly
  };

  const sendImmediateTerminalInput = (value: string) => {
    sendTerminalInput(value);
    resetDomInput();
    clearScheduledFlush();
  };

  // FIX: record sessionId at composition start
  const handleCompositionStart = () => {
    composing = true;
    compositionStartSessionId = sessionIdRef.current;
    resetDomInput();
  };

  // FIX: route to compositionStartSessionId; flush synchronously instead of schedule
  const handleCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    const targetSessionId = compositionStartSessionId ?? sessionIdRef.current;
    compositionStartSessionId = null;
    if (!targetSessionId) return;
    if (event.data && !input.value) { input.value = event.data; }
    if (!input.value) return;
    const normalized = normalizeCommittedText(input.value).replace(/\n/g, '\r');
    onInputRef.current?.(targetSessionId, normalized);
    resetDomInput();
    focusTerminal();
  };

  const handleBeforeInput = (event: InputEvent) => {
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      event.preventDefault();
      sendImmediateTerminalInput('\r');
      return;
    }
    if (
      event.inputType === 'insertReplacementText'
      || event.inputType === 'insertFromComposition'
      || event.inputType === 'insertCompositionText'
    ) {
      scheduleFlushDomInputValue();
    }
  };

  const handleInput = () => {
    if (!composing) flushDomInputValue();
  };
  // FIX: flush synchronously
  const handleChange = () => { flushDomInputValue(); };



  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey) return;
    const ctrlChord = resolveTerminalCtrlChord(event);
    if (ctrlChord) { event.preventDefault(); sendTerminalInput(ctrlChord); return; }
    const keyboardInput = resolveTerminalKeyboardInput(event, cursorKeysAppRef.current);
    if (!keyboardInput) return;
    event.preventDefault();
    sendImmediateTerminalInput(keyboardInput);
  };

  return {
    clearScheduledFlush,
    handleCompositionStart,
    handleCompositionEnd,
    handleBeforeInput,
    handleInput,
    handleChange,
    handleKeyDown,
  };
}
