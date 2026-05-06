import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSessionRenderBufferSnapshot, type SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import { DEFAULT_TERMINAL_COLOR, getTerminalThemePreset, packedTruecolorToCss, type TerminalThemePreset } from '@zterm/shared';
import type {
  SessionRenderBufferSnapshot,
  TerminalCell,
  TerminalGapRange,
  TerminalResizeHandler,
  TerminalViewportChangeHandler,
  TerminalWidthModeHandler,
  TerminalWidthMode,
} from '../lib/types';

interface TerminalViewProps {
  sessionId: string | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  renderBufferSnapshot?: SessionRenderBufferSnapshot | null;
  active?: boolean;
  live?: boolean;
  inputResetEpoch?: number;
  followResetEpoch?: number;
  allowDomFocus?: boolean;
  domInputOffscreen?: boolean;
  onInput?: (sessionId: string, data: string) => void;
  onActivateInput?: (sessionId: string) => void;
  onResize?: TerminalResizeHandler;
  onWidthModeChange?: TerminalWidthModeHandler;
  onViewportChange?: TerminalViewportChangeHandler;
  onSwipeTab?: (sessionId: string, direction: 'previous' | 'next') => void;
  focusNonce?: number;
  fontSize?: number;
  rowHeight?: string;
  themeId?: string;
  widthMode?: TerminalWidthMode;
  showAbsoluteLineNumbers?: boolean;
}

const DEFAULT_ROWS = 24;
const DEFAULT_COLOR = DEFAULT_TERMINAL_COLOR;
const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;
const NORMAL_CURSOR_KEYS = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
} as const;
const APP_CURSOR_KEYS = {
  ArrowUp: '\x1bOA',
  ArrowDown: '\x1bOB',
  ArrowRight: '\x1bOC',
  ArrowLeft: '\x1bOD',
} as const;
const TERMINAL_FONT_STACK = [
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
const XTERM_6X6_STEPS = [0, 95, 135, 175, 215, 255] as const;
const OVERSCAN_ROWS = 4;
const TAB_SWIPE_LOCK_THRESHOLD_PX = 18;
const TAB_SWIPE_TRIGGER_THRESHOLD_PX = 72;
const BLOCK_SHADE_CODEPOINT_MIN = 0x2580;
const BLOCK_SHADE_CODEPOINT_MAX = 0x259f;

const EMPTY_RENDER_BUFFER: SessionRenderBufferSnapshot = {
  lines: [],
  gapRanges: [],
  startIndex: 0,
  endIndex: 0,
  bufferHeadStartIndex: 0,
  bufferTailEndIndex: 0,
  daemonHeadRevision: 0,
  daemonHeadEndIndex: 0,
  cols: 80,
  rows: DEFAULT_ROWS,
  cursorKeysApp: false,
  cursor: null,
  revision: 0,
};

function normalizeCell(cell: TerminalCell | null | undefined): TerminalCell {
  return {
    char: typeof cell?.char === 'number' && Number.isFinite(cell.char) ? cell.char : 32,
    fg: typeof cell?.fg === 'number' && Number.isFinite(cell.fg) ? cell.fg : DEFAULT_COLOR,
    bg: typeof cell?.bg === 'number' && Number.isFinite(cell.bg) ? cell.bg : DEFAULT_COLOR,
    flags: typeof cell?.flags === 'number' && Number.isFinite(cell.flags) ? cell.flags : 0,
    width: cell?.width === 0 || cell?.width === 2 ? cell.width : 1,
  };
}

function safeCodePointToString(code: number) {
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) {
    return ' ';
  }

  try {
    return String.fromCodePoint(code);
  } catch (error) {
    console.warn('[TerminalView] Failed to render code point:', { code, error });
    return ' ';
  }
}

