import { useEffect, useMemo, useState } from 'react';
import {
  buildDaemonStartCommand,
  getDefaultBridgeServer,
  removeBridgeServer,
  setDefaultBridgeServer,
  sortBridgeServers,
  type BridgeSettings,
} from '../lib/bridge-settings';
import { type AppUpdateManifest, type AppUpdatePreferences } from '../lib/app-update';
import { APP_BASE_VERSION, APP_BUILD_NUMBER, APP_PACKAGE_NAME, APP_VERSION, APP_VERSION_CODE } from '../lib/app-version';
import { WTERM_CONFIG_DISPLAY_PATH } from '../lib/mobile-config';
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
  onBack,
}: SettingsPageProps) {
  const [draft, setDraft] = useState({ ...settings, servers: sortBridgeServers(settings.servers) });
  const [updateDraft, setUpdateDraft] = useState(updatePreferences);
  const daemonCommand = useMemo(() => buildDaemonStartCommand(draft), [draft]);
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
          <div style={{ marginTop: '4px', fontSize: '13px', color: mobileTheme.colors.lightMuted }}>
            Global cache + daemon help.
          </div>
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
          <div style={{ fontSize: '24px', fontWeight: 800 }}>About</div>
          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            Use this version number to confirm the phone is running the latest installed build.
          </div>

          <div
            style={{
              borderRadius: '20px',
              padding: '16px',
              backgroundColor: '#f6f8fb',
              color: mobileTheme.colors.lightText,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Version</div>
              <div style={{ fontSize: '24px', fontWeight: 800 }}>{APP_VERSION}</div>
            </div>
            <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Base</div>
                <div style={{ fontSize: '14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{APP_BASE_VERSION}</div>
              </div>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Build</div>
                <div style={{ fontSize: '14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{APP_BUILD_NUMBER}</div>
              </div>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Version Code</div>
                <div style={{ fontSize: '14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{APP_VERSION_CODE}</div>
              </div>
            </div>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Package</div>
              <div style={{ fontSize: '14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{APP_PACKAGE_NAME}</div>
            </div>
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>App Update</div>
          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            服务器只提供 latest.json 与 APK；客户端自己决定是否提醒、下载、校验并调起系统安装。
          </div>

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
              <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
                  推荐直接走当前 daemon：{suggestedManifestUrl}
                </div>
                <button
                  onClick={() =>
                    setUpdateDraft((current) => ({
                      ...current,
                      manifestUrl: suggestedManifestUrl,
                    }))
                  }
                  style={{
                    alignSelf: 'flex-start',
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

          <div
            style={{
              borderRadius: '20px',
              padding: '16px',
              backgroundColor: '#f6f8fb',
              color: mobileTheme.colors.lightText,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Ignore Policy</div>
              <div style={{ fontSize: '14px', lineHeight: 1.6 }}>
                {updatePreferences.ignoreUntilManualCheck
                  ? '当前：一直忽略，直到手动检查'
                  : updatePreferences.skippedVersionCode
                    ? `当前：跳过 versionCode ${updatePreferences.skippedVersionCode}`
                    : '当前：未忽略任何版本'}
              </div>
            </div>
            <button
              onClick={onResetUpdateIgnorePolicy}
              style={{
                alignSelf: 'flex-start',
                minHeight: '42px',
                padding: '0 14px',
                borderRadius: '14px',
                border: 'none',
                backgroundColor: '#eef2f8',
                color: mobileTheme.colors.lightText,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              清除忽略策略
            </button>
          </div>

          <div
            style={{
              borderRadius: '20px',
              padding: '16px',
              backgroundColor: '#f6f8fb',
              color: mobileTheme.colors.lightText,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Remote Version</div>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>
                {latestManifest ? latestManifest.versionName : '未检查'}
              </div>
            </div>
            {latestManifest && (
              <div style={{ fontSize: '13px', lineHeight: 1.6 }}>
                versionCode {latestManifest.versionCode}
                {latestManifest.publishedAt ? ` · ${latestManifest.publishedAt}` : ''}
              </div>
            )}
            {latestManifest?.notes?.length ? (
              <div style={{ fontSize: '13px', lineHeight: 1.6 }}>
                {latestManifest.notes.map((item, index) => (
                  <div key={`${item}-${index}`}>- {item}</div>
                ))}
              </div>
            ) : null}
            {updateError ? (
              <div style={{ color: mobileTheme.colors.danger, fontSize: '13px', lineHeight: 1.5 }}>
                {updateError}
              </div>
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
                disabled={!latestManifest || latestManifest.versionCode <= APP_VERSION_CODE || updateInstalling}
                style={{
                  minHeight: '44px',
                  padding: '0 16px',
                  borderRadius: '14px',
                  border: 'none',
                  backgroundColor: 'rgba(31,214,122,0.18)',
                  color: mobileTheme.colors.accent,
                  fontWeight: 800,
                  cursor: !latestManifest || latestManifest.versionCode <= APP_VERSION_CODE || updateInstalling ? 'not-allowed' : 'pointer',
                  opacity: !latestManifest || latestManifest.versionCode <= APP_VERSION_CODE || updateInstalling ? 0.55 : 1,
                }}
              >
                {updateInstalling ? '准备安装…' : '下载并安装'}
              </button>
            </div>
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>Terminal Cache</div>
          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            Cache lines are global. Per-server IP / port / auth token should only be edited in connection/session picker, not here.
          </div>

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
          <div style={{ fontSize: '24px', fontWeight: 800 }}>Server Daemon</div>
          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            Daemon auth only comes from {WTERM_CONFIG_DISPLAY_PATH}. If that file does not exist, bridge auth is disabled.
          </div>

          <div
            style={{
              borderRadius: '20px',
              padding: '16px',
              backgroundColor: mobileTheme.colors.shell,
              color: '#dce5ff',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '14px',
              lineHeight: 1.6,
              wordBreak: 'break-all',
            }}
          >
            {daemonCommand}
          </div>

          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            Server entry:
            <br />- `pnpm --filter @zterm/android daemon start|status|stop|restart`
            <br />- `scripts/zterm-daemon.sh`
            <br />- `zterm-daemon start|status|stop|restart|install-service`
            <br />- auth token / host / port come from `{WTERM_CONFIG_DISPLAY_PATH}`
            <br />- optional env override: `ZTERM_AUTH_TOKEN=... pnpm --filter @zterm/android daemon start`
          </div>

          <div
            style={{
              borderRadius: '20px',
              padding: '16px',
              backgroundColor: '#f6f8fb',
              color: mobileTheme.colors.lightText,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '13px',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
{`{
  "mobile": {
    "daemon": {
      "host": "0.0.0.0",
      "port": 3333,
      "authToken": "replace-with-your-token",
      "terminalCacheLines": 3000
    }
  }
}`}
          </div>
        </div>

        <div style={sectionStyle()}>
          <div style={{ fontSize: '24px', fontWeight: 800 }}>Remembered Servers</div>
          <div style={{ color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
            These are remembered from connection/session picker. Tap one to set the default target; edit host/port/token in connection/session picker instead of Settings.
          </div>

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
                      <div style={{ fontSize: '13px', opacity: 0.8 }}>{server.targetHost}:{server.targetPort}</div>
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

          {draft.servers.length > 0 && (
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
          )}
        </div>
      </div>
    </div>
  );
}
