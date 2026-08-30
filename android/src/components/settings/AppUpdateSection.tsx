import { mobileTheme } from '../../lib/mobile-ui';
import type { SettingsUpdateUiProps } from '../../lib/plugin-settings-update/settings-update-contract';
export type {
  AppUpdateManifestCandidate,
  SettingsUpdateUiProps as AppUpdateSectionProps,
} from '../../lib/plugin-settings-update/settings-update-contract';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

function formatManifestCandidateButtonLabel(label: string) {
  return label === '当前 daemon 地址' ? '使用当前 daemon 地址' : `使用 ${label}`;
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
  manifestCandidates,
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
  rollbackToPreviousEntry,
  onRollbackToPrevious,
}: SettingsUpdateUiProps) {
  const routeCandidates = manifestCandidates || [];

  return (
    <div data-testid="settings-update-section" style={settingsSectionStyle()}>
      <SettingsSectionTitle>版本与升级</SettingsSectionTitle>

      <div>
        <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Manifest URL</div>
        <input
          type="url"
          value={updateDraft.manifestUrl}
          onChange={(event) =>
            onUpdateDraftChange((current) => ({
              ...current,
              manifestUrl: event.target.value,
              manifestSource: event.target.value.trim() ? 'user-saved' : 'none',
            }))
          }
          placeholder="https://server.example.com/zterm/android/stable/latest.json"
          style={settingsInputStyle()}
        />
        {routeCandidates.length > 0 ? (
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {routeCandidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() =>
                  onUpdateDraftChange((current) => ({
                    ...current,
                    manifestUrl: candidate.manifestUrl,
                    manifestSource: candidate.manifestSource,
                  }))
                }
                style={{
                  minHeight: '40px',
                  padding: '0 14px',
                  borderRadius: '14px',
                  border: 'none',
                  backgroundColor: updateDraft.manifestUrl === candidate.manifestUrl ? mobileTheme.colors.shell : '#eef2f8',
                  color: updateDraft.manifestUrl === candidate.manifestUrl ? '#fff' : mobileTheme.colors.lightText,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {formatManifestCandidateButtonLabel(candidate.label)}
              </button>
            ))}
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
        {rollbackToPreviousEntry ? (
          <button
            onClick={onRollbackToPrevious}
            disabled={isRollingBack}
            style={{
              minHeight: '44px',
              padding: '0 16px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: 'rgba(239,68,68,0.16)',
              color: '#b91c1c',
              fontWeight: 800,
              cursor: isRollingBack ? 'wait' : 'pointer',
              opacity: isRollingBack ? 0.55 : 1,
            }}
          >
            {isRollingBack
              ? '正在回退到上一版本…'
              : `回退到上一版本 ${rollbackToPreviousEntry.sourceVersionName}`}
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
