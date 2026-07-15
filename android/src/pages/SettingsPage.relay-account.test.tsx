// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { SettingsPage } from './SettingsPage';
import type { BridgeSettings, TraversalRelayClientSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';

const syncRelay = vi.fn();
const logoutRelay = vi.fn();

vi.mock('../hooks/useTraversalRelayAccount', () => ({
  useTraversalRelayAccount: vi.fn(() => ({
    account: null,
    relayDevices: [],
    relayStatus: '',
    relayBusy: null,
    refreshLocalAccount: vi.fn(),
    syncRelay,
    logoutRelay,
  })),
}));

const baseSettings: BridgeSettings = {
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  terminalSessionGroupLayoutMode: 'auto',
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
  traversalRelay: undefined,
};

const relaySettings: TraversalRelayClientSettings = {
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

function renderSettings(overrides: Partial<ComponentProps<typeof SettingsPage>> = {}) {
  return render(
    <SettingsPage
      settings={baseSettings}
      currentVersionName="0.1.3"
      currentVersionCode={1030000}
      updatePreferences={{
        manifestUrl: '',
        autoCheckOnLaunch: false,
        skippedVersionCode: undefined,
        ignoreUntilManualCheck: false,
        lastCheckedAt: undefined,
        lastSeenVersionCode: undefined,
      }}
      latestManifest={null}
      updateChecking={false}
      updateInstalling={false}
      updateError={null}
      hasNewVersion={false}
      hasUpdateIgnorePolicy={false}
      onSave={vi.fn()}
      onRelaySettingsChange={vi.fn()}
      onUpdatePreferencesChange={vi.fn()}
      onCheckForUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
      onResetUpdateIgnorePolicy={vi.fn()}
      onTerminalThemeChange={vi.fn()}
      onBack={vi.fn()}
      {...overrides}
    />,
  );
}

describe('SettingsPage Relay account configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('keeps Relay auth in Settings and writes returned settings to the app owner', async () => {
    const onRelaySettingsChange = vi.fn();
    const onSave = vi.fn();
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

    renderSettings({ onRelaySettingsChange, onSave });

    expect(screen.getByTestId('settings-relay-fixed-host').textContent).toBe('relay.codewhisper.cc');
    fireEvent.change(screen.getByLabelText('Relay account'), { target: { value: 'jason' } });
    fireEvent.change(screen.getByLabelText('Relay password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(syncRelay).toHaveBeenCalledWith('login', {
      relayBaseUrl: '',
      username: 'jason',
      password: 'secret',
    }, undefined));
    expect(onRelaySettingsChange).toHaveBeenCalledWith(relaySettings);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      traversalRelay: relaySettings,
    }));
  });

  it('adds a direct server inside Settings so Home can project it as a server row', () => {
    const onSave = vi.fn();
    renderSettings({ onSave });

    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Mac Studio' } });
    fireEvent.change(screen.getByLabelText('Server host'), { target: { value: '100.66.1.82' } });
    fireEvent.change(screen.getByLabelText('Server auth token'), { target: { value: 'wterm-4123456' } });
    fireEvent.change(screen.getByLabelText('Daemon ID'), { target: { value: 'mac-studio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      servers: [
        expect.objectContaining({
          name: 'Mac Studio',
          targetHost: '100.66.1.82',
          targetPort: 3333,
          authToken: 'wterm-4123456',
          relayHostId: 'mac-studio',
        }),
      ],
      targetHost: '100.66.1.82',
      targetPort: 3333,
      targetAuthToken: 'wterm-4123456',
    }));
  });
});
