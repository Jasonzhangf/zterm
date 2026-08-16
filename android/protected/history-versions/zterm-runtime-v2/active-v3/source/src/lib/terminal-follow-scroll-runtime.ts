export type TerminalFollowScrollPhase =
  | 'idle-follow'
  | 'pending-follow-sync'
  | 'programmatic-scroll'
  | 'layout-settling'
  | 'user-scroll-intent'
  | 'reading';

interface TerminalFollowScrollBaseState {
  lastSettledScrollTop: number;
  hasSettledFollowFrame: boolean;
  userScrollIntentUntil: number;
  ignoredProgrammaticScrollTop: number | null;
}

export type TerminalFollowScrollIdleState = TerminalFollowScrollBaseState & {
  phase: 'idle-follow';
};

export type TerminalFollowScrollUserIntentState = TerminalFollowScrollBaseState & {
  phase: 'user-scroll-intent';
};

export type TerminalFollowScrollReadingState = Omit<
  TerminalFollowScrollBaseState,
  'ignoredProgrammaticScrollTop'
> & {
  phase: 'reading';
  ignoredProgrammaticScrollTop: null;
};

export type TerminalFollowScrollProgrammaticState = TerminalFollowScrollBaseState & {
  phase: 'programmatic-scroll';
  targetScrollTop: number;
  ignoredProgrammaticScrollTop: number;
};

export type TerminalFollowScrollLayoutSettlingState = TerminalFollowScrollBaseState & {
  phase: 'layout-settling';
  pendingViewportRealign: true;
  recentViewportLayoutChange: boolean;
};

export type TerminalFollowScrollPendingState = TerminalFollowScrollBaseState & {
  phase: 'pending-follow-sync';
  pendingRenderBottomIndex: number | null;
  lastQueuedRenderBottomIndex: number | null;
  pendingViewportRealign: boolean;
  guardPendingFollowDrift: boolean;
  immediate: boolean;
  recentViewportLayoutChange: boolean;
};

export type TerminalFollowScrollState =
  | TerminalFollowScrollIdleState
  | TerminalFollowScrollUserIntentState
  | TerminalFollowScrollReadingState
  | TerminalFollowScrollProgrammaticState
  | TerminalFollowScrollLayoutSettlingState
  | TerminalFollowScrollPendingState;

export type TerminalFollowScrollEffect =
  | { type: 'schedule-follow-flush' }
  | { type: 'cancel-follow-flush' }
  | { type: 'set-scroll-top'; scrollTop: number }
  | { type: 'set-mode'; mode: 'follow' | 'reading' }
  | { type: 'set-render-bottom-index'; renderBottomIndex: number }
  | { type: 'emit-viewport-demand'; mode: 'follow' | 'reading'; renderBottomIndex: number }
  | { type: 'mark-layout-settling' }
  | { type: 'clear-layout-settling' };

export interface TerminalFollowScrollTransition {
  state: TerminalFollowScrollState;
  effects: TerminalFollowScrollEffect[];
}

function normalizeScrollTop(scrollTop: number) {
  return Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
}

function readBaseState(
  input: Partial<TerminalFollowScrollBaseState> = {},
): TerminalFollowScrollBaseState {
  return {
    lastSettledScrollTop: normalizeScrollTop(input.lastSettledScrollTop ?? 0),
    hasSettledFollowFrame: Boolean(input.hasSettledFollowFrame),
    userScrollIntentUntil: Math.max(0, input.userScrollIntentUntil ?? 0),
    ignoredProgrammaticScrollTop: input.ignoredProgrammaticScrollTop ?? null,
  };
}

function toIdleFollowState(
  state: Partial<TerminalFollowScrollBaseState> = {},
): TerminalFollowScrollIdleState {
  return {
    ...readBaseState(state),
    phase: 'idle-follow',
  };
}

function toPendingFollowState(
  state: TerminalFollowScrollState,
  input: {
    pendingRenderBottomIndex: number | null;
    lastQueuedRenderBottomIndex: number | null;
    pendingViewportRealign?: boolean;
    guardPendingFollowDrift?: boolean;
    immediate?: boolean;
    recentViewportLayoutChange?: boolean;
  },
): TerminalFollowScrollPendingState {
  return {
    ...readBaseState(state),
    phase: 'pending-follow-sync',
    pendingRenderBottomIndex: input.pendingRenderBottomIndex,
    lastQueuedRenderBottomIndex: input.lastQueuedRenderBottomIndex,
    pendingViewportRealign: Boolean(input.pendingViewportRealign),
    guardPendingFollowDrift: Boolean(input.guardPendingFollowDrift),
    immediate: Boolean(input.immediate),
    recentViewportLayoutChange: Boolean(input.recentViewportLayoutChange),
  };
}

