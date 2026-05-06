import { mobileTheme } from '../../lib/mobile-ui';
import type { TraversalRelayDeviceSnapshot } from '../../lib/types';
import { ConnectionSection } from './ConnectionSection';

interface RelayDevicePickerProps {
  relayEnabled: boolean;
  devices: TraversalRelayDeviceSnapshot[];
  selectedRelayHostId: string;
  selectedRelayDeviceId: string;
  onSelect: (device: TraversalRelayDeviceSnapshot) => void;
  onClear: () => void;
}

export function RelayDevicePicker({
  relayEnabled,
  devices,
  selectedRelayHostId,
  selectedRelayDeviceId,
  onSelect,
  onClear,
}: RelayDevicePickerProps) {
  const selectedDevice = devices.find((device) => {
    const sameDevice = selectedRelayDeviceId.trim() && device.deviceId === selectedRelayDeviceId.trim();
    const sameHost = selectedRelayHostId.trim() && device.daemon.hostId === selectedRelayHostId.trim();
    return sameDevice || sameHost;
  });

  return (
    <ConnectionSection
      title="Relay Daemon"
      description={
        relayEnabled
          ? '已登录 relay 后，这里直接选择当前用户名下在线的 daemon 设备。用户不需要手填 ws/turn/signal，也不需要记 hostId。'
          : '当前未登录 relay。先去 Settings 登录 relay，随后这里会出现当前账号下在线 daemon 设备。'
      }
    >
      {selectedDevice ? (
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
          <div style={{ fontSize: '14px', fontWeight: 800, color: mobileTheme.colors.lightText }}>
            当前绑定：{selectedDevice.deviceName || selectedDevice.deviceId}
          </div>
          <div>deviceId: {selectedDevice.deviceId}</div>
          <div>hostId: {selectedDevice.daemon.hostId}</div>
          <div>daemon version: {selectedDevice.daemon.version || '-'}</div>
          <button
            type="button"
            onClick={onClear}
            style={{
              marginTop: '6px',
              minHeight: '40px',
              padding: '0 14px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: '#eef2f8',
              color: mobileTheme.colors.lightText,
              fontWeight: 700,
              cursor: 'pointer',
              justifySelf: 'start',
            }}
          >
            清空绑定
          </button>
        </div>
      ) : null}

      {devices.length === 0 ? (
        <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.6 }}>
          {relayEnabled ? '当前账号下还没有在线 daemon 设备。' : '未登录 relay，因此这里不显示 daemon 列表。'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {devices.map((device) => {
            const active = device.deviceId === selectedRelayDeviceId || device.daemon.hostId === selectedRelayHostId;
            return (
              <button
                key={`${device.deviceId}:${device.daemon.hostId}`}
                type="button"
                onClick={() => onSelect(device)}
                style={{
                  border: active
                    ? `2px solid ${mobileTheme.colors.accent}`
                    : `1px solid ${mobileTheme.colors.lightBorder}`,
                  borderRadius: '18px',
                  backgroundColor: '#ffffff',
                  padding: '14px 16px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  boxShadow: active ? '0 12px 26px rgba(31,214,122,0.14)' : mobileTheme.shadow.soft,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>
                    {device.deviceName || device.deviceId}
                  </div>
                  <div style={{ fontSize: '11px', color: mobileTheme.colors.accent, fontWeight: 800 }}>
                    {active ? '已选中' : '在线'}
                  </div>
                </div>
                <div style={{ marginTop: '6px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                  deviceId: {device.deviceId}
                </div>
                <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                  hostId: {device.daemon.hostId}
                </div>
                <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                  platform: {device.platform || '-'} · daemon version: {device.daemon.version || '-'}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </ConnectionSection>
  );
}
