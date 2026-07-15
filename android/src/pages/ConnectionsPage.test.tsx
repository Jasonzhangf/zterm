// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host, TraversalRelayDeviceSnapshot } from '../lib/types';
import { ConnectionsPage, type ConnectionsHomeActiveSession } from './ConnectionsPage';

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
  relayBaseUrl: 'https://relay.codewhisper.cc:18443/relay/',
  accessToken: 'token',
  userId: 'u1',
  username: 'jason',
  deviceId: 'android-1',
  deviceName: 'ZTerm Android',
  platform: 'android',
  wsDevicesUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/devices',
  wsHostUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/host',
  wsClientUrl: 'wss://relay.codewhisper.cc:18443/relay/ws/client',
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

function makeSavedHost(overrides: Partial<Host> = {}): Host {
  return {
    id: overrides.id || 'host-tailscale-a',
    createdAt: overrides.createdAt || 1,
    name: overrides.name || 'Mac Studio Tailscale',
    bridgeHost: overrides.bridgeHost || '100.66.1.82',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId || 'mac-studio',
    sessionName: overrides.sessionName || 'zterm',
    authToken: overrides.authToken || 'token-a',
    authType: overrides.authType || 'password',
    password: overrides.password,
    privateKey: overrides.privateKey,
    autoCommand: overrides.autoCommand || '',
    tags: overrides.tags || ['tailscale'],
    pinned: overrides.pinned ?? false,
    lastConnected: overrides.lastConnected || 2,
    relayEndpointCandidates: overrides.relayEndpointCandidates || [],
  };
}

function makeActiveSession(overrides: Partial<ConnectionsHomeActiveSession> = {}): ConnectionsHomeActiveSession {
  return {
    id: overrides.id || 'session-live-a',
    title: overrides.title || 'zterm',
    connectionName: overrides.connectionName || 'Mac Studio Tailscale',
    bridgeHost: overrides.bridgeHost || '100.66.1.82',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId || 'mac-studio',
    sessionName: overrides.sessionName || 'zterm',
    state: overrides.state || 'connected',
    resolvedEndpoint: overrides.resolvedEndpoint,
    resolvedPath: overrides.resolvedPath,
    customName: overrides.customName,
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

  it('shows saved direct connections, active sessions, add action, and fixed relay login while signed out', () => {
    const onResumeSession = vi.fn();
    const onOpenSavedConnection = vi.fn();
    const onOpenAddConnection = vi.fn();
    const savedHost = makeSavedHost();
    const activeSession = makeActiveSession();

    render(
      <ConnectionsPage
        savedConnections={[savedHost]}
        activeSessions={[activeSession]}
        activeSessionId={activeSession.id}
        onResumeSession={onResumeSession}
        onOpenSavedConnection={onOpenSavedConnection}
        onOpenAddConnection={onOpenAddConnection}
        onRelaySettingsChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId('relay-fixed-host').textContent).toBe('relay.codewhisper.cc');
    expect(screen.getByLabelText('Relay account')).toBeTruthy();
    expect(screen.getByLabelText('Relay password')).toBeTruthy();
    expect(screen.getByText('Mac Studio Tailscale')).toBeTruthy();
    expect(screen.getByText('100.66.1.82:3333')).toBeTruthy();
    expect(screen.getByTestId('saved-connection-row')).toBeTruthy();
    expect(screen.getByTestId('active-session-row')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeTruthy();
    expect(screen.queryByText('All servers')).toBeNull();
    expect(screen.queryByText('Open selected groups')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByDisplayValue(/https?:\/\//)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Resume zterm' }));
    expect(onResumeSession).toHaveBeenCalledWith(activeSession.id);
    fireEvent.click(screen.getByRole('button', { name: 'Open Mac Studio Tailscale' }));
    expect(onOpenSavedConnection).toHaveBeenCalledWith(savedHost);
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(onOpenAddConnection).toHaveBeenCalledTimes(1);
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

  it('projects daemon route rows without replacing saved direct connections or adding group actions', () => {
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

    const savedHost = makeSavedHost();

    render(
      <ConnectionsPage
        relaySettings={relaySettings}
        relayDevices={[makeRelayDevice()]}
        savedConnections={[savedHost]}
        onRelaySettingsChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText('Mac Studio')).toBeTruthy();
    expect(screen.getByText('Mac Studio Tailscale')).toBeTruthy();
    expect(screen.getByText('100.66.1.82:3333')).toBeTruthy();
    expect(screen.getByText('ONLINE')).toBeTruthy();
    expect(screen.getAllByTestId('relay-daemon-row')).toHaveLength(1);
    expect(screen.queryByText('sessions')).toBeNull();
    expect(screen.queryByText('Enter')).toBeNull();
  });

  it('logs out through the account owner and keeps saved direct entries visible', () => {
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
    const savedHost = makeSavedHost();

    render(
      <ConnectionsPage
        relaySettings={relaySettings}
        savedConnections={[savedHost]}
        onRelaySettingsChange={onRelaySettingsChange}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(logoutRelay).toHaveBeenCalledTimes(1);
    expect(onRelaySettingsChange).toHaveBeenCalledWith(undefined);
    expect(screen.getByText('Mac Studio Tailscale')).toBeTruthy();
  });

  it('keeps saved and active entries visible when relay login fails', async () => {
    syncRelay.mockResolvedValueOnce(null);
    const savedHost = makeSavedHost();
    const activeSession = makeActiveSession();

    render(
      <ConnectionsPage
        savedConnections={[savedHost]}
        activeSessions={[activeSession]}
        onRelaySettingsChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Relay account'), { target: { value: 'jason' } });
    fireEvent.change(screen.getByLabelText('Relay password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(syncRelay).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Mac Studio Tailscale')).toBeTruthy();
    expect(screen.getByTestId('active-session-row')).toBeTruthy();
  });
});
