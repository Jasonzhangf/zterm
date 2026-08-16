import { APP_VERSION } from './app-version';
import { getBrowserStorage } from './browser-storage';
import { collectClientDebugSnapshot } from './client-debug-snapshot';
import { readRuntimeDebugEntries } from './runtime-debug';
import type { BridgeSettings, TraversalRelayClientSettings } from './bridge-settings';
import type { TraversalRelayDeviceSnapshot, TraversalRelayUser } from './types';
import {
  normalizeRelayAccountDirectory,
  type RelayAccountDirectory,
} from './relay-account-directory';

export interface TraversalRelayAuthPayload {
  ok: boolean;
  accessToken?: string;
  user?: TraversalRelayUser;
  devices?: TraversalRelayDeviceSnapshot[];
  directory?: unknown;
  relayBaseUrl?: string;
  signalBaseUrl?: string;
  turn?: {
    url?: string;
    username?: string;
    credential?: string;
  } | null;
  ws?: {
    devices?: string;
    host?: string;
    client?: string;
  } | null;
  message?: string;
}

interface TraversalRelayDeviceMeta {
  deviceId: string;
  deviceName: string;
  platform: string;
}

interface RelayDebugRequestPayload {
  requestId?: string;
  reason?: string;
  includeSnapshot?: boolean;
  includeLogs?: boolean;
  logLimit?: number;
}

type RelayDeviceStreamMessage =
  | { type?: 'devices-snapshot' | 'device-updated'; payload?: { devices?: TraversalRelayDeviceSnapshot[] } }
  | { type?: 'directory-snapshot'; payload?: { directory?: unknown } }
  | { type?: 'control-pong'; payload?: { sentAt?: number; receivedAt?: number } }
  | { type?: 'relay-error'; reason?: string }
  | { type?: 'client-debug-request'; payload?: RelayDebugRequestPayload };

export interface TraversalRelayAccountState {
  username: string;
  password: string;
  relayBaseUrl: string;
  accessToken: string;
  user: TraversalRelayUser | null;
  deviceId: string;
  deviceName: string;
  platform: string;
  devices: TraversalRelayDeviceSnapshot[];
  directory: RelayAccountDirectory | null;
  updatedAt: number;
  relaySettings?: TraversalRelayClientSettings;
}

const STORAGE_KEY = 'zterm:traversal-relay-account';
const DEFAULT_TRAVERSAL_RELAY_BASE_URL_PARTS = ['https://', 'relay', '.', 'codewhisper', '.', 'cc:18443', '/relay/'] as const;
const LEGACY_DEFAULT_TRAVERSAL_RELAY_HOSTS = new Set(['claw.codewhisper.cc']);
const LEGACY_FIXED_RELAY_DEVICE_IDS = new Set(['zterm-android', 'zterm-ios', 'zterm-mac', 'zterm-windows', 'zterm-web']);

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function normalizeTraversalRelayBaseUrl(input: string) {
  const raw = input.trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    const segments = normalizedPath.split('/').filter(Boolean);
    const relayIndex = segments.indexOf('relay');
    if (relayIndex >= 0) {
      parsed.pathname = `/${segments.slice(0, relayIndex + 1).join('/')}/`;
    } else if (segments.length > 0) {
      parsed.pathname = `/${segments.join('/')}/relay/`;
    } else {
      parsed.pathname = '/relay/';
    }
    parsed.search = '';
    parsed.hash = '';
    if (LEGACY_DEFAULT_TRAVERSAL_RELAY_HOSTS.has(parsed.hostname)) {
      return getDefaultTraversalRelayBaseUrl();
    }
    return parsed.toString();
  } catch (error) {
    console.error('[traversal-relay-client] Failed to normalize relay base url:', error);
    return '';
  }
}

export function getDefaultTraversalRelayBaseUrl() {
  return DEFAULT_TRAVERSAL_RELAY_BASE_URL_PARTS.join('');
}

export function isDefaultTraversalRelayBaseUrl(input?: string | null) {
  return normalizeTraversalRelayBaseUrl(asString(input)) === getDefaultTraversalRelayBaseUrl();
}

export function resolveTraversalRelayBaseUrl(input?: string | null) {
  const normalized = normalizeTraversalRelayBaseUrl(asString(input));
  return normalized || getDefaultTraversalRelayBaseUrl();
}

function buildHttpUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ''), normalizeTraversalRelayBaseUrl(baseUrl)).toString();
}

export class TraversalRelayAuthenticationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TraversalRelayAuthenticationError';
    this.status = status;
  }
}

