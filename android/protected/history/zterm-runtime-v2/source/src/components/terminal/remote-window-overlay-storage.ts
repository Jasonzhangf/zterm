/**
 * Remote window overlay 本地持久化 owner（client.remote_window_overlay）。
 * 浮钮位置 / 触摸滚动参数 / 输入模式只经本模块读写 localStorage；
 * 组件禁止直写 raw storage key。
 */
import { REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION } from '../../lib/remote-window-touch-action-runtime';
import type { RemoteWindowInputMode } from './remote-window-overlay-constants';

export const REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY =
  'zterm:remote-window:entry-position-v1';
export const REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY =
  'zterm:remote-window:touch-scroll-fraction-v1';
export const REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY =
  'zterm:remote-window:touch-scroll-inverted-v1';
export const REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY =
  'zterm:remote-window:input-mode-v1';

export const REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS = [0.125, 0.25, 0.5, 1] as const;
export type RemoteWindowTouchScrollFraction =
  (typeof REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS)[number];

export interface FloatingEntryPosition {
  x: number | null;
  y: number | null;
}

export function resolveTouchScrollFractionPreset(
  value: unknown,
): RemoteWindowTouchScrollFraction {
  const parsed = typeof value === 'number' ? value : Number(value);
  const matched = REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_OPTIONS.find(
    (option) => option === parsed,
  );
  return matched ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
}

export function readStoredEntryPosition(): FloatingEntryPosition {
  if (typeof window === 'undefined') {
    return { x: null, y: null };
  }
  try {
    const raw = localStorage.getItem(REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY);
    if (!raw) {
      return { x: null, y: null };
    }
    const parsed = JSON.parse(raw) as Partial<{ x: number; y: number }>;
    return {
      x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null,
    };
  } catch (error) {
    console.warn('[RemoteWindowOverlay] Failed to read stored entry position:', error);
    return { x: null, y: null };
  }
}

export function writeStoredEntryPosition(position: FloatingEntryPosition) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(
      REMOTE_WINDOW_ENTRY_POSITION_STORAGE_KEY,
      JSON.stringify(position),
    );
  } catch (error) {
    console.warn('[RemoteWindowOverlay] Failed to store entry position:', error);
  }
}

export function readRemoteWindowTouchScrollFraction(): RemoteWindowTouchScrollFraction {
  if (typeof window === 'undefined') {
    return REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
  }
  return resolveTouchScrollFractionPreset(
    window.localStorage.getItem(REMOTE_WINDOW_TOUCH_SCROLL_FRACTION_STORAGE_KEY),
  );
}

export function readRemoteWindowTouchScrollInverted() {
  if (typeof window === 'undefined') {
    return true;
  }
  const raw = window.localStorage.getItem(
    REMOTE_WINDOW_TOUCH_SCROLL_INVERTED_STORAGE_KEY,
  );
  return raw === null ? true : raw === 'true';
}

export function readRemoteWindowInputMode(): RemoteWindowInputMode {
  if (typeof window === 'undefined') {
    return 'touch';
  }
  const raw = window.localStorage.getItem(REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY);
  return raw === 'mouse' ? 'mouse' : 'touch';
}

export function writeRemoteWindowInputMode(mode: RemoteWindowInputMode) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(REMOTE_WINDOW_INPUT_MODE_STORAGE_KEY, mode);
}
