export interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const REMOTE_WINDOW_DISPLAY_ORIENTATION_OPTIONS = ['portrait', 'landscape', 'follow-device'] as const;
export type RemoteWindowDisplayOrientation = typeof REMOTE_WINDOW_DISPLAY_ORIENTATION_OPTIONS[number];
export const REMOTE_WINDOW_DISPLAY_ORIENTATION_DEFAULT: RemoteWindowDisplayOrientation = 'portrait';
export const REMOTE_WINDOW_DISPLAY_ORIENTATION_STORAGE_KEY = 'zterm:remote-window-display-orientation-v1';
export const REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY = 'zterm:remote-window-quality-bitrate-multiplier-v1';
export const REMOTE_WINDOW_QUALITY_FRAME_RATE_STORAGE_KEY = 'zterm:remote-window-quality-max-frame-rate-v1';
export const REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS = [15, 30, 60] as const;
export type RemoteWindowQualityMaxFrameRate = typeof REMOTE_WINDOW_QUALITY_FRAME_RATE_OPTIONS[number];
export type RemoteWindowVideoBudgetMultiplier = 1 | 2 | 4;

export interface RemoteWindowQualityControls {
  bitrateMultiplier: RemoteWindowVideoBudgetMultiplier;
  maxFrameRateFps: RemoteWindowQualityMaxFrameRate;
}

export interface RemoteWindowDisplayOrientationViewport {
  width: number;
  height: number;
}

function isDisplayOrientation(value: unknown): value is RemoteWindowDisplayOrientation {
  return typeof value === 'string'
    && (REMOTE_WINDOW_DISPLAY_ORIENTATION_OPTIONS as readonly string[]).includes(value);
}

function isQualityBitrateMultiplier(value: unknown): value is RemoteWindowVideoBudgetMultiplier {
  return value === 1 || value === 2 || value === 4;
}

function isQualityMaxFrameRate(value: unknown): value is RemoteWindowQualityMaxFrameRate {
  return value === 15 || value === 30 || value === 60;
}

export function readRemoteWindowDisplayOrientation(
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowDisplayOrientation {
  if (!storage) {
    return REMOTE_WINDOW_DISPLAY_ORIENTATION_DEFAULT;
  }
  try {
    const raw = storage.getItem(REMOTE_WINDOW_DISPLAY_ORIENTATION_STORAGE_KEY);
    if (isDisplayOrientation(raw)) {
      return raw;
    }
  } catch {
    // ignore
  }
  return REMOTE_WINDOW_DISPLAY_ORIENTATION_DEFAULT;
}

export function writeRemoteWindowDisplayOrientation(
  orientation: RemoteWindowDisplayOrientation,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): boolean {
  if (!storage || !isDisplayOrientation(orientation)) {
    return false;
  }
  try {
    storage.setItem(REMOTE_WINDOW_DISPLAY_ORIENTATION_STORAGE_KEY, orientation);
    return true;
  } catch {
    return false;
  }
}

export function readRemoteWindowQualityControls(
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): RemoteWindowQualityControls {
  const defaults: RemoteWindowQualityControls = {
    bitrateMultiplier: 1,
    maxFrameRateFps: 30,
  };
  if (!storage) {
    return defaults;
  }
  const next: RemoteWindowQualityControls = { ...defaults };
  try {
    const raw = storage.getItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY);
    const parsed = raw === null ? null : Number(raw);
    if (isQualityBitrateMultiplier(parsed)) {
      next.bitrateMultiplier = parsed;
    }
  } catch {
    // ignore
  }
  try {
    const raw = storage.getItem(REMOTE_WINDOW_QUALITY_FRAME_RATE_STORAGE_KEY);
    const parsed = raw === null ? null : Number(raw);
    if (isQualityMaxFrameRate(parsed)) {
      next.maxFrameRateFps = parsed;
    }
  } catch {
    // ignore
  }
  return next;
}

export function writeRemoteWindowQualityControls(
  controls: RemoteWindowQualityControls,
  storage: BrowserStorageLike | null | undefined = typeof window === 'undefined' ? null : window.localStorage,
): boolean {
  if (!storage || !isQualityBitrateMultiplier(controls.bitrateMultiplier) || !isQualityMaxFrameRate(controls.maxFrameRateFps)) {
    return false;
  }
  try {
    storage.setItem(REMOTE_WINDOW_QUALITY_BITRATE_MULTIPLIER_STORAGE_KEY, String(controls.bitrateMultiplier));
    storage.setItem(REMOTE_WINDOW_QUALITY_FRAME_RATE_STORAGE_KEY, String(controls.maxFrameRateFps));
    return true;
  } catch {
    return false;
  }
}

export function resolveRemoteWindowContainerViewport(
  orientation: RemoteWindowDisplayOrientation,
  device: RemoteWindowDisplayOrientationViewport,
  visualViewport: RemoteWindowDisplayOrientationViewport | null,
): RemoteWindowDisplayOrientationViewport {
  const width = Math.max(1, Math.round(visualViewport?.width ?? device.width));
  const height = Math.max(1, Math.round(visualViewport?.height ?? device.height));
  if (orientation === 'landscape') {
    return {
      width: Math.max(width, height),
      height: Math.min(width, height),
    };
  }
  if (orientation === 'portrait') {
    return {
      width: Math.min(width, height),
      height: Math.max(width, height),
    };
  }
  return { width, height };
}

export function resolveRemoteWindowContainerLetterboxRect(
  container: RemoteWindowDisplayOrientationViewport,
  source: RemoteWindowDisplayOrientationViewport,
): { left: number; top: number; width: number; height: number } {
  const containerWidth = Math.max(1, container.width);
  const containerHeight = Math.max(1, container.height);
  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);
  const scale = Math.min(containerWidth / sourceWidth, containerHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}
