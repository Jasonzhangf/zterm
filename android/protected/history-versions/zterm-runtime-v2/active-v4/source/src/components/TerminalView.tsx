import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type TouchEvent,
} from "react";
import {
  useSessionRenderBufferSnapshot,
  type SessionRenderBufferStore,
} from "../lib/session-render-buffer-store";
import {
  getTerminalThemePreset,
  // renderer pure functions
  DEFAULT_ROWS,
  OVERSCAN_ROWS,
  TERMINAL_FONT_STACK,
  measureTerminalViewport,
  buildTerminalRenderRows,
  buildTerminalRenderFrame,
  buildTerminalGridPadding,
  buildTerminalRenderGeometryRevision,
  buildTerminalViewportDemandWithRepair,
  buildTerminalViewportDemandKey,
  alignTerminalRenderBottomToFollow,
  resolveTerminalFollowAnchorEndIndex,
  computeFollowRealignAfterBufferShift,
  computeTerminalReadingRealignAfterBufferShift,
  reconcileTerminalViewportAfterBufferShift,
  buildTerminalMeasuredViewportState,
  hasTerminalViewportLayoutChanged,
  resolveTerminalWidthModeSignal,
  resolveTerminalResizeCommitPlan,
  hasDiscontinuousNeighbor,
  resolveCursorOverlay,
  resolveScrollTopForRenderBottomIndex as resolveScrollTopForRenderBottomIndexShared,
  resolveTerminalRenderDemandFromScroll,
  isScrollAtBottom,
  resolveFollowScrollSyncTarget,
  consumeFollowResetSignal,
  consumeViewportRefreshSignal,
  createTerminalDomInputController,
  TERMINAL_DRAWER_EDGE_SWIPE_START_PX,
} from "@zterm/shared";
import {
  cancelTerminalFollowScrollRuntime,
  clearTerminalViewportLayoutDriftRuntime,
  commitProgrammaticTerminalScrollRuntime,
  consumeIgnoredProgrammaticScrollRuntime,
  createTerminalFollowScrollState,
  flushTerminalFollowScrollRuntime,
  getTerminalFollowLastSettledScrollTop,
  getTerminalFollowPendingRenderBottomIndex,
  hasTerminalFollowPendingDriftGuard,
  hasTerminalFollowPendingViewportRealign,
  hasTerminalFollowRecentViewportLayoutChange,
  hasTerminalFollowSettledFrame,
  isTerminalFollowScrollReading,
  markTerminalFollowImmediateSyncRuntime,
  markTerminalUserScrollIntent,
  markTerminalViewportLayoutDriftRuntime,
  queueTerminalFollowScrollRuntime,
  resetTerminalFollowScrollRuntime,
  resolveTerminalScrollObservationRuntime,
  type TerminalFollowScrollEffect,
  type TerminalFollowScrollTransition,
} from "../lib/terminal-follow-scroll-runtime";
import { normalizeTerminalCommittedText } from "../lib/terminal-input-normalization";
import { encodeTerminalSgrMouseWheel } from "../lib/terminal-mouse-wheel-sgr";
import {
  COPY_LONG_PRESS_DELAY_MS,
  hasCopyLongPressMovedTooFar,
} from "./terminal/terminal-copy-gesture";
import type {
  SessionRenderBufferSnapshot,
  TerminalResizeHandler,
  TerminalViewportChangeHandler,
  TerminalWidthModeHandler,
  TerminalWidthMode,
} from "../lib/types";
import { SESSION_PREVIEW_RIGHT_EDGE_PX } from "../lib/session-preview-gesture";

import { VisibleRow } from "./terminal/VisibleRow";
import { TerminalPreviewRow } from "./terminal/TerminalPreviewRow";
import {
  useMirrorFixedZoomPan,
  type MirrorFixedWheelStep,
} from "./useMirrorFixedZoomPan";

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
  focusNonce?: number;
  fontSize?: number;
  rowHeight?: string;
  themeId?: string;
  widthMode?: TerminalWidthMode;
  showAbsoluteLineNumbers?: boolean;
  copyModeActive?: boolean;
  copyStartRowIndex?: number | null;
  copyEndRowIndex?: number | null;
  copyPreviewRowIndex?: number | null;
  onLongPressRow?: (
    sessionId: string,
    rowIndex: number,
    clientX: number,
    clientY: number,
  ) => void;
  onCopySelectionDismiss?: () => void;
  splitVisible?: boolean;
  reserveRightEdgeSwipe?: boolean;
  projectionMode?: "terminal" | "preview-primary" | "preview-secondary";
}

function terminalCellToText(
  cell: { char?: number; width?: number } | null | undefined,
) {
  if (!cell || cell.width === 0) {
    return "";
  }
  const codePoint =
    typeof cell.char === "number" && Number.isFinite(cell.char)
      ? cell.char
      : 32;
  return String.fromCodePoint(codePoint);
}

function terminalRowToText(
  row: Array<{ char?: number; width?: number }> | null | undefined,
) {
  if (!Array.isArray(row)) {
    return "";
  }
  return row.map(terminalCellToText).join("").replace(/\s+$/u, "");
}

export function terminalRowRenderSignature(
  row: Array<{
    char?: number;
    fg?: number;
    bg?: number;
    flags?: number;
    width?: number;
  }> | null | undefined,
) {
  if (!Array.isArray(row)) {
    return "";
  }
  // 注意：禁止按「行引用」缓存签名。既有回归契约（bottom-stale）要求
  // 行引用不变但 cell 内容（如 bg）原地变化时也必须反映到签名并重绘；
  // 行引用不可变假设在 mirror 原地 mutate 路径上不成立。签名必须每帧
  // 从真实内容重算（成本远低于 P0 已消除的深拷贝 + 双重全量比较）。
  return row
    .map((cell) =>
      cell
        ? `${cell.char ?? 32}:${cell.fg ?? 256}:${cell.bg ?? 256}:${cell.flags ?? 0}:${cell.width ?? 1}`
        : "32:256:256:0:1",
    )
    .join(";");
}

