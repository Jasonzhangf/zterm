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
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
        {
          id: 'relay:daemon-mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'daemon-mac-studio',
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
          { id: 'tailscale:mac-studio', kind: 'tailscale', host: 'mac-studio.tailnet.ts.net', port: 3333 },
          { id: 'relay:daemon-mac-studio', kind: 'relay-rtc', relayHostId: 'daemon-mac-studio' },
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
            sessions: [
              { name: 'work' },
              { name: 'ops' },
            ],
          },
        },
      ],
    });
  });

  it('keeps last published directory facts when daemon disconnects', () => {
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
        endpoints: [{ id: 'relay:daemon-mba', kind: 'relay-rtc' }],
        sessions: [{ name: 'mobile-dev' }],
      },
    });
  });
});
