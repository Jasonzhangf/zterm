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
  queueTerminalFollowScrollSync,
  cancelTerminalFollowScrollSync,
  flushTerminalFollowScrollSync,
  markTerminalFollowViewportRealignOnLayoutDrift,
  handleTerminalFollowModeScrollGuards,
  alignTerminalRenderBottomToFollow,
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
  commitProgrammaticTerminalScroll,
  markUserScrollIntent,
  hasRecentUserScrollIntent,
  consumeFollowResetSignal,
  consumeViewportRefreshSignal,
  applySessionSwitchRenderReset,
  createTerminalDomInputController,
} from "@zterm/shared";
import { normalizeTerminalCommittedText } from "../lib/terminal-input-normalization";
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

import { VisibleRow } from "./terminal/VisibleRow";

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
  splitVisible?: boolean;
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
  onLongPressRow,
  splitVisible = false,
}: TerminalViewProps) {
  const theme = getTerminalThemePreset(themeId);
  const refreshActive = live ?? active;
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
  const pendingFollowRenderBottomIndexRef = useRef<number | null>(null);
  const pendingImmediateFollowScrollSyncRef = useRef(false);
  const lastQueuedFollowRenderBottomIndexRef = useRef<number | null>(null);
  const pendingFollowScrollSyncRef = useRef(false);
  const pendingFollowViewportRealignRef = useRef(false);
  const recentViewportLayoutChangeRef = useRef(false);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const resizeRafTokenRef = useRef<number | null>(null);
  const ignoredProgrammaticScrollTopRef = useRef<number | null>(null);
  const lastSettledScrollTopRef = useRef(0);
  const hasSettledFollowFrameRef = useRef(false);
  const syncScrollHostToRenderBottomRef = useRef<
    (nextRenderBottomIndex: number) => void
  >(() => {});
  const runViewportRefreshRef = useRef<() => void>(() => {});
  const queueFollowVisualRealignRef = useRef<
    (options?: {
      guardPendingFollowDrift?: boolean;
      renderBottomIndex?: number;
    }) => void
  >(() => {});
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
  const userScrollIntentDeadlineRef = useRef(0);
  const [viewportRows, setViewportRows] = useState(DEFAULT_ROWS);
  const [resolvedRowHeight, setResolvedRowHeight] = useState(rowHeight);
  const [resolvedCellWidthPx, setResolvedCellWidthPx] = useState(
    Math.max(1, fontSize * 0.62),
  );
  const [viewportClientHeightPx, setViewportClientHeightPx] = useState(0);
  const [renderBottomIndex, setRenderBottomIndex] = useState(
    effectiveBufferEndIndex,
  );
  const [readingMode, setReadingMode] = useState(false);

  const rowHeightPx = Math.max(
    1,
    parseInt(resolvedRowHeight, 10) || parseInt(rowHeight, 10) || 17,
  );
  readingModeRef.current = readingMode;
  const renderFrame = useMemo(
    () =>
      buildTerminalRenderFrame({
        bufferStartIndex: renderBuffer.startIndex,
        effectiveBufferEndIndex,
        bufferLinesLength: bufferLines.length,
        viewportRows,
        rowHeightPx,
        renderBottomIndex,
        followDemandAnchorEndIndex,
        readingMode,
        overscanRows: OVERSCAN_ROWS,
      }),
    [
      bufferLines.length,
      effectiveBufferEndIndex,
      followDemandAnchorEndIndex,
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
        rowHeightPx,
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
        rowHeightPx,
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

  const resolveScrollTopForRenderBottomIndex = useCallback(
    (nextRenderBottomIndex: number) => {
      return resolveScrollTopForRenderBottomIndexShared({
        nextRenderBottomIndex,
        totalRows,
        viewportRows,
        bufferStartIndex: renderBuffer.startIndex,
        rowHeightPx,
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
        rowHeightPx,
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

  const markFollowViewportRealignOnLayoutDrift = useCallback(
    (viewportLayoutChanged: boolean) => {
      markTerminalFollowViewportRealignOnLayoutDrift({
        readingMode: readingModeRef.current,
        viewportLayoutChanged,
        pendingFollowViewportRealignRef,
        viewportClientHeightPx,
        recentViewportLayoutChangeRef,
        recentViewportLayoutChangeTimerRef,
      });
    },
    [viewportClientHeightPx],
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
      const key = buildTerminalViewportDemandKey(demand);
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
      renderBuffer.startIndex,
      sessionId,
      viewportRows,
    ],
  );

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
        observedScrollTop < lastSettledScrollTopRef.current - 1;
      if (
        nextMode === "reading" &&
        !readingModeRef.current &&
        !hasRecentUserScrollIntent(userScrollIntentDeadlineRef) &&
        !upwardAwayFromSettledBottom
      ) {
        queueFollowVisualRealignRef.current({
          guardPendingFollowDrift: true,
        });
        return;
      }
      readingModeRef.current = nextMode === "reading";
      setRenderBottomIndex(nextRenderBottomIndex);
      setReadingMode(nextMode === "reading");
      emitRenderDemand(nextMode, nextRenderBottomIndex);
    },
    [emitRenderDemand, resolveRenderDemandFromScroll],
  );

  const syncScrollHostToRenderBottom = useCallback(
    (nextRenderBottomIndex: number) => {
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
    },
    [resolveScrollTopForRenderBottomIndex],
  );
  syncScrollHostToRenderBottomRef.current = syncScrollHostToRenderBottom;

  const queueFollowScrollSync = useCallback(
    (
      nextRenderBottomIndex: number,
      options?: {
        guardPendingFollowDrift?: boolean;
      },
    ) => {
      queueTerminalFollowScrollSync({
        nextRenderBottomIndex,
        minimumRenderBottomIndex,
        pendingFollowRenderBottomIndexRef,
        lastQueuedFollowRenderBottomIndexRef,
        pendingFollowScrollSyncRef,
        followScrollSyncTimerRef,
        guardPendingFollowDrift: options?.guardPendingFollowDrift,
        flushPendingRenderBottomIndex: () => {
          const pendingRenderBottomIndex =
            pendingFollowRenderBottomIndexRef.current;
          pendingFollowRenderBottomIndexRef.current = null;
          lastQueuedFollowRenderBottomIndexRef.current = null;
          if (pendingRenderBottomIndex === null) {
            return;
          }
          syncScrollHostToRenderBottomRef.current(pendingRenderBottomIndex);
        },
      });
    },
    [minimumRenderBottomIndex],
  );

  const cancelPendingFollowScrollSync = useCallback(() => {
    cancelTerminalFollowScrollSync({
      followScrollSyncTimerRef,
      recentViewportLayoutChangeTimerRef,
      pendingFollowRenderBottomIndexRef,
      pendingImmediateFollowScrollSyncRef,
      lastQueuedFollowRenderBottomIndexRef,
      pendingFollowScrollSyncRef,
      pendingFollowViewportRealignRef,
      recentViewportLayoutChangeRef,
      ignoredProgrammaticScrollTopRef,
    });
  }, []);

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
    return flushTerminalFollowScrollSync({
      refreshActive,
      readingMode: readingModeRef.current,
      pendingFollowRenderBottomIndexRef,
      pendingImmediateFollowScrollSyncRef,
      followScrollSyncTimerRef,
      followVisualBottomIndex,
      syncScrollHostToRenderBottom,
    });
  }, [
    followVisualBottomIndex,
    readingModeRef,
    refreshActive,
    syncScrollHostToRenderBottom,
  ]);

  const syncFollowScrollToAnchor = useCallback(() => {
    if (!refreshActive || readingModeRef.current) {
      return false;
    }
    syncScrollHostToRenderBottom(followVisualBottomIndex);
    return true;
  }, [followVisualBottomIndex, refreshActive, syncScrollHostToRenderBottom]);

  const handleFollowModeScrollGuards = useCallback(
    (host: HTMLDivElement) => {
      return handleTerminalFollowModeScrollGuards(host, {
        readingMode: readingModeRef.current,
        recentViewportLayoutChangeRef,
        recentViewportLayoutChangeTimerRef,
        pendingFollowScrollSyncRef,
        pendingFollowRenderBottomIndexRef,
        pendingFollowViewportRealignRef,
        lastSettledScrollTopRef,
        ignoredProgrammaticScrollTopRef,
        maxScrollTop,
        queueFollowVisualRealign,
        cancelPendingFollowScrollSync,
      });
    },
    [cancelPendingFollowScrollSync, maxScrollTop, queueFollowVisualRealign],
  );

  const resetFollowViewportReport = useCallback(() => {
    lastReportedViewportRef.current = "";
  }, []);

  const setFollowModeState = useCallback((nextRenderBottomIndex: number) => {
    readingModeRef.current = false;
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
        pendingImmediateFollowScrollSyncRef.current = true;
      }
      if (options?.queueScrollSync === false) {
        return;
      }
      queueFollowVisualRealign({
        renderBottomIndex: nextRenderBottomIndex,
        guardPendingFollowDrift: options?.guardPendingFollowDrift,
      });
    },
    [queueFollowVisualRealign],
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
    const nextMode: "follow" | "reading" = readingModeRef.current
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
      readingMode: readingModeRef.current,
      hasSettledFollowFrame: hasSettledFollowFrameRef.current,
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
    flushPendingFollowScrollSync();
  }, [
    effectiveBufferEndIndex,
    flushPendingFollowScrollSync,
    renderBuffer.revision,
    renderBuffer.startIndex,
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
    const domBottomScrollTop = Math.max(
      0,
      host.scrollHeight - host.clientHeight,
    );
    const overscrolledBlankFrame = observedScrollTop > domBottomScrollTop + 1;
    const pendingViewportRealign = pendingFollowViewportRealignRef.current;

    if (!overscrolledBlankFrame && !pendingViewportRealign) {
      return;
    }

    syncScrollHostToRenderBottom(followVisualBottomIndex);
  });

  useEffect(() => {
    const previousMetrics = previousFollowViewportMetricsRef.current;
    previousFollowViewportMetricsRef.current = {
      viewportRows,
      rowHeightPx,
      clientHeightPx: viewportClientHeightPx,
    };

    if (!refreshActive || readingModeRef.current) {
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
    if (renderGeometryRevisionRafRef.current !== null) {
      return;
    }
    renderGeometryRevisionRafRef.current = window.requestAnimationFrame(() => {
      renderGeometryRevisionRafRef.current = null;
      if (lastAppliedRenderGeometryRevisionKeyRef.current === renderGeometryRevisionKey) {
        return;
      }
      lastAppliedRenderGeometryRevisionKeyRef.current = renderGeometryRevisionKey;
      if (!refreshActive || readingModeRef.current) {
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
      data-copy-mode={copyModeActive ? "true" : undefined}
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
      onContextMenu={suppressNativeCopyMenu}
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
      onTouchMove={(event) => {
        if (event.touches.length === 1) {
          markUserScrollIntent(userScrollIntentDeadlineRef, 300);
        }
      }}
      onWheel={() => {
        markUserScrollIntent(userScrollIntentDeadlineRef, 250);
      }}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        backgroundColor: theme.background,
        overflowY: "auto",
        overflowX: "hidden",
        overscrollBehavior: "contain",
        touchAction: copyModeActive ? "pan-y" : "auto",
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
      }}
    >
      <div
        className="term-grid"
        data-cursor-source="cursor-metadata"
        onContextMenu={suppressNativeCopyMenu}
        style={{
          paddingTop: `${termGridPaddingTopPx}px`,
          paddingBottom: `${termGridPaddingBottomPx}px`,
        }}
      >
        {renderRows.map(({ absoluteIndex, row, isGap }, rowIndex) =>
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
                onPointerUp={copyModeActive ? cancelCopyLongPress : undefined}
                onTouchEnd={copyModeActive ? cancelCopyLongPress : undefined}
                onPointerCancel={
                  copyModeActive ? cancelCopyLongPress : undefined
                }
                onTouchCancel={copyModeActive ? cancelCopyLongPress : undefined}
              />
            );
          })(),
        )}
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
      <style>{`@keyframes zterm-history-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.wterm[data-copy-mode="true"],.wterm[data-copy-mode="true"] [data-terminal-row="true"]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}`}</style>
    </div>
  );
}

export const TerminalView = memo(TerminalViewComponent);
TerminalView.displayName = "TerminalView";
