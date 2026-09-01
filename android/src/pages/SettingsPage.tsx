import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { ConnectionConfigSection } from '../components/settings/ConnectionConfigSection';
import {
  settingsViewportPadding,
  SettingsSectionTitle,
  settingsInputStyle,
  settingsSectionStyle,
} from '../components/settings/SettingsSection';
import { TerminalThemeSection } from '../components/settings/TerminalThemeSection';
import {
  REMOTE_WINDOW_VIDEO_PREFERENCES,
  readRemoteWindowVideoPreferenceGlobalDefault,
  writeRemoteWindowVideoPreferenceGlobalDefault,
} from '../lib/remote-window-video-quality';
import type { RemoteWindowVideoPreference, TraversalRelayDeviceSnapshot } from '../lib/types';
import { buildAppUpdateManifestCandidates, isTailscaleManifestCandidate } from '../lib/app-update-relay-manifest';

interface SettingsPageProps {
  settings: BridgeSettings;
  relayDevices?: TraversalRelayDeviceSnapshot[];
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
  onCheckForUpdate: (
    next: AppUpdatePreferences,
    manifestCandidates: AppUpdateManifestCandidate[],
  ) => void;
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

function ToggleGlyph({ checked }: { checked: boolean }) {
  return (
    <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
      {checked ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}

function SettingsGroup({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className="zterm-settings-group"
      data-testid="settings-group"
      data-state={open ? 'open' : 'closed'}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{title}</span>
        <svg aria-hidden="true" className="zterm-settings-chevron" fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </summary>
      <div data-settings-group-content>{children}</div>
    </details>
  );
}

export function SettingsPage({
  settings,
  relayDevices = [],
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
  const [remoteWindowVideoPreference, setRemoteWindowVideoPreference] = useState<RemoteWindowVideoPreference>(() => (
    readRemoteWindowVideoPreferenceGlobalDefault() || 'smooth'
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
  const updateDraftEditedRef = useRef(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveResetTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveState !== 'saved') {
      return;
    }
    saveResetTimerRef.current = window.setTimeout(() => setSaveState('idle'), 3000);
    return () => {
      if (saveResetTimerRef.current !== null) {
        window.clearTimeout(saveResetTimerRef.current);
        saveResetTimerRef.current = null;
      }
    };
  }, [saveState]);
  const defaultServer = useMemo(() => getDefaultBridgeServer(draft), [draft]);
  const manifestCandidates = useMemo(() => buildAppUpdateManifestCandidates(draft), [draft]);
  useEffect(() => {
    setUpdateDraft((current) => {
      if (updateDraftEditedRef.current) {
        return current;
      }
      if (
        current.manifestUrl.trim()
        && current.manifestSource === 'user-saved'
      ) {
        return current;
      }
      const tailscaleManifest = manifestCandidates.find(isTailscaleManifestCandidate);
      const relayManifest = manifestCandidates.find((candidate) => candidate.manifestSource === 'relay-injected');
      const preferredManifest = tailscaleManifest || relayManifest;
      return preferredManifest
        ? {
            ...updatePreferences,
            manifestUrl: preferredManifest.manifestUrl,
            manifestSource: preferredManifest.manifestSource,
          }
        : updatePreferences;
    });
  }, [manifestCandidates, updatePreferences]);

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

  const handleSave = () => {
    setSaveState('saving');
    onSave(draft);
    onUpdatePreferencesChange(updateDraft);
    setSaveState('saved');
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
          padding: `${mobileTheme.safeArea.top} ${settingsViewportPadding} 18px`,
          backgroundColor: 'rgba(237, 242, 246, 0.94)',
          backdropFilter: 'blur(14px)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderBottom: `1px solid ${mobileTheme.colors.lightBorder}`,
        }}
      >
        <button
          type="button"
          aria-label="Back to connections"
          title="Back"
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
        <span
          data-settings-save-status
          data-state={saveState}
          role="status"
          aria-live="polite"
          style={{ fontSize: '13px', minWidth: 0, marginRight: '6px' }}
        >
          {saveState === 'saved' ? 'Saved' : ''}
        </span>
        <button
          type="button"
          aria-label="Save"
          title="Save settings"
          onClick={handleSave}
          disabled={saveState === 'saving'}
          style={{
            minWidth: 'clamp(84px, 22vw, 112px)',
            height: '56px',
            borderRadius: '20px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shell,
            color: '#ffffff',
            fontWeight: 800,
            boxShadow: mobileTheme.shadow.soft,
            cursor: 'pointer',
            opacity: saveState === 'saving' ? 0.72 : 1,
          }}
        >
          {saveState === 'saved' ? 'Saved' : 'Save'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: `${settingsViewportPadding} ${settingsViewportPadding} 32px`, width: '100%', boxSizing: 'border-box', minWidth: 0 }}>
        <SettingsGroup title="连接与升级" defaultOpen>
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
            manifestCandidates,
            onUpdateDraftChange: (updater) => {
              updateDraftEditedRef.current = true;
              setUpdateDraft((current) => updater(current));
            },
            onCheckForUpdate: () => onCheckForUpdate(updateDraft, manifestCandidates),
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

          <ConnectionConfigSection
            settings={draft}
            relayDevices={relayDevices}
            onSettingsChange={(updater) => setDraft((current) => updater(current))}
            onRemoveDefaultServer={() =>
              setDraft((current) => removeBridgeServer(current, defaultServer?.id || current.defaultServerId || ''))
            }
            onRelaySettingsChange={handleRelaySettingsChange}
          />
        </SettingsGroup>

        <SettingsGroup title="终端" defaultOpen>

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
        </SettingsGroup>

        <SettingsGroup title="诊断与输入">

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
            <ToggleGlyph checked={runtimeDebugEnabled} />
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
            <ToggleGlyph checked={draft.shortcutSmartSort} />
            智能排序 {draft.shortcutSmartSort ? '已开启' : '已关闭'}
          </button>
        </div>
        </SettingsGroup>

        <SettingsGroup title="远程窗口">

        <div style={settingsSectionStyle()}>
          <SettingsSectionTitle>远程窗口</SettingsSectionTitle>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            串流画质与触控滚动偏好，作用于后续远程窗口会话。
          </div>
          <div style={{ marginTop: '12px', marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>默认串流偏好</div>
          <select
            value={remoteWindowVideoPreference}
            onChange={(event) => {
              const next = event.currentTarget.value as RemoteWindowVideoPreference;
              setRemoteWindowVideoPreference(next);
              writeRemoteWindowVideoPreferenceGlobalDefault(next);
            }}
            style={settingsInputStyle()}
          >
            {REMOTE_WINDOW_VIDEO_PREFERENCES.map((preference) => (
              <option key={preference} value={preference}>
                {preference === 'smooth' ? '流畅优先' : '清晰优先'}
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
        </SettingsGroup>

        <SettingsGroup title="外观">

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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(118px, 100%), 1fr))', gap: '10px' }}>
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
        </SettingsGroup>

      </div>
    </div>
  );
}
