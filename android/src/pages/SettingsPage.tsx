import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getDefaultBridgeServer,
  removeBridgeServer,
  sortBridgeServers,
  type BridgeSettings,
} from '../lib/bridge-settings';
import { type AppUpdateManifest, type AppUpdatePreferences, type AppUpdateRollbackBackup } from '../lib/app-update';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import { isRuntimeDebugEnabled, setRuntimeDebugEnabled } from '../lib/runtime-debug';
import { mobileTheme } from '../lib/mobile-ui';
import {
  TERMINAL_WIDTH_MODE_OPTIONS,
  updateBridgeSettingsTerminalWidthMode,
} from '../lib/terminal-width-mode-manager';
import {
  TERMINAL_SESSION_GROUP_LAYOUT_OPTIONS,
  normalizeTerminalSessionGroupLayoutMode,
} from '../lib/terminal-layout-profile';
import { AppUpdateSection } from '../components/settings/AppUpdateSection';
import { RememberedServersSection } from '../components/settings/RememberedServersSection';
import { RelayAccountSettingsSection } from '../components/settings/RelayAccountSettingsSection';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from '../components/settings/SettingsSection';
import { TerminalThemeSection } from '../components/settings/TerminalThemeSection';

interface SettingsPageProps {
  settings: BridgeSettings;
  currentVersionName: string;
  currentVersionCode: number;
  updatePreferences: AppUpdatePreferences;
  latestManifest: AppUpdateManifest | null;
  updateChecking: boolean;
  updateInstalling: boolean;
  updateError: string | null;
  hasNewVersion: boolean;
  hasUpdateIgnorePolicy: boolean;
  onSave: (settings: BridgeSettings) => void;
  onRelaySettingsChange?: (settings: BridgeSettings['traversalRelay']) => void;
  onUpdatePreferencesChange: (next: AppUpdatePreferences) => void;
  onCheckForUpdate: (next: AppUpdatePreferences) => void;
  onInstallUpdate: () => void;
  onResetUpdateIgnorePolicy: () => void;
  rollbackBackup?: AppUpdateRollbackBackup | null;
  isRollingBack?: boolean;
  onRollback?: () => void;
  onExportConfig?: () => void;
  onImportConfig?: () => void;
  configExporting?: boolean;
  configImporting?: boolean;
  onTerminalThemeChange?: (themeId: BridgeSettings['terminalThemeId']) => void;
  onBack: () => void;
}

function deriveDaemonUpdateManifestUrl(targetHost: string, targetPort: number) {
  const rawHost = targetHost.trim();
  if (!rawHost) {
    return '';
  }

  try {
    const parsed = rawHost.includes('://') ? new URL(rawHost) : new URL(`ws://${rawHost}`);
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    const port = parsed.port || String(targetPort || 3333);
    return `${protocol}//${parsed.hostname}:${port}/updates/latest.json`;
  } catch (error) {
    console.warn('[SettingsPage] Failed to derive daemon update manifest URL:', error);
    return '';
  }
}

