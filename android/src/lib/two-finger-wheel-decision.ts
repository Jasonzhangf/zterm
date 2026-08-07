
/**
 * Pure decision logic for the two-finger mouse-wheel gesture.
 *
 * The intent: a vertical two-finger drag should emit SGR mouse wheel events
 * so TUIs (OpenCode / Codex) can scroll their internal history. A pinch
 * (two-finger span change) should NOT emit any wheel events.
 *
 * Three rules:
 *   1. If the live span deviates from the initial span by more than
 *      `pinchRatio`, abort the gesture (it is a zoom).
 *   2. Direction lock: once a direction (up/down) is committed, the user must
 *      accumulate at least `directionLockPx` in the opposite direction before
 *      the lock releases. This prevents threshold-boundary oscillation.
 *   3. Wheel notches: emit one notch per `stepPx` of cumulative motion in the
 *      committed direction, with the fractional remainder kept so subsequent
 *      moves can emit again immediately.
 */
export type WheelDirection = "up" | "down";

export type TwoFingerWheelSample = {
  midYDeltaPx: number;
  liveSpanPx: number;
};

export type TwoFingerWheelConfig = {
  stepPx: number;
  pinchRatio: number;
  directionLockPx: number;
  minInitialSpanPx: number;
};

export const DEFAULT_TWO_FINGER_WHEEL_CONFIG: TwoFingerWheelConfig = {
  stepPx: 24,
  pinchRatio: 0.35,
  directionLockPx: 48,
  minInitialSpanPx: 24,
};

export type TwoFingerWheelInternal = {
  active: boolean;
  initialSpanPx: number;
  accumulatedDeltaPx: number;
  lockedDirection: WheelDirection | null;
};

export function createTwoFingerWheelInitial(): TwoFingerWheelInternal {
  return {
    active: true,
    initialSpanPx: 0,
    accumulatedDeltaPx: 0,
    lockedDirection: null,
  };
}

export type TwoFingerWheelDecision = {
  /** Mutated internal state for the next call. */
  next: TwoFingerWheelInternal;
  /** Whether the gesture has been aborted (pinch detected). */
  aborted: boolean;
  /** Direction to emit, or null when no notch crossed the step threshold. */
  direction: WheelDirection | null;
  /** Number of wheel notches to emit this sample (0 or >=1). */
  steps: number;
};

export function decideTwoFingerWheel(
  state: TwoFingerWheelInternal,
  sample: TwoFingerWheelSample,
  config: TwoFingerWheelConfig = DEFAULT_TWO_FINGER_WHEEL_CONFIG,
): TwoFingerWheelDecision {
  const next: TwoFingerWheelInternal = {
    active: state.active,
    initialSpanPx: state.initialSpanPx,
    accumulatedDeltaPx: state.accumulatedDeltaPx + sample.midYDeltaPx,
    lockedDirection: state.lockedDirection,
  };
  if (state.initialSpanPx > 0) {
    const spanRatio =
      Math.abs(sample.liveSpanPx - state.initialSpanPx) /
      state.initialSpanPx;
    if (spanRatio > config.pinchRatio) {
      next.active = false;
      next.accumulatedDeltaPx = 0;
      return { next, aborted: true, direction: null, steps: 0 };
    }
  }
  if (Math.abs(next.accumulatedDeltaPx) < config.stepPx) {
    return { next, aborted: false, direction: null, steps: 0 };
  }
  const direction: WheelDirection =
    next.accumulatedDeltaPx < 0 ? "up" : "down";
  if (
    next.lockedDirection !== null &&
    next.lockedDirection !== direction &&
    Math.abs(next.accumulatedDeltaPx) < config.directionLockPx
  ) {
    return { next, aborted: false, direction: null, steps: 0 };
  }
  next.lockedDirection = direction;
  const steps = Math.floor(
    Math.abs(next.accumulatedDeltaPx) / config.stepPx,
  );
  if (steps < 1) {
    return { next, aborted: false, direction: null, steps: 0 };
  }
  const sign = next.accumulatedDeltaPx < 0 ? -1 : 1;
  next.accumulatedDeltaPx =
    (Math.abs(next.accumulatedDeltaPx) - steps * config.stepPx) * sign;
  return { next, aborted: false, direction, steps };
}

