
import { describe, expect, it } from "vitest";
import {
  createTwoFingerWheelInitial,
  decideTwoFingerWheel,
  DEFAULT_TWO_FINGER_WHEEL_CONFIG,
} from "./two-finger-wheel-decision";

describe("decideTwoFingerWheel", () => {
  it("does not emit below the step threshold", () => {
    const initial = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    const result = decideTwoFingerWheel(initial, {
      midYDeltaPx: 10,
      liveSpanPx: 100,
    });
    expect(result.aborted).toBe(false);
    expect(result.direction).toBeNull();
    expect(result.steps).toBe(0);
    expect(result.next.accumulatedDeltaPx).toBe(10);
  });

  it("emits a single up notch when crossing one step upward", () => {
    const initial = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    const result = decideTwoFingerWheel(initial, {
      midYDeltaPx: -30,
      liveSpanPx: 100,
    });
    expect(result.direction).toBe("up");
    expect(result.steps).toBe(1);
    expect(result.next.accumulatedDeltaPx).toBeCloseTo(-6, 5);
    expect(result.next.lockedDirection).toBe("up");
  });

  it("emits multiple notches when motion exceeds several step widths", () => {
    const initial = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    const result = decideTwoFingerWheel(initial, {
      midYDeltaPx: -100,
      liveSpanPx: 100,
    });
    expect(result.direction).toBe("up");
    expect(result.steps).toBe(4);
    expect(result.next.accumulatedDeltaPx).toBeCloseTo(-4, 5);
  });

  it("locks direction: small reverse motion does not flip direction", () => {
    let state = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    state = decideTwoFingerWheel(state, {
      midYDeltaPx: -100,
      liveSpanPx: 100,
    }).next;
    expect(state.lockedDirection).toBe("up");
    const reverse = decideTwoFingerWheel(state, {
      midYDeltaPx: 30,
      liveSpanPx: 100,
    });
    expect(reverse.direction).toBeNull();
    expect(reverse.steps).toBe(0);
    expect(reverse.next.lockedDirection).toBe("up");
  });

  it("releases direction lock once reverse motion exceeds the dead-zone", () => {
    let state = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    state = decideTwoFingerWheel(state, {
      midYDeltaPx: -100,
      liveSpanPx: 100,
    }).next;
    const reverse = decideTwoFingerWheel(state, {
      midYDeltaPx: 60,
      liveSpanPx: 100,
    });
    expect(reverse.direction).toBe("down");
    expect(reverse.steps).toBeGreaterThanOrEqual(1);
    expect(reverse.next.lockedDirection).toBe("down");
  });

  it("aborts the gesture when pinch ratio is exceeded", () => {
    let state = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    const result = decideTwoFingerWheel(state, {
      midYDeltaPx: 10,
      liveSpanPx: 130,
    });
    expect(result.aborted).toBe(true);
    expect(result.direction).toBeNull();
    expect(result.steps).toBe(0);
    expect(result.next.active).toBe(false);
  });

  it("keeps emitting during long scrolls without throttling", () => {
    let state = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    let totalSteps = 0;
    for (let i = 0; i < 8; i += 1) {
      const decision = decideTwoFingerWheel(state, {
        midYDeltaPx: -30,
        liveSpanPx: 100,
      });
      totalSteps += decision.steps;
      state = decision.next;
    }
    expect(totalSteps).toBeGreaterThanOrEqual(8);
  });

  it("honors custom step and lock configuration", () => {
    const initial = { ...createTwoFingerWheelInitial(), initialSpanPx: 100 };
    const config = {
      ...DEFAULT_TWO_FINGER_WHEEL_CONFIG,
      stepPx: 10,
      directionLockPx: 20,
    };
    const result = decideTwoFingerWheel(
      initial,
      { midYDeltaPx: -15, liveSpanPx: 100 },
      config,
    );
    expect(result.steps).toBe(1);
    expect(result.next.lockedDirection).toBe("up");
  });
});

