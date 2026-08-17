import {
  normalizeRelayEndpointCandidates,
  normalizeRelayTmuxSessionSnapshots,
  type RelayAccountDirectory,
  type RelayDirectoryDaemon,
  type RelayDirectoryDevice,
} from '@zterm/shared/relay-directory';
import type { TraversalRelayDeviceSnapshot } from './types';

export type { RelayAccountDirectory } from '@zterm/shared/relay-directory';

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : false;
}

function normalizePresence(input: unknown, now: string) {
  const candidate = input && typeof input === 'object'
    ? input as { connected?: unknown; lastSeenAt?: unknown }
    : {};
  return {
    connected: asBoolean(candidate.connected),
    lastSeenAt: asString(candidate.lastSeenAt) || now,
  };
}

function normalizeDirectoryDaemon(input: unknown, now: string): RelayDirectoryDaemon | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<RelayDirectoryDaemon>;
  const hostId = asString(candidate.hostId);
  if (!hostId) {
    return null;
  }
  return {
    hostId,
    version: asString(candidate.version),
    presence: normalizePresence(candidate.presence, now),
    endpoints: normalizeRelayEndpointCandidates(candidate.endpoints, now),
    sessions: normalizeRelayTmuxSessionSnapshots(candidate.sessions, now),
    lastPublishedAt: asString(candidate.lastPublishedAt) || now,
  };
}

function normalizeDirectoryDevice(input: unknown, now: string): RelayDirectoryDevice | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<RelayDirectoryDevice>;
  const deviceId = asString(candidate.deviceId);
  if (!deviceId) {
    return null;
  }
  return {
    deviceId,
    deviceName: asString(candidate.deviceName),
    platform: asString(candidate.platform),
    appVersion: asString(candidate.appVersion),
    client: normalizePresence(candidate.client, now),
    daemon: normalizeDirectoryDaemon(candidate.daemon, now),
  };
}

export function normalizeRelayAccountDirectory(input: unknown): RelayAccountDirectory | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<RelayAccountDirectory>;
  if (candidate.schemaVersion !== 1) {
    return null;
  }
  const user = candidate.user && typeof candidate.user === 'object'
    ? candidate.user as { id?: unknown; username?: unknown }
    : null;
  const userId = asString(user?.id);
  const username = asString(user?.username);
  if (!userId || !username) {
    return null;
  }
  const updatedAt = asString(candidate.updatedAt) || new Date().toISOString();
  const devices = Array.isArray(candidate.devices)
    ? candidate.devices
        .map((device) => normalizeDirectoryDevice(device, updatedAt))
        .filter((device): device is RelayDirectoryDevice => device !== null)
    : [];
  return {
    schemaVersion: 1,
    user: {
      id: userId,
      username,
    },
    devices,
    updatedAt,
  };
}

export interface RelayDirectoryMachineProjection {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  daemonHostId: string;
  daemonVersion: string;
  connected: boolean;
  lastSeenAt: string;
  endpoints: RelayDirectoryDaemon['endpoints'];
  sessions: RelayDirectoryDaemon['sessions'];
}

export interface RelayDaemonIdentityInput {
  daemonHostId?: string | null;
  relayHostId?: string | null;
  relayDeviceId?: string | null;
  authToken?: string | null;
  bridgeHost?: string | null;
  bridgePort?: number | null;
}

