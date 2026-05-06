import { mobileTheme } from '../../lib/mobile-ui';
import type { TraversalRelayClientSettings } from '../../lib/bridge-settings';
import type { TraversalRelayDeviceSnapshot } from '../../lib/types';
import { countConnectedTraversalRelayDevices } from '../../lib/traversal-relay-devices';
import { SettingsSectionTitle, settingsInputStyle, settingsSectionStyle } from './SettingsSection';

interface RelayControlSectionProps {
  transportMode: 'auto' | 'websocket' | 'webrtc';
  onTransportModeChange: (mode: 'auto' | 'websocket' | 'webrtc') => void;
  relayBaseUrl: string;
  onRelayBaseUrlChange: (value: string) => void;
  relayUsername: string;
  onRelayUsernameChange: (value: string) => void;
  relayPassword: string;
  onRelayPasswordChange: (value: string) => void;
  relayBusy: 'login' | 'register' | 'refresh' | null;
  relayStatus: string;
  relaySettings?: TraversalRelayClientSettings;
  relayDevices: TraversalRelayDeviceSnapshot[];
  onRegister: () => void;
  onLogin: () => void;
  onRefresh: () => void;
}

export function RelayControlSection({
  transportMode,
  onTransportModeChange,
  relayBaseUrl,
  onRelayBaseUrlChange,
  relayUsername,
  onRelayUsernameChange,
  relayPassword,
  onRelayPasswordChange,
  relayBusy,
  relayStatus,
  relaySettings,
  relayDevices,
  onRegister,
  onLogin,
  onRefresh,
}: RelayControlSectionProps) {
  const connectedRelayDevices = countConnectedTraversalRelayDevices(relayDevices);

  return (
    <div style={settingsSectionStyle()}>
      <SettingsSectionTitle>Remote Access</SettingsSectionTitle>
      <div style={{ fontSize: '13px', lineHeight: 1.6, color: mobileTheme.colors.lightMuted }}>
        连接顺序固定为 Tailscale → IPv6 → IPv4 → Relay。Transport Mode 由你选择；signal / TURN / ws 细节由 relay 控制面自动下发，对用户透明。
      </div>

      <div>
        <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Transport Mode</div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {(['auto', 'websocket', 'webrtc'] as const).map((mode) => {
            const active = transportMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onTransportModeChange(mode)}
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
                {mode === 'auto' ? 'Auto' : mode === 'websocket' ? 'WS Only' : 'RTC First'}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>Relay Base URL</div>
        <input
          type="url"
          value={relayBaseUrl}
          onChange={(event) => onRelayBaseUrlChange(event.target.value)}
          placeholder="https://coder2.codewhisper.cc"
          style={settingsInputStyle()}
        />
        <div style={{ marginTop: '6px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
          只填基础地址即可，客户端会自动补齐 relay 路径。
        </div>
      </div>

      <div>
        <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>用户名</div>
        <input
          type="text"
          value={relayUsername}
          onChange={(event) => onRelayUsernameChange(event.target.value)}
          placeholder="同一个账号下设备会实时汇总"
          style={settingsInputStyle()}
        />
      </div>

      <div>
        <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 700 }}>密码</div>
        <input
          type="password"
          value={relayPassword}
          onChange={(event) => onRelayPasswordChange(event.target.value)}
          placeholder="登录控制面"
          style={settingsInputStyle()}
        />
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onRegister}
          disabled={relayBusy !== null}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: '#eef2f8',
            color: mobileTheme.colors.lightText,
            fontWeight: 800,
            cursor: relayBusy ? 'wait' : 'pointer',
            opacity: relayBusy ? 0.7 : 1,
          }}
        >
          注册
        </button>
        <button
          type="button"
          onClick={onLogin}
          disabled={relayBusy !== null}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: mobileTheme.colors.shell,
            color: '#fff',
            fontWeight: 800,
            cursor: relayBusy ? 'wait' : 'pointer',
            opacity: relayBusy ? 0.7 : 1,
          }}
        >
          登录并同步控制面
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={relayBusy !== null || !relaySettings?.accessToken}
          style={{
            minHeight: '44px',
            padding: '0 16px',
            borderRadius: '14px',
            border: 'none',
            backgroundColor: 'rgba(31,214,122,0.18)',
            color: mobileTheme.colors.accent,
            fontWeight: 800,
            cursor: relayBusy ? 'wait' : 'pointer',
            opacity: relayBusy || !relaySettings?.accessToken ? 0.6 : 1,
          }}
        >
          刷新设备列表
        </button>
      </div>

      <div
        style={{
          fontSize: '13px',
          lineHeight: 1.6,
          color: relayStatus.includes('已登录') ? mobileTheme.colors.accent : mobileTheme.colors.lightMuted,
        }}
      >
        {relayStatus || '未登录 relay。登录后客户端会自动获取 ws/client、ws/host、TURN 凭证，并实时看到当前用户名下的设备列表。'}
      </div>

      {relaySettings ? (
        <div
          style={{
            borderRadius: '18px',
            backgroundColor: '#f6f8fb',
            padding: '14px 16px',
            display: 'grid',
            gap: '6px',
            fontSize: '12px',
            color: mobileTheme.colors.lightMuted,
          }}
        >
          <div>当前账号：{relaySettings.username || relayUsername || '-'}</div>
          <div>设备 ID：{relaySettings.deviceId}</div>
          <div>设备名：{relaySettings.deviceName}</div>
          <div>TURN：{relaySettings.turnUrl || '未下发'}</div>
          <div>WS client：{relaySettings.wsClientUrl}</div>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700 }}>
          我的设备列表 {connectedRelayDevices > 0 ? `(${connectedRelayDevices} 在线)` : ''}
        </div>
        {relayDevices.length === 0 ? (
          <div style={{ color: mobileTheme.colors.lightMuted, fontSize: '13px' }}>
            登录后会实时显示当前用户名下的 client / daemon 设备状态。
          </div>
        ) : relayDevices.map((device) => (
          <div
            key={device.deviceId}
            style={{
              borderRadius: '18px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              backgroundColor: '#ffffff',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
              <div style={{ fontSize: '15px', fontWeight: 800 }}>{device.deviceName || device.deviceId}</div>
              <div
                style={{
                  fontSize: '11px',
                  color: device.daemon.connected ? mobileTheme.colors.accent : mobileTheme.colors.lightMuted,
                  fontWeight: 800,
                }}
              >
                {device.daemon.connected ? 'DAEMON ONLINE' : device.client.connected ? 'CLIENT ONLINE' : 'OFFLINE'}
              </div>
            </div>
            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>deviceId: {device.deviceId}</div>
            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
              platform: {device.platform || '-'} · app: {device.appVersion || '-'}
            </div>
            <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
              daemonHostId: {device.daemon.hostId || '-'} · version: {device.daemon.version || '-'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
