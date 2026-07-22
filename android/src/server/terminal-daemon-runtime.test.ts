import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { createTerminalDaemonRuntime } from './terminal-daemon-runtime';
import type { TerminalTransportSubscriber } from './terminal-runtime';
import {
  TERMINAL_TRANSPORT_STALE_INBOUND_MS,
  type DaemonTransportConnection,
} from './terminal-transport-runtime';

function createSessionSubscriber(transportId: string): TerminalTransportSubscriber {
  return {
    id: transportId,
    transportId,
    transport: null,
    sessionName: 'demo',
    mirrorKey: 'demo',
    bodySubscribed: true,
    adaptiveWidthCols: 58,
    adaptiveWidthHeartbeatAt: Date.now(),
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function createConnection(
  overrides: Partial<DaemonTransportConnection> = {},
): DaemonTransportConnection {
  const transport = {
    kind: 'rtc' as const,
    readyState: 1,
    bufferedAmount: 0,
    requestOrigin: 'relay-host',
    connectedSent: true,
    sendText: vi.fn(),
    close: vi.fn(),
  };
  const connection: DaemonTransportConnection = {
    id: 'connection-1',
    transportId: 'transport-1',
    transport,
    closeTransport: vi.fn((reason: string) => transport.close(reason)),
    requestOrigin: 'relay-host',
    role: 'session',
    boundSubscriberId: 'transport-1',
    wsAlive: true,
    ...overrides,
    lastInboundAt: overrides.lastInboundAt ?? Date.now(),
  };
  return connection;
}

function createRuntimeHarness() {
  const sessions = new Map<string, TerminalTransportSubscriber>();
  const connections = new Map<string, DaemonTransportConnection>();
  const connection = createConnection();
  const subscriber = createSessionSubscriber(connection.transportId);
  subscriber.transport = connection.transport;
  subscriber.closeTransport = connection.closeTransport;
  sessions.set(subscriber.id, subscriber);
  connections.set(connection.id, connection);
  const detachSubscriberTransportOnly = vi.fn();
  const destroyMirror = vi.fn();
  const runtime = createTerminalDaemonRuntime({
    host: '127.0.0.1',
    port: 3333,
    requiredAuthToken: '',
    updatesDir: '/tmp/updates',
    tmuxBinary: 'tmux',
    defaultSessionName: 'zterm',
    logDir: '/tmp/logs',
    configDisplayPath: '/tmp/config.json',
    authLabel: 'disabled',
    relayLabel: 'disabled',
    terminalCacheLines: 1000,
    wsHeartbeatIntervalMs: 1000,
    memoryGuardIntervalMs: 60000,
    memoryGuardMaxRssBytes: Number.MAX_SAFE_INTEGER,
    memoryGuardMaxHeapUsedBytes: Number.MAX_SAFE_INTEGER,
    startupPortConflictExitCode: 78,
    sessions,
    connections,
    mirrors: new Map(),
    server: { close: vi.fn() } as never,
    wss: { close: vi.fn() } as never,
    logTimePrefix: () => '2026-07-20 00:00:00',
    shutdownTerminalSessions: vi.fn(),
    destroyMirror,
    disposeScheduleRuntime: vi.fn(),
    startRelayHostClient: vi.fn(),
    disposeRelayHostClient: vi.fn(),
    disposeRtcBridgeServer: vi.fn(),
    detachSubscriberTransportOnly,
  } as Parameters<typeof createTerminalDaemonRuntime>[0]);

  return {
    connection,
    connections,
    detachSubscriberTransportOnly,
    destroyMirror,
    runtime,
    sessions,
    subscriber,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('terminal daemon runtime transport liveness', () => {
  it('keeps quiet rtc session transports before the client heartbeat can run', () => {
    const { connection, connections, detachSubscriberTransportOnly, runtime } =
      createRuntimeHarness();

    runtime.startHeartbeatLoop();
    vi.setSystemTime(new Date('2026-07-20T00:00:11Z'));
    vi.advanceTimersByTime(1000);

    expect(connection.closeTransport).not.toHaveBeenCalled();
    expect(detachSubscriberTransportOnly).not.toHaveBeenCalled();
    expect(connections.has(connection.id)).toBe(true);
  });

  it('detaches stale bound rtc session transports through the subscriber detach owner after the daemon stale bound', () => {
    const { connection, connections, detachSubscriberTransportOnly, destroyMirror, runtime, subscriber } =
      createRuntimeHarness();

    runtime.startHeartbeatLoop();
    vi.setSystemTime(new Date(Date.parse('2026-07-20T00:00:00Z') + TERMINAL_TRANSPORT_STALE_INBOUND_MS + 1000));
    vi.advanceTimersByTime(1000);

    expect(connection.closeTransport).toHaveBeenCalledWith('transport heartbeat stale');
    expect(detachSubscriberTransportOnly).toHaveBeenCalledWith(
      subscriber,
      'transport heartbeat stale',
      connection.transportId,
    );
    expect(connections.has(connection.id)).toBe(false);
    expect(destroyMirror).not.toHaveBeenCalled();
  });

  it('keeps active rtc session transports when inbound activity keeps arriving', () => {
    const { connection, connections, detachSubscriberTransportOnly, runtime } = createRuntimeHarness();
    runtime.startHeartbeatLoop();

    for (const elapsedMs of [2000, 4000, 6000, 8000]) {
      vi.setSystemTime(new Date(Date.parse('2026-07-20T00:00:00Z') + elapsedMs));
      connection.lastInboundAt = Date.now();
      vi.advanceTimersByTime(1000);
    }

    expect(connection.closeTransport).not.toHaveBeenCalled();
    expect(detachSubscriberTransportOnly).not.toHaveBeenCalled();
    expect(connections.has(connection.id)).toBe(true);
  });

  it('detaches every mux channel subscriber when the physical target transport goes stale', () => {
    const { connection, connections, detachSubscriberTransportOnly, runtime, sessions } = createRuntimeHarness();
    const subscriberA = createSessionSubscriber('transport-1:channel-a');
    const subscriberB = createSessionSubscriber('transport-1:channel-b');
    subscriberA.transportId = connection.transportId;
    subscriberB.transportId = connection.transportId;
    subscriberA.transport = connection.transport;
    subscriberB.transport = connection.transport;
    connection.boundSubscriberId = null;
    connection.muxChannels = new Map([
      ['channel-a', subscriberA.id],
      ['channel-b', subscriberB.id],
    ]);
    sessions.set(subscriberA.id, subscriberA);
    sessions.set(subscriberB.id, subscriberB);

    runtime.startHeartbeatLoop();
    vi.setSystemTime(new Date(Date.parse('2026-07-20T00:00:00Z') + TERMINAL_TRANSPORT_STALE_INBOUND_MS + 1000));
    vi.advanceTimersByTime(1000);

    expect(connection.closeTransport).toHaveBeenCalledWith('transport heartbeat stale');
    expect(detachSubscriberTransportOnly).toHaveBeenCalledWith(
      subscriberA,
      'transport heartbeat stale',
      connection.transportId,
    );
    expect(detachSubscriberTransportOnly).toHaveBeenCalledWith(
      subscriberB,
      'transport heartbeat stale',
      connection.transportId,
    );
    expect(connection.muxChannels.size).toBe(0);
    expect(connections.has(connection.id)).toBe(false);
  });
}
);