export function isTraversalRelayAuthenticationError(error: unknown): error is TraversalRelayAuthenticationError {
  return error instanceof TraversalRelayAuthenticationError
    || (error instanceof Error && error.name === 'TraversalRelayAuthenticationError');
}

async function readTraversalRelayAuthPayload(response: Response, allowInvalidJson: boolean) {
  try {
    return await response.json() as TraversalRelayAuthPayload;
  } catch (error) {
    if (allowInvalidJson) {
      return {} as TraversalRelayAuthPayload;
    }
    throw error;
  }
}

function resolvePlatform() {
  if (typeof navigator === 'undefined') {
    return 'web';
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) {
    return 'android';
  }
  if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('ios')) {
    return 'ios';
  }
  if (userAgent.includes('mac os')) {
    return 'mac';
  }
  if (userAgent.includes('windows')) {
    return 'windows';
  }
  return 'web';
}

function buildDefaultDeviceName(platform: string) {
  switch (platform) {
    case 'android':
      return 'ZTerm Android';
    case 'ios':
      return 'ZTerm iOS';
    case 'mac':
      return 'ZTerm Mac';
    case 'windows':
      return 'ZTerm Windows';
    default:
      return 'ZTerm Client';
  }
}

export function buildDefaultDeviceId(platform: string) {
  const storage = getBrowserStorage();
  const storageKey = `zterm:relay-device-id:${platform}`;
  const stored = asString(storage?.getItem(storageKey)).trim();
  if (stored && !isLegacyFixedRelayDeviceId(platform, stored)) {
    return stored;
  }
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const deviceId = `zterm-${platform}-${randomId.toLowerCase()}`;
  storage?.setItem(storageKey, deviceId);
  return deviceId;
}

function isLegacyFixedRelayDeviceId(platform: string, deviceId: string) {
  const normalizedPlatform = platform.trim().toLowerCase();
  const normalizedDeviceId = deviceId.trim().toLowerCase();
  return normalizedDeviceId === `zterm-${normalizedPlatform}` || LEGACY_FIXED_RELAY_DEVICE_IDS.has(normalizedDeviceId);
}

function resolveRelayDeviceId(platform: string, candidateDeviceId: unknown) {
  const candidate = asString(candidateDeviceId).trim();
  if (candidate && !isLegacyFixedRelayDeviceId(platform, candidate)) {
    return candidate;
  }
  return buildDefaultDeviceId(platform);
}

function resolveTraversalRelayDeviceMeta(account?: Partial<TraversalRelayAccountState> | null): TraversalRelayDeviceMeta {
  const platform = asString(account?.platform).trim() || resolvePlatform();
  return {
    deviceId: resolveRelayDeviceId(platform, account?.deviceId),
    deviceName: asString(account?.deviceName).trim() || buildDefaultDeviceName(platform),
    platform,
  };
}

function readRelaySettingsCandidateDeviceMeta(candidate: Partial<TraversalRelayAccountState>, platform: string) {
  const relay = candidate.relaySettings && typeof candidate.relaySettings === 'object'
    ? candidate.relaySettings as TraversalRelayClientSettings
    : undefined;
  const topLevelId = asString(candidate.deviceId).trim();
  const relaySettingsId = asString(relay?.deviceId).trim();
  const deviceId = topLevelId && !isLegacyFixedRelayDeviceId(platform, topLevelId)
    ? topLevelId
    : relaySettingsId && !isLegacyFixedRelayDeviceId(platform, relaySettingsId)
      ? relaySettingsId
      : '';
  return resolveTraversalRelayDeviceMeta({
    deviceId,
    deviceName: asString(candidate.deviceName).trim() || asString(relay?.deviceName).trim(),
    platform,
  });
}

function normalizeStoredState(input: unknown): TraversalRelayAccountState | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<TraversalRelayAccountState>;
  const relayBaseUrl = normalizeTraversalRelayBaseUrl(asString(candidate.relayBaseUrl));
  if (!relayBaseUrl) {
    return null;
  }
  const platform = asString(candidate.platform).trim() || resolvePlatform();
  const deviceMeta = readRelaySettingsCandidateDeviceMeta(candidate, platform);
  return {
    username: asString(candidate.username).trim(),
    password: '',
    relayBaseUrl,
    accessToken: asString(candidate.accessToken).trim(),
    user: candidate.user && typeof candidate.user === 'object'
      ? {
          id: asString((candidate.user as TraversalRelayUser).id).trim(),
          username: asString((candidate.user as TraversalRelayUser).username).trim(),
          createdAt: asString((candidate.user as TraversalRelayUser).createdAt).trim(),
        }
      : null,
    deviceId: deviceMeta.deviceId,
    deviceName: deviceMeta.deviceName,
    platform: deviceMeta.platform,
    devices: Array.isArray(candidate.devices) ? candidate.devices as TraversalRelayDeviceSnapshot[] : [],
    directory: normalizeRelayAccountDirectory(candidate.directory),
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : Date.now(),
    relaySettings: normalizeStoredStateRelaySettings(candidate.relaySettings, deviceMeta),
  };
}

