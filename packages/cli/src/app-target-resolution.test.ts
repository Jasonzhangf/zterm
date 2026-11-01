import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppCliError,
  resolveLocalAppDaemonConfig,
} from './app-target-resolution.js';

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
    authToken: 'wterm-4123456',
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

describe('resolveLocalAppDaemonConfig', () => {
  it('resolves the legacy mobile token when the new-style token is an empty string', () => {
    const homeDir = writeFixtureConfig({ androidDaemon: { authToken: '' } });
    const resolved = resolveLocalAppDaemonConfig({ homeDir, env: {} });
    expect(resolved.authToken).toBe('wterm-4123456');
    expect(resolved.host).toBe('192.168.1.50');
    expect(resolved.port).toBe(9911);
    expect(resolved.deviceId).toBe('device-1');
    expect(resolved.daemonHostId).toBe('host-1');
  });

  it('resolves daemon fields independently, falling back to mobile per field', () => {
    const homeDir = writeFixtureConfig({
      androidDaemon: { host: '127.0.0.2', port: '', authToken: '' },
      mobileDaemon: { host: '192.168.1.50', port: 9911, authToken: 'wterm-4123456' },
    });
    const resolved = resolveLocalAppDaemonConfig({ homeDir, env: {} });
    expect(resolved.host).toBe('127.0.0.2');
    expect(resolved.port).toBe(9911);
    expect(resolved.authToken).toBe('wterm-4123456');
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
