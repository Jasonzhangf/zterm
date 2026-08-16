import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeRelayDeviceStreamReconnectDelay,
  createRelayDeviceStreamRuntime,
  mergeRelayPresenceWithDirectoryTruth,
  RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS,
  RELAY_DEVICE_STREAM_HEARTBEAT_MAX_MISSES,
} from './relay-device-stream-runtime';
import type { TraversalRelayClientSettings } from './bridge-settings';
import type { TraversalRelayDeviceSnapshot } from './types';

function makeDevice(overrides: Partial<TraversalRelayDeviceSnapshot> = {}): TraversalRelayDeviceSnapshot {
  return {
    deviceId: overrides.deviceId || 'device-1',
    deviceName: overrides.deviceName || 'Mac',
    platform: overrides.platform || 'darwin',
    appVersion: overrides.appVersion || '0.1.3',
    updatedAt: overrides.updatedAt || '2026-07-27T00:00:00.000Z',
    client: overrides.client || {
      connected: false,
      lastSeenAt: '2026-07-27T00:00:00.000Z',
    },
    daemon: {
      connected: true,
      lastSeenAt: '2026-07-27T00:00:00.000Z',
      hostId: 'mac-studio',
      version: '0.1.3',
      endpoints: overrides.daemon?.endpoints,
      sessions: overrides.daemon?.sessions,
      ...(overrides.daemon || {}),
    },
  };
}

class FakeSocket {
  readyState = 1;
  onclose: ((event: Partial<CloseEvent>) => void) | null = null;
  sent: string[] = [];
  send = vi.fn((payload: string) => {
    this.sent.push(payload);
  });
  close = vi.fn((code = 1000, reason = '') => {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  });
}

