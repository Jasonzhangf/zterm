import { useMemo, useState } from 'react';
import {
  buildDaemonStartCommand,
  getDefaultBridgeServer,
  removeBridgeServer,
  setDefaultBridgeServer,
  sortBridgeServers,
  type BridgeSettings,
} from '../lib/bridge-settings';
import { APP_BASE_VERSION, APP_BUILD_NUMBER, APP_PACKAGE_NAME, APP_VERSION } from '../lib/app-version';
import { WTERM_CONFIG_DISPLAY_PATH } from '../lib/mobile-config';
import { mobileTheme } from '../lib/mobile-ui';
import { formatTargetBadge } from '../lib/network-target';

interface SettingsPageProps {
  settings: BridgeSettings;
  onSave: (settings: BridgeSettings) => void;
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

export function SettingsPage({ settings, onSave, onBack }: SettingsPageProps) {
  const [draft, setDraft] = useState({ ...settings, servers: sortBridgeServers(settings.servers) });
  const daemonCommand = useMemo(() => buildDaemonStartCommand(draft), [draft]);
  const defaultServer = useMemo(() => getDefaultBridgeServer(draft), [draft]);

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
          onClick={() => onSave(draft)}
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
            </div>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: mobileTheme.colors.lightMuted }}>Package</div>
              <div style={{ fontSize: '14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{APP_PACKAGE_NAME}</div>
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
