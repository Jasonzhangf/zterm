// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { readOnlineTraversalRelayDaemonDevices } from './traversal-relay-devices';

describe('traversal-relay-devices truth', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  });

  it('reads online daemon devices from the stored relay account through one entry', () => {
    window.localStorage.setItem(
      'zterm:traversal-relay-account',
      JSON.stringify({
        username: 'jason',
        password: 'pw',
        relayBaseUrl: 'http://159.75.134.56/relay/',
        accessToken: 'access-1',
        deviceId: 'tablet-1',
        deviceName: 'Jason Tablet',
        platform: 'android',
        devices: [
          {
            deviceId: 'daemon-online',
            deviceName: 'Claw Mac',
            platform: 'mac',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: true,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'daemon-host-claw',
              version: '1.2.3',
            },
          },
          {
            deviceId: 'client-only',
            deviceName: 'Phone',
            platform: 'android',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: true, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: false,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: '',
              version: '',
            },
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    expect(readOnlineTraversalRelayDaemonDevices()).toEqual([
      expect.objectContaining({
        deviceId: 'daemon-online',
        daemon: expect.objectContaining({
          hostId: 'daemon-host-claw',
        }),
      }),
    ]);
  });
});
