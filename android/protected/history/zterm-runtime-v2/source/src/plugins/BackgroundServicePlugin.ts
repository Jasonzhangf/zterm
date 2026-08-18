import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * BackgroundServicePlugin - 前端与 Android 后台服务的接口
 *
 * 生命周期分工：
 * - retained session > 0 时由 app lifecycle owner 保持 Android service 常驻
 * - 只有进入后台时才启用 Web 层 30 秒 control heartbeat callback
 * - service 与 heartbeat callback 独立停止；前台恢复不停止 service
 */

// 后台心跳间隔：30秒
const BACKGROUND_HEARTBEAT_INTERVAL_MS = 30 * 1000;

// 心跳超时：超过90秒没有心跳认为连接已断开
const BACKGROUND_HEARTBEAT_TIMEOUT_MS = 3 * BACKGROUND_HEARTBEAT_INTERVAL_MS;

export interface BackgroundHeartbeatState {
  lastHeartbeatAt: number;
  sessionCount: number;
  isBackgroundActive: boolean;
}

interface BackgroundServiceOptions {
  sessionCount: number;
}

interface BackgroundServiceNativePlugin {
  start: (options: BackgroundServiceOptions) => Promise<{ ok: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
  updateSessionCount: (options: BackgroundServiceOptions) => Promise<{ ok: boolean }>;
}

const BackgroundService = registerPlugin<BackgroundServiceNativePlugin>('BackgroundService');

// Native BackgroundService wakes the WebView every 30s while the app is in
// background (WebView JS timers freeze when not visible, which would stop the
// mux-ping heartbeat). It calls this global tick which re-arms the heartbeat
// state and fires the configured callback.
if (typeof window !== 'undefined') {
  (window as unknown as { ztermBackgroundHeartbeatTick?: () => void }).ztermBackgroundHeartbeatTick = () => {
    if (!heartbeatState.isBackgroundActive) {
      return;
    }
    heartbeatState.lastHeartbeatAt = Date.now();
    if (backgroundHeartbeatCallback) {
      backgroundHeartbeatCallback();
    }
  };
}

// 后台心跳状态（单例）
let heartbeatTimerId: ReturnType<typeof setInterval> | null = null;
let heartbeatState: BackgroundHeartbeatState = {
  lastHeartbeatAt: 0,
  sessionCount: 0,
  isBackgroundActive: false,
};
let backgroundHeartbeatCallback: (() => void) | null = null;

/**
 * 设置后台心跳回调。回调为空表示前台，不代表停止 native service。
 */
export function setBackgroundHeartbeatCallback(callback: (() => void) | null): void {
  backgroundHeartbeatCallback = callback;
  if (callback) {
    if (heartbeatState.sessionCount > 0) {
      startBackgroundHeartbeatTimer(heartbeatState.sessionCount);
    }
    return;
  }
  stopBackgroundHeartbeatTimer();
}

/**
 * 获取后台心跳状态 - 用于恢复时判断连接是否仍然有效
 */
export function getBackgroundHeartbeatState(): BackgroundHeartbeatState {
  return { ...heartbeatState };
}

/**
 * 检查后台心跳是否有效
 */
export function isBackgroundHeartbeatAlive(): boolean {
  if (!heartbeatState.isBackgroundActive) {
    return false;
  }
  const now = Date.now();
  const elapsed = now - heartbeatState.lastHeartbeatAt;
  return elapsed < BACKGROUND_HEARTBEAT_TIMEOUT_MS;
}

/**
 * 记录一次心跳成功
 */
export function recordBackgroundHeartbeat(): void {
  heartbeatState.lastHeartbeatAt = Date.now();
}

/**
 * 开始后台心跳定时器
 */
function startBackgroundHeartbeatTimer(sessionCount: number): void {
  stopBackgroundHeartbeatTimer();

  heartbeatState = {
    lastHeartbeatAt: Date.now(),
    sessionCount,
    isBackgroundActive: true,
  };

  heartbeatTimerId = setInterval(() => {
    if (backgroundHeartbeatCallback) {
      heartbeatState.lastHeartbeatAt = Date.now();
      backgroundHeartbeatCallback();
    }
  }, BACKGROUND_HEARTBEAT_INTERVAL_MS);
}

/**
 * 停止后台心跳定时器
 */
function stopBackgroundHeartbeatTimer(): void {
  if (heartbeatTimerId !== null) {
    clearInterval(heartbeatTimerId);
    heartbeatTimerId = null;
  }
  heartbeatState.isBackgroundActive = false;
}

/**
 * 启动 Android 原生 service。不会隐式启用后台 heartbeat。
 */
export function startBackgroundService(sessionCount: number = 0): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    heartbeatState.sessionCount = sessionCount;
    return;
  }
  void BackgroundService.start({ sessionCount }).catch((error) => {
    console.warn('[BackgroundService] start failed:', error);
  });
  heartbeatState.sessionCount = sessionCount;
}

/**
 * 停止 Android 原生 service，并清理独立的后台 heartbeat timer。
 */
export function stopBackgroundService(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    stopBackgroundHeartbeatTimer();
    return;
  }
  void BackgroundService.stop().catch((error) => {
    console.warn('[BackgroundService] stop failed:', error);
  });
  stopBackgroundHeartbeatTimer();
}

/**
 * 更新 retained session 数量。后台 heartbeat 是否运行由
 * setBackgroundHeartbeatCallback() 独立决定。
 */
export function updateSessionCount(count: number): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    heartbeatState.sessionCount = count;
    if (count <= 0) {
      stopBackgroundHeartbeatTimer();
    }
    return;
  }
  void BackgroundService.updateSessionCount({ sessionCount: count }).catch((error) => {
    console.warn('[BackgroundService] updateSessionCount failed:', error);
  });
  heartbeatState.sessionCount = count;
  if (count <= 0) {
    stopBackgroundHeartbeatTimer();
  } else if (backgroundHeartbeatCallback) {
    startBackgroundHeartbeatTimer(count);
  }
}

/**
 * 检查是否支持后台服务
 */
export function isBackgroundServiceSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
