import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function listenerMock() {
  const listeners = new Map<string, (event: unknown) => void>();
  const add = vi.fn((eventName: string, callback: (event: unknown) => void) => {
    listeners.set(eventName, callback);
    return Promise.resolve({ remove: vi.fn(async () => undefined) });
  });
  return { listeners, add };
}

const target = {
  targetKey: 'daemon:mac-studio',
  bridgeHost: '100.66.1.82',
  bridgePort: 3333,
  authToken: 'token',
};

describe('AndroidConnectionServiceTransportSocket', () => {
  beforeEach(() => {
    plugin.readSnapshot.mockReset();
    plugin.addListener.mockReset();
    plugin.sendCommand.mockReset();
    plugin.readSnapshot.mockResolvedValue({
      state: 'connecting',
      generation: 'g1',
      target,
      route: { mode: 'auto' },
      channels: [],
      lastHeartbeatAt: null,
      lastActivityAt: 1,
      nextRetryAt: null,
      error: null,
    });
  });

  it('projects mux-ready from native service events', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target, 'shell');
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
    });

    expect(opened).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('reads the initial snapshot for its own target', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target, 'shell');

    await socket.start();

    expect(plugin.readSnapshot).toHaveBeenCalledWith('daemon:mac-studio');
  });

  it('maps channel frames to typed service commands without owning transport', () => {
    const socket = new AndroidConnectionServiceTransportSocket(target, 'shell');
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

  it('ignores events projected for a different target', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target, 'shell');
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
    const socket = new AndroidConnectionServiceTransportSocket(target, 'shell');
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
});
