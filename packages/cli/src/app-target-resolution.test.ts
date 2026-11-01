import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppCliError,
  resolveAppTargetFromDirectory,
  resolveLocalAppDaemonConfig,
} from './app-target-resolution.js';
import type {
  RelayAccountDirectory,
  RelayDirectoryDaemon,
  RelayDirectoryDevice,
  RelayEndpointCandidate,
} from '../../shared/src/connection/relay-directory.js';

interface FixtureOverrides {
  androidDaemon?: Record<string, unknown>;
  androidRelay?: Record<string, unknown>;
  mobileDaemon?: Record<string, unknown>;
  mobileRelay?: Record<string, unknown>;
}

function writeFixtureConfig(overrides: FixtureOverrides): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-app-target-'));
  const configDir = join(homeDir, '.zterm');
  mkdirSync(configDir, { recursive: true });
  const mobileDaemon = overrides.mobileDaemon ?? {
    host: '192.168.1.50',
    port: 9911,
    authToken: 'wterm-redacted-test-token',
  };
  const mobileRelay = overrides.mobileRelay ?? { deviceId: 'device-1', hostId: 'host-1' };
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      zterm: {
        android: {
          daemon: overrides.androidDaemon ?? {},
          relay: overrides.androidRelay ?? {},
        },
      },
      mobile: { daemon: mobileDaemon, relay: mobileRelay },
    }),
    'utf8',
  );
  return homeDir;
}

function thrownError(call: () => unknown): unknown {
  try {
    call();
    return undefined;
  } catch (error) {
    return error;
  }
}

function endpoint(
  id: string,
  kind: RelayEndpointCandidate['kind'],
  options: {
    host?: string;
    port?: number;
    wsUrl?: string;
    relayHostId?: string;
    authToken?: string;
  } = {},
): RelayEndpointCandidate {
  return {
    id,
    kind,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.wsUrl === undefined ? {} : { wsUrl: options.wsUrl }),
    ...(options.relayHostId === undefined ? {} : { relayHostId: options.relayHostId }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    authRequired: true,
    lastSeenAt: '2026-11-01T00:00:00.000Z',
  };
}

