import {
  describeBridgePresetIdentity,
  resolveBridgePresetDaemonHostId,
  sortBridgeServers,
  type BridgeServerPreset,
} from './bridge-settings';
import { formatTargetBadge } from './network-target';

export interface BridgeServerPresetView {
  server: BridgeServerPreset;
  daemonHostId: string;
  bridgeLabel: string;
  daemonLabel: string;
  targetBadge: string;
  authLabel: string;
}

export function buildBridgeServerPresetViews(servers: BridgeServerPreset[]): BridgeServerPresetView[] {
  return sortBridgeServers(servers).map((server) => {
    const daemonHostId = resolveBridgePresetDaemonHostId(server);
    const identity = describeBridgePresetIdentity(server);
    return {
      server,
      daemonHostId,
      bridgeLabel: identity.bridgeLabel,
      daemonLabel: identity.daemonLabel,
      targetBadge: formatTargetBadge(server.targetHost),
      authLabel: server.authToken ? 'Auth on' : 'No token',
    };
  });
}
