import { type BridgeServerPreset, type BridgeSettings } from './bridge-settings';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { resolveRelayDeviceBridgeTarget } from './session-picker';
import { isOnlineTraversalRelayDaemonDevice } from './traversal-relay-devices';
import type { Host, TraversalRelayDeviceSnapshot } from './types';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';

export {
  hasRelayDirectoryTruth,
  listRelayDirectoryTruthDevices,
  mergeRelayPresenceWithDirectoryTruth,
} from './relay-device-stream-runtime';

function getHomeConnectionEndpointKey(input: Pick<Host, 'bridgeHost' | 'bridgePort'>) {
  return `${input.bridgeHost.trim()}:${input.bridgePort || DEFAULT_BRIDGE_PORT}`;
}

function getHomeConnectionDaemonKey(input: Pick<Host, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId'>) {
  const daemonHostId = (input.daemonHostId || input.relayHostId || '').trim();
  return daemonHostId ? `${daemonHostId}|${getHomeConnectionEndpointKey(input)}` : '';
}

function getHomeConnectionDaemonOwnerKey(input: Pick<Host, 'daemonHostId' | 'relayHostId'>) {
  return (input.daemonHostId || input.relayHostId || '').trim();
}

function getHomeConnectionIdentityKeys(input: Pick<Host, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId'>) {
  return {
    endpointKey: getHomeConnectionEndpointKey(input),
    daemonKey: getHomeConnectionDaemonKey(input),
    daemonOwnerKey: getHomeConnectionDaemonOwnerKey(input),
  };
}

function shouldReplaceHomeConnection(current: Host, next: Host) {
  const currentIsRelayDirectory = (current.tags || []).includes('relay-directory');
  const nextIsRelayDirectory = (next.tags || []).includes('relay-directory');
  if (currentIsRelayDirectory !== nextIsRelayDirectory) {
    return currentIsRelayDirectory && !nextIsRelayDirectory;
  }
  const currentIsServer = current.sessionName.trim() === '';
  const nextIsServer = next.sessionName.trim() === '';
  if (currentIsServer !== nextIsServer) {
    return nextIsServer;
  }
  if (current.pinned !== next.pinned) {
    return next.pinned;
  }
  return Math.max(next.lastConnected || 0, next.createdAt || 0) > Math.max(current.lastConnected || 0, current.createdAt || 0);
}

function buildRelayEndpointKey(candidate: RelayEndpointCandidate) {
  return [
    candidate.id.trim(),
    candidate.kind,
    candidate.host?.trim() || '',
    candidate.wsUrl?.trim() || '',
    candidate.relayHostId?.trim() || '',
    String(candidate.port || ''),
  ].join('|');
}

export function hasRelayRtcCandidate(input: Pick<Host, 'relayEndpointCandidates'>) {
  return (input.relayEndpointCandidates || []).some((candidate) => (
    candidate.kind === 'relay-rtc'
    && candidate.relayHostId?.trim()
  ));
}

function mergeRelayEndpointCandidates(
  left: RelayEndpointCandidate[] = [],
  right: RelayEndpointCandidate[] = [],
) {
  const merged = new Map<string, RelayEndpointCandidate>();
  for (const candidate of [...left, ...right]) {
    const key = buildRelayEndpointKey(candidate);
    merged.set(key, candidate);
  }
  return [...merged.values()];
}

function mergeHomeConnectionRouteCandidates(base: Host, supplement: Host): Host {
  const routeTruth = (supplement.tags || []).includes('relay-directory')
    ? supplement
    : (base.tags || []).includes('relay-directory')
      ? base
      : null;
  const relayEndpointCandidates = mergeRelayEndpointCandidates(
    base.relayEndpointCandidates || [],
    supplement.relayEndpointCandidates || [],
  );
  const tags = [...new Set([...(base.tags || []), ...(supplement.tags || []).filter((tag) => tag === 'relay-directory')])];
  return {
    ...base,
    daemonHostId: routeTruth?.daemonHostId || routeTruth?.relayHostId || base.daemonHostId || supplement.daemonHostId,
    relayHostId: routeTruth?.relayHostId || routeTruth?.daemonHostId || base.relayHostId || supplement.relayHostId || supplement.daemonHostId,
    relayDeviceId: routeTruth?.relayDeviceId || base.relayDeviceId || supplement.relayDeviceId,
    authToken: routeTruth?.authToken || base.authToken || supplement.authToken,
    tailscaleHost: routeTruth?.tailscaleHost || base.tailscaleHost || supplement.tailscaleHost,
    ipv6Host: routeTruth?.ipv6Host || base.ipv6Host || supplement.ipv6Host,
    ipv4Host: routeTruth?.ipv4Host || base.ipv4Host || supplement.ipv4Host,
    signalUrl: routeTruth?.signalUrl || base.signalUrl || supplement.signalUrl,
    transportMode: routeTruth?.transportMode || base.transportMode || supplement.transportMode,
    relayEndpointCandidates,
    tags,
  };
}

