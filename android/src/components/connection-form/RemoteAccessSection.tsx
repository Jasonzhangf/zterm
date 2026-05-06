import { ConnectionSection, FieldLabel, inputStyle, segmentedButtonStyle } from './ConnectionSection';

interface RemoteAccessSectionProps {
  transportMode: 'auto' | 'websocket' | 'webrtc';
  onTransportModeChange: (value: 'auto' | 'websocket' | 'webrtc') => void;
  relayBound: boolean;
  tailscaleHost: string;
  onTailscaleHostChange: (value: string) => void;
  ipv6Host: string;
  onIpv6HostChange: (value: string) => void;
  ipv4Host: string;
  onIpv4HostChange: (value: string) => void;
}

export function RemoteAccessSection({
  transportMode,
  onTransportModeChange,
  relayBound,
  tailscaleHost,
  onTailscaleHostChange,
  ipv6Host,
  onIpv6HostChange,
  ipv4Host,
  onIpv4HostChange,
}: RemoteAccessSectionProps) {
  return (
    <ConnectionSection
      title="Remote Access"
      description="自动连接顺序固定为 Tailscale → IPv6 → IPv4 → Relay；若已登录 relay，则协议信息自动从控制面下发，对用户透明。"
    >
      <div style={{ display: 'flex', gap: '10px' }}>
        <button type="button" onClick={() => onTransportModeChange('auto')} style={segmentedButtonStyle(transportMode === 'auto')}>
          Auto
        </button>
        <button
          type="button"
          onClick={() => onTransportModeChange('websocket')}
          style={segmentedButtonStyle(transportMode === 'websocket')}
        >
          WS Only
        </button>
        <button
          type="button"
          onClick={() => onTransportModeChange('webrtc')}
          style={segmentedButtonStyle(transportMode === 'webrtc')}
        >
          RTC First
        </button>
      </div>

      <div>
        <FieldLabel>Tailscale Host</FieldLabel>
        <input
          value={tailscaleHost}
          onChange={(event) => onTailscaleHostChange(event.target.value)}
          placeholder="your-host.ts.net 或 100.x.y.z"
          style={inputStyle()}
        />
      </div>

      <div>
        <FieldLabel>IPv6 Host</FieldLabel>
        <input
          value={ipv6Host}
          onChange={(event) => onIpv6HostChange(event.target.value)}
          placeholder="240e:xxxx::1"
          style={inputStyle()}
        />
      </div>

      <div>
        <FieldLabel>IPv4 Host</FieldLabel>
        <input
          value={ipv4Host}
          onChange={(event) => onIpv4HostChange(event.target.value)}
          placeholder="1.2.3.4"
          style={inputStyle()}
        />
      </div>

      <div style={{ marginTop: '-2px', fontSize: '12px', color: '#6b7688', lineHeight: 1.5 }}>
        {relayBound
          ? '当前已启用 relay 控制面；signal / TURN / ws 地址自动注入。具体连接哪个 daemon，请在下方 Relay Daemon 区域点选设备。'
          : '当前未登录 relay；仅使用直连路径。若要使用 TURN 穿透，请先在设置中登录 relay。'}
      </div>
    </ConnectionSection>
  );
}
