import { DEFAULT_BRIDGE_PORT } from '../../lib/mobile-config';
import { ConnectionSection, FieldLabel, inputStyle } from './ConnectionSection';

interface ConnectionSectionFieldsProps {
  bridgeHost: string;
  onBridgeHostChange: (value: string) => void;
  bridgePort: number;
  onBridgePortChange: (value: number) => void;
  authToken: string;
  onAuthTokenChange: (value: string) => void;
}

export function ConnectionSectionFields({
  bridgeHost,
  onBridgeHostChange,
  bridgePort,
  onBridgePortChange,
  authToken,
  onAuthTokenChange,
}: ConnectionSectionFieldsProps) {
  return (
    <ConnectionSection title="Connection" description="Bridge address, Tailscale IP priority, and daemon auth token.">
      <div>
        <FieldLabel>Bridge Host / Tailscale IP *</FieldLabel>
        <input
          value={bridgeHost}
          onChange={(event) => onBridgeHostChange(event.target.value)}
          placeholder="100.127.23.27 或 macstudio.tailnet"
          style={inputStyle()}
        />
      </div>

      <div>
        <FieldLabel>Bridge Port</FieldLabel>
        <input
          type="number"
          value={bridgePort}
          onChange={(event) => onBridgePortChange(Number.parseInt(event.target.value, 10) || DEFAULT_BRIDGE_PORT)}
          style={inputStyle()}
        />
      </div>

      <div>
        <FieldLabel>Bridge Auth Token</FieldLabel>
        <input
          value={authToken}
          onChange={(event) => onAuthTokenChange(event.target.value)}
          placeholder="daemon 的共享 token"
          style={inputStyle()}
        />
      </div>
    </ConnectionSection>
  );
}
