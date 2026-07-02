import { describe, expect, it } from 'vitest';
import {
  buildConnectionConfigShareLink,
  buildConnectionConfigSharePayload,
  encodeConnectionConfigSharePayload,
  parseConnectionConfigShareLink,
} from './connection-config-share';
import type { EditableHost } from './types';

const host: EditableHost = {
  name: 'Mac Studio',
  bridgeHost: '100.127.23.27:40807',
  bridgePort: 3333,
  daemonHostId: 'daemon-a',
  sessionName: 'main',
  authToken: 'token-a',
  relayHostId: 'daemon-a',
  relayDeviceId: 'device-a',
  tailscaleHost: 'mac.tailnet.ts.net',
  ipv6Host: '',
  ipv4Host: '',
  signalUrl: '',
  transportMode: 'webrtc',
  authType: 'key',
  password: 'must-not-export',
  privateKey: 'must-not-export',
  tags: [' work ', ''],
  pinned: true,
  lastConnected: 123,
  autoCommand: 'tmux attach -t main',
};

describe('connection config share link', () => {
  it('builds and parses an app link with normalized connection truth', () => {
    const link = buildConnectionConfigShareLink({ host, exportedAt: 1000 });
    const parsed = parseConnectionConfigShareLink(link);

    expect(link.startsWith('zterm://connection/import?payload=')).toBe(true);
    expect(parsed).toEqual({
      ok: true,
      payload: expect.objectContaining({
        kind: 'zterm.connection-config',
        schemaVersion: 1,
        exportedAt: 1000,
        hosts: [
          expect.objectContaining({
            name: 'Mac Studio',
            bridgeHost: '100.127.23.27',
          }),
        ],
      }),
      hosts: [
        expect.objectContaining({
          name: 'Mac Studio',
          bridgeHost: '100.127.23.27',
        }),
      ],
      host: expect.objectContaining({
        name: 'Mac Studio',
        bridgeHost: '100.127.23.27',
        bridgePort: 40807,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
        sessionName: 'main',
        authToken: 'token-a',
        transportMode: 'webrtc',
        tags: ['work'],
        pinned: true,
        autoCommand: 'tmux attach -t main',
        password: undefined,
        privateKey: undefined,
        lastConnected: undefined,
      }),
    });
  });

  it('builds a web link and accepts raw encoded payload for paste/import flows', () => {
    const payload = buildConnectionConfigSharePayload({ host, exportedAt: 1000 });
    const encoded = encodeConnectionConfigSharePayload(payload);
    const webLink = buildConnectionConfigShareLink({ host, exportedAt: 1000, linkKind: 'web' });

    expect(webLink.startsWith('https://zterm.app/connection/import?payload=')).toBe(true);
    expect(parseConnectionConfigShareLink(encoded)).toEqual(
      expect.objectContaining({
        ok: true,
        host: expect.objectContaining({ bridgeHost: '100.127.23.27', bridgePort: 40807 }),
      }),
    );
  });

  it('returns explicit errors for malformed or unsupported links', () => {
    expect(parseConnectionConfigShareLink('')).toEqual({
      ok: false,
      error: 'connection share link is missing payload',
    });
    expect(parseConnectionConfigShareLink('https://example.com/connection/import?payload=abc')).toEqual({
      ok: false,
      error: 'connection share link is missing payload',
    });
    expect(parseConnectionConfigShareLink('zterm://connection/import?payload=not-json')).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('connection share payload is not valid JSON'),
      }),
    );
  });

  it('rejects payloads without required connection identity instead of returning empty truth', () => {
    const encoded = encodeConnectionConfigSharePayload({
      kind: 'zterm.connection-config',
      schemaVersion: 1,
      exportedAt: 1000,
      host: {
        ...host,
        name: '',
        bridgeHost: '',
      },
    });

    expect(parseConnectionConfigShareLink(encoded)).toEqual({
      ok: false,
      error: 'connection share payload host is invalid',
    });
  });

  it('builds and parses all local connection configs in one share link', () => {
    const link = buildConnectionConfigShareLink({
      hosts: [
        host,
        {
          ...host,
          name: 'Linux Box',
          bridgeHost: '100.64.0.20',
          bridgePort: 3333,
          sessionName: 'work',
          authToken: 'token-b',
        },
      ],
      exportedAt: 2000,
    });

    const parsed = parseConnectionConfigShareLink(link);

    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      hosts: [
        expect.objectContaining({
          name: 'Mac Studio',
          bridgeHost: '100.127.23.27',
          bridgePort: 40807,
          password: undefined,
          privateKey: undefined,
          lastConnected: undefined,
        }),
        expect.objectContaining({
          name: 'Linux Box',
          bridgeHost: '100.64.0.20',
          bridgePort: 3333,
          sessionName: 'work',
          authToken: 'token-b',
        }),
      ],
    }));
    if (parsed.ok) {
      expect(parsed.payload.hosts).toHaveLength(2);
    }
  });
});
