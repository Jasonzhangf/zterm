import { describe, expect, it } from 'vitest';
import { APP_UPDATE_STORAGE_KEY } from './app-update';
import {
  APP_CONFIG_BACKUP_STORAGE_KEYS,
  applyAppConfigBackupPayload,
  buildAppConfigBackupPayload,
  normalizeAppConfigBackupPayload,
} from './app-config-backup';
import { TRAVERSAL_RELAY_ACCOUNT_STORAGE_KEY } from './traversal-relay-client';
import { STORAGE_KEYS } from './types';

function createStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial || {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe('app-config-backup', () => {
  it('keeps the backup allowlist aligned with user-facing storage truth', () => {
    expect(APP_CONFIG_BACKUP_STORAGE_KEYS).toContain(STORAGE_KEYS.HOSTS);
    expect(APP_CONFIG_BACKUP_STORAGE_KEYS).toContain(STORAGE_KEYS.OPEN_TABS);
    expect(APP_CONFIG_BACKUP_STORAGE_KEYS).toContain(APP_UPDATE_STORAGE_KEY);
    expect(APP_CONFIG_BACKUP_STORAGE_KEYS).toContain(TRAVERSAL_RELAY_ACCOUNT_STORAGE_KEY);
  });

  it('serializes only allowlisted storage keys and ignores unknown keys', () => {
    const payload = buildAppConfigBackupPayload({
      storage: createStorage({
        [STORAGE_KEYS.HOSTS]: '[{"id":"host-1"}]',
        [APP_UPDATE_STORAGE_KEY]: '{"manifestUrl":"https://example.com"}',
        'zterm:unknown': 'should-not-export',
      }),
      exportedAt: 123456789,
      appVersion: '0.1.3.1795',
      appVersionCode: 1031795,
    });

    expect(payload.storage[STORAGE_KEYS.HOSTS]).toBe('[{"id":"host-1"}]');
    expect(payload.storage[APP_UPDATE_STORAGE_KEY]).toBe('{"manifestUrl":"https://example.com"}');
    expect(payload.storage['zterm:unknown']).toBeUndefined();
  });

  it('rewrites only allowlisted keys during restore and clears missing allowlisted keys', () => {
    const storage = createStorage({
      [STORAGE_KEYS.HOSTS]: '[{"id":"old"}]',
      [STORAGE_KEYS.OPEN_TABS]: '[{"sessionId":"stale"}]',
      'zterm:unknown': 'keep-me',
    });

    const payload = normalizeAppConfigBackupPayload({
      schemaVersion: 1,
      exportedAt: 123456789,
      platform: 'android',
      appVersion: '0.1.3.1795',
      appVersionCode: 1031795,
      storage: {
        [STORAGE_KEYS.HOSTS]: '[{"id":"new"}]',
      },
    });

    if (!payload) {
      throw new Error('expected normalized payload');
    }

    applyAppConfigBackupPayload(storage, payload);

    expect(storage.getItem(STORAGE_KEYS.HOSTS)).toBe('[{"id":"new"}]');
    expect(storage.getItem(STORAGE_KEYS.OPEN_TABS)).toBeNull();
    expect(storage.getItem('zterm:unknown')).toBe('keep-me');
  });
});