function buildHomeConnectionFromPreset(server: BridgeServerPreset): Host | null {
  const bridgeHost = server.targetHost?.trim() || '';
  if (!bridgeHost) {
    return null;
  }
  const bridgePort = Number.isFinite(server.targetPort) ? server.targetPort : DEFAULT_BRIDGE_PORT;
  const daemonHostId = server.relayHostId?.trim() || '';
  return {
    id: `bridge-preset:${server.id || `${bridgeHost}:${bridgePort}`}`,
    createdAt: 0,
    name: server.name?.trim() || bridgeHost,
    bridgeHost,
    bridgePort,
    daemonHostId,
    relayHostId: daemonHostId,
    relayDeviceId: server.relayDeviceId,
    sessionName: '',
    authToken: server.authToken || '',
    transportMode: 'auto',
    authType: 'password',
    password: undefined,
    privateKey: undefined,
    tags: ['bridge-server'],
    pinned: false,
    lastConnected: undefined,
    autoCommand: '',
  };
}

function buildHomeConnectionFromRelayDevice(
  bridgeSettings: BridgeSettings,
  device: TraversalRelayDeviceSnapshot,
): Host | null {
  if (!isOnlineTraversalRelayDaemonDevice(device)) {
    return null;
  }
  const target = resolveRelayDeviceBridgeTarget(bridgeSettings.servers, device);
  if (!target.bridgeHost.trim() && (target.relayEndpointCandidates || []).length === 0) {
    return null;
  }
  const daemonHostId = target.daemonHostId || target.relayHostId || device.daemon.hostId.trim();
  const name = device.deviceName.trim() || daemonHostId || device.deviceId;
  return {
    id: `relay-device:${device.deviceId}:${daemonHostId || target.bridgeHost}`,
    createdAt: 0,
    name,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    daemonHostId,
    relayHostId: target.relayHostId || daemonHostId,
    relayDeviceId: target.relayDeviceId || device.deviceId,
    sessionName: '',
    authToken: target.authToken || '',
    tailscaleHost: target.tailscaleHost,
    ipv6Host: target.ipv6Host,
    ipv4Host: target.ipv4Host,
    signalUrl: target.signalUrl,
    transportMode: target.transportMode || 'auto',
    relayEndpointCandidates: target.relayEndpointCandidates || [],
    authType: 'password',
    password: undefined,
    privateKey: undefined,
    tags: ['relay-directory'],
    pinned: false,
    lastConnected: Date.parse(device.daemon.lastSeenAt || device.updatedAt || '') || undefined,
    autoCommand: '',
  };
}

export function projectHomeSavedConnections(
  hosts: Host[],
  bridgeSettings: BridgeSettings,
  relayDevices: TraversalRelayDeviceSnapshot[],
): Host[] {
  const projected: Host[] = [];
  const endpointIndex = new Map<string, number>();
  const daemonIndex = new Map<string, number>();
  const daemonOwnerIndex = new Map<string, number>();
  const indexConnectionIdentity = (connection: Host, index: number) => {
    const { endpointKey, daemonKey, daemonOwnerKey } = getHomeConnectionIdentityKeys(connection);
    if (connection.bridgeHost.trim()) {
      endpointIndex.set(endpointKey, index);
    }
    if (daemonKey) {
      daemonIndex.set(daemonKey, index);
    }
    if (daemonOwnerKey) {
      daemonOwnerIndex.set(daemonOwnerKey, index);
    }
  };
  const addConnection = (connection: Host) => {
    const { endpointKey, daemonKey, daemonOwnerKey } = getHomeConnectionIdentityKeys(connection);
    const hasEndpointKey = connection.bridgeHost.trim().length > 0;
    const existingIndex = (
      daemonOwnerKey ? daemonOwnerIndex.get(daemonOwnerKey) : undefined
    ) ?? (
      daemonKey ? daemonIndex.get(daemonKey) : undefined
    ) ?? (
      hasEndpointKey ? endpointIndex.get(endpointKey) : undefined
    );
    if (existingIndex !== undefined) {
      const current = projected[existingIndex];
      if (current) {
        const base = shouldReplaceHomeConnection(current, connection) ? connection : current;
        const supplement = base === current ? connection : current;
        const merged = mergeHomeConnectionRouteCandidates(base, supplement);
        projected[existingIndex] = merged;
        indexConnectionIdentity(merged, existingIndex);
      }
      return;
    }
    const index = projected.length;
    projected.push(connection);
    indexConnectionIdentity(connection, index);
  };

  hosts.forEach(addConnection);
  const servers: BridgeServerPreset[] = Array.isArray(bridgeSettings.servers) ? [...bridgeSettings.servers] : [];
  const targetHost = bridgeSettings.targetHost?.trim() || '';
  const targetPort = Number.isFinite(bridgeSettings.targetPort) ? bridgeSettings.targetPort : DEFAULT_BRIDGE_PORT;

  if (
    targetHost
    && !servers.some((server) => server.targetHost === targetHost && server.targetPort === targetPort)
  ) {
    servers.push({
      id: `target:${targetHost}:${targetPort}`,
      name: targetHost,
      targetHost,
      targetPort,
      authToken: bridgeSettings.targetAuthToken || '',
    });
  }

  for (const server of servers) {
    const homeConnection = buildHomeConnectionFromPreset(server);
    if (!homeConnection) {
      continue;
    }
    addConnection(homeConnection);
  }

  for (const device of relayDevices) {
    const homeConnection = buildHomeConnectionFromRelayDevice(bridgeSettings, device);
    if (!homeConnection) {
      continue;
    }
    addConnection(homeConnection);
  }

  return projected;
}
