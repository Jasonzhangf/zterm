// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateSection } from './AppUpdateSection';

afterEach(() => {
  cleanup();
});

function buildProps() {
  return {
    currentVersionName: '0.1.1.1590',
    currentVersionCode: 1011590,
    updateDraft: {
      manifestUrl: '',
      autoCheckOnLaunch: false,
      skippedVersionCode: undefined,
      ignoreUntilManualCheck: false,
      lastCheckedAt: undefined,
      lastSeenVersionCode: undefined,
    },
    latestManifest: null,
    updateChecking: false,
    updateInstalling: false,
    updateError: null,
    hasNewVersion: false,
    hasUpdateIgnorePolicy: false,
    suggestedManifestUrl: '',
    onUpdateDraftChange: vi.fn(),
    onCheckForUpdate: vi.fn(),
    onInstallUpdate: vi.fn(),
    onResetUpdateIgnorePolicy: vi.fn(),
    configBackupPath: '/storage/emulated/0/Download/zterm/zterm-config-backup.json',
    configBackupInfo: null,
    configBackupError: null,
    isExportingConfig: false,
    isRestoringConfig: false,
    onExportConfig: vi.fn(),
    onRestoreConfig: vi.fn(),
    rollbackBackup: null,
    isRollingBack: false,
    onRollback: vi.fn(),
  } as const;
}

describe('AppUpdateSection', () => {
  it('shows current version before latest manifest info', () => {
    render(<AppUpdateSection
      {...buildProps()}
      latestManifest={{
        versionName: '0.1.1.1591',
        versionCode: 1011591,
        apkUrl: 'zterm-0.1.1.1591.apk',
        sha256: 'abc',
        notes: [],
      }}
      hasNewVersion
    />);

    expect(screen.getByText('当前版本 0.1.1.1590 · versionCode 1011590')).toBeTruthy();
    expect(screen.getByText('最新版本 0.1.1.1591 · versionCode 1011591')).toBeTruthy();
  });

  it('fills manifest url from current daemon shortcut', () => {
    const onUpdateDraftChange = vi.fn();

    render(
      <AppUpdateSection
        {...buildProps()}
        suggestedManifestUrl="http://100.66.1.82:3333/updates/latest.json"
        onUpdateDraftChange={onUpdateDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '使用当前 daemon 地址' }));
    expect(onUpdateDraftChange).toHaveBeenCalledTimes(1);
  });

  it('shows rollback button when rollback backup exists and triggers onRollback', () => {
    const onRollback = vi.fn();

    render(
      <AppUpdateSection
        {...buildProps()}
        rollbackBackup={{
          versionCode: 1011589,
          versionName: '0.1.1.1589',
          filePath: '/tmp/rollback.apk',
          sha256: 'abc',
          backedUpAt: 123456789,
        }}
        isRollingBack={false}
        onRollback={onRollback}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '回退到 0.1.1.1589' }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it('shows config backup actions and triggers export/restore callbacks', () => {
    const onExportConfig = vi.fn();
    const onRestoreConfig = vi.fn();

    render(
      <AppUpdateSection
        {...buildProps()}
        configBackupInfo={{
          filePath: '/storage/emulated/0/Download/zterm/zterm-config-backup.json',
          exportedAt: 123456789,
          appVersion: '0.1.3.1795',
          appVersionCode: 1031795,
          storedKeys: 5,
        }}
        onExportConfig={onExportConfig}
        onRestoreConfig={onRestoreConfig}
      />,
    );

    expect(screen.getAllByText(/配置备份路径/).length).toBeGreaterThan(0);
    expect(screen.getByText(/最近配置备份 0.1.3.1795/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '导出配置' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '从备份恢复' })[0]);
    expect(onExportConfig).toHaveBeenCalledTimes(1);
    expect(onRestoreConfig).toHaveBeenCalledTimes(1);
  });

});
