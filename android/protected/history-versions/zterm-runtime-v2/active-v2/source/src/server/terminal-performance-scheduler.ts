export type TerminalLiveSyncLane = 'fast' | 'normal' | 'slow' | 'overloaded' | 'quiet';

export interface TerminalLiveSyncSchedulerInput {
  requestedDelayMs?: number;
  activeDelayMs: number;
  idleDelayMs: number;
  now: number;
  lastLiveActivityAt: number;
  consecutiveFailures: number;
  subscriberCount: number;
  lastCaptureDurationMs: number;
  lastCanonicalizeDurationMs: number;
  flushInFlight: boolean;
}

export interface TerminalLiveSyncScheduleDecision {
  delayMs: number;
  lane: TerminalLiveSyncLane;
  reason: string;
}

const FAST_LANE_DELAY_MS = 16;
// R9: zero-delay requested schedules still cap here so tmux capture can't be
// pulled into a tight CPU-bound loop by repeated explicit-immediate requests.
const FAST_LANE_MIN_DELAY_MS = 8;
const OVERLOADED_CAPTURE_MS = 120;
const SLOW_CAPTURE_MS = 64;
function finiteMs(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value || 0)) : fallback;
}

export function resolveTerminalLiveSyncDelay(
  input: TerminalLiveSyncSchedulerInput,
): TerminalLiveSyncScheduleDecision {
  const activeDelayMs = Math.max(1, finiteMs(input.activeDelayMs, 33));
  const idleDelayMs = Math.max(activeDelayMs, finiteMs(input.idleDelayMs, 120));
  const hasExplicitRequestedDelay = typeof input.requestedDelayMs === 'number' && Number.isFinite(input.requestedDelayMs);
  const requestedDelayMs = Number.isFinite(input.requestedDelayMs)
    ? Math.max(0, Math.floor(input.requestedDelayMs || 0))
    : activeDelayMs;
  if (hasExplicitRequestedDelay && requestedDelayMs === 0) {
    // R9: explicit-immediate returns 0; flushInFlight path already guards against
    // re-triggering mid-capture with a minimum 16ms floor. Removing the 8ms floor
    // here restores the contract for attach/input paths that call schedule(0).
    return { delayMs: 0, lane: 'fast', reason: 'explicit-immediate' };
  }
  if (requestedDelayMs > activeDelayMs) {
    // Idle-terminal quiet-capture backoff (the only caller that requests a
    // delay above the active cadence): honor it verbatim so the min-with-
    // activeDelayMs cap cannot collapse the backoff to 33ms.
    return { delayMs: requestedDelayMs, lane: 'quiet', reason: 'quiet-backoff' };
  }
  const subscriberCount = Math.max(0, Math.floor(input.subscriberCount || 0));
  if (subscriberCount <= 0) {
    return { delayMs: idleDelayMs, lane: 'slow', reason: 'no-subscribers' };
  }

  const failureCount = Math.max(0, Math.floor(input.consecutiveFailures || 0));
  if (failureCount > 0) {
    return {
      delayMs: Math.max(idleDelayMs, idleDelayMs * Math.min(failureCount + 1, 11)),
      lane: 'slow',
      reason: 'failure-backoff',
    };
  }

  if (input.flushInFlight) {
    // R9: if a capture is already in flight, force a minimum 16ms gap so the
    // next timer can't collapse to zero and lock the capture loop into a hot
    // spin. The activeDelayMs (33ms) is the recommended gap; 16ms is the
    // floor that still respects the new "no zero-delay capture" rule.
    return {
      delayMs: Math.max(activeDelayMs, FAST_LANE_MIN_DELAY_MS),
      lane: 'normal',
      reason: 'flush-in-flight',
    };
  }

  const captureCostMs = Math.max(0, Math.floor(input.lastCaptureDurationMs || 0))
    + Math.max(0, Math.floor(input.lastCanonicalizeDurationMs || 0));
  if (captureCostMs >= OVERLOADED_CAPTURE_MS) {
    return {
      delayMs: Math.min(1000, Math.max(idleDelayMs + activeDelayMs, Math.ceil(captureCostMs * 1.25))),
      lane: 'overloaded',
      reason: 'capture-over-budget',
    };
  }

  if (captureCostMs >= SLOW_CAPTURE_MS) {
    return {
      delayMs: Math.max(activeDelayMs, Math.ceil(captureCostMs)),
      lane: 'normal',
      reason: 'capture-normal-budget',
    };
  }

  if (requestedDelayMs <= activeDelayMs) {
    return {
      delayMs: Math.min(activeDelayMs, FAST_LANE_DELAY_MS),
      lane: 'fast',
      reason: 'subscribed-low-capture-cost',
    };
  }

  return {
    delayMs: Math.min(requestedDelayMs, activeDelayMs),
    lane: 'normal',
    reason: 'subscribed-active',
  };
}
