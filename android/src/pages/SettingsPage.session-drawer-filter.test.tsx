// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { SettingsPage } from './SettingsPage';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from '../lib/bridge-settings';
import { STORAGE_KEYS } from '../lib/types';
import { buildConfigExportPayload, applyConfigImportPayload } from '../lib/config-export';
import { SESSION_DRAWER_FILTER_STORAGE_KEY } from '../lib/plugin-session-drawer/session-drawer-visibility';

const baseSettings: BridgeSettings = {
  ...DEFAULT_BRIDGE_SETTINGS,
  targetHost: '',
  targetPort: 3333,
  terminalCacheLines: 1000,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  sessionDrawerFilter: undefined,
};

const updatePreferences = {
  manifestUrl: '',
  autoCheckOnLaunch: false,
  skippedVersionCode: undefined,
  ignoreUntilManualCheck: false,
  lastCheckedAt: undefined,
  lastSeenVersionCode: undefined,
};

function successfulBridgeSettings(settings: BridgeSettings) {
  return {
    ok: true as const,
    settings,
    persistedKeys: [STORAGE_KEYS.BRIDGE_SETTINGS],
  };
}

function renderSettings(
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {},
) {
  return render(
    <SettingsPage
      settings={baseSettings}
      currentVersionName="0.1.3"
      currentVersionCode={1030000}
      updatePreferences={updatePreferences}
      latestManifest={null}
      updateChecking={false}
      updateInstalling={false}
      updateError={null}
      hasNewVersion={false}
      hasUpdateIgnorePolicy={false}
      onSave={vi.fn(successfulBridgeSettings)}
      onUpdatePreferencesChange={vi.fn(() => ({
        ok: true as const,
        preferences: updatePreferences,
        persistedKeys: [],
      }))}
      onCheckForUpdate={vi.fn()}
      onInstallUpdate={vi.fn()}
      onResetUpdateIgnorePolicy={vi.fn()}
      onBack={vi.fn()}
      {...overrides}
    />,
  );
}

describe('SettingsPage session drawer filter', () => {
  afterEach(cleanup);

  it('renders drawer filter guidance without manual name fields', () => {
    renderSettings({
      settings: {
        ...baseSettings,
        sessionDrawerFilter: {
          version: 2,
          mode: 'hide-worker',
          hiddenSessionNames: ['OneStop-1'],
        },
      },
    });

    expect(screen.getByTestId('settings-session-drawer-filter')).toBeTruthy();
    expect(screen.getByText(/Collab 角色由 daemon 只读投影决定/)).toBeTruthy();
    expect(screen.queryByLabelText('会话抽屉筛选模式')).toBeNull();
    expect(screen.queryByLabelText('master 会话名')).toBeNull();
    expect(screen.queryByLabelText('subagent 会话名')).toBeNull();
    expect(screen.queryByLabelText('隐藏会话名')).toBeNull();
    expect(screen.queryByTestId('settings-session-drawer-master-names')).toBeNull();
    expect(screen.queryByTestId('settings-session-drawer-subagent-names')).toBeNull();
    expect(screen.queryByTestId('settings-session-drawer-hidden-names')).toBeNull();
  });

  it('keeps hidden session names when saving the existing settings draft', () => {
    const onSave = vi.fn(successfulBridgeSettings);
    renderSettings({
      onSave,
      settings: {
        ...baseSettings,
        sessionDrawerFilter: {
          version: 2,
          mode: 'hide-worker',
          hiddenSessionNames: ['OneStop-1', ' OneStop-1 ', 'tmux-master'],
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      sessionDrawerFilter: {
        version: 2,
        mode: 'hide-worker',
        hiddenSessionNames: ['OneStop-1', 'tmux-master'],
      },
    }));
  });

  it('refreshes the saved drawer config from a rerendered persisted BridgeSettings value', () => {
    const onSave = vi.fn(successfulBridgeSettings);
    const view = renderSettings({
      onSave,
      settings: {
        ...baseSettings,
        sessionDrawerFilter: {
          version: 2,
          mode: 'all',
          hiddenSessionNames: ['old-hidden'],
        },
      },
    });

    view.rerender(
      <SettingsPage
        settings={{
          ...baseSettings,
          sessionDrawerFilter: {
            version: 2,
            mode: 'only-master',
            hiddenSessionNames: ['persisted-hidden'],
          },
        }}
        currentVersionName="0.1.3"
        currentVersionCode={1030000}
        updatePreferences={updatePreferences}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        onSave={onSave}
        onUpdatePreferencesChange={vi.fn(() => ({
          ok: true as const,
          preferences: updatePreferences,
          persistedKeys: [],
        }))}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      sessionDrawerFilter: {
        version: 2,
        mode: 'only-master',
        hiddenSessionNames: ['persisted-hidden'],
      },
    }));
  });

  it('round-trips sessionDrawerFilter through the existing BridgeSettings export key only', () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    };
    const settings = {
      ...baseSettings,
      sessionDrawerFilter: {
        version: 2 as const,
        mode: 'hide-worker' as const,
        hiddenSessionNames: ['OneStop-1'],
      },
    };
    storage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify(settings));

    const payload = buildConfigExportPayload({
      storage,
      exportedAt: 1,
      appVersion: '0.1.3',
    });
    const exportedSettings = JSON.parse(payload.storage[STORAGE_KEYS.BRIDGE_SETTINGS] || '{}') as BridgeSettings;
    expect(exportedSettings.sessionDrawerFilter).toEqual(settings.sessionDrawerFilter);
    expect(payload.storage[SESSION_DRAWER_FILTER_STORAGE_KEY]).toBeUndefined();

    storage.removeItem(STORAGE_KEYS.BRIDGE_SETTINGS);
    applyConfigImportPayload(storage, payload);
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS) || '{}').sessionDrawerFilter)
      .toEqual(settings.sessionDrawerFilter);
  });
});
