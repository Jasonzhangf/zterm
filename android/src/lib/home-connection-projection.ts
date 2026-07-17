import { type BridgeServerPreset, type BridgeSettings } from './bridge-settings';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { resolveRelayDeviceBridgeTarget } from './session-picker';
import { isOnlineTraversalRelayDaemonDevice } from './traversal-relay-devices';
import type { Host, TraversalRelayDeviceSnapshot } from './types';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';

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
  const seen = new Set<string>();
  const merged: RelayEndpointCandidate[] = [];
  for (const candidate of [...left, ...right]) {
    const key = buildRelayEndpointKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

function mergeHomeConnectionRouteCandidates(base: Host, supplement: Host): Host {
  const relayEndpointCandidates = mergeRelayEndpointCandidates(
    base.relayEndpointCandidates || [],
    supplement.relayEndpointCandidates || [],
  );
  const tags = [...new Set([...(base.tags || []), ...(supplement.tags || []).filter((tag) => tag === 'relay-directory')])];
  return {
    ...base,
    daemonHostId: base.daemonHostId || supplement.daemonHostId,
    relayHostId: base.relayHostId || supplement.relayHostId || supplement.daemonHostId,
    relayDeviceId: base.relayDeviceId || supplement.relayDeviceId,
    tailscaleHost: base.tailscaleHost || supplement.tailscaleHost,
    ipv6Host: base.ipv6Host || supplement.ipv6Host,
    ipv4Host: base.ipv4Host || supplement.ipv4Host,
    signalUrl: base.signalUrl || supplement.signalUrl,
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

export function buildHomeRelayConnectionHost(host: Host): Host | null {
  const relayRtcEndpointCandidates = (host.relayEndpointCandidates || []).filter((candidate) => (
    candidate.kind === 'relay-rtc'
    && candidate.relayHostId?.trim()
  ));
  const relayHostId = (
    host.relayHostId
    || host.daemonHostId
    || relayRtcEndpointCandidates[0]?.relayHostId
    || ''
  ).trim();
  if (!relayHostId || relayRtcEndpointCandidates.length === 0) {
    return null;
  }
  return {
    ...host,
    id: `relay-route:${host.id}`,
    bridgeHost: '',
    daemonHostId: host.daemonHostId || relayHostId,
    relayHostId,
    relayEndpointCandidates: host.relayEndpointCandidates || relayRtcEndpointCandidates,
    transportMode: 'auto',
    tags: [...new Set([...(host.tags || []), 'relay-route'])],
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
        projected[existingIndex] = mergeHomeConnectionRouteCandidates(base, supplement);
      }
      return;
    }
    const index = projected.length;
    projected.push(connection);
    if (hasEndpointKey) {
      endpointIndex.set(endpointKey, index);
    }
    if (daemonKey) {
      daemonIndex.set(daemonKey, index);
    }
    if (daemonOwnerKey) {
      daemonOwnerIndex.set(daemonOwnerKey, index);
    }
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
