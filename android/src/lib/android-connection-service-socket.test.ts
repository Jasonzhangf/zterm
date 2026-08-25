import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTerminalMuxReady } from '@zterm/shared/protocol';

const plugin = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  addListener: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('../plugins/AndroidConnectionServicePlugin', () => ({
  readAndroidConnectionServiceSnapshot: (targetKey: string) => plugin.readSnapshot(targetKey),
  addAndroidConnectionServiceListener: (eventName: string, callback: (event: unknown) => void) => (
    plugin.addListener(eventName, callback)
  ),
  sendAndroidConnectionCommand: (command: unknown) => plugin.sendCommand(command),
}));

import {
  AndroidConnectionServiceTransportSocket,
} from './android-connection-service-socket';
import {
  openAndroidConnectionServiceTransportSocket,
} from './android-connection-service-factory';

function listenerMock() {
  const listeners = new Map<string, (event: unknown) => void>();
  const removes = new Map<string, ReturnType<typeof vi.fn>>();
  const add = vi.fn((eventName: string, callback: (event: unknown) => void) => {
    listeners.set(eventName, callback);
    const remove = vi.fn(async () => undefined);
    removes.set(eventName, remove as ReturnType<typeof vi.fn>);
    return Promise.resolve({ remove });
  });
  return { listeners, removes, add };
}

const target = {
  targetKey: 'daemon:mac-studio',
  bridgeHost: '100.66.1.82',
  bridgePort: 3333,
  authToken: 'token',
};

const muxReadyPayload = buildTerminalMuxReady({ daemonHostId: 'daemon-host' }).payload;

