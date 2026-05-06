import { useEffect, useMemo, useState } from 'react';
import {
  getDefaultBridgeServer,
  removeBridgeServer,
  sortBridgeServers,
  type BridgeSettings,
} from '../lib/bridge-settings';
import { type AppUpdateManifest, type AppUpdatePreferences } from '../lib/app-update';
import { APP_VERSION_CODE } from '../lib/app-version';
import { useTraversalRelayAccount } from '../hooks/useTraversalRelayAccount';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import { mobileTheme } from '../lib/mobile-ui';
import {
  TERMINAL_WIDTH_MODE_OPTIONS,
  updateBridgeSettingsTerminalWidthMode,
} from '../lib/terminal-width-mode-manager';
import { AppUpdateSection } from '../components/settings/AppUpdateSection';
import { RememberedServersSection } from '../components/settings/RememberedServersSection';
import { RelayControlSection } from '../components/settings/RelayControlSection';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from '../components/settings/SettingsSection';
import { TerminalThemeSection } from '../components/settings/TerminalThemeSection';

interface SettingsPageProps {
  settings: BridgeSettings;
  updatePreferences: AppUpdatePreferences;
  latestManifest: AppUpdateManifest | null;
  updateChecking: boolean;
  updateInstalling: boolean;
  updateError: string | null;
  onSave: (settings: BridgeSettings) => void;
  onUpdatePreferencesChange: (next: AppUpdatePreferences) => void;
  onCheckForUpdate: (next: AppUpdatePreferences) => void;
  onInstallUpdate: () => void;
  onResetUpdateIgnorePolicy: () => void;
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
  updatePreferences,
  latestManifest,
  updateChecking,
  updateInstalling,
  updateError,
  onSave,
  onUpdatePreferencesChange,
  onCheckForUpdate,
  onInstallUpdate,
  onResetUpdateIgnorePolicy,
  onTerminalThemeChange,
  onBack,
}: SettingsPageProps) {
  const [draft, setDraft] = useState({ ...settings, servers: sortBridgeServers(settings.servers) });
  const [updateDraft, setUpdateDraft] = useState(updatePreferences);
  const [relayBaseUrl, setRelayBaseUrl] = useState(settings.traversalRelay?.relayBaseUrl || '');
  const [relayUsername, setRelayUsername] = useState('');
  const [relayPassword, setRelayPassword] = useState('');
  const {
    account: relayAccount,
    relayDevices,
    relayStatus,
    relayBusy,
    syncRelay,
  } = useTraversalRelayAccount(settings.traversalRelay);
  const defaultServer = useMemo(() => getDefaultBridgeServer(draft), [draft]);
  const hasUpdateIgnorePolicy = updatePreferences.ignoreUntilManualCheck || Boolean(updatePreferences.skippedVersionCode);
  const hasNewVersion = Boolean(latestManifest && latestManifest.versionCode > APP_VERSION_CODE);
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
    setRelayBaseUrl(settings.traversalRelay?.relayBaseUrl || '');
  }, [settings]);

  useEffect(() => {
    if (!relayAccount) {
      return;
    }
    setRelayUsername(relayAccount.username);
    setRelayPassword(relayAccount.password);
    setRelayBaseUrl(relayAccount.relayBaseUrl);
  }, [relayAccount]);

  const handleRelaySync = async (mode: 'login' | 'register' | 'refresh') => {
    const relayResult = await syncRelay(
      mode,
      {
        relayBaseUrl,
        username: relayUsername,
        password: relayPassword,
      },
      draft.traversalRelay,
    );
    if (!relayResult) {
      return;
    }
    setDraft((current) => ({
      ...current,
      traversalRelay: {
        ...relayResult.relaySettings,
        deviceId: relayResult.account.deviceId,
        deviceName: relayResult.account.deviceName,
        platform: relayResult.account.platform,
      },
    }));
  };

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
            `mirror-fixed` 保持 tmux / daemon 镜像宽度不变，只做本地裁切；`adaptive-phone` 只允许按手机屏宽调整 cols，不再改 rows。
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

        <RelayControlSection
          transportMode={draft.transportMode}
          onTransportModeChange={(transportMode) => setDraft((current) => ({ ...current, transportMode }))}
          relayBaseUrl={relayBaseUrl}
          onRelayBaseUrlChange={setRelayBaseUrl}
          relayUsername={relayUsername}
          onRelayUsernameChange={setRelayUsername}
          relayPassword={relayPassword}
          onRelayPasswordChange={setRelayPassword}
          relayBusy={relayBusy}
          relayStatus={relayStatus}
          relaySettings={draft.traversalRelay}
          relayDevices={relayDevices}
          onRegister={() => void handleRelaySync('register')}
          onLogin={() => void handleRelaySync('login')}
          onRefresh={() => void handleRelaySync('refresh')}
        />

        <TerminalThemeSection
          terminalThemeId={draft.terminalThemeId}
          onSelectTheme={(themeId) => {
            setDraft((current) => ({ ...current, terminalThemeId: themeId }));
            onTerminalThemeChange?.(themeId);
          }}
        />

        <RememberedServersSection
          settings={draft}
          onSettingsChange={(updater) => setDraft((current) => updater(current))}
          onRemoveDefaultServer={() =>
            setDraft((current) => removeBridgeServer(current, defaultServer?.id || current.defaultServerId || ''))
          }
        />
      </div>
    </div>
  );
}
