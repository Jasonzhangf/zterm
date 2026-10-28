import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import {
  normalizeRelayEndpointCandidates,
  normalizeRelayTmuxSessionSnapshots,
  type RelayAccountDirectory,
  type RelayDirectoryDaemon,
  type RelayDirectoryDevice,
  type RelayEndpointCandidate,
  type RelayTmuxSessionSnapshot,
} from '@zterm/shared/relay-directory';

export interface TraversalRelayUserRecord {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

export interface TraversalRelayTokenRecord {
  token: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface TraversalRelayDeviceRecord {
  userId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  clientConnected: boolean;
  clientLastSeenAt: string;
  daemonConnected: boolean;
  daemonLastSeenAt: string;
  daemonHostId: string;
  daemonVersion: string;
  daemonDirectoryPublishedAt: string;
  daemonEndpoints: RelayEndpointCandidate[];
  daemonSessions: RelayTmuxSessionSnapshot[];
}

export interface TraversalRelayStoreData {
  users: TraversalRelayUserRecord[];
  tokens: TraversalRelayTokenRecord[];
  devices: TraversalRelayDeviceRecord[];
}

export class DeviceCleanupRejectedError extends Error {
  public readonly rejected: Array<{
    deviceId: string;
    reason: 'online' | 'not_owned' | 'not_daemon';
  }>;

  public constructor(rejected: Array<{
    deviceId: string;
    reason: 'online' | 'not_owned' | 'not_daemon';
  }>) {
    super('device cleanup rejected');
    this.name = 'DeviceCleanupRejectedError';
    this.rejected = rejected.map((entry) => ({ ...entry }));
  }
}

export interface TraversalRelayPublicUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface TraversalRelayDeviceSnapshot {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  online: boolean;
  client: {
    connected: boolean;
    lastSeenAt: string;
  };
    daemon: {
      connected: boolean;
      lastSeenAt: string;
      hostId: string;
      version: string;
  };
}

function createEmptyStore(): TraversalRelayStoreData {
  return {
    users: [],
    tokens: [],
    devices: [],
  };
}

function cloneStoreData(data: TraversalRelayStoreData): TraversalRelayStoreData {
  return {
    users: data.users.map((user) => ({ ...user })),
    tokens: data.tokens.map((token) => ({ ...token })),
    devices: data.devices.map((device) => ({
      ...device,
      daemonEndpoints: device.daemonEndpoints.map((endpoint) => ({ ...endpoint })),
      daemonSessions: device.daemonSessions.map((session) => ({ ...session })),
    })),
  };
}

function ensureStoreDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function stableNow() {
  return new Date().toISOString();
}

function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString('hex');
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function normalizeDeviceId(value: string) {
  return value.trim();
}

function asStoredDevice(record: Partial<TraversalRelayDeviceRecord>): TraversalRelayDeviceRecord | null {
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const deviceId = typeof record.deviceId === 'string' ? normalizeDeviceId(record.deviceId) : '';
  if (!userId || !deviceId) {
    return null;
  }
  const createdAt = typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt : stableNow();
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt.trim() ? record.updatedAt : createdAt;
  const lastSeenAt = typeof record.lastSeenAt === 'string' && record.lastSeenAt.trim() ? record.lastSeenAt : updatedAt;
  const clientLastSeenAt = typeof record.clientLastSeenAt === 'string' ? record.clientLastSeenAt : '';
  const daemonLastSeenAt = typeof record.daemonLastSeenAt === 'string' ? record.daemonLastSeenAt : '';
  return {
    userId,
    deviceId,
    deviceName: typeof record.deviceName === 'string' ? record.deviceName.trim() : '',
    platform: typeof record.platform === 'string' ? record.platform.trim() : '',
    appVersion: typeof record.appVersion === 'string' ? record.appVersion.trim() : '',
    createdAt,
    updatedAt,
    lastSeenAt,
    // Connection flags describe the process that wrote this file. A restarted
    // relay has no live sockets yet, so loading them as online would create
    // permanent ghost devices. Sockets re-establish presence after startup.
    clientConnected: false,
    clientLastSeenAt,
    daemonConnected: false,
    daemonLastSeenAt,
    daemonHostId: typeof record.daemonHostId === 'string' ? record.daemonHostId.trim() : '',
    daemonVersion: typeof record.daemonVersion === 'string' ? record.daemonVersion.trim() : '',
    daemonDirectoryPublishedAt: typeof record.daemonDirectoryPublishedAt === 'string' ? record.daemonDirectoryPublishedAt : '',
    daemonEndpoints: normalizeRelayEndpointCandidates(record.daemonEndpoints, updatedAt),
    daemonSessions: normalizeRelayTmuxSessionSnapshots(record.daemonSessions, updatedAt),
  };
}

function toPublicUser(user: TraversalRelayUserRecord): TraversalRelayPublicUser {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
  };
}

function toDeviceSnapshot(record: TraversalRelayDeviceRecord): TraversalRelayDeviceSnapshot {
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    appVersion: record.appVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    online: record.clientConnected || record.daemonConnected,
    client: {
      connected: record.clientConnected,
      lastSeenAt: record.clientLastSeenAt,
    },
    daemon: {
      connected: record.daemonConnected,
      lastSeenAt: record.daemonLastSeenAt,
      hostId: record.daemonHostId,
      version: record.daemonVersion,
    },
  };
}