describe('AndroidConnectionServiceTransportSocket', () => {
  beforeEach(() => {
    plugin.readSnapshot.mockReset();
    plugin.addListener.mockReset();
    plugin.sendCommand.mockReset();
    plugin.readSnapshot.mockResolvedValue({
      state: 'connecting',
      generation: null,
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 1,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: null,
    });
  });

  it('projects mux-ready from native service events', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    socket.onopen = opened;

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'mux-ready',
      generation: 'g1',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 2,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    await Promise.resolve();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('projects a mux-ready frame while the initial service snapshot is still connecting', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    const closed = vi.fn();
    const messages: string[] = [];
    socket.onopen = opened;
    socket.onclose = closed;
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-ready',
      generation: 'g-frame-first',
      receivedAt: 2,
      payload: buildTerminalMuxReady().payload,
    });
    await Promise.resolve();

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => JSON.parse(message).type)).toEqual(['mux-ready']);
  });

  it('reads the initial snapshot for its own target', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);

    await socket.start();

    expect(plugin.readSnapshot).toHaveBeenCalledWith('daemon:mac-studio');
  });

  it('replays the exact native mux-ready payload after JS listeners attach late', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const muxReadyPayload = {
      ...buildTerminalMuxReady({ daemonHostId: 'daemon-host-exact' }).payload,
      serviceCapability: 'exact-native-value',
    };
    plugin.readSnapshot.mockResolvedValue({
      state: 'healthy',
      generation: 'g-late',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 3,
      lastActivityAt: 3,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    const messages: string[] = [];

    await socket.start();
    socket.onmessage = (event) => messages.push(String(event.data));
    socket.onopen = opened;
    await Promise.resolve();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => JSON.parse(message))).toEqual([{
      type: 'mux-ready',
      payload: muxReadyPayload,
    }]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('replays already-open native channels after a WebView adapter is recreated', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const snapshot = {
      state: 'channels-ready' as const,
      generation: 'g-restored-channel',
      target,
      route: { mode: 'auto' as const },
      channels: [{ channelId: 'channel-restored', state: 'open' as const, sessionName: 'shell' }],
      lastHeartbeatAt: 3,
      lastActivityAt: 3,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    };
    plugin.readSnapshot.mockResolvedValue(snapshot);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];

    await socket.start();
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));
    await Promise.resolve();

    expect(messages.map((message) => JSON.parse(message))).toEqual([
      { type: 'mux-ready', payload: muxReadyPayload },
      {
        type: 'mux-channel-opened',
        payload: {
          channelId: 'channel-restored',
          sessionName: 'shell',
          snapshot,
        },
      },
    ]);
  });

  it('does not duplicate a channel opened event already recovered from the same snapshot', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const snapshot = {
      state: 'channels-ready' as const,
      generation: 'g-channel-dedupe',
      target,
      route: { mode: 'auto' as const },
      channels: [{ channelId: 'channel-dedupe', state: 'open' as const, sessionName: 'shell' }],
      lastHeartbeatAt: 3,
      lastActivityAt: 3,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    };
    plugin.readSnapshot.mockResolvedValue(snapshot);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];

    await socket.start();
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));
    await Promise.resolve();
    listeners.get('androidConnectionChannelOpened')?.({
      kind: 'channel-opened',
      targetKey: target.targetKey,
      generation: snapshot.generation,
      channelId: 'channel-dedupe',
      sessionName: 'shell',
      snapshot,
    });

    expect(messages.map((message) => JSON.parse(message).type)).toEqual([
      'mux-ready',
      'mux-channel-opened',
    ]);
  });

  it('does not expose a native service socket as a JS heartbeat owner', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    socket.onopen = opened;

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'healthy',
      generation: 'g-service',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 4,
      lastActivityAt: 4,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    await Promise.resolve();

    expect(socket.transportOwnership).toBe('service');
    expect(plugin.sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'channel-message',
      message: expect.objectContaining({ type: 'mux-ping' }),
    }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('does not replay a duplicate native mux-ready generation', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'healthy',
      generation: 'g-duplicate',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 5,
      lastActivityAt: 5,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    socket.onopen = vi.fn();
    await Promise.resolve();
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-ready',
      generation: 'g-duplicate',
      receivedAt: 6,
      payload: {
        version: 1,
        capabilities: {
          version: 1,
          channelEnvelope: true,
          targetMessages: true,
          boundedBodyScheduler: true,
        },
      },
    });

    expect(messages).toHaveLength(1);
  });

  it('does not synthesize mux-ready when the native snapshot lacks exact protocol truth', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    plugin.readSnapshot.mockResolvedValue({
      state: 'healthy',
      generation: 'g-shared',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 6,
      lastActivityAt: 6,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: null,
    });
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onmessage = (event) => messages.push(String(event.data));
    socket.onopen = vi.fn();

    await socket.start();

    expect(messages).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
  });

  it('replays mux-ready when the native frame is observed before JS listeners attach', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    plugin.readSnapshot.mockResolvedValue({
      state: 'connecting',
      generation: 'g-frame-late',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 7,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: null,
    });
    const socket = new AndroidConnectionServiceTransportSocket(target);
    await socket.start();
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-ready',
      generation: 'g-frame-late',
      receivedAt: 8,
      payload: {
        version: 1,
        capabilities: {
          version: 1,
          channelEnvelope: true,
          targetMessages: true,
          boundedBodyScheduler: true,
        },
      },
    });
    const opened = vi.fn();
    const messages: string[] = [];
    socket.onmessage = (event) => messages.push(String(event.data));
    socket.onopen = opened;
    await Promise.resolve();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([JSON.stringify({
      type: 'mux-ready',
      payload: {
        version: 1,
        capabilities: {
          version: 1,
          channelEnvelope: true,
          targetMessages: true,
          boundedBodyScheduler: true,
        },
      },
    })]);
  });

  it('replays mux-ready when onopen binds before onmessage in the runtime listener order', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    plugin.readSnapshot.mockResolvedValue({
      state: 'healthy',
      generation: 'g-binding-order',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 9,
      lastActivityAt: 9,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    const messages: string[] = [];

    await socket.start();
    socket.onopen = opened;
    socket.onmessage = (event) => messages.push(String(event.data));
    await Promise.resolve();

    expect(opened).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([JSON.stringify({ type: 'mux-ready', payload: muxReadyPayload })]);
  });

  it('projects open once per healthy native generation', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    const closed = vi.fn();
    const messages: string[] = [];
    socket.onopen = opened;
    socket.onclose = closed;
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    const emitHealthy = (generation: string) => listeners.get('androidConnectionSnapshot')?.({
      state: 'healthy',
      generation,
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 10,
      lastActivityAt: 10,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    emitHealthy('g-once');
    await Promise.resolve();
    emitHealthy('g-once');
    await Promise.resolve();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'connecting',
      generation: 'g-next',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 11,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: null,
    });
    emitHealthy('g-next');
    await Promise.resolve();

    expect(opened).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(2);
  });

  it('rejects stale mux-ready and payload frames after a new generation is ready', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'healthy',
      generation: 'g-current',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 11,
      lastActivityAt: 11,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    await Promise.resolve();
    messages.length = 0;

    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-ready',
      generation: 'g-stale',
      receivedAt: 12,
      payload: buildTerminalMuxReady().payload,
    });
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-target-message',
      generation: 'g-stale',
      receivedAt: 13,
      payload: { message: { type: 'session-list', payload: { sessions: [] } } },
    });
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-pong',
      generation: 'g-current',
      receivedAt: 14,
      payload: { sentAt: 13, receivedAt: 14 },
    });

    expect(messages.map((message) => JSON.parse(message).type)).toEqual(['mux-pong']);
  });

  it('rejects stale channel events after a new generation is ready', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    const snapshot = (state: 'connecting' | 'healthy', generation: string) => ({
      state,
      generation,
      target,
      route: { mode: 'auto' as const },
      channels: [],
      lastHeartbeatAt: state === 'healthy' ? 15 : null,
      lastActivityAt: 15,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: state === 'healthy' ? muxReadyPayload : null,
    });
    listeners.get('androidConnectionSnapshot')?.(snapshot('healthy', 'g-old'));
    await Promise.resolve();
    listeners.get('androidConnectionSnapshot')?.(snapshot('connecting', 'g-current'));
    listeners.get('androidConnectionSnapshot')?.(snapshot('healthy', 'g-current'));
    await Promise.resolve();
    messages.length = 0;

    listeners.get('androidConnectionChannelOpened')?.({
      kind: 'channel-opened',
      targetKey: target.targetKey,
      generation: 'g-old',
      channelId: 'channel-1',
      sessionName: 'shell',
      snapshot: snapshot('healthy', 'g-old'),
    });
    listeners.get('androidConnectionChannelMessage')?.({
      targetKey: target.targetKey,
      generation: 'g-old',
      channelId: 'channel-1',
      message: { type: 'buffer-head', payload: { revision: 1 } },
    });
    listeners.get('androidConnectionChannelClosed')?.({
      kind: 'channel-closed',
      targetKey: target.targetKey,
      generation: 'g-old',
      channelId: 'channel-1',
    });

    expect(messages).toEqual([]);
  });

  it('accepts the next mux generation after native backoff reconnect', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    const closed = vi.fn();
    const messages: string[] = [];
    socket.onopen = opened;
    socket.onclose = closed;
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'healthy',
      generation: 'g-one',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: 15,
      lastActivityAt: 15,
      nextRetryAt: null,
      error: null,
      muxReadyPayload,
    });
    await Promise.resolve();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'backoff-reconnect',
      generation: null,
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 16,
      nextRetryAt: 17,
      error: null,
      muxReadyPayload: null,
    });
    listeners.get('androidConnectionSnapshot')?.({
      state: 'connecting',
      generation: 'g-two',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 18,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: null,
    });
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: target.targetKey,
      type: 'mux-ready',
      generation: 'g-two',
      receivedAt: 19,
      payload: buildTerminalMuxReady().payload,
    });
    await Promise.resolve();

    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith({ code: 1000, reason: 'service-reconnect' });
    expect(messages.map((message) => JSON.parse(message).type)).toEqual(['mux-ready', 'mux-ready']);
  });

  it('removes native listeners when projection failure disposes the socket', async () => {
    const { removes, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);

    await socket.start();
    socket.reportFailure('terminal failure');
    await Promise.resolve();

    expect([...removes.values()]).toHaveLength(6);
    for (const remove of removes.values()) {
      expect(remove).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the projection attached while the native service retries a physical error', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const closed = vi.fn();
    socket.onclose = closed;

    await socket.start();
    listeners.get('androidConnectionError')?.({
      kind: 'physical-error',
      targetKey: 'daemon:other',
      errorCode: 'websocket-send',
      errorMessage: 'other target failed',
    });
    expect(closed).not.toHaveBeenCalled();

    listeners.get('androidConnectionError')?.({
      kind: 'physical-error',
      targetKey: target.targetKey,
      errorCode: 'websocket-send',
      errorMessage: 'target failed',
    });
    expect(closed).not.toHaveBeenCalled();
  });

  it('keeps target release explicit instead of releasing the service on UI close', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);

    await socket.start();
    socket.close(1000, 'ui-detach');

    expect(plugin.sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'release-target',
      targetKey: target.targetKey,
    }));
  });

  it('maps channel frames to typed service commands without owning transport', () => {
    const socket = new AndroidConnectionServiceTransportSocket(target);
    socket.send(JSON.stringify({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-1',
        message: { type: 'buffer-sync-request', payload: { startIndex: 0, endIndex: 10 } },
      },
    }));
    expect(plugin.sendCommand).toHaveBeenCalledWith({
      type: 'channel-message',
      targetKey: 'daemon:mac-studio',
      channelId: 'channel-1',
      message: expect.objectContaining({ type: 'buffer-sync-request' }),
    });
    expect(plugin.sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'bind-target',
    }));
  });

  it('maps mux-target-message frames to typed service commands without closing the transport', () => {
    const socket = new AndroidConnectionServiceTransportSocket(target);
    socket.send(JSON.stringify({
      type: 'mux-target-message',
      payload: {
        requestId: 'request-1',
        message: { type: 'list-sessions' },
      },
    }));

    expect(plugin.sendCommand).toHaveBeenCalledWith({
      type: 'target-message',
      targetKey: 'daemon:mac-studio',
      requestId: 'request-1',
      message: { type: 'list-sessions' },
    });
    expect(socket.readyState).not.toBe(WebSocket.CLOSED);
  });

  it('ignores events projected for a different target', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const opened = vi.fn();
    socket.onopen = opened;

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'mux-ready',
      generation: 'other-generation',
      target: {
        ...target,
        targetKey: 'daemon:other',
      },
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 2,
      nextRetryAt: null,
      error: null,
    });
    listeners.get('androidConnectionServerFrame')?.({
      targetKey: 'daemon:other',
      type: 'mux-ready',
      generation: 'other-generation',
      receivedAt: 2,
      payload: {},
    });

    expect(opened).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(WebSocket.CONNECTING);
  });

  it('routes auth terminal errors as close events instead of scheduling reconnect', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const closed = vi.fn();
    socket.onclose = closed;

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.({
      state: 'authentication-error',
      generation: null,
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 3,
      nextRetryAt: null,
      error: { code: 'authentication', message: '401 unauthorized' },
    });

    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ code: 4001 }));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('projects bind-target rejection into the service socket error chain', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    plugin.readSnapshot.mockResolvedValue({
      state: 'connecting',
      generation: null,
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 1,
      nextRetryAt: null,
      error: null,
      muxReadyPayload: null,
    });
    plugin.sendCommand.mockResolvedValue({ ok: false, error: 'target not authorized' });
    const socket = openAndroidConnectionServiceTransportSocket({
      id: 'host-1',
      createdAt: 1,
      name: 'mac-studio',
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
      daemonHostId: 'mac-studio',
      sessionName: 'shell',
      authType: 'password',
      tags: [],
      pinned: false,
    });
    const closed = vi.fn();
    socket.onclose = closed;
    socket.onerror = vi.fn();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(plugin.sendCommand).toHaveBeenCalledWith({
      type: 'bind-target',
      target: expect.objectContaining({ targetKey: 'daemon=mac-studio' }),
    });
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({
      code: 4000,
      reason: 'bind-target rejected by connection service',
    }));
  });

  it('projects startup failure into the service socket error chain', async () => {
    plugin.addListener.mockRejectedValue(new Error('bridge unavailable'));
    const socket = openAndroidConnectionServiceTransportSocket({
      id: 'host-1',
      createdAt: 1,
      name: 'mac-studio',
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
      daemonHostId: 'mac-studio',
      sessionName: 'shell',
      authType: 'password',
      tags: [],
      pinned: false,
    });
    const closed = vi.fn();
    socket.onclose = closed;
    socket.onerror = vi.fn();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(closed).toHaveBeenCalledWith(expect.objectContaining({
      code: 4000,
      reason: 'connection service startup failed: bridge unavailable',
    }));
  });
});