export function createTerminalFollowScrollState(
  input: Partial<TerminalFollowScrollBaseState> & {
    phase?: TerminalFollowScrollPhase;
  } = {},
): TerminalFollowScrollState {
  const base = readBaseState(input);
  if (input.phase === 'reading') {
    return {
      ...base,
      phase: 'reading',
      ignoredProgrammaticScrollTop: null,
    };
  }
  if (input.phase === 'user-scroll-intent') {
    return {
      ...base,
      phase: 'user-scroll-intent',
    };
  }
  return toIdleFollowState(base);
}

export function isTerminalFollowScrollReading(state: TerminalFollowScrollState) {
  return state.phase === 'reading';
}

export function getTerminalFollowLastSettledScrollTop(
  state: TerminalFollowScrollState,
) {
  return state.lastSettledScrollTop;
}

export function hasTerminalFollowSettledFrame(
  state: TerminalFollowScrollState,
) {
  return state.hasSettledFollowFrame;
}

export function getTerminalFollowPendingRenderBottomIndex(
  state: TerminalFollowScrollState,
) {
  return state.phase === 'pending-follow-sync'
    ? state.pendingRenderBottomIndex
    : null;
}

export function hasTerminalFollowPendingDriftGuard(
  state: TerminalFollowScrollState,
) {
  return state.phase === 'pending-follow-sync' && state.guardPendingFollowDrift;
}

export function hasTerminalFollowPendingViewportRealign(
  state: TerminalFollowScrollState,
) {
  return (
    (state.phase === 'pending-follow-sync' && state.pendingViewportRealign)
    || state.phase === 'layout-settling'
  );
}

export function hasTerminalFollowRecentViewportLayoutChange(
  state: TerminalFollowScrollState,
) {
  return (
    (state.phase === 'pending-follow-sync' && state.recentViewportLayoutChange)
    || (state.phase === 'layout-settling' && state.recentViewportLayoutChange)
  );
}

export function hasTerminalUserScrollIntent(
  state: Pick<TerminalFollowScrollBaseState, 'userScrollIntentUntil'>,
  now: number,
) {
  return state.userScrollIntentUntil > now;
}

export function markTerminalUserScrollIntent(
  state: TerminalFollowScrollState,
  now: number,
  durationMs = 250,
): TerminalFollowScrollTransition {
  const nextBase = {
    ...state,
    userScrollIntentUntil: now + Math.max(16, durationMs),
  };
  if (state.phase === 'reading') {
    return { state: { ...nextBase, phase: 'reading', ignoredProgrammaticScrollTop: null }, effects: [] };
  }
  return {
    state: {
      ...nextBase,
      phase: 'user-scroll-intent',
    },
    effects: [],
  };
}

export function queueTerminalFollowScrollRuntime(
  state: TerminalFollowScrollState,
  input: {
    renderBottomIndex: number;
    minimumRenderBottomIndex: number;
    guardPendingFollowDrift?: boolean;
    immediate?: boolean;
    readingMode?: boolean;
  },
): TerminalFollowScrollTransition {
  if (input.readingMode || state.phase === 'reading') {
    return { state, effects: [] };
  }
  const target = Math.max(
    input.minimumRenderBottomIndex,
    Math.floor(input.renderBottomIndex),
  );
  const enteringPending = state.phase !== 'pending-follow-sync';
  const samePendingTarget = !enteringPending
    && state.pendingRenderBottomIndex === target
    && state.lastQueuedRenderBottomIndex === target;
  const previousPendingViewportRealign = state.phase === 'pending-follow-sync'
    ? state.pendingViewportRealign
    : state.phase === 'layout-settling';
  const previousRecentLayout = state.phase === 'pending-follow-sync'
    ? state.recentViewportLayoutChange
    : state.phase === 'layout-settling' && state.recentViewportLayoutChange;
  const previousGuard = state.phase === 'pending-follow-sync'
    ? state.guardPendingFollowDrift
    : false;
  const previousImmediate = state.phase === 'pending-follow-sync'
    ? state.immediate
    : false;
  const nextState = toPendingFollowState(state, {
    pendingRenderBottomIndex: target,
    lastQueuedRenderBottomIndex: target,
    pendingViewportRealign: previousPendingViewportRealign,
    guardPendingFollowDrift: previousGuard || Boolean(input.guardPendingFollowDrift),
    immediate: previousImmediate || Boolean(input.immediate),
    recentViewportLayoutChange: previousRecentLayout,
  });
  return {
    state: nextState,
    effects: enteringPending || !samePendingTarget
      ? enteringPending ? [{ type: 'schedule-follow-flush' }] : []
      : [],
  };
}

