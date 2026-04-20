/**
 * BackgroundServicePlugin - 前端与 Android 后台服务的接口
 */

import { Capacitor } from '@capacitor/core';

interface BackgroundServiceOptions {
  sessionCount: number;
}

declare global {
  interface Window {
    BackgroundService?: {
      start: (options: BackgroundServiceOptions) => void;
      stop: () => void;
      updateSessionCount: (count: number) => void;
    };
  }
}

/**
 * 启动后台服务
 */
export function startBackgroundService(sessionCount: number = 0): void {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    // 通过 Capacitor 插件或原生桥接调用
    // 目前使用简单的方式：通过 window 对象调用
    if (window.BackgroundService) {
      window.BackgroundService.start({ sessionCount });
    } else {
      console.warn('[BackgroundService] Native plugin not available');
    }
  } else {
    console.log('[BackgroundService] Not on Android, skipping');
  }
}

/**
 * 停止后台服务
 */
export function stopBackgroundService(): void {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    if (window.BackgroundService) {
      window.BackgroundService.stop();
    }
  }
}

/**
 * 更新 Session 数量
 */
export function updateSessionCount(count: number): void {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    if (window.BackgroundService) {
      window.BackgroundService.updateSessionCount(count);
    }
  }
}

/**
 * 检查是否支持后台服务
 */
export function isBackgroundServiceSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
