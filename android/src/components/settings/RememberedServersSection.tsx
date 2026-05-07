import {
  setDefaultBridgeServer,
  type BridgeSettings,
} from '../../lib/bridge-settings';
import { buildBridgeServerPresetViews } from '../../lib/bridge-server-presets-view';
import { mobileTheme } from '../../lib/mobile-ui';
import { SettingsSectionTitle, settingsSectionStyle } from './SettingsSection';

interface RememberedServersSectionProps {
  settings: BridgeSettings;
  onSettingsChange: (updater: (current: BridgeSettings) => BridgeSettings) => void;
  onRemoveDefaultServer: () => void;
}

export function RememberedServersSection({
  settings,
  onSettingsChange,
  onRemoveDefaultServer,
}: RememberedServersSectionProps) {
  const serverViews = buildBridgeServerPresetViews(settings.servers);
  return (
    <div style={settingsSectionStyle()}>
      <SettingsSectionTitle>Remembered Bridge Entry Points</SettingsSectionTitle>

      {serverViews.length === 0 ? (
        <div style={{ color: mobileTheme.colors.lightMuted }}>No remembered server yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {serverViews.map(({ server, daemonHostId, bridgeLabel, daemonLabel, targetBadge, authLabel }) => {
            const active = server.id === settings.defaultServerId;
            return (
              <button
                key={server.id}
                onClick={() => onSettingsChange((current) => setDefaultBridgeServer(current, server.id))}
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
                    {bridgeLabel}
                  </div>
                  {daemonHostId ? (
                    <div style={{ marginTop: '4px', fontSize: '11px', opacity: 0.78 }}>
                      {daemonLabel}
                    </div>
                  ) : null}
                  <div style={{ marginTop: '4px', fontSize: '11px', opacity: 0.78 }}>
                    {targetBadge} · {authLabel}
                  </div>
                </div>
                <span style={{ fontSize: '12px', opacity: 0.8 }}>{active ? 'Default' : 'Use'}</span>
              </button>
            );
          })}
        </div>
      )}

      {serverViews.length > 0 ? (
        <button
          onClick={onRemoveDefaultServer}
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
          Remove Default Entry Point
        </button>
      ) : null}
    </div>
  );
}