export function markTerminalFollowImmediateSyncRuntime(
  state: TerminalFollowScrollState,
): TerminalFollowScrollTransition {
  if (state.phase === 'reading') {
    return { state, effects: [] };
  }
  if (state.phase === 'pending-follow-sync') {
    return {
      state: {
        ...state,
        immediate: true,
      },
      effects: [],
    };
  }
  return {
    state: toPendingFollowState(state, {
      pendingRenderBottomIndex: null,
      lastQueuedRenderBottomIndex: null,
      immediate: true,
    }),
    effects: [{ type: 'schedule-follow-flush' }],
  };
}

export function flushTerminalFollowScrollRuntime(
  state: TerminalFollowScrollState,
  input: {
    refreshActive: boolean;
    readingMode: boolean;
    followVisualBottomIndex: number;
    resolveScrollTop: (renderBottomIndex: number) => number;
  },
): TerminalFollowScrollTransition {
  if (
    !input.refreshActive
    || input.readingMode
    || state.phase === 'reading'
    || state.phase !== 'pending-follow-sync'
  ) {
    return { state, effects: [] };
  }
  const shouldFlush = state.pendingRenderBottomIndex !== null || state.immediate;
  if (!shouldFlush) {
    return { state, effects: [] };
  }
  const renderBottomIndex = state.pendingRenderBottomIndex ?? input.followVisualBottomIndex;
  const scrollTop = normalizeScrollTop(input.resolveScrollTop(renderBottomIndex));
  return {
    state: {
      ...readBaseState({
        ...state,
        lastSettledScrollTop: scrollTop,
        hasSettledFollowFrame: true,
        ignoredProgrammaticScrollTop: scrollTop,
      }),
      phase: 'programmatic-scroll',
      targetScrollTop: scrollTop,
      ignoredProgrammaticScrollTop: scrollTop,
    },
    effects: [
      { type: 'cancel-follow-flush' },
      { type: 'set-scroll-top', scrollTop },
    ],
  };
}

export function commitProgrammaticTerminalScrollRuntime(
  state: TerminalFollowScrollState,
  targetScrollTop: number,
): TerminalFollowScrollTransition {
  const scrollTop = normalizeScrollTop(targetScrollTop);
  return {
    state: {
      ...readBaseState({
        ...state,
        lastSettledScrollTop: scrollTop,
        hasSettledFollowFrame: true,
        ignoredProgrammaticScrollTop: scrollTop,
      }),
      phase: 'programmatic-scroll',
      targetScrollTop: scrollTop,
      ignoredProgrammaticScrollTop: scrollTop,
    },
    effects: [{ type: 'set-scroll-top', scrollTop }],
  };
}

export function consumeIgnoredProgrammaticScrollRuntime(
  state: TerminalFollowScrollState,
  observedScrollTop: number,
) {
  const ignoredTarget = state.ignoredProgrammaticScrollTop;
  if (
    ignoredTarget === null
    || Math.abs(normalizeScrollTop(observedScrollTop) - ignoredTarget) > 1
  ) {
    return { consumed: false, state };
  }
  return {
    consumed: true,
    state: toIdleFollowState({
      ...state,
      lastSettledScrollTop: normalizeScrollTop(observedScrollTop),
      ignoredProgrammaticScrollTop: null,
    }),
  };
}

export function markTerminalViewportLayoutDriftRuntime(
  state: TerminalFollowScrollState,
  input: {
    readingMode: boolean;
    viewportLayoutChanged: boolean;
    viewportClientHeightPx: number;
  },
): TerminalFollowScrollTransition {
  if (input.readingMode || state.phase === 'reading' || !input.viewportLayoutChanged) {
    return { state, effects: [] };
  }
  const recentViewportLayoutChange = input.viewportClientHeightPx > 0;
  if (state.phase === 'pending-follow-sync') {
    return {
      state: {
        ...state,
        pendingViewportRealign: true,
        recentViewportLayoutChange:
          state.recentViewportLayoutChange || recentViewportLayoutChange,
      },
      effects: recentViewportLayoutChange ? [{ type: 'mark-layout-settling' }] : [],
    };
  }
  return {
    state: {
      ...readBaseState(state),
      phase: 'layout-settling',
      pendingViewportRealign: true,
      recentViewportLayoutChange,
    },
    effects: recentViewportLayoutChange ? [{ type: 'mark-layout-settling' }] : [],
  };
}

