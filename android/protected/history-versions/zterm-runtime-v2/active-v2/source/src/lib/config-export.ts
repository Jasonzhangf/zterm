import type { BrowserStorageLike } from './browser-storage';
import { STORAGE_KEYS } from './types';
import { APP_UPDATE_STORAGE_KEY } from './app-update';

export const CONFIG_EXPORT_STORAGE_KEYS = Array.from(new Set<string>([
  STORAGE_KEYS.HOSTS,
  STORAGE_KEYS.BRIDGE_SETTINGS,
  STORAGE_KEYS.QUICK_ACTIONS,
  STORAGE_KEYS.SHORTCUT_ACTIONS,
  STORAGE_KEYS.WEBDAV_CONFIG,
  APP_UPDATE_STORAGE_KEY,
]));

export interface ConfigExportPayload {
  schemaVersion: number;
  exportedAt: number;
  platform: string;
  appVersion: string;
  storage: Record<string, string>;
}

export function buildConfigExportPayload(options: {
  storage: BrowserStorageLike;
  exportedAt: number;
  appVersion: string;
}): ConfigExportPayload {
  const snapshot: Record<string, string> = {};
  for (const key of CONFIG_EXPORT_STORAGE_KEYS) {
    const value = options.storage.getItem(key);
    if (typeof value === 'string') {
      snapshot[key] = value;
    }
  }
  return {
    schemaVersion: 1,
  exportedAt: options.exportedAt,
  platform: 'android',
    appVersion: options.appVersion.trim(),
    storage: snapshot,
  };
}

export function applyConfigImportPayload(storage: BrowserStorageLike, payload: ConfigExportPayload) {
  for (const key of CONFIG_EXPORT_STORAGE_KEYS) {
    if (typeof payload.storage[key] === 'string') {
      storage.setItem(key, payload.storage[key] as string);
    } else {
      storage.removeItem(key);
    }
  }
}

export function validateConfigExportPayload(input: unknown): ConfigExportPayload | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<ConfigExportPayload>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.exportedAt !== 'number' ||
    candidate.platform !== 'android' ||
    typeof candidate.appVersion !== 'string' ||
    !candidate.storage ||
    typeof candidate.storage !== 'object'
  ) {
    return null;
  }
  return candidate as ConfigExportPayload;
}
