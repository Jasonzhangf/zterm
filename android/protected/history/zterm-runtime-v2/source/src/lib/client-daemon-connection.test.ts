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

  it('reuses an OPEN same-target transport instead of building a second socket', () => {
    const existingSocket = { readyState: WebSocket.OPEN };
    const openSessionTargetTransport = vi.fn(() => ({ readyState: WebSocket.CONNECTING }) as any);
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(existingSocket),
      sendSocketPayload: vi.fn(),
      openSessionTargetTransport,
    });

    expect(connection.openSessionTargetTransport?.({
      sessionId: 'session-1',
      host: makeHost(),
      debugScope: 'connect',
      finalizeFailure: vi.fn(),
    })).toBe(existingSocket);

    expect(openSessionTargetTransport).not.toHaveBeenCalled();
  });

  it('reuses a CONNECTING same-target transport instead of building a second socket', () => {
    const existingSocket = { readyState: WebSocket.CONNECTING };
    const openSessionTargetTransport = vi.fn(() => ({ readyState: WebSocket.CONNECTING }) as any);
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(existingSocket),
      sendSocketPayload: vi.fn(),
      openSessionTargetTransport,
    });

    expect(connection.openSessionTargetTransport?.({
      sessionId: 'session-1',
      host: makeHost(),
      debugScope: 'reconnect',
      finalizeFailure: vi.fn(),
    })).toBe(existingSocket);

    expect(openSessionTargetTransport).not.toHaveBeenCalled();
  });

  it('builds a new transport only when the same-target socket is missing or closed', () => {
    const openSessionTargetTransport = vi.fn(() => ({ readyState: WebSocket.CONNECTING }) as any);
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource({ readyState: WebSocket.CLOSED }),
      sendSocketPayload: vi.fn(),
      openSessionTargetTransport,
    });

    expect(connection.openSessionTargetTransport?.({
      sessionId: 'session-1',
      host: makeHost(),
      debugScope: 'connect',
      finalizeFailure: vi.fn(),
    })).toEqual(openSessionTargetTransport.mock.results[0]?.value);

    expect(openSessionTargetTransport).toHaveBeenCalledTimes(1);
  });

  it('retains only the current typed probe error and supports explicit acknowledgement', () => {
    const onTargetNetworkProbeError = vi.fn();
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(null),
      sendSocketPayload: vi.fn(),
      onTargetNetworkProbeError,
    });
    const first = {
      type: 'TargetNetworkProbeError04NativeSnapshot' as const,
      message: 'first snapshot failure',
    };
    const second = {
      type: 'TargetNetworkProbeError04NativeSnapshot' as const,
      message: 'second snapshot failure',
    };

    connection.reportTargetNetworkProbeError?.(first);
    connection.reportTargetNetworkProbeError?.(second);

    expect(onTargetNetworkProbeError).toHaveBeenNthCalledWith(1, first);
    expect(onTargetNetworkProbeError).toHaveBeenNthCalledWith(2, second);
    expect(connection.readTargetNetworkProbeError?.()).toBe(second);
    expect(connection.acknowledgeTargetNetworkProbeError?.(first)).toBe(false);
    expect(connection.readTargetNetworkProbeError?.()).toBe(second);
    expect(connection.acknowledgeTargetNetworkProbeError?.(second)).toBe(true);
    expect(connection.readTargetNetworkProbeError?.()).toBeNull();
    expect(connection.acknowledgeTargetNetworkProbeError?.()).toBe(false);
  });

  it('keeps a typed probe error visible when no consumer is registered', () => {
    const connection = createClientDaemonConnection({
      readSessionTransportResource: () => createResource(null),
      sendSocketPayload: vi.fn(),
    });
    const failure = {
      type: 'TargetNetworkProbeError04NativeSnapshot' as const,
      message: 'consumer unavailable',
    };

    connection.reportTargetNetworkProbeError?.(failure);

    expect(connection.readTargetNetworkProbeError?.()).toBe(failure);
  });
});

function makeHost() {
  return {
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
}
