import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTerminalMuxReady } from '@zterm/shared/protocol';

const plugin = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  addListener: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('../plugins/AndroidConnectionServicePlugin', () => ({
  readAndroidConnectionServiceSnapshot: (targetKey: string) => plugin.readSnapshot(targetKey),
  addAndroidConnectionServiceListener: (
    eventName: string,
    callback: (event: unknown) => void,
  ) => plugin.addListener(eventName, callback),
  sendAndroidConnectionCommand: (command: unknown) => plugin.sendCommand(command),
}));

import { AndroidConnectionServiceTransportSocket } from './android-connection-service-socket';
import { openAndroidConnectionServiceTransportSocket } from './android-connection-service-factory';
import type {
  AndroidConnectionServiceChannelSnapshot,
  AndroidConnectionServiceSnapshot,
} from './android-connection-service-snapshot';

const target = {
  targetKey: 'daemon:mac-studio',
  bridgeHost: '100.66.1.82',
  bridgePort: 3333,
  authToken: 'token',
};

const muxReadyPayload = buildTerminalMuxReady({ daemonHostId: 'daemon-host' }).payload;

function listenerMock() {
  const listeners = new Map<string, (event: unknown) => void>();
  const add = vi.fn((eventName: string, callback: (event: unknown) => void) => {
    listeners.set(eventName, callback);
    return Promise.resolve({ remove: async () => undefined });
  });
  return { listeners, add };
}

function channel(
  channelId: string,
  stableId?: string,
  state: AndroidConnectionServiceChannelSnapshot['state'] = 'open',
): AndroidConnectionServiceChannelSnapshot {
  return {
    channelId,
    state,
    sessionName: 'same-name',
    ...(stableId ? { stableId } : {}),
  };
}

function snapshot(
  channels: AndroidConnectionServiceChannelSnapshot[],
  generation = 'g1',
  projectionTarget = target,
): AndroidConnectionServiceSnapshot {
  return {
    state: 'healthy',
    generation,
    target: projectionTarget,
    route: { mode: 'auto' },
    channels,
    lastHeartbeatAt: 5,
    lastActivityAt: 5,
    nextRetryAt: null,
    error: null,
    muxReadyPayload,
  };
}

function parseMessages(messages: string[]) {
  return messages.map((message) => JSON.parse(message));
}

