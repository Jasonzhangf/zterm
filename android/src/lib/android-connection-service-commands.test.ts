import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseAndroidConnectionCommand,
  type AndroidConnectionCommand,
} from './android-connection-service-commands';

describe('Android connection service control contract', () => {
  it('accepts only explicit route policy and target binding commands', () => {
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
      {
        type: 'release-target',
        targetKey: 'daemon:mac-studio',
        reason: 'user-closed',
      },
    ];

    for (const command of commands) {
      expect(parseAndroidConnectionCommand(command)).toEqual(command);
    }
  });

  it('rejects lifecycle and reconnect policy pretending to be service commands', () => {
    expect(() => parseAndroidConnectionCommand({
      type: 'foreground-resume',
      allowReconnectIfUnavailable: true,
    })).toThrow(/unsupported Android connection service command/);
    expect(() => parseAndroidConnectionCommand({
      type: 'notify-target-network-signal',
      fingerprintChanged: true,
    })).toThrow(/unsupported Android connection service command/);
  });

  it('requires target identity for every channel command', () => {
    const commands: AndroidConnectionCommand[] = [
      {
        type: 'open-channel',
        targetKey: 'daemon:mac-studio',
        channelId: 'channel-1',
        sessionName: 'shell',
      },
      {
        type: 'channel-message',
        targetKey: 'daemon:mac-studio',
        channelId: 'channel-1',
        message: { type: 'ping' },
      },
      {
        type: 'channel-binary',
        targetKey: 'daemon:mac-studio',
        channelId: 'channel-1',
        dataBase64: 'AQI=',
      },
      {
        type: 'close-channel',
        targetKey: 'daemon:mac-studio',
        channelId: 'channel-1',
        reason: 'user-close',
      },
    ];

    for (const command of commands) {
      expect(parseAndroidConnectionCommand(command)).toEqual(command);
    }

    expect(() => parseAndroidConnectionCommand({
      type: 'open-channel',
      channelId: 'channel-1',
      sessionName: 'shell',
    })).toThrow(/channel open command/);
    expect(() => parseAndroidConnectionCommand({
      type: 'release-target',
      reason: 'user-closed',
    })).toThrow(/release target/);
  });

  it('keeps service control separate from terminal business payloads', () => {
    const source = readFileSync(new URL('../contexts/session-context-transport-orchestration-runtime.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('AndroidConnectionCommand');
    expect(source).not.toContain('service-snapshot');
  });
});
