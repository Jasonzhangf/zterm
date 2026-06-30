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

export function projectRelayDirectoryMachines(directory: RelayAccountDirectory | null | undefined): RelayDirectoryMachineProjection[] {
  if (!directory) {
    return [];
  }
  return directory.devices
    .filter((device) => Boolean(device.daemon?.hostId))
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      platform: device.platform,
      appVersion: device.appVersion,
      daemonHostId: device.daemon!.hostId,
      daemonVersion: device.daemon!.version,
      connected: device.daemon!.presence.connected,
      lastSeenAt: device.daemon!.presence.lastSeenAt,
      endpoints: device.daemon!.endpoints,
      sessions: device.daemon!.sessions,
    }));
}

export function projectRelayDirectoryDeviceSnapshots(
  directory: RelayAccountDirectory | null | undefined,
): TraversalRelayDeviceSnapshot[] {
  if (!directory) {
    return [];
  }
  return directory.devices.map((device) => ({
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
  }));
}
