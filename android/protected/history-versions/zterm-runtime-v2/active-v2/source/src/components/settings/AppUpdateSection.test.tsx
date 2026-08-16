// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppUpdateSection } from './AppUpdateSection';

describe('AppUpdateSection', () => {
  it('shows current version before latest manifest info', () => {
    render(
      <AppUpdateSection
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updateDraft={{
          manifestUrl: '',
          autoCheckOnLaunch: false,
          skippedVersionCode: undefined,
          ignoreUntilManualCheck: false,
          lastCheckedAt: undefined,
          lastSeenVersionCode: undefined,
        }}
        latestManifest={{
          versionName: '0.1.1.1591',
          versionCode: 1011591,
          apkUrl: 'zterm-0.1.1.1591.apk',
          sha256: 'abc',
          notes: [],
        }}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion
        hasUpdateIgnorePolicy={false}
        suggestedManifestUrl=""
        onUpdateDraftChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        rollbackBackup={null}
        isRollingBack={false}
        onRollback={vi.fn()}
      />,
    );

    expect(screen.getByText('当前版本 0.1.1.1590 · versionCode 1011590')).toBeTruthy();
    expect(screen.getByText('最新版本 0.1.1.1591 · versionCode 1011591')).toBeTruthy();
  });

  it('fills manifest url from current daemon shortcut', () => {
    const onUpdateDraftChange = vi.fn();

    render(
      <AppUpdateSection
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updateDraft={{
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
        suggestedManifestUrl="http://100.66.1.82:3333/updates/latest.json"
        onUpdateDraftChange={onUpdateDraftChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        rollbackBackup={null}
        isRollingBack={false}
        onRollback={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '使用当前 daemon 地址' }));
    expect(onUpdateDraftChange).toHaveBeenCalledTimes(1);
    expect(onUpdateDraftChange.mock.calls[0][0]({
      manifestUrl: '',
      manifestSource: 'none',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    })).toMatchObject({
      manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
      manifestSource: 'server-connected',
    });
  });

  it('fills manifest url from an explicit relay update route candidate', () => {
    const onUpdateDraftChange = vi.fn();

    render(
      <AppUpdateSection
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updateDraft={{
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
        suggestedManifestUrl=""
        manifestCandidates={[
          {
            id: 'relay-public',
            label: 'Relay 公网',
            manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
            manifestSource: 'relay-injected',
          },
          {
            id: 'daemon-direct',
            label: 'Mac Studio daemon',
            manifestUrl: 'http://100.66.1.82:3333/updates/latest.json',
            manifestSource: 'server-connected',
          },
        ]}
        onUpdateDraftChange={onUpdateDraftChange}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
        rollbackBackup={null}
        isRollingBack={false}
        onRollback={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '使用 Relay 公网' }));
    expect(onUpdateDraftChange).toHaveBeenCalledTimes(1);
    expect(onUpdateDraftChange.mock.calls[0][0]({
      manifestUrl: '',
      manifestSource: 'none',
      autoCheckOnLaunch: false,
      ignoreUntilManualCheck: false,
    })).toMatchObject({
      manifestUrl: 'https://relay.codewhisper.cc:18443/relay/updates/latest.json',
      manifestSource: 'relay-injected',
    });
  });

  it('shows rollback button when rollback backup exists and triggers onRollback', () => {
    const onRollback = vi.fn();

    render(
      <AppUpdateSection
        currentVersionName="0.1.1.1590"
        currentVersionCode={1011590}
        updateDraft={{
          manifestUrl: '',
          autoCheckOnLaunch: false,
          skippedVersionCode: undefined,
          ignoreUntilManualCheck: false,
          lastCheckedAt: undefined,
          lastSeenVersionCode: undefined,
          rollbackBackup: null,
        }}
        latestManifest={null}
        updateChecking={false}
        updateInstalling={false}
        updateError={null}
        hasNewVersion={false}
        hasUpdateIgnorePolicy={false}
        suggestedManifestUrl=""
        onUpdateDraftChange={vi.fn()}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onResetUpdateIgnorePolicy={vi.fn()}
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
});
