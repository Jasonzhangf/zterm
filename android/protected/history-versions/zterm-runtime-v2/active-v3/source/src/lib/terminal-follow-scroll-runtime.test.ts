import { describe, expect, it } from 'vitest';
import {
  cancelTerminalFollowScrollRuntime,
  commitProgrammaticTerminalScrollRuntime,
  consumeIgnoredProgrammaticScrollRuntime,
  createTerminalFollowScrollState,
  flushTerminalFollowScrollRuntime,
  getTerminalFollowPendingRenderBottomIndex,
  hasTerminalFollowPendingDriftGuard,
  hasTerminalFollowPendingViewportRealign,
  hasTerminalFollowRecentViewportLayoutChange,
  hasTerminalUserScrollIntent,
  isTerminalFollowScrollReading,
  markTerminalUserScrollIntent,
  markTerminalViewportLayoutDriftRuntime,
  queueTerminalFollowScrollRuntime,
  resetTerminalFollowScrollRuntime,
  resolveTerminalScrollObservationRuntime,
  type TerminalFollowScrollState,
} from './terminal-follow-scroll-runtime';

const resolveScrollTop = (renderBottomIndex: number) => renderBottomIndex * 10;

describe('terminal-follow-scroll-runtime', () => {
  it('queues one follow sync and dedupes the same target without stacking effects', () => {
    const initial = createTerminalFollowScrollState();

    const first = queueTerminalFollowScrollRuntime(initial, {
      renderBottomIndex: 40,
      minimumRenderBottomIndex: 10,
      guardPendingFollowDrift: true,
    });

    expect(first.state).toEqual(expect.objectContaining({
      phase: 'pending-follow-sync',
      pendingRenderBottomIndex: 40,
      lastQueuedRenderBottomIndex: 40,
      guardPendingFollowDrift: true,
    }));
    expect(first.effects).toEqual([{ type: 'schedule-follow-flush' }]);

    const second = queueTerminalFollowScrollRuntime(first.state, {
      renderBottomIndex: 40,
      minimumRenderBottomIndex: 10,
    });

    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual([]);
  });

  it('does not allow reading mode to carry a pending follow sync', () => {
    const reading = createTerminalFollowScrollState({ phase: 'reading' });

    const queued = queueTerminalFollowScrollRuntime(reading, {
      renderBottomIndex: 12,
      minimumRenderBottomIndex: 0,
    });

    expect(queued.state).toEqual(reading);
    expect(queued.effects).toEqual([]);
    expect(isTerminalFollowScrollReading(queued.state)).toBe(true);
    expect('pendingRenderBottomIndex' in queued.state).toBe(false);
    expect(getTerminalFollowPendingRenderBottomIndex(queued.state)).toBeNull();
  });

  it('flushes pending follow sync into one programmatic scroll effect', () => {
    const queued = queueTerminalFollowScrollRuntime(createTerminalFollowScrollState(), {
      renderBottomIndex: 25,
      minimumRenderBottomIndex: 0,
    });

    const flushed = flushTerminalFollowScrollRuntime(queued.state, {
      refreshActive: true,
      readingMode: false,
      followVisualBottomIndex: 99,
      resolveScrollTop,
    });

    expect(flushed.state).toEqual(expect.objectContaining({
      phase: 'programmatic-scroll',
      targetScrollTop: 250,
      ignoredProgrammaticScrollTop: 250,
      lastSettledScrollTop: 250,
      hasSettledFollowFrame: true,
    }));
    expect(flushed.effects).toEqual([
      { type: 'cancel-follow-flush' },
      { type: 'set-scroll-top', scrollTop: 250 },
    ]);
  });

  it('does not flush while inactive or reading', () => {
    const queued = queueTerminalFollowScrollRuntime(createTerminalFollowScrollState(), {
      renderBottomIndex: 25,
      minimumRenderBottomIndex: 0,
    });

    expect(flushTerminalFollowScrollRuntime(queued.state, {
      refreshActive: false,
      readingMode: false,
      followVisualBottomIndex: 99,
      resolveScrollTop,
    })).toEqual({ state: queued.state, effects: [] });

    expect(flushTerminalFollowScrollRuntime(queued.state, {
      refreshActive: true,
      readingMode: true,
      followVisualBottomIndex: 99,
      resolveScrollTop,
    })).toEqual({ state: queued.state, effects: [] });
  });

  it('consumes programmatic scroll suppression once', () => {
    const committed = commitProgrammaticTerminalScrollRuntime(
      createTerminalFollowScrollState(),
      123,
    );

    const consumed = consumeIgnoredProgrammaticScrollRuntime(committed.state, 123);
    expect(consumed.consumed).toBe(true);
    expect(consumed.state).toEqual(expect.objectContaining({
      phase: 'idle-follow',
      ignoredProgrammaticScrollTop: null,
      lastSettledScrollTop: 123,
    }));

    const second = consumeIgnoredProgrammaticScrollRuntime(consumed.state, 123);
    expect(second.consumed).toBe(false);
    expect(second.state).toEqual(consumed.state);
  });

  it('marks real user intent and only then enters reading on scroll observation', () => {
    const marked = markTerminalUserScrollIntent(
      createTerminalFollowScrollState({ lastSettledScrollTop: 300 }),
      1_000,
      250,
    );
    expect(marked.state.phase).toBe('user-scroll-intent');
    expect(hasTerminalUserScrollIntent(marked.state, 1_100)).toBe(true);

    const reading = resolveTerminalScrollObservationRuntime(marked.state, {
      nextMode: 'reading',
      nextRenderBottomIndex: 20,
      observedScrollTop: 160,
      now: 1_100,
      upwardAwayFromSettledBottom: false,
    });

    expect(reading.state).toEqual(expect.objectContaining({
      phase: 'reading',
      lastSettledScrollTop: 160,
    }));
    expect(reading.effects).toEqual([
      { type: 'set-mode', mode: 'reading' },
      { type: 'set-render-bottom-index', renderBottomIndex: 20 },
      { type: 'emit-viewport-demand', mode: 'reading', renderBottomIndex: 20 },
    ]);
  });

  it('keeps layout drift in follow mode and queues guarded realign instead of reading', () => {
    const layout = markTerminalViewportLayoutDriftRuntime(
      createTerminalFollowScrollState({ lastSettledScrollTop: 300 }),
      {
        readingMode: false,
        viewportLayoutChanged: true,
        viewportClientHeightPx: 480,
      },
    );

    expect(layout.state).toEqual(expect.objectContaining({
      phase: 'layout-settling',
      pendingViewportRealign: true,
      recentViewportLayoutChange: true,
    }));
    expect(layout.effects).toEqual([{ type: 'mark-layout-settling' }]);

    const observed = resolveTerminalScrollObservationRuntime(layout.state, {
      nextMode: 'reading',
      nextRenderBottomIndex: 17,
      observedScrollTop: 299,
      now: 2_000,
      upwardAwayFromSettledBottom: false,
    });

    expect(observed.state).toEqual(expect.objectContaining({
      phase: 'pending-follow-sync',
      pendingViewportRealign: true,
      guardPendingFollowDrift: true,
    }));
    expect(observed.effects).toEqual([{ type: 'schedule-follow-flush' }]);
  });

  it('tracks layout and pending selectors without exposing pending fields on non-pending phases', () => {
    const layout = markTerminalViewportLayoutDriftRuntime(
      createTerminalFollowScrollState(),
      {
        readingMode: false,
        viewportLayoutChanged: true,
        viewportClientHeightPx: 100,
      },
    );
    expect(hasTerminalFollowPendingViewportRealign(layout.state)).toBe(true);
    expect(hasTerminalFollowRecentViewportLayoutChange(layout.state)).toBe(true);
    expect(hasTerminalFollowPendingDriftGuard(layout.state)).toBe(false);
    expect(getTerminalFollowPendingRenderBottomIndex(layout.state)).toBeNull();
    expect('pendingRenderBottomIndex' in layout.state).toBe(false);
  });

  it('reset returns reading to follow and queues a new sync demand', () => {
    const reading: TerminalFollowScrollState = {
      phase: 'reading',
      lastSettledScrollTop: 50,
      hasSettledFollowFrame: true,
      userScrollIntentUntil: 0,
      ignoredProgrammaticScrollTop: null,
    };

    const reset = resetTerminalFollowScrollRuntime(reading, {
      followVisualBottomIndex: 45,
      minimumRenderBottomIndex: 10,
      immediate: true,
    });

    expect(reset.state).toEqual(expect.objectContaining({
      phase: 'pending-follow-sync',
      pendingRenderBottomIndex: 45,
      immediate: true,
    }));
    expect(reset.effects).toEqual([
      { type: 'set-mode', mode: 'follow' },
      { type: 'set-render-bottom-index', renderBottomIndex: 45 },
      { type: 'emit-viewport-demand', mode: 'follow', renderBottomIndex: 45 },
      { type: 'schedule-follow-flush' },
    ]);
  });

  it('cancel clears pending, layout and ignored programmatic state', () => {
    const queued = queueTerminalFollowScrollRuntime(
      createTerminalFollowScrollState({ ignoredProgrammaticScrollTop: 10 }),
      {
        renderBottomIndex: 42,
        minimumRenderBottomIndex: 0,
        guardPendingFollowDrift: true,
      },
    );

    const cancelled = cancelTerminalFollowScrollRuntime(queued.state);

    expect(cancelled.state).toEqual({
      phase: 'idle-follow',
      lastSettledScrollTop: 0,
      hasSettledFollowFrame: false,
      userScrollIntentUntil: 0,
      ignoredProgrammaticScrollTop: null,
    });
    expect(cancelled.effects).toEqual([
      { type: 'cancel-follow-flush' },
      { type: 'clear-layout-settling' },
    ]);
  });
});
