import {
  handleIgnoredProgrammaticScrollGuard,
  handlePendingFollowScrollGuard,
  handleRecentViewportLayoutScrollGuard,
  shouldQueueFollowRealignFromObservedScroll,
} from '../renderer';

interface RefLike<T> {
  current: T;
}

const scheduleTimeout = (callback: () => void) => globalThis.setTimeout(callback, 0) as unknown as number;
const cancelTimeout = (timer: number | null) => {
  if (timer !== null) {
    globalThis.clearTimeout(timer);
  }
};

export function markTerminalFollowViewportRealignOnLayoutDrift(options: {
  readingMode: boolean;
  viewportLayoutChanged: boolean;
  pendingFollowViewportRealignRef: RefLike<boolean>;
  viewportClientHeightPx: number;
  recentViewportLayoutChangeRef: RefLike<boolean>;
  recentViewportLayoutChangeTimerRef: RefLike<number | null>;
}) {
  if (options.readingMode || !options.viewportLayoutChanged) {
    return;
  }
  options.pendingFollowViewportRealignRef.current = true;
  if (options.viewportClientHeightPx <= 0) {
    return;
  }
  options.recentViewportLayoutChangeRef.current = true;
  if (options.recentViewportLayoutChangeTimerRef.current !== null) {
    cancelTimeout(options.recentViewportLayoutChangeTimerRef.current);
  }
  options.recentViewportLayoutChangeTimerRef.current = scheduleTimeout(() => {
    options.recentViewportLayoutChangeTimerRef.current = null;
    options.recentViewportLayoutChangeRef.current = false;
  });
}

export function queueTerminalFollowScrollSync(options: {
  nextRenderBottomIndex: number;
  minimumRenderBottomIndex: number;
  pendingFollowRenderBottomIndexRef: RefLike<number | null>;
  lastQueuedFollowRenderBottomIndexRef: RefLike<number | null>;
  pendingFollowScrollSyncRef: RefLike<boolean>;
  followScrollSyncTimerRef: RefLike<number | null>;
  guardPendingFollowDrift?: boolean;
  flushPendingRenderBottomIndex: () => void;
}) {
  const normalizedTarget = Math.max(options.minimumRenderBottomIndex, Math.floor(options.nextRenderBottomIndex));
  const samePendingTarget = options.pendingFollowRenderBottomIndexRef.current === normalizedTarget;
  const sameQueuedTarget = options.lastQueuedFollowRenderBottomIndexRef.current === normalizedTarget;
  if (
    samePendingTarget
    && sameQueuedTarget
    && (options.followScrollSyncTimerRef.current !== null || options.pendingFollowScrollSyncRef.current)
  ) {
    if (options.guardPendingFollowDrift) {
      options.pendingFollowScrollSyncRef.current = true;
    }
    return;
  }
  options.pendingFollowRenderBottomIndexRef.current = normalizedTarget;
  options.lastQueuedFollowRenderBottomIndexRef.current = normalizedTarget;
  options.pendingFollowScrollSyncRef.current = options.pendingFollowScrollSyncRef.current
    || Boolean(options.guardPendingFollowDrift);
  if (options.followScrollSyncTimerRef.current !== null) {
    return;
  }
  options.followScrollSyncTimerRef.current = scheduleTimeout(() => {
    options.followScrollSyncTimerRef.current = null;
    options.flushPendingRenderBottomIndex();
  });
}

export function cancelTerminalFollowScrollSync(options: {
  followScrollSyncTimerRef: RefLike<number | null>;
  recentViewportLayoutChangeTimerRef: RefLike<number | null>;
  pendingFollowRenderBottomIndexRef: RefLike<number | null>;
  pendingImmediateFollowScrollSyncRef: RefLike<boolean>;
  lastQueuedFollowRenderBottomIndexRef: RefLike<number | null>;
  pendingFollowScrollSyncRef: RefLike<boolean>;
  pendingFollowViewportRealignRef: RefLike<boolean>;
  recentViewportLayoutChangeRef: RefLike<boolean>;
  ignoredProgrammaticScrollTopRef: RefLike<number | null>;
}) {
  if (options.followScrollSyncTimerRef.current !== null) {
    cancelTimeout(options.followScrollSyncTimerRef.current);
    options.followScrollSyncTimerRef.current = null;
  }
  if (options.recentViewportLayoutChangeTimerRef.current !== null) {
    cancelTimeout(options.recentViewportLayoutChangeTimerRef.current);
    options.recentViewportLayoutChangeTimerRef.current = null;
  }
  options.pendingFollowRenderBottomIndexRef.current = null;
  options.pendingImmediateFollowScrollSyncRef.current = false;
  options.lastQueuedFollowRenderBottomIndexRef.current = null;
  options.pendingFollowScrollSyncRef.current = false;
  options.pendingFollowViewportRealignRef.current = false;
  options.recentViewportLayoutChangeRef.current = false;
  options.ignoredProgrammaticScrollTopRef.current = null;
}

