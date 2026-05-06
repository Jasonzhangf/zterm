import { mobileTheme } from '../../lib/mobile-ui';
import type { AppUpdateManifest, AppUpdatePreferences } from '../../lib/app-update';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

interface AppUpdateSectionProps {
  updateDraft: AppUpdatePreferences;
  latestManifest: AppUpdateManifest | null;
  updateChecking: boolean;
  updateInstalling: boolean;
  updateError: string | null;
  hasNewVersion: boolean;
  hasUpdateIgnorePolicy: boolean;
  suggestedManifestUrl: string;
  onUpdateDraftChange: (updater: (current: AppUpdatePreferences) => AppUpdatePreferences) => void;
  onCheckForUpdate: () => void;
  onInstallUpdate: () => void;
  onResetUpdateIgnorePolicy: () => void;
}

export function AppUpdateSection({
  updateDraft,
  latestManifest,
  updateChecking,
  updateInstalling,
  updateError,
  hasNewVersion,
  hasUpdateIgnorePolicy,
  suggestedManifestUrl,
  onUpdateDraftChange,
  onCheckForUpdate,
  onInstallUpdate,
  onResetUpdateIgnorePolicy,
}: AppUpdateSectionProps) {
  return (
    <div style={settingsSectionStyle()}>
      <SettingsSectionTitle>App Update</SettingsSectionTitle>

      <div>
        <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Manifest URL</div>
        <input
          type="url"
          value={updateDraft.manifestUrl}
          onChange={(event) =>
            onUpdateDraftChange((current) => ({
              ...current,
              manifestUrl: event.target.value,
            }))
          }
          placeholder="https://server.example.com/zterm/android/stable/latest.json"
          style={settingsInputStyle()}
        />
        {suggestedManifestUrl ? (
          <div style={{ marginTop: '10px' }}>
            <button
              onClick={() =>
                onUpdateDraftChange((current) => ({
                  ...current,
                  manifestUrl: suggestedManifestUrl,
                }))
              }
              style={{
                minHeight: '40px',
                padding: '0 14px',
                borderRadius: '14px',
                border: 'none',
                backgroundColor: '#eef2f8',
                color: mobileTheme.colors.lightText,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              使用当前 daemon 地址
            </button>
          </div>
        ) : null}
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          fontSize: '15px',
          fontWeight: 600,
        }}
      >
        <input
          type="checkbox"
          checked={updateDraft.autoCheckOnLaunch}
          onChange={(event) =>
            onUpdateDraftChange((current) => ({
              ...current,
              autoCheckOnLaunch: event.target.checked,
            }))
          }
        />
        启动时自动检查更新
      </label>

      {latestManifest ? (
        <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
          最新版本 {latestManifest.versionName} · versionCode {latestManifest.versionCode}
          {latestManifest.publishedAt ? ` · ${latestManifest.publishedAt}` : ''}
        </div>
      ) : null}

      {updateError ? (
        <div style={{ color: mobileTheme.colors.danger, fontSize: '13px', lineHeight: 1.5 }}>{updateError}</div>
      ) : null}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <button
          onClick={onCheckForUpdate}
          disabled={updateChecking}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shell,
            color: '#fff',
            fontWeight: 800,
            cursor: updateChecking ? 'wait' : 'pointer',
            opacity: updateChecking ? 0.72 : 1,
          }}
        >
          {updateChecking ? '检查中…' : '检查更新'}
        </button>
        <button
          onClick={onInstallUpdate}
          disabled={!hasNewVersion || updateInstalling}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: 'rgba(31,214,122,0.18)',
            color: mobileTheme.colors.accent,
            fontWeight: 800,
            cursor: !hasNewVersion || updateInstalling ? 'not-allowed' : 'pointer',
            opacity: !hasNewVersion || updateInstalling ? 0.55 : 1,
          }}
        >
          {updateInstalling ? '准备安装…' : '下载并安装'}
        </button>
        {hasUpdateIgnorePolicy ? (
          <button
            onClick={onResetUpdateIgnorePolicy}
            style={{
              minHeight: '44px',
              padding: '0 16px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: '#eef2f8',
              color: mobileTheme.colors.lightText,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            清除忽略
          </button>
        ) : null}
      </div>
    </div>
  );
}
