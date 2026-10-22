import {
  buildDaemonSessionName,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_DAEMON_HOST,
} from '../connection/mobile-config';
import type { ConfigSnapshot, JsonObject, SharedConfigStore } from './shared-config';

export type DaemonConfigSource = 'env' | 'file' | 'default';

export interface DaemonConfigValue<T> {
  value: T;
  source: DaemonConfigSource;
  sourceName: string;
}

export interface DaemonConfigAuthProjection {
  configured: boolean;
  source: DaemonConfigSource;
  sourceName: string;
}

export interface DaemonConfigProjection {
  configPath: string;
  configFound: boolean;
  runtimeLoaded: 'unknown';
  host: DaemonConfigValue<string>;
  port: DaemonConfigValue<number>;
  sessionName: DaemonConfigValue<string>;
  cacheLines: DaemonConfigValue<number>;
  auth: DaemonConfigAuthProjection;
}

type DaemonEnvironment = Record<string, string | undefined>;

const DEFAULT_DAEMON_CACHE_LINES = 3000;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function nestedObject(value: unknown, keys: string[]) {
  let current = value;
  for (const key of keys) {
    if (!isJsonObject(current)) {
      return {};
    }
    current = current[key];
  }
  return isJsonObject(current) ? current : {};
}

function fromEnvironment(
  env: DaemonEnvironment,
  primaryName: string,
  fallbackName?: string,
) {
  const primary = asString(env[primaryName]);
  if (primary) {
    return { value: primary, source: 'env' as const, sourceName: primaryName };
  }
  if (fallbackName) {
    const fallback = asString(env[fallbackName]);
    if (fallback) {
      return { value: fallback, source: 'env' as const, sourceName: fallbackName };
    }
  }
  return undefined;
}

function positiveEnvironment(
  env: DaemonEnvironment,
  primaryName: string,
  fallbackName?: string,
) {
  const primary = asPositiveInteger(env[primaryName]);
  if (primary !== undefined) {
    return { value: primary, source: 'env' as const, sourceName: primaryName };
  }
  if (fallbackName) {
    const fallback = asPositiveInteger(env[fallbackName]);
    if (fallback !== undefined) {
      return { value: fallback, source: 'env' as const, sourceName: fallbackName };
    }
  }
  return undefined;
}

function fileString(
  ztermDaemon: JsonObject,
  mobileDaemon: JsonObject,
  key: string,
  ztermSourceName: string,
  mobileSourceName: string,
) {
  const ztermValue = asString(ztermDaemon[key]);
  if (ztermValue) {
    return { value: ztermValue, source: 'file' as const, sourceName: ztermSourceName };
  }
  const mobileValue = asString(mobileDaemon[key]);
  if (mobileValue) {
    return { value: mobileValue, source: 'file' as const, sourceName: mobileSourceName };
  }
  return undefined;
}

function filePositiveInteger(
  ztermDaemon: JsonObject,
  mobileDaemon: JsonObject,
  key: string,
  ztermSourceName: string,
  mobileSourceName: string,
) {
  const ztermValue = asPositiveInteger(ztermDaemon[key]);
  if (ztermValue !== undefined) {
    return { value: ztermValue, source: 'file' as const, sourceName: ztermSourceName };
  }
  const mobileValue = asPositiveInteger(mobileDaemon[key]);
  if (mobileValue !== undefined) {
    return { value: mobileValue, source: 'file' as const, sourceName: mobileSourceName };
  }
  return undefined;
}

export function projectDaemonConfig(
  snapshot: ConfigSnapshot,
  env: DaemonEnvironment = process.env,
): DaemonConfigProjection {
  const zterm = nestedObject(snapshot.config, ['zterm']);
  const android = nestedObject(zterm, ['android']);
  const ztermDaemon = nestedObject(android, ['daemon']);
  const mobile = nestedObject(snapshot.config, ['mobile']);
  const mobileDaemon = nestedObject(mobile, ['daemon']);

  const host =
    fromEnvironment(env, 'ZTERM_HOST', 'HOST') ??
    fileString(
      ztermDaemon,
      mobileDaemon,
      'host',
      'zterm.android.daemon.host',
      'mobile.daemon.host',
    ) ??
    {
      value: DEFAULT_DAEMON_HOST,
      source: 'default' as const,
      sourceName: 'default',
    };

  const port =
    positiveEnvironment(env, 'ZTERM_PORT', 'PORT') ??
    filePositiveInteger(
      ztermDaemon,
      mobileDaemon,
      'port',
      'zterm.android.daemon.port',
      'mobile.daemon.port',
    ) ??
    {
      value: DEFAULT_BRIDGE_PORT,
      source: 'default' as const,
      sourceName: 'default',
    };

  const authTokenFromEnv = asString(env.ZTERM_AUTH_TOKEN);
  const auth: DaemonConfigAuthProjection = authTokenFromEnv
    ? { configured: true, source: 'env', sourceName: 'ZTERM_AUTH_TOKEN' }
    : asString(ztermDaemon.authToken)
      ? {
          configured: true,
          source: 'file',
          sourceName: 'zterm.android.daemon.authToken',
        }
      : asString(mobileDaemon.authToken)
        ? {
            configured: true,
            source: 'file',
            sourceName: 'mobile.daemon.authToken',
          }
        : { configured: false, source: 'default', sourceName: 'default' };

  const sessionName =
    fromEnvironment(env, 'ZTERM_DAEMON_SESSION') ??
    fileString(
      ztermDaemon,
      mobileDaemon,
      'sessionName',
      'zterm.android.daemon.sessionName',
      'mobile.daemon.sessionName',
    ) ??
    {
      value: buildDaemonSessionName(port.value),
      source: 'default' as const,
      sourceName: 'default',
    };

  const cacheLines =
    positiveEnvironment(env, 'ZTERM_TERMINAL_CACHE_LINES') ??
    filePositiveInteger(
      ztermDaemon,
      mobileDaemon,
      'terminalCacheLines',
      'zterm.android.daemon.terminalCacheLines',
      'mobile.daemon.terminalCacheLines',
    ) ??
    {
      value: DEFAULT_DAEMON_CACHE_LINES,
      source: 'default' as const,
      sourceName: 'default',
    };

  return {
    configPath: snapshot.path,
    configFound: snapshot.found,
    runtimeLoaded: 'unknown',
    host,
    port,
    sessionName,
    cacheLines,
    auth,
  };
}

export async function readDaemonConfigProjection(
  store: SharedConfigStore,
  env: DaemonEnvironment = process.env,
) {
  return projectDaemonConfig(await store.read(), env);
}