function toDirectoryDevice(record: TraversalRelayDeviceRecord): RelayDirectoryDevice {
  const daemonConnected = record.daemonConnected;
  const daemon: RelayDirectoryDaemon | null = record.daemonHostId
    ? {
        hostId: record.daemonHostId,
        version: record.daemonVersion,
        presence: {
          connected: daemonConnected,
          lastSeenAt: record.daemonLastSeenAt,
        },
        endpoints: daemonConnected ? record.daemonEndpoints.map((endpoint) => ({ ...endpoint })) : [],
        sessions: daemonConnected ? record.daemonSessions.map((session) => ({ ...session })) : [],
        lastPublishedAt: record.daemonDirectoryPublishedAt || record.daemonLastSeenAt,
      }
    : null;
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    platform: record.platform,
    appVersion: record.appVersion,
    client: {
      connected: record.clientConnected,
      lastSeenAt: record.clientLastSeenAt,
    },
    daemon,
  };
}

const MAX_TOKENS_PER_USER = 64;

function pruneTokensPerUser(
  tokens: TraversalRelayTokenRecord[],
  maxPerUser = MAX_TOKENS_PER_USER,
): TraversalRelayTokenRecord[] {
  const byUser = new Map<string, TraversalRelayTokenRecord[]>();
  for (const token of tokens) {
    if (!token || typeof token.userId !== 'string' || typeof token.token !== 'string') {
      continue;
    }
    let list = byUser.get(token.userId);
    if (!list) {
      list = [];
      byUser.set(token.userId, list);
    }
    list.push(token);
  }
  const kept = new Set<TraversalRelayTokenRecord>();
  for (const list of byUser.values()) {
    if (list.length <= maxPerUser) {
      for (const item of list) {
        kept.add(item);
      }
      continue;
    }
    const sorted = [...list].sort((left, right) => {
      const leftTime = left.lastUsedAt || left.createdAt || '';
      const rightTime = right.lastUsedAt || right.createdAt || '';
      return leftTime.localeCompare(rightTime);
    });
    for (const item of sorted.slice(-maxPerUser)) {
      kept.add(item);
    }
  }
  return tokens.filter((token) => kept.has(token));
}

export class TraversalRelayStore {
  private data: TraversalRelayStoreData;

  public constructor(private readonly path: string) {
    this.data = this.load();
  }

