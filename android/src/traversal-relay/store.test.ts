import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceCleanupRejectedError, TraversalRelayStore } from './store';

const tempDirs: string[] = [];

function createStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zterm-traversal-store-'));
  tempDirs.push(dir);
  const path = join(dir, 'store.json');
  return {
    path,
    store: new TraversalRelayStore(path),
  };
}

function createStore() {
  return createStoreFixture().store;
}

function readStoredDocument(path: string) {
  return JSON.parse(readFileSync(path, 'utf-8')) as {
    users: Array<{ id: string }>;
    tokens: Array<{ token: string; lastUsedAt: string }>;
    devices: Array<{ userId: string; deviceId: string }>;
  };
}

function blockTemporaryWrite(path: string) {
  const temporaryPath = `${path}.tmp`;
  mkdirSync(temporaryPath, { recursive: true });
  return temporaryPath;
}

function writeStoredPresence(
  path: string,
  deviceId: string,
  presence: { clientConnected: boolean; daemonConnected: boolean },
) {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    devices?: Array<Record<string, unknown>>;
  };
  const device = data.devices?.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    throw new Error(`stored device not found: ${deviceId}`);
  }
  device.clientConnected = presence.clientConnected;
  device.daemonConnected = presence.daemonConnected;
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function createOfflineDaemonDevice(
  store: TraversalRelayStore,
  userId: string,
  deviceId: string,
  hostId = `host-${deviceId}`,
) {
  store.publishDaemonDirectory({ userId, deviceId, hostId });
  store.setDaemonConnected({ userId, deviceId, hostId, connected: false });
}

