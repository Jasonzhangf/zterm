import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
} from '../lib/mobile-config';

export const DEFAULT_DAEMON_TERMINAL_CACHE_LINES = 3000;

export const WTERM_HOME_DIRNAME = '.wterm';
export const WTERM_CONFIG_FILENAME = 'config.json';
export const WTERM_UPDATES_DIRNAME = 'updates';

interface WtermConfigFile {
  mobile?: {
    daemon?: {
      host?: unknown;
      port?: unknown;
      authToken?: unknown;
      terminalCacheLines?: unknown;
      sessionName?: unknown;
    };
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
    };
  };
}

export interface DaemonRuntimeConfig {
  host: string;
  port: number;
  authToken: string;
  terminalCacheLines: number;
  sessionName: string;
  configPath: string;
  configFound: boolean;
  authSource: 'env' | 'config' | 'default';
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

  return {
    host,
    port,
    authToken,
    terminalCacheLines,
    sessionName,
    configPath: path,
    configFound: found,
    authSource,
  };
}
