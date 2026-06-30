// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TmuxSessionPickerSheet } from './TmuxSessionPickerSheet';

const refreshRelayDevices = vi.fn();
const relayDevices = [
  {
    deviceId: 'daemon-device-a',
    deviceName: 'MacStudio Relay',
    platform: 'darwin',
    appVersion: '0.1.0',
    updatedAt: '2026-06-28T00:00:00.000Z',
    client: {
      connected: true,
      lastSeenAt: '2026-06-28T00:00:00.000Z',
    },
    daemon: {
      connected: true,
      lastSeenAt: '2026-06-28T00:00:00.000Z',
      hostId: 'daemon-host-a',
      version: '0.1.0',
      endpoints: [
        {
          id: 'direct:tailscale:daemon-host-a',
          kind: 'tailscale',
          host: 'mac.tailnet.ts.net',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
        {
          id: 'relay-rtc:daemon-host-a',
          kind: 'relay-rtc',
          relayHostId: 'daemon-host-a',
          authRequired: true,
          lastSeenAt: '2026-06-28T00:00:00.000Z',
        },
      ],
      sessions: [
        {
          name: 'main',
          cwd: '/Users/jason/project',
          title: 'main',
          updatedAt: '2026-06-28T00:00:00.000Z',
        },
      ],
    },
  },
];

vi.mock('../../hooks/useTraversalRelayDaemonDevices', () => ({
  useTraversalRelayDaemonDevices: () => ({
    refresh: refreshRelayDevices,
    devices: relayDevices,
  }),
}));

const bridgeSettings = {
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto' as const,
  traversalRelay: {
    relayBaseUrl: 'http://relay.test/relay/',
    accessToken: 'access-1',
    userId: 'user-1',
    username: 'jason',
    deviceId: 'android-1',
    deviceName: 'Android',
    platform: 'android',
    wsDevicesUrl: 'ws://relay.test/relay/ws/devices',
    wsHostUrl: 'ws://relay.test/relay/ws/host',
    wsClientUrl: 'ws://relay.test/relay/ws/client',
    turnUrl: 'turn:relay.test:3478',
    turnUsername: 'turn-user',
    turnCredential: 'turn-pass',
    updatedAt: 1,
  },
};

describe('TmuxSessionPickerSheet relay directory projection', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens a directory tmux session without requiring a local bridge preset', () => {
    const onOpenTmuxSession = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="quick-tab"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={onOpenTmuxSession}
        onOpenMultipleTmuxSessions={vi.fn()}
        onSelectCleanSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('MacStudio Relay'));

    expect(screen.getByTestId('tmux-session-name').textContent).toBe('main');
    fireEvent.click(screen.getByText('Open'));

    expect(onOpenTmuxSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: 'mac.tailnet.ts.net',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-a',
        relayHostId: 'daemon-host-a',
        relayDeviceId: 'daemon-device-a',
        relayEndpointCandidates: expect.arrayContaining([
          expect.objectContaining({ id: 'direct:tailscale:daemon-host-a' }),
          expect.objectContaining({ id: 'relay-rtc:daemon-host-a' }),
        ]),
      }),
      'main',
    );
  });

  it('shows an explicit add-server action in new-connection mode', () => {
    const onSelectCleanSession = vi.fn();

    render(
      <TmuxSessionPickerSheet
        mode="new-connection"
        open
        servers={[]}
        bridgeSettings={bridgeSettings}
        onClose={vi.fn()}
        onOpenTmuxSession={vi.fn()}
        onOpenMultipleTmuxSessions={vi.fn()}
        onSelectCleanSession={onSelectCleanSession}
      />,
    );

    fireEvent.click(screen.getByTestId('tmux-session-picker-add-server'));

    expect(onSelectCleanSession).toHaveBeenCalledTimes(1);
    expect(onSelectCleanSession.mock.calls[0][0]).toEqual(expect.objectContaining({
      bridgeHost: '',
      bridgePort: 3333,
    }));
  });
});
