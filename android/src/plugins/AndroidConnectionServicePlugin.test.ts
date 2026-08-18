import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pluginCalls = vi.hoisted(() => ({
  setManualRoutePolicy: vi.fn(),
  bindTarget: vi.fn(),
  releaseTarget: vi.fn(),
  openChannel: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendChannelBinary: vi.fn(),
  closeChannel: vi.fn(),
  readSnapshot: vi.fn(),
  addListener: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  registerPlugin: () => pluginCalls,
}));

import {
  sendAndroidConnectionCommand,
} from './AndroidConnectionServicePlugin';
import type { AndroidConnectionCommand } from '../lib/android-connection-service-commands';

describe('AndroidConnectionServicePlugin', () => {
  beforeEach(() => {
    pluginCalls.setManualRoutePolicy.mockReset();
    pluginCalls.bindTarget.mockReset();
    pluginCalls.releaseTarget.mockReset();
    pluginCalls.openChannel.mockReset();
    pluginCalls.sendChannelMessage.mockReset();
    pluginCalls.sendChannelBinary.mockReset();
    pluginCalls.closeChannel.mockReset();
    pluginCalls.readSnapshot.mockReset();
    pluginCalls.addListener.mockReset();
  });

  it('dispatches only typed user commands to the native service', () => {
    const commands: AndroidConnectionCommand[] = [
      {
        type: 'set-manual-route-policy',
        policy: { mode: 'manual', path: 'tailscale' },
      },
      {
        type: 'bind-target',
        target: {
          targetKey: 'daemon:mac-studio',
          bridgeHost: '100.66.1.82',
          bridgePort: 3333,
          authToken: 'token',
        },
      },
      { type: 'release-target', reason: 'user-close' },
    ];

    for (const command of commands) {
      sendAndroidConnectionCommand(command);
    }

    expect(pluginCalls.setManualRoutePolicy).toHaveBeenCalledWith({
      policy: {
        mode: 'manual',
        path: 'tailscale',
      },
    });
    expect(pluginCalls.bindTarget).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        targetKey: 'daemon:mac-studio',
      }),
    }));
    expect(pluginCalls.releaseTarget).toHaveBeenCalledWith({ reason: 'user-close' });
  });

  it('never schedules JS heartbeat/reconnect timers or calls evaluateJavascript', () => {
    const source = readFileSync(new URL('./AndroidConnectionServicePlugin.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('evaluateJavascript');
    expect(source).not.toContain('allowReconnectIfUnavailable');
  });

  it('keeps channel business messages on typed service commands', () => {
    sendAndroidConnectionCommand({
      type: 'open-channel',
      channelId: 'channel-1',
      sessionName: 'shell',
      options: { cols: 80, rows: 24 },
    });
    sendAndroidConnectionCommand({
      type: 'channel-message',
      channelId: 'channel-1',
      message: { type: 'buffer-sync-request', payload: { startIndex: 0, endIndex: 10 } },
    });
    sendAndroidConnectionCommand({
      type: 'channel-binary',
      channelId: 'channel-1',
      dataBase64: 'AQI=',
    });
    sendAndroidConnectionCommand({
      type: 'close-channel',
      channelId: 'channel-1',
      reason: 'user-close',
    });

    expect(pluginCalls.openChannel).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'channel-1' }));
    expect(pluginCalls.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      message: expect.objectContaining({ type: 'buffer-sync-request' }),
    }));
    expect(pluginCalls.sendChannelBinary).toHaveBeenCalledWith({
      type: 'channel-binary',
      channelId: 'channel-1',
      dataBase64: 'AQI=',
    });
    expect(pluginCalls.closeChannel).toHaveBeenCalledWith({
      type: 'close-channel',
      channelId: 'channel-1',
      reason: 'user-close',
    });
  });
});
