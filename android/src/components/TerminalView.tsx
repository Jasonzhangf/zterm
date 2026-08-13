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
  TERMINAL_DRAWER_EDGE_SWIPE_START_PX,
  TERMINAL_FONT_STACK,
  measureTerminalViewport,
  buildTerminalRenderRows,
  buildTerminalRenderFrame,
  buildTerminalGridPadding,
  buildTerminalRenderGeometryRevision,
  buildTerminalViewportDemandWithRepair,
  buildTerminalViewportDemandKey,
  alignTerminalRenderBottomToFollow,
  computeFollowRealignAfterBufferShift,
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
  setTwoFingerWheelDebugSnapshot,
  type TwoFingerWheelDebugSnapshot,
} from "../lib/two-finger-wheel-debug-store";
import {
  decideTwoFingerWheel,
  DEFAULT_TWO_FINGER_WHEEL_CONFIG,
} from "../lib/two-finger-wheel-decision";
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
import { useMirrorFixedZoomPan } from "./useMirrorFixedZoomPan";

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

const MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY =
  "zterm:terminal:mirror-fixed-horizontal-offsets";
const HORIZONTAL_PAN_LOCK_PX = 8;

function clampHorizontalOffset(offsetPx: number, maxOffsetPx: number) {
  if (!Number.isFinite(offsetPx)) {
    return 0;
  }
  return Math.max(0, Math.min(maxOffsetPx, Math.round(offsetPx)));
}

function readStoredHorizontalOffset(sessionId: string | null) {
  if (!sessionId || typeof localStorage === "undefined") {
    return 0;
  }
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY) || "{}",
    );
    const value =
      parsed && typeof parsed === "object"
        ? Number((parsed as Record<string, unknown>)[sessionId])
        : 0;
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  } catch {
    return 0;
  }
}

