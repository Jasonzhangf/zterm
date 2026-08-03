// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  projectOnlineTraversalRelayDaemonDevicesFromAccount,
  readOnlineTraversalRelayDaemonDevices,
} from './traversal-relay-devices';

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
          {
            deviceId: 'rtc-device-1784267569532',
            deviceName: 'rtc-device-1784267569532',
            platform: 'darwin',
            appVersion: '0.1.1',
            updatedAt: '2026-05-06T00:00:00Z',
            client: { connected: false, lastSeenAt: '2026-05-06T00:00:00Z' },
            daemon: {
              connected: false,
              lastSeenAt: '2026-05-06T00:00:00Z',
              hostId: 'rtc-verify-1784267569532',
              version: '1.2.3',
              endpoints: [{
                id: 'relay-rtc:rtc-verify-1784267569532',
                kind: 'relay-rtc',
                relayHostId: 'rtc-verify-1784267569532',
                authRequired: true,
                lastSeenAt: '2026-05-06T00:00:00Z',
              }],
              sessions: [{
                name: 'stale-session',
                updatedAt: '2026-05-06T00:00:00Z',
              }],
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

  it('keeps an online daemon when an older partial directory only contains the client row', () => {
    const daemon = {
      deviceId: 'mac-studio',
      deviceName: 'Mac Studio',
      platform: 'darwin',
      appVersion: '0.1.3',
      updatedAt: '2026-08-01T00:00:00Z',
      client: { connected: false, lastSeenAt: '2026-08-01T00:00:00Z' },
      daemon: {
        connected: true,
        lastSeenAt: '2026-08-01T00:00:00Z',
        hostId: 'mac-studio',
        version: '0.1.3',
      },
    };
    const projected = projectOnlineTraversalRelayDaemonDevicesFromAccount({
      directory: {
        version: 1,
        devices: [{
          deviceId: 'mac-studio',
          deviceName: 'Mac Studio',
          platform: 'darwin',
          appVersion: '0.1.3',
          client: { connected: false, lastSeenAt: '2026-08-01T00:00:00Z' },
          daemon: null,
        }],
        updatedAt: '2026-08-01T00:00:00Z',
      },
      devices: [daemon],
    } as any);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(expect.objectContaining({ deviceId: 'mac-studio' }));
    expect(projected[0].daemon.hostId).toBe('mac-studio');
  });

  it('does not resurrect a daemon when the confirmed directory says it is disconnected', () => {
    const projected = projectOnlineTraversalRelayDaemonDevicesFromAccount({
      directory: {
        version: 1,
        devices: [{
          deviceId: 'mac-studio',
          deviceName: 'Mac Studio',
          platform: 'darwin',
          appVersion: '0.1.3',
          client: { connected: false, lastSeenAt: '2026-08-01T00:00:00Z' },
          daemon: {
            hostId: 'mac-studio',
            version: '0.1.3',
            presence: { connected: false, lastSeenAt: '2026-08-01T00:00:00Z' },
            endpoints: [],
            sessions: [],
          },
        }],
        updatedAt: '2026-08-01T00:00:00Z',
      },
      devices: [{
        deviceId: 'mac-studio',
        deviceName: 'Mac Studio',
        platform: 'darwin',
        appVersion: '0.1.3',
        updatedAt: '2026-08-01T00:00:01Z',
        client: { connected: true, lastSeenAt: '2026-08-01T00:00:01Z' },
        daemon: { connected: true, lastSeenAt: '2026-08-01T00:00:01Z', hostId: 'mac-studio', version: '0.1.3' },
      }],
    } as any);

    expect(projected).toEqual([]);
  });
});
