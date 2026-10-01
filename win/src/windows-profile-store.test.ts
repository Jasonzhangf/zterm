// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createWindowsProfileStore,
  normalizeWindowsProfile,
  validateWindowsProfile,
} from './windows-profile-store';

function storageStub(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    clear: () => values.clear(),
  } as unknown as Storage;
}

describe('windows profile store', () => {
  it('seeds one local default and resolves a terminal target', () => {
    const store = createWindowsProfileStore(storageStub());
    const snapshot = store.getSnapshot();
    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.activeProfileId).toBe(snapshot.profiles[0]!.id);
    const target = store.resolveTarget(snapshot.profiles[0]!);
    expect(target.bridgeHost).toBe('127.0.0.1');
    expect(target.bridgePort).toBe(3333);
    expect(target.sessionName).toBe('zterm');
  });

  it('saves, selects, deletes, and persists profiles', () => {
    const storage = storageStub();
    const store = createWindowsProfileStore(storage);
    const saved = store.saveProfile({
      name: 'dev',
      bridgeHost: '10.0.0.2',
      bridgePort: 4444,
      sessionName: 'dev-shell',
      authToken: 'secret',
    });
    expect(store.getSnapshot().activeProfileId).toBe(saved.id);

    const reloaded = createWindowsProfileStore(storage);
    expect(reloaded.getSnapshot().profiles.map((profile) => profile.name)).toContain('dev');
    expect(reloaded.getSnapshot().activeProfileId).toBe(saved.id);

    reloaded.deleteProfile(saved.id);
    expect(reloaded.getSnapshot().activeProfileId).not.toBe(saved.id);
    expect(reloaded.getSnapshot().profiles.map((profile) => profile.name)).not.toContain('dev');
  });

  it('normalizes profile inputs', () => {
    const profile = normalizeWindowsProfile({
      name: '  ', bridgeHost: '  localhost ', bridgePort: 0, sessionName: '  zterm  ',
    });
    expect(profile.name).toBe('local');
    expect(profile.bridgeHost).toBe('localhost');
    expect(profile.bridgePort).toBe(3333);
    expect(profile.sessionName).toBe('zterm');
  });

  it('rejects invalid profiles instead of persisting unusable connection state', () => {
    const storage = storageStub();
    const store = createWindowsProfileStore(storage);

    expect(() => store.saveProfile({ name: 'x', bridgeHost: '  ', bridgePort: 3333, sessionName: 'zterm' })).toThrow();
    expect(() => store.saveProfile({ name: 'x', bridgeHost: '10.0.0.2', bridgePort: 70000, sessionName: 'zterm' })).toThrow();
    expect(() => store.saveProfile({ name: 'x', bridgeHost: '10.0.0.2', bridgePort: 3333, sessionName: '  ' })).toThrow();
    expect(store.getSnapshot().profiles).toHaveLength(1);

    expect(validateWindowsProfile({ bridgeHost: '10.0.0.2', bridgePort: 3333, sessionName: 'zterm' })).toBeNull();
    expect(validateWindowsProfile({ bridgeHost: '10.0.0.2', bridgePort: 0, sessionName: 'zterm' })).not.toBeNull();
    expect(validateWindowsProfile({ bridgeHost: '', bridgePort: 3333, sessionName: 'zterm' })).not.toBeNull();
    expect(validateWindowsProfile({ bridgeHost: '10.0.0.2', bridgePort: 3333, sessionName: '' })).not.toBeNull();
  });
});
