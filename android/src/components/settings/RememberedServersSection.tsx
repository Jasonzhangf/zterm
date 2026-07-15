import { useState } from 'react';
import {
  setDefaultBridgeServer,
  upsertBridgeServer,
  type BridgeSettings,
} from '../../lib/bridge-settings';
import { buildBridgeServerPresetViews } from '../../lib/bridge-server-presets-view';
import { mobileTheme } from '../../lib/mobile-ui';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

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
  const [draft, setDraft] = useState({
    name: '',
    targetHost: '',
    targetPort: '3333',
    authToken: '',
    relayHostId: '',
  });

  const canAddServer = draft.targetHost.trim().length > 0;
  const handleAddServer = () => {
    const targetHost = draft.targetHost.trim();
    if (!targetHost) {
      return;
    }
    const targetPort = Number.parseInt(draft.targetPort, 10) || 3333;
    onSettingsChange((current) => upsertBridgeServer(current, {
      name: draft.name,
      targetHost,
      targetPort,
      authToken: draft.authToken,
      relayHostId: draft.relayHostId,
    }));
    setDraft({
      name: '',
      targetHost: '',
      targetPort: '3333',
      authToken: '',
      relayHostId: '',
    });
  };

  return (
    <div style={settingsSectionStyle()}>
      <SettingsSectionTitle>Remembered Bridge Entry Points</SettingsSectionTitle>

      <div style={{ display: 'grid', gap: '10px' }}>
        <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
          Server Name
          <input
            aria-label="Server name"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Mac Studio"
            style={settingsInputStyle()}
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px', gap: '10px' }}>
          <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
            Host
            <input
              aria-label="Server host"
              value={draft.targetHost}
              onChange={(event) => setDraft((current) => ({ ...current, targetHost: event.target.value }))}
              placeholder="100.66.1.82"
              style={settingsInputStyle()}
            />
          </label>
          <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
            Port
            <input
              aria-label="Server port"
              inputMode="numeric"
              value={draft.targetPort}
              onChange={(event) => setDraft((current) => ({ ...current, targetPort: event.target.value }))}
              style={settingsInputStyle()}
            />
          </label>
        </div>
        <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
          Auth Token
          <input
            aria-label="Server auth token"
            value={draft.authToken}
            onChange={(event) => setDraft((current) => ({ ...current, authToken: event.target.value }))}
            placeholder="wterm-..."
            style={settingsInputStyle()}
          />
        </label>
        <label style={{ display: 'grid', gap: '7px', fontSize: '13px', fontWeight: 700 }}>
          Daemon ID
          <input
            aria-label="Daemon ID"
            value={draft.relayHostId}
            onChange={(event) => setDraft((current) => ({ ...current, relayHostId: event.target.value }))}
            placeholder="mac-studio"
            style={settingsInputStyle()}
          />
        </label>
        <button
          type="button"
          onClick={handleAddServer}
          disabled={!canAddServer}
          style={{
            minHeight: '48px',
            borderRadius: '16px',
            border: 'none',
            backgroundColor: canAddServer ? mobileTheme.colors.shell : '#d9e1ea',
            color: canAddServer ? '#ffffff' : mobileTheme.colors.lightMuted,
            fontWeight: 800,
            cursor: canAddServer ? 'pointer' : 'not-allowed',
          }}
        >
          Add Server
        </button>
      </div>

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
