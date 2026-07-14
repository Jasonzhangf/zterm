// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraversalRelayDeviceSnapshot } from '../lib/types';
import { ConnectionsPage } from './ConnectionsPage';

const syncRelay = vi.fn();
const logoutRelay = vi.fn();

vi.mock('../hooks/useTraversalRelayAccount', () => ({
  useTraversalRelayAccount: vi.fn(() => ({
    account: null,
    relayStatus: '',
    relayBusy: null,
    syncRelay,
    logoutRelay,
  })),
}));

import { useTraversalRelayAccount } from '../hooks/useTraversalRelayAccount';

const relaySettings = {
  relayBaseUrl: 'https://relay.codewhisper.cc/relay/',
  accessToken: 'token',
  userId: 'u1',
  username: 'jason',
  deviceId: 'android-1',
  deviceName: 'ZTerm Android',
  platform: 'android',
  wsDevicesUrl: 'wss://relay.codewhisper.cc/relay/ws/devices',
  wsHostUrl: 'wss://relay.codewhisper.cc/relay/ws/host',
  wsClientUrl: 'wss://relay.codewhisper.cc/relay/ws/client',
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
  updatedAt: 1,
};

function makeRelayDevice(overrides: Partial<TraversalRelayDeviceSnapshot> = {}): TraversalRelayDeviceSnapshot {
  return {
    deviceId: overrides.deviceId || 'mac-studio-device',
    deviceName: overrides.deviceName || 'Mac Studio',
    platform: overrides.platform || 'mac',
    appVersion: overrides.appVersion || '0.1.3',
    updatedAt: overrides.updatedAt || '2026-07-14T00:00:00.000Z',
    client: overrides.client || { connected: false, lastSeenAt: '' },
    daemon: overrides.daemon || {
      connected: true,
      lastSeenAt: '2026-07-14T00:00:00.000Z',
      hostId: 'mac-studio',
      version: '0.1.3',
    },
  };
}

describe('ConnectionsPage fixed relay login home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: null,
      relayDevices: [],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });
  });

  afterEach(cleanup);

  it('shows only the fixed relay service plus account/password login fields', () => {
    render(<ConnectionsPage onRelaySettingsChange={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByTestId('relay-fixed-host').textContent).toBe('relay.codewhisper.cc');
    expect(screen.getByLabelText('Relay account')).toBeTruthy();
    expect(screen.getByLabelText('Relay password')).toBeTruthy();
    expect(screen.queryByText('All servers')).toBeNull();
    expect(screen.queryByText('Open selected groups')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByDisplayValue(/https?:\/\//)).toBeNull();
  });

  it('submits account/password through the fixed-domain relay owner and applies returned settings', async () => {
    const onRelaySettingsChange = vi.fn();
    syncRelay.mockResolvedValueOnce({
      account: {
        username: 'jason',
        password: '',
        relayBaseUrl: relaySettings.relayBaseUrl,
        accessToken: 'token',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        devices: [],
        directory: null,
        updatedAt: 1,
        relaySettings,
      },
      relaySettings,
    });

    render(<ConnectionsPage onRelaySettingsChange={onRelaySettingsChange} onOpenSettings={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Relay account'), { target: { value: 'jason' } });
    fireEvent.change(screen.getByLabelText('Relay password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(syncRelay).toHaveBeenCalledWith('login', {
      relayBaseUrl: '',
      username: 'jason',
      password: 'secret',
    }, undefined));
    expect(onRelaySettingsChange).toHaveBeenCalledWith(relaySettings);
  });

  it('projects daemon rows without projecting session children or group actions', () => {
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: {
        username: 'jason',
        password: '',
        relayBaseUrl: relaySettings.relayBaseUrl,
        accessToken: 'token',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        devices: [],
        directory: null,
        updatedAt: 1,
        relaySettings,
      },
      relayDevices: [],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });

    render(
      <ConnectionsPage
        relaySettings={relaySettings}
        relayDevices={[makeRelayDevice()]}
        onRelaySettingsChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('Mac Studio')).toBeTruthy();
    expect(screen.getByText('ONLINE')).toBeTruthy();
    expect(screen.getAllByTestId('relay-daemon-row')).toHaveLength(1);
    expect(screen.queryByText('sessions')).toBeNull();
    expect(screen.queryByText('Enter')).toBeNull();
  });

  it('logs out through the account owner and clears App relay settings', () => {
    vi.mocked(useTraversalRelayAccount).mockReturnValue({
      account: {
        username: 'jason',
        password: '',
        relayBaseUrl: relaySettings.relayBaseUrl,
        accessToken: 'token',
        user: { id: 'u1', username: 'jason', createdAt: 'now' },
        deviceId: 'android-1',
        deviceName: 'ZTerm Android',
        platform: 'android',
        devices: [],
        directory: null,
        updatedAt: 1,
        relaySettings,
      },
      relayDevices: [],
      relayStatus: '',
      relayBusy: null,
      refreshLocalAccount: vi.fn(),
      syncRelay,
      logoutRelay,
    });
    const onRelaySettingsChange = vi.fn();

    render(
      <ConnectionsPage
        relaySettings={relaySettings}
        onRelaySettingsChange={onRelaySettingsChange}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(logoutRelay).toHaveBeenCalledTimes(1);
    expect(onRelaySettingsChange).toHaveBeenCalledWith(undefined);
  });
});