export function clearTerminalViewportLayoutDriftRuntime(
  state: TerminalFollowScrollState,
): TerminalFollowScrollTransition {
  if (state.phase === 'pending-follow-sync') {
    return {
      state: {
        ...state,
        recentViewportLayoutChange: false,
      },
      effects: [{ type: 'clear-layout-settling' }],
    };
  }
  if (state.phase === 'layout-settling') {
    return {
      state: {
        ...state,
        recentViewportLayoutChange: false,
      },
      effects: [{ type: 'clear-layout-settling' }],
    };
  }
  return {
    state,
    effects: [{ type: 'clear-layout-settling' }],
  };
}

export function resolveTerminalScrollObservationRuntime(
  state: TerminalFollowScrollState,
  input: {
    nextMode: 'follow' | 'reading';
    nextRenderBottomIndex: number;
    observedScrollTop: number;
    now: number;
    upwardAwayFromSettledBottom: boolean;
  },
): TerminalFollowScrollTransition {
  if (input.nextMode === 'reading') {
    const canEnterReading = state.phase === 'reading'
      || hasTerminalUserScrollIntent(state, input.now)
      || input.upwardAwayFromSettledBottom;
    if (!canEnterReading) {
      return {
        state: toPendingFollowState(state, {
          pendingRenderBottomIndex: null,
          lastQueuedRenderBottomIndex: null,
          pendingViewportRealign: true,
          guardPendingFollowDrift: true,
        }),
        effects: [{ type: 'schedule-follow-flush' }],
      };
    }
    return {
      state: {
        ...readBaseState({
          ...state,
          lastSettledScrollTop: input.observedScrollTop,
          ignoredProgrammaticScrollTop: null,
        }),
        phase: 'reading',
        ignoredProgrammaticScrollTop: null,
      },
      effects: [
        { type: 'set-mode', mode: 'reading' },
        { type: 'set-render-bottom-index', renderBottomIndex: input.nextRenderBottomIndex },
        { type: 'emit-viewport-demand', mode: 'reading', renderBottomIndex: input.nextRenderBottomIndex },
      ],
    };
  }

  return {
    state: toIdleFollowState({
      ...state,
      lastSettledScrollTop: input.observedScrollTop,
      ignoredProgrammaticScrollTop: null,
    }),
    effects: [
      { type: 'set-mode', mode: 'follow' },
      { type: 'set-render-bottom-index', renderBottomIndex: input.nextRenderBottomIndex },
      { type: 'emit-viewport-demand', mode: 'follow', renderBottomIndex: input.nextRenderBottomIndex },
    ],
  };
}

export function resetTerminalFollowScrollRuntime(
  state: TerminalFollowScrollState,
  input: {
    followVisualBottomIndex: number;
    minimumRenderBottomIndex: number;
    immediate?: boolean;
  },
): TerminalFollowScrollTransition {
  const idleState = toIdleFollowState({
    ...state,
    ignoredProgrammaticScrollTop: null,
  });
  const queued = queueTerminalFollowScrollRuntime(idleState, {
    renderBottomIndex: input.followVisualBottomIndex,
    minimumRenderBottomIndex: input.minimumRenderBottomIndex,
    immediate: input.immediate,
  });
  return {
    state: queued.state,
    effects: [
      { type: 'set-mode', mode: 'follow' },
      { type: 'set-render-bottom-index', renderBottomIndex: input.followVisualBottomIndex },
      { type: 'emit-viewport-demand', mode: 'follow', renderBottomIndex: input.followVisualBottomIndex },
      ...queued.effects,
    ],
  };
}

export function cancelTerminalFollowScrollRuntime(
  state: TerminalFollowScrollState,
): TerminalFollowScrollTransition {
  return {
    state: toIdleFollowState({
      lastSettledScrollTop: state.lastSettledScrollTop,
      hasSettledFollowFrame: state.hasSettledFollowFrame,
    }),
    effects: [
      { type: 'cancel-follow-flush' },
      { type: 'clear-layout-settling' },
    ],
  };
}
