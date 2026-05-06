import {
  buildBridgeServerPresetIdentityId,
  DEFAULT_BRIDGE_SETTINGS,
  buildDaemonStartCommand,
  buildServerPresetId,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
  type BridgeServerPreset,
  type BridgeSettings,
  type TraversalRelayClientSettings,
} from '@zterm/shared';

export {
  DEFAULT_BRIDGE_SETTINGS,
  buildBridgeServerPresetIdentityId,
  buildDaemonStartCommand,
  buildServerPresetId,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  resolveBridgePresetDaemonHostId,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
};
export type { BridgeServerPreset, BridgeSettings, TraversalRelayClientSettings };

export function removeBridgeServer(settings: BridgeSettings, serverId: string): BridgeSettings {
  const servers = sortBridgeServers(settings.servers.filter((server) => server.id !== serverId));
  const nextDefaultServerId = settings.defaultServerId === serverId ? servers[0]?.id : settings.defaultServerId;
  const nextDefault = servers.find((server) => server.id === nextDefaultServerId);

  return {
    ...settings,
    servers,
    defaultServerId: nextDefaultServerId,
    targetHost: nextDefault?.targetHost || '',
    targetPort: nextDefault?.targetPort || DEFAULT_BRIDGE_SETTINGS.targetPort,
    targetAuthToken: nextDefault?.authToken || '',
  };
}
