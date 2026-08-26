import {
  DEFAULT_BRIDGE_SETTINGS,
  normalizeBridgeSettings,
  type BridgeSettings,
} from '../connection/bridge-settings';
import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayDirectoryDevice,
  RelayEndpointCandidate,
  RelayTmuxSessionSnapshot,
} from '../connection/relay-directory';
import {
  deriveAppUpdateProjection,
  type AppUpdateProjection,
  type AppUpdateProjectionInput,
  type AppUpdateProjectionManifest,
} from '../interaction/projection';

export type PersistenceRevision = number;

export type PersistenceMutation =
  | {
      readonly type: 'replace-settings';
      readonly settings: BridgeSettings;
    }
  | {
      readonly type: 'replace-account';
      readonly account: RelayAccountDirectory | null;
    }
  | {
      readonly type: 'replace-update';
      readonly update: AppUpdateProjectionInput;
    };

export interface PersistenceProjection {
  readonly revision: PersistenceRevision;
  readonly settings: BridgeSettings;
  readonly account: RelayAccountDirectory | null;
  readonly update: AppUpdateProjection;
}

export interface PersistenceProjectionEvent {
  readonly revision: PersistenceRevision;
  readonly mutation: PersistenceMutation;
  readonly persistedAt: number;
}

export const INITIAL_PERSISTENCE_REVISION = 0;
export const INITIAL_PERSISTENCE_PROJECTION: PersistenceProjection = Object.freeze({
  revision: INITIAL_PERSISTENCE_REVISION,
  settings: DEFAULT_BRIDGE_SETTINGS,
  account: null,
  update: deriveAppUpdateProjection({
    preferences: {
      manifestUrl: '',
      manifestSource: 'none',
      autoCheckOnLaunch: true,
      ignoreUntilManualCheck: false,
    },
    latestManifest: null,
    availableManifest: null,
    checking: false,
    installing: false,
    lastError: null,
    updateStage: 'idle',
    runtimeVersionCode: 0,
  }),
});

export function createPersistenceProjection(
  settings: BridgeSettings = DEFAULT_BRIDGE_SETTINGS,
  account: RelayAccountDirectory | null = null,
  update: AppUpdateProjectionInput = {
    preferences: {
      manifestUrl: '',
      manifestSource: 'none',
      autoCheckOnLaunch: true,
      ignoreUntilManualCheck: false,
    },
    latestManifest: null,
    availableManifest: null,
    checking: false,
    installing: false,
    lastError: null,
    updateStage: 'idle',
    runtimeVersionCode: 0,
  },
): PersistenceProjection {
  return {
    revision: INITIAL_PERSISTENCE_REVISION,
    settings: normalizeBridgeSettings(settings),
    account: account === null ? null : normalizeAccountDirectory(account),
    update: deriveAppUpdateProjection(normalizeUpdateInput(update)),
  };
}

export function applyPersistenceMutation(
  state: PersistenceProjection,
  mutation: PersistenceMutation,
  persistedAt = Date.now(),
): PersistenceProjectionEvent {
  const normalized = normalizePersistenceMutation(mutation);
  const revision = state.revision + 1;
  return {
    revision,
    mutation: normalized,
    persistedAt,
  };
}

export function projectPersistenceEvent(
  state: PersistenceProjection,
  event: PersistenceProjectionEvent,
): PersistenceProjection {
  if (event.revision !== state.revision + 1) {
    throw new Error('persistence revision must advance by exactly one');
  }

  const mutation = event.mutation;
  switch (mutation.type) {
    case 'replace-settings':
      return {
        ...state,
        revision: event.revision,
        settings: normalizeBridgeSettings(mutation.settings),
      };
    case 'replace-account':
      return {
        ...state,
        revision: event.revision,
        account: mutation.account === null ? null : normalizeAccountDirectory(mutation.account),
      };
    case 'replace-update':
      return {
        ...state,
        revision: event.revision,
        update: deriveAppUpdateProjection(mutation.update),
      };
  }
}

