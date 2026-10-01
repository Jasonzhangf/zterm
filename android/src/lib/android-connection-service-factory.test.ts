import { describe, expect, it } from 'vitest';
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

    expect(target).toMatchObject({ bridgeHost: '192.168.50.30', lanHost: '192.168.50.20' });
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
});
