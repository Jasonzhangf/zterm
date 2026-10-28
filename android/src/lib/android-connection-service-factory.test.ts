import { describe, expect, it } from 'vitest';
import { defaultClientControlDirectoryRuntime } from './client-control-directory-runtime';
import { buildAndroidConnectionServiceTarget, resolveRoutePlanPath } from './android-connection-service-factory';

describe('buildAndroidConnectionServiceTarget', () => {
  it('keeps Relay directory LAN candidate authoritative', () => {
    const target = buildAndroidConnectionServiceTarget({
      id: 'host-lan-directory',
      createdAt: 1,
      name: 'LAN',
      bridgeHost: '192.168.50.30',
      bridgePort: 3333,
      sessionName: 'default',
      authType: 'password',
      tags: [],
      pinned: false,
      relayEndpointCandidates: [{
        id: 'lan:192.168.50.20:3333',
        kind: 'lan',
        host: '192.168.50.20',
        port: 3333,
        authRequired: true,
        lastSeenAt: '2026-09-28T00:00:00.000Z',
      }],
    } as any);

    expect(target).toMatchObject({
      bridgeHost: '192.168.50.30',
      lanHost: '192.168.50.20',
      lanHosts: ['192.168.50.20', '192.168.50.30'],
    });
  });

  it('preserves all multi-NIC directory LAN candidates in lanHosts', () => {
    const target = buildAndroidConnectionServiceTarget({
      id: 'host-multi-lan',
      createdAt: 1,
      name: 'Multi LAN',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      sessionName: 'default',
      authType: 'password',
      tags: [],
      pinned: false,
      relayEndpointCandidates: [
        {
          id: 'lan:10.211.31.100:3333',
          kind: 'lan',
          host: '10.211.31.100',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-09-28T00:00:00.000Z',
        },
        {
          id: 'lan:192.168.0.3:3333',
          kind: 'lan',
          host: '192.168.0.3',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-09-28T00:00:00.000Z',
        },
      ],
    } as any);

    expect(target.lanHost).toBe('10.211.31.100');
    expect(target.lanHosts).toEqual(['10.211.31.100', '192.168.0.3']);
  });

  it('maps private LAN bridgeHost into lanHost when no directory LAN candidate exists', () => {
    const target = buildAndroidConnectionServiceTarget({
      id: 'host-lan-bridge',
      createdAt: 1,
      name: 'LAN bridge',
      bridgeHost: '192.168.50.20',
      bridgePort: 3333,
      sessionName: 'default',
      authType: 'password',
      tags: [],
      pinned: false,
    } as any);

    expect(target.lanHost).toBe('192.168.50.20');
  });

  it('maps loopback bridgeHost into lanHost for emulator-to-host replay', () => {
    const target = buildAndroidConnectionServiceTarget({
      id: 'host-loopback',
      createdAt: 1,
      name: 'Loopback bridge',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'default',
      authType: 'password',
      tags: [],
      pinned: false,
    } as any);

    expect(target.lanHost).toBe('127.0.0.1');
  });

  it('does not treat public bridgeHost as lanHost', () => {
    const target = buildAndroidConnectionServiceTarget({
      id: 'host-public',
      createdAt: 1,
      name: 'Public bridge',
      bridgeHost: '203.0.113.10',
      bridgePort: 3333,
      sessionName: 'default',
      authType: 'password',
      tags: [],
      pinned: false,
    } as any);

    expect(target.lanHost).toBeUndefined();
  });

  it('classifies route plan path by real bridge host, not relayHostId', () => {
    const base = {
      id: 'host-route-plan',
      createdAt: 1,
      name: 'Route plan',
      bridgePort: 3333,
      sessionName: 'default',
      authType: 'password',
      tags: [],
      pinned: false,
      relayHostId: 'mac-studio',
    } as any;

    expect(resolveRoutePlanPath({ ...base, bridgeHost: '10.0.2.2' })).toBe('LAN');
    expect(resolveRoutePlanPath({ ...base, bridgeHost: '192.168.1.10' })).toBe('LAN');
    expect(resolveRoutePlanPath({ ...base, bridgeHost: '100.66.1.82' })).toBe('Tailscale');
    expect(resolveRoutePlanPath({ ...base, bridgeHost: '2001:db8::1' })).toBe('IPv6');
    expect(resolveRoutePlanPath({ ...base, bridgeHost: '203.0.113.10' })).toBe('IPv4');
  });

  it('prefers client traversalRelay.deviceId over daemon host.relayDeviceId and merges control directory endpoints', () => {
    defaultClientControlDirectoryRuntime.replaceFromDevices([{
      deviceId: 'mac-studio-device',
      deviceName: 'Mac Studio',
      updatedAt: '2026-10-28T00:00:00.000Z',
      daemon: {
        connected: true,
        hostId: 'mac-studio',
        lastSeenAt: '2026-10-28T00:00:00.000Z',
        endpoints: [
          {
            id: 'lan:10.211.31.100:3333',
            kind: 'lan',
            host: '10.211.31.100',
            port: 3333,
            authRequired: true,
            lastSeenAt: '2026-10-28T00:00:00.000Z',
          },
          {
            id: 'lan:192.168.0.3:3333',
            kind: 'lan',
            host: '192.168.0.3',
            port: 3333,
            authRequired: true,
            lastSeenAt: '2026-10-28T00:00:00.000Z',
          },
        ],
        sessions: [],
      },
    } as any]);

    try {
      const target = buildAndroidConnectionServiceTarget({
        id: 'host-saved',
        createdAt: 1,
        name: 'Mac Studio',
        bridgeHost: '192.168.0.3',
        bridgePort: 3333,
        daemonHostId: 'mac-studio',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio',
        sessionName: 'workspace-1',
        authType: 'password',
        tags: [],
        pinned: true,
      } as any, {
        traversalRelay: {
          relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
          username: 'jason',
          userId: 'user-1',
          accessToken: 'token-1',
          deviceId: 'android-mobile-15t',
          deviceName: 'OnePlus 15T',
          platform: 'android',
          wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
          wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
          wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
          turnUrl: 'turn:relay.codewhisper.cc:3479?transport=udp',
          turnUsername: 'ztermturn',
          turnCredential: 'secret',
          updatedAt: 1,
        },
      });

      expect(target.relayDeviceId).toBe('android-mobile-15t');
      expect(target.lanHosts).toEqual(['10.211.31.100', '192.168.0.3']);
    } finally {
      defaultClientControlDirectoryRuntime.clear();
    }
  });
});