describe('relay device stream runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes capped exponential reconnect delay', () => {
    expect(computeRelayDeviceStreamReconnectDelay(0)).toBe(300);
    expect(computeRelayDeviceStreamReconnectDelay(1)).toBe(600);
    expect(computeRelayDeviceStreamReconnectDelay(2)).toBe(1200);
    expect(computeRelayDeviceStreamReconnectDelay(10)).toBe(5000);
  });

  it('sends typed control heartbeat every thirty seconds and keeps the stream on control pong', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let pongHandler: ((payload: { sentAt?: number; receivedAt?: number }) => void) | undefined;
    let socket: FakeSocket | null = null;
    const runtimeDebug = vi.fn();
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'token-1', deviceId: 'android-1' }),
      refreshAccount: async (account) => ({
        account,
        relaySettings: {
          relayBaseUrl: 'https://relay.example.com/relay/',
          accessToken: 'token-1',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.com/relay/ws/host',
          wsClientUrl: 'wss://relay.example.com/relay/ws/client',
          turnUrl: '',
          turnUsername: '',
          turnCredential: '',
          updatedAt: 1,
        },
      }),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        socket = new FakeSocket();
        pongHandler = options.onControlPong;
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        queueMicrotask(() => options.onOpen?.());
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(socket).not.toBeNull());
    await vi.waitFor(() => expect(pongHandler).toBeDefined());
    await vi.advanceTimersByTimeAsync(RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS);

    expect(socket!.sent).toHaveLength(1);
    const pingPayload = JSON.parse(socket!.sent[0]);
    expect(pingPayload).toEqual({
      type: 'control-ping',
      payload: { sentAt: expect.any(Number) },
    });
    expect(pingPayload.payload.sentAt).toBeGreaterThanOrEqual(RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS);
    expect(pingPayload.payload.sentAt).toBeLessThan(RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS + 1000);

    vi.setSystemTime(31_000);
    pongHandler?.({ sentAt: 30_000, receivedAt: 30_500 });
    await vi.advanceTimersByTimeAsync(RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS * 2);

    expect(socket!.close).not.toHaveBeenCalled();
    expect(runtimeDebug).not.toHaveBeenCalledWith('relay.device-stream.heartbeat.timeout', expect.anything());
    runtime.stop();
  });

  it('closes only the device control stream after consecutive heartbeat misses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sockets: FakeSocket[] = [];
    const runtimeDebug = vi.fn();
    const refreshAccount = vi.fn(async (account) => ({
      account,
      relaySettings: {
        relayBaseUrl: 'https://relay.example.com/relay/',
        accessToken: 'token-1',
        userId: 'u1',
        username: 'jason',
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
        wsHostUrl: 'wss://relay.example.com/relay/ws/host',
        wsClientUrl: 'wss://relay.example.com/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    }));
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'token-1', deviceId: 'android-1' }),
      refreshAccount,
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        const nextSocket = new FakeSocket();
        sockets.push(nextSocket);
        nextSocket.onclose = (event) => options.onClose?.(event as CloseEvent);
        queueMicrotask(() => options.onOpen?.());
        return nextSocket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(
      RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS * RELAY_DEVICE_STREAM_HEARTBEAT_MAX_MISSES,
    );

    expect(sockets[0].close).toHaveBeenCalledWith(4000, 'relay device stream heartbeat timeout');
    expect(runtimeDebug).toHaveBeenCalledWith(
      'relay.device-stream.heartbeat.timeout',
      expect.objectContaining({ misses: RELAY_DEVICE_STREAM_HEARTBEAT_MAX_MISSES }),
    );

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(refreshAccount).toHaveBeenCalledTimes(2);
    runtime.stop();
  });

  it('closes the device control stream when heartbeat send fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let socket: FakeSocket | null = null;
    const runtimeDebug = vi.fn();
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'token-1', deviceId: 'android-1' }),
      refreshAccount: async (account) => ({
        account,
        relaySettings: {
          relayBaseUrl: 'https://relay.example.com/relay/',
          accessToken: 'token-1',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.com/relay/ws/host',
          wsClientUrl: 'wss://relay.example.com/relay/ws/client',
          turnUrl: '',
          turnUsername: '',
          turnCredential: '',
          updatedAt: 1,
        },
      }),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        socket = new FakeSocket();
        socket.send.mockImplementation((_payload: string): void => {
          throw new Error('send failed');
        });
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        queueMicrotask(() => options.onOpen?.());
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(socket).not.toBeNull());
    await vi.advanceTimersByTimeAsync(RELAY_DEVICE_STREAM_HEARTBEAT_INTERVAL_MS);

    expect(socket!.close).toHaveBeenCalledWith(4000, 'relay device stream heartbeat timeout');
    expect(runtimeDebug).toHaveBeenCalledWith(
      'relay.device-stream.heartbeat.send-failed',
      { message: 'send failed' },
    );
    runtime.stop();
  });

  it('preserves directory endpoints and sessions when presence snapshot omits them', () => {
    const directory = [makeDevice({
      daemon: {
        connected: true,
        lastSeenAt: new Date().toISOString(),
        hostId: 'mac-studio',
        version: '0.1.3',
        endpoints: [{
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: new Date().toISOString(),
        }],
        sessions: [{ name: 'zterm', updatedAt: new Date().toISOString() }],
      },
    })];
    const presence = [makeDevice({
      updatedAt: new Date().toISOString(),
      daemon: {
        connected: true,
        lastSeenAt: new Date().toISOString(),
        hostId: 'mac-studio',
        version: '0.1.3',
      },
    })];

    const merged = mergeRelayPresenceWithDirectoryTruth(presence, directory);
    expect(merged).toHaveLength(1);
    expect(merged[0].daemon.endpoints).toEqual([
      expect.objectContaining({ id: 'relay-rtc:mac-studio' }),
    ]);
    expect(merged[0].daemon.sessions).toEqual([
      expect.objectContaining({ name: 'zterm' }),
    ]);
  });

  it('refreshes account before opening and reconnects after close', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const setDevices = vi.fn();
    const applyRelaySettings = vi.fn();
    const publishDirectoryTruth = vi.fn();
    const runtimeDebug = vi.fn();
    const refreshAccount = vi.fn(async (account) => ({
      account,
      relaySettings: {
        relayBaseUrl: 'https://relay.example.com/relay/',
        accessToken: 'token-1',
        userId: 'u1',
        username: 'jason',
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
        wsHostUrl: 'wss://relay.example.com/relay/ws/host',
        wsClientUrl: 'wss://relay.example.com/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    }));

    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({
        accessToken: 'token-1',
        relayBaseUrl: 'https://relay.example.com/relay/',
        deviceId: 'android-1',
        relaySettings: {
          accessToken: 'token-1',
          relayBaseUrl: 'https://relay.example.com/relay/',
        },
      }),
      refreshAccount,
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        queueMicrotask(() => options.onOpen?.());
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices,
      applyRelaySettings,
      publishDirectoryTruth,
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(applyRelaySettings).toHaveBeenCalled();
    expect(publishDirectoryTruth).toHaveBeenCalledWith(
      [],
      'confirmed',
      expect.objectContaining({ accessToken: 'token-1', deviceId: 'android-1' }),
    );

    sockets[0].close(1006, 'server closed');
    await vi.waitFor(() => expect(runtimeDebug).toHaveBeenCalledWith(
      'relay.device-stream.reconnect.scheduled',
      expect.objectContaining({ reason: 'server closed' }),
    ));

    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    runtime.stop();
  });

  it('refreshes foreground control truth without rebuilding an open device stream', async () => {
    const sockets: FakeSocket[] = [];
    const publishDirectoryTruth = vi.fn();
    const refreshAccount = vi.fn(async (account) => ({
      account,
      relaySettings: {
        relayBaseUrl: 'https://relay.example.com/relay/',
        accessToken: 'token-1',
        userId: 'u1',
        username: 'jason',
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
        wsHostUrl: 'wss://relay.example.com/relay/ws/host',
        wsClientUrl: 'wss://relay.example.com/relay/ws/client',
        turnUrl: '',
        turnUsername: '',
        turnCredential: '',
        updatedAt: 1,
      },
    }));
    const device = makeDevice({
      daemon: {
        connected: true,
        lastSeenAt: '2026-08-03T00:00:00.000Z',
        hostId: 'mac-studio',
        version: '0.1.3',
        endpoints: [{
          id: 'tailscale:mac-studio',
          kind: 'tailscale',
          host: '100.66.1.83',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-08-03T00:00:00.000Z',
        }],
      },
    });
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'token-1', deviceId: 'android-1' }),
      refreshAccount,
      projectDevicesFromAccount: () => [device],
      connectDevicesStream: (options) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        queueMicrotask(() => options.onOpen?.());
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      publishDirectoryTruth,
    });

    runtime.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1));
    publishDirectoryTruth.mockClear();
    refreshAccount.mockClear();

    const refreshed = runtime.refreshNow('foreground-resume');
    expect(publishDirectoryTruth).toHaveBeenCalledWith(
      [device],
      'disconnected',
      expect.objectContaining({ accessToken: 'token-1' }),
    );
    await expect(refreshed).resolves.toBe(true);
    expect(refreshAccount).toHaveBeenCalledTimes(1);
    expect(publishDirectoryTruth).toHaveBeenLastCalledWith(
      [device],
      'confirmed',
      expect.objectContaining({ accessToken: 'token-1' }),
    );
    expect(sockets).toHaveLength(1);

    runtime.stop();
  });

  it('does not reuse a stale generation refresh after runtime restart', async () => {
    const sockets: FakeSocket[] = [];
    const resolvers: Array<(value: { account: unknown; relaySettings: TraversalRelayClientSettings }) => void> = [];
    const relaySettings = {
      relayBaseUrl: 'https://relay.example.com/relay/',
      accessToken: 'token-1',
      userId: 'u1',
      username: 'jason',
      deviceId: 'android-1',
      deviceName: 'ZTerm Android',
      platform: 'android',
      wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
      wsHostUrl: 'wss://relay.example.com/relay/ws/host',
      wsClientUrl: 'wss://relay.example.com/relay/ws/client',
      turnUrl: '',
      turnUsername: '',
      turnCredential: '',
      updatedAt: 1,
    };
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'token-1', deviceId: 'android-1' }),
      refreshAccount: vi.fn((account) => new Promise((resolve) => {
        resolvers.push((value) => resolve({ ...value, account }));
      })),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        queueMicrotask(() => options.onOpen?.());
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
    });

    runtime.start();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    runtime.start();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[0]({ account: {}, relaySettings });
    await Promise.resolve();
    expect(sockets).toHaveLength(0);

    resolvers[1]({ account: {}, relaySettings });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    runtime.stop();
  });

  it('does not reconnect after stop', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({
        accessToken: 'token-1',
        relayBaseUrl: 'https://relay.example.com/relay/',
        deviceId: 'android-1',
      }),
      refreshAccount: async (account) => ({
        account,
        relaySettings: {
          relayBaseUrl: 'https://relay.example.com/relay/',
          accessToken: 'token-1',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.com/relay/ws/host',
          wsClientUrl: 'wss://relay.example.com/relay/ws/client',
          turnUrl: '',
          turnUsername: '',
          turnCredential: '',
          updatedAt: 1,
        },
      }),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
    });

    runtime.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    runtime.stop();
    sockets[0].close(1006, 'unmount');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(1);
  });

  it('invalidates an authoritative rejected account without reconnecting', async () => {
    vi.useFakeTimers();
    const invalidateAuthentication = vi.fn();
    const setDevices = vi.fn();
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'expired-token' }),
      refreshAccount: async () => {
        const error = new Error('unauthorized');
        Object.assign(error, { name: 'TraversalRelayAuthenticationError' });
        throw error;
      },
      projectDevicesFromAccount: () => [],
      connectDevicesStream: () => new FakeSocket() as unknown as WebSocket,
      projectDirectoryDevices: () => [],
      setDevices,
      invalidateAuthentication,
    });

    runtime.start();
    await vi.waitFor(() => expect(invalidateAuthentication).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(setDevices).toHaveBeenCalledWith([]);
    expect(invalidateAuthentication).toHaveBeenCalledWith('unauthorized');
    runtime.stop();
  });

  it('invalidates a device stream closed with code 4001 without scheduling reconnect', async () => {
    vi.useFakeTimers();
    const invalidateAuthentication = vi.fn();
    const runtimeDebug = vi.fn();
    let socket: FakeSocket | null = null;
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'expired-token' }),
      refreshAccount: async (account) => ({
        account,
        relaySettings: {
          relayBaseUrl: 'https://relay.example.com/relay/', accessToken: 'expired-token', userId: 'u1', username: 'jason',
          deviceId: 'android-1', deviceName: 'Android', platform: 'android', wsDevicesUrl: 'wss://relay.example.com/devices',
          wsHostUrl: 'wss://relay.example.com/host', wsClientUrl: 'wss://relay.example.com/client', turnUrl: '', turnUsername: '', turnCredential: '', updatedAt: 1,
        },
      }),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        socket = new FakeSocket();
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      invalidateAuthentication,
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(socket).not.toBeNull());
    socket!.close(4001, 'unauthorized');
    await vi.waitFor(() => expect(invalidateAuthentication).toHaveBeenCalledWith('unauthorized'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runtimeDebug).not.toHaveBeenCalledWith('relay.device-stream.reconnect.scheduled', expect.anything());
    runtime.stop();
  });

  it('does not let a socket closed by a newer start schedule a stale reconnect', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const runtimeDebug = vi.fn();
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({
        accessToken: 'token-1',
        relayBaseUrl: 'https://relay.example.com/relay/',
        deviceId: 'android-1',
      }),
      refreshAccount: async (account) => ({
        account,
        relaySettings: {
          relayBaseUrl: 'https://relay.example.com/relay/',
          accessToken: 'token-1',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.com/relay/ws/host',
          wsClientUrl: 'wss://relay.example.com/relay/ws/client',
          turnUrl: '',
          turnUsername: '',
          turnCredential: '',
          updatedAt: 1,
        },
      }),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        socket.onclose = (event) => options.onClose?.(event as CloseEvent);
        return socket as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    runtime.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(5000);
    expect(sockets).toHaveLength(2);
    expect(runtimeDebug).toHaveBeenCalledWith(
      'relay.device-stream.close.stale',
      expect.objectContaining({ reason: 'relay device stream restart' }),
    );

    runtime.stop();
  });

  it('publishes an empty directory snapshot as confirmed control truth', async () => {
    const publishDirectoryTruth = vi.fn();
    let directoryHandler: ((directory: unknown) => void) | undefined;
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({
        accessToken: 'token-1',
        relayBaseUrl: 'https://relay.example.com/relay/',
        deviceId: 'android-1',
      }),
      refreshAccount: async (account) => ({
        account,
        relaySettings: {
          relayBaseUrl: 'https://relay.example.com/relay/',
          accessToken: 'token-1',
          userId: 'u1',
          username: 'jason',
          deviceId: 'android-1',
          deviceName: 'ZTerm Android',
          platform: 'android',
          wsDevicesUrl: 'wss://relay.example.com/relay/ws/devices',
          wsHostUrl: 'wss://relay.example.com/relay/ws/host',
          wsClientUrl: 'wss://relay.example.com/relay/ws/client',
          turnUrl: '',
          turnUsername: '',
          turnCredential: '',
          updatedAt: 1,
        },
      }),
      projectDevicesFromAccount: () => [],
      connectDevicesStream: (options) => {
        directoryHandler = options.onDirectory;
        return new FakeSocket() as unknown as WebSocket;
      },
      projectDirectoryDevices: () => [],
      setDevices: vi.fn(),
      publishDirectoryTruth,
    });

    runtime.start();
    await vi.waitFor(() => expect(directoryHandler).toBeDefined());
    directoryHandler?.({ schemaVersion: 1, devices: [] });

    expect(publishDirectoryTruth).toHaveBeenLastCalledWith(
      [],
      'confirmed',
      expect.objectContaining({ accessToken: 'token-1', deviceId: 'android-1' }),
    );
    runtime.stop();
  });

  it('keeps cached UI projection unconfirmed when account refresh fails', async () => {
    vi.useFakeTimers();
    const directoryDevice = makeDevice({
      daemon: {
        connected: true,
        lastSeenAt: '2026-07-27T00:00:00.000Z',
        hostId: 'mac-studio',
        version: '0.1.3',
        endpoints: [{
          id: 'lan:192.168.1.20:3333',
          kind: 'lan',
          host: '192.168.1.20',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-07-27T00:00:00.000Z',
        }],
        sessions: [],
      },
    });
    const setDevices = vi.fn();
    const publishDirectoryTruth = vi.fn();
    const runtime = createRelayDeviceStreamRuntime({
      readEnabledAccount: () => ({ accessToken: 'token-1' }),
      refreshAccount: async () => {
        throw new Error('relay temporarily unavailable');
      },
      projectDevicesFromAccount: () => [directoryDevice],
      connectDevicesStream: () => new FakeSocket() as unknown as WebSocket,
      projectDirectoryDevices: () => [],
      setDevices,
      publishDirectoryTruth,
    });

    runtime.start();
    await vi.waitFor(() => expect(setDevices).toHaveBeenCalled());
    await vi.waitFor(() => expect(publishDirectoryTruth).toHaveBeenCalledWith([directoryDevice], 'cached', undefined));

    expect(runtime.getDirectoryTruthDevices()).toEqual([directoryDevice]);
    expect(setDevices).not.toHaveBeenCalledWith([]);
    runtime.stop();
  });
});