function listDeviceIds(store: TraversalRelayStore, userId: string) {
  return store.listDevices(userId).map((device) => device.deviceId).sort();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('TraversalRelayStore', () => {
  it('does not publish or resurrect a failed presence write', () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    store.login('Jason', 'secret');

    const blocker = blockTemporaryWrite(path);
    let failure: unknown;
    try {
      store.setClientConnected({
        userId: user.id,
        deviceId: 'failed-device',
        connected: true,
      });
    } catch (error) {
      failure = error;
    }

    const afterFailureMemory = store.listDevices(user.id).map((device) => device.deviceId);
    const afterFailureDisk = readStoredDocument(path).devices.map((device) => device.deviceId);
    rmSync(blocker, { recursive: true, force: true });

    store.setClientConnected({
      userId: user.id,
      deviceId: 'next-device',
      connected: true,
    });
    const afterNextMemory = store.listDevices(user.id).map((device) => device.deviceId);
    const afterNextDisk = readStoredDocument(path).devices.map((device) => device.deviceId);

    expect(failure).toBeInstanceOf(Error);
    expect({
      afterFailureMemory,
      afterFailureDisk,
      afterNextMemory,
      afterNextDisk,
    }).toEqual({
      afterFailureMemory: [],
      afterFailureDisk: [],
      afterNextMemory: ['next-device'],
      afterNextDisk: ['next-device'],
    });
  });

  it('does not publish or resurrect a failed token timestamp write', async () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    const login = store.login('Jason', 'secret');
    const originalLastUsedAt = readStoredDocument(path).tokens[0].lastUsedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const blocker = blockTemporaryWrite(path);
    let failure: unknown;
    try {
      store.authenticate(login.token);
    } catch (error) {
      failure = error;
    }

    const afterFailureLastUsedAt = readStoredDocument(path).tokens[0].lastUsedAt;
    rmSync(blocker, { recursive: true, force: true });

    store.setClientConnected({
      userId: user.id,
      deviceId: 'next-device',
      connected: false,
    });
    const afterNextLastUsedAt = readStoredDocument(path).tokens[0].lastUsedAt;
    const authenticated = store.authenticate(login.token);

    expect(failure).toBeInstanceOf(Error);
    expect(authenticated).toMatchObject({ username: 'jason' });
    expect({
      afterFailureLastUsedAt,
      afterNextLastUsedAt,
    }).toEqual({
      afterFailureLastUsedAt: originalLastUsedAt,
      afterNextLastUsedAt: originalLastUsedAt,
    });
  });

  it('resets stale on-disk presence on load so a restart does not keep ghost online rows', () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    createOfflineDaemonDevice(store, user.id, 'restart-device', 'host-restart');
    writeStoredPresence(path, 'restart-device', {
      clientConnected: true,
      daemonConnected: true,
    });

    const restarted = new TraversalRelayStore(path);
    expect(restarted.listDevices(user.id)).toEqual([
      expect.objectContaining({
        deviceId: 'restart-device',
        online: false,
        client: expect.objectContaining({ connected: false }),
        daemon: expect.objectContaining({ connected: false }),
      }),
    ]);

    expect(restarted.cleanupOfflineDevices(user.id, ['restart-device'], () => false)).toEqual({
      removedDeviceIds: ['restart-device'],
      absentDeviceIds: [],
    });
    expect(listDeviceIds(restarted, user.id)).toEqual([]);
  });

  it('keeps independent tokens and device presence for concurrent logins to one account', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');
    const phoneALogin = store.login('Jason', 'secret');
    const phoneBLogin = store.login('Jason', 'secret');

    expect(phoneALogin.token).not.toBe(phoneBLogin.token);
    expect(store.authenticate(phoneALogin.token)).toMatchObject({ id: user.id });
    expect(store.authenticate(phoneBLogin.token)).toMatchObject({ id: user.id });

    store.setClientConnected({
      userId: user.id,
      deviceId: 'phone-a',
      deviceName: 'Phone A',
      connected: true,
    });
    store.setClientConnected({
      userId: user.id,
      deviceId: 'phone-b',
      deviceName: 'Phone B',
      connected: true,
    });
    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'mac-studio-device',
      hostId: 'mac-studio',
      endpoints: [{
        id: 'relay:mac-studio',
        kind: 'relay-rtc',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: '2026-08-02T00:00:00.000Z',
      }],
    });
    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'windows-desktop-device',
      hostId: 'windows-desktop',
      endpoints: [{
        id: 'relay:windows-desktop',
        kind: 'relay-rtc',
        relayHostId: 'windows-desktop',
        authRequired: true,
        lastSeenAt: '2026-08-02T00:00:00.000Z',
      }],
    });

    expect(store.listDevices(user.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'phone-a', client: expect.objectContaining({ connected: true }) }),
      expect.objectContaining({ deviceId: 'phone-b', client: expect.objectContaining({ connected: true }) }),
    ]));
    expect(store.getAccountDirectory(user.id).devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'mac-studio-device', daemon: expect.objectContaining({ hostId: 'mac-studio' }) }),
      expect.objectContaining({ deviceId: 'windows-desktop-device', daemon: expect.objectContaining({ hostId: 'windows-desktop' }) }),
    ]));
  });

  it('rejects an unknown token without affecting valid tokens or another account directory', () => {
    const store = createStore();
    const jason = store.register('Jason', 'secret');
    const other = store.register('Other', 'other-secret');
    const jasonLogin = store.login('Jason', 'secret');
    const otherLogin = store.login('Other', 'other-secret');

    store.setClientConnected({ userId: jason.id, deviceId: 'jason-phone', connected: true });
    store.setClientConnected({ userId: other.id, deviceId: 'other-phone', connected: true });

    expect(store.authenticate('unknown-token')).toBeNull();
    expect(store.authenticate(jasonLogin.token)).toMatchObject({ id: jason.id });
    expect(store.authenticate(otherLogin.token)).toMatchObject({ id: other.id });
    expect(store.getAccountDirectory(jason.id).devices.map((device) => device.deviceId)).toEqual(['jason-phone']);
    expect(store.getAccountDirectory(other.id).devices.map((device) => device.deviceId)).toEqual(['other-phone']);
  });

  it('registers, logs in, authenticates, and records device presence', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');
    const login = store.login('Jason', 'secret');
    const authed = store.authenticate(login.token);

    expect(user.username).toBe('jason');
    expect(authed).toMatchObject({
      id: user.id,
      username: 'jason',
    });

    const clientSnapshot = store.setClientConnected({
      userId: user.id,
      deviceId: 'ipad-pro',
      deviceName: 'Jason iPad',
      platform: 'android',
      appVersion: '0.1.1',
      connected: true,
    });
    const daemonSnapshot = store.setDaemonConnected({
      userId: user.id,
      deviceId: 'ipad-pro',
      hostId: 'daemon-host',
      daemonVersion: '0.1.1-daemon',
      connected: true,
    });

    expect(clientSnapshot).toMatchObject({
      deviceId: 'ipad-pro',
      deviceName: 'Jason iPad',
      platform: 'android',
      appVersion: '0.1.1',
      online: true,
      client: {
        connected: true,
      },
    });
    expect(daemonSnapshot).toMatchObject({
      deviceId: 'ipad-pro',
      online: true,
      daemon: {
        connected: true,
        hostId: 'daemon-host',
        version: '0.1.1-daemon',
      },
    });
  });

  it('sorts devices by latest update and clears online status when both client and daemon disconnect', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');

    store.setClientConnected({
      userId: user.id,
      deviceId: 'device-a',
      deviceName: 'A',
      connected: true,
    });
    store.setClientConnected({
      userId: user.id,
      deviceId: 'device-b',
      deviceName: 'B',
      connected: true,
    });
    store.setDaemonConnected({
      userId: user.id,
      deviceId: 'device-a',
      hostId: 'host-a',
      connected: true,
    });
    store.setClientConnected({
      userId: user.id,
      deviceId: 'device-a',
      connected: false,
    });
    store.setDaemonConnected({
      userId: user.id,
      deviceId: 'device-a',
      hostId: 'host-a',
      connected: false,
    });

    const devices = store.listDevices(user.id);
    expect(devices.map((entry) => entry.deviceId)).toEqual(['device-a', 'device-b']);
    expect(devices[0]).toMatchObject({
      deviceId: 'device-a',
      online: false,
      client: {
        connected: false,
      },
      daemon: {
        connected: false,
        hostId: 'host-a',
      },
    });
    expect(devices[1]).toMatchObject({
      deviceId: 'device-b',
      online: true,
    });
  });

  it('publishes account directory endpoints and tmux sessions without requiring client presence', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');

    const device = store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'mac-studio',
      deviceName: 'Mac Studio',
      platform: 'darwin',
      appVersion: '0.1.3',
      hostId: 'daemon-mac-studio',
      daemonVersion: '0.1.3-daemon',
      endpoints: [
        {
          id: 'tailscale:mac-studio',
          kind: 'tailscale',
          host: 'mac-studio.tailnet.ts.net',
          port: 3333,
          authToken: 'daemon-direct-token',
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
        {
          id: 'relay:daemon-mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'daemon-mac-studio',
          authToken: 'daemon-relay-token',
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
      ],
      sessions: [
        { name: 'work', cwd: '/Users/jason/code', title: 'zterm', updatedAt: '2026-06-28T00:00:00.000Z' },
        { name: 'ops', updatedAt: '2026-06-28T00:00:00.000Z' },
      ],
      publishedAt: '2026-06-28T00:00:00.000Z',
    });

    expect(device).toMatchObject({
      deviceId: 'mac-studio',
      daemon: {
        hostId: 'daemon-mac-studio',
        version: '0.1.3-daemon',
        presence: {
          connected: true,
        },
        endpoints: [
          { id: 'tailscale:mac-studio', kind: 'tailscale', host: 'mac-studio.tailnet.ts.net', port: 3333, authToken: 'daemon-direct-token' },
          { id: 'relay:daemon-mac-studio', kind: 'relay-rtc', relayHostId: 'daemon-mac-studio', authToken: 'daemon-relay-token' },
        ],
        sessions: [
          { name: 'work', cwd: '/Users/jason/code', title: 'zterm' },
          { name: 'ops' },
        ],
      },
    });

    const directory = store.getAccountDirectory(user.id);
    expect(directory).toMatchObject({
      schemaVersion: 1,
      user: {
        id: user.id,
        username: 'jason',
      },
      devices: [
        {
          deviceId: 'mac-studio',
          client: {
            connected: false,
          },
          daemon: {
            hostId: 'daemon-mac-studio',
            endpoints: [
              { id: 'tailscale:mac-studio', kind: 'tailscale', authToken: 'daemon-direct-token' },
              { id: 'relay:daemon-mac-studio', kind: 'relay-rtc', authToken: 'daemon-relay-token' },
            ],
            sessions: [
              { name: 'work' },
              { name: 'ops' },
            ],
          },
        },
      ],
    });
  });

  it('returns fresh directory endpoint and session arrays', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');
    const published = store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'mac-studio',
      hostId: 'daemon-mac-studio',
      endpoints: [{
        id: 'relay:mac-studio',
        kind: 'relay-rtc',
        relayHostId: 'daemon-mac-studio',
        authRequired: true,
        lastSeenAt: '2026-08-02T00:00:00.000Z',
      }],
      sessions: [{
        name: 'work',
        updatedAt: '2026-08-02T00:00:00.000Z',
      }],
    });
    if (!published.daemon) {
      throw new Error('expected published daemon');
    }

    published.daemon.endpoints[0].id = 'mutated-endpoint';
    published.daemon.sessions[0].name = 'mutated-session';
    published.daemon.endpoints.length = 0;
    published.daemon.sessions.length = 0;

    const directory = store.getAccountDirectory(user.id);
    expect(directory.devices[0].daemon).toMatchObject({
      endpoints: [{ id: 'relay:mac-studio' }],
      sessions: [{ name: 'work' }],
    });
  });

  it('keeps daemon identity but hides route candidates when daemon disconnects', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');

    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'macbook-air',
      hostId: 'daemon-mba',
      endpoints: [{ id: 'relay:daemon-mba', kind: 'relay-rtc', relayHostId: 'daemon-mba', authRequired: true, lastSeenAt: '2026-06-28T00:00:00.000Z' }],
      sessions: [{ name: 'mobile-dev', updatedAt: '2026-06-28T00:00:00.000Z' }],
    });
    store.setDaemonConnected({
      userId: user.id,
      deviceId: 'macbook-air',
      hostId: 'daemon-mba',
      connected: false,
    });

    const directory = store.getAccountDirectory(user.id);
    expect(directory.devices[0]).toMatchObject({
      deviceId: 'macbook-air',
      daemon: {
        hostId: 'daemon-mba',
        presence: {
          connected: false,
        },
        endpoints: [],
        sessions: [],
      },
    });
  });

  it('retires an older online device binding when the same daemon host registers with a new device id', () => {
    const store = createStore();
    const user = store.register('Jason', 'secret');

    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'old-device',
      hostId: 'daemon-macbook-air',
      endpoints: [{
        id: 'relay:old',
        kind: 'relay-rtc',
        relayHostId: 'daemon-macbook-air',
        authRequired: true,
        lastSeenAt: '2026-08-03T00:00:00.000Z',
      }],
    });
    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'new-device',
      hostId: 'daemon-macbook-air',
      endpoints: [{
        id: 'relay:new',
        kind: 'relay-rtc',
        relayHostId: 'daemon-macbook-air',
        authRequired: true,
        lastSeenAt: '2026-08-03T00:00:01.000Z',
      }],
    });

    expect(store.clearOtherDaemonHostBindings({
      userId: user.id,
      deviceId: 'new-device',
      hostId: 'daemon-macbook-air',
    })).toBe(true);
    expect(store.getAccountDirectory(user.id).devices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deviceId: 'old-device',
        daemon: null,
      }),
      expect.objectContaining({
        deviceId: 'new-device',
        daemon: expect.objectContaining({
          hostId: 'daemon-macbook-air',
          presence: expect.objectContaining({ connected: true }),
        }),
      }),
    ]));
  });

  it('removes exact offline daemon rows without touching foreign rows, accounts, or tokens', () => {
    const { path, store } = createStoreFixture();
    const jason = store.register('Jason', 'secret');
    const jasonLogin = store.login('Jason', 'secret');
    const other = store.register('Other', 'other-secret');
    const otherLogin = store.login('Other', 'other-secret');

    createOfflineDaemonDevice(store, jason.id, 'shared-device', 'host-jason-shared');
    createOfflineDaemonDevice(store, other.id, 'shared-device', 'host-other-shared');
    createOfflineDaemonDevice(store, jason.id, 'offline-only', 'host-offline');
    createOfflineDaemonDevice(store, other.id, 'foreign-only', 'host-foreign');
    store.publishDaemonDirectory({
      userId: jason.id,
      deviceId: 'online-device',
      hostId: 'host-online',
    });
    store.setClientConnected({
      userId: jason.id,
      deviceId: 'client-only',
      connected: false,
    });

    const checks: string[] = [];
    const result = store.cleanupOfflineDevices(
      jason.id,
      ['shared-device', 'offline-only', 'missing-device'],
      (deviceId, daemonHostId) => {
        checks.push(`${deviceId}:${daemonHostId}`);
        return false;
      },
    );

    expect(result).toEqual({
      removedDeviceIds: ['shared-device', 'offline-only'],
      absentDeviceIds: ['missing-device'],
    });
    expect(checks).toEqual([
      'shared-device:host-jason-shared',
      'offline-only:host-offline',
    ]);
    expect(listDeviceIds(store, jason.id)).toEqual(['client-only', 'online-device']);
    expect(listDeviceIds(store, other.id)).toEqual(['foreign-only', 'shared-device']);

    const disk = readStoredDocument(path);
    const diskIds = disk.devices.map((device) => `${device.userId}:${device.deviceId}`);
    expect(diskIds).not.toContain(`${jason.id}:shared-device`);
    expect(diskIds).not.toContain(`${jason.id}:offline-only`);
    expect(diskIds).toContain(`${other.id}:shared-device`);
    expect(diskIds).toContain(`${other.id}:foreign-only`);
    expect(disk.users).toHaveLength(2);
    expect(disk.tokens).toHaveLength(2);

    result.removedDeviceIds.push('tampered');
    result.absentDeviceIds.length = 0;
    expect(listDeviceIds(store, jason.id)).not.toContain('tampered');
    expect(store.authenticate(jasonLogin.token)).toMatchObject({ id: jason.id });
    expect(store.authenticate(otherLogin.token)).toMatchObject({ id: other.id });
  });

  it('rejects a foreign-only device id without deleting it', () => {
    const { store } = createStoreFixture();
    const jason = store.register('Jason', 'secret');
    store.login('Jason', 'secret');
    const other = store.register('Other', 'other-secret');
    store.login('Other', 'other-secret');
    createOfflineDaemonDevice(store, other.id, 'foreign-only', 'host-foreign');

    let rejection: unknown;
    try {
      store.cleanupOfflineDevices(jason.id, ['foreign-only'], () => false);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(DeviceCleanupRejectedError);
    const cleanupError = rejection as DeviceCleanupRejectedError;
    expect(cleanupError.message).toBe('device cleanup rejected');
    expect(cleanupError.rejected).toEqual([
      { deviceId: 'foreign-only', reason: 'not_owned' },
    ]);
    expect(listDeviceIds(store, jason.id)).toEqual([]);
    expect(listDeviceIds(store, other.id)).toEqual(['foreign-only']);
  });

  it('rejects an owned client-only record as not_daemon', () => {
    const { store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    store.setClientConnected({
      userId: user.id,
      deviceId: 'client-only',
      connected: false,
    });
    let predicateCalls = 0;

    let rejection: unknown;
    try {
      store.cleanupOfflineDevices(user.id, ['client-only'], () => {
        predicateCalls += 1;
        return false;
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(DeviceCleanupRejectedError);
    expect((rejection as DeviceCleanupRejectedError).rejected).toEqual([
      { deviceId: 'client-only', reason: 'not_daemon' },
    ]);
    expect(predicateCalls).toBe(0);
    expect(listDeviceIds(store, user.id)).toEqual(['client-only']);
  });

  it('rejects stored-online and physically-connected rows without deleting eligible rows', () => {
    const { store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    createOfflineDaemonDevice(store, user.id, 'eligible-device', 'host-eligible');
    createOfflineDaemonDevice(store, user.id, 'physical-device', 'host-physical');
    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'stored-online-device',
      hostId: 'host-stored-online',
    });
    const checks: string[] = [];

    let rejection: unknown;
    try {
      store.cleanupOfflineDevices(
        user.id,
        ['stored-online-device', 'physical-device', 'eligible-device'],
        (deviceId) => {
          checks.push(deviceId);
          return deviceId === 'physical-device';
        },
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(DeviceCleanupRejectedError);
    expect((rejection as DeviceCleanupRejectedError).rejected).toEqual([
      { deviceId: 'stored-online-device', reason: 'online' },
      { deviceId: 'physical-device', reason: 'online' },
    ]);
    expect(checks).toEqual(['physical-device', 'eligible-device']);
    expect(listDeviceIds(store, user.id)).toEqual([
      'eligible-device',
      'physical-device',
      'stored-online-device',
    ]);
  });

  it('rejects a mixed batch as a whole and preserves every row', () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    const other = store.register('Other', 'other-secret');
    createOfflineDaemonDevice(store, user.id, 'eligible-device', 'host-eligible');
    store.setClientConnected({
      userId: user.id,
      deviceId: 'client-only',
      connected: false,
    });
    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'online-device',
      hostId: 'host-online',
    });
    createOfflineDaemonDevice(store, other.id, 'foreign-device', 'host-foreign');
    const before = readFileSync(path, 'utf-8');

    let rejection: unknown;
    try {
      store.cleanupOfflineDevices(
        user.id,
        ['eligible-device', 'client-only', 'online-device', 'foreign-device', 'absent-device'],
        () => false,
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(DeviceCleanupRejectedError);
    expect((rejection as DeviceCleanupRejectedError).rejected).toEqual([
      { deviceId: 'client-only', reason: 'not_daemon' },
      { deviceId: 'online-device', reason: 'online' },
      { deviceId: 'foreign-device', reason: 'not_owned' },
    ]);
    expect(listDeviceIds(store, user.id)).toEqual([
      'client-only',
      'eligible-device',
      'online-device',
    ]);
    expect(listDeviceIds(store, other.id)).toEqual(['foreign-device']);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('reports absent ids on retry and avoids a redundant write', () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    createOfflineDaemonDevice(store, user.id, 'offline-device', 'host-offline');
    store.publishDaemonDirectory({
      userId: user.id,
      deviceId: 'protected-online',
      hostId: 'host-protected',
    });

    const first = store.cleanupOfflineDevices(
      user.id,
      ['offline-device', 'absent-device'],
      () => false,
    );
    expect(first).toEqual({
      removedDeviceIds: ['offline-device'],
      absentDeviceIds: ['absent-device'],
    });
    const beforeRetry = readFileSync(path, 'utf-8');
    const retry = store.cleanupOfflineDevices(
      user.id,
      ['offline-device', 'absent-device'],
      () => false,
    );
    expect(retry).toEqual({
      removedDeviceIds: [],
      absentDeviceIds: ['offline-device', 'absent-device'],
    });
    expect(readFileSync(path, 'utf-8')).toBe(beforeRetry);
    expect(listDeviceIds(store, user.id)).toEqual(['protected-online']);
  });

  it('does not partially delete cleanup rows when persistence fails', () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    createOfflineDaemonDevice(store, user.id, 'cleanup-a', 'host-a');
    createOfflineDaemonDevice(store, user.id, 'cleanup-b', 'host-b');
    const before = readFileSync(path, 'utf-8');
    const blocker = blockTemporaryWrite(path);

    let failure: unknown;
    try {
      store.cleanupOfflineDevices(user.id, ['cleanup-a', 'cleanup-b'], () => false);
    } catch (error) {
      failure = error;
    }
    const afterFailureMemory = listDeviceIds(store, user.id);
    const afterFailureDisk = readFileSync(path, 'utf-8');
    rmSync(blocker, { recursive: true, force: true });

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(DeviceCleanupRejectedError);
    expect(afterFailureMemory).toEqual(['cleanup-a', 'cleanup-b']);
    expect(afterFailureDisk).toBe(before);
    expect(store.cleanupOfflineDevices(user.id, ['cleanup-a', 'cleanup-b'], () => false)).toEqual({
      removedDeviceIds: ['cleanup-a', 'cleanup-b'],
      absentDeviceIds: [],
    });
  });

  it('validates exact unique ids and never uses prefix matching', () => {
    const { path, store } = createStoreFixture();
    const user = store.register('Jason', 'secret');
    createOfflineDaemonDevice(store, user.id, 'device-1', 'host-device-1');
    const before = readFileSync(path, 'utf-8');
    const predicate = () => false;

    expect(() => store.cleanupOfflineDevices(user.id, [], predicate)).toThrow(
      'deviceIds must contain between 1 and 100 unique exact IDs',
    );
    expect(() => store.cleanupOfflineDevices(user.id, ['device-1', 'device-1'], predicate)).toThrow(
      'deviceIds must contain between 1 and 100 unique exact IDs',
    );
    expect(() => store.cleanupOfflineDevices(user.id, [' device-1'], predicate)).toThrow(
      'deviceIds must contain between 1 and 100 unique exact IDs',
    );
    expect(() => store.cleanupOfflineDevices(user.id, [''], predicate)).toThrow(
      'deviceIds must contain between 1 and 100 unique exact IDs',
    );
    expect(() => store.cleanupOfflineDevices(
      user.id,
      Array.from({ length: 101 }, (_, index) => `id-${index}`),
      predicate,
    )).toThrow('deviceIds must contain between 1 and 100 unique exact IDs');
    expect(() => store.cleanupOfflineDevices('missing-user', ['device-1'], predicate)).toThrow(
      'user missing-user not found',
    );
    expect(store.cleanupOfflineDevices(user.id, ['device'], predicate)).toEqual({
      removedDeviceIds: [],
      absentDeviceIds: ['device'],
    });
    expect(listDeviceIds(store, user.id)).toEqual(['device-1']);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});