  private load(): TraversalRelayStoreData {
    if (!existsSync(this.path)) {
      return createEmptyStore();
    }
    const raw = readFileSync(this.path, 'utf-8');
    if (!raw.trim()) {
      return createEmptyStore();
    }
    const parsed = JSON.parse(raw) as Partial<TraversalRelayStoreData>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users as TraversalRelayUserRecord[] : [],
      tokens: Array.isArray(parsed.tokens)
        ? pruneTokensPerUser(parsed.tokens as TraversalRelayTokenRecord[])
        : [],
      devices: Array.isArray(parsed.devices)
        ? parsed.devices
            .map((entry) => asStoredDevice(entry as Partial<TraversalRelayDeviceRecord>))
            .filter((entry): entry is TraversalRelayDeviceRecord => entry !== null)
        : [],
    };
  }

  private persist(data: TraversalRelayStoreData) {
    ensureStoreDir(this.path);
    const tempPath = `${this.path}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'w');
      writeFileSync(descriptor, JSON.stringify(data, null, 2));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(tempPath, this.path);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Keep the original persistence error.
        }
      }
      try {
        unlinkSync(tempPath);
      } catch {
        // Keep the original persistence error.
      }
      throw error;
    }
  }

  private commitCandidate<T>(
    mutate: (candidate: TraversalRelayStoreData) => { result: T; commit: boolean },
  ) {
    const candidate = cloneStoreData(this.data);
    const { result, commit } = mutate(candidate);
    if (!commit) {
      return result;
    }
    this.persist(candidate);
    this.data = candidate;
    return result;
  }

  private requireUserById(data: TraversalRelayStoreData, userId: string) {
    const user = data.users.find((entry) => entry.id === userId);
    if (!user) {
      throw new Error(`user ${userId} not found`);
    }
    return user;
  }

  private getOrCreateDevice(data: TraversalRelayStoreData, userId: string, deviceId: string) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
      throw new Error('deviceId is required');
    }
    let device = data.devices.find((entry) => entry.userId === userId && entry.deviceId === normalizedDeviceId);
    if (device) {
      return device;
    }
    const now = stableNow();
    device = {
      userId,
      deviceId: normalizedDeviceId,
      deviceName: '',
      platform: '',
      appVersion: '',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      clientConnected: false,
      clientLastSeenAt: '',
      daemonConnected: false,
      daemonLastSeenAt: '',
      daemonHostId: '',
      daemonVersion: '',
      daemonDirectoryPublishedAt: '',
      daemonEndpoints: [],
      daemonSessions: [],
    };
    data.devices.push(device);
    return device;
  }

  private patchDeviceIdentity(
    device: TraversalRelayDeviceRecord,
    input: {
      deviceName?: string;
      platform?: string;
      appVersion?: string;
    },
  ) {
    const nextDeviceName = typeof input.deviceName === 'string' ? input.deviceName.trim() : '';
    const nextPlatform = typeof input.platform === 'string' ? input.platform.trim() : '';
    const nextAppVersion = typeof input.appVersion === 'string' ? input.appVersion.trim() : '';
    if (nextDeviceName) {
      device.deviceName = nextDeviceName;
    }
    if (nextPlatform) {
      device.platform = nextPlatform;
    }
    if (nextAppVersion) {
      device.appVersion = nextAppVersion;
    }
  }

  public register(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) {
      throw new Error('username is required');
    }
    if (!password.trim()) {
      throw new Error('password is required');
    }
    if (this.data.users.some((user) => user.username === normalizedUsername)) {
      throw new Error('username already exists');
    }
    const salt = randomHex(16);
    const now = stableNow();
    const record: TraversalRelayUserRecord = {
      id: randomHex(16),
      username: normalizedUsername,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      createdAt: now,
    };
    return this.commitCandidate((candidate) => {
      candidate.users.push({ ...record });
      return { result: toPublicUser(record), commit: true };
    });
  }

  public login(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const user = this.data.users.find((entry) => entry.username === normalizedUsername);
    if (!user) {
      throw new Error('invalid username or password');
    }
    const expected = Buffer.from(user.passwordHash, 'hex');
    const actual = Buffer.from(hashPassword(password, user.passwordSalt), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('invalid username or password');
    }
    const now = stableNow();
    const tokenRecord: TraversalRelayTokenRecord = {
      token: randomHex(24),
      userId: user.id,
      createdAt: now,
      lastUsedAt: now,
    };
    return this.commitCandidate((candidate) => {
      candidate.tokens.push({ ...tokenRecord });
      candidate.tokens = pruneTokensPerUser(candidate.tokens);
      return {
        result: {
          token: tokenRecord.token,
          user: toPublicUser(user),
        },
        commit: true,
      };
    });
  }

  public authenticate(token: string) {
    const record = this.data.tokens.find((entry) => entry.token === token.trim());
    if (!record) {
      return null;
    }
    const user = this.data.users.find((entry) => entry.id === record.userId);
    if (!user) {
      return null;
    }
    const lastUsedAt = stableNow();
    return this.commitCandidate((candidate) => {
      const candidateRecord = candidate.tokens.find((entry) => entry.token === record.token);
      if (!candidateRecord) {
        throw new Error(`token ${record.token} not found`);
      }
      candidateRecord.lastUsedAt = lastUsedAt;
      return { result: toPublicUser(user), commit: true };
    });
  }

  public setClientConnected(options: {
    userId: string;
    deviceId: string;
    deviceName?: string;
    platform?: string;
    appVersion?: string;
    connected: boolean;
  }) {
    const now = stableNow();
    return this.commitCandidate((candidate) => {
      this.requireUserById(candidate, options.userId);
      const device = this.getOrCreateDevice(candidate, options.userId, options.deviceId);
      this.patchDeviceIdentity(device, options);
      device.clientConnected = options.connected;
      device.updatedAt = now;
      device.lastSeenAt = now;
      device.clientLastSeenAt = now;
      return { result: toDeviceSnapshot(device), commit: true };
    });
  }

  public publishDaemonDirectory(options: {
    userId: string;
    deviceId: string;
    hostId: string;
    deviceName?: string;
    platform?: string;
    appVersion?: string;
    daemonVersion?: string;
    endpoints?: RelayEndpointCandidate[];
    sessions?: RelayTmuxSessionSnapshot[];
    publishedAt?: string;
  }) {
    const hostId = options.hostId.trim();
    const now = stableNow();
    const publishedAt = options.publishedAt?.trim() || now;
    return this.commitCandidate((candidate) => {
      this.requireUserById(candidate, options.userId);
      if (!hostId) {
        throw new Error('hostId is required');
      }
      const device = this.getOrCreateDevice(candidate, options.userId, options.deviceId);
      this.patchDeviceIdentity(device, options);
      device.daemonConnected = true;
      device.daemonHostId = hostId;
      device.daemonLastSeenAt = now;
      device.daemonDirectoryPublishedAt = publishedAt;
      device.updatedAt = now;
      device.lastSeenAt = now;
      if (typeof options.daemonVersion === 'string' && options.daemonVersion.trim()) {
        device.daemonVersion = options.daemonVersion.trim();
      }
      device.daemonEndpoints = normalizeRelayEndpointCandidates(options.endpoints, publishedAt)
        .map((endpoint) => ({ ...endpoint }));
      device.daemonSessions = normalizeRelayTmuxSessionSnapshots(options.sessions, publishedAt)
        .map((session) => ({ ...session }));
      return { result: toDirectoryDevice(device), commit: true };
    });
  }

  public setDaemonConnected(options: {
    userId: string;
    deviceId: string;
    hostId: string;
    deviceName?: string;
    platform?: string;
    appVersion?: string;
    daemonVersion?: string;
    connected: boolean;
  }) {
    const hostId = options.hostId.trim();
    const now = stableNow();
    return this.commitCandidate((candidate) => {
      this.requireUserById(candidate, options.userId);
      if (!hostId) {
        throw new Error('hostId is required');
      }
      const device = this.getOrCreateDevice(candidate, options.userId, options.deviceId);
      this.patchDeviceIdentity(device, options);
      device.daemonConnected = options.connected;
      device.daemonHostId = hostId;
      device.daemonLastSeenAt = now;
      device.updatedAt = now;
      device.lastSeenAt = now;
      if (typeof options.daemonVersion === 'string' && options.daemonVersion.trim()) {
        device.daemonVersion = options.daemonVersion.trim();
      }
      return { result: toDeviceSnapshot(device), commit: true };
    });
  }

  public clearOtherDaemonHostBindings(options: {
    userId: string;
    deviceId: string;
    hostId: string;
  }) {
    const deviceId = normalizeDeviceId(options.deviceId);
    const hostId = options.hostId.trim();
    const now = stableNow();
    return this.commitCandidate((candidate) => {
      this.requireUserById(candidate, options.userId);
      if (!deviceId || !hostId) {
        return { result: false, commit: false };
      }
      let changed = false;
      for (const device of candidate.devices) {
        if (
          device.userId !== options.userId
          || device.deviceId === deviceId
          || device.daemonHostId !== hostId
          || !device.daemonConnected
        ) {
          continue;
        }
        device.daemonConnected = false;
        device.daemonLastSeenAt = '';
        device.daemonHostId = '';
        device.daemonVersion = '';
        device.daemonDirectoryPublishedAt = '';
        device.daemonEndpoints = [];
        device.daemonSessions = [];
        device.updatedAt = now;
        device.lastSeenAt = now;
        changed = true;
      }
      return { result: changed, commit: changed };
    });
  }

  public cleanupOfflineDevices(
    userId: string,
    deviceIds: readonly string[],
    isPhysicallyConnected: (deviceId: string, daemonHostId: string) => boolean,
  ): { removedDeviceIds: string[]; absentDeviceIds: string[] } {
    this.requireUserById(this.data, userId);
    if (!Array.isArray(deviceIds) || deviceIds.length < 1 || deviceIds.length > 100) {
      throw new Error('deviceIds must contain between 1 and 100 unique exact IDs');
    }

    const requestedDeviceIds = Array.from(deviceIds);
    const requested = new Set<string>();
    for (const deviceId of requestedDeviceIds) {
      if (
        typeof deviceId !== 'string'
        || deviceId.length === 0
        || deviceId.trim() !== deviceId
        || requested.has(deviceId)
      ) {
        throw new Error('deviceIds must contain between 1 and 100 unique exact IDs');
      }
      requested.add(deviceId);
    }

    const ownedRowsByDeviceId = new Map<string, TraversalRelayDeviceRecord[]>();
    const foreignDeviceIds = new Set<string>();
    for (const device of this.data.devices) {
      if (!requested.has(device.deviceId)) {
        continue;
      }
      if (device.userId === userId) {
        const rows = ownedRowsByDeviceId.get(device.deviceId) ?? [];
        rows.push(device);
        ownedRowsByDeviceId.set(device.deviceId, rows);
      } else {
        foreignDeviceIds.add(device.deviceId);
      }
    }

    const removedDeviceIds: string[] = [];
    const absentDeviceIds: string[] = [];
    const rejected: Array<{
      deviceId: string;
      reason: 'online' | 'not_owned' | 'not_daemon';
    }> = [];
    for (const deviceId of requestedDeviceIds) {
      const ownedRows = ownedRowsByDeviceId.get(deviceId);
      if (!ownedRows || ownedRows.length === 0) {
        if (foreignDeviceIds.has(deviceId)) {
          rejected.push({ deviceId, reason: 'not_owned' });
        } else {
          absentDeviceIds.push(deviceId);
        }
        continue;
      }
      if (ownedRows.some((device) => device.clientConnected || device.daemonConnected)) {
        rejected.push({ deviceId, reason: 'online' });
        continue;
      }
      if (ownedRows.some((device) => !device.daemonHostId)) {
        rejected.push({ deviceId, reason: 'not_daemon' });
        continue;
      }
      if (ownedRows.some((device) => isPhysicallyConnected(deviceId, device.daemonHostId))) {
        rejected.push({ deviceId, reason: 'online' });
        continue;
      }
      removedDeviceIds.push(deviceId);
    }

    if (rejected.length > 0) {
      throw new DeviceCleanupRejectedError(rejected);
    }
    if (removedDeviceIds.length === 0) {
      return {
        removedDeviceIds: [],
        absentDeviceIds: absentDeviceIds.slice(),
      };
    }

    const removed = new Set(removedDeviceIds);
    return this.commitCandidate((candidate) => {
      candidate.devices = candidate.devices.filter(
        (device) => device.userId !== userId || !removed.has(device.deviceId),
      );
      return {
        result: {
          removedDeviceIds: removedDeviceIds.slice(),
          absentDeviceIds: absentDeviceIds.slice(),
        },
        commit: true,
      };
    });
  }

  public listDevices(userId: string) {
    this.requireUserById(this.data, userId);
    return this.data.devices
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.deviceId.localeCompare(right.deviceId))
      .map((entry) => toDeviceSnapshot(entry));
  }

  public getAccountDirectory(userId: string): RelayAccountDirectory {
    const user = this.requireUserById(this.data, userId);
    const devices = this.data.devices
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.deviceId.localeCompare(right.deviceId))
      .map((entry) => toDirectoryDevice(entry));
    return {
      schemaVersion: 1,
      user: {
        id: user.id,
        username: user.username,
      },
      devices,
      updatedAt: stableNow(),
    };
  }

  public summary() {
    return {
      users: this.data.users.length,
      tokens: this.data.tokens.length,
      devices: this.data.devices.length,
    };
  }
}