export function flushTerminalFollowScrollSync(options: {
  refreshActive: boolean;
  readingMode: boolean;
  pendingFollowRenderBottomIndexRef: RefLike<number | null>;
  pendingImmediateFollowScrollSyncRef: RefLike<boolean>;
  followScrollSyncTimerRef: RefLike<number | null>;
  followVisualBottomIndex: number;
  syncScrollHostToRenderBottom: (nextRenderBottomIndex: number) => void;
}) {
  if (!options.refreshActive || options.readingMode) {
    return false;
  }
  const pendingRenderBottomIndex = options.pendingFollowRenderBottomIndexRef.current;
  const shouldSyncImmediately = options.pendingImmediateFollowScrollSyncRef.current;
  if (pendingRenderBottomIndex === null && !shouldSyncImmediately) {
    return false;
  }
  if (options.followScrollSyncTimerRef.current !== null) {
    cancelTimeout(options.followScrollSyncTimerRef.current);
    options.followScrollSyncTimerRef.current = null;
  }
  options.pendingFollowRenderBottomIndexRef.current = null;
  options.pendingImmediateFollowScrollSyncRef.current = false;
  options.syncScrollHostToRenderBottom(pendingRenderBottomIndex ?? options.followVisualBottomIndex);
  return true;
}

export function clearTerminalRecentViewportLayoutChange(options: {
  recentViewportLayoutChangeRef: RefLike<boolean>;
  recentViewportLayoutChangeTimerRef: RefLike<number | null>;
}) {
  options.recentViewportLayoutChangeRef.current = false;
  if (options.recentViewportLayoutChangeTimerRef.current !== null) {
    cancelTimeout(options.recentViewportLayoutChangeTimerRef.current);
    options.recentViewportLayoutChangeTimerRef.current = null;
  }
}

export function handleTerminalFollowModeScrollGuards(host: HTMLDivElement, options: {
  readingMode: boolean;
  recentViewportLayoutChangeRef: RefLike<boolean>;
  recentViewportLayoutChangeTimerRef: RefLike<number | null>;
  pendingFollowScrollSyncRef: RefLike<boolean>;
  pendingFollowRenderBottomIndexRef: RefLike<number | null>;
  pendingFollowViewportRealignRef: RefLike<boolean>;
  lastSettledScrollTopRef: RefLike<number>;
  ignoredProgrammaticScrollTopRef: RefLike<number | null>;
  maxScrollTop: number;
  queueFollowVisualRealign: (options?: { guardPendingFollowDrift?: boolean; renderBottomIndex?: number }) => void;
  cancelPendingFollowScrollSync: () => void;
}) {
  if (options.readingMode) {
    return false;
  }

  if (handleRecentViewportLayoutScrollGuard({
    recentViewportLayoutChangeRef: options.recentViewportLayoutChangeRef,
    clearRecentViewportLayoutChange: () => clearTerminalRecentViewportLayoutChange({
      recentViewportLayoutChangeRef: options.recentViewportLayoutChangeRef,
      recentViewportLayoutChangeTimerRef: options.recentViewportLayoutChangeTimerRef,
    }),
    queueFollowVisualRealign: options.queueFollowVisualRealign,
  })) {
    return true;
  }

  if (handlePendingFollowScrollGuard(host, {
    pendingFollowScrollSyncRef: options.pendingFollowScrollSyncRef,
    pendingFollowRenderBottomIndexRef: options.pendingFollowRenderBottomIndexRef,
    pendingFollowViewportRealignRef: options.pendingFollowViewportRealignRef,
    lastSettledScrollTopRef: options.lastSettledScrollTopRef,
    queueFollowVisualRealign: options.queueFollowVisualRealign,
    cancelPendingFollowScrollSync: options.cancelPendingFollowScrollSync,
  })) {
    return true;
  }

  if (handleIgnoredProgrammaticScrollGuard(host, {
    ignoredProgrammaticScrollTopRef: options.ignoredProgrammaticScrollTopRef,
    lastSettledScrollTopRef: options.lastSettledScrollTopRef,
  })) {
    return true;
  }

  if (shouldQueueFollowRealignFromObservedScroll(host, {
    lastSettledScrollTopRef: options.lastSettledScrollTopRef,
    maxScrollTop: options.maxScrollTop,
  })) {
    options.queueFollowVisualRealign({
      guardPendingFollowDrift: true,
    });
    return true;
  }

  return false;
}

