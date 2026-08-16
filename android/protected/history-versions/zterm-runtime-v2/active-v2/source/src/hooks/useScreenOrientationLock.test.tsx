// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveOrientationFromGamma,
  useScreenOrientationLock,
  type LockedOrientation,
} from './useScreenOrientationLock';

type OrientationListener = (gamma: number) => void;

function makeHarness(overrides?: {
  supported?: boolean;
  initialLock?: LockedOrientation | null;
}) {
  const setOrientation = vi.fn(async (_o: LockedOrientation) => undefined);
  let listener: OrientationListener | null = null;
  const removeDeviceOrientationListener = vi.fn(() => {
    listener = null;
  });
  const addDeviceOrientationListener = vi.fn(
    (cb: OrientationListener) => {
      listener = cb;
      return removeDeviceOrientationListener;
    },
  );
  const supported = overrides?.supported ?? true;
  const { result, unmount } = renderHook(() =>
    useScreenOrientationLock({
      supported,
      initialLock: overrides?.initialLock ?? null,
      setOrientation,
      addDeviceOrientationListener,
    }),
  );
  const fireGamma = (gamma: number) => {
    // 真实 deviceorientation 高频触发；连续两次同姿态才生效（去抖）
    act(() => {
      listener?.(gamma);
      listener?.(gamma);
    });
  };
  return { result, unmount, setOrientation, fireGamma, addDeviceOrientationListener, removeDeviceOrientationListener };
}

describe('resolveOrientationFromGamma', () => {
  it('treats near-0 and near-180 as portrait, near-90 as landscape, 45 boundary as landscape', () => {
    expect(resolveOrientationFromGamma(0)).toBe('portrait');
    expect(resolveOrientationFromGamma(10)).toBe('portrait');
    expect(resolveOrientationFromGamma(40)).toBe('portrait');
    expect(resolveOrientationFromGamma(175)).toBe('portrait');
    expect(resolveOrientationFromGamma(-170)).toBe('portrait');
    expect(resolveOrientationFromGamma(90)).toBe('landscape');
    expect(resolveOrientationFromGamma(-90)).toBe('landscape');
    expect(resolveOrientationFromGamma(60)).toBe('landscape');
    expect(resolveOrientationFromGamma(45)).toBe('landscape');
  });
});

describe('useScreenOrientationLock', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('locks portrait by default on supported platforms', () => {
    const { result, setOrientation, addDeviceOrientationListener } =
      makeHarness();
    expect(setOrientation).toHaveBeenCalledWith('portrait');
    expect(addDeviceOrientationListener).toHaveBeenCalled();
    expect(result.current.lockedOrientation).toBe('portrait');
    expect(result.current.showSwitchButton).toBe(false);
  });

  it('does not lock or listen on unsupported platforms', () => {
    const { result, setOrientation, addDeviceOrientationListener } =
      makeHarness({ supported: false });
    expect(setOrientation).not.toHaveBeenCalled();
    expect(addDeviceOrientationListener).not.toHaveBeenCalled();
    expect(result.current.lockedOrientation).toBeNull();
    expect(result.current.showSwitchButton).toBe(false);
  });

  it('removes the deviceorientation listener on unmount', () => {
    const { unmount, removeDeviceOrientationListener } = makeHarness();
    unmount();
    expect(removeDeviceOrientationListener).toHaveBeenCalledTimes(1);
  });

  it('shows the switch button when the physical pose turns landscape while locked portrait', () => {
    const { result, fireGamma } = makeHarness();
    // 物理姿态横屏（gamma 90），锁定竖屏 → 弹出转换按钮
    fireGamma(90);
    expect(result.current.showSwitchButton).toBe(true);
    expect(result.current.pendingTarget).toBe('landscape');
  });

  it('hides the button when pose matches the locked orientation', () => {
    const { result, fireGamma } = makeHarness();
    fireGamma(90);
    expect(result.current.showSwitchButton).toBe(true);
    fireGamma(5);
    expect(result.current.showSwitchButton).toBe(false);
    expect(result.current.pendingTarget).toBeNull();
  });

  it('switching locks the pose orientation and hides the button', async () => {
    const { result, setOrientation, fireGamma } = makeHarness();
    fireGamma(90);
    expect(result.current.pendingTarget).toBe('landscape');
    await act(async () => {
      result.current.requestOrientationSwitch();
    });
    expect(setOrientation).toHaveBeenCalledWith('landscape');
    expect(result.current.lockedOrientation).toBe('landscape');
    expect(result.current.showSwitchButton).toBe(false);
    // 姿态仍横屏（已锁定横屏）→ 按钮保持隐藏
    fireGamma(85);
    expect(result.current.showSwitchButton).toBe(false);
  });

  it('shows the button again when the pose turns portrait while locked landscape', () => {
    const { result, fireGamma } = makeHarness();
    fireGamma(90);
    act(() => {
      // 切到横屏锁定
      void result.current.requestOrientationSwitch();
    });
    expect(result.current.lockedOrientation).toBe('landscape');
    // 物理姿态转回竖屏 → 提示可切回竖屏
    fireGamma(0);
    expect(result.current.showSwitchButton).toBe(true);
    expect(result.current.pendingTarget).toBe('portrait');
  });

  it('ignores intermediate tilts below the 45-degree threshold', () => {
    // 45° 以下仍视为竖屏姿态（避免轻微倾斜就弹按钮）；45° 起视为横屏
    const { result, fireGamma } = makeHarness();
    fireGamma(44);
    expect(result.current.showSwitchButton).toBe(false);
    fireGamma(46);
    expect(result.current.showSwitchButton).toBe(true);
    expect(result.current.pendingTarget).toBe('landscape');
  });
});