function writeStoredHorizontalOffset(sessionId: string | null, offsetPx: number) {
  if (!sessionId || typeof localStorage === "undefined") {
    return;
  }
  try {
    const parsed = JSON.parse(
      localStorage.getItem(MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY) || "{}",
    );
    const next =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    next[sessionId] = clampHorizontalOffset(offsetPx, Number.MAX_SAFE_INTEGER);
    localStorage.setItem(
      MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    localStorage.setItem(
      MIRROR_FIXED_HORIZONTAL_OFFSET_STORAGE_KEY,
      JSON.stringify({
        [sessionId]: clampHorizontalOffset(offsetPx, Number.MAX_SAFE_INTEGER),
      }),
    );
  }
}

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
  const followDemandAnchorEndIndex = bufferTailAnchorEndIndex;
  const mirrorFixedZoomPan = useMirrorFixedZoomPan({
    widthMode,
    copyModeActive,
    reserveRightEdgeSwipe,
    sessionId,
    readHorizontalOffset: () => mirrorFixedHorizontalOffsetRef.current,
    onHorizontalOffsetChange: (offsetPx) => {
      mirrorFixedHorizontalOffsetRef.current = offsetPx;
      setMirrorFixedHorizontalOffsetPx((current) =>
        current === offsetPx ? current : offsetPx,
      );
    },
  });
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
  const horizontalPanRef = useRef<{
    active: boolean;
    axis: "horizontal" | "vertical" | null;
    startX: number;
    startY: number;
    startOffsetPx: number;
    consumedHorizontal: boolean;
    consumedVertical: boolean;
  }>({
    active: false,
    axis: null,
    startX: 0,
    startY: 0,
    startOffsetPx: 0,
    consumedHorizontal: false,
    consumedVertical: false,
  });
  const [mirrorFixedHorizontalOffsetPx, setMirrorFixedHorizontalOffsetPx] =
    useState(0);
  const mirrorFixedHorizontalOffsetRef = useRef(0);
  /** pinch 前 scrollTop 快照（缩放态清零后用 v 平移补偿，还原时写回） */
  /** mirror-fixed 视觉缩放只属于 UI shell（useMirrorFixedZoomPan）：只写
   *  .term-render-scale-layer 的 transform: scale，不改变 buffer 几何、行号映射、
   *  scrollTop 或 touchAction。此处只保留一个 mirrorFixedScaleRef 给旧手势调用点
   *  （两指 wheel 方向判定）做只读同步，不再写 gridEl.style.zoom / touchAction。 */
  const mirrorFixedScaleRef = useRef(1);
  const mirrorFixedMinScaleRef = useRef(1);
  const pinchRef = useRef<{ startSpan: number; startScale: number } | null>(null);
  const gridElRef = useRef<HTMLDivElement | null>(null);
  /** 旧两指手势调用点转发：视觉层 transform 由 hook 独占写入 */
  const applyPinchScale = useCallback((next: number) => {
    mirrorFixedScaleRef.current = next;
    mirrorFixedZoomPan.applyVisualScale(next);
  }, [mirrorFixedZoomPan]);

  /** 计算本次 pinch 的目标 scale：clamp 到 [minScale, 1]；接近上限 1 时渐进（每 move ≤ 0.08），
   *  避免 zoom 从缩小状态直接跳到 1 造成布局重排闪屏 */
  const computeNextPinchScale = useCallback((ratio: number) => {
    const current = mirrorFixedScaleRef.current;
    const minScale = mirrorFixedMinScaleRef.current;
    const rawNext = pinchRef.current
      ? pinchRef.current.startScale * ratio
      : current;
    const clamped = Math.min(1, Math.max(minScale, rawNext));
    if (clamped >= 1 && current < 1) {
      return Math.min(1, current + 0.08);
    }
    return clamped;
  }, []);

  const restoredHorizontalOffsetSessionRef = useRef<string | null>(null);
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

  const rowHeightPx = Math.max(
    1,
    parseInt(resolvedRowHeight, 10) || parseInt(rowHeight, 10) || 17,
  );
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

  // Two-finger drag tracks vertical motion to emit SGR mouse wheel events so
  // TUI apps (e.g. OpenCode) can scroll their internal history without us
  // touching tmux copy-mode.
  const twoFingerWheelRef = useRef<{
    active: boolean;
    pointerIds: [number, number] | null;
    lastClientY: number;
    lastSpanPx: number;
    initialSpanPx: number;
    accumulatedDeltaPx: number;
    accumulatedPinchDeltaPx: number;
    lastSentDirection: "up" | "down" | null;
    lastSentTickAt: number;
    lockedDirection: "up" | "down" | null;
    debug: {
      startCalls: number;
      moveCalls: number;
      endCalls: number;
      abortedCount: number;
      sentCount: number;
      lastReason: string;
      lastEventAt: number;
    };
  }>({
    active: false,
    pointerIds: null,
    lastClientY: 0,
    lastSpanPx: 0,
    initialSpanPx: 0,
    accumulatedDeltaPx: 0,
    accumulatedPinchDeltaPx: 0,
    lastSentDirection: null,
    lastSentTickAt: 0,
    lockedDirection: null,
    debug: {
      startCalls: 0,
      moveCalls: 0,
      endCalls: 0,
      abortedCount: 0,
      sentCount: 0,
      lastReason: "init",
      lastEventAt: 0,
    },
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

  const maxMirrorFixedHorizontalOffsetPx = Math.max(
    0,
    Math.round((renderBuffer.cols || 0) * resolvedCellWidthPx - viewportClientWidthPx),
  );

  const commitMirrorFixedHorizontalOffset = useCallback(
    (nextOffsetPx: number) => {
      const clamped = clampHorizontalOffset(
        nextOffsetPx,
        maxMirrorFixedHorizontalOffsetPx,
      );
      mirrorFixedHorizontalOffsetRef.current = clamped;
      setMirrorFixedHorizontalOffsetPx((current) =>
        current === clamped ? current : clamped,
      );
      return clamped;
    },
    [maxMirrorFixedHorizontalOffsetPx],
  );

  useEffect(() => {
    if (widthMode !== "mirror-fixed" || !sessionId) {
      restoredHorizontalOffsetSessionRef.current = null;
      mirrorFixedHorizontalOffsetRef.current = 0;
      setMirrorFixedHorizontalOffsetPx(0);
      return;
    }
    if (viewportClientWidthPx <= 0) {
      return;
    }
    if (restoredHorizontalOffsetSessionRef.current === sessionId) {
      return;
    }
    restoredHorizontalOffsetSessionRef.current = sessionId;
    commitMirrorFixedHorizontalOffset(readStoredHorizontalOffset(sessionId));
  }, [commitMirrorFixedHorizontalOffset, sessionId, viewportClientWidthPx, widthMode]);

  useEffect(() => {
    if (widthMode !== "mirror-fixed" || !sessionId) {
      return;
    }
    if (viewportClientWidthPx <= 0) {
      return;
    }
    setMirrorFixedHorizontalOffsetPx((current) => {
      const clamped = clampHorizontalOffset(
        current,
        maxMirrorFixedHorizontalOffsetPx,
      );
      mirrorFixedHorizontalOffsetRef.current = clamped;
      if (clamped !== current) {
        writeStoredHorizontalOffset(sessionId, clamped);
      }
      return current === clamped ? current : clamped;
    });
  }, [
    maxMirrorFixedHorizontalOffsetPx,
    sessionId,
    viewportClientWidthPx,
    widthMode,
  ]);

  const handleMirrorFixedTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (
        widthMode !== "mirror-fixed" ||
        copyModeActive ||
        event.touches.length !== 1
      ) {
        horizontalPanRef.current.active = false;
        return;
      }
      const startX = event.touches[0].clientX;
      const startOffsetPx = mirrorFixedHorizontalOffsetRef.current;
      const viewportWidth = window.visualViewport?.width || window.innerWidth || 0;
      const reservedRightEdge = reserveRightEdgeSwipe
        && viewportWidth > 0
        && startX >= viewportWidth - SESSION_PREVIEW_RIGHT_EDGE_PX;
      horizontalPanRef.current = {
        active: !reservedRightEdge,
        axis: null,
        startX,
        startY: event.touches[0].clientY,
        startOffsetPx,
        consumedHorizontal: false,
        consumedVertical: false,
      };
      if (reservedRightEdge) return;
      if (
        startOffsetPx > 0 ||
        startX > TERMINAL_DRAWER_EDGE_SWIPE_START_PX
      ) {
        event.stopPropagation();
      }
    },
    [copyModeActive, reserveRightEdgeSwipe, widthMode],
  );

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

  const handleMirrorFixedTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const pan = horizontalPanRef.current;
      if (!pan.active || widthMode !== "mirror-fixed" || event.touches.length !== 1) {
        if (event.touches.length === 1) {
          markUserScrollIntentRuntime(300);
        }
        return;
      }
      const deltaX = event.touches[0].clientX - pan.startX;
      const deltaY = event.touches[0].clientY - pan.startY;
      if (!pan.axis) {
        if (
          Math.abs(deltaX) < HORIZONTAL_PAN_LOCK_PX &&
          Math.abs(deltaY) < HORIZONTAL_PAN_LOCK_PX
        ) {
          markUserScrollIntentRuntime(300);
          return;
        }
        pan.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      }
      if (pan.axis !== "horizontal") {
        // 纵向手势永远交给原生 scrollTop（UI shell 不接管纵向滚动，视觉缩放不改 buffer 几何）
        markUserScrollIntentRuntime(300);
        return;
      }
      const nextOffset = commitMirrorFixedHorizontalOffset(pan.startOffsetPx - deltaX);
      const shouldReserveForRenderer =
        pan.startOffsetPx > 0 ||
        pan.startX > TERMINAL_DRAWER_EDGE_SWIPE_START_PX ||
        nextOffset !== pan.startOffsetPx;
      if (shouldReserveForRenderer) {
        pan.consumedHorizontal = true;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [commitMirrorFixedHorizontalOffset, markUserScrollIntentRuntime, widthMode],
  );

  const commitMirrorFixedTouchEnd = useCallback((event?: TouchEvent<HTMLDivElement>) => {
    const pan = horizontalPanRef.current;
    horizontalPanRef.current = {
      active: false,
      axis: null,
      startX: 0,
      startY: 0,
      startOffsetPx: 0,
      consumedHorizontal: false,
      consumedVertical: false,
    };
    if (pan.consumedHorizontal) {
      event?.stopPropagation();
    }
    if (widthMode === "mirror-fixed" && sessionId && pan.axis === "horizontal") {
      writeStoredHorizontalOffset(sessionId, mirrorFixedHorizontalOffsetRef.current);
    }
  }, [sessionId, widthMode]);

  // Two-finger vertical drag is converted into SGR mouse wheel events so TUIs
  // (OpenCode / Codex) can scroll their internal history buffer. This bypasses
  // tmux alternate-screen limitations that prevent capture-pane from
  // preserving scrollback for full-screen TUIs.
  // Configuration is centralized in the pure decision helper so it can be
  // unit-tested without DOM. See two-finger-wheel-decision.ts.
  const TWO_FINGER_WHEEL_CONFIG = DEFAULT_TWO_FINGER_WHEEL_CONFIG;

  const publishTwoFingerWheelDebug = useCallback(
    (state: typeof twoFingerWheelRef.current) => {
      const snap: TwoFingerWheelDebugSnapshot = {
        active: state.active,
        lockedDirection: state.lockedDirection,
        initialSpanPx: Math.round(state.initialSpanPx),
        accumulatedDeltaPx: Math.round(state.accumulatedDeltaPx),
        lastSentDirection: state.lastSentDirection,
        lastSentAt: state.lastSentTickAt || null,
        startCalls: state.debug.startCalls,
        moveCalls: state.debug.moveCalls,
        endCalls: state.debug.endCalls,
        abortedCount: state.debug.abortedCount,
        sentCount: state.debug.sentCount,
        lastReason: state.debug.lastReason,
        lastEventAt: state.debug.lastEventAt,
      };
      setTwoFingerWheelDebugSnapshot(snap);
    },
    [],
  );

  const handleTwoFingerWheelTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (event.touches.length !== 2) {
        return;
      }
      twoFingerWheelRef.current.debug.startCalls += 1;
      twoFingerWheelRef.current.debug.lastEventAt = Date.now();
      if (previewProjection) {
        twoFingerWheelRef.current.debug.lastReason = "skip-preview-projection";
        return;
      }
      if (copyModeActive) {
        twoFingerWheelRef.current.debug.lastReason = "skip-copy-mode";
        return;
      }
      const [t0, t1] = [event.touches[0], event.touches[1]];
      const spanPx = Math.hypot(
        t1.clientX - t0.clientX,
        t1.clientY - t0.clientY,
      );
      if (spanPx < TWO_FINGER_WHEEL_CONFIG.minInitialSpanPx) {
        twoFingerWheelRef.current.debug.lastReason = "skip-min-span";
        return;
      }
      twoFingerWheelRef.current.debug.lastReason = "started";
      pinchRef.current = {
        startSpan: spanPx,
        startScale: mirrorFixedScaleRef.current,
      };
      const midY = (t0.clientY + t1.clientY) / 2;
      twoFingerWheelRef.current = {
        active: true,
        pointerIds: [t0.identifier, t1.identifier],
        lastClientY: midY,
        lastSpanPx: spanPx,
        initialSpanPx: spanPx,
        accumulatedDeltaPx: 0,
        accumulatedPinchDeltaPx: 0,
        lastSentDirection: null,
        lastSentTickAt: 0,
        lockedDirection: null,
        debug: { ...twoFingerWheelRef.current.debug, startCalls: twoFingerWheelRef.current.debug.startCalls },
      };
      publishTwoFingerWheelDebug(twoFingerWheelRef.current);
      // Reserve the gesture so mirror-fixed panning does not also act on it.
      event.preventDefault();
    },
    [previewProjection, copyModeActive, publishTwoFingerWheelDebug],
  );

  const handleTwoFingerWheelTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const wheel = twoFingerWheelRef.current;
      wheel.debug.moveCalls += 1;
      wheel.debug.lastEventAt = Date.now();
      if (!wheel.active) {
        wheel.debug.lastReason = "skip-inactive";
        // 手势已因 pinch 中止：继续执行容器缩放（mirror-fixed 恒定宽度模式）
        if (
          event.touches.length === 2 &&
          pinchRef.current &&
          widthMode === 'mirror-fixed'
        ) {
          const [t0, t1] = [event.touches[0], event.touches[1]];
          const spanPx = Math.hypot(
            t1.clientX - t0.clientX,
            t1.clientY - t0.clientY,
          );
          if (spanPx > 0 && pinchRef.current.startSpan > 0) {
            const ratio = spanPx / pinchRef.current.startSpan;
            applyPinchScale(computeNextPinchScale(ratio));
            event.preventDefault();
            event.stopPropagation();
          }
        }
        publishTwoFingerWheelDebug(wheel);
        return;
      }
      if (event.touches.length !== 2) {
        wheel.debug.lastReason = "skip-not-two-fingers";
        publishTwoFingerWheelDebug(wheel);
        return;
      }
      const [t0, t1] = [event.touches[0], event.touches[1]];
      const midY = (t0.clientY + t1.clientY) / 2;
      const spanPx = Math.hypot(
        t1.clientX - t0.clientX,
        t1.clientY - t0.clientY,
      );
      const midYDelta = midY - wheel.lastClientY;
      wheel.lastClientY = midY;
      wheel.lastSpanPx = spanPx;

      const decision = decideTwoFingerWheel(
        {
          active: wheel.active,
          initialSpanPx: wheel.initialSpanPx,
          accumulatedDeltaPx: wheel.accumulatedDeltaPx,
          lockedDirection: wheel.lockedDirection,
        },
        { midYDeltaPx: midYDelta, liveSpanPx: spanPx },
        TWO_FINGER_WHEEL_CONFIG,
      );

      wheel.active = decision.next.active;
      wheel.initialSpanPx = decision.next.initialSpanPx;
      wheel.accumulatedDeltaPx = decision.next.accumulatedDeltaPx;
      wheel.lockedDirection = decision.next.lockedDirection;
      wheel.accumulatedPinchDeltaPx += Math.abs(
        spanPx - wheel.lastSpanPx,
      );

      if (decision.aborted) {
        wheel.debug.abortedCount += 1;
        wheel.debug.lastReason = "aborted-pinch";
        // 双指距离变化 = pinch：缩放 mirror-fixed 容器
        if (widthMode === 'mirror-fixed' && pinchRef.current) {
          const ratio =
            pinchRef.current.startSpan > 0
              ? spanPx / pinchRef.current.startSpan
              : 1;
          applyPinchScale(computeNextPinchScale(ratio));
        }
        event.preventDefault();
        event.stopPropagation();
        publishTwoFingerWheelDebug(wheel);
        return;
      }
      if (decision.direction === null || decision.steps < 1) {
        wheel.debug.lastReason = "no-step";
        publishTwoFingerWheelDebug(wheel);
        return;
      }
      const host = containerRef.current;
      if (!host || !sessionIdRef.current) {
        return;
      }
      const rect = host.getBoundingClientRect();
      const col = Math.max(
        1,
        Math.floor(((t0.clientX + t1.clientX) / 2 - rect.left) / Math.max(1, resolvedCellWidthPx)) + 1,
      );
      const row = Math.max(
        1,
        Math.floor((midY - rect.top) / Math.max(1, rowHeightPx)) + 1,
      );
      wheel.lastSentDirection = decision.direction;
      wheel.lastSentTickAt = Date.now();
      wheel.debug.sentCount += decision.steps;
      wheel.debug.lastReason = `sent-${decision.direction}-x${decision.steps}`;
      const sequence = encodeTerminalSgrMouseWheel(decision.direction, col, row);
      onInputRef.current?.(sessionIdRef.current, sequence);
      event.preventDefault();
      event.stopPropagation();
      publishTwoFingerWheelDebug(wheel);
    },
    [resolvedCellWidthPx, rowHeightPx],
  );

  const commitTwoFingerWheelTouchEnd = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const wheel = twoFingerWheelRef.current;
      wheel.debug.endCalls += 1;
      wheel.debug.lastEventAt = Date.now();
      if (!wheel.active) {
        wheel.debug.lastReason = "end-inactive";
        pinchRef.current = null;
        // pinch 中止（active=false）后抬起：横向平移归零（纵向一直由原生 scrollTop 承担）
        if (mirrorFixedScaleRef.current < 1) {
          setMirrorFixedHorizontalOffsetPx(0);
          mirrorFixedHorizontalOffsetRef.current = 0;
        }
        publishTwoFingerWheelDebug(wheel);
        return;
      }
      // Any touch change other than 2 active fingers ends the gesture.
      if (event.touches.length === 2) {
        publishTwoFingerWheelDebug(wheel);
        return;
      }
      wheel.debug.lastReason = "ended";
      publishTwoFingerWheelDebug(wheel);
      pinchRef.current = null;
      // commit pinch 缩放结果：横向平移归零（纵向一直由原生 scrollTop 承担）
      if (mirrorFixedScaleRef.current < 1) {
        setMirrorFixedHorizontalOffsetPx(0);
        mirrorFixedHorizontalOffsetRef.current = 0;
      }
      twoFingerWheelRef.current = {
        active: false,
        pointerIds: null,
        lastClientY: 0,
        lastSpanPx: 0,
        initialSpanPx: 0,
        accumulatedDeltaPx: 0,
        accumulatedPinchDeltaPx: 0,
        lastSentDirection: null,
        lastSentTickAt: 0,
        lockedDirection: null,
        debug: { ...twoFingerWheelRef.current.debug, endCalls: twoFingerWheelRef.current.debug.endCalls },
      };
      publishTwoFingerWheelDebug(twoFingerWheelRef.current);
    },
    [publishTwoFingerWheelDebug],
  );

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
    const followRealignAfterBufferShift = computeFollowRealignAfterBufferShift({
      refreshActive,
      readingMode: isTerminalFollowScrollReading(followScrollStateRef.current),
      previousPaddingTopPx: previousTermGridPaddingTopPxRef.current,
      nextPaddingTopPx: termGridPaddingTopPx,
      viewportClientHeightPx: viewportClientHeightPx || host?.clientHeight || 0,
      maxScrollTop,
    });
    previousTermGridPaddingTopPxRef.current = termGridPaddingTopPx;
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
    effectiveBufferEndIndex,
    applyFollowScrollTransition,
    followVisualBottomIndex,
    flushPendingFollowScrollSync,
    maxScrollTop,
    refreshActive,
    renderBuffer.revision,
    renderBuffer.startIndex,
    rowHeightPx,
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

  // 渲染时同步 mirror-fixed 最小缩放（终端全宽对齐屏幕宽度时的 scale）
  if (widthMode === 'mirror-fixed') {
    const terminalLogicalWidthPx = Math.max(
      viewportClientWidthPx,
      Math.round((renderBuffer.cols || 0) * resolvedCellWidthPx),
    );
    mirrorFixedMinScaleRef.current =
      viewportClientWidthPx > 0 && terminalLogicalWidthPx > viewportClientWidthPx
        ? viewportClientWidthPx / terminalLogicalWidthPx
        : 1;
  }

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
      onTouchMove={(event) => {
        if (event.touches.length === 2) {
          handleTwoFingerWheelTouchMove(event);
          return;
        }
        handleMirrorFixedTouchMove(event);
        mirrorFixedZoomPan.onTouchMove(event);
      }}
      onTouchStart={(event) => {
        mirrorFixedZoomPan.onTouchStart(event);
        if (event.touches.length === 2) {
          handleTwoFingerWheelTouchStart(event);
          return;
        }
        handleMirrorFixedTouchStart(event);
      }}
      onTouchEnd={(event) => {
        mirrorFixedZoomPan.onTouchEnd(event);
        commitTwoFingerWheelTouchEnd(event);
        commitMirrorFixedTouchEnd(event);
      }}
      onTouchCancel={(event) => {
        mirrorFixedZoomPan.onTouchEnd(event);
        commitTwoFingerWheelTouchEnd(event);
        commitMirrorFixedTouchEnd(event);
      }}
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
          ref={gridElRef}
        data-cursor-source="cursor-metadata"
        data-horizontal-offset-px={
          widthMode === "mirror-fixed"
            ? String(mirrorFixedHorizontalOffsetPx)
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
            widthMode === "mirror-fixed" && mirrorFixedHorizontalOffsetPx > 0
              ? `translateX(-${mirrorFixedHorizontalOffsetPx}px)`
              : undefined,
          willChange:
            widthMode === "mirror-fixed" && mirrorFixedHorizontalOffsetPx > 0
              ? "transform"
              : undefined,
        }}
      >
        {passivePreviewProjection
          ? renderRowsWithSignatures.map(({ absoluteIndex, row, isGap }) => {
              const plainText = terminalRowToText(row);
              return (
                <div
                  key={`preview-row-${absoluteIndex}`}
                  data-terminal-row="true"
                  data-terminal-preview-row="true"
                  data-terminal-gap={isGap ? "true" : undefined}
                  data-terminal-index={absoluteIndex}
                  data-terminal-row-text={plainText}
                  style={{
                    height: resolvedRowHeight || rowHeight,
                    minHeight: resolvedRowHeight || rowHeight,
                    lineHeight: resolvedRowHeight || rowHeight,
                    color: theme.foreground,
                    whiteSpace: "pre",
                    overflow: "hidden",
                    textOverflow: "clip",
                  }}
                >
                  {plainText || "\u00a0"}
                </div>
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