function colorToCSS(index: number, theme: TerminalThemePreset): string | null {
  if (index === DEFAULT_COLOR) {
    return null;
  }
  const packedTruecolor = packedTruecolorToCss(index);
  if (packedTruecolor) {
    return packedTruecolor;
  }
  if (index < 16) {
    return theme.colors[index] || theme.foreground;
  }
  if (index < 232) {
    const n = index - 16;
    const r = XTERM_6X6_STEPS[Math.floor(n / 36)] ?? 0;
    const g = XTERM_6X6_STEPS[Math.floor(n / 6) % 6] ?? 0;
    const b = XTERM_6X6_STEPS[n % 6] ?? 0;
    return `rgb(${r},${g},${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

function parseCssColorToRgb(color: string, fallback: string): [number, number, number] {
  const candidate = (color || '').trim() || fallback.trim();
  if (candidate.startsWith('#')) {
    const normalized = candidate.slice(1);
    const hex = normalized.length === 3
      ? normalized.split('').map((part) => `${part}${part}`).join('')
      : normalized;
    if (hex.length === 6) {
      return [
        Number.parseInt(hex.slice(0, 2), 16) || 0,
        Number.parseInt(hex.slice(2, 4), 16) || 0,
        Number.parseInt(hex.slice(4, 6), 16) || 0,
      ];
    }
  }

  const rgbMatch = candidate.match(/^rgb\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)$/i);
  if (rgbMatch) {
    return [
      Number.parseInt(rgbMatch[1] || '0', 10) || 0,
      Number.parseInt(rgbMatch[2] || '0', 10) || 0,
      Number.parseInt(rgbMatch[3] || '0', 10) || 0,
    ];
  }

  if (candidate === 'transparent') {
    return parseCssColorToRgb(fallback, fallback);
  }

  return parseCssColorToRgb(fallback, fallback);
}

function mixCssColors(fg: string, bg: string, fgRatio: number, fallbackBg: string) {
  const [fr, fgGreen, fb] = parseCssColorToRgb(fg, fallbackBg);
  const [br, bgGreen, bb] = parseCssColorToRgb(bg, fallbackBg);
  const mix = (front: number, back: number) => Math.round((front * fgRatio) + (back * (1 - fgRatio)));
  return `rgb(${mix(fr, br)},${mix(fgGreen, bgGreen)},${mix(fb, bb)})`;
}

function resolveColors(inputCell: TerminalCell, theme: TerminalThemePreset, cursorActive = false) {
  const cell = normalizeCell(inputCell);
  let fg = cell.fg;
  let bg = cell.bg;
  const reverse = Boolean(cell.flags & FLAG_REVERSE) || cursorActive;

  if (reverse) {
    [fg, bg] = [bg, fg];
  }

  return {
    fg: fg === DEFAULT_COLOR
      ? (reverse ? theme.background : theme.foreground)
      : colorToCSS(fg, theme) || theme.foreground,
    bg: bg === DEFAULT_COLOR
      ? (reverse ? theme.foreground : 'transparent')
      : colorToCSS(bg, theme) || 'transparent',
  };
}

function resolveDimmedForeground(fg: string, bg: string, themeBackground: string) {
  return mixCssColors(fg, bg, 0.5, themeBackground);
}

function isBlockShadeCodePoint(code: number) {
  return Number.isInteger(code) && code >= BLOCK_SHADE_CODEPOINT_MIN && code <= BLOCK_SHADE_CODEPOINT_MAX;
}

function buildBlockBackground(code: number, fg: string, bg: string, themeBackground: string) {
  switch (code) {
    case 0x2580:
      return `linear-gradient(${fg} 50%,${bg} 50%)`;
    case 0x2581:
      return `linear-gradient(${bg} 87.5%,${fg} 87.5%)`;
    case 0x2582:
      return `linear-gradient(${bg} 75%,${fg} 75%)`;
    case 0x2583:
      return `linear-gradient(${bg} 62.5%,${fg} 62.5%)`;
    case 0x2584:
      return `linear-gradient(${bg} 50%,${fg} 50%)`;
    case 0x2585:
      return `linear-gradient(${bg} 37.5%,${fg} 37.5%)`;
    case 0x2586:
      return `linear-gradient(${bg} 25%,${fg} 25%)`;
    case 0x2587:
      return `linear-gradient(${bg} 12.5%,${fg} 12.5%)`;
    case 0x2588:
      return fg;
    case 0x2589:
      return `linear-gradient(to right,${fg} 87.5%,${bg} 87.5%)`;
    case 0x258a:
      return `linear-gradient(to right,${fg} 75%,${bg} 75%)`;
    case 0x258b:
      return `linear-gradient(to right,${fg} 62.5%,${bg} 62.5%)`;
    case 0x258c:
      return `linear-gradient(to right,${fg} 50%,${bg} 50%)`;
    case 0x258d:
      return `linear-gradient(to right,${fg} 37.5%,${bg} 37.5%)`;
    case 0x258e:
      return `linear-gradient(to right,${fg} 25%,${bg} 25%)`;
    case 0x258f:
      return `linear-gradient(to right,${fg} 12.5%,${bg} 12.5%)`;
    case 0x2590:
      return `linear-gradient(to right,${bg} 50%,${fg} 50%)`;
    case 0x2591:
      return mixCssColors(fg, bg, 0.25, themeBackground);
    case 0x2592:
      return mixCssColors(fg, bg, 0.5, themeBackground);
    case 0x2593:
      return mixCssColors(fg, bg, 0.75, themeBackground);
    case 0x2594:
      return `linear-gradient(${fg} 12.5%,${bg} 12.5%)`;
    case 0x2595:
      return `linear-gradient(to right,${bg} 87.5%,${fg} 87.5%)`;
    default: {
      const quadrants: Record<number, [boolean, boolean, boolean, boolean]> = {
        0x2596: [false, false, true, false],
        0x2597: [false, false, false, true],
        0x2598: [true, false, false, false],
        0x2599: [true, false, true, true],
        0x259a: [true, false, false, true],
        0x259b: [true, true, true, false],
        0x259c: [true, true, false, true],
        0x259d: [false, true, false, false],
        0x259e: [false, true, true, false],
        0x259f: [false, true, true, true],
      };
      const quadrantFill = quadrants[code];
      if (!quadrantFill) {
        return fg;
      }
      const [topLeft, topRight, bottomLeft, bottomRight] = quadrantFill;
      if (topLeft && topRight && bottomLeft && bottomRight) {
        return fg;
      }
      const layers: string[] = [];
      const positions = ['0 0', '100% 0', '0 100%', '100% 100%'];
      quadrantFill.forEach((filled, index) => {
        if (!filled) {
          return;
        }
        layers.push(`linear-gradient(${fg},${fg}) ${positions[index]} / 50% 50% no-repeat`);
      });
      layers.push(bg);
      return layers.join(',');
    }
  }
}

function isSolidBlockBackground(background: string) {
  return !background.includes('gradient(');
}

function cellStyle(
  inputCell: TerminalCell,
  rowHeight: string,
  cellWidthPx: number,
  theme: TerminalThemePreset,
  cursorActive = false,
) {
  const cell = normalizeCell(inputCell);
  const colors = resolveColors(cell, theme, cursorActive);
  const renderedForeground = (cell.flags & FLAG_DIM)
    ? resolveDimmedForeground(colors.fg, colors.bg, theme.background)
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

function measureViewport(host: HTMLDivElement, fontSize: number, rowHeight: string) {
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

  const latinWidthPx = Math.max(1, latinRect.width || fontSize * 0.62);
  const cjkHalfWidthPx = Math.max(1, (cjkRect.width || latinWidthPx * 2) / 2);
  const cellWidthPx = Math.max(latinWidthPx, cjkHalfWidthPx);
  const measuredRowHeight = Math.max(1, Math.ceil(latinRect.height || parseInt(rowHeight, 10) || 17));

  return {
    cols: Math.max(1, Math.floor(host.clientWidth / cellWidthPx)),
    rows: Math.max(1, Math.floor(host.clientHeight / measuredRowHeight)),
    resolvedRowHeight: `${measuredRowHeight}px`,
    resolvedCellWidthPx: cellWidthPx,
  };
}

function isGapIndex(gapRanges: TerminalGapRange[], absoluteIndex: number) {
  return gapRanges.some((range) => absoluteIndex >= range.startIndex && absoluteIndex < range.endIndex);
}

function hasDiscontinuousNeighbor(
  rows: Array<{ absoluteIndex: number }>,
  rowIndex: number,
) {
  const current = rows[rowIndex];
  if (!current) {
    return false;
  }
  const previous = rows[rowIndex - 1];
  const next = rows[rowIndex + 1];
  const brokenBefore = Boolean(previous) && previous.absoluteIndex + 1 !== current.absoluteIndex;
  const brokenAfter = Boolean(next) && current.absoluteIndex + 1 !== next.absoluteIndex;
  return brokenBefore || brokenAfter;
}

function resolveCursorCellColumn(row: TerminalCell[], preferredCol: number) {
  if (row.length === 0) {
    return -1;
  }

  const clamped = Math.max(0, Math.min(row.length - 1, Math.floor(preferredCol)));
  if (row[clamped]?.width !== 0) {
    return clamped;
  }

  for (let col = clamped - 1; col >= 0; col -= 1) {
    if (row[col]?.width !== 0) {
      return col;
    }
  }

  return clamped;
}

function resolveDomBottomScrollTop(host: HTMLDivElement, targetScrollTop: number) {
  const safeTargetScrollTop = Math.max(0, targetScrollTop);
  const domBottomScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
  return Math.min(domBottomScrollTop, safeTargetScrollTop);
}

function isScrollAtBottom(host: HTMLDivElement | null, scrollTop: number, localBottomScrollTop: number) {
  const safeScrollTop = Math.max(0, scrollTop);
  const safeLocalBottomScrollTop = Math.max(0, localBottomScrollTop);
  if (!host) {
    return safeScrollTop >= safeLocalBottomScrollTop - 1;
  }
  const domScrollHeight = host.scrollHeight;
  const domClientHeight = host.clientHeight;
  const domScrollable = Number.isFinite(domScrollHeight)
    && Number.isFinite(domClientHeight)
    && domScrollHeight > domClientHeight + 1;
  if (!domScrollable) {
    return safeScrollTop >= safeLocalBottomScrollTop - 1;
  }
  const domBottomDistance = Math.max(0, (domScrollHeight - domClientHeight) - safeScrollTop);
  return domBottomDistance <= 1 || safeScrollTop >= safeLocalBottomScrollTop - 1;
}

function resolveTerminalCtrlChord(event: KeyboardEvent) {
  if (!event.ctrlKey || event.key.length !== 1) {
    return null;
  }
  const code = event.key.toUpperCase().charCodeAt(0);
  if (code < 64 || code > 95) {
    return null;
  }
  return String.fromCharCode(code - 64);
}

function resolveTerminalKeyboardInput(
  event: KeyboardEvent,
  cursorKeysApp: boolean,
) {
  const arrows = cursorKeysApp ? APP_CURSOR_KEYS : NORMAL_CURSOR_KEYS;
  if (event.key in arrows) {
    return arrows[event.key as keyof typeof arrows];
  }
  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    default:
      return null;
  }
}

function createTerminalDomInputController({
  input,
  sessionIdRef,
  onInputRef,
  focusTerminalRef,
  cursorKeysAppRef,
}: {
  input: HTMLTextAreaElement;
  sessionIdRef: { current: string | null };
  onInputRef: { current: ((sessionId: string, data: string) => void) | undefined };
  focusTerminalRef: { current: () => void };
  cursorKeysAppRef: { current: boolean };
}) {
  let composing = false;
  let flushTimer: number | null = null;
  let flushRetryTimer: number | null = null;

  const sendTerminalInput = (value: string) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }
    onInputRef.current?.(currentSessionId, value);
  };

  const clearScheduledFlush = () => {
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (flushRetryTimer !== null) {
      window.clearTimeout(flushRetryTimer);
      flushRetryTimer = null;
    }
  };

  const resetDomInput = () => {
    input.value = '';
  };

  const focusTerminal = () => {
    focusTerminalRef.current();
  };

  const flushDomInputValue = () => {
    if (composing || !input.value) {
      return;
    }
    sendTerminalInput(input.value.replace(/\n/g, '\r'));
    resetDomInput();
    focusTerminal();
  };

  const scheduleFlushDomInputValue = () => {
    clearScheduledFlush();
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flushDomInputValue();
    }, 0);
    flushRetryTimer = window.setTimeout(() => {
      flushRetryTimer = null;
      flushDomInputValue();
    }, 32);
  };

  const sendImmediateTerminalInput = (value: string) => {
    sendTerminalInput(value);
    resetDomInput();
    clearScheduledFlush();
  };

  const handleCompositionStart = () => {
    composing = true;
    resetDomInput();
  };

  const handleCompositionEnd = (event: CompositionEvent) => {
    composing = false;
    if (event.data && !input.value) {
      input.value = event.data;
    }
    scheduleFlushDomInputValue();
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
    if (!composing) {
      flushDomInputValue();
    }
  };

  const handleChange = () => {
    scheduleFlushDomInputValue();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey) {
      return;
    }

    const ctrlChord = resolveTerminalCtrlChord(event);
    if (ctrlChord) {
      event.preventDefault();
      sendTerminalInput(ctrlChord);
      return;
    }

    const keyboardInput = resolveTerminalKeyboardInput(event, cursorKeysAppRef.current);
    if (!keyboardInput) {
      return;
    }

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

function resolveFollowScrollSyncTarget(
  host: HTMLDivElement,
  nextRenderBottomIndex: number,
  resolveScrollTopForRenderBottomIndex: (nextRenderBottomIndex: number) => number,
) {
  return resolveDomBottomScrollTop(
    host,
    Math.max(0, resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex)),
  );
}

function commitProgrammaticTerminalScroll(host: HTMLDivElement, nextTarget: number, options: {
  ignoredProgrammaticScrollTopRef: { current: number | null };
  suppressProgrammaticScrollRef: { current: boolean };
  lastSettledScrollTopRef: { current: number };
  hasSettledFollowFrameRef: { current: boolean };
}) {
  options.ignoredProgrammaticScrollTopRef.current = nextTarget;
  options.suppressProgrammaticScrollRef.current = true;
  if (Math.abs(host.scrollTop - nextTarget) > 1) {
    host.scrollTop = nextTarget;
  }
  options.suppressProgrammaticScrollRef.current = false;
  options.lastSettledScrollTopRef.current = nextTarget;
  options.hasSettledFollowFrameRef.current = true;
}

function handleRecentViewportLayoutScrollGuard(options: {
  recentViewportLayoutChangeRef: { current: boolean };
  clearRecentViewportLayoutChange: () => void;
  queueFollowVisualRealign: (options?: { guardPendingFollowDrift?: boolean; renderBottomIndex?: number }) => void;
}) {
  if (!options.recentViewportLayoutChangeRef.current) {
    return false;
  }
  options.clearRecentViewportLayoutChange();
  options.queueFollowVisualRealign({
    guardPendingFollowDrift: true,
  });
  return true;
}

function handlePendingFollowScrollGuard(host: HTMLDivElement, options: {
  pendingFollowScrollSyncRef: { current: boolean };
  pendingFollowRenderBottomIndexRef: { current: number | null };
  pendingFollowViewportRealignRef: { current: boolean };
  lastSettledScrollTopRef: { current: number };
  queueFollowVisualRealign: (options?: { guardPendingFollowDrift?: boolean; renderBottomIndex?: number }) => void;
  cancelPendingFollowScrollSync: () => void;
}) {
  if (options.pendingFollowScrollSyncRef.current && options.pendingFollowRenderBottomIndexRef.current !== null) {
    options.queueFollowVisualRealign({
      renderBottomIndex: options.pendingFollowRenderBottomIndexRef.current,
      guardPendingFollowDrift: true,
    });
    return true;
  }

  if (options.pendingFollowViewportRealignRef.current) {
    options.queueFollowVisualRealign({
      guardPendingFollowDrift: true,
    });
    return true;
  }

  if (!options.pendingFollowScrollSyncRef.current) {
    return false;
  }

  const scrollTopUnchanged = Math.abs(host.scrollTop - options.lastSettledScrollTopRef.current) <= 1;
  if (scrollTopUnchanged) {
    return true;
  }

  options.cancelPendingFollowScrollSync();
  return false;
}

function handleIgnoredProgrammaticScrollGuard(host: HTMLDivElement, options: {
  ignoredProgrammaticScrollTopRef: { current: number | null };
  lastSettledScrollTopRef: { current: number };
}) {
  const ignoredTarget = options.ignoredProgrammaticScrollTopRef.current;
  if (ignoredTarget === null) {
    return false;
  }

  options.ignoredProgrammaticScrollTopRef.current = null;
  if (Math.abs(host.scrollTop - ignoredTarget) <= 1) {
    options.lastSettledScrollTopRef.current = host.scrollTop;
    return true;
  }

  return false;
}

function shouldQueueFollowRealignFromObservedScroll(host: HTMLDivElement, options: {
  lastSettledScrollTopRef: { current: number };
  maxScrollTop: number;
}) {
  const observedScrollTop = Math.max(0, host.scrollTop);
  const upwardAwayFromSettledBottom = observedScrollTop < options.lastSettledScrollTopRef.current - 1;
  const stillAtBottom = isScrollAtBottom(host, observedScrollTop, options.maxScrollTop);
  return !upwardAwayFromSettledBottom && !stillAtBottom;
}

function markUserScrollIntent(userScrollIntentDeadlineRef: { current: number }, durationMs = 250) {
  userScrollIntentDeadlineRef.current = Date.now() + Math.max(16, durationMs);
}

function hasRecentUserScrollIntent(userScrollIntentDeadlineRef: { current: number }) {
  return userScrollIntentDeadlineRef.current > Date.now();
}

function consumeFollowResetSignal(options: {
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

  if (!options.refreshActive) {
    return false;
  }

  return becameActive || inputResetChanged || followResetChanged;
}

function consumeViewportRefreshSignal(options: {
  refreshActive: boolean;
  previousRefreshActiveRef: { current: boolean };
  previousRefreshSessionIdRef: { current: string | null };
  sessionId: string | null;
}) {
  const becameActive = options.refreshActive && !options.previousRefreshActiveRef.current;
  const sessionChanged = options.previousRefreshSessionIdRef.current !== options.sessionId;
  options.previousRefreshActiveRef.current = options.refreshActive;
  options.previousRefreshSessionIdRef.current = options.sessionId;

  if (!options.refreshActive) {
    return false;
  }

  return becameActive || sessionChanged;
}

function applySessionSwitchRenderReset(options: {
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
  if (options.previousSessionIdRef.current === options.sessionId) {
    return false;
  }

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

const VisibleRow = memo(function VisibleRow({
  row,
  rowIndex: _rowIndex,
  absoluteIndex,
  rowHeight,
  cellWidthPx,
  isGap,
  theme,
  cursorColumn,
  showAbsoluteLineNumbers = false,
  discontinuousLineNumber = false,
}: {
  row: TerminalCell[];
  rowIndex: number;
  absoluteIndex: number;
  rowHeight: string;
  cellWidthPx: number;
  isGap: boolean;
  theme: TerminalThemePreset;
  cursorColumn: number;
  showAbsoluteLineNumbers?: boolean;
  discontinuousLineNumber?: boolean;
}) {
  const lineNumberCell = showAbsoluteLineNumbers ? (
    <span
      data-terminal-line-number="true"
      data-terminal-line-discontinuous={discontinuousLineNumber ? 'true' : undefined}
      style={{
        display: 'inline-flex',
        width: '48px',
        minWidth: '48px',
        justifyContent: 'flex-end',
        paddingRight: '8px',
        boxSizing: 'border-box',
        color: discontinuousLineNumber ? '#ef4444' : theme.colors[8],
        opacity: 0.92,
        fontWeight: discontinuousLineNumber ? 700 : 500,
      }}
    >
      {absoluteIndex}
    </span>
  ) : null;

  if (isGap) {
    return (
      <div
        data-terminal-row="true"
        data-terminal-gap="true"
        data-terminal-index={absoluteIndex}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: rowHeight,
          lineHeight: rowHeight,
          whiteSpace: 'pre',
          color: theme.foreground,
          opacity: 0.88,
          background: 'rgba(239, 68, 68, 0.12)',
          borderTop: `1px dashed rgba(239, 68, 68, 0.42)`,
          borderBottom: `1px dashed rgba(239, 68, 68, 0.42)`,
        }}
      >
        {lineNumberCell}
        <span
          data-terminal-gap-fill="true"
          style={{
            display: 'block',
            minWidth: 0,
            flex: 1,
            height: '100%',
            background: 'rgba(239, 68, 68, 0.08)',
          }}
        />
      </div>
    );
  }
  return (
    <div
      data-terminal-row="true"
      data-terminal-index={absoluteIndex}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: rowHeight,
        lineHeight: rowHeight,
        whiteSpace: 'pre',
      }}
    >
      {lineNumberCell}
      <span style={{ display: 'inline-block', minWidth: 0, flex: 1 }}>
        {row.length > 0
          ? row.map((cell, cellIndex) => (
              <span
                key={`cell-${absoluteIndex}-${cellIndex}`}
                data-terminal-cursor={cursorColumn === cellIndex ? 'true' : undefined}
                style={cellStyle(cell, rowHeight, cellWidthPx, theme, cursorColumn === cellIndex)}
              >
                {cell.width === 0 ? '' : safeCodePointToString(cell.char)}
              </span>
            ))
          : ' '}
      </span>
    </div>
  );
}, (prev, next) => (
  prev.row === next.row
  && prev.rowHeight === next.rowHeight
  && prev.cellWidthPx === next.cellWidthPx
  && prev.isGap === next.isGap
  && prev.absoluteIndex === next.absoluteIndex
  && prev.theme === next.theme
  && prev.cursorColumn === next.cursorColumn
  && prev.showAbsoluteLineNumbers === next.showAbsoluteLineNumbers
  && prev.discontinuousLineNumber === next.discontinuousLineNumber
));

function TerminalViewComponent({
  sessionId,
  sessionBufferStore = null,
  renderBufferSnapshot = null,
  active = false,
  live,
  inputResetEpoch = 0,
  followResetEpoch = 0,
  allowDomFocus = true,
  domInputOffscreen = false,
  onInput,
  onActivateInput,
  onResize,
  onWidthModeChange,
  onViewportChange,
  onSwipeTab,
  focusNonce = 0,
  fontSize = 14,
  rowHeight = '17px',
  themeId,
  widthMode = 'adaptive-phone',
  showAbsoluteLineNumbers = false,
}: TerminalViewProps) {
  const theme = getTerminalThemePreset(themeId);
  const refreshActive = live ?? active;
  const swipeTabEnabled = widthMode !== 'mirror-fixed' && Boolean(onSwipeTab);
  const sessionBufferSnapshot = useSessionRenderBufferSnapshot(sessionBufferStore, sessionBufferStore ? sessionId : null);
  const renderBuffer = renderBufferSnapshot
    || (sessionBufferStore && sessionId ? sessionBufferSnapshot.buffer : EMPTY_RENDER_BUFFER);
  const bufferLines = renderBuffer.lines || [];
  const effectiveBufferEndIndex = Math.max(renderBuffer.startIndex, Math.floor(renderBuffer.endIndex || (renderBuffer.startIndex + bufferLines.length)));
  const bufferTailAnchorEndIndex = Math.max(renderBuffer.startIndex, Math.floor(renderBuffer.bufferTailEndIndex || effectiveBufferEndIndex));
  const demandHeadEndIndex = typeof renderBuffer.daemonHeadEndIndex === 'number' && Number.isFinite(renderBuffer.daemonHeadEndIndex)
    ? Math.max(renderBuffer.startIndex, Math.floor(renderBuffer.daemonHeadEndIndex))
    : bufferTailAnchorEndIndex;
  const followDemandAnchorEndIndex = Math.max(bufferTailAnchorEndIndex, demandHeadEndIndex);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastWidthModeSignalRef = useRef<{ mode: TerminalWidthMode; cols: number | null } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const lastReportedViewportRef = useRef<string>('');
  const followScrollSyncTimerRef = useRef<number | null>(null);
  const recentViewportLayoutChangeTimerRef = useRef<number | null>(null);
  const pendingFollowRenderBottomIndexRef = useRef<number | null>(null);
  const pendingImmediateFollowScrollSyncRef = useRef(false);
  const lastQueuedFollowRenderBottomIndexRef = useRef<number | null>(null);
  const pendingFollowScrollSyncRef = useRef(false);
  const pendingFollowViewportRealignRef = useRef(false);
  const recentViewportLayoutChangeRef = useRef(false);
  const ignoredProgrammaticScrollTopRef = useRef<number | null>(null);
  const lastSettledScrollTopRef = useRef(0);
  const hasSettledFollowFrameRef = useRef(false);
  const syncScrollHostToRenderBottomRef = useRef<(nextRenderBottomIndex: number) => void>(() => {});
  const runViewportRefreshRef = useRef<() => void>(() => {});
  const queueFollowVisualRealignRef = useRef<(options?: {
    guardPendingFollowDrift?: boolean;
    renderBottomIndex?: number;
  }) => void>(() => {});
  const readingModeRef = useRef(false);
  const suppressProgrammaticScrollRef = useRef(false);
  const wasActiveRef = useRef(refreshActive);
  const previousRefreshActiveRef = useRef(refreshActive);
  const previousRefreshSessionIdRef = useRef<string | null>(sessionId);
  const previousSessionIdRef = useRef<string | null>(sessionId);
  const previousInputResetEpochRef = useRef(inputResetEpoch);
  const previousFollowResetEpochRef = useRef(followResetEpoch);
  const previousFollowViewportMetricsRef = useRef<{
    viewportRows: number;
    rowHeightPx: number;
    clientHeightPx: number;
  } | null>(null);
  const previousPrePaintFollowRealignKeyRef = useRef<string | null>(null);
  const userScrollIntentDeadlineRef = useRef(0);
  const touchGestureRef = useRef({
    active: false,
    pointerCaptured: false,
    axis: null as 'horizontal' | 'vertical' | null,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
  });

  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [resolvedCellWidthPx, setResolvedCellWidthPx] = useState(Math.max(1, fontSize * 0.62));
  const [viewportClientHeightPx, setViewportClientHeightPx] = useState(0);
  const [renderBottomIndex, setRenderBottomIndex] = useState(effectiveBufferEndIndex);
  const [readingMode, setReadingMode] = useState(false);

  const rowHeightPx = Math.max(1, parseInt(resolvedRowHeight, 10) || parseInt(rowHeight, 10) || 17);
  const dataRowCount = Math.max(0, effectiveBufferEndIndex - renderBuffer.startIndex);
  const minimumRenderBottomIndex = dataRowCount <= viewportRows
    ? effectiveBufferEndIndex
    : renderBuffer.startIndex + viewportRows;
  const followVisualBottomIndex = Math.max(
    minimumRenderBottomIndex,
    Math.min(
      Math.max(minimumRenderBottomIndex, Math.floor(followDemandAnchorEndIndex || 0)),
      Math.max(minimumRenderBottomIndex, Math.floor(effectiveBufferEndIndex || 0)),
    ),
  );
  const maximumRenderBottomIndex = Math.max(minimumRenderBottomIndex, effectiveBufferEndIndex);
  const clampedRenderBottomIndex = Math.max(
    minimumRenderBottomIndex,
    Math.min(maximumRenderBottomIndex, Math.floor(renderBottomIndex || followVisualBottomIndex)),
  );
  const totalRows = Math.max(
    bufferLines.length,
    effectiveBufferEndIndex - renderBuffer.startIndex,
    viewportRows,
  );
  const maxScrollTop = Math.max(0, (totalRows - viewportRows) * rowHeightPx);
  readingModeRef.current = readingMode;
  const followMode = !readingMode;
  const effectiveRenderBottomIndex = followMode ? followVisualBottomIndex : clampedRenderBottomIndex;
  const visibleWindowStartIndex = Math.max(renderBuffer.startIndex, effectiveRenderBottomIndex - viewportRows);
  const visibleWindowEndIndex = Math.min(effectiveBufferEndIndex, Math.max(visibleWindowStartIndex, effectiveRenderBottomIndex));
  const visibleDataRows = Math.max(0, visibleWindowEndIndex - visibleWindowStartIndex);
  const leadingBlankRows = Math.max(0, viewportRows - visibleDataRows);
  const visibleStartOffset = Math.max(0, visibleWindowStartIndex - renderBuffer.startIndex);
  const renderStartOffset = Math.max(0, visibleStartOffset - OVERSCAN_ROWS);
  const renderEndOffset = Math.min(totalRows, visibleStartOffset + viewportRows + OVERSCAN_ROWS);
  const renderRows = useMemo(() => {
    const rows: Array<{ absoluteIndex: number; row: TerminalCell[]; isGap: boolean; viewportOffset: number }> = [];
    const visibleDataStartOffset = Math.max(0, renderStartOffset - leadingBlankRows);
    const visibleDataEndOffset = Math.max(
      visibleDataStartOffset,
      Math.min(bufferLines.length, renderEndOffset - leadingBlankRows),
    );

    for (let dataOffset = visibleDataStartOffset; dataOffset < visibleDataEndOffset; dataOffset += 1) {
      const viewportOffset = leadingBlankRows + dataOffset;
      const absoluteIndex = renderBuffer.startIndex + dataOffset;
      rows.push({
        absoluteIndex,
        row: bufferLines[dataOffset] || [],
        isGap: isGapIndex(renderBuffer.gapRanges, absoluteIndex),
        viewportOffset,
      });
    }
    return rows;
  }, [
    bufferLines,
    leadingBlankRows,
    renderEndOffset,
    renderStartOffset,
    renderBuffer.gapRanges,
    renderBuffer.startIndex,
  ]);
  const termGridPaddingTopPx = renderRows.length > 0
    ? renderRows[0]!.viewportOffset * rowHeightPx
    : totalRows * rowHeightPx;
  const termGridPaddingBottomPx = renderRows.length > 0
    ? Math.max(0, totalRows - (renderRows[renderRows.length - 1]!.viewportOffset + 1)) * rowHeightPx
    : 0;
  const renderGeometryRevision = [
    renderBuffer.revision,
    renderBuffer.startIndex,
    effectiveBufferEndIndex,
    followVisualBottomIndex,
    viewportRows,
    rowHeightPx,
    renderRows.length,
    termGridPaddingTopPx,
    termGridPaddingBottomPx,
  ].join(':');

  const focusTerminal = useCallback(() => {
    if (!allowDomFocus) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.disabled = false;
    input.readOnly = false;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [allowDomFocus]);
  const sessionIdRef = useRef(sessionId);
  const onInputRef = useRef(onInput);
  const focusTerminalRef = useRef(focusTerminal);
  const cursorKeysAppRef = useRef(renderBuffer.cursorKeysApp);
  sessionIdRef.current = sessionId;
  onInputRef.current = onInput;
  focusTerminalRef.current = focusTerminal;
  cursorKeysAppRef.current = renderBuffer.cursorKeysApp;

  const resolveScrollTopForRenderBottomIndex = useCallback((nextRenderBottomIndex: number) => {
    const topOffset = Math.max(
      0,
      Math.min(
        totalRows - viewportRows,
        Math.max(0, Math.floor(nextRenderBottomIndex) - renderBuffer.startIndex - viewportRows),
      ),
    );
    return Math.max(0, Math.min(maxScrollTop, topOffset * rowHeightPx));
  }, [maxScrollTop, renderBuffer.startIndex, rowHeightPx, totalRows, viewportRows]);

  const resolveRenderDemandFromScroll = useCallback((nextScrollTop: number, host?: HTMLDivElement | null) => {
    const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    const scrollHost = host ?? containerRef.current;
    const observedScrollTop = scrollHost ? scrollHost.scrollTop : clampedScrollTop;
    const visibleTopOffset = Math.max(0, Math.floor(clampedScrollTop / rowHeightPx));
    const nextWindowBottomIndex = dataRowCount <= viewportRows
      ? effectiveBufferEndIndex
      : Math.max(
          minimumRenderBottomIndex,
          Math.min(bufferTailAnchorEndIndex, renderBuffer.startIndex + visibleTopOffset + viewportRows),
        );
    const nextMode: 'follow' | 'reading' = isScrollAtBottom(scrollHost, observedScrollTop, maxScrollTop)
      ? 'follow'
      : 'reading';
    const nextRenderBottomIndex = nextMode === 'follow'
      ? followVisualBottomIndex
      : nextWindowBottomIndex;
    return {
      clampedScrollTop: nextMode === 'follow'
        ? resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex)
        : clampedScrollTop,
      nextMode,
      nextRenderBottomIndex,
    };
  }, [
    renderBuffer.startIndex,
    dataRowCount,
    effectiveBufferEndIndex,
    followVisualBottomIndex,
    maxScrollTop,
    minimumRenderBottomIndex,
    resolveScrollTopForRenderBottomIndex,
    rowHeightPx,
    viewportRows,
  ]);

  const markFollowViewportRealignOnLayoutDrift = useCallback((viewportLayoutChanged: boolean) => {
    if (readingModeRef.current || !viewportLayoutChanged) {
      return;
    }
    pendingFollowViewportRealignRef.current = true;
    if (viewportClientHeightPx <= 0) {
      return;
    }
    recentViewportLayoutChangeRef.current = true;
    if (recentViewportLayoutChangeTimerRef.current !== null) {
      window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
    }
    recentViewportLayoutChangeTimerRef.current = window.setTimeout(() => {
      recentViewportLayoutChangeTimerRef.current = null;
      recentViewportLayoutChangeRef.current = false;
    }, 0);
  }, [viewportClientHeightPx]);

  const commitMeasuredViewportState = useCallback((nextViewport: ReturnType<typeof measureViewport>, nextClientHeight: number) => {
    setViewportClientHeightPx((current) => (current === nextClientHeight ? current : nextClientHeight));
    setResolvedRowHeight((current) => current === nextViewport.resolvedRowHeight ? current : nextViewport.resolvedRowHeight);
    setResolvedCellWidthPx((current) => current === nextViewport.resolvedCellWidthPx ? current : nextViewport.resolvedCellWidthPx);
    setViewportRows((current) => current === nextViewport.rows ? current : nextViewport.rows);
  }, []);

  const emitWidthModeSignalIfNeeded = useCallback((nextViewport: ReturnType<typeof measureViewport>) => {
    if (!sessionId) {
      return;
    }
    const widthSignalCols = widthMode === 'adaptive-phone' ? nextViewport.cols : null;
    const previousWidthSignal = lastWidthModeSignalRef.current;
    const shouldEmitWidthModeSignal = Boolean(
      refreshActive
      && sessionId
      && onWidthModeChange
      && (
        !previousWidthSignal
        || previousWidthSignal.mode !== widthMode
        || previousWidthSignal.cols !== widthSignalCols
      )
    );

    if (!shouldEmitWidthModeSignal) {
      return;
    }

    lastWidthModeSignalRef.current = {
      mode: widthMode,
      cols: widthSignalCols,
    };
    onWidthModeChange?.(sessionId, widthMode, widthSignalCols);
  }, [onWidthModeChange, refreshActive, sessionId, widthMode]);

  const scheduleViewportResizeCommit = useCallback((nextViewport: ReturnType<typeof measureViewport>, previousViewport: { cols: number; rows: number } | null) => {
    if (!sessionId) {
      return;
    }
    if (previousViewport && previousViewport.cols === nextViewport.cols && previousViewport.rows === nextViewport.rows) {
      return;
    }

    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
    }

    if (widthMode === 'mirror-fixed') {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      return;
    }

    if (previousViewport && previousViewport.cols === nextViewport.cols && previousViewport.rows !== nextViewport.rows) {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      return;
    }

    resizeCommitTimerRef.current = window.setTimeout(() => {
      lastViewportRef.current = { cols: nextViewport.cols, rows: nextViewport.rows };
      onResize?.(sessionId, nextViewport.cols, nextViewport.rows);
      resizeCommitTimerRef.current = null;
    }, 60);
  }, [onResize, sessionId, widthMode]);

  const syncViewport = useCallback(() => {
    const host = containerRef.current;
    if (!host || !refreshActive || !sessionId) {
      return;
    }

    const nextViewport = measureViewport(host, fontSize, rowHeight);
    const nextClientHeight = Math.max(0, Math.round(host.clientHeight || 0));
    const viewportLayoutChanged = nextViewport.rows !== viewportRows || nextClientHeight !== viewportClientHeightPx;

    markFollowViewportRealignOnLayoutDrift(viewportLayoutChanged);
    commitMeasuredViewportState(nextViewport, nextClientHeight);

    const previousViewport = lastViewportRef.current;
    emitWidthModeSignalIfNeeded(nextViewport);
    scheduleViewportResizeCommit(nextViewport, previousViewport);
  }, [
    commitMeasuredViewportState,
    emitWidthModeSignalIfNeeded,
    fontSize,
    markFollowViewportRealignOnLayoutDrift,
    refreshActive,
    rowHeight,
    scheduleViewportResizeCommit,
    sessionId,
    viewportClientHeightPx,
    viewportRows,
  ]);

  const emitRenderDemand = useCallback((nextMode: 'follow' | 'reading', nextRenderBottomIndex: number, options?: {
    viewportEndIndex?: number;
  }) => {
    if (!refreshActive || !sessionId || !onViewportChange) {
      return;
    }

    const viewportEndIndex = typeof options?.viewportEndIndex === 'number'
      ? Math.max(renderBuffer.startIndex, Math.floor(options.viewportEndIndex))
      : nextMode === 'follow'
      ? followDemandAnchorEndIndex
      : Math.max(renderBuffer.startIndex, Math.floor(nextRenderBottomIndex));
    const key = `${nextMode}:${viewportEndIndex}:${viewportRows}`;
    if (lastReportedViewportRef.current === key) {
      return;
    }
    lastReportedViewportRef.current = key;
    onViewportChange(sessionId, {
      mode: nextMode,
      viewportEndIndex,
      viewportRows,
    });
  }, [followDemandAnchorEndIndex, onViewportChange, refreshActive, renderBuffer.startIndex, sessionId, viewportRows]);

  const applyScrollState = useCallback((nextScrollTop: number, host?: HTMLDivElement | null) => {
    const { nextMode, nextRenderBottomIndex } = resolveRenderDemandFromScroll(nextScrollTop, host);
    const scrollHost = host ?? containerRef.current;
    const observedScrollTop = scrollHost ? Math.max(0, scrollHost.scrollTop) : Math.max(0, nextScrollTop);
    const upwardAwayFromSettledBottom = observedScrollTop < lastSettledScrollTopRef.current - 1;
    if (
      nextMode === 'reading'
      && !readingModeRef.current
      && !hasRecentUserScrollIntent(userScrollIntentDeadlineRef)
      && !upwardAwayFromSettledBottom
    ) {
      queueFollowVisualRealignRef.current({
        guardPendingFollowDrift: true,
      });
      return;
    }
    readingModeRef.current = nextMode === 'reading';
    setRenderBottomIndex(nextRenderBottomIndex);
    setReadingMode(nextMode === 'reading');
    emitRenderDemand(nextMode, nextRenderBottomIndex);
  }, [emitRenderDemand, resolveRenderDemandFromScroll]);

  const syncScrollHostToRenderBottom = useCallback((nextRenderBottomIndex: number) => {
    const host = containerRef.current;
    if (!host) {
      pendingFollowScrollSyncRef.current = false;
      return;
    }

    const nextTarget = resolveFollowScrollSyncTarget(
      host,
      nextRenderBottomIndex,
      resolveScrollTopForRenderBottomIndex,
    );
    pendingFollowScrollSyncRef.current = false;
    pendingFollowViewportRealignRef.current = false;
    commitProgrammaticTerminalScroll(host, nextTarget, {
      ignoredProgrammaticScrollTopRef,
      suppressProgrammaticScrollRef,
      lastSettledScrollTopRef,
      hasSettledFollowFrameRef,
    });
  }, [resolveScrollTopForRenderBottomIndex]);
  syncScrollHostToRenderBottomRef.current = syncScrollHostToRenderBottom;

  const queueFollowScrollSync = useCallback((nextRenderBottomIndex: number, options?: {
    guardPendingFollowDrift?: boolean;
  }) => {
    const normalizedTarget = Math.max(minimumRenderBottomIndex, Math.floor(nextRenderBottomIndex));
    const samePendingTarget = pendingFollowRenderBottomIndexRef.current === normalizedTarget;
    const sameQueuedTarget = lastQueuedFollowRenderBottomIndexRef.current === normalizedTarget;
    if (
      samePendingTarget
      && sameQueuedTarget
      && (followScrollSyncTimerRef.current !== null || pendingFollowScrollSyncRef.current)
    ) {
      if (options?.guardPendingFollowDrift) {
        pendingFollowScrollSyncRef.current = true;
      }
      return;
    }
    pendingFollowRenderBottomIndexRef.current = normalizedTarget;
    lastQueuedFollowRenderBottomIndexRef.current = normalizedTarget;
    pendingFollowScrollSyncRef.current = pendingFollowScrollSyncRef.current
      || Boolean(options?.guardPendingFollowDrift);
    if (followScrollSyncTimerRef.current !== null) {
      return;
    }
    followScrollSyncTimerRef.current = window.setTimeout(() => {
      followScrollSyncTimerRef.current = null;
      const pendingRenderBottomIndex = pendingFollowRenderBottomIndexRef.current;
      pendingFollowRenderBottomIndexRef.current = null;
      lastQueuedFollowRenderBottomIndexRef.current = null;
      if (pendingRenderBottomIndex === null) {
        return;
      }
      syncScrollHostToRenderBottomRef.current(pendingRenderBottomIndex);
    }, 0);
  }, [minimumRenderBottomIndex]);

  const cancelPendingFollowScrollSync = useCallback(() => {
    if (followScrollSyncTimerRef.current !== null) {
      window.clearTimeout(followScrollSyncTimerRef.current);
      followScrollSyncTimerRef.current = null;
    }
    if (recentViewportLayoutChangeTimerRef.current !== null) {
      window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
      recentViewportLayoutChangeTimerRef.current = null;
    }
    pendingFollowRenderBottomIndexRef.current = null;
    pendingImmediateFollowScrollSyncRef.current = false;
    lastQueuedFollowRenderBottomIndexRef.current = null;
    pendingFollowScrollSyncRef.current = false;
    pendingFollowViewportRealignRef.current = false;
    recentViewportLayoutChangeRef.current = false;
    ignoredProgrammaticScrollTopRef.current = null;
  }, []);

  const queueFollowVisualRealign = useCallback((options?: {
    guardPendingFollowDrift?: boolean;
    renderBottomIndex?: number;
  }) => {
    queueFollowScrollSync(options?.renderBottomIndex ?? followVisualBottomIndex, {
      guardPendingFollowDrift: options?.guardPendingFollowDrift,
    });
  }, [followVisualBottomIndex, queueFollowScrollSync]);
  queueFollowVisualRealignRef.current = queueFollowVisualRealign;

  const flushPendingFollowScrollSync = useCallback(() => {
    if (!refreshActive || readingModeRef.current) {
      return false;
    }
    const pendingRenderBottomIndex = pendingFollowRenderBottomIndexRef.current;
    const shouldSyncImmediately = pendingImmediateFollowScrollSyncRef.current;
    if (pendingRenderBottomIndex === null && !shouldSyncImmediately) {
      return false;
    }
    if (followScrollSyncTimerRef.current !== null) {
      window.clearTimeout(followScrollSyncTimerRef.current);
      followScrollSyncTimerRef.current = null;
    }
    pendingFollowRenderBottomIndexRef.current = null;
    pendingImmediateFollowScrollSyncRef.current = false;
    syncScrollHostToRenderBottom(pendingRenderBottomIndex ?? followVisualBottomIndex);
    return true;
  }, [followVisualBottomIndex, readingModeRef, refreshActive, syncScrollHostToRenderBottom]);

  const syncFollowScrollToAnchor = useCallback(() => {
    if (!refreshActive || readingModeRef.current) {
      return false;
    }
    syncScrollHostToRenderBottom(followVisualBottomIndex);
    return true;
  }, [followVisualBottomIndex, refreshActive, syncScrollHostToRenderBottom]);

  const clearRecentViewportLayoutChange = useCallback(() => {
    recentViewportLayoutChangeRef.current = false;
    if (recentViewportLayoutChangeTimerRef.current !== null) {
      window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
      recentViewportLayoutChangeTimerRef.current = null;
    }
  }, []);

  const handleFollowModeScrollGuards = useCallback((host: HTMLDivElement) => {
    if (readingModeRef.current) {
      return false;
    }

    if (handleRecentViewportLayoutScrollGuard({
      recentViewportLayoutChangeRef,
      clearRecentViewportLayoutChange,
      queueFollowVisualRealign,
    })) {
      return true;
    }

    if (handlePendingFollowScrollGuard(host, {
      pendingFollowScrollSyncRef,
      pendingFollowRenderBottomIndexRef,
      pendingFollowViewportRealignRef,
      lastSettledScrollTopRef,
      queueFollowVisualRealign,
      cancelPendingFollowScrollSync,
    })) {
      return true;
    }

    if (handleIgnoredProgrammaticScrollGuard(host, {
      ignoredProgrammaticScrollTopRef,
      lastSettledScrollTopRef,
    })) {
      return true;
    }

    if (shouldQueueFollowRealignFromObservedScroll(host, {
      lastSettledScrollTopRef,
      maxScrollTop,
    })) {
      queueFollowVisualRealign({
        guardPendingFollowDrift: true,
      });
      return true;
    }

    return false;
  }, [cancelPendingFollowScrollSync, clearRecentViewportLayoutChange, maxScrollTop, queueFollowVisualRealign]);

  const resetFollowViewportReport = useCallback(() => {
    lastReportedViewportRef.current = '';
  }, []);

  const setFollowModeState = useCallback((nextRenderBottomIndex: number) => {
    readingModeRef.current = false;
    setReadingMode(false);
    setRenderBottomIndex(nextRenderBottomIndex);
  }, []);

  const scheduleFollowScrollRealign = useCallback((nextRenderBottomIndex: number, options?: {
    guardPendingFollowDrift?: boolean;
    queueScrollSync?: boolean;
    immediateScrollSync?: boolean;
  }) => {
    if (options?.immediateScrollSync) {
      pendingImmediateFollowScrollSyncRef.current = true;
    }
    if (options?.queueScrollSync === false) {
      return;
    }
    queueFollowVisualRealign({
      renderBottomIndex: nextRenderBottomIndex,
      guardPendingFollowDrift: options?.guardPendingFollowDrift,
    });
  }, [queueFollowVisualRealign]);

  const emitFollowViewportDemand = useCallback((nextRenderBottomIndex: number) => {
    emitRenderDemand('follow', nextRenderBottomIndex);
  }, [emitRenderDemand]);

  const alignRenderBottomToFollow = useCallback((options?: {
    resetReportedViewport?: boolean;
    guardPendingFollowDrift?: boolean;
    queueScrollSync?: boolean;
    immediateScrollSync?: boolean;
  }) => {
    const nextRenderBottomIndex = followVisualBottomIndex;
    if (options?.resetReportedViewport) {
      resetFollowViewportReport();
    }
    setFollowModeState(nextRenderBottomIndex);
    scheduleFollowScrollRealign(nextRenderBottomIndex, options);
    emitFollowViewportDemand(nextRenderBottomIndex);
    return nextRenderBottomIndex;
  }, [emitFollowViewportDemand, followVisualBottomIndex, resetFollowViewportReport, scheduleFollowScrollRealign, setFollowModeState]);

  const emitCurrentRenderDemand = useCallback(() => {
    const nextMode: 'follow' | 'reading' = readingModeRef.current ? 'reading' : 'follow';
    emitRenderDemand(
      nextMode,
      nextMode === 'follow' ? followVisualBottomIndex : effectiveRenderBottomIndex,
    );
  }, [effectiveRenderBottomIndex, emitRenderDemand, followVisualBottomIndex]);

  const emitReadingRenderDemand = useCallback((nextRenderBottomIndex?: number) => {
    emitRenderDemand('reading', nextRenderBottomIndex ?? effectiveRenderBottomIndex);
  }, [effectiveRenderBottomIndex, emitRenderDemand]);

  const reconcileFollowViewportAfterBufferShift = useCallback(() => {
    alignRenderBottomToFollow({
      guardPendingFollowDrift: hasSettledFollowFrameRef.current,
    });
  }, [alignRenderBottomToFollow]);

  const reconcileReadingViewportAfterBufferShift = useCallback(() => {
    if (effectiveRenderBottomIndex >= followVisualBottomIndex) {
      alignRenderBottomToFollow();
      return;
    }

    const nextRenderBottomIndex = Math.max(
      minimumRenderBottomIndex,
      Math.min(maximumRenderBottomIndex, Math.floor(effectiveRenderBottomIndex)),
    );
    if (maxScrollTop <= 1) {
      alignRenderBottomToFollow();
      return;
    }
    if (nextRenderBottomIndex !== effectiveRenderBottomIndex) {
      setRenderBottomIndex(nextRenderBottomIndex);
    }
    emitReadingRenderDemand(nextRenderBottomIndex);
  }, [
    alignRenderBottomToFollow,
    effectiveRenderBottomIndex,
    emitReadingRenderDemand,
    maxScrollTop,
    maximumRenderBottomIndex,
    minimumRenderBottomIndex,
    followVisualBottomIndex,
  ]);

  const reconcileViewportAfterBufferShift = useCallback(() => {
    if (!refreshActive) {
      return;
    }
    if (!readingModeRef.current) {
      reconcileFollowViewportAfterBufferShift();
      return;
    }
    reconcileReadingViewportAfterBufferShift();
  }, [
    readingModeRef,
    reconcileFollowViewportAfterBufferShift,
    reconcileReadingViewportAfterBufferShift,
    refreshActive,
  ]);

  const emitRenderDemandSignalsForCurrentFrame = useCallback(() => {
    emitCurrentRenderDemand();
  }, [emitCurrentRenderDemand]);

  const runViewportRefresh = useCallback(() => {
    syncViewport();
  }, [syncViewport]);
  runViewportRefreshRef.current = runViewportRefresh;

  const consumeFollowResetTrigger = useCallback(() => consumeFollowResetSignal({
    refreshActive,
    wasActiveRef,
    previousInputResetEpochRef,
    previousFollowResetEpochRef,
    inputResetEpoch,
    followResetEpoch,
  }), [followResetEpoch, inputResetEpoch, refreshActive]);

  const consumeViewportRefreshTrigger = useCallback(() => consumeViewportRefreshSignal({
    refreshActive,
    previousRefreshActiveRef,
    previousRefreshSessionIdRef,
    sessionId,
  }), [refreshActive, sessionId]);

  const resetTouchGesture = useCallback(() => {
    touchGestureRef.current = {
      active: false,
      pointerCaptured: false,
      axis: null,
      startX: 0,
      startY: 0,
      deltaX: 0,
      deltaY: 0,
    };
  }, []);

  useEffect(() => {
    applySessionSwitchRenderReset({
      sessionId,
      previousSessionIdRef,
      followVisualBottomIndex,
      setReadingMode,
      setRenderBottomIndex,
      pendingImmediateFollowScrollSyncRef,
      lastReportedViewportRef,
      previousRefreshSessionIdRef,
      previousInputResetEpochRef,
      previousFollowResetEpochRef,
      inputResetEpoch,
      followResetEpoch,
    });
  }, [followResetEpoch, followVisualBottomIndex, inputResetEpoch, sessionId]);

  useLayoutEffect(() => {
    if (!consumeFollowResetTrigger()) {
      return;
    }
    alignRenderBottomToFollow({ resetReportedViewport: true, immediateScrollSync: true });
  }, [alignRenderBottomToFollow, consumeFollowResetTrigger]);

  useEffect(() => {
    if (!consumeViewportRefreshTrigger()) {
      return;
    }
    runViewportRefresh();
  }, [consumeViewportRefreshTrigger, runViewportRefresh]);

  useEffect(() => {
    reconcileViewportAfterBufferShift();
  }, [
    refreshActive,
    renderBuffer.gapRanges,
    bufferLines,
    renderBuffer.startIndex,
    effectiveBufferEndIndex,
    followDemandAnchorEndIndex,
    maxScrollTop,
    reconcileViewportAfterBufferShift,
    renderGeometryRevision,
    sessionId,
    viewportRows,
  ]);

  useLayoutEffect(() => {
    const followRealignKey = [
      sessionId || '',
      renderGeometryRevision,
    ].join(':');
    const previousKey = previousPrePaintFollowRealignKeyRef.current;
    previousPrePaintFollowRealignKeyRef.current = followRealignKey;

    if (previousKey === null || previousKey === followRealignKey) {
      return;
    }
    if (!active || !refreshActive || readingModeRef.current) {
      return;
    }
    syncScrollHostToRenderBottom(followVisualBottomIndex);
  }, [
    active,
    effectiveBufferEndIndex,
    followVisualBottomIndex,
    refreshActive,
    renderBuffer.startIndex,
    renderGeometryRevision,
    rowHeightPx,
    sessionId,
    syncScrollHostToRenderBottom,
    viewportRows,
  ]);

  useLayoutEffect(() => {
    flushPendingFollowScrollSync();
  }, [
    effectiveBufferEndIndex,
    flushPendingFollowScrollSync,
    renderBuffer.revision,
    renderBuffer.startIndex,
    renderGeometryRevision,
    rowHeightPx,
    viewportRows,
  ]);

  useLayoutEffect(() => {
    if (!refreshActive || readingModeRef.current) {
      return;
    }
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const observedScrollTop = Math.max(0, host.scrollTop);
    const domBottomScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    const overscrolledBlankFrame = observedScrollTop > domBottomScrollTop + 1;
    const pendingViewportRealign = pendingFollowViewportRealignRef.current;

    if (!overscrolledBlankFrame && !pendingViewportRealign) {
      return;
    }

    syncScrollHostToRenderBottom(followVisualBottomIndex);
  });

  useEffect(() => {
    const previousMetrics = previousFollowViewportMetricsRef.current;
    previousFollowViewportMetricsRef.current = { viewportRows, rowHeightPx, clientHeightPx: viewportClientHeightPx };

    if (!refreshActive || readingModeRef.current) {
      return;
    }

    if (
      !previousMetrics
      || (
        previousMetrics.viewportRows === viewportRows
        && previousMetrics.rowHeightPx === rowHeightPx
        && previousMetrics.clientHeightPx === viewportClientHeightPx
      )
    ) {
      return;
    }

    syncFollowScrollToAnchor();
  }, [rowHeightPx, syncFollowScrollToAnchor, viewportClientHeightPx, viewportRows]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    runViewportRefreshRef.current();
    const observer = new ResizeObserver(() => runViewportRefreshRef.current());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!refreshActive) {
      return;
    }
    emitRenderDemandSignalsForCurrentFrame();
  }, [
    refreshActive,
    renderBuffer.gapRanges,
    bufferLines,
    renderBuffer.startIndex,
    effectiveBufferEndIndex,
    emitRenderDemandSignalsForCurrentFrame,
    followDemandAnchorEndIndex,
    renderGeometryRevision,
    viewportRows,
  ]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.disabled = !allowDomFocus;
    input.readOnly = !allowDomFocus;
    input.tabIndex = allowDomFocus ? 0 : -1;
    input.style.pointerEvents = allowDomFocus && !domInputOffscreen ? 'auto' : 'none';
    input.style.opacity = domInputOffscreen ? '0' : '0.01';
    input.style.width = domInputOffscreen ? '1px' : '140px';
    input.style.height = domInputOffscreen ? '1px' : '36px';
    input.style.left = domInputOffscreen ? '-9999px' : '50%';
    input.style.bottom = domInputOffscreen ? 'auto' : '12px';
    input.style.top = domInputOffscreen ? '0' : 'auto';
    input.style.transform = domInputOffscreen ? 'none' : 'translateX(-50%)';
    if (!allowDomFocus) {
      input.blur();
    }
  }, [allowDomFocus, domInputOffscreen]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !allowDomFocus) {
      return;
    }

    const domInputController = createTerminalDomInputController({
      input,
      sessionIdRef,
      onInputRef,
      focusTerminalRef,
      cursorKeysAppRef,
    });

    input.addEventListener('compositionstart', domInputController.handleCompositionStart);
    input.addEventListener('compositionend', domInputController.handleCompositionEnd);
    input.addEventListener('beforeinput', domInputController.handleBeforeInput);
    input.addEventListener('input', domInputController.handleInput);
    input.addEventListener('change', domInputController.handleChange);
    input.addEventListener('keydown', domInputController.handleKeyDown);

    return () => {
      domInputController.clearScheduledFlush();
      input.removeEventListener('compositionstart', domInputController.handleCompositionStart);
      input.removeEventListener('compositionend', domInputController.handleCompositionEnd);
      input.removeEventListener('beforeinput', domInputController.handleBeforeInput);
      input.removeEventListener('input', domInputController.handleInput);
      input.removeEventListener('change', domInputController.handleChange);
      input.removeEventListener('keydown', domInputController.handleKeyDown);
    };
  }, [allowDomFocus]);

  useEffect(() => {
    if (!active || !allowDomFocus) {
      return;
    }
    focusTerminal();
  }, [active, allowDomFocus, focusNonce, focusTerminal]);

  useEffect(() => () => {
    cancelPendingFollowScrollSync();
    if (resizeCommitTimerRef.current) {
      window.clearTimeout(resizeCommitTimerRef.current);
      resizeCommitTimerRef.current = null;
    }
    resetTouchGesture();
  }, [cancelPendingFollowScrollSync, resetTouchGesture]);

  return (
    <div
      ref={containerRef}
      className="wterm"
      data-terminal-session-id={sessionId || undefined}
      data-testid={sessionId ? `terminal-view-${sessionId}` : undefined}
      data-active={active ? 'true' : 'false'}
      data-has-oninput={onInput ? 'true' : 'false'}
      data-has-onresize={onResize ? 'true' : 'false'}
      data-has-onswipetab={swipeTabEnabled ? 'true' : 'false'}
      data-width-mode={widthMode}
      onClick={() => {
        if (!sessionId) {
          return;
        }
        if (allowDomFocus) {
          focusTerminal();
          return;
        }
        onActivateInput?.(sessionId);
      }}
      onScroll={(event) => {
        if (suppressProgrammaticScrollRef.current) {
          return;
        }
        const host = event.currentTarget as HTMLDivElement;
        if (handleFollowModeScrollGuards(host)) {
          return;
        }
        applyScrollState(host.scrollTop, host);
        lastSettledScrollTopRef.current = host.scrollTop;
      }}
      onTouchStart={(event) => {
        if (!active || !sessionId || !swipeTabEnabled || event.touches.length !== 1) {
          resetTouchGesture();
          return;
        }
        markUserScrollIntent(userScrollIntentDeadlineRef, 300);
        const touch = event.touches[0];
        touchGestureRef.current = {
          active: true,
          pointerCaptured: false,
          axis: null,
          startX: touch.clientX,
          startY: touch.clientY,
          deltaX: 0,
          deltaY: 0,
        };
      }}
      onTouchMove={(event) => {
        const gesture = touchGestureRef.current;
        if (!gesture.active || event.touches.length !== 1) {
          return;
        }
        const touch = event.touches[0];
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        gesture.deltaX = deltaX;
        gesture.deltaY = deltaY;

        if (!gesture.axis) {
          if (Math.abs(deltaX) < TAB_SWIPE_LOCK_THRESHOLD_PX && Math.abs(deltaY) < TAB_SWIPE_LOCK_THRESHOLD_PX) {
            return;
          }
          gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
        }

        if (gesture.axis === 'horizontal') {
          gesture.pointerCaptured = true;
          event.preventDefault();
          return;
        }
        markUserScrollIntent(userScrollIntentDeadlineRef, 300);
      }}
      onTouchEnd={() => {
        const gesture = touchGestureRef.current;
        if (!gesture.active) {
          return;
        }
        const direction = gesture.axis === 'horizontal' && Math.abs(gesture.deltaX) >= TAB_SWIPE_TRIGGER_THRESHOLD_PX
          ? gesture.deltaX < 0
            ? 'next'
            : 'previous'
          : null;
        resetTouchGesture();
        if (!active || !sessionId || !swipeTabEnabled || !direction) {
          return;
        }
        onSwipeTab?.(sessionId, direction);
      }}
      onTouchCancel={() => {
        resetTouchGesture();
      }}
      onWheel={() => {
        markUserScrollIntent(userScrollIntentDeadlineRef, 250);
      }}
      onPointerDown={() => {
        markUserScrollIntent(userScrollIntentDeadlineRef, 250);
      }}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        backgroundColor: theme.background,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        touchAction: swipeTabEnabled ? 'pan-y' : 'pan-x pan-y',
        padding: '0',
        borderRadius: '0',
        boxShadow: 'none',
        ['--term-font-family' as string]: TERMINAL_FONT_STACK,
        ['--term-font-size' as string]: `${fontSize}px`,
        ['--term-row-height' as string]: resolvedRowHeight || rowHeight,
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: `${fontSize}px`,
      }}
    >
      <div className="term-grid" data-cursor-source="cursor-metadata" style={{ paddingTop: `${termGridPaddingTopPx}px`, paddingBottom: `${termGridPaddingBottomPx}px` }}>
        {renderRows.map(({ absoluteIndex, row, isGap }, rowIndex) => (
          <VisibleRow
            key={`row-${absoluteIndex}`}
            absoluteIndex={absoluteIndex}
            row={row}
            rowIndex={rowIndex}
            rowHeight={resolvedRowHeight || rowHeight}
            cellWidthPx={resolvedCellWidthPx}
            isGap={isGap}
            theme={theme}
            cursorColumn={
              renderBuffer.cursor && renderBuffer.cursor.visible && renderBuffer.cursor.rowIndex === absoluteIndex
                ? resolveCursorCellColumn(row, renderBuffer.cursor.col)
                : -1
            }
            showAbsoluteLineNumbers={showAbsoluteLineNumbers}
            discontinuousLineNumber={isGap || hasDiscontinuousNeighbor(renderRows, rowIndex)}
          />
        ))}
      </div>
      <textarea
        ref={inputRef}
        data-wterm-input="true"
        data-terminal-input-session-id={sessionId || undefined}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        enterKeyHint="done"
        inputMode="text"
        spellCheck={false}
        aria-hidden={domInputOffscreen ? 'true' : undefined}
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 0,
          opacity: 0,
          width: '1px',
          height: '1px',
          border: '0',
          padding: 0,
          resize: 'none',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'transparent',
        }}
      />
      <style>{`@keyframes zterm-history-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export const TerminalView = memo(TerminalViewComponent);
TerminalView.displayName = 'TerminalView';