function isRowInCopySelection(
  rowIndex: number,
  start: number | null | undefined,
  end: number | null | undefined,
) {
  if (start === null || start === undefined) {
    return false;
  }
  const resolvedEnd = end === null || end === undefined ? start : end;
  const from = Math.min(start, resolvedEnd);
  const to = Math.max(start, resolvedEnd);
  return rowIndex >= from && rowIndex <= to;
}

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
  focusNonce = 0,
  fontSize = 14,
  rowHeight = "17px",
  themeId,
  widthMode = "adaptive-phone",
  showAbsoluteLineNumbers = false,
  copyModeActive = false,
  copyStartRowIndex = null,
  copyEndRowIndex = null,
  copyPreviewRowIndex = null,
  onCopySelectionDismiss,
  onLongPressRow,
  splitVisible = false,
  reserveRightEdgeSwipe = false,
  projectionMode = "terminal",
}: TerminalViewProps) {
  const theme = getTerminalThemePreset(themeId);
  const previewProjection = projectionMode !== "terminal";
  const passivePreviewProjection = projectionMode === "preview-secondary";
  const refreshActive = passivePreviewProjection ? false : (live ?? active);
  const sessionBufferSnapshot = useSessionRenderBufferSnapshot(
    sessionBufferStore,
    sessionBufferStore ? sessionId : null,
  );
  const renderBuffer =
    renderBufferSnapshot ||
    (sessionBufferStore && sessionId
      ? sessionBufferSnapshot.buffer
      : EMPTY_RENDER_BUFFER);
  const bufferLines = renderBuffer.lines || [];
  const effectiveBufferEndIndex = Math.max(
    renderBuffer.startIndex,
    Math.floor(
      renderBuffer.endIndex || renderBuffer.startIndex + bufferLines.length,
    ),
  );
  const bufferTailAnchorEndIndex = Math.max(
    renderBuffer.startIndex,
    Math.floor(renderBuffer.bufferTailEndIndex || effectiveBufferEndIndex),
  );
  const mirrorFixedVerticalScrollIntentRef = useRef<() => void>(() => {});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastViewportRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastWidthModeSignalRef = useRef<{
    mode: TerminalWidthMode;
    cols: number | null;
  } | null>(null);
  const resizeCommitTimerRef = useRef<number | null>(null);
  const lastReportedViewportRef = useRef<string>("");
  const followScrollSyncTimerRef = useRef<number | null>(null);
  const recentViewportLayoutChangeTimerRef = useRef<number | null>(null);
  const followScrollStateRef = useRef(createTerminalFollowScrollState());
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const resizeRafTokenRef = useRef<number | null>(null);
  const syncScrollHostToRenderBottomRef = useRef<
    (nextRenderBottomIndex: number) => void
  >(() => {});
  const flushPendingFollowScrollSyncRef = useRef<() => boolean>(() => false);
  const runViewportRefreshRef = useRef<() => void>(() => {});
  const emitRenderDemandRef = useRef<
    (nextMode: "follow" | "reading", nextRenderBottomIndex: number) => void
  >(() => {});
  const queueFollowVisualRealignRef = useRef<
    (options?: {
      guardPendingFollowDrift?: boolean;
      renderBottomIndex?: number;
    }) => void
  >(() => {});
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
  const previousTermGridPaddingTopPxRef = useRef<number | null>(null);
  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [resolvedCellWidthPx, setResolvedCellWidthPx] = useState(
    Math.max(1, fontSize * 0.62),
  );
  const [viewportClientWidthPx, setViewportClientWidthPx] = useState(0);
  const [viewportClientHeightPx, setViewportClientHeightPx] = useState(0);
  const [renderBottomIndex, setRenderBottomIndex] = useState(
    effectiveBufferEndIndex,
  );
  const [readingMode, setReadingMode] = useState(false);
  const followDemandAnchorEndIndex = resolveTerminalFollowAnchorEndIndex({
    bufferStartIndex: renderBuffer.startIndex,
    bufferLines,
    effectiveBufferEndIndex,
    bufferTailEndIndex: bufferTailAnchorEndIndex,
    cursorRowIndex: renderBuffer.cursor?.rowIndex,
    cursorVisible: renderBuffer.cursor?.visible,
    viewportRows,
  });

  const rowHeightPx = Math.max(
    1,
    parseInt(resolvedRowHeight, 10) || parseInt(rowHeight, 10) || 17,
  );
  const maxMirrorFixedHorizontalOffsetPx = Math.max(
    0,
    Math.round((renderBuffer.cols || 0) * resolvedCellWidthPx - viewportClientWidthPx),
  );
  const mirrorFixedMinScale = (() => {
    if (widthMode !== "mirror-fixed") {
      return 1;
    }
    const terminalLogicalWidthPx = Math.max(
      viewportClientWidthPx,
      Math.round((renderBuffer.cols || 0) * resolvedCellWidthPx),
    );
    return viewportClientWidthPx > 0 && terminalLogicalWidthPx > viewportClientWidthPx
      ? viewportClientWidthPx / terminalLogicalWidthPx
      : 1;
  })();
  // 滚动↔行号映射只用原始 rowHeightPx：视觉 scale（transform）不改布局，
  // 原生 scrollTop 坐标系与排版坐标系一致，禁止按缩放后行高另算映射（会分叉）。
  const renderFrame = useMemo(
    () =>
      buildTerminalRenderFrame({
        bufferStartIndex: renderBuffer.startIndex,
        effectiveBufferEndIndex,
        bufferLinesLength: bufferLines.length,
        viewportRows,
        rowHeightPx: rowHeightPx,
        // Secondary previews are passive tail projections. Their visible window
        // must follow the latest buffer revision without starting interactive
        // scroll/follow state or a per-tile viewport demand loop.
        renderBottomIndex: passivePreviewProjection
          ? effectiveBufferEndIndex
          : renderBottomIndex,
        followDemandAnchorEndIndex,
        readingMode,
        overscanRows: OVERSCAN_ROWS,
      }),
    [
      bufferLines.length,
      effectiveBufferEndIndex,
      followDemandAnchorEndIndex,
      passivePreviewProjection,
      readingMode,
      renderBottomIndex,
      renderBuffer.startIndex,
      rowHeightPx,
      viewportRows,
    ],
  );
  const {
    dataRowCount,
    minimumRenderBottomIndex,
    followVisualBottomIndex,
    maximumRenderBottomIndex,
    totalRows,
    maxScrollTop,
    effectiveRenderBottomIndex,
    leadingBlankRows,
    renderStartOffset,
    renderEndOffset,
  } = renderFrame;
  const latestFollowVisualBottomIndexRef = useRef(followVisualBottomIndex);
  latestFollowVisualBottomIndexRef.current = followVisualBottomIndex;
  const renderRows = useMemo(() => {
    return buildTerminalRenderRows({
      bufferLines,
      gapRanges: renderBuffer.gapRanges,
      startIndex: renderBuffer.startIndex,
      leadingBlankRows,
      renderStartOffset,
      renderEndOffset,
    });
  }, [
    bufferLines,
    leadingBlankRows,
    renderEndOffset,
    renderStartOffset,
    renderBuffer.gapRanges,
    renderBuffer.revision,
    renderBuffer.startIndex,
  ]);
  const renderRowsWithSignatures = useMemo(
    () => renderRows.map((renderRow) => ({
      ...renderRow,
      renderSignature: terminalRowRenderSignature(renderRow.row),
    })),
    [renderRows],
  );
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{
    x: number;
    y: number;
    rowIndex: number;
  } | null>(null);
  const cancelCopyLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);
  const startCopyLongPress = useCallback(
    (event: PointerEvent<HTMLDivElement>, rowIndex: number) => {
      if (!copyModeActive || !sessionId || !onLongPressRow) {
        return;
      }
      cancelCopyLongPress();
      longPressStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        rowIndex,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        const start = longPressStartRef.current;
        longPressStartRef.current = null;
        if (!start) {
          return;
        }
        onLongPressRow(sessionId, start.rowIndex, start.x, start.y);
      }, COPY_LONG_PRESS_DELAY_MS);
    },
    [cancelCopyLongPress, copyModeActive, onLongPressRow, sessionId],
  );
  const handleCopyLongPressMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = longPressStartRef.current;
      if (!start) {
        return;
      }
      if (hasCopyLongPressMovedTooFar(start, event.clientX, event.clientY)) {
        cancelCopyLongPress();
      }
    },
    [cancelCopyLongPress],
  );
  const startCopyLongPressTouch = useCallback(
    (event: TouchEvent<HTMLDivElement>, rowIndex: number) => {
      if (!copyModeActive || !sessionId || !onLongPressRow) {
        return;
      }
      cancelCopyLongPress();
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) {
        return;
      }
      longPressStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        rowIndex,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        const start = longPressStartRef.current;
        longPressStartRef.current = null;
        if (!start) {
          return;
        }
        onLongPressRow(sessionId, start.rowIndex, start.x, start.y);
      }, COPY_LONG_PRESS_DELAY_MS);
    },
    [cancelCopyLongPress, copyModeActive, onLongPressRow, sessionId],
  );
  const handleCopyLongPressTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const start = longPressStartRef.current;
      const touch = event.touches[0];
      if (!start || !touch) {
        return;
      }
      if (hasCopyLongPressMovedTooFar(start, touch.clientX, touch.clientY)) {
        cancelCopyLongPress();
      }
    },
    [cancelCopyLongPress],
  );
  /**
   * pointerup/touchend 短按取消：若本次按下未达长按阈值（timer 仍活跃）且
   * 当前已有选择高亮或菜单弹出，则取消整个 copy selection（含菜单）。
   * 长按（timer 已触发并清空）不取消——弹菜单/重新选择语义不变。
   */
  const handleCopyRowPointerUp = useCallback(() => {
    const timerWasActive = longPressTimerRef.current !== null;
    cancelCopyLongPress();
    if (
      timerWasActive &&
      (copyStartRowIndex !== null || copyEndRowIndex !== null || copyPreviewRowIndex !== null) &&
      onCopySelectionDismiss
    ) {
      onCopySelectionDismiss();
    }
  }, [
    cancelCopyLongPress,
    copyEndRowIndex,
    copyPreviewRowIndex,
    copyStartRowIndex,
    onCopySelectionDismiss,
  ]);
  const suppressNativeCopyMenu = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    if (!copyModeActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, [copyModeActive]);
  const { termGridPaddingTopPx, termGridPaddingBottomPx } = useMemo(
    () =>
      buildTerminalGridPadding({
        renderRows,
        rowHeightPx: rowHeightPx,
        totalRows,
      }),
    [renderRows, rowHeightPx, totalRows],
  );
  const renderGeometryRevision = useMemo(
    () =>
      buildTerminalRenderGeometryRevision({
        revision: renderBuffer.revision,
        startIndex: renderBuffer.startIndex,
        effectiveBufferEndIndex,
        followVisualBottomIndex,
        viewportRows,
        rowHeightPx: rowHeightPx,
        renderRowsLength: renderRows.length,
        termGridPaddingTopPx,
        termGridPaddingBottomPx,
      }),
    [
      effectiveBufferEndIndex,
      followVisualBottomIndex,
      renderBuffer.revision,
      renderBuffer.startIndex,
      renderRows.length,
      rowHeightPx,
      termGridPaddingBottomPx,
      termGridPaddingTopPx,
      viewportRows,
    ],
  );
  const renderGeometryRevisionKey = useMemo(
    () => `${sessionId || ""}:${renderGeometryRevision}`,
    [renderGeometryRevision, sessionId],
  );
  const lastAppliedRenderGeometryRevisionKeyRef = useRef<string>("");
  const renderGeometryRevisionRafRef = useRef<number | null>(null);

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

  const onWheelStep = useCallback((step: MirrorFixedWheelStep) => {
    const host = containerRef.current;
    if (!host || !sessionIdRef.current) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const col = Math.max(
      1,
      Math.floor((step.clientX - rect.left) / Math.max(1, resolvedCellWidthPx)) + 1,
    );
    const row = Math.max(
      1,
      Math.floor((step.clientY - rect.top) / Math.max(1, rowHeightPx)) + 1,
    );
    const sequence = encodeTerminalSgrMouseWheel(step.direction, col, row);
    onInputRef.current?.(sessionIdRef.current, sequence);
  }, [resolvedCellWidthPx, rowHeightPx]);

  const mirrorFixedZoomPan = useMirrorFixedZoomPan({
    widthMode,
    copyModeActive,
    previewProjection,
    reserveRightEdgeSwipe,
    rightEdgeReservePx: SESSION_PREVIEW_RIGHT_EDGE_PX,
    drawerEdgeSwipeStartPx: TERMINAL_DRAWER_EDGE_SWIPE_START_PX,
    sessionId,
    minScale: mirrorFixedMinScale,
    maxHorizontalOffsetPx: maxMirrorFixedHorizontalOffsetPx,
    onVerticalScrollIntent: () => {
      mirrorFixedVerticalScrollIntentRef.current();
    },
    onWheelStep,
  });

  const resolveScrollTopForRenderBottomIndex = useCallback(
    (nextRenderBottomIndex: number) => {
      return resolveScrollTopForRenderBottomIndexShared({
        nextRenderBottomIndex,
        totalRows,
        viewportRows,
        bufferStartIndex: renderBuffer.startIndex,
        rowHeightPx: rowHeightPx,
        maxScrollTop,
      });
    },
    [
      maxScrollTop,
      renderBuffer.startIndex,
      rowHeightPx,
      totalRows,
      viewportRows,
    ],
  );

  const resolveRenderDemandFromScroll = useCallback(
    (nextScrollTop: number, host?: HTMLDivElement | null) => {
      const scrollHost = host ?? containerRef.current;
      const clampedScrollTop = Math.max(
        0,
        Math.min(maxScrollTop, nextScrollTop),
      );
      const observedScrollTop = scrollHost
        ? scrollHost.scrollTop
        : clampedScrollTop;
      return resolveTerminalRenderDemandFromScroll({
        nextScrollTop,
        maxScrollTop,
        rowHeightPx: rowHeightPx,
        dataRowCount,
        viewportRows,
        effectiveBufferEndIndex,
        minimumRenderBottomIndex,
        bufferTailAnchorEndIndex,
        bufferStartIndex: renderBuffer.startIndex,
        followVisualBottomIndex,
        observedScrollTop,
        isAtBottom: isScrollAtBottom(
          scrollHost,
          observedScrollTop,
          maxScrollTop,
        ),
        resolveScrollTopForRenderBottomIndex,
      });
    },
    [
      renderBuffer.startIndex,
      dataRowCount,
      effectiveBufferEndIndex,
      followVisualBottomIndex,
      maxScrollTop,
      minimumRenderBottomIndex,
      resolveScrollTopForRenderBottomIndex,
      rowHeightPx,
      viewportRows,
    ],
  );

  const applyFollowScrollTransition = useCallback(
    (transition: TerminalFollowScrollTransition) => {
      followScrollStateRef.current = transition.state;
      transition.effects.forEach((effect: TerminalFollowScrollEffect) => {
        if (effect.type === "schedule-follow-flush") {
          if (followScrollSyncTimerRef.current !== null) {
            return;
          }
          followScrollSyncTimerRef.current = window.setTimeout(() => {
            followScrollSyncTimerRef.current = null;
            flushPendingFollowScrollSyncRef.current();
          }, 0);
          return;
        }
        if (effect.type === "cancel-follow-flush") {
          if (followScrollSyncTimerRef.current !== null) {
            window.clearTimeout(followScrollSyncTimerRef.current);
            followScrollSyncTimerRef.current = null;
          }
          return;
        }
        if (effect.type === "set-scroll-top") {
          const host = containerRef.current;
          if (host && Math.abs(host.scrollTop - effect.scrollTop) > 1) {
            // 视觉缩放只作用于独立渲染层；scrollTop 始终保持原生坐标系（UI shell 不接管）。
            host.scrollTop = effect.scrollTop;
          }
          return;
        }
        if (effect.type === "set-mode") {
          setReadingMode(effect.mode === "reading");
          return;
        }
        if (effect.type === "set-render-bottom-index") {
          setRenderBottomIndex(effect.renderBottomIndex);
          return;
        }
        if (effect.type === "emit-viewport-demand") {
          emitRenderDemandRef.current(effect.mode, effect.renderBottomIndex);
          return;
        }
        if (effect.type === "mark-layout-settling") {
          if (recentViewportLayoutChangeTimerRef.current !== null) {
            window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
          }
          recentViewportLayoutChangeTimerRef.current = window.setTimeout(() => {
            recentViewportLayoutChangeTimerRef.current = null;
            followScrollStateRef.current = clearTerminalViewportLayoutDriftRuntime(
              followScrollStateRef.current,
            ).state;
          }, 0);
          return;
        }
        if (effect.type === "clear-layout-settling") {
          if (recentViewportLayoutChangeTimerRef.current !== null) {
            window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
            recentViewportLayoutChangeTimerRef.current = null;
          }
        }
      });
    },
    [],
  );

  const markFollowViewportRealignOnLayoutDrift = useCallback(
    (viewportLayoutChanged: boolean) => {
      applyFollowScrollTransition(
        markTerminalViewportLayoutDriftRuntime(followScrollStateRef.current, {
          readingMode: isTerminalFollowScrollReading(
            followScrollStateRef.current,
          ),
          viewportLayoutChanged,
          viewportClientHeightPx,
        }),
      );
    },
    [applyFollowScrollTransition, viewportClientHeightPx],
  );

  const commitMeasuredViewportState = useCallback(
    (
      nextViewport: ReturnType<typeof measureTerminalViewport>,
      nextClientHeight: number,
    ) => {
      const nextState = buildTerminalMeasuredViewportState(
        nextViewport,
        nextClientHeight,
      );
      const nextClientWidth = Math.max(
        0,
        Math.round(containerRef.current?.clientWidth || 0),
      );
      setViewportClientWidthPx((current) =>
        current === nextClientWidth ? current : nextClientWidth,
      );
      setViewportClientHeightPx((current) =>
        current === nextState.viewportClientHeightPx
          ? current
          : nextState.viewportClientHeightPx,
      );
      setResolvedRowHeight((current) =>
        current === nextState.resolvedRowHeight
          ? current
          : nextState.resolvedRowHeight,
      );
      setResolvedCellWidthPx((current) =>
        current === nextState.resolvedCellWidthPx
          ? current
          : nextState.resolvedCellWidthPx,
      );
      setViewportRows((current) =>
        current === nextState.viewportRows ? current : nextState.viewportRows,
      );
    },
    [],
  );

  const emitWidthModeSignalIfNeeded = useCallback(
    (nextViewport: ReturnType<typeof measureTerminalViewport>) => {
      const nextSignal = resolveTerminalWidthModeSignal({
        refreshActive,
        sessionId,
        hasWidthModeHandler: Boolean(onWidthModeChange),
        widthMode,
        nextViewport,
        previousWidthSignal: lastWidthModeSignalRef.current,
      });
      if (!nextSignal) {
        return;
      }
      lastWidthModeSignalRef.current = nextSignal;
      onWidthModeChange?.(sessionId!, nextSignal.mode, nextSignal.cols);
    },
    [onWidthModeChange, refreshActive, sessionId, widthMode],
  );

  const scheduleViewportResizeCommit = useCallback(
    (
      nextViewport: ReturnType<typeof measureTerminalViewport>,
      previousViewport: { cols: number; rows: number } | null,
    ) => {
      const plan = resolveTerminalResizeCommitPlan({
        sessionId,
        widthMode,
        previousViewport,
        nextViewport,
      });
      if (plan.action === "skip") {
        return;
      }
      if (resizeCommitTimerRef.current) {
        window.clearTimeout(resizeCommitTimerRef.current);
      }
      if (plan.action === "store-only") {
        lastViewportRef.current = plan.viewport;
        return;
      }

      resizeCommitTimerRef.current = window.setTimeout(() => {
        lastViewportRef.current = plan.viewport;
        onResize?.(sessionId!, plan.viewport.cols, plan.viewport.rows);
        resizeCommitTimerRef.current = null;
      }, 60);
    },
    [onResize, sessionId, widthMode],
  );

  const syncViewport = useCallback(() => {
    const host = containerRef.current;
    if (!host || !refreshActive || !sessionId) {
      return;
    }

    const nextViewport = measureTerminalViewport(host, fontSize, rowHeight);
    const nextClientHeight = Math.max(0, Math.round(host.clientHeight || 0));
    const viewportLayoutChanged = hasTerminalViewportLayoutChanged({
      nextViewport,
      nextClientHeight,
      viewportRows,
      viewportClientHeightPx,
    });

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

  const emitRenderDemand = useCallback(
    (
      nextMode: "follow" | "reading",
      nextRenderBottomIndex: number,
      options?: {
        viewportEndIndex?: number;
      },
    ) => {
      if (!refreshActive || !sessionId || !onViewportChange) {
        return;
      }

      const demand = buildTerminalViewportDemandWithRepair({
        nextMode,
        nextRenderBottomIndex,
        viewportRows,
        bufferStartIndex: renderBuffer.startIndex,
        bufferEndIndex: renderBuffer.endIndex,
        gapRanges: renderBuffer.gapRanges,
        followDemandAnchorEndIndex,
        viewportEndIndexOverride: options?.viewportEndIndex,
      });
      const missingRanges = (demand as { missingRanges?: unknown }).missingRanges;
      const repairFreshnessKey = Array.isArray(missingRanges) && missingRanges.length > 0
        ? `:fresh:${renderBuffer.revision}:${renderBuffer.daemonHeadRevision}:${renderBuffer.startIndex}:${renderBuffer.endIndex}`
        : "";
      const key = `${buildTerminalViewportDemandKey(demand)}${repairFreshnessKey}`;
      if (lastReportedViewportRef.current === key) {
        return;
      }
      lastReportedViewportRef.current = key;
      onViewportChange(sessionId, demand);
    },
    [
      followDemandAnchorEndIndex,
      onViewportChange,
      refreshActive,
      renderBuffer.endIndex,
      renderBuffer.gapRanges,
      renderBuffer.daemonHeadRevision,
      renderBuffer.revision,
      renderBuffer.startIndex,
      sessionId,
      viewportRows,
    ],
  );
  emitRenderDemandRef.current = emitRenderDemand;

  const applyScrollState = useCallback(
    (nextScrollTop: number, host?: HTMLDivElement | null) => {
      const { nextMode, nextRenderBottomIndex } = resolveRenderDemandFromScroll(
        nextScrollTop,
        host,
      );
      const scrollHost = host ?? containerRef.current;
      const observedScrollTop = scrollHost
        ? Math.max(0, scrollHost.scrollTop)
        : Math.max(0, nextScrollTop);
      const upwardAwayFromSettledBottom =
        observedScrollTop < getTerminalFollowLastSettledScrollTop(
          followScrollStateRef.current,
        ) - 1;
      applyFollowScrollTransition(
        resolveTerminalScrollObservationRuntime(followScrollStateRef.current, {
          nextMode,
          nextRenderBottomIndex,
          observedScrollTop,
          now: Date.now(),
          upwardAwayFromSettledBottom,
        }),
      );
    },
    [applyFollowScrollTransition, resolveRenderDemandFromScroll],
  );

  const syncScrollHostToRenderBottom = useCallback(
    (nextRenderBottomIndex: number) => {
      const host = containerRef.current;
      if (!host) {
        applyFollowScrollTransition(
          cancelTerminalFollowScrollRuntime(followScrollStateRef.current),
        );
        return;
      }

      const nextTarget = resolveFollowScrollSyncTarget(
        host,
        nextRenderBottomIndex,
        resolveScrollTopForRenderBottomIndex,
      );
      applyFollowScrollTransition(
        commitProgrammaticTerminalScrollRuntime(
          followScrollStateRef.current,
          nextTarget,
        ),
      );
    },
    [applyFollowScrollTransition, resolveScrollTopForRenderBottomIndex],
  );
  syncScrollHostToRenderBottomRef.current = syncScrollHostToRenderBottom;

  const queueFollowScrollSync = useCallback(
    (
      nextRenderBottomIndex: number,
      options?: {
        guardPendingFollowDrift?: boolean;
      },
    ) => {
      applyFollowScrollTransition(
        queueTerminalFollowScrollRuntime(followScrollStateRef.current, {
          renderBottomIndex: nextRenderBottomIndex,
          minimumRenderBottomIndex,
          guardPendingFollowDrift: options?.guardPendingFollowDrift,
        }),
      );
    },
    [applyFollowScrollTransition, minimumRenderBottomIndex],
  );

  const cancelPendingFollowScrollSync = useCallback(() => {
    applyFollowScrollTransition(
      cancelTerminalFollowScrollRuntime(followScrollStateRef.current),
    );
  }, [applyFollowScrollTransition]);

  const queueFollowVisualRealign = useCallback(
    (options?: {
      guardPendingFollowDrift?: boolean;
      renderBottomIndex?: number;
    }) => {
      queueFollowScrollSync(
        options?.renderBottomIndex ?? followVisualBottomIndex,
        {
          guardPendingFollowDrift: options?.guardPendingFollowDrift,
        },
      );
    },
    [followVisualBottomIndex, queueFollowScrollSync],
  );
  queueFollowVisualRealignRef.current = queueFollowVisualRealign;

  const flushPendingFollowScrollSync = useCallback(() => {
    const transition = flushTerminalFollowScrollRuntime(
      followScrollStateRef.current,
      {
        refreshActive,
        readingMode: isTerminalFollowScrollReading(followScrollStateRef.current),
        followVisualBottomIndex,
        resolveScrollTop: (nextRenderBottomIndex) => {
          const host = containerRef.current;
          if (!host) {
            return resolveScrollTopForRenderBottomIndex(nextRenderBottomIndex);
          }
          return resolveFollowScrollSyncTarget(
            host,
            nextRenderBottomIndex,
            resolveScrollTopForRenderBottomIndex,
          );
        },
      },
    );
    applyFollowScrollTransition(transition);
    return transition.effects.some((effect) => effect.type === "set-scroll-top");
  }, [
    applyFollowScrollTransition,
    followVisualBottomIndex,
    refreshActive,
    resolveScrollTopForRenderBottomIndex,
  ]);
  flushPendingFollowScrollSyncRef.current = flushPendingFollowScrollSync;

  const markUserScrollIntentRuntime = useCallback(
    (durationMs: number) => {
      applyFollowScrollTransition(markTerminalUserScrollIntent(
        followScrollStateRef.current,
        Date.now(),
        durationMs,
      ));
    },
    [applyFollowScrollTransition],
  );
  mirrorFixedVerticalScrollIntentRef.current = () => markUserScrollIntentRuntime(300);

  const syncFollowScrollToAnchor = useCallback(() => {
    if (!refreshActive || isTerminalFollowScrollReading(followScrollStateRef.current)) {
      return false;
    }
    syncScrollHostToRenderBottom(followVisualBottomIndex);
    return true;
  }, [followVisualBottomIndex, refreshActive, syncScrollHostToRenderBottom]);

  const handleFollowModeScrollGuards = useCallback(
    (host: HTMLDivElement) => {
      const state = followScrollStateRef.current;
      if (isTerminalFollowScrollReading(state)) {
        return false;
      }

      if (hasTerminalFollowRecentViewportLayoutChange(state)) {
        applyFollowScrollTransition(clearTerminalViewportLayoutDriftRuntime(state));
        queueFollowVisualRealign({ guardPendingFollowDrift: true });
        return true;
      }

      const pendingRenderBottomIndex =
        getTerminalFollowPendingRenderBottomIndex(state);
      if (
        hasTerminalFollowPendingDriftGuard(state)
        && pendingRenderBottomIndex !== null
      ) {
        queueFollowVisualRealign({
          renderBottomIndex: pendingRenderBottomIndex,
          guardPendingFollowDrift: true,
        });
        return true;
      }

      if (hasTerminalFollowPendingViewportRealign(state)) {
        queueFollowVisualRealign({ guardPendingFollowDrift: true });
        return true;
      }

      if (hasTerminalFollowPendingDriftGuard(state)) {
        const scrollTopUnchanged =
          Math.abs(host.scrollTop - getTerminalFollowLastSettledScrollTop(state)) <= 1;
        if (scrollTopUnchanged) {
          return true;
        }
        cancelPendingFollowScrollSync();
        return false;
      }

      const consumed = consumeIgnoredProgrammaticScrollRuntime(
        state,
        host.scrollTop,
      );
      if (consumed.consumed) {
        followScrollStateRef.current = consumed.state;
        return true;
      }

      const observedScrollTop = Math.max(0, host.scrollTop);
      const upwardAwayFromSettledBottom =
        observedScrollTop < getTerminalFollowLastSettledScrollTop(state) - 1;
      const stillAtBottom = isScrollAtBottom(host, observedScrollTop, maxScrollTop);
      if (!upwardAwayFromSettledBottom && !stillAtBottom) {
        queueFollowVisualRealign({
          guardPendingFollowDrift: true,
        });
        return true;
      }

      return false;
    },
    [
      applyFollowScrollTransition,
      cancelPendingFollowScrollSync,
      maxScrollTop,
      queueFollowVisualRealign,
    ],
  );

  const resetFollowViewportReport = useCallback(() => {
    lastReportedViewportRef.current = "";
  }, []);

  const setFollowModeState = useCallback((nextRenderBottomIndex: number) => {
    followScrollStateRef.current = createTerminalFollowScrollState({
      lastSettledScrollTop: getTerminalFollowLastSettledScrollTop(
        followScrollStateRef.current,
      ),
      hasSettledFollowFrame: hasTerminalFollowSettledFrame(
        followScrollStateRef.current,
      ),
    });
    setReadingMode(false);
    setRenderBottomIndex(nextRenderBottomIndex);
  }, []);

  const scheduleFollowScrollRealign = useCallback(
    (
      nextRenderBottomIndex: number,
      options?: {
        guardPendingFollowDrift?: boolean;
        queueScrollSync?: boolean;
        immediateScrollSync?: boolean;
      },
    ) => {
      if (options?.immediateScrollSync) {
        applyFollowScrollTransition(
          markTerminalFollowImmediateSyncRuntime(followScrollStateRef.current),
        );
      }
      if (options?.queueScrollSync === false) {
        return;
      }
      queueFollowVisualRealign({
        renderBottomIndex: nextRenderBottomIndex,
        guardPendingFollowDrift: options?.guardPendingFollowDrift,
      });
    },
    [applyFollowScrollTransition, queueFollowVisualRealign],
  );

  const emitFollowViewportDemand = useCallback(
    (nextRenderBottomIndex: number) => {
      emitRenderDemand("follow", nextRenderBottomIndex);
    },
    [emitRenderDemand],
  );

  const alignRenderBottomToFollow = useCallback(
    (options?: {
      resetReportedViewport?: boolean;
      guardPendingFollowDrift?: boolean;
      queueScrollSync?: boolean;
      immediateScrollSync?: boolean;
    }) => {
      return alignTerminalRenderBottomToFollow({
        followVisualBottomIndex,
        resetReportedViewport: options?.resetReportedViewport,
        guardPendingFollowDrift: options?.guardPendingFollowDrift,
        queueScrollSync: options?.queueScrollSync,
        immediateScrollSync: options?.immediateScrollSync,
        resetFollowViewportReport,
        setFollowModeState,
        scheduleFollowScrollRealign,
        emitFollowViewportDemand,
      });
    },
    [
      emitFollowViewportDemand,
      followVisualBottomIndex,
      resetFollowViewportReport,
      scheduleFollowScrollRealign,
      setFollowModeState,
    ],
  );

  const emitCurrentRenderDemand = useCallback(() => {
    const nextMode: "follow" | "reading" = isTerminalFollowScrollReading(
      followScrollStateRef.current,
    )
      ? "reading"
      : "follow";
    emitRenderDemand(
      nextMode,
      nextMode === "follow"
        ? followVisualBottomIndex
        : effectiveRenderBottomIndex,
    );
  }, [effectiveRenderBottomIndex, emitRenderDemand, followVisualBottomIndex]);

  const emitReadingRenderDemand = useCallback(
    (nextRenderBottomIndex?: number) => {
      emitRenderDemand(
        "reading",
        nextRenderBottomIndex ?? effectiveRenderBottomIndex,
      );
    },
    [effectiveRenderBottomIndex, emitRenderDemand],
  );

  const reconcileViewportAfterBufferShift = useCallback(() => {
    reconcileTerminalViewportAfterBufferShift({
      refreshActive,
      readingMode: isTerminalFollowScrollReading(followScrollStateRef.current),
      hasSettledFollowFrame: hasTerminalFollowSettledFrame(
        followScrollStateRef.current,
      ),
      effectiveRenderBottomIndex,
      followVisualBottomIndex,
      minimumRenderBottomIndex,
      maximumRenderBottomIndex,
      maxScrollTop,
      alignRenderBottomToFollow,
      setRenderBottomIndex,
      emitReadingRenderDemand,
    });
  }, [
    alignRenderBottomToFollow,
    effectiveRenderBottomIndex,
    emitReadingRenderDemand,
    followVisualBottomIndex,
    maxScrollTop,
    maximumRenderBottomIndex,
    minimumRenderBottomIndex,
    refreshActive,
  ]);

  const emitRenderDemandSignalsForCurrentFrame = useCallback(() => {
    emitCurrentRenderDemand();
  }, [emitCurrentRenderDemand]);

  const runViewportRefresh = useCallback(() => {
    syncViewport();
  }, [syncViewport]);
  runViewportRefreshRef.current = runViewportRefresh;

  const consumeFollowResetTrigger = useCallback(
    () =>
      consumeFollowResetSignal({
        refreshActive,
        wasActiveRef,
        previousInputResetEpochRef,
        previousFollowResetEpochRef,
        inputResetEpoch,
        followResetEpoch,
      }),
    [followResetEpoch, inputResetEpoch, refreshActive],
  );

  const consumeViewportRefreshTrigger = useCallback(
    () =>
      consumeViewportRefreshSignal({
        refreshActive,
        previousRefreshActiveRef,
        previousRefreshSessionIdRef,
        sessionId,
      }),
    [refreshActive, sessionId],
  );

  useLayoutEffect(() => {
    if (previousSessionIdRef.current === sessionId) {
      return;
    }
    previousSessionIdRef.current = sessionId;
    applyFollowScrollTransition(resetTerminalFollowScrollRuntime(
      followScrollStateRef.current,
      {
        followVisualBottomIndex,
        minimumRenderBottomIndex,
        immediate: true,
      },
    ));
    lastReportedViewportRef.current = "";
    previousRefreshSessionIdRef.current = sessionId;
    previousInputResetEpochRef.current = inputResetEpoch;
    previousFollowResetEpochRef.current = followResetEpoch;
    previousTermGridPaddingTopPxRef.current = null;
  }, [
    applyFollowScrollTransition,
    followResetEpoch,
    followVisualBottomIndex,
    inputResetEpoch,
    minimumRenderBottomIndex,
    sessionId,
  ]);

  useLayoutEffect(() => {
    if (!passivePreviewProjection || renderBottomIndex === followVisualBottomIndex) {
      return;
    }
    setRenderBottomIndex(followVisualBottomIndex);
  }, [followVisualBottomIndex, passivePreviewProjection, renderBottomIndex]);

  useLayoutEffect(() => {
    if (!consumeFollowResetTrigger()) {
      return;
    }
    alignRenderBottomToFollow({
      resetReportedViewport: true,
      immediateScrollSync: true,
    });
  }, [alignRenderBottomToFollow, consumeFollowResetTrigger]);

  useEffect(() => {
    if (!consumeViewportRefreshTrigger()) {
      return;
    }
    runViewportRefresh();
  }, [consumeViewportRefreshTrigger, runViewportRefresh]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !copyModeActive) {
      return;
    }
    const suppressNativeMenu = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const options: AddEventListenerOptions = { capture: true, passive: false };
    host.addEventListener('contextmenu', suppressNativeMenu, options);
    host.addEventListener('selectstart', suppressNativeMenu, options);
    return () => {
      host.removeEventListener('contextmenu', suppressNativeMenu, options);
      host.removeEventListener('selectstart', suppressNativeMenu, options);
    };
  }, [copyModeActive]);

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
    sessionId,
    viewportRows,
  ]);

  useLayoutEffect(() => {
    const didFlush = flushPendingFollowScrollSync();
    const host = containerRef.current;
    const readingRealignAfterBufferShift = computeTerminalReadingRealignAfterBufferShift({
      refreshActive,
      readingMode: isTerminalFollowScrollReading(followScrollStateRef.current),
      previousPaddingTopPx: previousTermGridPaddingTopPxRef.current,
      nextPaddingTopPx: termGridPaddingTopPx,
      viewportClientHeightPx: viewportClientHeightPx || host?.clientHeight || 0,
    });
    const followRealignAfterBufferShift = computeFollowRealignAfterBufferShift({
      refreshActive,
      readingMode: isTerminalFollowScrollReading(followScrollStateRef.current),
      previousPaddingTopPx: previousTermGridPaddingTopPxRef.current,
      nextPaddingTopPx: termGridPaddingTopPx,
      viewportClientHeightPx: viewportClientHeightPx || host?.clientHeight || 0,
      maxScrollTop,
    });
    previousTermGridPaddingTopPxRef.current = termGridPaddingTopPx;
    if (readingRealignAfterBufferShift.needsReadingRealign && host) {
      host.scrollTop = resolveScrollTopForRenderBottomIndex(effectiveRenderBottomIndex);
      applyScrollState(host.scrollTop, host);
      return;
    }
    if (followRealignAfterBufferShift.needsImmediateRealign) {
      applyFollowScrollTransition(
        commitProgrammaticTerminalScrollRuntime(
          followScrollStateRef.current,
          followRealignAfterBufferShift.targetScrollTop,
        ),
      );
      return;
    }
    if (
      !didFlush
      && refreshActive
      && !isTerminalFollowScrollReading(followScrollStateRef.current)
      && !hasTerminalFollowSettledFrame(followScrollStateRef.current)
    ) {
      window.queueMicrotask(() => {
        if (
          !refreshActive
          || isTerminalFollowScrollReading(followScrollStateRef.current)
          || latestFollowVisualBottomIndexRef.current !== followVisualBottomIndex
          || getTerminalFollowPendingRenderBottomIndex(followScrollStateRef.current) !== null
          || hasTerminalFollowPendingViewportRealign(followScrollStateRef.current)
          || hasTerminalFollowPendingDriftGuard(followScrollStateRef.current)
        ) {
          return;
        }
        applyFollowScrollTransition(
          commitProgrammaticTerminalScrollRuntime(
            followScrollStateRef.current,
            maxScrollTop,
          ),
        );
      });
    }
  }, [
    applyScrollState,
    effectiveBufferEndIndex,
    effectiveRenderBottomIndex,
    applyFollowScrollTransition,
    followVisualBottomIndex,
    flushPendingFollowScrollSync,
    maxScrollTop,
    refreshActive,
    renderBuffer.revision,
    renderBuffer.startIndex,
    rowHeightPx,
    resolveScrollTopForRenderBottomIndex,
    termGridPaddingTopPx,
    viewportClientHeightPx,
    viewportRows,
  ]);

  useLayoutEffect(() => {
    if (!refreshActive || isTerminalFollowScrollReading(followScrollStateRef.current)) {
      return;
    }
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const observedScrollTop = Math.max(0, host.scrollTop);
    const domBottomScrollTop = Math.max(
      0,
      host.scrollHeight - host.clientHeight,
    );
    const overscrolledBlankFrame = observedScrollTop > domBottomScrollTop + 1;
    const pendingViewportRealign = hasTerminalFollowPendingViewportRealign(
      followScrollStateRef.current,
    );

    if (!overscrolledBlankFrame && !pendingViewportRealign) {
      return;
    }

    syncScrollHostToRenderBottom(followVisualBottomIndex);
  });

  useEffect(() => {
    const previousMetrics = previousFollowViewportMetricsRef.current;
    previousFollowViewportMetricsRef.current = {
      viewportRows,
      rowHeightPx: rowHeightPx,
      clientHeightPx: viewportClientHeightPx,
    };

    if (!refreshActive || isTerminalFollowScrollReading(followScrollStateRef.current)) {
      return;
    }

    if (
      !previousMetrics ||
      (previousMetrics.viewportRows === viewportRows &&
        previousMetrics.rowHeightPx === rowHeightPx &&
        previousMetrics.clientHeightPx === viewportClientHeightPx)
    ) {
      return;
    }

    syncFollowScrollToAnchor();
  }, [
    rowHeightPx,
    syncFollowScrollToAnchor,
    viewportClientHeightPx,
    viewportRows,
  ]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    runViewportRefreshRef.current();
    const scheduleResizeRefresh = () => {
      if (resizeRafTokenRef.current !== null || resizeThrottleTimerRef.current !== null) {
        return;
      }
      const scheduleFrame = () => {
        resizeRafTokenRef.current = window.requestAnimationFrame(() => {
          resizeRafTokenRef.current = null;
          runViewportRefreshRef.current();
        });
      };
      if (splitVisible) {
        resizeThrottleTimerRef.current = window.setTimeout(() => {
          resizeThrottleTimerRef.current = null;
          scheduleFrame();
        }, 32);
        return;
      }
      scheduleFrame();
    };
    const observer = new ResizeObserver(() => {
      scheduleResizeRefresh();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (resizeThrottleTimerRef.current !== null) {
        window.clearTimeout(resizeThrottleTimerRef.current);
        resizeThrottleTimerRef.current = null;
      }
      if (resizeRafTokenRef.current !== null) {
        window.cancelAnimationFrame(resizeRafTokenRef.current);
        resizeRafTokenRef.current = null;
      }
    };
  }, [splitVisible]);

  useEffect(() => {
    if (!refreshActive) {
      return;
    }
    if (renderGeometryRevisionRafRef.current !== null) {
      return;
    }
    renderGeometryRevisionRafRef.current = window.requestAnimationFrame(() => {
      renderGeometryRevisionRafRef.current = null;
      if (lastAppliedRenderGeometryRevisionKeyRef.current === renderGeometryRevisionKey) {
        return;
      }
      lastAppliedRenderGeometryRevisionKeyRef.current = renderGeometryRevisionKey;
      if (!refreshActive || isTerminalFollowScrollReading(followScrollStateRef.current)) {
        return;
      }
      syncScrollHostToRenderBottom(followVisualBottomIndex);
      emitRenderDemandSignalsForCurrentFrame();
    });
    return () => {
      if (renderGeometryRevisionRafRef.current !== null) {
        window.cancelAnimationFrame(renderGeometryRevisionRafRef.current);
        renderGeometryRevisionRafRef.current = null;
      }
    };
  }, [
    emitRenderDemandSignalsForCurrentFrame,
    followVisualBottomIndex,
    refreshActive,
    refreshActive,
    renderGeometryRevisionKey,
    syncScrollHostToRenderBottom,
  ]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.disabled = !allowDomFocus;
    input.readOnly = !allowDomFocus;
    input.tabIndex = allowDomFocus ? 0 : -1;
    input.style.pointerEvents =
      allowDomFocus && !domInputOffscreen ? "auto" : "none";
    input.style.opacity = domInputOffscreen ? "0" : "0.01";
    input.style.width = domInputOffscreen ? "1px" : "140px";
    input.style.height = domInputOffscreen ? "1px" : "36px";
    input.style.left = domInputOffscreen ? "-9999px" : "50%";
    input.style.bottom = domInputOffscreen ? "auto" : "12px";
    input.style.top = domInputOffscreen ? "0" : "auto";
    input.style.transform = domInputOffscreen ? "none" : "translateX(-50%)";
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
      normalizeCommittedText: normalizeTerminalCommittedText,
    });

    input.addEventListener(
      "compositionstart",
      domInputController.handleCompositionStart,
    );
    input.addEventListener(
      "compositionend",
      domInputController.handleCompositionEnd,
    );
    input.addEventListener("beforeinput", domInputController.handleBeforeInput);
    input.addEventListener("input", domInputController.handleInput);
    input.addEventListener("change", domInputController.handleChange);
    input.addEventListener("keydown", domInputController.handleKeyDown);

    return () => {
      domInputController.clearScheduledFlush();
      input.removeEventListener(
        "compositionstart",
        domInputController.handleCompositionStart,
      );
      input.removeEventListener(
        "compositionend",
        domInputController.handleCompositionEnd,
      );
      input.removeEventListener(
        "beforeinput",
        domInputController.handleBeforeInput,
      );
      input.removeEventListener("input", domInputController.handleInput);
      input.removeEventListener("change", domInputController.handleChange);
      input.removeEventListener("keydown", domInputController.handleKeyDown);
    };
  }, [allowDomFocus]);

  useEffect(() => {
    if (!active || !allowDomFocus) {
      return;
    }
    focusTerminal();
  }, [active, allowDomFocus, focusNonce, focusTerminal]);

  useEffect(
    () => () => {
      cancelPendingFollowScrollSync();
      if (resizeCommitTimerRef.current) {
        window.clearTimeout(resizeCommitTimerRef.current);
        resizeCommitTimerRef.current = null;
      }
    },
    [cancelPendingFollowScrollSync],
  );

  return (
    <div
      ref={containerRef}
      className="wterm"
      data-terminal-session-id={sessionId || undefined}
      data-testid={sessionId ? `terminal-view-${sessionId}` : undefined}
      data-active={active ? "true" : "false"}
      data-has-oninput={onInput ? "true" : "false"}
      data-has-onresize={onResize ? "true" : "false"}
      data-width-mode={widthMode}
      data-projection-mode={projectionMode}
      data-copy-mode={copyModeActive ? "true" : undefined}
      onClick={() => {
        if (!sessionId) {
          return;
        }
        if (previewProjection) {
          return;
        }
        alignRenderBottomToFollow({
          resetReportedViewport: true,
          immediateScrollSync: true,
        });
        if (allowDomFocus) {
          focusTerminal();
          return;
        }
        onActivateInput?.(sessionId);
      }}
      onContextMenu={suppressNativeCopyMenu}
      onScroll={(event) => {
        const host = event.currentTarget as HTMLDivElement;
        if (handleFollowModeScrollGuards(host)) {
          return;
        }
        applyScrollState(host.scrollTop, host);
      }}
      onTouchMove={mirrorFixedZoomPan.onTouchMove}
      onTouchStart={mirrorFixedZoomPan.onTouchStart}
      onTouchEnd={mirrorFixedZoomPan.onTouchEnd}
      onTouchCancel={mirrorFixedZoomPan.onTouchEnd}
      onWheel={() => {
        markUserScrollIntentRuntime(250);
      }}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        backgroundColor: theme.background,
        overflowY: "auto",
        overflowX: "hidden",
        scrollbarWidth: "none",
        overscrollBehavior: "contain",
        touchAction:
          widthMode === "mirror-fixed" && !copyModeActive
            ? "pan-y"
            : copyModeActive
              ? "pan-y"
              : "auto",
        userSelect: copyModeActive ? "none" : undefined,
        WebkitUserSelect: copyModeActive ? "none" : undefined,
        padding: "0",
        borderRadius: "0",
        boxShadow: "none",
        ["--term-font-family" as string]: TERMINAL_FONT_STACK,
        ["--term-font-size" as string]: `${fontSize}px`,
        ["--term-row-height" as string]: resolvedRowHeight || rowHeight,
        fontFamily: TERMINAL_FONT_STACK,
        fontSize: `${fontSize}px`,
        WebkitTextSizeAdjust: previewProjection ? "none" : undefined,
        textSizeAdjust: previewProjection ? "none" : undefined,
      }}
    >
      <div className="term-render-scale-layer" ref={mirrorFixedZoomPan.scaleLayerRef}>
        <div
          className="term-grid"
          data-cursor-source="cursor-metadata"
          data-horizontal-offset-px={
            widthMode === "mirror-fixed"
              ? String(mirrorFixedZoomPan.horizontalOffsetPx)
              : undefined
          }
          onContextMenu={suppressNativeCopyMenu}
          style={{
            paddingTop: `${termGridPaddingTopPx}px`,
            paddingBottom: `${termGridPaddingBottomPx}px`,
            minWidth:
              widthMode === "mirror-fixed"
                ? `${Math.max(
                    viewportClientWidthPx,
                    Math.round((renderBuffer.cols || 0) * resolvedCellWidthPx),
                  )}px`
                : undefined,
            transform:
              widthMode === "mirror-fixed" && mirrorFixedZoomPan.horizontalOffsetPx > 0
                ? `translateX(-${mirrorFixedZoomPan.horizontalOffsetPx}px)`
                : undefined,
            willChange:
              widthMode === "mirror-fixed" && mirrorFixedZoomPan.horizontalOffsetPx > 0
                ? "transform"
                : undefined,
          }}
      >
        {passivePreviewProjection
          ? renderRowsWithSignatures.map(({ absoluteIndex, row, isGap }) => {
              const plainText = terminalRowToText(row);
              return (
                <TerminalPreviewRow
                  key={`preview-row-${absoluteIndex}`}
                  absoluteIndex={absoluteIndex}
                  row={row}
                  isGap={isGap}
                  rowHeight={resolvedRowHeight || rowHeight}
                  cellWidthPx={resolvedCellWidthPx}
                  theme={theme}
                  plainText={plainText}
                />
              );
            })
          : renderRowsWithSignatures.map(({ absoluteIndex, row, isGap, renderSignature }, rowIndex) =>
            (() => {
            const cursorOverlay = resolveCursorOverlay({
              row,
              cursor: renderBuffer.cursor,
              absoluteIndex,
            });
            return (
              <VisibleRow
                key={`row-${absoluteIndex}`}
                absoluteIndex={absoluteIndex}
                renderSignature={renderSignature}
                row={row}
                rowIndex={rowIndex}
                rowHeight={resolvedRowHeight || rowHeight}
                cellWidthPx={resolvedCellWidthPx}
                isGap={isGap}
                theme={theme}
                cursorColumn={cursorOverlay.cursorColumn}
                showAbsoluteLineNumbers={showAbsoluteLineNumbers}
                discontinuousLineNumber={
                  isGap || hasDiscontinuousNeighbor(renderRows, rowIndex)
                }
                rowHighlightStyle={
                  absoluteIndex === copyPreviewRowIndex ||
                  isRowInCopySelection(
                    absoluteIndex,
                    copyStartRowIndex,
                    copyEndRowIndex,
                  )
                    ? {
                        backgroundColor: "rgba(83, 139, 255, 0.18)",
                        outline: "1px solid rgba(83, 139, 255, 0.34)",
                        outlineOffset: "-1px",
                      }
                    : undefined
                }
                copyModeActive={copyModeActive}
                plainText={terminalRowToText(row)}
                onPointerDown={
                  copyModeActive
                    ? (event) => startCopyLongPress(event, absoluteIndex)
                    : undefined
                }
                onTouchStart={
                  copyModeActive
                    ? (event) => startCopyLongPressTouch(event, absoluteIndex)
                    : undefined
                }
                onPointerMove={
                  copyModeActive ? handleCopyLongPressMove : undefined
                }
                onTouchMove={
                  copyModeActive ? handleCopyLongPressTouchMove : undefined
                }
                onPointerUp={copyModeActive ? handleCopyRowPointerUp : undefined}
                onTouchEnd={copyModeActive ? handleCopyRowPointerUp : undefined}
                onPointerCancel={
                  copyModeActive ? cancelCopyLongPress : undefined
                }
                onTouchCancel={copyModeActive ? cancelCopyLongPress : undefined}
              />
            );
          })(),
          )}
      </div>
      {!previewProjection ? (
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
          aria-hidden={domInputOffscreen ? "true" : undefined}
          style={{
            position: "absolute",
            left: "-9999px",
            top: 0,
            opacity: 0,
            width: "1px",
            height: "1px",
            border: "0",
            padding: 0,
            resize: "none",
            background: "transparent",
            color: "transparent",
            caretColor: "transparent",
          }}
        />
      ) : null}
      </div>
      <style>{`@keyframes zterm-history-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.wterm::-webkit-scrollbar{display:none;width:0;height:0}.wterm[data-copy-mode="true"],.wterm[data-copy-mode="true"] [data-terminal-row="true"]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}`}</style>
    </div>
  );
}
export const TerminalView = memo(TerminalViewComponent);
TerminalView.displayName = "TerminalView";
