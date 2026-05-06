import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
} from '../lib/mobile-config';

export const DEFAULT_DAEMON_TERMINAL_CACHE_LINES = 3000;

export const WTERM_HOME_DIRNAME = '.wterm';
export const WTERM_CONFIG_FILENAME = 'config.json';
export const WTERM_UPDATES_DIRNAME = 'updates';
export const WTERM_DAEMON_ID_FILENAME = 'daemon-id';

interface WtermRelayConfig {
  relayUrl?: unknown;
  username?: unknown;
  password?: unknown;
  hostId?: unknown;
  deviceId?: unknown;
  deviceName?: unknown;
  platform?: unknown;
  appVersion?: unknown;
  daemonVersion?: unknown;
}

interface WtermConfigFile {
  mobile?: {
    daemon?: {
      host?: unknown;
      port?: unknown;
      authToken?: unknown;
      terminalCacheLines?: unknown;
      sessionName?: unknown;
    };
    relay?: WtermRelayConfig;
  };
  zterm?: {
    android?: {
      daemon?: {
        host?: unknown;
        port?: unknown;
        authToken?: unknown;
        terminalCacheLines?: unknown;
        sessionName?: unknown;
      };
      relay?: WtermRelayConfig;
    };
  };
}

export interface TraversalRelayRuntimeConfig {
  relayUrl: string;
  username: string;
  password: string;
  hostId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  daemonVersion: string;
}

export interface DaemonRuntimeConfig {
  host: string;
  port: number;
  authToken: string;
  terminalCacheLines: number;
  sessionName: string;
  daemonHostId: string;
  configPath: string;
  configFound: boolean;
  authSource: 'env' | 'config' | 'default';
  relay: TraversalRelayRuntimeConfig | null;
}

type DaemonEnv = Record<string, string | undefined>;

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInteger(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, parsed);
    }
  }
  return undefined;
}

export function getWtermConfigPath(homeDir: string = homedir()) {
  return join(homeDir, WTERM_HOME_DIRNAME, WTERM_CONFIG_FILENAME);
}

export function getWtermHomeDir(homeDir: string = homedir()) {
  return join(homeDir, WTERM_HOME_DIRNAME);
}

export function getWtermUpdatesDir(homeDir: string = homedir()) {
  return join(getWtermHomeDir(homeDir), WTERM_UPDATES_DIRNAME);
}

export function getWtermDaemonIdPath(homeDir: string = homedir()) {
  return join(getWtermHomeDir(homeDir), WTERM_DAEMON_ID_FILENAME);
}

function sanitizeDaemonId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 128);
}

function buildDefaultDaemonId() {
  const host = hostname().trim() || 'zterm-daemon';
  const entropy = randomUUID();
  const digest = createHash('sha256').update(`${host}:${entropy}`).digest('hex').slice(0, 16);
  return sanitizeDaemonId(`daemon-${host}-${digest}`);
}

export function resolveStableDaemonHostId(homeDir: string = homedir()) {
  const daemonIdPath = getWtermDaemonIdPath(homeDir);
  if (existsSync(daemonIdPath)) {
    const stored = sanitizeDaemonId(readFileSync(daemonIdPath, 'utf-8'));
    if (stored) {
      return stored;
    }
  }

  const nextDaemonId = buildDefaultDaemonId();
  mkdirSync(getWtermHomeDir(homeDir), { recursive: true });
  writeFileSync(daemonIdPath, `${nextDaemonId}\n`, 'utf-8');
  return nextDaemonId;
}