function requireRelayAccountDirectory(input: unknown) {
  const directory = normalizeRelayAccountDirectory(input);
  if (!directory) {
    throw new Error('relay account directory missing or invalid');
  }
  return directory;
}

function normalizeStoredStateRelaySettings(
  input: unknown,
  parentDeviceMeta?: Partial<TraversalRelayDeviceMeta> | null,
): TraversalRelayClientSettings | undefined {
  const relay = input as TraversalRelayClientSettings | undefined;
  const deviceMeta = resolveTraversalRelayDeviceMeta(parentDeviceMeta || (relay ? {
    deviceId: relay.deviceId,
    deviceName: relay.deviceName,
    platform: relay.platform,
  } : null));
  return deriveTraversalRelayClientSettings({
    ok: true,
    relayBaseUrl: asString(relay?.relayBaseUrl),
    accessToken: asString(relay?.accessToken),
    user: input && typeof input === 'object'
      ? {
          id: asString(relay?.userId),
          username: asString(relay?.username),
          createdAt: '',
        }
      : undefined,
    turn: input && typeof input === 'object'
      ? {
          url: asString(relay?.turnUrl),
          username: asString(relay?.turnUsername),
          credential: asString(relay?.turnCredential),
        }
      : undefined,
    ws: input && typeof input === 'object'
      ? {
          devices: asString(relay?.wsDevicesUrl),
          host: asString(relay?.wsHostUrl),
          client: asString(relay?.wsClientUrl),
        }
      : undefined,
  }, deviceMeta);
}

function storedRelayDeviceIdentityNeedsMigration(
  input: unknown,
  normalized: TraversalRelayAccountState,
) {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const candidate = input as Partial<TraversalRelayAccountState>;
  const relay = candidate.relaySettings && typeof candidate.relaySettings === 'object'
    ? candidate.relaySettings as TraversalRelayClientSettings
    : undefined;
  return asString(candidate.deviceId).trim() !== normalized.deviceId
    || (relay ? asString(relay.deviceId).trim() !== normalized.relaySettings?.deviceId : false);
}

export function readTraversalRelayAccountState(): TraversalRelayAccountState | null {
  const storage = getBrowserStorage();
  if (!storage) {
    return null;
  }
  try {
    const stored = storage.getItem(STORAGE_KEY) || 'null';
    const parsed = JSON.parse(stored);
    const normalized = normalizeStoredState(parsed);
    if (normalized && storedRelayDeviceIdentityNeedsMigration(parsed, normalized)) {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch (error) {
    console.error('[traversal-relay-client] Failed to read account state:', error);
    return null;
  }
}

export function writeTraversalRelayAccountState(state: TraversalRelayAccountState | null) {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  if (!state) {
    storage.removeItem(STORAGE_KEY);
    emitTraversalRelayAccountChange(state);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
  emitTraversalRelayAccountChange(state);
}

function emitTraversalRelayAccountChange(state: TraversalRelayAccountState | null) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('traversal-relay-account-change', { detail: { state } }));
  } catch {
    // ignore
  }
}

function readCurrentTraversalRelayStreamAccount(base: TraversalRelayAccountState) {
  const current = readTraversalRelayAccountState();
  if (
    current
    && current.accessToken === base.accessToken
    && normalizeTraversalRelayBaseUrl(current.relayBaseUrl) === normalizeTraversalRelayBaseUrl(base.relayBaseUrl)
  ) {
    return current;
  }
  throw new Error('relay device stream identity mismatch: account logged out, replaced, or token rotated');
}

