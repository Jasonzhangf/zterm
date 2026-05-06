import { APP_VERSION } from './app-version';
import { getBrowserStorage } from './browser-storage';
import type { BridgeSettings, TraversalRelayClientSettings } from './bridge-settings';
import type { TraversalRelayDeviceSnapshot, TraversalRelayUser } from './types';

export interface TraversalRelayAuthPayload {
  ok: boolean;
  accessToken?: string;
  user?: TraversalRelayUser;
  devices?: TraversalRelayDeviceSnapshot[];
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
  updatedAt: number;
  relaySettings?: TraversalRelayClientSettings;
}

const STORAGE_KEY = 'zterm:traversal-relay-account';

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function normalizeBaseUrl(input: string) {
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
    return parsed.toString();
  } catch {
    return '';
  }
}

function buildHttpUrl(baseUrl: string, path: string) {
  return new URL(path.replace(/^\//, ''), normalizeBaseUrl(baseUrl)).toString();
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

function buildDefaultDeviceId(platform: string) {
  return `zterm-${platform}`;
}

function resolveTraversalRelayDeviceMeta(account?: Partial<TraversalRelayAccountState> | null): TraversalRelayDeviceMeta {
  const platform = asString(account?.platform).trim() || resolvePlatform();
  return {
    deviceId: asString(account?.deviceId).trim() || buildDefaultDeviceId(platform),
    deviceName: asString(account?.deviceName).trim() || buildDefaultDeviceName(platform),
    platform,
  };
}

function normalizeStoredState(input: unknown): TraversalRelayAccountState | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as Partial<TraversalRelayAccountState>;
  const relayBaseUrl = normalizeBaseUrl(asString(candidate.relayBaseUrl));
  if (!relayBaseUrl) {
    return null;
  }
  const platform = asString(candidate.platform).trim() || resolvePlatform();
  return {
    username: asString(candidate.username).trim(),
    password: asString(candidate.password),
    relayBaseUrl,
    accessToken: asString(candidate.accessToken).trim(),
    user: candidate.user && typeof candidate.user === 'object'
      ? {
          id: asString((candidate.user as TraversalRelayUser).id).trim(),
          username: asString((candidate.user as TraversalRelayUser).username).trim(),
          createdAt: asString((candidate.user as TraversalRelayUser).createdAt).trim(),
        }
      : null,
    deviceId: asString(candidate.deviceId).trim() || buildDefaultDeviceId(platform),
    deviceName: asString(candidate.deviceName).trim() || buildDefaultDeviceName(platform),
    platform,
    devices: Array.isArray(candidate.devices) ? candidate.devices as TraversalRelayDeviceSnapshot[] : [],
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : Date.now(),
    relaySettings: normalizeStoredStateRelaySettings(candidate.relaySettings),
  };
}

function normalizeStoredStateRelaySettings(input: unknown): TraversalRelayClientSettings | undefined {
  const relay = input as TraversalRelayClientSettings | undefined;
  const deviceMeta = resolveTraversalRelayDeviceMeta(relay ? {
    deviceId: relay.deviceId,
    deviceName: relay.deviceName,
    platform: relay.platform,
  } : null);
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

export function readTraversalRelayAccountState(): TraversalRelayAccountState | null {
  const storage = getBrowserStorage();
  if (!storage) {
    return null;
  }
  try {
    return normalizeStoredState(JSON.parse(storage.getItem(STORAGE_KEY) || 'null'));
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
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function deriveTraversalRelayClientSettings(
  payload: TraversalRelayAuthPayload,
  deviceMetaInput?: Partial<TraversalRelayDeviceMeta> | null,
): TraversalRelayClientSettings | undefined {
  const relayBaseUrl = normalizeBaseUrl(asString(payload.relayBaseUrl));
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
    password: options.password,
    relayBaseUrl: normalizeBaseUrl(options.relayBaseUrl),
    accessToken: asString(payload.accessToken).trim(),
    user: payload.user || null,
    deviceId: deviceMeta.deviceId,
    deviceName: deviceMeta.deviceName,
    platform: deviceMeta.platform,
    devices: Array.isArray(payload.devices) ? payload.devices : [],
    updatedAt: Date.now(),
    relaySettings: deriveTraversalRelayClientSettings(payload, deviceMeta),
  };
  writeTraversalRelayAccountState(nextState);
  return nextState;
}

export async function traversalRelayRefreshMe(state: TraversalRelayAccountState) {
  const response = await fetch(buildHttpUrl(state.relayBaseUrl, '/api/auth/me'), {
    headers: {
      authorization: `Bearer ${state.accessToken}`,
    },
  });
  const payload = await response.json() as TraversalRelayAuthPayload;
  if (!response.ok) {
    throw new Error(payload.message || `me failed: HTTP ${response.status}`);
  }
  const nextState: TraversalRelayAccountState = {
    ...state,
    user: payload.user || state.user,
    devices: Array.isArray(payload.devices) ? payload.devices : state.devices,
    updatedAt: Date.now(),
    relaySettings: deriveTraversalRelayClientSettings(payload, state) || state.relaySettings,
  };
  writeTraversalRelayAccountState(nextState);
  return {
    account: nextState,
    relaySettings: deriveTraversalRelayClientSettings(payload, state),
  };
}

export function connectTraversalRelayDevicesStream(options: {
  account: TraversalRelayAccountState;
  onDevices: (devices: TraversalRelayDeviceSnapshot[]) => void;
  onError?: (message: string) => void;
}) {
  const relay = options.account.relaySettings;
  if (!relay?.wsDevicesUrl) {
    throw new Error('relay device stream url missing');
  }

  const url = new URL(relay.wsDevicesUrl);
  url.searchParams.set('token', options.account.accessToken);
  url.searchParams.set('deviceId', options.account.deviceId);
  url.searchParams.set('deviceName', options.account.deviceName);
  url.searchParams.set('platform', options.account.platform);
  url.searchParams.set('appVersion', APP_VERSION);

  const socket = new WebSocket(url.toString());
  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: 'device-meta',
      payload: {
        deviceId: options.account.deviceId,
        deviceName: options.account.deviceName,
        platform: options.account.platform,
        appVersion: APP_VERSION,
      },
    }));
  };
  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as { type?: string; payload?: { devices?: TraversalRelayDeviceSnapshot[] }; reason?: string };
      if ((payload.type === 'devices-snapshot' || payload.type === 'device-updated') && Array.isArray(payload.payload?.devices)) {
        const nextState: TraversalRelayAccountState = {
          ...options.account,
          devices: payload.payload.devices,
          updatedAt: Date.now(),
        };
        writeTraversalRelayAccountState(nextState);
        options.onDevices(payload.payload.devices);
        return;
      }
      if (payload.type === 'relay-error') {
        options.onError?.(payload.reason || 'relay device stream error');
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error));
    }
  };
  socket.onerror = () => {
    options.onError?.('relay device stream websocket error');
  };
  return socket;
}
