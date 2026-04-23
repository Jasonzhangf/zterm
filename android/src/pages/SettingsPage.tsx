import { useEffect, useMemo, useState } from 'react';
import { TERMINAL_THEME_OPTIONS, getTerminalThemePreset } from '@zterm/shared';
import {
  getDefaultBridgeServer,
  removeBridgeServer,
  setDefaultBridgeServer,
  sortBridgeServers,
  type BridgeSettings,
} from '../lib/bridge-settings';
import { type AppUpdateManifest, type AppUpdatePreferences } from '../lib/app-update';
import { APP_VERSION_CODE } from '../lib/app-version';
import { mobileTheme } from '../lib/mobile-ui';
import { formatTargetBadge } from '../lib/network-target';

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

function inputStyle() {
  return {
    width: '100%',
    minHeight: '56px',
    borderRadius: '20px',
    border: `1px solid ${mobileTheme.colors.lightBorder}`,
    backgroundColor: '#ffffff',
    color: mobileTheme.colors.lightText,
    fontSize: '18px',
    padding: '0 18px',
  } as const;
}

function sectionStyle() {
  return {
    borderRadius: '28px',
    padding: '24px',
    backgroundColor: '#ffffff',
    boxShadow: mobileTheme.shadow.soft,
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  } as const;
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
  } catch {
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
  const selectedTerminalTheme = useMemo(
    () => getTerminalThemePreset(draft.terminalThemeId),
    [draft.terminalThemeId],
  );

  useEffect(() => {
    setUpdateDraft(updatePreferences);
  }, [updatePreferences]);

  useEffect(() => {
    setDraft({ ...settings, servers: sortBridgeServers(settings.servers) });
  }, [settings]);

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
        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>App Update</div>

          <div>
            <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Manifest URL</div>
            <input
              type="url"
              value={updateDraft.manifestUrl}
              onChange={(event) =>
                setUpdateDraft((current) => ({
                  ...current,
                  manifestUrl: event.target.value,
                }))
              }
              placeholder="https://server.example.com/zterm/android/stable/latest.json"
              style={inputStyle()}
            />
            {suggestedManifestUrl ? (
              <div style={{ marginTop: '10px' }}>
                <button
                  onClick={() =>
                    setUpdateDraft((current) => ({
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
                setUpdateDraft((current) => ({
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
              onClick={() => onCheckForUpdate(updateDraft)}
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

        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>Terminal Cache</div>
          <div>
            <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Terminal Cache Lines</div>
            <input
              type="number"
              value={draft.terminalCacheLines}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  terminalCacheLines: Math.max(200, Number.parseInt(event.target.value, 10) || current.terminalCacheLines),
                }))
              }
              style={inputStyle()}
            />
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>Terminal Theme</div>
          <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
            这里会改终端 ANSI 16 色映射和默认前景/背景色。当前：{selectedTerminalTheme.name}。点主题卡会即时生效并持久化。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
            {TERMINAL_THEME_OPTIONS.map((theme) => {
              const active = draft.terminalThemeId === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => {
                    setDraft((current) => ({ ...current, terminalThemeId: theme.id }));
                    onTerminalThemeChange?.(theme.id);
                  }}
                  style={{
                    borderRadius: '20px',
                    border: active ? `2px solid ${mobileTheme.colors.accent}` : `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: '#ffffff',
                    color: mobileTheme.colors.lightText,
                    padding: '14px',
                    cursor: 'pointer',
                    boxShadow: active ? '0 12px 26px rgba(31,214,122,0.14)' : mobileTheme.shadow.soft,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 800 }}>{theme.name}</div>
                      <div style={{ marginTop: '4px', fontSize: '11px', color: mobileTheme.colors.lightMuted }}>{theme.family}</div>
                    </div>
                    <div style={{ fontSize: '11px', color: active ? mobileTheme.colors.accent : mobileTheme.colors.lightMuted, fontWeight: 800 }}>
                      {active ? 'ACTIVE' : 'USE'}
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: '12px',
                      borderRadius: '14px',
                      overflow: 'hidden',
                      border: `1px solid ${mobileTheme.colors.lightBorder}`,
                      backgroundColor: theme.background,
                    }}
                  >
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))' }}>
                      {theme.colors.map((color, index) => (
                        <div
                          key={`${theme.id}-${index}`}
                          style={{
                            height: '16px',
                            backgroundColor: color,
                          }}
                        />
                      ))}
                    </div>
                    <div
                      style={{
                        padding: '10px 12px',
                        fontSize: '12px',
                        lineHeight: 1.5,
                        color: theme.foreground,
                        backgroundColor: theme.background,
                      }}
                    >
                      <span style={{ color: theme.colors[2] }}>ls</span>
                      <span> </span>
                      <span style={{ color: theme.colors[4] }}>~/workspace</span>
                      <span style={{ color: theme.colors[3] }}> $</span>
                    </div>
                  </div>

                  <div style={{ marginTop: '10px', fontSize: '12px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
                    {theme.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>Remembered Servers</div>

          {draft.servers.length === 0 ? (
            <div style={{ color: mobileTheme.colors.lightMuted }}>No remembered server yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {sortBridgeServers(draft.servers).map((server) => {
                const active = server.id === draft.defaultServerId;
                return (
                  <button
                    key={server.id}
                    onClick={() => setDraft((current) => setDefaultBridgeServer(current, server.id))}
                    style={{
                      border: 'none',
                      borderRadius: '20px',
                      padding: '14px 16px',
                      textAlign: 'left',
                      backgroundColor: active ? mobileTheme.colors.shell : '#ffffff',
                      color: active ? '#ffffff' : mobileTheme.colors.lightText,
                      boxShadow: mobileTheme.shadow.soft,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '12px',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800 }}>{server.name}</div>
                      <div style={{ fontSize: '13px', opacity: 0.8 }}>
                        {server.targetHost}:{server.targetPort}
                      </div>
                      <div style={{ marginTop: '4px', fontSize: '11px', opacity: 0.78 }}>
                        {formatTargetBadge(server.targetHost)} · {server.authToken ? 'Auth on' : 'No token'}
                      </div>
                    </div>
                    <span style={{ fontSize: '12px', opacity: 0.8 }}>{active ? 'Default' : 'Use'}</span>
                  </button>
                );
              })}
            </div>
          )}

          {draft.servers.length > 0 ? (
            <button
              onClick={() => setDraft((current) => removeBridgeServer(current, defaultServer?.id || current.defaultServerId || ''))}
              style={{
                height: '52px',
                borderRadius: '18px',
                border: 'none',
                backgroundColor: 'rgba(255,124,146,0.16)',
                color: mobileTheme.colors.danger,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              Remove Default Server
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
