import { describe, expect, it } from 'vitest';
import {
  buildDaemonConnectionEndpointCandidates,
  resolveDaemonTailscaleUpdateManifestUrl,
  type DaemonNetworkInterfaceMap,
} from './daemon-connection-endpoint-runtime';

const now = '2026-07-28T07:00:00.000Z';

describe('daemon connection endpoint runtime', () => {
  it('derives upgrade manifest from the Tailscale address, never a LAN address', () => {
    expect(resolveDaemonTailscaleUpdateManifestUrl({
      bridgePort: 3333,
      interfaces: {
        en0: [{ address: '192.168.50.20', family: 'IPv4', internal: false }],
        utun7: [{ address: '100.66.1.82', family: 'IPv4', internal: false }],
      },
    })).toBe('http://100.66.1.82:3333/updates/latest.json');
  });

  it('returns no remote upgrade manifest when no Tailscale address exists', () => {
    expect(resolveDaemonTailscaleUpdateManifestUrl({
      bridgePort: 3333,
      interfaces: { en0: [{ address: '192.168.50.20', family: 'IPv4', internal: false }] },
    })).toBe('');
  });

  it('publishes deterministic LAN, Tailscale, RTC-direct, and Relay candidates', () => {
    const interfaces: DaemonNetworkInterfaceMap = {
      en0: [
        { address: '192.168.50.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      utun7: [
        { address: '100.66.1.82', family: 'IPv4', internal: false },
      ],
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
      ],
    };

    expect(buildDaemonConnectionEndpointCandidates({
      hostId: 'mac-studio',
      bridgePort: 3333,
      now,
      interfaces,
    })).toEqual([
      {
        id: 'lan:192.168.50.20:3333',
        kind: 'lan',
        host: '192.168.50.20',
        port: 3333,
        authRequired: true,
        lastSeenAt: now,
      },
      {
        id: 'rtc-direct:mac-studio',
        kind: 'rtc-direct',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: now,
      },
      {
        id: 'tailscale:100.66.1.82:3333',
        kind: 'tailscale',
        host: '100.66.1.82',
        port: 3333,
        authRequired: true,
        lastSeenAt: now,
      },
      {
        id: 'relay-rtc:mac-studio',
        kind: 'relay-rtc',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: now,
      },
    ]);
  });

  it('publishes daemon auth token on account-scoped route candidates', () => {
    const candidates = buildDaemonConnectionEndpointCandidates({
      hostId: 'mac-studio',
      bridgePort: 3333,
      authToken: 'daemon-token',
      now,
      interfaces: {
        utun7: [
          { address: '100.66.1.82', family: 'IPv4', internal: false },
        ],
      },
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        id: 'rtc-direct:mac-studio',
        authToken: 'daemon-token',
      }),
      expect.objectContaining({
        id: 'tailscale:100.66.1.82:3333',
        authToken: 'daemon-token',
      }),
      expect.objectContaining({
        id: 'relay-rtc:mac-studio',
        authToken: 'daemon-token',
      }),
    ]);
  });

  it('excludes loopback, link-local, unspecified, duplicate, and public TCP addresses', () => {
    const interfaces: DaemonNetworkInterfaceMap = {
      en0: [
        { address: '0.0.0.0', family: 'IPv4', internal: false },
        { address: '169.254.1.2', family: 'IPv4', internal: false },
        { address: '203.0.113.20', family: 'IPv4', internal: false },
        { address: '192.168.1.2', family: 'IPv4', internal: false },
      ],
      bridge0: [
        { address: '192.168.1.2', family: 'IPv4', internal: false },
      ],
      lo0: [
        { address: '::1', family: 'IPv6', internal: true },
      ],
    };

    const candidates = buildDaemonConnectionEndpointCandidates({
      hostId: 'mac-studio',
      bridgePort: 3333,
      now,
      interfaces,
    });

    expect(candidates.filter((candidate) => candidate.kind === 'lan')).toEqual([
      expect.objectContaining({ host: '192.168.1.2' }),
    ]);
    expect(candidates.some((candidate) => candidate.host === '203.0.113.20')).toBe(false);
    expect(candidates.some((candidate) => candidate.host === '169.254.1.2')).toBe(false);
  });

  it('publishes a literal public UDP endpoint only when supplied by its UDP allocation owner', () => {
    const candidates = buildDaemonConnectionEndpointCandidates({
      hostId: 'mac-studio',
      bridgePort: 3333,
      now,
      interfaces: {},
      publicUdpEndpoint: {
        host: '198.51.100.40',
        port: 49152,
      },
    });

    expect(candidates).toContainEqual({
      id: 'rtc-direct:198.51.100.40:49152',
      kind: 'rtc-direct',
      host: '198.51.100.40',
      port: 49152,
      relayHostId: 'mac-studio',
      authRequired: true,
      lastSeenAt: now,
    });
  });
});