export function deriveTraversalRelayClientSettings(
  payload: TraversalRelayAuthPayload,
  deviceMetaInput?: Partial<TraversalRelayDeviceMeta> | null,
): TraversalRelayClientSettings | undefined {
  const relayBaseUrl = normalizeTraversalRelayBaseUrl(asString(payload.relayBaseUrl));
  const accessToken = asString(payload.accessToken).trim();
  const userId = asString(payload.user?.id).trim();
  const username = asString(payload.user?.username).trim();
  const wsDevicesUrl = asString(payload.ws?.devices).trim();
  const wsHostUrl = asString(payload.ws?.host).trim();
  const wsClientUrl = asString(payload.ws?.client).trim();
  if (!relayBaseUrl || !accessToken || !wsDevicesUrl || !wsHostUrl || !wsClientUrl) {
    return undefined;
  }
  const deviceMeta = resolveTraversalRelayDeviceMeta(deviceMetaInput || null);
  return {
    relayBaseUrl,
    accessToken,
    userId,
    username,
    deviceId: deviceMeta.deviceId,
    deviceName: deviceMeta.deviceName,
    platform: deviceMeta.platform,
    wsDevicesUrl,
    wsHostUrl,
    wsClientUrl,
    turnUrl: asString(payload.turn?.url).trim(),
    turnUsername: asString(payload.turn?.username),
    turnCredential: asString(payload.turn?.credential),
    updatedAt: Date.now(),
  };
}

export function applyTraversalRelaySettings(base: BridgeSettings, relay: TraversalRelayClientSettings | undefined): BridgeSettings {
  return {
    ...base,
    traversalRelay: relay,
  };
}

export async function traversalRelayRegister(options: {
  relayBaseUrl: string;
  username: string;
  password: string;
}) {
  const response = await fetch(buildHttpUrl(options.relayBaseUrl, '/api/auth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: options.username,
      password: options.password,
    }),
  });
  const payload = await response.json() as TraversalRelayAuthPayload;
  if (!response.ok) {
    throw new Error(payload.message || `register failed: HTTP ${response.status}`);
  }
  return payload;
}

export async function traversalRelayLogin(options: {
  relayBaseUrl: string;
  username: string;
  password: string;
}) {
  const response = await fetch(buildHttpUrl(options.relayBaseUrl, '/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: options.username,
      password: options.password,
    }),
  });
  const payload = await response.json() as TraversalRelayAuthPayload;
  if (!response.ok) {
    throw new Error(payload.message || `login failed: HTTP ${response.status}`);
  }

  const current = readTraversalRelayAccountState();
  const deviceMeta = resolveTraversalRelayDeviceMeta(current);
  const nextState: TraversalRelayAccountState = {
    username: options.username.trim(),
    password: '',
    relayBaseUrl: normalizeTraversalRelayBaseUrl(options.relayBaseUrl),
    accessToken: asString(payload.accessToken).trim(),
    user: payload.user || null,
    deviceId: deviceMeta.deviceId,
    deviceName: deviceMeta.deviceName,
    platform: deviceMeta.platform,
    devices: Array.isArray(payload.devices) ? payload.devices : [],
    directory: requireRelayAccountDirectory(payload.directory),
    updatedAt: Date.now(),
    relaySettings: deriveTraversalRelayClientSettings(payload, deviceMeta),
  };
  writeTraversalRelayAccountState(nextState);
  return nextState;
}

export async function traversalRelayRefreshMe(state: TraversalRelayAccountState) {
  const normalizedState = normalizeStoredState(state) || state;
  const response = await fetch(buildHttpUrl(normalizedState.relayBaseUrl, '/api/auth/me'), {
    headers: {
      authorization: `Bearer ${normalizedState.accessToken}`,
    },
  });
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    const payload = await readTraversalRelayAuthPayload(response, true);
    throw new TraversalRelayAuthenticationError(payload.message || 'Relay 登录已失效', response.status);
  }
  const payload = await readTraversalRelayAuthPayload(response, !response.ok);
  if (!response.ok) {
    throw new Error(payload.message || `me failed: HTTP ${response.status}`);
  }
  const refreshPayload: TraversalRelayAuthPayload = {
    ...payload,
    accessToken: asString(payload.accessToken).trim() || normalizedState.accessToken,
  };
  const nextRelaySettings = deriveTraversalRelayClientSettings(refreshPayload, normalizedState);
  if (!nextRelaySettings) {
    throw new Error('relay control payload missing ws/control settings');
  }
  const nextState: TraversalRelayAccountState = {
    ...normalizedState,
    accessToken: refreshPayload.accessToken || normalizedState.accessToken,
    user: payload.user || normalizedState.user,
    deviceId: nextRelaySettings.deviceId,
    deviceName: nextRelaySettings.deviceName,
    platform: nextRelaySettings.platform,
    devices: Array.isArray(payload.devices) ? payload.devices : normalizedState.devices,
    directory: requireRelayAccountDirectory(payload.directory),
    updatedAt: Date.now(),
    relaySettings: nextRelaySettings,
  };
  writeTraversalRelayAccountState(nextState);
  return {
    account: nextState,
    relaySettings: nextRelaySettings,
  };
}

