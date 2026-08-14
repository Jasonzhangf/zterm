// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  listOnlineTraversalRelayDaemonDevices,
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
              lastSeenAt: new Date().toISOString(),
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
        lastSeenAt: new Date().toISOString(),
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

  it('projects one online machine when account and directory use different device ids for one daemon host', () => {
    const projected = projectOnlineTraversalRelayDaemonDevicesFromAccount({
      directory: {
        version: 1,
        devices: [{
          deviceId: 'old-registration',
          deviceName: 'Old Mac Name',
          platform: 'darwin',
          appVersion: '0.1.3',
          client: { connected: false, lastSeenAt: '2026-08-10T00:00:00Z' },
          daemon: {
            hostId: 'mac-studio',
            version: '0.1.3',
            presence: { connected: true, lastSeenAt: '2026-08-10T00:00:00Z' },
            endpoints: [],
            sessions: [],
          },
        }],
        updatedAt: '2026-08-10T00:00:00Z',
      },
      devices: [{
        deviceId: 'current-registration',
        deviceName: 'Current Mac Name',
        platform: 'darwin',
        appVersion: '0.1.3',
        updatedAt: '2026-08-10T00:00:01Z',
        client: { connected: false, lastSeenAt: '2026-08-10T00:00:01Z' },
        daemon: {
          connected: true,
          lastSeenAt: new Date().toISOString(),
          hostId: 'mac-studio',
          version: '0.1.3',
          sessions: [{ name: 'shell', updatedAt: new Date().toISOString() }],
        },
      }],
    } as any);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      deviceId: 'current-registration',
      daemon: { hostId: 'mac-studio', sessions: [{ name: 'shell' }] },
    });
  });
});

  it('filters a stale connected daemon (half-open relay residue) while keeping a fresh one', () => {
    // 半开残留：旧 wterm 0.1.0 实例 connected=true 但 lastSeenAt 已是 10 小时前
    const stale = {
      deviceId: 'Macstudio.local-daemon',
      deviceName: 'Macstudio.local',
      platform: 'darwin',
      appVersion: '0.1.0',
      updatedAt: '2026-08-10T04:32:36.126Z',
      client: { connected: false, lastSeenAt: '2026-08-10T04:32:36.126Z' },
      daemon: {
        connected: true,
        lastSeenAt: '2026-08-10T04:32:36.126Z',
        hostId: 'c5f61277-c563-47e7-a82f-a63141b577a5',
        version: '0.1.0',
      },
    };
    const fresh = {
      deviceId: 'mac-studio',
      deviceName: 'Mac Studio',
      platform: 'darwin',
      appVersion: '0.1.3',
      updatedAt: new Date().toISOString(),
      client: { connected: false, lastSeenAt: new Date().toISOString() },
      daemon: {
        connected: true,
        lastSeenAt: new Date().toISOString(),
        hostId: 'mac-studio',
        version: '0.1.3',
      },
    };
    const projected = projectOnlineTraversalRelayDaemonDevicesFromAccount({
      directory: null,
      devices: [stale, fresh],
    } as any);

    expect(projected.map((device) => device.deviceId)).toEqual(['mac-studio']);
  });

it('keeps a stale connected daemon that this client recently connected to (daemon not yet upgraded to periodic publish)', () => {
  // 未升级 daemon：lastSeenAt 停在启动时刻（陈旧），但本客户端 1 分钟前刚连通过该 daemon
  const staleButRecentlyConnected = {
    deviceId: 'mac-studio',
    deviceName: 'Mac Studio',
    platform: 'darwin',
    appVersion: '0.1.3',
    updatedAt: '2026-08-10T04:32:36.126Z',
    client: { connected: false, lastSeenAt: '2026-08-10T04:32:36.126Z' },
    daemon: {
      connected: true,
      lastSeenAt: '2026-08-10T04:32:36.126Z',
      hostId: 'mac-studio',
      version: '0.1.3',
    },
  };
  const now = Date.now();
  const recentConnections = new Map<string, number>([['mac-studio', now - 60_000]]);
  const online = listOnlineTraversalRelayDaemonDevices([staleButRecentlyConnected], now, recentConnections);
  expect(online.map((device) => device.deviceId)).toEqual(['mac-studio']);
});

it('still filters a stale connected daemon the client never connected to', () => {
  const staleNeverConnected = {
    deviceId: 'Macstudio.local-daemon',
    deviceName: 'Macstudio.local',
    platform: 'darwin',
    appVersion: '0.1.0',
    updatedAt: '2026-08-10T04:32:36.126Z',
    client: { connected: false, lastSeenAt: '2026-08-10T04:32:36.126Z' },
    daemon: {
      connected: true,
      lastSeenAt: '2026-08-10T04:32:36.126Z',
      hostId: 'c5f61277-c563-47e7-a82f-a63141b577a5',
      version: '0.1.0',
    },
  };
  const now = Date.now();
  const recentConnections = new Map<string, number>();
  const online = listOnlineTraversalRelayDaemonDevices([staleNeverConnected], now, recentConnections);
  expect(online).toHaveLength(0);
});
