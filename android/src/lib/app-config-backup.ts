import type { BrowserStorageLike } from './browser-storage';
import { APP_UPDATE_STORAGE_KEY } from './app-update';
import { TRAVERSAL_RELAY_ACCOUNT_STORAGE_KEY } from './traversal-relay-client';
import { STORAGE_KEYS } from './types';

export const APP_CONFIG_BACKUP_SCHEMA_VERSION = 1;
export const APP_CONFIG_BACKUP_DIR_PATH = '/storage/emulated/0/Download/zterm';
export const APP_CONFIG_BACKUP_FILE_PATH = `${APP_CONFIG_BACKUP_DIR_PATH}/zterm-config-backup.json`;

export const APP_CONFIG_BACKUP_STORAGE_KEYS = Array.from(new Set<string>([
  ...Object.values(STORAGE_KEYS),
  APP_UPDATE_STORAGE_KEY,
  TRAVERSAL_RELAY_ACCOUNT_STORAGE_KEY,
]));

export interface AppConfigBackupPayload {
  schemaVersion: number;
  exportedAt: number;
  platform: 'android';
  appVersion: string;
  appVersionCode: number;
  storage: Partial<Record<string, string>>;
}

export interface AppConfigBackupInfo {
  filePath: string;
  exportedAt: number;
  appVersion: string;
  appVersionCode: number;
  storedKeys: number;
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeStorageEntries(input: unknown) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const entries = input as Record<string, unknown>;
  const normalized: Partial<Record<string, string>> = {};
  for (const key of APP_CONFIG_BACKUP_STORAGE_KEYS) {
    const value = entries[key];
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function buildAppConfigBackupPayload(options: {
  storage: BrowserStorageLike;
  exportedAt: number;
  appVersion: string;
  appVersionCode: number;
}): AppConfigBackupPayload {
  const snapshot: Partial<Record<string, string>> = {};
  for (const key of APP_CONFIG_BACKUP_STORAGE_KEYS) {
    const value = options.storage.getItem(key);
    if (typeof value === 'string') {
      snapshot[key] = value;
    }
  }
  return {
    schemaVersion: APP_CONFIG_BACKUP_SCHEMA_VERSION,
    exportedAt: options.exportedAt,
    platform: 'android',
    appVersion: options.appVersion.trim(),
    appVersionCode: options.appVersionCode,
    storage: snapshot,
  };
}

export function normalizeAppConfigBackupPayload(input: unknown): AppConfigBackupPayload | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<AppConfigBackupPayload>;
  const schemaVersion = toFiniteNumber(candidate.schemaVersion);
  const exportedAt = toFiniteNumber(candidate.exportedAt);
  const appVersionCode = toFiniteNumber(candidate.appVersionCode);
  const appVersion = typeof candidate.appVersion === 'string' ? candidate.appVersion.trim() : '';
  const storage = normalizeStorageEntries(candidate.storage);

  if (
    schemaVersion !== APP_CONFIG_BACKUP_SCHEMA_VERSION
    || !exportedAt
    || exportedAt <= 0
    || candidate.platform !== 'android'
    || !appVersion
    || !appVersionCode
    || appVersionCode <= 0
    || !storage
  ) {
    return null;
  }

  return {
    schemaVersion,
    exportedAt,
    platform: 'android',
    appVersion,
    appVersionCode,
    storage,
  };
}

export function toAppConfigBackupInfo(payload: AppConfigBackupPayload): AppConfigBackupInfo {
  return {
    filePath: APP_CONFIG_BACKUP_FILE_PATH,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    appVersionCode: payload.appVersionCode,
    storedKeys: Object.keys(payload.storage).length,
  };
}

export function applyAppConfigBackupPayload(storage: BrowserStorageLike, payload: AppConfigBackupPayload) {
  for (const key of APP_CONFIG_BACKUP_STORAGE_KEYS) {
    if (typeof payload.storage[key] === 'string') {
      storage.setItem(key, payload.storage[key] as string);
      continue;
    }
    storage.removeItem(key);
  }
}