export function replayPersistenceEvents(
  events: readonly PersistenceProjectionEvent[],
  base: PersistenceProjection = INITIAL_PERSISTENCE_PROJECTION,
): PersistenceProjection {
  let state = base;
  for (const event of events) {
    state = projectPersistenceEvent(state, event);
  }
  return state;
}

export function serializePersistenceProjection(state: PersistenceProjection): string {
  return JSON.stringify(state);
}

export function parsePersistenceProjection(input: string): PersistenceProjection {
  const value = JSON.parse(input) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('persistence projection must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
    throw new Error('persistence revision must be a non-negative integer');
  }
  return {
    ...createPersistenceProjection(
      normalizeBridgeSettings(candidate.settings),
      candidate.account === null || candidate.account === undefined ? null : normalizeAccountDirectory(candidate.account),
      normalizeUpdateInput(candidate.update),
    ),
    revision: candidate.revision,
  };
}

function normalizeAccountDirectory(input: unknown): RelayAccountDirectory {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('account directory must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const schemaVersion = candidate.schemaVersion;
  const user = candidate.user;
  const devices = candidate.devices;
  const updatedAt = candidate.updatedAt;
  if (schemaVersion !== 1) {
    throw new Error('account directory schema version must be 1');
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('account directory user must be an object');
  }
  const userId = (user as Record<string, unknown>).id;
  const username = (user as Record<string, unknown>).username;
  if (typeof userId !== 'string' || !userId.trim() || typeof username !== 'string' || !username.trim()) {
    throw new Error('account directory user id and username are required');
  }
  if (!Array.isArray(devices)) {
    throw new Error('account directory devices must be an array');
  }
  if (typeof updatedAt !== 'string' || !updatedAt.trim()) {
    throw new Error('account directory updatedAt is required');
  }
  return {
    schemaVersion: 1,
    user: { id: userId.trim(), username: username.trim() },
    devices: devices.map((device) => normalizeAccountDevice(device)),
    updatedAt: updatedAt.trim(),
  };
}

function normalizeAccountDevice(input: unknown): RelayDirectoryDevice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('account device must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const deviceId = candidate.deviceId;
  const deviceName = candidate.deviceName;
  const platform = candidate.platform;
  const appVersion = candidate.appVersion;
  const client = candidate.client;
  const daemon = candidate.daemon;
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('account device id is required');
  }
  if (typeof deviceName !== 'string' || !deviceName.trim()) {
    throw new Error('account device name is required');
  }
  if (typeof platform !== 'string' || !platform.trim()) {
    throw new Error('account device platform is required');
  }
  if (typeof appVersion !== 'string' || !appVersion.trim()) {
    throw new Error('account device appVersion is required');
  }
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new Error('account device client presence is required');
  }
  const clientRecord = client as Record<string, unknown>;
  if (typeof clientRecord.connected !== 'boolean' || typeof clientRecord.lastSeenAt !== 'string' || !clientRecord.lastSeenAt.trim()) {
    throw new Error('account device client presence is invalid');
  }
  if (daemon !== null && (!daemon || typeof daemon !== 'object' || Array.isArray(daemon))) {
    throw new Error('account device daemon must be null or an object');
  }
  return {
    deviceId: deviceId.trim(),
    deviceName: deviceName.trim(),
    platform: platform.trim(),
    appVersion: appVersion.trim(),
    client: { connected: clientRecord.connected, lastSeenAt: clientRecord.lastSeenAt.trim() },
    daemon: daemon === null || daemon === undefined ? null : normalizeAccountDaemon(daemon),
  };
}

