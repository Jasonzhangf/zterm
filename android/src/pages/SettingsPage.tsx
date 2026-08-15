import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDefaultBridgeServer,
  removeBridgeServer,
  sortBridgeServers,
  TERMINAL_SHELL_SKIN_OPTIONS,
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
import type {
  AppUpdateManifestCandidate,
  SettingsUpdateUiSlot,
} from '../lib/plugin-settings-update/settings-update-contract';
import { RememberedServersSection } from '../components/settings/RememberedServersSection';
import { RelayAccountSettingsSection } from '../components/settings/RelayAccountSettingsSection';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from '../components/settings/SettingsSection';
import { TerminalThemeSection } from '../components/settings/TerminalThemeSection';
import {
  REMOTE_WINDOW_VIDEO_BITRATE_PRESETS,
  readRemoteWindowVideoBitrateGlobalDefault,
  writeRemoteWindowVideoBitrateGlobalDefault,
  buildRemoteWindowVideoBitrateConfig,
} from '../lib/remote-window-video-quality';
import type { RemoteWindowVideoBitratePreset } from '../lib/types';
import { deriveRelayUpdateManifestUrl } from '../lib/app-update-relay-manifest';

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
  rollbackToPreviousEntry?: import('../lib/app-update').AppUpdateRollbackEntry | null;
  onRollbackToPrevious?: () => void;
  onExportConfig?: () => void;
  onImportConfig?: () => void;
  configExporting?: boolean;
  configImporting?: boolean;
  onTerminalThemeChange?: (themeId: BridgeSettings['terminalThemeId']) => void;
  onTerminalShellSkinChange?: (skin: BridgeSettings['terminalShellSkin']) => void;
  renderSettingsUpdate?: SettingsUpdateUiSlot['render'];
  onBack: () => void;
}