describe('AndroidConnectionServiceTransportSocket open projection', () => {
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
      muxReadyPayload: null,
    });
  });

  it('projects the current snapshot identity first and ignores a duplicate event', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    plugin.readSnapshot.mockResolvedValue(snapshot([channel('channel-a', 'rex:v1:a')]));
    listeners.get('androidConnectionSnapshot')?.(snapshot([channel('channel-a', 'rex:v1:a')]));
    await Promise.resolve();
    expect(parseMessages(messages)).toEqual([
      { type: 'mux-ready', payload: muxReadyPayload },
      {
        type: 'mux-channel-opened',
        payload: {
          channelId: 'channel-a',
          sessionName: 'same-name',
          stableId: 'rex:v1:a',
          snapshot: snapshot([channel('channel-a', 'rex:v1:a')]),
        },
      },
    ]);

    listeners.get('androidConnectionChannelOpened')?.({
      kind: 'channel-opened',
      targetKey: target.targetKey,
      generation: 'g1',
      channelId: 'channel-a',
      sessionName: 'same-name',
      snapshot: snapshot([channel('channel-a', 'rex:v1:a')]),
    });
    expect(parseMessages(messages)).toHaveLength(2);
  });

  it('projects an event-first admitted channel from its exact snapshot record', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const eventSnapshot = snapshot([
      channel('channel-b', 'rex:v1:b'),
      channel('channel-a', 'rex:v1:a'),
    ]);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.(snapshot([], 'g1'));
    await Promise.resolve();
    messages.length = 0;
    listeners.get('androidConnectionChannelOpened')?.({
      kind: 'channel-opened',
      targetKey: target.targetKey,
      generation: 'g1',
      channelId: 'channel-b',
      sessionName: 'same-name',
      snapshot: eventSnapshot,
    });

    expect(parseMessages(messages)).toEqual([{
      type: 'mux-channel-opened',
      payload: {
        channelId: 'channel-b',
        sessionName: 'same-name',
        stableId: 'rex:v1:b',
        snapshot: eventSnapshot,
      },
    }]);
  });

  it('keeps a legacy snapshot open when the daemon supplies no identity', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const legacySnapshot = snapshot([channel('channel-legacy')]);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];

    await socket.start();
    socket.close(1000, 'webview-detach');
    plugin.readSnapshot.mockResolvedValue(legacySnapshot);
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    expect(await socket.reattach()).toBe(true);
    expect(plugin.readSnapshot).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();

    const opened = parseMessages(messages).find(
      (message) => message.type === 'mux-channel-opened',
    );
    expect(opened).toEqual({
      type: 'mux-channel-opened',
      payload: {
        channelId: 'channel-legacy',
        sessionName: 'same-name',
        snapshot: legacySnapshot,
      },
    });
    expect(Object.hasOwn(opened.payload, 'stableId')).toBe(false);
  });

  it('projects a fresh exact Rex channel through the reattach factory without native writes', async () => {
    const { add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const factoryTarget = { ...target, targetKey: 'daemon=mac-studio' };
    const exactSnapshot = snapshot(
      [channel('rex-channel', 'rex:v1:block-exact')],
      'g-exact',
      factoryTarget,
    );
    plugin.readSnapshot.mockResolvedValue(exactSnapshot);
    const socket = openAndroidConnectionServiceTransportSocket({
      id: 'host-1',
      createdAt: 1,
      name: 'mac-studio',
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
      daemonHostId: 'mac-studio',
      sessionName: 'same-name',
      authType: 'password',
      tags: [],
      pinned: false,
    }, undefined, { mode: 'reattach' });
    const messages: string[] = [];
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(parseMessages(messages).filter(
      (message) => message.type === 'mux-channel-opened',
    )).toEqual([{
      type: 'mux-channel-opened',
      payload: {
        channelId: 'rex-channel',
        sessionName: 'same-name',
        stableId: 'rex:v1:block-exact',
        snapshot: exactSnapshot,
      },
    }]);
    expect(plugin.readSnapshot).toHaveBeenCalledWith('daemon=mac-studio');
    expect(plugin.sendCommand).not.toHaveBeenCalled();
  });

  it('rejects stale and closed projections while retaining the current sibling', async () => {
    const { listeners, add } = listenerMock();
    plugin.addListener.mockImplementation(add);
    const currentSnapshot = snapshot([
      channel('channel-current', 'rex:v1:current'),
      channel('channel-closed', 'rex:v1:closed', 'closed'),
    ]);
    const socket = new AndroidConnectionServiceTransportSocket(target);
    const messages: string[] = [];
    socket.onopen = vi.fn();
    socket.onmessage = (event) => messages.push(String(event.data));

    await socket.start();
    listeners.get('androidConnectionSnapshot')?.(currentSnapshot);
    await Promise.resolve();
    messages.length = 0;
    listeners.get('androidConnectionChannelOpened')?.({
      kind: 'channel-opened',
      targetKey: target.targetKey,
      generation: 'g0',
      channelId: 'channel-old',
      sessionName: 'same-name',
      snapshot: snapshot([channel('channel-old', 'rex:v1:old')], 'g0'),
    });
    listeners.get('androidConnectionChannelOpened')?.({
      kind: 'channel-opened',
      targetKey: target.targetKey,
      generation: 'g1',
      channelId: 'channel-closed',
      sessionName: 'same-name',
      snapshot: currentSnapshot,
    });

    expect(parseMessages(messages)).toEqual([]);
    expect(plugin.sendCommand).not.toHaveBeenCalled();
  });
});
