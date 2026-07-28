import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeRelayDeviceStreamReconnectDelay,
  createRelayDeviceStreamRuntime,
  mergeRelayPresenceWithDirectoryTruth,
} from './relay-device-stream-runtime';
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

  it('preserves directory endpoints and sessions when presence snapshot omits them', () => {
    const directory = [makeDevice({
      daemon: {
        connected: true,
        lastSeenAt: '2026-07-27T00:00:00.000Z',
        hostId: 'mac-studio',
        version: '0.1.3',
        endpoints: [{
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-27T00:00:00.000Z',
        }],
        sessions: [{ name: 'zterm', updatedAt: '2026-07-27T00:00:00.000Z' }],
      },
    })];
    const presence = [makeDevice({
      updatedAt: '2026-07-27T00:00:01.000Z',
      daemon: {
        connected: true,
        lastSeenAt: '2026-07-27T00:00:01.000Z',
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
      runtimeDebug,
    });

    runtime.start();
    await vi.waitFor(() => expect(refreshAccount).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(applyRelaySettings).toHaveBeenCalled();

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

  it('retains last confirmed endpoint truth when account refresh fails', async () => {
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
    await vi.waitFor(() => expect(publishDirectoryTruth).toHaveBeenCalledWith([directoryDevice]));

    expect(runtime.getDirectoryTruthDevices()).toEqual([directoryDevice]);
    expect(setDevices).not.toHaveBeenCalledWith([]);
    runtime.stop();
  });
});