export function alignTerminalRenderBottomToFollow(options: {
  followVisualBottomIndex: number;
  resetReportedViewport?: boolean;
  guardPendingFollowDrift?: boolean;
  queueScrollSync?: boolean;
  immediateScrollSync?: boolean;
  resetFollowViewportReport: () => void;
  setFollowModeState: (nextRenderBottomIndex: number) => void;
  scheduleFollowScrollRealign: (
    nextRenderBottomIndex: number,
    options?: {
      guardPendingFollowDrift?: boolean;
      queueScrollSync?: boolean;
      immediateScrollSync?: boolean;
    },
  ) => void;
  emitFollowViewportDemand: (nextRenderBottomIndex: number) => void;
}) {
  const nextRenderBottomIndex = options.followVisualBottomIndex;
  if (options.resetReportedViewport) {
    options.resetFollowViewportReport();
  }
  options.setFollowModeState(nextRenderBottomIndex);
  options.scheduleFollowScrollRealign(nextRenderBottomIndex, {
    guardPendingFollowDrift: options.guardPendingFollowDrift,
    queueScrollSync: options.queueScrollSync,
    immediateScrollSync: options.immediateScrollSync,
  });
  options.emitFollowViewportDemand(nextRenderBottomIndex);
  return nextRenderBottomIndex;
}

export function reconcileTerminalViewportAfterBufferShift(options: {
  refreshActive: boolean;
  readingMode: boolean;
  hasSettledFollowFrame: boolean;
  effectiveRenderBottomIndex: number;
  followVisualBottomIndex: number;
  minimumRenderBottomIndex: number;
  maximumRenderBottomIndex: number;
  maxScrollTop: number;
  alignRenderBottomToFollow: (options?: {
    resetReportedViewport?: boolean;
    guardPendingFollowDrift?: boolean;
    queueScrollSync?: boolean;
    immediateScrollSync?: boolean;
  }) => number;
  setRenderBottomIndex: (nextRenderBottomIndex: number) => void;
  emitReadingRenderDemand: (nextRenderBottomIndex?: number) => void;
}) {
  if (!options.refreshActive) {
    return;
  }
  if (!options.readingMode) {
    options.alignRenderBottomToFollow({
      guardPendingFollowDrift: options.hasSettledFollowFrame,
    });
    return;
  }
  if (options.effectiveRenderBottomIndex >= options.followVisualBottomIndex) {
    options.alignRenderBottomToFollow();
    return;
  }

  const nextRenderBottomIndex = Math.max(
    options.minimumRenderBottomIndex,
    Math.min(options.maximumRenderBottomIndex, Math.floor(options.effectiveRenderBottomIndex)),
  );
  if (options.maxScrollTop <= 1) {
    options.alignRenderBottomToFollow();
    return;
  }
  if (nextRenderBottomIndex !== options.effectiveRenderBottomIndex) {
    options.setRenderBottomIndex(nextRenderBottomIndex);
  }
  options.emitReadingRenderDemand(nextRenderBottomIndex);
}

export function computeFollowRealignAfterBufferShift(options: {
  refreshActive: boolean;
  readingMode: boolean;
  previousPaddingTopPx: number | null;
  nextPaddingTopPx: number;
  viewportClientHeightPx: number;
  maxScrollTop: number;
}) {
  const previousPaddingTopPx = typeof options.previousPaddingTopPx === 'number'
    && Number.isFinite(options.previousPaddingTopPx)
    ? Math.max(0, options.previousPaddingTopPx)
    : null;
  const nextPaddingTopPx = Number.isFinite(options.nextPaddingTopPx)
    ? Math.max(0, options.nextPaddingTopPx)
    : 0;
  const viewportClientHeightPx = Number.isFinite(options.viewportClientHeightPx)
    ? Math.max(0, options.viewportClientHeightPx)
    : 0;
  const targetScrollTop = Number.isFinite(options.maxScrollTop)
    ? Math.max(0, options.maxScrollTop)
    : 0;
  const paddingDeltaPx = previousPaddingTopPx === null
    ? 0
    : Math.abs(nextPaddingTopPx - previousPaddingTopPx);
  const needsImmediateRealign = Boolean(
    options.refreshActive
    && !options.readingMode
    && previousPaddingTopPx !== null
    && viewportClientHeightPx > 0
    && paddingDeltaPx > viewportClientHeightPx
  );

  return {
    needsImmediateRealign,
    targetScrollTop,
    paddingDeltaPx,
  };
}
