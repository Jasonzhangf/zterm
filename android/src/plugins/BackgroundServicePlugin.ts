/**
 * BackgroundServicePlugin - 前端与 Android 后台服务的接口
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

interface BackgroundServiceOptions {
  sessionCount: number;
}

interface BackgroundServiceNativePlugin {
  start: (options: BackgroundServiceOptions) => Promise<{ ok: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
  updateSessionCount: (options: BackgroundServiceOptions) => Promise<{ ok: boolean }>;
}

const BackgroundService = registerPlugin<BackgroundServiceNativePlugin>('BackgroundService');

/**
 * 启动后台服务
 */
export function startBackgroundService(sessionCount: number = 0): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }
  void BackgroundService.start({ sessionCount }).catch((error) => {
    console.warn('[BackgroundService] start failed:', error);
  });
}

/**
 * 停止后台服务
 */
export function stopBackgroundService(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }
  void BackgroundService.stop().catch((error) => {
    console.warn('[BackgroundService] stop failed:', error);
  });
}

/**
 * 更新 Session 数量
 */
export function updateSessionCount(count: number): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }
  void BackgroundService.updateSessionCount({ sessionCount: count }).catch((error) => {
    console.warn('[BackgroundService] updateSessionCount failed:', error);
  });
}

/**
 * 检查是否支持后台服务
 */
export function isBackgroundServiceSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
