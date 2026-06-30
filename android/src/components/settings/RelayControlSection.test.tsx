// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayControlSection } from './RelayControlSection';
import type { TraversalRelayClientSettings } from '../../lib/bridge-settings';
import type { TraversalRelayDeviceSnapshot } from '../../lib/types';
import { runTraversalRelayTurnDiagnostic } from '../../lib/traversal-relay-diagnostics';

vi.mock('../../lib/traversal-relay-diagnostics', () => ({
  runTraversalRelayTurnDiagnostic: vi.fn().mockResolvedValue({
    ok: true,
    hostId: 'mac-studio',
    iceTransportPolicy: 'relay',
    selectedPairFound: true,
    candidateTypes: { local: 'relay', remote: 'srflx' },
  }),
}));

const relaySettings: TraversalRelayClientSettings = {
  relayBaseUrl: 'https://claw.codewhisper.cc:18443/relay/',
  accessToken: 'access-token',
  userId: 'user-1',
  username: 'jason',
  deviceId: 'zterm-android',
  deviceName: 'ZTerm Android',
  platform: 'android',
  wsDevicesUrl: 'wss://claw.codewhisper.cc:18443/relay/ws/devices',
  wsHostUrl: 'wss://claw.codewhisper.cc:18443/relay/ws/host',
  wsClientUrl: 'wss://claw.codewhisper.cc:18443/relay/ws/client',
  turnUrl: 'turn:claw.codewhisper.cc:3479?transport=udp',
  turnUsername: 'ztermturn',
  turnCredential: 'turn-pass',
  updatedAt: 1,
};

const device: TraversalRelayDeviceSnapshot = {
  deviceId: 'mac-studio',
  deviceName: 'Mac Studio',
  platform: 'darwin',
  appVersion: '0.1.2',
  updatedAt: '2026-05-29T05:00:00.000Z',
  client: { connected: false, lastSeenAt: '' },
  daemon: { connected: true, lastSeenAt: '2026-05-29T05:00:00.000Z', hostId: 'mac-studio', version: '0.1.2' },
};

describe('RelayControlSection relay diagnostics', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('runs a TURN relay-only diagnostic for an online daemon from the phone UI', async () => {
    render(
      <RelayControlSection
        transportMode="auto"
        onTransportModeChange={vi.fn()}
        traversalPathPriority={['tailscale', 'ipv6', 'ipv4', 'rtc-relay']}
        onTraversalPathPriorityChange={vi.fn()}
        relayBaseUrl="https://claw.codewhisper.cc:18443/relay/"
        onRelayBaseUrlChange={vi.fn()}
        relayUsername="jason"
        onRelayUsernameChange={vi.fn()}
        relayPassword="secret"
        onRelayPasswordChange={vi.fn()}
        relayBusy={null}
        relayStatus="已登录 jason"
        relaySettings={relaySettings}
        relayDevices={[device]}
        onRegister={vi.fn()}
        onLogin={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('https://your-relay.example.com/relay/')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'TURN relay-only 测试 Mac Studio' }));

    await waitFor(() => expect(runTraversalRelayTurnDiagnostic).toHaveBeenCalledWith({
      relaySettings,
      hostId: 'mac-studio',
    }));
    expect(await screen.findByText('TURN relay-only OK · local=relay · remote=srflx')).toBeTruthy();
  });
});