function directoryFixture(endpoints: RelayEndpointCandidate[]): RelayAccountDirectory {
  const daemon: RelayDirectoryDaemon = {
    hostId: 'host-1',
    version: '0.1.4',
    presence: { connected: true, lastSeenAt: '2026-11-01T00:00:00.000Z' },
    endpoints,
    sessions: [],
    lastPublishedAt: '2026-11-01T00:00:00.000Z',
  };
  const device: RelayDirectoryDevice = {
    deviceId: 'device-1',
    deviceName: 'peer',
    platform: 'android',
    appVersion: '0.1.4',
    client: { connected: true, lastSeenAt: '2026-11-01T00:00:00.000Z' },
    daemon,
  };
  return {
    schemaVersion: 1,
    user: { id: 'user-1', username: 'owner' },
    devices: [device],
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

describe('resolveLocalAppDaemonConfig', () => {
  it('resolves the legacy mobile token when the new-style token is an empty string', () => {
    const homeDir = writeFixtureConfig({ androidDaemon: { authToken: '' } });
    const resolved = resolveLocalAppDaemonConfig({ homeDir, env: {} });
    expect(resolved.authToken).toBe('wterm-redacted-test-token');
    expect(resolved.host).toBe('192.168.1.50');
    expect(resolved.port).toBe(9911);
    expect(resolved.deviceId).toBe('device-1');
    expect(resolved.daemonHostId).toBe('host-1');
  });

  it('resolves daemon fields independently, falling back to mobile per field', () => {
    const homeDir = writeFixtureConfig({
      androidDaemon: { host: '127.0.0.2', port: '', authToken: '' },
      mobileDaemon: { host: '192.168.1.50', port: 9911, authToken: 'wterm-redacted-test-token' },
    });
    const resolved = resolveLocalAppDaemonConfig({ homeDir, env: {} });
    expect(resolved.host).toBe('127.0.0.2');
    expect(resolved.port).toBe(9911);
    expect(resolved.authToken).toBe('wterm-redacted-test-token');
  });

  it('resolves relay identity fields independently', () => {
    const homeDir = writeFixtureConfig({
      androidRelay: { deviceId: 'device-2' },
      mobileRelay: { deviceId: 'device-1', hostId: 'host-2' },
    });
    const resolved = resolveLocalAppDaemonConfig({ homeDir, env: {} });
    expect(resolved.deviceId).toBe('device-2');
    expect(resolved.daemonHostId).toBe('host-2');
  });

  it('keeps missing_auth_token when neither new-style nor legacy token is configured', () => {
    const homeDir = writeFixtureConfig({
      androidDaemon: { host: '127.0.0.2' },
      mobileDaemon: { host: '192.168.1.50' },
    });
    const error = thrownError(() => resolveLocalAppDaemonConfig({ homeDir, env: {} }));
    expect(error).toBeInstanceOf(AppCliError);
    expect((error as AppCliError).code).toBe('missing_auth_token');
  });

  it('keeps missing_identity when no relay identity is configured', () => {
    const homeDir = writeFixtureConfig({ mobileRelay: {} });
    const error = thrownError(() => resolveLocalAppDaemonConfig({ homeDir, env: {} }));
    expect(error).toBeInstanceOf(AppCliError);
    expect((error as AppCliError).code).toBe('missing_identity');
  });
});

describe('resolveAppTargetFromDirectory multi-endpoint resolution', () => {
  it('keeps only direct /app candidates and orders lan before tailscale', () => {
    const directory = directoryFixture([
      endpoint('lan', 'lan', { wsUrl: 'ws://192.168.1.10:3333/old', authToken: 'lan-token' }),
      endpoint('rtc', 'rtc-direct', { host: '1.2.3.4', port: 3333 }),
      endpoint('tailscale', 'tailscale', { wsUrl: 'ws://100.86.84.63:3333/old', authToken: 'ts-token' }),
      endpoint('relay', 'relay-rtc', { relayHostId: 'relay-1' }),
    ]);

    const target = resolveAppTargetFromDirectory({ directory, peerDeviceId: 'device-1' });

    expect(target).toMatchObject({
      deviceId: 'device-1',
      daemonHostId: 'host-1',
      wsUrl: 'ws://192.168.1.10:3333/app',
      authToken: 'lan-token',
    });
    expect(target.endpoints).toEqual([
      { kind: 'lan', wsUrl: 'ws://192.168.1.10:3333/app', authToken: 'lan-token' },
      { kind: 'tailscale', wsUrl: 'ws://100.86.84.63:3333/app', authToken: 'ts-token' },
    ]);
    expect(target.wsUrl).toBe(target.endpoints?.[0]?.wsUrl);
    expect(target.authToken).toBe(target.endpoints?.[0]?.authToken);
  });

  it('orders direct candidates by priority while preserving intra-tier order and deduplicating URLs', () => {
    const directory = directoryFixture([
      endpoint('tailscale', 'tailscale', { wsUrl: 'ws://100.86.84.63:3333/app' }),
      endpoint('lan', 'lan', { wsUrl: 'ws://192.168.1.10:3333/app' }),
      endpoint('ipv4-a', 'ipv4', { wsUrl: 'ws://10.0.0.5:3333/app?x=1' }),
      endpoint('ipv4-b', 'ipv4', { wsUrl: 'ws://10.0.0.5:3333/app?y=2' }),
      endpoint('rtc', 'rtc-direct', { host: '1.2.3.4', port: 3333 }),
    ]);

    const target = resolveAppTargetFromDirectory({ directory, peerDeviceId: 'device-1' });

    expect(target.endpoints?.map((candidate) => candidate.kind)).toEqual(['lan', 'ipv4', 'tailscale']);
    expect(target.endpoints?.map((candidate) => candidate.wsUrl)).toEqual([
      'ws://192.168.1.10:3333/app',
      'ws://10.0.0.5:3333/app',
      'ws://100.86.84.63:3333/app',
    ]);
  });

  it('throws no_direct_endpoint when every published endpoint is ineligible', () => {
    const directory = directoryFixture([
      endpoint('rtc', 'rtc-direct', { host: '1.2.3.4', port: 3333 }),
      endpoint('relay', 'relay-rtc', { relayHostId: 'relay-1' }),
    ]);

    const error = thrownError(() => resolveAppTargetFromDirectory({ directory, peerDeviceId: 'device-1' }));
    expect(error).toBeInstanceOf(AppCliError);
    expect((error as AppCliError).code).toBe('no_direct_endpoint');
  });
});