export function connectTraversalRelayDevicesStream(options: {
  account: TraversalRelayAccountState;
  onDevices: (devices: TraversalRelayDeviceSnapshot[]) => void;
  onDirectory?: (directory: RelayAccountDirectory) => void;
  onControlPong?: (payload: { sentAt?: number; receivedAt?: number }) => void;
  onOpen?: () => void;
  onError?: (message: string) => void;
  onClose?: (event: CloseEvent) => void;
  onDebugRequest?: (payload: RelayDebugRequestPayload, socket: WebSocket) => void;
}) {
  const relay = options.account.relaySettings;
  if (!relay?.wsDevicesUrl) {
    throw new Error('relay device stream url missing');
  }
  const deviceMeta = resolveTraversalRelayDeviceMeta(options.account);

  const url = new URL(relay.wsDevicesUrl);
  url.searchParams.set('token', options.account.accessToken);
  url.searchParams.set('deviceId', deviceMeta.deviceId);
  url.searchParams.set('deviceName', deviceMeta.deviceName);
  url.searchParams.set('platform', deviceMeta.platform);
  url.searchParams.set('appVersion', APP_VERSION);

  const socket = new WebSocket(url.toString());
  socket.onopen = () => {
    options.onOpen?.();
    socket.send(JSON.stringify({
      type: 'device-meta',
      payload: {
        deviceId: deviceMeta.deviceId,
        deviceName: deviceMeta.deviceName,
        platform: deviceMeta.platform,
        appVersion: APP_VERSION,
      },
    }));
  };
  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as RelayDeviceStreamMessage;
      if ((payload.type === 'devices-snapshot' || payload.type === 'device-updated') && Array.isArray(payload.payload?.devices)) {
        const currentAccount = readCurrentTraversalRelayStreamAccount(options.account);
        const nextState: TraversalRelayAccountState = {
          ...currentAccount,
          devices: payload.payload.devices,
          updatedAt: Date.now(),
        };
        writeTraversalRelayAccountState(nextState);
        options.onDevices(payload.payload.devices);
        return;
      }
      if (payload.type === 'directory-snapshot') {
        const directory = normalizeRelayAccountDirectory(payload.payload?.directory);
        if (!directory) {
          options.onError?.('relay directory snapshot missing or invalid');
          return;
        }
        const currentAccount = readCurrentTraversalRelayStreamAccount(options.account);
        writeTraversalRelayAccountState({
          ...currentAccount,
          directory,
          updatedAt: Date.now(),
        });
        options.onDirectory?.(directory);
        return;
      }
      if (payload.type === 'control-pong') {
        options.onControlPong?.(payload.payload || {});
        return;
      }
      if (payload.type === 'relay-error') {
        options.onError?.(payload.reason || 'relay device stream error');
        return;
      }
      if (payload.type === 'client-debug-request') {
        options.onDebugRequest?.(payload.payload || {}, socket);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onError?.(message);
      if (message.startsWith('relay device stream identity mismatch')) {
        socket.close();
      }
    }
  };
  socket.onerror = () => {
    options.onError?.('relay device stream websocket error');
  };
  socket.onclose = (event) => {
    options.onClose?.(event);
  };
  return socket;
}

export function sendTraversalRelayClientDebugSnapshot(options: {
  socket: WebSocket;
  account: TraversalRelayAccountState;
  requestId?: string;
  reason?: string;
  snapshot?: unknown;
}) {
  if (options.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  options.socket.send(JSON.stringify({
    type: 'client-debug-snapshot',
    payload: {
      deviceId: options.account.deviceId,
      requestId: options.requestId?.trim() || undefined,
      reason: options.reason?.trim() || undefined,
      snapshot: options.snapshot ?? collectClientDebugSnapshot({
        relayDeviceId: options.account.deviceId,
        relayUsername: options.account.username,
      }),
    },
  }));
  return true;
}

export function sendTraversalRelayClientDebugLogs(options: {
  socket: WebSocket;
  account: TraversalRelayAccountState;
  limit?: number;
  sinceSeq?: number;
}) {
  if (options.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  const entries = readRuntimeDebugEntries({
    limit: options.limit,
    sinceSeq: options.sinceSeq,
  });
  if (entries.length === 0) {
    return false;
  }
  options.socket.send(JSON.stringify({
    type: 'client-debug-log',
    payload: {
      deviceId: options.account.deviceId,
      entries,
    },
  }));
  return true;
}
