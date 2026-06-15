import { mobileTheme } from '../../lib/mobile-ui';
import type { AppUpdateManifest, AppUpdatePreferences, AppUpdateRollbackBackup } from '../../lib/app-update';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

interface AppUpdateSectionProps {
  currentVersionName: string;
  currentVersionCode: number;
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
  onExportConfig?: () => void;
  onImportConfig?: () => void;
  configExporting?: boolean;
  configImporting?: boolean;
  rollbackBackup?: AppUpdateRollbackBackup | null;
  isRollingBack?: boolean;
  onRollback?: () => void;
}

export function AppUpdateSection({
  currentVersionName,
  currentVersionCode,
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
  onExportConfig,
  onImportConfig,
  configExporting = false,
  configImporting = false,
  rollbackBackup,
  isRollingBack = false,
  onRollback,
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

      <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
        当前版本 {currentVersionName} · versionCode {currentVersionCode}
      </div>

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
        <button
          onClick={onExportConfig}
          disabled={configExporting || configImporting}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: 'rgba(59,130,246,0.16)',
            color: '#1d4ed8',
            fontWeight: 800,
            cursor: configExporting || configImporting ? 'wait' : 'pointer',
            opacity: configExporting || configImporting ? 0.55 : 1,
          }}
        >
          {configExporting ? '导出中…' : '导出配置'}
        </button>
        <button
          onClick={onImportConfig}
          disabled={configImporting || configExporting}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: 'rgba(14,165,233,0.16)',
            color: '#0369a1',
            fontWeight: 800,
            cursor: configImporting || configExporting ? 'wait' : 'pointer',
            opacity: configImporting || configExporting ? 0.55 : 1,
          }}
        >
          {configImporting ? '导入中…' : '导入配置'}
        </button>
        {rollbackBackup ? (
          <button
            onClick={onRollback}
            disabled={isRollingBack}
            style={{
              minHeight: '44px',
              padding: '0 16px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: 'rgba(245,158,11,0.18)',
              color: '#b45309',
              fontWeight: 800,
              cursor: isRollingBack ? 'wait' : 'pointer',
              opacity: isRollingBack ? 0.55 : 1,
            }}
          >
            {isRollingBack ? '正在回滚…' : `回退到 ${rollbackBackup.versionName}`}
          </button>
        ) : null}
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
