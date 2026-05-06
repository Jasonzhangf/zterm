import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

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
}

export interface TraversalRelayStoreData {
  users: TraversalRelayUserRecord[];
  tokens: TraversalRelayTokenRecord[];
  devices: TraversalRelayDeviceRecord[];
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
    clientConnected: false,
    clientLastSeenAt,
    daemonConnected: false,
    daemonLastSeenAt,
    daemonHostId: typeof record.daemonHostId === 'string' ? record.daemonHostId.trim() : '',
    daemonVersion: typeof record.daemonVersion === 'string' ? record.daemonVersion.trim() : '',
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
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens as TraversalRelayTokenRecord[] : [],
      devices: Array.isArray(parsed.devices)
        ? parsed.devices
            .map((entry) => asStoredDevice(entry as Partial<TraversalRelayDeviceRecord>))
            .filter((entry): entry is TraversalRelayDeviceRecord => entry !== null)
        : [],
    };
  }

  private persist() {
    ensureStoreDir(this.path);
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
    renameSync(tempPath, this.path);
  }

  private requireUserById(userId: string) {
    const user = this.data.users.find((entry) => entry.id === userId);
    if (!user) {
      throw new Error(`user ${userId} not found`);
    }
    return user;
  }

  private getOrCreateDevice(userId: string, deviceId: string) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
      throw new Error('deviceId is required');
    }
    let device = this.data.devices.find((entry) => entry.userId === userId && entry.deviceId === normalizedDeviceId);
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
    };
    this.data.devices.push(device);
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
    this.data.users.push(record);
    this.persist();
    return toPublicUser(record);
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
    this.data.tokens.push(tokenRecord);
    this.persist();
    return {
      token: tokenRecord.token,
      user: toPublicUser(user),
    };
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
    record.lastUsedAt = stableNow();
    this.persist();
    return toPublicUser(user);
  }

  public setClientConnected(options: {
    userId: string;
    deviceId: string;
    deviceName?: string;
    platform?: string;
    appVersion?: string;
    connected: boolean;
  }) {
    this.requireUserById(options.userId);
    const device = this.getOrCreateDevice(options.userId, options.deviceId);
    this.patchDeviceIdentity(device, options);
    const now = stableNow();
    device.clientConnected = options.connected;
    device.updatedAt = now;
    device.lastSeenAt = now;
    device.clientLastSeenAt = now;
    this.persist();
    return toDeviceSnapshot(device);
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
    this.requireUserById(options.userId);
    const hostId = options.hostId.trim();
    if (!hostId) {
      throw new Error('hostId is required');
    }
    const device = this.getOrCreateDevice(options.userId, options.deviceId);
    this.patchDeviceIdentity(device, options);
    const now = stableNow();
    device.daemonConnected = options.connected;
    device.daemonHostId = hostId;
    device.daemonLastSeenAt = now;
    device.updatedAt = now;
    device.lastSeenAt = now;
    if (typeof options.daemonVersion === 'string' && options.daemonVersion.trim()) {
      device.daemonVersion = options.daemonVersion.trim();
    }
    this.persist();
    return toDeviceSnapshot(device);
  }

  public listDevices(userId: string) {
    this.requireUserById(userId);
    return this.data.devices
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.deviceId.localeCompare(right.deviceId))
      .map((entry) => toDeviceSnapshot(entry));
  }

  public summary() {
    return {
      users: this.data.users.length,
      tokens: this.data.tokens.length,
      devices: this.data.devices.length,
    };
  }
}
