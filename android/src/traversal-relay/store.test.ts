import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraversalRelayStore } from './store';

const tempDirs: string[] = [];

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), 'zterm-traversal-store-'));
  tempDirs.push(dir);
  return new TraversalRelayStore(join(dir, 'store.json'));
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
});
