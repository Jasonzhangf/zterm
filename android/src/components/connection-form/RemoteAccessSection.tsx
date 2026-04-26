import type { BridgeSettings } from '../../lib/bridge-settings';
import { ConnectionSection, FieldLabel, inputStyle, segmentedButtonStyle } from './ConnectionSection';

interface RemoteAccessSectionProps {
  transportMode: 'auto' | 'websocket' | 'webrtc';
  onTransportModeChange: (value: 'auto' | 'websocket' | 'webrtc') => void;
  tailscaleHost: string;
  onTailscaleHostChange: (value: string) => void;
  ipv6Host: string;
  onIpv6HostChange: (value: string) => void;
  ipv4Host: string;
  onIpv4HostChange: (value: string) => void;
  signalUrl: string;
  onSignalUrlChange: (value: string) => void;
  defaults: Pick<BridgeSettings, 'signalUrl'>;
}

export function RemoteAccessSection({
  transportMode,
  onTransportModeChange,
  tailscaleHost,
  onTailscaleHostChange,
  ipv6Host,
  onIpv6HostChange,
  ipv4Host,
  onIpv4HostChange,
  signalUrl,
  onSignalUrlChange,
  defaults,
}: RemoteAccessSectionProps) {
  return (
    <ConnectionSection
      title="Remote Access"
      description="直连优先顺序固定为 Tailscale → IPv6 → IPv4；TURN / signaling 只在最后 RTC 链路使用。"
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

      <div>
        <FieldLabel>Signal URL Override</FieldLabel>
        <input
          value={signalUrl}
          onChange={(event) => onSignalUrlChange(event.target.value)}
          placeholder={defaults.signalUrl || 'wss://signal.example.com/signal'}
          style={inputStyle()}
        />
      </div>
    </ConnectionSection>
  );
}
