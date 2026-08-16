import type { TwoFingerWheelDebugSnapshot } from './types';

/**
 * Process-wide singleton snapshot of the two-finger mouse wheel gesture state
 * inside TerminalView. The debug overlay reads from this store to surface what
 * the gesture layer actually did, so the user can confirm whether a touch
 * gesture was detected, filtered, or aborted.
 */
export type { TwoFingerWheelDebugSnapshot };

const EMPTY_SNAPSHOT: TwoFingerWheelDebugSnapshot = {
  active: false,
  lockedDirection: null,
  initialSpanPx: 0,
  accumulatedDeltaPx: 0,
  lastSentDirection: null,
  lastSentAt: null,
  startCalls: 0,
  moveCalls: 0,
  endCalls: 0,
  abortedCount: 0,
  sentCount: 0,
  lastReason: "idle",
  lastEventAt: 0,
};

let snapshot: TwoFingerWheelDebugSnapshot = { ...EMPTY_SNAPSHOT };

export function getTwoFingerWheelDebugSnapshot(): TwoFingerWheelDebugSnapshot {
  return snapshot;
}

export function setTwoFingerWheelDebugSnapshot(
  next: TwoFingerWheelDebugSnapshot,
): void {
  snapshot = next;
}

export function resetTwoFingerWheelDebugSnapshot(): void {
  snapshot = { ...EMPTY_SNAPSHOT };
}