interface DaemonUpdateRouteInput {
  id: string;
  name: string;
  targetHost: string;
  targetPort: number;
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

function addManifestCandidate(
  candidates: AppUpdateManifestCandidate[],
  seenUrls: Set<string>,
  candidate: AppUpdateManifestCandidate,
) {
  const url = candidate.manifestUrl.trim();
  if (!url || seenUrls.has(url)) {
    return;
  }
  seenUrls.add(url);
  candidates.push({ ...candidate, manifestUrl: url });
}

function buildAppUpdateManifestCandidates(settings: BridgeSettings): AppUpdateManifestCandidate[] {
  const candidates: AppUpdateManifestCandidate[] = [];
  const seenUrls = new Set<string>();
  const relayWsHostUrl = settings.traversalRelay?.wsHostUrl?.trim() || '';

  if (relayWsHostUrl) {
    try {
      addManifestCandidate(candidates, seenUrls, {
        id: 'relay-public',
        label: 'Relay 公网',
        manifestUrl: deriveRelayUpdateManifestUrl(relayWsHostUrl),
        manifestSource: 'relay-injected',
      });
    } catch (error) {
      console.warn('[SettingsPage] Failed to derive relay update manifest URL:', error);
    }
  }

  const defaultServer = getDefaultBridgeServer(settings);
  const directInputs: Array<DaemonUpdateRouteInput | null | undefined> = [
    defaultServer,
    ...settings.servers.filter((server) => server.id !== defaultServer?.id),
    settings.targetHost.trim()
      ? {
          id: 'current-target',
          name: '当前 daemon 地址',
          targetHost: settings.targetHost,
          targetPort: settings.targetPort,
        }
      : null,
  ];

  for (const server of directInputs.filter((item): item is DaemonUpdateRouteInput => Boolean(item))) {
    const manifestUrl = deriveDaemonUpdateManifestUrl(server.targetHost, server.targetPort);
    addManifestCandidate(candidates, seenUrls, {
      id: `daemon-${server.id || `${server.targetHost}:${server.targetPort}`}`,
      label: server.name?.trim() || '当前 daemon 地址',
      manifestUrl,
      manifestSource: 'server-connected',
    });
  }

  return candidates;
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
  rollbackToPreviousEntry,
  onRollbackToPrevious,
  onExportConfig,
  onImportConfig,
  configExporting = false,
  configImporting = false,
  onTerminalThemeChange,
  onTerminalShellSkinChange,
  renderSettingsUpdate,
  onBack,
}: SettingsPageProps) {
  const [draft, setDraft] = useState({ ...settings, servers: sortBridgeServers(settings.servers) });
  const [updateDraft, setUpdateDraft] = useState(updatePreferences);
  const [runtimeDebugEnabled, setRuntimeDebugEnabledState] = useState(() => isRuntimeDebugEnabled());
  const [remoteWindowBitrate, setRemoteWindowBitrate] = useState<RemoteWindowVideoBitratePreset>(() => (
    readRemoteWindowVideoBitrateGlobalDefault() || '5mbps'
  ));
  const [remoteScrollFraction, setRemoteScrollFraction] = useState<number>(() => {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem('zterm:remote-window:touch-scroll-fraction-v1');
    const parsed = raw === null ? NaN : Number(raw);
    return [0.125, 0.25, 0.5, 1].includes(parsed) ? parsed : 0.25;
  });
  const [remoteScrollInverted, setRemoteScrollInverted] = useState<boolean>(() => (
    typeof window !== 'undefined' && window.localStorage.getItem('zterm:remote-window:touch-scroll-inverted-v1') === 'true'
  ));
  const livePreviewPatchRef = useRef<Partial<Pick<BridgeSettings, 'terminalThemeId' | 'terminalShellSkin'>> | null>(null);
  const defaultServer = useMemo(() => getDefaultBridgeServer(draft), [draft]);
  const manifestCandidates = useMemo(() => buildAppUpdateManifestCandidates(draft), [draft]);
  const suggestedManifestUrl = useMemo(
    () => manifestCandidates.find((candidate) => candidate.manifestSource === 'server-connected')?.manifestUrl || '',
    [manifestCandidates],
  );
  useEffect(() => {
    setUpdateDraft(updatePreferences);
  }, [updatePreferences]);

  useEffect(() => {
    const livePreviewPatch = livePreviewPatchRef.current;
    if (livePreviewPatch) {
      livePreviewPatchRef.current = null;
      setDraft((current) => ({
        ...current,
        terminalThemeId: settings.terminalThemeId,
        terminalShellSkin: settings.terminalShellSkin,
      }));
      return;
    }
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
        {renderSettingsUpdate ? renderSettingsUpdate({
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
          manifestCandidates,
          onUpdateDraftChange: (updater) => setUpdateDraft((current) => updater(current)),
          onCheckForUpdate: () => onCheckForUpdate(updateDraft),
          onInstallUpdate,
          onResetUpdateIgnorePolicy,
          onExportConfig,
          onImportConfig,
          configExporting,
          configImporting,
          rollbackBackup,
          isRollingBack,
          onRollback,
          rollbackToPreviousEntry,
          onRollbackToPrevious,
        }) : null}

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
            打开后，客户端会临时通过当前已连接的会话 WebSocket 上送 runtime debug 日志到 daemon，默认 10 分钟后自动停止。关闭后立即停止上送。
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

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>远程窗口</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            串流画质与触控滚动偏好，作用于后续远程窗口会话。
          </div>
          <div style={{ marginTop: '12px', marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>默认码率</div>
          <select
            value={remoteWindowBitrate}
            onChange={(event) => {
              const next = event.currentTarget.value as RemoteWindowVideoBitratePreset;
              setRemoteWindowBitrate(next);
              writeRemoteWindowVideoBitrateGlobalDefault(next);
            }}
            style={settingsInputStyle()}
          >
            {REMOTE_WINDOW_VIDEO_BITRATE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {buildRemoteWindowVideoBitrateConfig(preset).bitrateMbps} Mbps
              </option>
            ))}
          </select>
          <div style={{ marginTop: '12px', marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>滚动幅度</div>
          <select
            value={String(remoteScrollFraction)}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              setRemoteScrollFraction(next);
              if (typeof window !== 'undefined') {
                window.localStorage.setItem('zterm:remote-window:touch-scroll-fraction-v1', String(next));
              }
            }}
            style={settingsInputStyle()}
          >
            {[0.125, 0.25, 0.5, 1].map((fraction) => (
              <option key={fraction} value={fraction}>
                {fraction === 1 ? '整屏' : `${Math.round(fraction * 100)}%`}
              </option>
            ))}
          </select>
          <div style={{ marginTop: '12px', marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>滚动方向</div>
          <button
            type="button"
            onClick={() => {
              const next = !remoteScrollInverted;
              setRemoteScrollInverted(next);
              if (typeof window !== 'undefined') {
                window.localStorage.setItem('zterm:remote-window:touch-scroll-inverted-v1', String(next));
              }
            }}
            style={{
              minHeight: '48px',
              width: '100%',
              borderRadius: '16px',
              border: 'none',
              backgroundColor: remoteScrollInverted ? mobileTheme.colors.shell : '#eef3f8',
              color: remoteScrollInverted ? '#ffffff' : mobileTheme.colors.lightText,
              fontWeight: 800,
              fontSize: '16px',
              cursor: 'pointer',
            }}
          >
            {remoteScrollInverted ? '反向滚动（已开启）' : '正向滚动'}
          </button>
        </div>

        <TerminalThemeSection
          terminalThemeId={draft.terminalThemeId}
          onSelectTheme={(themeId) => {
            if (onTerminalThemeChange) {
              livePreviewPatchRef.current = { terminalThemeId: themeId };
            }
            setDraft((current) => ({ ...current, terminalThemeId: themeId }));
            onTerminalThemeChange?.(themeId);
          }}
        />

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>Shell Skin</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            这里单独控制顶部栏、快捷栏和终端外壳，不改变终端 ANSI 颜色。默认跟主页保持白灰配色。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: '10px' }}>
            {TERMINAL_SHELL_SKIN_OPTIONS.map((option) => {
              const active = draft.terminalShellSkin === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    if (onTerminalShellSkinChange) {
                      livePreviewPatchRef.current = { terminalShellSkin: option.id };
                    }
                    setDraft((current) => ({ ...current, terminalShellSkin: option.id }));
                    onTerminalShellSkinChange?.(option.id);
                  }}
                  style={{
                    minHeight: '76px',
                    borderRadius: '18px',
                    border: active ? `2px solid ${mobileTheme.colors.accent}` : `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: active ? '#ffffff' : '#f7f9fc',
                    color: mobileTheme.colors.lightText,
                    boxShadow: active ? '0 12px 26px rgba(31,214,122,0.14)' : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    padding: '12px',
                  }}
                >
                  <div style={{ fontSize: '15px', fontWeight: 850 }}>{option.label}</div>
                  <div style={{ marginTop: '5px', fontSize: '11px', lineHeight: 1.35, color: mobileTheme.colors.lightMuted }}>
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
