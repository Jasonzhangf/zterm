export type TerminalLiveSyncLane = 'fast' | 'normal' | 'slow' | 'overloaded';

export interface TerminalLiveSyncSchedulerInput {
  requestedDelayMs?: number;
  activeDelayMs: number;
  idleDelayMs: number;
  now: number;
  lastProgressAt: number;
  consecutiveFailures: number;
  subscriberCount: number;
  transportBufferedBytes: number;
  transportBackpressureCount: number;
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
const BACKPRESSURE_BUFFERED_BYTES = 128 * 1024;
const OVERLOADED_CAPTURE_MS = 120;
const SLOW_CAPTURE_MS = 64;
const RECENT_PROGRESS_MS = 1500;

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
    return { delayMs: 0, lane: 'fast', reason: 'explicit-immediate' };
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
    return {
      delayMs: activeDelayMs,
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

  const bufferedBytes = Math.max(0, Math.floor(input.transportBufferedBytes || 0));
  const backpressureCount = Math.max(0, Math.floor(input.transportBackpressureCount || 0));
  if (bufferedBytes >= BACKPRESSURE_BUFFERED_BYTES || backpressureCount > 0) {
    return {
      delayMs: Math.max(idleDelayMs, activeDelayMs * (backpressureCount + 2)),
      lane: 'slow',
      reason: 'transport-backpressure',
    };
  }

  if (captureCostMs >= SLOW_CAPTURE_MS) {
    return {
      delayMs: Math.max(activeDelayMs, Math.ceil(captureCostMs)),
      lane: 'normal',
      reason: 'capture-normal-budget',
    };
  }

  const recentlyActive = input.lastProgressAt > 0 && input.now - input.lastProgressAt <= RECENT_PROGRESS_MS;
  if (recentlyActive && requestedDelayMs <= activeDelayMs && bufferedBytes === 0) {
    return {
      delayMs: Math.min(activeDelayMs, FAST_LANE_DELAY_MS),
      lane: 'fast',
      reason: 'good-transport-low-capture-cost',
    };
  }

  return {
    delayMs: Math.min(requestedDelayMs, recentlyActive ? activeDelayMs : idleDelayMs),
    lane: recentlyActive ? 'normal' : 'slow',
    reason: recentlyActive ? 'normal-active' : 'idle',
  };
}
