import { describe, expect, it } from 'vitest';
import {
  buildRelayDirectoryUpdateEnvelope,
  publishRelayDirectoryUpdate,
} from './relay-client';

function createOpenSocket() {
  const sent: string[] = [];
  return {
    sent,
    socket: {
      readyState: 1,
      send: (payload: string) => sent.push(payload),
    },
  };
}

describe('traversal relay daemon directory publisher', () => {
  it('builds a directory-update with gateway endpoint candidates and tmux sessions', () => {
    const endpoints = [
      {
        id: 'lan:192.168.50.20:3333',
        kind: 'lan' as const,
        host: '192.168.50.20',
        port: 3333,
        authRequired: true,
        lastSeenAt: '2026-06-28T10:00:00.000Z',
      },
      {
        id: 'relay-rtc:daemon-host-1',
        kind: 'relay-rtc' as const,
        relayHostId: 'daemon-host-1',
        authRequired: true,
        lastSeenAt: '2026-06-28T10:00:00.000Z',
      },
    ];
    const envelope = buildRelayDirectoryUpdateEnvelope({
      endpoints,
      sessionNames: ['main', 'work', 'main', '  '],
      now: '2026-06-28T10:00:00.000Z',
    });

    expect(envelope).toEqual({
      type: 'directory-update',
      directory: {
        endpoints,
        sessions: [
          { name: 'main', updatedAt: '2026-06-28T10:00:00.000Z' },
          { name: 'work', updatedAt: '2026-06-28T10:00:00.000Z' },
        ],
        publishedAt: '2026-06-28T10:00:00.000Z',
      },
    });
  });

  it('publishes directory-update after tmux sessions are read successfully', () => {
    const { socket, sent } = createOpenSocket();
    const result = publishRelayDirectoryUpdate({
      socket,
      listEndpointCandidates: () => [{
        id: 'relay-rtc:daemon-host-1',
        kind: 'relay-rtc',
        relayHostId: 'daemon-host-1',
        authRequired: true,
        lastSeenAt: '2026-06-28T10:01:00.000Z',
      }],
      listTmuxSessions: () => ['main'],
      now: () => '2026-06-28T10:01:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({
      type: 'directory-update',
      directory: {
        endpoints: [{ kind: 'relay-rtc', relayHostId: 'daemon-host-1' }],
        sessions: [{ name: 'main' }],
      },
    });
  });

  it('reports tmux session read failure explicitly instead of publishing an empty success directory', () => {
    const { socket, sent } = createOpenSocket();
    const result = publishRelayDirectoryUpdate({
      socket,
      listEndpointCandidates: () => [{
        id: 'relay-rtc:daemon-host-1',
        kind: 'relay-rtc',
        relayHostId: 'daemon-host-1',
        authRequired: true,
        lastSeenAt: '2026-06-28T10:02:00.000Z',
      }],
      listTmuxSessions: () => {
        throw new Error('tmux unavailable');
      },
      now: () => '2026-06-28T10:02:00.000Z',
    });

    expect(result).toEqual({ ok: false, reason: 'tmux unavailable' });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: 'relay-error',
      reason: 'directory-update failed: tmux unavailable',
    });
  });

  it('reports endpoint discovery failure explicitly instead of publishing Relay-only fallback truth', () => {
    const { socket, sent } = createOpenSocket();
    const result = publishRelayDirectoryUpdate({
      socket,
      listEndpointCandidates: () => {
        throw new Error('network endpoint discovery failed');
      },
      listTmuxSessions: () => ['main'],
      now: () => '2026-06-28T10:03:00.000Z',
    });

    expect(result).toEqual({ ok: false, reason: 'network endpoint discovery failed' });
    expect(JSON.parse(sent[0])).toEqual({
      type: 'relay-error',
      reason: 'directory-update failed: network endpoint discovery failed',
    });
  });
});
