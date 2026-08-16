import { describe, expect, it, vi } from 'vitest';
import { createClientDaemonConnection } from './client-daemon-connection';

function createResource(socket: any, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    runtime: null,
    targetRuntime: null,
    targetKey: 'daemon=mac-studio',
    host: null,
    socket,
    socketReadyState: socket?.readyState ?? null,
    socketState: socket?.readyState === WebSocket.OPEN ? 'open' : 'closed',
    controlSocket: null,
    requestedTerminalGeometry: null,
    terminalSocket: socket,
    channel: { channelId: 'channel:session-1', state: 'open' },
    ...overrides,
  } as any;
}

describe('client.daemon_connection interface', () => {
  it('sends feature messages through the session resource effective socket', () => {
    const socket = { readyState: WebSocket.OPEN };
    const sendSocketPayload = vi.fn();
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(socket),
      sendSocketPayload,
    });

    expect(connection.sendSessionMessage('session-1', {
      type: 'schedule-list',
      payload: { sessionName: 'zterm' },
    })).toBe(true);

    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-1',
      socket,
      JSON.stringify({ type: 'schedule-list', payload: { sessionName: 'zterm' } }),
    );
  });

  it('fails explicitly instead of exposing a closed or missing socket', () => {
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(null, {
        targetKey: 'daemon=mac-studio',
        channel: { channelId: 'channel:session-1', state: 'open' },
      }),
      sendSocketPayload: vi.fn(),
    });

    expect(connection.sendSessionRaw('session-1', { type: 'ping' })).toBe(false);
    expect(() => connection.readOpenSessionSocket('session-1', 'remote window catalog')).toThrow(
      'remote window catalog requires an open daemon connection',
    );
  });

  it('opens target transports through the daemon connection owner hook', () => {
    const openedSocket = { readyState: WebSocket.CONNECTING };
    const openSessionTargetTransport = vi.fn(() => openedSocket as any);
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(null),
      sendSocketPayload: vi.fn(),
      openSessionTargetTransport,
    });
    const host = {
      id: 'host-1',
      createdAt: 1,
      name: 'Mac Studio',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      sessionName: 'zterm',
      authType: 'password' as const,
      tags: [],
      pinned: false,
    };
    const finalizeFailure = vi.fn();

    expect(connection.openSessionTargetTransport?.({
      sessionId: 'session-1',
      host,
      debugScope: 'connect',
      finalizeFailure,
    })).toBe(openedSocket);

    expect(openSessionTargetTransport).toHaveBeenCalledWith({
      sessionId: 'session-1',
      host,
      debugScope: 'connect',
      finalizeFailure,
    });
  });
});
