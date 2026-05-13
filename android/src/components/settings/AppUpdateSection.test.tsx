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
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '使用当前 daemon 地址' }));
    expect(onUpdateDraftChange).toHaveBeenCalledTimes(1);
  });
});
