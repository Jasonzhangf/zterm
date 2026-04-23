import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT, DEFAULT_DAEMON_HOST } from '../lib/mobile-config';
import { DEFAULT_DAEMON_TERMINAL_CACHE_LINES, getWtermConfigPath, resolveDaemonRuntimeConfig } from './daemon-config';

const tempDirs: string[] = [];

function createTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'zterm-daemon-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(homeDir: string, body: unknown) {
  const configPath = getWtermConfigPath(homeDir);
  mkdirSync(join(homeDir, '.wterm'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(body, null, 2));
  return configPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('daemon config', () => {
  it('reads auth token and port from ~/.wterm/config.json', () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, {
      zterm: {
        android: {
          daemon: {
          host: '0.0.0.0',
          port: 4567,
          authToken: 'config-token',
          terminalCacheLines: 4096,
          },
        },
      },
    });

    const config = resolveDaemonRuntimeConfig({ env: {}, homeDir });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4567);
    expect(config.authToken).toBe('config-token');
    expect(config.authSource).toBe('config');
    expect(config.terminalCacheLines).toBe(4096);
    expect(config.configFound).toBe(true);
  });

  it('lets env override ~/.wterm/config.json', () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, {
      zterm: {
        android: {
          daemon: {
          host: '0.0.0.0',
          port: 4567,
          authToken: 'config-token',
          },
        },
      },
    });

    const config = resolveDaemonRuntimeConfig({
      env: {
        ZTERM_HOST: '127.0.0.1',
        ZTERM_PORT: '5678',
        ZTERM_AUTH_TOKEN: 'env-token',
      },
      homeDir,
    });

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(5678);
    expect(config.authToken).toBe('env-token');
    expect(config.authSource).toBe('env');
  });

  it('falls back to defaults when ~/.wterm/config.json is absent', () => {
    const homeDir = createTempHome();
    const config = resolveDaemonRuntimeConfig({ env: {}, homeDir });

    expect(config.host).toBe(DEFAULT_DAEMON_HOST);
    expect(config.port).toBe(DEFAULT_BRIDGE_PORT);
    expect(config.authToken).toBe('');
    expect(config.authSource).toBe('default');
    expect(config.terminalCacheLines).toBe(DEFAULT_DAEMON_TERMINAL_CACHE_LINES);
    expect(config.configFound).toBe(false);
  });
});
