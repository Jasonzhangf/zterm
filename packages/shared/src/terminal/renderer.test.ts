import { describe, expect, it, vi } from 'vitest';
import { getTerminalThemePreset } from './theme';
import {
  alignTerminalRenderBottomToFollow,
  buildTerminalRenderFrame,
  buildTerminalMeasuredViewportState,
  buildTerminalRenderRows,
  buildTerminalViewportDemand,
  buildTerminalViewportDemandWithRepair,
  buildTerminalViewportDemandKey,
  resolveTerminalRenderDemandFromScroll,
  clearTerminalRecentViewportLayoutChange,
  computeFollowRealignAfterBufferShift,
  flushTerminalFollowScrollSync,
  markTerminalFollowViewportRealignOnLayoutDrift,
  reconcileTerminalViewportAfterBufferShift,
  queueTerminalFollowScrollSync,
  resolveTerminalResizeCommitPlan,
  resolveTerminalWidthModeSignal,
  hasTerminalViewportLayoutChanged,
  detectDoubleWidthChar,
  hasDiscontinuousNeighbor,
  buildTerminalVisibleRowViewModel,
  renderGapMarker,
  renderRowCells,
  resolveCursorOverlay,
} from './renderer/index';

describe('shared terminal renderer pure helpers', () => {
  const theme = getTerminalThemePreset('classic-dark');

  it('builds visible render rows with gap truth', () => {
    const rows = buildTerminalRenderRows({
      bufferLines: [
        [{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }],
        [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }],
      ],
      gapRanges: [{ startIndex: 1, endIndex: 2 }],
      startIndex: 0,
      leadingBlankRows: 0,
      renderStartOffset: 0,
      renderEndOffset: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ absoluteIndex: 0, isGap: false, viewportOffset: 0 });
    expect(rows[1]).toMatchObject({ absoluteIndex: 1, isGap: true, viewportOffset: 1 });
  });

  it('builds follow/read render frame geometry as pure derived state', () => {
    const frame = buildTerminalRenderFrame({
      bufferStartIndex: 100,
      effectiveBufferEndIndex: 140,
      bufferLinesLength: 40,
      viewportRows: 10,
      rowHeightPx: 17,
      renderBottomIndex: 128,
      followDemandAnchorEndIndex: 140,
      readingMode: false,
      overscanRows: 4,
    });

    expect(frame.minimumRenderBottomIndex).toBe(110);
    expect(frame.followVisualBottomIndex).toBe(140);
    expect(frame.effectiveRenderBottomIndex).toBe(140);
    expect(frame.visibleWindowStartIndex).toBe(130);
    expect(frame.visibleWindowEndIndex).toBe(140);
    expect(frame.renderStartOffset).toBe(26);
    expect(frame.renderEndOffset).toBe(40);
  });

  it('builds viewport demand and stable key from pure renderer inputs', () => {
    const demand = buildTerminalViewportDemand({
      nextMode: 'reading',
      nextRenderBottomIndex: 132,
      viewportRows: 12,
      bufferStartIndex: 100,
      followDemandAnchorEndIndex: 140,
    });

    expect(demand).toEqual({
      mode: 'reading',
      viewportEndIndex: 132,
      viewportRows: 12,
    });
    expect(buildTerminalViewportDemandKey(demand)).toBe('reading:132:12');
  });

  it('uses the scaled renderer viewport rows for scroll demand and visible gap repair', () => {
    const viewportRows = 24;
    const zoomedRenderViewportRows = 48;
    const frame = buildTerminalRenderFrame({
      bufferStartIndex: 100,
      effectiveBufferEndIndex: 220,
      bufferLinesLength: 120,
      viewportRows: zoomedRenderViewportRows,
      scrollViewportRows: viewportRows,
      rowHeightPx: 17,
      renderBottomIndex: 172,
      followDemandAnchorEndIndex: 220,
      readingMode: true,
      overscanRows: 4,
    });
    const demand = resolveTerminalRenderDemandFromScroll({
      nextScrollTop: 408,
      maxScrollTop: frame.maxScrollTop,
      rowHeightPx: 17,
      dataRowCount: frame.dataRowCount,
      viewportRows: zoomedRenderViewportRows,
      effectiveBufferEndIndex: 220,
      minimumRenderBottomIndex: frame.minimumRenderBottomIndex,
      bufferTailAnchorEndIndex: 220,
      bufferStartIndex: 100,
      followVisualBottomIndex: frame.followVisualBottomIndex,
      observedScrollTop: 408,
      isAtBottom: false,
      resolveScrollTopForRenderBottomIndex: () => 0,
    });
    const repaired = buildTerminalViewportDemandWithRepair({
      nextMode: demand.nextMode,
      nextRenderBottomIndex: demand.nextRenderBottomIndex,
      viewportRows: zoomedRenderViewportRows,
      bufferStartIndex: 100,
      bufferEndIndex: 220,
      gapRanges: [{ startIndex: 140, endIndex: 180 }],
      followDemandAnchorEndIndex: 220,
    });

    expect(frame.maxScrollTop).toBe((120 - viewportRows) * 17);
    expect(demand.nextRenderBottomIndex).toBe(172);
    expect(repaired.viewportRows).toBe(zoomedRenderViewportRows);
    expect(repaired.missingRanges).toEqual([{ startIndex: 140, endIndex: 172 }]);
  });

  it('queues follow scroll sync as pure pending timer state', () => {
    vi.useFakeTimers();
    try {
      const pendingFollowRenderBottomIndexRef = { current: null as number | null };
      const lastQueuedFollowRenderBottomIndexRef = { current: null as number | null };
      const pendingFollowScrollSyncRef = { current: false };
      const followScrollSyncTimerRef = { current: null as number | null };
      const flushed: number[] = [];

      queueTerminalFollowScrollSync({
        nextRenderBottomIndex: 139.7,
        minimumRenderBottomIndex: 110,
        pendingFollowRenderBottomIndexRef,
        lastQueuedFollowRenderBottomIndexRef,
        pendingFollowScrollSyncRef,
        followScrollSyncTimerRef,
        guardPendingFollowDrift: true,
        flushPendingRenderBottomIndex: () => {
          flushed.push(pendingFollowRenderBottomIndexRef.current ?? -1);
        },
      });

      expect(pendingFollowRenderBottomIndexRef.current).toBe(139);
      expect(lastQueuedFollowRenderBottomIndexRef.current).toBe(139);
      expect(pendingFollowScrollSyncRef.current).toBe(true);
      expect(followScrollSyncTimerRef.current).not.toBeNull();

      vi.runAllTimers();
      expect(flushed).toEqual([139]);
      expect(followScrollSyncTimerRef.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes follow scroll sync only when active and not reading', () => {
    const pendingFollowRenderBottomIndexRef = { current: 135 as number | null };
    const pendingImmediateFollowScrollSyncRef = { current: false };
    const followScrollSyncTimerRef = { current: null as number | null };
    const synced: number[] = [];

    const didFlush = flushTerminalFollowScrollSync({
      refreshActive: true,
      readingMode: false,
      pendingFollowRenderBottomIndexRef,
      pendingImmediateFollowScrollSyncRef,
      followScrollSyncTimerRef,
      followVisualBottomIndex: 140,
      syncScrollHostToRenderBottom: (next) => synced.push(next),
    });

    expect(didFlush).toBe(true);
    expect(synced).toEqual([135]);
    expect(pendingFollowRenderBottomIndexRef.current).toBeNull();
  });

  it('marks viewport relayout drift as pending follow realign', () => {
    vi.useFakeTimers();
    try {
      const pendingFollowViewportRealignRef = { current: false };
      const recentViewportLayoutChangeRef = { current: false };
      const recentViewportLayoutChangeTimerRef = { current: null as number | null };

      markTerminalFollowViewportRealignOnLayoutDrift({
        readingMode: false,
        viewportLayoutChanged: true,
        pendingFollowViewportRealignRef,
        viewportClientHeightPx: 240,
        recentViewportLayoutChangeRef,
        recentViewportLayoutChangeTimerRef,
      });

      expect(pendingFollowViewportRealignRef.current).toBe(true);
      expect(recentViewportLayoutChangeRef.current).toBe(true);
      clearTerminalRecentViewportLayoutChange({
        recentViewportLayoutChangeRef,
        recentViewportLayoutChangeTimerRef,
      });
      expect(recentViewportLayoutChangeRef.current).toBe(false);
      expect(recentViewportLayoutChangeTimerRef.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aligns follow render bottom via injected follow orchestration hooks', () => {
    const calls: Array<[string, number | boolean | undefined]> = [];
    const aligned = alignTerminalRenderBottomToFollow({
      followVisualBottomIndex: 140,
      resetReportedViewport: true,
      immediateScrollSync: true,
      resetFollowViewportReport: () => calls.push(['reset', true]),
      setFollowModeState: (next) => calls.push(['state', next]),
      scheduleFollowScrollRealign: (next, options) => calls.push(['queue', options?.immediateScrollSync ? next : -1]),
      emitFollowViewportDemand: (next) => calls.push(['emit', next]),
    });

    expect(aligned).toBe(140);
    expect(calls).toEqual([
      ['reset', true],
      ['state', 140],
      ['queue', 140],
      ['emit', 140],
    ]);
  });

  it('reconciles buffer shift in reading mode without crossing renderer ownership', () => {
    const alignCalls: number[] = [];
    const setRenderBottomIndexCalls: number[] = [];
    const emitReadingDemandCalls: number[] = [];

    reconcileTerminalViewportAfterBufferShift({
      refreshActive: true,
      readingMode: true,
      hasSettledFollowFrame: false,
      effectiveRenderBottomIndex: 132,
      followVisualBottomIndex: 140,
      minimumRenderBottomIndex: 110,
      maximumRenderBottomIndex: 140,
      maxScrollTop: 500,
      alignRenderBottomToFollow: () => {
        alignCalls.push(1);
        return 140;
      },
      setRenderBottomIndex: (next) => setRenderBottomIndexCalls.push(next),
      emitReadingRenderDemand: (next) => emitReadingDemandCalls.push(next ?? -1),
    });

    expect(alignCalls).toEqual([]);
    expect(setRenderBottomIndexCalls).toEqual([]);
    expect(emitReadingDemandCalls).toEqual([132]);
  });

  it('detects large follow padding shifts that need same-frame scroll realignment', () => {
    expect(computeFollowRealignAfterBufferShift({
      refreshActive: true,
      readingMode: false,
      previousPaddingTopPx: 102,
      nextPaddingTopPx: 15440,
      viewportClientHeightPx: 497,
      maxScrollTop: 15502,
    })).toEqual({
      needsImmediateRealign: true,
      targetScrollTop: 15502,
      paddingDeltaPx: 15338,
    });
  });

  it('does not realign large padding shifts while reading or before a previous frame exists', () => {
    expect(computeFollowRealignAfterBufferShift({
      refreshActive: true,
      readingMode: true,
      previousPaddingTopPx: 102,
      nextPaddingTopPx: 15440,
      viewportClientHeightPx: 497,
      maxScrollTop: 15502,
    }).needsImmediateRealign).toBe(false);

    expect(computeFollowRealignAfterBufferShift({
      refreshActive: true,
      readingMode: false,
      previousPaddingTopPx: null,
      nextPaddingTopPx: 15440,
      viewportClientHeightPx: 497,
      maxScrollTop: 15502,
    }).needsImmediateRealign).toBe(false);

    expect(computeFollowRealignAfterBufferShift({
      refreshActive: true,
      readingMode: false,
      previousPaddingTopPx: 102,
      nextPaddingTopPx: 300,
      viewportClientHeightPx: 497,
      maxScrollTop: 392,
    }).needsImmediateRealign).toBe(false);
  });

  it('derives measured viewport state and layout-drift truth as pure state', () => {
    const state = buildTerminalMeasuredViewportState({
      cols: 80,
      rows: 24,
      resolvedRowHeight: '17px',
      resolvedCellWidthPx: 8,
    }, 408);

    expect(state).toEqual({
      viewportClientHeightPx: 408,
      resolvedRowHeight: '17px',
      resolvedCellWidthPx: 8,
      viewportRows: 24,
    });

    expect(hasTerminalViewportLayoutChanged({
      nextViewport: {
        cols: 80,
        rows: 25,
        resolvedRowHeight: '17px',
        resolvedCellWidthPx: 8,
      },
      nextClientHeight: 425,
      viewportRows: 24,
      viewportClientHeightPx: 408,
    })).toBe(true);
  });

  it('emits width-mode signal only when width truth really changes', () => {
    expect(resolveTerminalWidthModeSignal({
      refreshActive: true,
      sessionId: 's1',
      hasWidthModeHandler: true,
      widthMode: 'adaptive-phone',
      nextViewport: {
        cols: 81,
        rows: 24,
        resolvedRowHeight: '17px',
        resolvedCellWidthPx: 8,
      },
      previousWidthSignal: null,
    })).toEqual({
      mode: 'adaptive-phone',
      cols: 81,
    });

    expect(resolveTerminalWidthModeSignal({
      refreshActive: true,
      sessionId: 's1',
      hasWidthModeHandler: true,
      widthMode: 'mirror-fixed',
      nextViewport: {
        cols: 81,
        rows: 24,
        resolvedRowHeight: '17px',
        resolvedCellWidthPx: 8,
      },
      previousWidthSignal: {
        mode: 'mirror-fixed',
        cols: null,
      },
    })).toBeNull();
  });

  it('builds resize commit plan without hiding width-mode rules in TerminalView', () => {
    expect(resolveTerminalResizeCommitPlan({
      sessionId: 's1',
      widthMode: 'mirror-fixed',
      previousViewport: { cols: 80, rows: 24 },
      nextViewport: {
        cols: 90,
        rows: 30,
        resolvedRowHeight: '17px',
        resolvedCellWidthPx: 8,
      },
    })).toEqual({
      action: 'store-only',
      viewport: { cols: 90, rows: 30 },
    });

    expect(resolveTerminalResizeCommitPlan({
      sessionId: 's1',
      widthMode: 'adaptive-phone',
      previousViewport: { cols: 80, rows: 24 },
      nextViewport: {
        cols: 80,
        rows: 30,
        resolvedRowHeight: '17px',
        resolvedCellWidthPx: 8,
      },
    })).toEqual({
      action: 'store-only',
      viewport: { cols: 80, rows: 30 },
    });

    expect(resolveTerminalResizeCommitPlan({
      sessionId: 's1',
      widthMode: 'adaptive-phone',
      previousViewport: { cols: 80, rows: 24 },
      nextViewport: {
        cols: 81,
        rows: 24,
        resolvedRowHeight: '17px',
        resolvedCellWidthPx: 8,
      },
    })).toEqual({
      action: 'emit-resize',
      viewport: { cols: 81, rows: 24 },
    });
  });

  it('renders row cells with cursor styling and preserves double-width widths', () => {
    const cells = renderRowCells({
      absoluteIndex: 8,
      row: [
        { char: '你'.codePointAt(0)!, fg: 2, bg: 1, flags: 0, width: 2 },
        { char: 0, fg: 256, bg: 256, flags: 0, width: 0 },
      ],
      rowHeight: '17px',
      cellWidthPx: 8,
      theme,
      cursorColumn: 0,
    });

    expect(cells).toHaveLength(2);
    expect(cells[0]?.char).toBe('你');
    expect(cells[0]?.cursorActive).toBe(true);
    expect(cells[0]?.style.width).toBe('16px');
    expect(cells[1]?.char).toBe('');
    expect(cells[1]?.style.width).toBe('0px');
  });

  it('builds blank gap placeholder payload with explicit fill block', () => {
    const gap = renderGapMarker({
      absoluteIndex: 99,
      rowHeight: '17px',
      theme,
    });

    expect(gap.key).toBe('row-99');
    expect(gap.rowStyle.background).toBe(theme.background);
    expect(gap.rowStyle.borderTop).toBe('none');
    expect(gap.fillProps['data-terminal-gap-fill']).toBe('true');
  });

  it('keeps terminal row presentation fixed-height; visual wrapping must not be CSS auto-height', () => {
    const viewModel = buildTerminalVisibleRowViewModel({
      absoluteIndex: 42,
      row: Array.from('1234567890').map((char) => ({
        char: char.codePointAt(0)!,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 1,
      })),
      rowHeight: '17px',
      cellWidthPx: 8,
      isGap: false,
      theme,
      cursorColumn: 9,
    });

    expect(viewModel.kind).toBe('row');
    expect(viewModel.cells).toHaveLength(10);
    expect(viewModel.rowStyle.height).toBe('17px');
    expect(viewModel.rowStyle.minHeight).toBeUndefined();
    expect(viewModel.cellWrapProps.style.width).toBeUndefined();
    expect(viewModel.cellWrapProps.style.maxWidth).toBeUndefined();
    expect(viewModel.cellWrapProps.style.whiteSpace).toBe('pre');
  });

  it('paints ordinary rows with the terminal surface so trimmed empty rows cannot become transparent holes', () => {
    const viewModel = buildTerminalVisibleRowViewModel({
      absoluteIndex: 43,
      row: [],
      rowHeight: '17px',
      cellWidthPx: 8,
      isGap: false,
      theme,
      cursorColumn: -1,
    });

    expect(viewModel.kind).toBe('row');
    expect(viewModel.rowStyle.background).toBe(theme.background);
  });

  it('resolves cursor overlay only for matching visible cursor row', () => {
    const row = [
      { char: 65, fg: 256, bg: 256, flags: 0, width: 1 },
      { char: 66, fg: 256, bg: 256, flags: 0, width: 1 },
    ];

    expect(resolveCursorOverlay({
      row,
      cursor: { rowIndex: 12, col: 1, visible: true },
      absoluteIndex: 12,
    })).toEqual({ cursorColumn: 1, active: true });

    expect(resolveCursorOverlay({
      row,
      cursor: { rowIndex: 13, col: 1, visible: true },
      absoluteIndex: 12,
    })).toEqual({ cursorColumn: -1, active: false });
  });

  it('detects double-width characters by code point', () => {
    expect(detectDoubleWidthChar('你')).toBe(true);
    expect(detectDoubleWidthChar('A')).toBe(false);
    expect(detectDoubleWidthChar('😀')).toBe(true);
  });

  it('marks discontinuous neighbors when absolute indices skip', () => {
    const rows = [
      { absoluteIndex: 10 },
      { absoluteIndex: 12 },
      { absoluteIndex: 13 },
    ];

    expect(hasDiscontinuousNeighbor(rows, 0)).toBe(true);
    expect(hasDiscontinuousNeighbor(rows, 1)).toBe(true);
    expect(hasDiscontinuousNeighbor(rows, 2)).toBe(false);
  });
});
