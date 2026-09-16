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

  it('renders the persisted mode and name lists', () => {
    renderSettings({
      settings: {
        ...baseSettings,
        sessionDrawerFilter: {
          version: 1,
          mode: 'hide-subagent',
          masterNames: ['zterm-3', 'master-a'],
          subagentNames: ['worker-a'],
          hiddenSessionNames: ['OneStop-1'],
        },
      },
    });

    expect((screen.getByLabelText('会话抽屉筛选模式') as HTMLSelectElement).value).toBe('hide-subagent');
    expect((screen.getByLabelText('master 会话名') as HTMLTextAreaElement).value).toBe('zterm-3\nmaster-a');
    expect((screen.getByLabelText('subagent 会话名') as HTMLTextAreaElement).value).toBe('worker-a');
    expect((screen.getByLabelText('隐藏会话名') as HTMLTextAreaElement).value).toBe('OneStop-1');
  });

  it('normalizes edited values into BridgeSettings on the existing save action', () => {
    const onSave = vi.fn(successfulBridgeSettings);
    renderSettings({ onSave });

    fireEvent.change(screen.getByLabelText('会话抽屉筛选模式'), {
      target: { value: 'only-master' },
    });
    fireEvent.change(screen.getByLabelText('master 会话名'), {
      target: { value: ' zterm-3 \nmaster-a\nzterm-3\n' },
    });
    fireEvent.change(screen.getByLabelText('subagent 会话名'), {
      target: { value: '\nworker-a\n worker-b \nworker-a' },
    });
    fireEvent.change(screen.getByLabelText('隐藏会话名'), {
      target: { value: '\nOneStop-1\n OneStop-1 \n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      sessionDrawerFilter: {
        version: 1,
        mode: 'only-master',
        masterNames: ['zterm-3', 'master-a'],
        subagentNames: ['worker-a', 'worker-b'],
        hiddenSessionNames: ['OneStop-1'],
      },
    }));
  });

  it('refreshes the draft from a rerendered persisted BridgeSettings value', () => {
    const view = renderSettings();
    const masterNames = screen.getByLabelText('master 会话名');
    fireEvent.change(masterNames, { target: { value: 'draft-only' } });
    expect((masterNames as HTMLTextAreaElement).value).toBe('draft-only');

    view.rerender(
      <SettingsPage
        settings={{
          ...baseSettings,
          sessionDrawerFilter: {
            version: 1,
            mode: 'only-master',
            masterNames: ['persisted-master'],
            subagentNames: ['persisted-worker'],
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
      />,
    );

    expect((screen.getByLabelText('会话抽屉筛选模式') as HTMLSelectElement).value).toBe('only-master');
    expect((screen.getByLabelText('master 会话名') as HTMLTextAreaElement).value).toBe('persisted-master');
    expect((screen.getByLabelText('subagent 会话名') as HTMLTextAreaElement).value).toBe('persisted-worker');
    expect((screen.getByLabelText('隐藏会话名') as HTMLTextAreaElement).value).toBe('persisted-hidden');
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
        version: 1 as const,
        mode: 'hide-subagent' as const,
        masterNames: ['zterm-3'],
        subagentNames: ['worker-a'],
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