function normalizeAccountDaemon(input: unknown): RelayDirectoryDaemon {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('account daemon must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const hostId = candidate.hostId;
  const version = candidate.version;
  const presence = candidate.presence;
  const endpoints = candidate.endpoints;
  const sessions = candidate.sessions;
  const lastPublishedAt = candidate.lastPublishedAt;
  if (typeof hostId !== 'string' || !hostId.trim()) {
    throw new Error('account daemon hostId is required');
  }
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('account daemon version is required');
  }
  if (!presence || typeof presence !== 'object' || Array.isArray(presence)) {
    throw new Error('account daemon presence is required');
  }
  const presenceRecord = presence as Record<string, unknown>;
  if (typeof presenceRecord.connected !== 'boolean' || typeof presenceRecord.lastSeenAt !== 'string' || !presenceRecord.lastSeenAt.trim()) {
    throw new Error('account daemon presence is invalid');
  }
  if (!Array.isArray(endpoints)) {
    throw new Error('account daemon endpoints must be an array');
  }
  if (!Array.isArray(sessions)) {
    throw new Error('account daemon sessions must be an array');
  }
  if (typeof lastPublishedAt !== 'string' || !lastPublishedAt.trim()) {
    throw new Error('account daemon lastPublishedAt is required');
  }
  return {
    hostId: hostId.trim(),
    version: version.trim(),
    presence: { connected: presenceRecord.connected, lastSeenAt: presenceRecord.lastSeenAt.trim() },
    endpoints: endpoints.map((endpoint) => normalizeAccountEndpoint(endpoint)),
    sessions: sessions.map((session) => normalizeAccountSession(session)),
    lastPublishedAt: lastPublishedAt.trim(),
  };
}

function normalizeAccountEndpoint(input: unknown): RelayEndpointCandidate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('account endpoint must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const id = candidate.id;
  const authRequired = candidate.authRequired;
  const lastSeenAt = candidate.lastSeenAt;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('account endpoint id is required');
  }
  if (typeof authRequired !== 'boolean') {
    throw new Error('account endpoint authRequired is required');
  }
  if (typeof lastSeenAt !== 'string' || !lastSeenAt.trim()) {
    throw new Error('account endpoint lastSeenAt is required');
  }
  const kind = candidate.kind;
  if (typeof kind !== 'string' || !kind.trim()) {
    throw new Error('account endpoint kind is required');
  }
  if (
    kind !== 'lan'
    && kind !== 'rtc-direct'
    && kind !== 'tailscale'
    && kind !== 'ipv6'
    && kind !== 'ipv4'
    && kind !== 'relay-rtc'
  ) {
    throw new Error('account endpoint kind is invalid');
  }
  return {
    id: id.trim(),
    kind,
    ...(typeof candidate.host === 'string' && candidate.host.trim() ? { host: candidate.host.trim() } : {}),
    ...(typeof candidate.port === 'number' && Number.isInteger(candidate.port) && candidate.port > 0 ? { port: candidate.port } : {}),
    ...(typeof candidate.wsUrl === 'string' && candidate.wsUrl.trim() ? { wsUrl: candidate.wsUrl.trim() } : {}),
    ...(typeof candidate.relayHostId === 'string' && candidate.relayHostId.trim() ? { relayHostId: candidate.relayHostId.trim() } : {}),
    ...(typeof candidate.authToken === 'string' ? { authToken: candidate.authToken } : {}),
    authRequired,
    lastSeenAt: lastSeenAt.trim(),
  };
}

function normalizeAccountSession(input: unknown): RelayTmuxSessionSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('account session must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const name = candidate.name;
  const updatedAt = candidate.updatedAt;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('account session name is required');
  }
  if (typeof updatedAt !== 'string' || !updatedAt.trim()) {
    throw new Error('account session updatedAt is required');
  }
  return {
    name: name.trim(),
    ...(typeof candidate.cwd === 'string' && candidate.cwd.trim() ? { cwd: candidate.cwd.trim() } : {}),
    ...(typeof candidate.title === 'string' && candidate.title.trim() ? { title: candidate.title.trim() } : {}),
    updatedAt: updatedAt.trim(),
  };
}

