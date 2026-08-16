import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isScreenOrientationSupported,
  ScreenOrientationPlugin,
} from '../plugins/ScreenOrientationPlugin';

export type LockedOrientation = 'portrait' | 'landscape';

export interface ScreenOrientationLockOptions {
  /** 平台能力开关（测试注入；默认走 Capacitor 平台判断） */
  supported?: boolean;
  /** 初始锁定方向（测试注入；默认 null = 由本 hook 首启锁竖屏） */
  initialLock?: LockedOrientation | null;
  /** 方向锁定调用（测试注入；默认走 ScreenOrientationPlugin） */
  setOrientation?: (orientation: LockedOrientation) => Promise<unknown>;
  /** deviceorientation 监听注册（测试注入；默认 window.addEventListener） */
  addDeviceOrientationListener?: (
    listener: (gamma: number) => void,
  ) => void | (() => void);
}

export interface ScreenOrientationLockRuntime {
  /** 当前锁定方向；null = 平台不支持（不锁定、不弹按钮） */
  lockedOrientation: LockedOrientation | null;
  /** 物理姿态与锁定方向不一致 → 显示角落转换按钮 */
  showSwitchButton: boolean;
  /** 姿态对应的目标方向（按钮点击后锁定它） */
  pendingTarget: LockedOrientation | null;
  /** 点击转换按钮：锁定 pendingTarget */
  requestOrientationSwitch: () => void;
}

/** gamma（deviceorientation 左右倾，-180~180）→ 姿态方向。
 *  0 = 正竖、±180 = 倒竖（竖屏姿态）；±90 = 横屏姿态；
 *  45° 对角线等中间姿态返回 null（不触发按钮，避免抖动） */
export function resolveOrientationFromGamma(
  gamma: number,
): LockedOrientation | null {
  const abs = Math.abs(gamma);
  if (abs < 45 || abs > 135) {
    return 'portrait';
  }
  if (abs >= 45 && abs <= 135) {
    return 'landscape';
  }
  return null;
}

/**
 * 屏幕方向锁定 + 姿态检测弹转换按钮（视频播放器式）：
 * - 启动默认锁竖屏（SCREEN_ORIENTATION_PORTRAIT，固定变体——不随传感器自动切换）
 * - 监听 deviceorientation：物理姿态与锁定方向不一致时，`showSwitchButton=true`
 *   （角落小按钮，不覆盖其他浮动标签）；点击后锁定姿态方向
 * - 非原生平台（web/test 环境不支持）整体降级：不锁定、不弹按钮
 */
export function useScreenOrientationLock(
  options?: ScreenOrientationLockOptions,
): ScreenOrientationLockRuntime {
  const supported = options?.supported ?? isScreenOrientationSupported();
  const initialLock = options?.initialLock ?? null;
  // 默认 setOrientation 稳定化：不随 render 重建，避免 useEffect 依赖变化反复重跑
  const defaultSetOrientationRef = useRef<
    ((orientation: LockedOrientation) => Promise<unknown>) | null
  >(null);
  if (defaultSetOrientationRef.current === null) {
    defaultSetOrientationRef.current = (orientation: LockedOrientation) =>
      ScreenOrientationPlugin.setOrientation({ orientation });
  }
  const setOrientation =
    options?.setOrientation ?? defaultSetOrientationRef.current;

  const [lockedOrientation, setLockedOrientation] =
    useState<LockedOrientation | null>(initialLock);
  const [showSwitchButton, setShowSwitchButton] = useState(false);
  const [pendingTarget, setPendingTarget] =
    useState<LockedOrientation | null>(null);
  // 同步 ref：姿态 handler 与 requestOrientationSwitch 读最新锁定方向/目标
  const lockedOrientationRef = useRef<LockedOrientation | null>(initialLock);
  const pendingTargetRef = useRef<LockedOrientation | null>(null);
  // 姿态去抖：连续两次同一姿态才更新按钮状态，避免传感器抖动闪烁
  const lastPoseRef = useRef<LockedOrientation | null>(null);
  const lastPoseCountRef = useRef(0);

  const requestOrientationSwitch = useCallback(() => {
    const target = pendingTargetRef.current;
    if (target === null) {
      return;
    }
    void setOrientation(target);
    pendingTargetRef.current = null;
    lockedOrientationRef.current = target;
    setLockedOrientation(target);
    setPendingTarget(null);
    setShowSwitchButton(false);
  }, [setOrientation]);

  useEffect(() => {
    if (!supported) {
      return;
    }
    // 启动默认锁竖屏（MainActivity 原生也锁，这里 JS 侧同步状态并兜底）
    void setOrientation('portrait');
    lockedOrientationRef.current = 'portrait';
    setLockedOrientation('portrait');

    const addListener =
      options?.addDeviceOrientationListener ??
      ((listener: (gamma: number) => void) => {
        const handler = (event: DeviceOrientationEvent) => {
          if (event.gamma === null || Number.isNaN(event.gamma)) {
            return;
          }
          listener(event.gamma);
        };
        window.addEventListener('deviceorientation', handler);
        return () => window.removeEventListener('deviceorientation', handler);
      });

    const removeListener = addListener((gamma) => {
      const pose = resolveOrientationFromGamma(gamma);
      if (pose === null) {
        return;
      }
      // 姿态去抖：连续两次同姿态才生效
      if (lastPoseRef.current === pose) {
        lastPoseCountRef.current += 1;
      } else {
        lastPoseRef.current = pose;
        lastPoseCountRef.current = 1;
      }
      if (lastPoseCountRef.current < 2) {
        return;
      }
      const locked = lockedOrientationRef.current;
      if (locked === null) {
        return;
      }
      if (pose === locked) {
        pendingTargetRef.current = null;
        setPendingTarget(null);
        setShowSwitchButton(false);
      } else {
        pendingTargetRef.current = pose;
        setPendingTarget(pose);
        setShowSwitchButton(true);
      }
    });
    return () => removeListener?.();
  }, [supported, setOrientation, options?.addDeviceOrientationListener]);

  return {
    lockedOrientation,
    showSwitchButton,
    pendingTarget,
    requestOrientationSwitch,
  };
}
