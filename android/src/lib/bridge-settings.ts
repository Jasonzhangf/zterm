import {
  DEFAULT_BRIDGE_SETTINGS,
  buildDaemonStartCommand,
  buildServerPresetId,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
  type BridgeServerPreset,
  type BridgeSettings,
} from '@zterm/shared';

export {
  DEFAULT_BRIDGE_SETTINGS,
  buildDaemonStartCommand,
  buildServerPresetId,
  formatBridgeTarget,
  getDefaultBridgeServer,
  normalizeBridgeSettings,
  setDefaultBridgeServer,
  sortBridgeServers,
  upsertBridgeServer,
};
export type { BridgeServerPreset, BridgeSettings };

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
