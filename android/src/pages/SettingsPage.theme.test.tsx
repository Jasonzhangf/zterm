// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import type { BridgeSettings } from '../lib/bridge-settings';

const baseSettings: BridgeSettings = {
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
  terminalCacheLines: 3000,
  terminalThemeId: 'classic-dark',
  servers: [],
  defaultServerId: undefined,
};

describe('SettingsPage terminal theme selection', () => {
  afterEach(() => {
    cleanup();
  });

  it('persists terminal theme immediately when a theme card is selected', () => {
    const onTerminalThemeChange = vi.fn();

    render(
      <SettingsPage
        settings={baseSettings}
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
        onSave={vi.fn()}
        onUpdatePreferencesChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onTerminalThemeChange={onTerminalThemeChange}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Gruvbox Dark'));
    expect(onTerminalThemeChange).toHaveBeenCalledWith('gruvbox-dark');
  });
});