export function readWtermConfigFile(homeDir: string = homedir()) {
  const configPath = getWtermConfigPath(homeDir);
  if (!existsSync(configPath)) {
    return {
      path: configPath,
      found: false,
      config: {} as WtermConfigFile,
    };
  }

  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${configPath}: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${configPath}: root must be a JSON object`);
  }

  return {
    path: configPath,
    found: true,
    config: parsed as WtermConfigFile,
  };
}

export function resolveDaemonRuntimeConfig(options?: {
  env?: DaemonEnv;
  homeDir?: string;
}): DaemonRuntimeConfig {
  const env = options?.env || process.env;
  const homeDir = options?.homeDir || homedir();
  const { config, found, path } = readWtermConfigFile(homeDir);
  const daemonConfig = config.zterm?.android?.daemon || config.mobile?.daemon || {};
  const relayConfig = config.zterm?.android?.relay || config.mobile?.relay || {};

  const host =
    asString(env.ZTERM_HOST) ||
    asString(env.HOST) ||
    asString(daemonConfig.host) ||
    DEFAULT_DAEMON_HOST;

  const port =
    asPositiveInteger(env.ZTERM_PORT) ||
    asPositiveInteger(env.PORT) ||
    asPositiveInteger(daemonConfig.port) ||
    DEFAULT_BRIDGE_PORT;

  const authTokenFromEnv = asString(env.ZTERM_AUTH_TOKEN);
  const authTokenFromConfig = asString(daemonConfig.authToken);
  const authToken = authTokenFromEnv || authTokenFromConfig || '';
  const authSource: DaemonRuntimeConfig['authSource'] = authTokenFromEnv
    ? 'env'
    : authTokenFromConfig
      ? 'config'
      : 'default';

  const terminalCacheLines =
    asPositiveInteger(env.ZTERM_TERMINAL_CACHE_LINES) ||
    asPositiveInteger(daemonConfig.terminalCacheLines) ||
    DEFAULT_DAEMON_TERMINAL_CACHE_LINES;

  const sessionName =
    asString(env.ZTERM_DAEMON_SESSION) ||
    asString(daemonConfig.sessionName) ||
    buildDaemonSessionName(port);

  const relayUrl = asString(env.ZTERM_TRAVERSAL_RELAY_URL) || asString(relayConfig.relayUrl);
  const relayUsername = asString(env.ZTERM_TRAVERSAL_USERNAME) || asString(relayConfig.username);
  const relayPassword = asString(env.ZTERM_TRAVERSAL_PASSWORD) || asString(relayConfig.password);
  const relayHostId = asString(env.ZTERM_TRAVERSAL_HOST_ID) || asString(relayConfig.hostId);
  const relayDefaultHostName = hostname().trim();
  const relayDeviceId =
    asString(env.ZTERM_TRAVERSAL_DEVICE_ID) ||
    asString(relayConfig.deviceId) ||
    relayDefaultHostName;
  const relayDeviceName =
    asString(env.ZTERM_TRAVERSAL_DEVICE_NAME) ||
    asString(relayConfig.deviceName) ||
    relayDefaultHostName;
  const relayPlatform =
    asString(env.ZTERM_TRAVERSAL_PLATFORM) ||
    asString(relayConfig.platform) ||
    process.platform;
  const relayAppVersion =
    asString(env.ZTERM_TRAVERSAL_APP_VERSION) ||
    asString(env.ZTERM_APP_VERSION) ||
    asString(relayConfig.appVersion);
  const relayDaemonVersion =
    asString(env.ZTERM_TRAVERSAL_DAEMON_VERSION) ||
    asString(env.ZTERM_DAEMON_VERSION) ||
    asString(relayConfig.daemonVersion) ||
    relayAppVersion;
  const relay = relayUrl && relayUsername && relayPassword && relayHostId
    ? {
        relayUrl,
        username: relayUsername,
        password: relayPassword,
        hostId: relayHostId,
        deviceId: relayDeviceId,
        deviceName: relayDeviceName,
        platform: relayPlatform,
        appVersion: relayAppVersion,
        daemonVersion: relayDaemonVersion,
      }
    : null;
  const daemonHostId = relay?.hostId || resolveStableDaemonHostId(homeDir);

  return {
    host,
    port,
    authToken,
    terminalCacheLines,
    sessionName,
    daemonHostId,
    configPath: path,
    configFound: found,
    authSource,
    relay,
  };
}
