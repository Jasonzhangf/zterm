import { describe, expect, it } from 'vitest';
import { validateRelayDirectoryUpdatePayload } from './relay-directory';

describe('relay directory control payload contract', () => {
  it('accepts endpoint, route identity, heartbeat timestamp, and device session metadata', () => {
    expect(validateRelayDirectoryUpdatePayload({
      endpoints: [{
        id: 'lan:192.168.1.20:3333',
        kind: 'lan',
        host: '192.168.1.20',
        port: 3333,
        authToken: 'daemon-token',
        authRequired: true,
        lastSeenAt: '2026-07-28T07:00:00.000Z',
      }],
      sessions: [{
        name: 'main',
        updatedAt: '2026-07-28T07:00:00.000Z',
      }],
      publishedAt: '2026-07-28T07:00:00.000Z',
    })).toBe(true);
  });

  it('rejects terminal buffer data on the control chain', () => {
    expect(() => validateRelayDirectoryUpdatePayload({
      endpoints: [],
      sessions: [],
      publishedAt: '2026-07-28T07:00:00.000Z',
      bufferSync: {
        sessionId: 'main',
        lines: ['forbidden'],
      },
    })).toThrow('unknown control field: bufferSync');
  });

  it('rejects terminal payload hidden inside an endpoint candidate', () => {
    expect(() => validateRelayDirectoryUpdatePayload({
      endpoints: [{
        id: 'relay-rtc:mac-studio',
        kind: 'relay-rtc',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: '2026-07-28T07:00:00.000Z',
        terminalData: 'forbidden',
      }],
      sessions: [],
      publishedAt: '2026-07-28T07:00:00.000Z',
    })).toThrow('unknown endpoint control field: terminalData');
  });
});
