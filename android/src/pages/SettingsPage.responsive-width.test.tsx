// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { AppUpdateSection } from '../components/settings/AppUpdateSection';
import {
  settingsCardPadding,
  settingsViewportPadding,
  settingsSectionStyle,
  settingsInputStyle,
} from '../components/settings/SettingsSection';
import type { BridgeSettings } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';

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

function renderSettings() {
  return render(
    <SettingsPage
      settings={baseSettings}
      currentVersionName="0.1.3.2726"
      currentVersionCode={1100027260}
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
      onUpdatePreferencesChange={vi.fn()}
      onCheckForUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
      onResetUpdateIgnorePolicy={vi.fn()}
      onBack={vi.fn()}
      renderSettingsUpdate={(props) => <AppUpdateSection {...props} />}
    />,
  );
}

describe('SettingsPage responsive width', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, String(value));
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 411,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('uses dynamic viewport padding for the settings scroll container', () => {
    renderSettings();

    const scroll = screen.getByTestId('settings-scroll');
    expect(scroll.style.width).toBe('');
    expect(scroll.style.maxWidth).toBe('');

    expect(settingsViewportPadding).toContain('clamp(');
    expect(settingsViewportPadding).toContain('vw');
    expect(settingsCardPadding).toContain('clamp(');
    expect(settingsCardPadding).toContain('vw');
  });

  it('does not pin the update card to a fixed desktop width', () => {
    renderSettings();

    const updateSection = screen.getByTestId('settings-update-section');
    expect(updateSection.style.width).toBe('100%');
    expect(settingsSectionStyle().padding).toBe(settingsCardPadding);
    expect(settingsSectionStyle().minWidth).toBe(0);
    expect(settingsInputStyle().padding).toContain('clamp(');
  });
});
