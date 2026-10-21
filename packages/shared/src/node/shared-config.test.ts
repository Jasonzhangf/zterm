import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigStoreError,
  SharedConfigStore,
  getSharedConfigPath,
} from './shared-config';

const tempHomes: string[] = [];
const sharedPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function createTempHome() {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-shared-config-'));
  tempHomes.push(homeDir);
  return homeDir;
}

function writeConfig(homeDir: string, body: unknown, mode = 0o600) {
  const configPath = getSharedConfigPath(homeDir);
  mkdirSync(join(homeDir, '.zterm'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(body, null, 2)}\n`, { mode });
  chmodSync(configPath, mode);
  return configPath;
}

function runWriter(homeDir: string, marker: string, delayMs: number) {
  const script = `
    const { SharedConfigStore } = await import(process.env.TEST_CONFIG_MODULE);
    const store = new SharedConfigStore({ homeDir: process.env.TEST_HOME });
    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    await store.update((latest) => {
      latest.collaborators = latest.collaborators && typeof latest.collaborators === 'object'
        ? latest.collaborators
        : {};
      latest.collaborators[${JSON.stringify(marker)}] = { marker: ${JSON.stringify(marker)} };
      return { value: undefined, changed: true };
    }, new AbortController().signal);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: sharedPackageRoot,
    env: {
      ...process.env,
      TEST_HOME: homeDir,
      TEST_CONFIG_MODULE: pathToFileURL(
        join(sharedPackageRoot, 'src', 'node', 'shared-config.ts'),
      ).href,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childEvents = child as typeof child & {
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
  };
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise<void>((resolve, reject) => {
    childEvents.on('error', reject);
    childEvents.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`writer ${marker} exited ${code}: ${stderr}`));
      }
    });
  });
}

afterEach(() => {
  while (tempHomes.length > 0) {
    rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe('SharedConfigStore', () => {
  it('reads the canonical path without creating a file', async () => {
    const homeDir = createTempHome();
    const store = new SharedConfigStore({ homeDir });

    await expect(store.read()).resolves.toEqual({
      path: join(homeDir, '.zterm', 'config.json'),
      found: false,
      config: {},
    });
    expect(existsSync(join(homeDir, '.zterm'))).toBe(false);
  });

  it('refuses to overwrite invalid JSON and reports the original file', async () => {
    const homeDir = createTempHome();
    const configPath = getSharedConfigPath(homeDir);
    mkdirSync(join(homeDir, '.zterm'), { recursive: true });
    writeFileSync(configPath, '{"zterm":', { mode: 0o600 });
    const store = new SharedConfigStore({ homeDir });

    await expect(store.update(() => ({
      value: undefined,
      changed: true,
    }), new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_json',
      path: configPath,
    });
    expect(readFileSync(configPath, 'utf8')).toBe('{"zterm":');
  });

  it('serializes cooperating writers and preserves unknown plus daemon fields', async () => {
    const homeDir = createTempHome();
    writeConfig(homeDir, {
      zterm: {
        android: {
          daemon: {
            host: '127.0.0.1',
            port: 4567,
            authToken: 'daemon-token',
            futureDaemonField: { keep: true },
          },
        },
        cli: {
          slots: {
            '1': { session: { name: 'existing' } },
          },
          unknownCliField: ['keep'],
        },
      },
      unrelated: { nested: { keep: 'yes' } },
    });

    await Promise.all([
      runWriter(homeDir, 'alpha', 0),
      runWriter(homeDir, 'beta', 5),
    ]);

    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));
    expect(parsed.zterm.android.daemon).toEqual({
      host: '127.0.0.1',
      port: 4567,
      authToken: 'daemon-token',
      futureDaemonField: { keep: true },
    });
    expect(parsed.zterm.cli.slots['1'].session.name).toBe('existing');
    expect(parsed.zterm.cli.unknownCliField).toEqual(['keep']);
    expect(parsed.unrelated).toEqual({ nested: { keep: 'yes' } });
    expect(parsed.collaborators).toEqual({
      alpha: { marker: 'alpha' },
      beta: { marker: 'beta' },
    });
    expect(statSync(getSharedConfigPath(homeDir)).mode & 0o777).toBe(0o600);
  });

  it('does not steal an existing lock and reports its recovery path', async () => {
    const homeDir = createTempHome();
    const store = new SharedConfigStore({
      homeDir,
      lockTimeoutMs: 40,
      lockRetryMs: 10,
    });
    mkdirSync(join(homeDir, '.zterm'), { recursive: true });
    const lockPath = `${getSharedConfigPath(homeDir)}.lock`;
    writeFileSync(lockPath, 'pid=1234\n', { mode: 0o600 });

    const error = await store.update(() => ({
      value: undefined,
      changed: true,
    }), new AbortController().signal).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigStoreError);
    expect(Object.getOwnPropertyDescriptor(error, 'cause')).toEqual({
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    expect(error).toMatchObject({
      code: 'config_busy',
      lockPath,
    });
    expect(existsSync(lockPath)).toBe(true);
  });
});
