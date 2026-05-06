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
});
