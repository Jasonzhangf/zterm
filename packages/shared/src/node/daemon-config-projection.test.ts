import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectDaemonConfig,
  readDaemonConfigProjection,
} from './daemon-config-projection';
import { SharedConfigStore, getSharedConfigPath } from './shared-config';

const tempHomes: string[] = [];

function createTempHome() {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-daemon-projection-'));
  tempHomes.push(homeDir);
  return homeDir;
}

function writeConfig(homeDir: string, body: unknown) {
  mkdirSync(join(homeDir, '.zterm'), { recursive: true });
  writeFileSync(getSharedConfigPath(homeDir), JSON.stringify(body), { mode: 0o600 });
}

afterEach(() => {
  while (tempHomes.length > 0) {
    rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe('daemon config projection', () => {
  it('reports file, environment, compatibility, and default sources without claiming loaded runtime state', async () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, {
      zterm: {
        android: {
          daemon: {
            host: 'file-host',
            port: 4000,
            sessionName: 'file-session',
            terminalCacheLines: 4100,
            authToken: 'file-auth-token',
          },
        },
      },
      mobile: {
        daemon: {
          port: 5000,
          sessionName: 'mobile-session',
          terminalCacheLines: 5100,
          authToken: 'mobile-auth-token',
        },
      },
    });
    const store = new SharedConfigStore({ homeDir });

    const projection = await readDaemonConfigProjection(store, {
      ZTERM_HOST: 'env-host',
    });

    expect(projection.configPath).toBe(getSharedConfigPath(homeDir));
    expect(projection.configFound).toBe(true);
    expect(projection.runtimeLoaded).toBe('unknown');
    expect(projection.host).toEqual({
      value: 'env-host',
      source: 'env',
      sourceName: 'ZTERM_HOST',
    });
    expect(projection.port).toEqual({
      value: 4000,
      source: 'file',
      sourceName: 'zterm.android.daemon.port',
    });
    expect(projection.sessionName).toEqual({
      value: 'file-session',
      source: 'file',
      sourceName: 'zterm.android.daemon.sessionName',
    });
    expect(projection.cacheLines).toEqual({
      value: 4100,
      source: 'file',
      sourceName: 'zterm.android.daemon.terminalCacheLines',
    });
    expect(projection.auth).toEqual({
      configured: true,
      source: 'file',
      sourceName: 'zterm.android.daemon.authToken',
    });
  });

  it('falls back to mobile daemon fields and defaults', async () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, {
      mobile: {
        daemon: {
          host: 'mobile-host',
          port: '6123',
          terminalCacheLines: '2200',
        },
      },
    });
    const store = new SharedConfigStore({ homeDir });

    const projection = await readDaemonConfigProjection(store, {});

    expect(projection.host.sourceName).toBe('mobile.daemon.host');
    expect(projection.port).toMatchObject({ value: 6123, source: 'file' });
    expect(projection.cacheLines).toMatchObject({ value: 2200, source: 'file' });
    expect(projection.sessionName).toEqual({
      value: 'zterm-daemon-6123',
      source: 'default',
      sourceName: 'default',
    });
    expect(projection.auth).toEqual({
      configured: false,
      source: 'default',
      sourceName: 'default',
    });
  });

  it('emits only the daemon whitelist and never serializes credentials or unknown fields', () => {
    const projection = projectDaemonConfig({
      path: '/tmp/config.json',
      found: true,
      config: {
        zterm: {
          android: {
            daemon: {
              host: '0.0.0.0',
              authToken: 'daemon-secret',
            },
            relay: {
              password: 'relay-secret',
            },
          },
          cli: {
            auth: {
              accessToken: 'account-secret',
            },
            unknownCliField: 'unknown-secret',
          },
        },
        mobile: {
          relay: {
            password: 'mobile-relay-secret',
          },
        },
        unknownRoot: {
          token: 'root-secret',
        },
      },
    }, {});
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain('daemon-secret');
    expect(serialized).not.toContain('relay-secret');
    expect(serialized).not.toContain('account-secret');
    expect(serialized).not.toContain('mobile-relay-secret');
    expect(serialized).not.toContain('root-secret');
    expect(serialized).not.toContain('accessToken');
    expect(serialized).not.toContain('password');
  });
});
