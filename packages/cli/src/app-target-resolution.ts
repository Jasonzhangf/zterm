import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedAccount, AccountClient } from './account-client.js';
import type { StoredCliAuth } from './commands/auth.js';
import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayDirectoryDevice,
  RelayEndpointCandidate,
} from '../../shared/src/connection/relay-directory.js';
import { DEFAULT_BRIDGE_PORT } from '../../shared/src/connection/mobile-config.js';
import type { AppTarget } from '../../shared/src/connection/app-protocol.js';

export class AppCliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = 'AppCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface LocalAppDaemonConfig {
  host: string;
  port: number;
  authToken: string;
  deviceId: string;
  daemonHostId: string;
  configPath: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function readDaemonId(readOnlyHomeDir: string): string {
  const daemonIdPath = join(readOnlyHomeDir, '.zterm', 'daemon-id');
  if (!existsSync(daemonIdPath)) return '';
  return text(readFileSync(daemonIdPath, 'utf8'));
}

/**
 * Read-only projection of the daemon config used by the CLI. This must not
 * create `~/.zterm`, a daemon id, or any account state. Missing identity is an
 * explicit typed error.
 */
export function resolveLocalAppDaemonConfig(options?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): LocalAppDaemonConfig {
  const home = options?.homeDir ?? homedir();
  const env = options?.env ?? process.env;
  const configPath = join(home, '.zterm', 'config.json');
  let config: JsonObject = {};
  if (existsSync(configPath)) {
    try {
      config = object(JSON.parse(readFileSync(configPath, 'utf8')));
    } catch (error) {
      throw new AppCliError(
        'config_invalid',
        `cannot read daemon config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const zterm = object(config.zterm);
  const android = object(zterm.android);
  const mobile = object(config.mobile);
  const daemon = Object.keys(object(android.daemon)).length > 0
    ? object(android.daemon)
    : object(mobile.daemon);
  const relay = Object.keys(object(android.relay)).length > 0
    ? object(android.relay)
    : object(mobile.relay);
  const host = text(env.ZTERM_HOST) || text(env.HOST) || text(daemon.host) || '0.0.0.0';
  const port = positiveInteger(env.ZTERM_PORT)
    ?? positiveInteger(env.PORT)
    ?? positiveInteger(daemon.port)
    ?? DEFAULT_BRIDGE_PORT;
  const authToken = text(env.ZTERM_AUTH_TOKEN) || text(daemon.authToken);
  if (!authToken) {
    throw new AppCliError(
      'missing_auth_token',
      '/app requires a configured daemon token; set zterm.android.daemon.authToken',
    );
  }
  const deviceId = text(env.ZTERM_TRAVERSAL_DEVICE_ID) || text(relay.deviceId);
  if (!deviceId) {
    throw new AppCliError(
      'missing_identity',
      'local deviceId is missing; configure zterm.android.relay.deviceId',
    );
  }
  const daemonHostId = text(env.ZTERM_TRAVERSAL_HOST_ID) || text(relay.hostId) || readDaemonId(home);
  if (!daemonHostId) {
    throw new AppCliError(
      'missing_identity',
      'local daemonHostId is missing; configure zterm.android.relay.hostId or an existing daemon-id file',
    );
  }
  return { host, port, authToken, deviceId, daemonHostId, configPath };
}

function loopbackHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '[::]' || !host) return '127.0.0.1';
  return host;
}

function hostForUrl(host: string): string {
  const normalized = loopbackHost(host);
  return normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
}

export function buildLocalAppUrl(config: Pick<LocalAppDaemonConfig, 'host' | 'port'>): string {
  return `ws://${hostForUrl(config.host)}:${config.port}/app`;
}

function exactDevice(directory: RelayAccountDirectory, peerDeviceId: string): RelayDirectoryDevice {
  const matches = directory.devices.filter((device) => device.deviceId === peerDeviceId);
  if (matches.length === 0) {
    throw new AppCliError('peer_not_found', `peer device not found: ${peerDeviceId}`);
  }
  if (matches.length > 1) {
    throw new AppCliError('peer_ambiguous', `peer device is ambiguous: ${peerDeviceId}`);
  }
  return matches[0]!;
}

function directEndpoint(daemon: RelayDirectoryDaemon): RelayEndpointCandidate | undefined {
  return daemon.endpoints.find((endpoint) => {
    if (endpoint.kind === 'rtc-direct' || endpoint.kind === 'relay-rtc') return false;
    if (endpoint.wsUrl) return true;
    return Boolean(endpoint.host);
  });
}

function endpointUrl(endpoint: RelayEndpointCandidate): string {
  const raw = endpoint.wsUrl
    ? endpoint.wsUrl
    : `ws://${(endpoint.host ?? '').includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port ?? DEFAULT_BRIDGE_PORT}`;
  const url = new URL(raw);
  url.pathname = '/app';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function resolveAppTargetFromDirectory(input: {
  directory: RelayAccountDirectory;
  peerDeviceId: string;
  daemonHostId?: string;
}): AppTarget {
  const device = exactDevice(input.directory, input.peerDeviceId);
  if (!device.daemon) {
    throw new AppCliError('unreachable', `peer daemon is not published: ${input.peerDeviceId}`);
  }
  if (input.daemonHostId && device.daemon.hostId !== input.daemonHostId) {
    throw new AppCliError('peer_identity_mismatch', 'daemonHostId does not match the resolved peer daemon');
  }
  const endpoint = directEndpoint(device.daemon);
  if (!endpoint) {
    throw new AppCliError('no_direct_endpoint', `peer daemon has no LAN, Tailscale, IPv4, or IPv6 /app endpoint: ${input.peerDeviceId}`);
  }
  return {
    deviceId: device.deviceId,
    daemonHostId: device.daemon.hostId,
    wsUrl: endpointUrl(endpoint),
    authToken: endpoint.authToken ?? '',
  };
}

export async function resolveAppTarget(input: {
  auth: StoredCliAuth;
  accountClient: Pick<AccountClient, 'me' | 'directory'>;
  peerDeviceId: string;
  daemonHostId?: string;
  signal: AbortSignal;
}): Promise<AppTarget> {
  const account: AuthenticatedAccount = await input.accountClient.me(
    { relayBaseUrl: input.auth.relayBaseUrl, accessToken: input.auth.accessToken },
    input.signal,
  );
  if (account.user.id !== input.auth.userId) {
    throw new AppCliError('auth_account_changed', 'current account differs from the stored CLI login');
  }
  const directory = await input.accountClient.directory(
    { relayBaseUrl: input.auth.relayBaseUrl, accessToken: input.auth.accessToken },
    input.signal,
  );
  if (directory.user.id !== input.auth.userId) {
    throw new AppCliError('auth_account_changed', 'account directory does not belong to the stored CLI login');
  }
  return resolveAppTargetFromDirectory({
    directory,
    peerDeviceId: input.peerDeviceId,
    daemonHostId: input.daemonHostId,
  });
}