export function SettingsPage({
  settings,
  currentVersionName,
  currentVersionCode,
  updatePreferences,
  latestManifest,
  updateChecking,
  updateInstalling,
  updateError,
  hasNewVersion,
  hasUpdateIgnorePolicy,
  onSave,
  onRelaySettingsChange,
  onUpdatePreferencesChange,
  onCheckForUpdate,
  onInstallUpdate,
  onResetUpdateIgnorePolicy,
  rollbackBackup,
  isRollingBack = false,
  onRollback,
  onExportConfig,
  onImportConfig,
  configExporting = false,
  configImporting = false,
  onTerminalThemeChange,
  onBack,
}: SettingsPageProps) {
  const [draft, setDraft] = useState({ ...settings, servers: sortBridgeServers(settings.servers) });
  const [updateDraft, setUpdateDraft] = useState(updatePreferences);
  const [runtimeDebugEnabled, setRuntimeDebugEnabledState] = useState(() => isRuntimeDebugEnabled());
  const defaultServer = useMemo(() => getDefaultBridgeServer(draft), [draft]);
  const suggestedManifestUrl = useMemo(
    () => deriveDaemonUpdateManifestUrl(
      defaultServer?.targetHost || draft.targetHost || '',
      defaultServer?.targetPort || draft.targetPort || 3333,
    ),
    [defaultServer?.targetHost, defaultServer?.targetPort, draft.targetHost, draft.targetPort],
  );
  useEffect(() => {
    setUpdateDraft(updatePreferences);
  }, [updatePreferences]);

  useEffect(() => {
    setDraft({ ...settings, servers: sortBridgeServers(settings.servers) });
  }, [settings]);

  const handleRelaySettingsChange = useCallback((nextRelay: BridgeSettings['traversalRelay']) => {
    setDraft((current) => ({
      ...current,
      traversalRelay: nextRelay,
    }));
    onRelaySettingsChange?.(nextRelay);
  }, [onRelaySettingsChange]);

  return (
    <div
      data-testid="settings-scroll"
      style={{
        minHeight: '100dvh',
        maxHeight: '100dvh',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        backgroundColor: mobileTheme.colors.lightBg,
        color: mobileTheme.colors.lightText,
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          padding: `${mobileTheme.safeArea.top} 18px 18px`,
          backgroundColor: 'rgba(237, 242, 246, 0.94)',
          backdropFilter: 'blur(14px)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
        }}
      >
        <button
          onClick={onBack}
          style={{
            width: '56px',
            height: '56px',
            borderRadius: '20px',
            border: 'none',
            backgroundColor: '#ffffff',
            color: mobileTheme.colors.lightText,
            fontSize: '26px',
            boxShadow: mobileTheme.shadow.soft,
            cursor: 'pointer',
          }}
        >
          ‹
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Settings</div>
        </div>
        <button
          onClick={() => {
            onSave(draft);
            onUpdatePreferencesChange(updateDraft);
          }}
          style={{
            minWidth: '92px',
            height: '56px',
            borderRadius: '20px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shell,
            color: '#ffffff',
            fontWeight: 800,
            boxShadow: mobileTheme.shadow.soft,
            cursor: 'pointer',
          }}
        >
          Save
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '18px 18px 32px' }}>
        <AppUpdateSection
          currentVersionName={currentVersionName}
          currentVersionCode={currentVersionCode}
          updateDraft={updateDraft}
          latestManifest={latestManifest}
          updateChecking={updateChecking}
          updateInstalling={updateInstalling}
          updateError={updateError}
          hasNewVersion={hasNewVersion}
          hasUpdateIgnorePolicy={hasUpdateIgnorePolicy}
          suggestedManifestUrl={suggestedManifestUrl}
          onUpdateDraftChange={(updater) => setUpdateDraft((current) => updater(current))}
          onCheckForUpdate={() => onCheckForUpdate(updateDraft)}
          onInstallUpdate={onInstallUpdate}
          onResetUpdateIgnorePolicy={onResetUpdateIgnorePolicy}
          onExportConfig={onExportConfig}
          onImportConfig={onImportConfig}
          configExporting={configExporting}
          configImporting={configImporting}
          rollbackBackup={rollbackBackup}
          isRollingBack={isRollingBack}
          onRollback={onRollback}
        />

        <RememberedServersSection
          settings={draft}
          onSettingsChange={(updater) => setDraft((current) => updater(current))}
          onRemoveDefaultServer={() =>
            setDraft((current) => removeBridgeServer(current, defaultServer?.id || current.defaultServerId || ''))
          }
        />

        <RelayAccountSettingsSection
          relaySettings={draft.traversalRelay}
          onRelaySettingsChange={handleRelaySettingsChange}
        />

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>Terminal Cache</SettingsSectionTitle>
          <div>
            <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Terminal Cache Lines</div>
            <input
              type="number"
              min={200}
              max={DEFAULT_TERMINAL_CACHE_LINES}
              value={draft.terminalCacheLines}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  terminalCacheLines: Math.min(
                    DEFAULT_TERMINAL_CACHE_LINES,
                    Math.max(200, Number.parseInt(event.target.value, 10) || current.terminalCacheLines),
                  ),
                }))
              }
              style={settingsInputStyle()}
            />
          </div>
        </div>

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>Terminal Width Mode</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            `mirror-fixed` 保持 tmux / daemon 镜像宽度不变，只做本地裁切；`adaptive-phone` 会按手机屏宽请求 tmux 重新排版，只调整 cols，不改 rows。
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            {TERMINAL_WIDTH_MODE_OPTIONS.map((option) => {
              const active = draft.terminalWidthMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setDraft((current) => updateBridgeSettingsTerminalWidthMode(current, option.id))}
                  style={{
                    flex: 1,
                    minHeight: '48px',
                    borderRadius: '16px',
                    border: 'none',
                    backgroundColor: active ? mobileTheme.colors.shell : '#eef3f8',
                    color: active ? '#ffffff' : mobileTheme.colors.lightText,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>Session Group Layout</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            默认按宽高比决定：手机窄屏保持上下滚动；宽竖屏默认左右滚动。横屏始终左右滚动。
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            {TERMINAL_SESSION_GROUP_LAYOUT_OPTIONS.map((option) => {
              const active = normalizeTerminalSessionGroupLayoutMode(draft.terminalSessionGroupLayoutMode) === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  title={option.description}
                  onClick={() => setDraft((current) => ({
                    ...current,
                    terminalSessionGroupLayoutMode: option.id,
                  }))}
                  style={{
                    flex: 1,
                    minHeight: '48px',
                    borderRadius: '16px',
                    border: 'none',
                    backgroundColor: active ? mobileTheme.colors.shell : '#eef3f8',
                    color: active ? '#ffffff' : mobileTheme.colors.lightText,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>Daemon Debug</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            打开后，客户端会通过当前已连接的 Tailscale WebSocket 自动持续把 runtime debug 日志上送到 daemon。关闭后立即停止上送。
          </div>
          <button
            type="button"
            onClick={() => {
              const nextEnabled = !runtimeDebugEnabled;
              setRuntimeDebugEnabled(nextEnabled);
              setRuntimeDebugEnabledState(nextEnabled);
            }}
            style={{
              minHeight: '48px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: runtimeDebugEnabled ? mobileTheme.colors.shell : '#eef3f8',
              color: runtimeDebugEnabled ? '#ffffff' : mobileTheme.colors.lightText,
              fontWeight: 800,
              fontSize: '16px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '18px' }}>{runtimeDebugEnabled ? '✓' : '○'}</span>
            Daemon Debug {runtimeDebugEnabled ? '已开启' : '已关闭'}
          </button>
        </div>

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>快捷键智能排序</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            开启后，高频使用的快捷键会自动排到前面（历史使用占 80%，最近 10 分钟占 20%），减少滚动查找。
          </div>
          <button
            type="button"
            onClick={() => setDraft((current) => ({ ...current, shortcutSmartSort: !current.shortcutSmartSort }))}
            style={{
              minHeight: '48px',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: draft.shortcutSmartSort ? mobileTheme.colors.shell : '#eef3f8',
              color: draft.shortcutSmartSort ? '#ffffff' : mobileTheme.colors.lightText,
              fontWeight: 800,
              fontSize: '16px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '18px' }}>{draft.shortcutSmartSort ? '✓' : '○'}</span>
            智能排序 {draft.shortcutSmartSort ? '已开启' : '已关闭'}
          </button>
        </div>

        <TerminalThemeSection
          terminalThemeId={draft.terminalThemeId}
          onSelectTheme={(themeId) => {
            setDraft((current) => ({ ...current, terminalThemeId: themeId }));
            onTerminalThemeChange?.(themeId);
          }}
        />

      </div>
    </div>
  );
}