function normalizeDaemonIdentityText(value: string | null | undefined) {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveRelayDaemonCanonicalHostId(
  input: RelayDaemonIdentityInput,
  devices: TraversalRelayDeviceSnapshot[],
) {
  const onlineDevices = devices.filter((device) => (
    device.daemon.connected
    && device.daemon.hostId.trim()
  ));
  const canonicalHostIds = new Set(onlineDevices.map((device) => device.daemon.hostId.trim()));
  const candidateHostId = normalizeDaemonIdentityText(input.daemonHostId)
    || normalizeDaemonIdentityText(input.relayHostId);
  if (candidateHostId && canonicalHostIds.has(candidateHostId)) {
    return candidateHostId;
  }

  const relayDeviceId = normalizeDaemonIdentityText(input.relayDeviceId);
  if (relayDeviceId) {
    const matched = onlineDevices.filter((device) => device.deviceId.trim() === relayDeviceId);
    if (matched.length === 1) {
      return matched[0]!.daemon.hostId.trim();
    }
  }

  const authToken = normalizeDaemonIdentityText(input.authToken);
  if (authToken) {
    const matched = new Set<string>();
    for (const device of onlineDevices) {
      for (const endpoint of device.daemon.endpoints || []) {
        if ((endpoint.authToken || '').trim() === authToken) {
          matched.add(device.daemon.hostId.trim());
        }
      }
    }
    if (matched.size === 1) {
      return [...matched][0]!;
    }
  }

  const bridgeHost = normalizeDaemonIdentityText(input.bridgeHost);
  const bridgePort = typeof input.bridgePort === 'number' ? input.bridgePort : 0;
  if (bridgeHost && bridgePort > 0) {
    const matched = new Set<string>();
    for (const device of onlineDevices) {
      for (const endpoint of device.daemon.endpoints || []) {
        if (
          (endpoint.host || '').trim() === bridgeHost
          && endpoint.port === bridgePort
        ) {
          matched.add(device.daemon.hostId.trim());
        }
      }
    }
    if (matched.size === 1) {
      return [...matched][0]!;
    }
  }

  return null;
}

function snapshotTruthScore(device: TraversalRelayDeviceSnapshot) {
  return (device.daemon.connected ? 1_000_000 : 0)
    + (device.daemon.sessions?.length || 0) * 1_000
    + (device.daemon.endpoints?.length || 0) * 100
    + (device.deviceName.trim() ? 10 : 0);
}

function mergeRelayDirectorySnapshotTruth(
  primary: TraversalRelayDeviceSnapshot,
  supplement: TraversalRelayDeviceSnapshot,
) {
  const endpoints = new Map((primary.daemon.endpoints || []).map((endpoint) => [endpoint.id, endpoint]));
  for (const endpoint of supplement.daemon.endpoints || []) {
    const current = endpoints.get(endpoint.id);
    if (!current || endpoint.lastSeenAt > current.lastSeenAt) {
      endpoints.set(endpoint.id, endpoint);
    }
  }
  const sessions = new Map((primary.daemon.sessions || []).map((session) => [session.name, session]));
  for (const session of supplement.daemon.sessions || []) {
    const current = sessions.get(session.name);
    if (!current || session.updatedAt > current.updatedAt) {
      sessions.set(session.name, session);
    }
  }
  return {
    ...primary,
    client: {
      connected: primary.client.connected || supplement.client.connected,
      lastSeenAt: primary.client.lastSeenAt > supplement.client.lastSeenAt
        ? primary.client.lastSeenAt
        : supplement.client.lastSeenAt,
    },
    updatedAt: primary.updatedAt > supplement.updatedAt ? primary.updatedAt : supplement.updatedAt,
    daemon: {
      ...primary.daemon,
      connected: primary.daemon.connected || supplement.daemon.connected,
      lastSeenAt: primary.daemon.lastSeenAt > supplement.daemon.lastSeenAt
        ? primary.daemon.lastSeenAt
        : supplement.daemon.lastSeenAt,
      version: primary.daemon.version || supplement.daemon.version,
      endpoints: [...endpoints.values()],
      sessions: [...sessions.values()],
    },
  };
}

export function dedupeRelayDaemonDeviceSnapshots(
  devices: TraversalRelayDeviceSnapshot[],
) {
  const byHostId = new Map<string, TraversalRelayDeviceSnapshot>();
  const result: TraversalRelayDeviceSnapshot[] = [];
  for (const device of devices) {
    const hostId = device.daemon.hostId.trim();
    if (!hostId) {
      result.push(device);
      continue;
    }
    const existing = byHostId.get(hostId);
    if (!existing) {
      byHostId.set(hostId, device);
      result.push(device);
      continue;
    }
    const primary = snapshotTruthScore(device) > snapshotTruthScore(existing) ? device : existing;
    const merged = mergeRelayDirectorySnapshotTruth(primary, primary === existing ? device : existing);
    byHostId.set(hostId, merged);
    const index = result.indexOf(existing);
    if (index >= 0) {
      result[index] = merged;
    }
  }
  return result;
}

export function projectRelayDirectoryMachines(directory: RelayAccountDirectory | null | undefined): RelayDirectoryMachineProjection[] {
  if (!directory) {
    return [];
  }
  const devices = dedupeRelayDaemonDeviceSnapshots(projectRelayDirectoryDeviceSnapshots(directory));
  return devices
    .filter((device) => Boolean(device.daemon?.hostId))
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      platform: device.platform,
      appVersion: device.appVersion,
      daemonHostId: device.daemon!.hostId,
      daemonVersion: device.daemon!.version,
      connected: device.daemon!.connected,
      lastSeenAt: device.daemon!.lastSeenAt,
      endpoints: device.daemon!.endpoints || [],
      sessions: device.daemon!.sessions || [],
    }));
}

export function projectRelayDirectoryDeviceSnapshots(
  directory: RelayAccountDirectory | null | undefined,
): TraversalRelayDeviceSnapshot[] {
  if (!directory) {
    return [];
  }
  return dedupeRelayDaemonDeviceSnapshots(directory.devices.map((device) => ({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    platform: device.platform,
    appVersion: device.appVersion,
    updatedAt: directory.updatedAt,
    client: {
      connected: device.client.connected,
      lastSeenAt: device.client.lastSeenAt,
    },
      daemon: device.daemon
      ? {
          connected: device.daemon.presence.connected,
          lastSeenAt: device.daemon.presence.lastSeenAt,
          hostId: device.daemon.hostId,
          version: device.daemon.version,
          endpoints: device.daemon.endpoints,
          sessions: device.daemon.sessions,
        }
      : {
          connected: false,
          lastSeenAt: '',
          hostId: '',
          version: '',
        },
  })));
}