function normalizeUpdateInput(input: unknown): AppUpdateProjectionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('update projection must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const preferences = candidate.preferences;
  const latestManifest = candidate.latestManifest;
  const availableManifest = candidate.availableManifest;
  const runtimeVersionCode = candidate.runtimeVersionCode;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('update preferences are required');
  }
  if (typeof runtimeVersionCode !== 'number' || !Number.isSafeInteger(runtimeVersionCode) || runtimeVersionCode < 0) {
    throw new Error('update runtimeVersionCode is invalid');
  }
  const prefs = preferences as Record<string, unknown>;
  return {
    preferences: {
      manifestUrl: typeof prefs.manifestUrl === 'string' ? prefs.manifestUrl : '',
      manifestSource:
        prefs.manifestSource === 'user-saved'
          || prefs.manifestSource === 'relay-injected'
          || prefs.manifestSource === 'server-connected'
          || prefs.manifestSource === 'manual-override'
          || prefs.manifestSource === 'none'
          ? prefs.manifestSource
          : 'none',
      autoCheckOnLaunch: typeof prefs.autoCheckOnLaunch === 'boolean' ? prefs.autoCheckOnLaunch : true,
      ...(typeof prefs.skippedVersionCode === 'number' ? { skippedVersionCode: prefs.skippedVersionCode } : {}),
      ignoreUntilManualCheck: typeof prefs.ignoreUntilManualCheck === 'boolean' ? prefs.ignoreUntilManualCheck : false,
      ...(typeof prefs.lastCheckedAt === 'number' ? { lastCheckedAt: prefs.lastCheckedAt } : {}),
      ...(typeof prefs.lastSeenVersionCode === 'number' ? { lastSeenVersionCode: prefs.lastSeenVersionCode } : {}),
    },
    latestManifest: latestManifest === null || latestManifest === undefined ? null : normalizeUpdateManifest(latestManifest),
    availableManifest: availableManifest === null || availableManifest === undefined ? null : normalizeUpdateManifest(availableManifest),
    checking: typeof candidate.checking === 'boolean' ? candidate.checking : false,
    installing: typeof candidate.installing === 'boolean' ? candidate.installing : false,
    lastError: typeof candidate.lastError === 'string' || candidate.lastError === null ? candidate.lastError : null,
    updateStage: typeof candidate.updateStage === 'string' ? candidate.updateStage : 'idle',
    runtimeVersionCode,
  };
}

function normalizeUpdateManifest(input: unknown): AppUpdateProjectionManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('update manifest must be an object');
  }
  const candidate = input as Record<string, unknown>;
  const versionCode = candidate.versionCode;
  const versionName = candidate.versionName;
  const apkUrl = candidate.apkUrl;
  const sha256 = candidate.sha256;
  const notes = candidate.notes;
  if (typeof versionCode !== 'number' || !Number.isSafeInteger(versionCode) || versionCode < 0) {
    throw new Error('update manifest versionCode is invalid');
  }
  if (typeof versionName !== 'string' || !versionName.trim()) {
    throw new Error('update manifest versionName is required');
  }
  if (typeof apkUrl !== 'string' || !apkUrl.trim()) {
    throw new Error('update manifest apkUrl is required');
  }
  if (typeof sha256 !== 'string' || !sha256.trim()) {
    throw new Error('update manifest sha256 is required');
  }
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== 'string')) {
    throw new Error('update manifest notes must be a string array');
  }
  return {
    versionCode,
    versionName: versionName.trim(),
    ...(typeof candidate.buildNumber === 'number' ? { buildNumber: candidate.buildNumber } : {}),
    apkUrl: apkUrl.trim(),
    sha256: sha256.trim(),
    ...(typeof candidate.size === 'number' ? { size: candidate.size } : {}),
    notes: [...notes] as string[],
    ...(typeof candidate.publishedAt === 'string' && candidate.publishedAt.trim() ? { publishedAt: candidate.publishedAt.trim() } : {}),
    ...(typeof candidate.channel === 'string' && candidate.channel.trim() ? { channel: candidate.channel.trim() } : {}),
  };
}

function normalizePersistenceMutation(mutation: PersistenceMutation): PersistenceMutation {
  switch (mutation.type) {
    case 'replace-settings':
      return { type: 'replace-settings', settings: normalizeBridgeSettings(mutation.settings) };
    case 'replace-account':
      return {
        type: 'replace-account',
        account: mutation.account === null ? null : normalizeAccountDirectory(mutation.account),
      };
    case 'replace-update':
      return { type: 'replace-update', update: normalizeUpdateInput(mutation.update) };
  }
}
