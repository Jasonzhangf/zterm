import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountClient, AuthenticatedAccount } from './account-client.js';
import type {
  SessionChannel,
  SessionConnection,
  SessionConnectionEvent,
} from './connection.js';
import { runMain } from './main.js';
import type { PromptPort } from './prompts.js';
import type { CliSlotBinding } from './slot-store.js';
import {
  SharedConfigStore,
  getSharedConfigPath,
} from '../../shared/src/node/shared-config.js';

class TestPrompts implements PromptPort {
  text = vi.fn(async () => '');
  password = vi.fn(async () => '');
  async select<T>(
    _message: string,
    choices: readonly { label: string; value: T }[],
  ): Promise<T> {
    const first = choices[0];
    if (!first) throw new Error('test prompt has no choices');
    return first.value;
  }
  confirm = vi.fn(async () => false);
}

function outputCapture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    read: () => text,
  };
}

function account(accessToken = 'account-access-secret'): AuthenticatedAccount {
  return {
    relayBaseUrl: 'https://relay.example.test/zterm/',
    accessToken,
    user: {
      id: 'user-1',
      username: 'jason',
    },
    directory: {
      schemaVersion: 1,
      user: {
        id: 'user-1',
        username: 'jason',
      },
      devices: [],
      updatedAt: '2026-10-20T00:00:00.000Z',
    },
  };
}

function boundBinding(): CliSlotBinding {
  return {
    account: {
      relayBaseUrl: 'https://relay.example.test/zterm/',
      userId: 'user-1',
    },
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
      displayName: 'Mac Studio',
    },
    session: {
      backend: 'tmux',
      stableId: 'stable-1',
      name: 'work',
    },
    widthMode: 'adaptive-phone',
  };
}

function accountWithBoundServer(): AuthenticatedAccount {
  const value = account();
  return {
    ...value,
    directory: {
      ...value.directory,
      devices: [{
        deviceId: 'device-1',
        deviceName: 'Mac Studio',
        platform: 'darwin',
        appVersion: '1.0.0',
        client: {
          connected: true,
          lastSeenAt: '2026-10-20T00:00:00.000Z',
        },
        daemon: {
          hostId: 'daemon-1',
          version: '1.0.0',
          presence: {
            connected: true,
            lastSeenAt: '2026-10-20T00:00:00.000Z',
          },
          endpoints: [],
          sessions: [],
          lastPublishedAt: '2026-10-20T00:00:00.000Z',
        },
      }],
    },
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function testStore() {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-main-'));
  cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
  return {
    homeDir,
    store: new SharedConfigStore({ homeDir }),
  };
}

describe('zterm public main contract', () => {
  it('serves help and version without reading or creating shared config', async () => {
    const { homeDir, store } = testStore();
    const stdout = outputCapture();
    const stderr = outputCapture();

    await expect(runMain(['--help'], {
      store,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    })).resolves.toBe(0);
    expect(stdout.read()).toContain('zterm <1..20>');
    expect(stdout.read()).toContain('zterm daemon install');
    expect(stderr.read()).toBe('');

    const versionStdout = outputCapture();
    await expect(runMain(['--version'], {
      store,
      stdout: versionStdout.stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    })).resolves.toBe(0);
    expect(versionStdout.read()).toMatch(/^zterm \d+\.\d+\.\d+\n$/);
    expect(() => readFileSync(getSharedConfigPath(homeDir), 'utf8')).toThrow();
  });

  it('rejects an invalid numbered slot with usage exit code 2', async () => {
    const { homeDir, store } = testStore();
    const stdout = outputCapture();
    const stderr = outputCapture();

    const exitCode = await runMain(['21'], {
      store,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(2);
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('槽位编号必须是 1 到 20 的整数');
  });

  it('lists an empty local slot store without login or a config write', async () => {
    const { homeDir, store } = testStore();
    const stdout = outputCapture();

    const exitCode = await runMain(['slot', 'list'], {
      store,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain('没有已配置的槽位');
    expect(() => readFileSync(getSharedConfigPath(homeDir), 'utf8')).toThrow();
  });

  it('returns the local no-slot failure for a no-argument launch', async () => {
    const { homeDir, store } = testStore();
    const stdout = outputCapture();
    const stderr = outputCapture();

    const exitCode = await runMain([], {
      store,
      prompts: new TestPrompts(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('没有已配置的槽位');
    expect(() => readFileSync(getSharedConfigPath(homeDir), 'utf8')).toThrow();
  });

  it('returns a real auth-required failure for slot set without login', async () => {
    const { store } = testStore();
    const stderr = outputCapture();

    const exitCode = await runMain(['slot', 'set', '1'], {
      store,
      prompts: new TestPrompts(),
      stdout: outputCapture().stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(1);
    expect(stderr.read()).toContain('尚未登录');
    expect(stderr.read()).toContain('zterm login');
  });

  it('wires config login and local logout without projecting secrets', async () => {
    const { homeDir, store } = testStore();
    const secret = 'account-access-secret';
    await store.update((config) => {
      config.zterm = {
        cli: {
          server: { relayBaseUrl: 'https://relay.example.test/zterm/' },
          loginInput: { username: 'jason', password: 'one-shot-secret' },
        },
      };
      return { value: undefined, changed: true };
    });
    const accountClient = {
      login: vi.fn(async () => account(secret)),
      me: vi.fn(),
      directory: vi.fn(),
    } as unknown as Pick<AccountClient, 'login' | 'me' | 'directory'>;
    const loginStdout = outputCapture();

    const loginExit = await runMain(['login', '--from-config'], {
      store,
      accountClient,
      prompts: new TestPrompts(),
      stdout: loginStdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(loginExit).toBe(0);
    expect(loginStdout.read()).toContain('登录成功');
    expect(loginStdout.read()).not.toContain(secret);
    expect(loginStdout.read()).not.toContain('one-shot-secret');
    const configAfterLogin = readFileSync(getSharedConfigPath(homeDir), 'utf8');
    expect(configAfterLogin).toContain(secret);
    expect(configAfterLogin).not.toContain('one-shot-secret');

    const logoutStdout = outputCapture();
    const logoutExit = await runMain(['logout'], {
      store,
      stdout: logoutStdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(logoutExit).toBe(0);
    expect(logoutStdout.read()).toContain('已清除本机 CLI 登录态');
    expect(readFileSync(getSharedConfigPath(homeDir), 'utf8')).not.toContain(secret);
  });

  it('preserves daemon status exit semantics and output', async () => {
    const { store } = testStore();
    const stdout = outputCapture();
    const stderr = outputCapture();
    const daemonStatus = vi.fn(async () => ({
      command: 'zterm-daemon',
      args: ['status'],
      exitCode: 3,
      signal: null,
      stdout: 'service failed\n',
      stderr: 'detail\n',
      state: 'observed' as const,
    }));

    const exitCode = await runMain(['daemon', 'status'], {
      store,
      daemonStatus,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(3);
    expect(stdout.read()).toBe('service failed\n');
    expect(stderr.read()).toBe('detail\n');
    expect(daemonStatus).toHaveBeenCalledTimes(1);
  });

  it('launches a numbered slot through the exact binding and closes the connection', async () => {
    const { store } = testStore();
    const binding = boundBinding();
    const secret = 'account-access-secret';
    await store.update((config) => {
      config.zterm = {
        cli: {
          server: { relayBaseUrl: binding.account.relayBaseUrl },
          auth: {
            loginId: 'login-1',
            userId: binding.account.userId,
            username: 'jason',
            accessToken: secret,
            authenticatedAt: '2026-10-20T00:00:00.000Z',
          },
          slots: { '1': binding },
        },
      };
      return { value: undefined, changed: true };
    });

    const accountClient = {
      login: vi.fn(),
      me: vi.fn(async () => accountWithBoundServer()),
      directory: vi.fn(async () => accountWithBoundServer().directory),
    } as unknown as Pick<AccountClient, 'login' | 'me' | 'directory'>;
    const close = vi.fn();
    const connection = { close } as unknown as SessionConnection;
    const connectionFactory = vi.fn(async () => connection);
    const runTerminal = vi.fn(async () => ({ exitCode: 0 }));
    const stdout = outputCapture();

    const exitCode = await runMain(['1'], {
      store,
      accountClient,
      connectionFactory,
      runTerminal,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(accountClient.me).toHaveBeenCalledWith({
      relayBaseUrl: binding.account.relayBaseUrl,
      accessToken: secret,
    }, expect.any(AbortSignal));
    expect(connectionFactory).toHaveBeenCalledWith(
      accountWithBoundServer(),
      {
        deviceId: binding.server.deviceId,
        daemonHostId: binding.server.daemonHostId,
      },
      expect.any(AbortSignal),
    );
    expect(runTerminal).toHaveBeenCalledWith({
      store,
      binding,
      connection,
      signal: expect.any(AbortSignal),
    });
    expect(close).toHaveBeenCalledWith('main-terminal-complete');
    expect(stdout.read()).toBe('');
  });

  it('projects a snapshot through renderer and closes slot-set connections on success', async () => {
    const { store } = testStore();
    const binding = boundBinding();
    const auth = {
      relayBaseUrl: binding.account.relayBaseUrl,
      loginId: 'login-1',
      userId: binding.account.userId,
      username: 'jason',
      accessToken: 'account-access-secret',
      authenticatedAt: '2026-10-20T00:00:00.000Z',
    };
    await store.update((config) => {
      config.zterm = {
        cli: {
          server: { relayBaseUrl: binding.account.relayBaseUrl },
          auth,
        },
      };
      return { value: undefined, changed: true };
    });
    const directory = accountWithBoundServer().directory;
    const accountClient = {
      login: vi.fn(),
      me: vi.fn(async () => accountWithBoundServer()),
      directory: vi.fn(async () => directory),
    } as unknown as Pick<AccountClient, 'login' | 'me' | 'directory'>;
    const prompts: PromptPort = {
      text: vi.fn(async () => ''),
      password: vi.fn(async () => ''),
      select: vi.fn(async (_message, choices) => choices[0]!.value),
      confirm: vi.fn(async () => true),
    };
    const close = vi.fn();
    const channel = { close } as unknown as SessionChannel;
    const listeners = new Set<(event: SessionConnectionEvent) => void>();
    const connection = {
      state: 'ready',
      listSessions: vi.fn(async () => ({
        sessions: ['work'],
        sessionCatalog: [{
          name: 'work',
          backend: 'tmux',
          stableId: 'stable-1',
        }],
      })),
      readSnapshot: vi.fn(async () => ({
        status: 'available',
        backend: 'tmux',
        stableId: 'stable-1',
        head: {
          revision: 1,
          bufferStartIndex: 0,
          bufferLines: 1,
          latestEndIndex: 1,
        },
        body: {
          revision: 1,
          startIndex: 0,
          endIndex: 1,
          rows: 1,
          cols: 8,
          lines: [{
            i: 0,
            t: 'preview',
          }],
        },
      })),
      close,
      onEvent: vi.fn((listener: (event: SessionConnectionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      openExisting: vi.fn(async () => channel),
    } as unknown as SessionConnection;
    const connectionFactory = vi.fn(async () => connection);
    const stdout = outputCapture();

    const exitCode = await runMain(['slot', 'set', '1', '--width-mode', 'mirror-fixed'], {
      store,
      accountClient,
      prompts,
      connectionFactory,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(connectionFactory).toHaveBeenCalledWith(
      accountWithBoundServer(),
      {
        deviceId: binding.server.deviceId,
        daemonHostId: binding.server.daemonHostId,
      },
      expect.any(AbortSignal),
    );
    expect(connection.readSnapshot).toHaveBeenCalledWith({
      backend: 'tmux',
      stableId: 'stable-1',
      maxLines: 80,
    });
    expect(stdout.read()).toContain('\x1b[0m\x1b[?25h');
    expect(stdout.read()).toContain('预览：work · tmux');
    expect(stdout.read().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).toContain('preview');
    expect(close).toHaveBeenCalledWith('slot-configure-complete');
  });

  it('preserves daemon config exit semantics and output', async () => {
    const { store } = testStore();
    const stdout = outputCapture();
    const stderr = outputCapture();
    const daemonConfig = vi.fn(async () => ({
      command: 'zterm-daemon',
      args: ['config'],
      exitCode: 4,
      signal: null,
      stdout: '{"server":{"port":3333}}\n',
      stderr: 'config warning\n',
      state: 'observed' as const,
    }));

    const exitCode = await runMain(['daemon', 'config'], {
      store,
      daemonConfig,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(4);
    expect(stdout.read()).toBe('{"server":{"port":3333}}\n');
    expect(stderr.read()).toBe('config warning\n');
    expect(daemonConfig).toHaveBeenCalledTimes(1);
  });

  it('accepts daemon install options in either order', async () => {
    const { store } = testStore();
    const daemonInstall = vi.fn(async () => ({
      phase: 'verify' as const,
      installedVersion: '1.2.3',
      commandAvailable: true,
      filesWritten: [],
      previousEntryPreserved: 'unknown' as const,
    }));

    for (const args of [
      ['daemon', 'install', '--version', '1.2.3', '--registry', 'https://npm.example/'],
      ['daemon', 'install', '--registry', 'https://npm.example/', '--version', '1.2.3'],
    ]) {
      const exitCode = await runMain(args, {
        store,
        daemonInstall,
        stdout: outputCapture().stream,
        stderr: outputCapture().stream,
        signal: new AbortController().signal,
      });
      expect(exitCode).toBe(0);
    }

    expect(daemonInstall).toHaveBeenNthCalledWith(1, {
      version: '1.2.3',
      registry: 'https://npm.example/',
      signal: expect.any(AbortSignal),
    });
    expect(daemonInstall).toHaveBeenNthCalledWith(2, {
      version: '1.2.3',
      registry: 'https://npm.example/',
      signal: expect.any(AbortSignal),
    });
  });

  it('delegates upgrade registry selection and preserves the unchanged state', async () => {
    const { store } = testStore();
    const stdout = outputCapture();
    const upgrade = vi.fn(async () => ({
      beforeVersion: '0.1.0',
      installationState: 'unchanged' as const,
    }));

    const exitCode = await runMain(['upgrade', '--registry', 'https://npm.example/'], {
      store,
      upgrade,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(upgrade).toHaveBeenCalledWith({
      registry: 'https://npm.example/',
      signal: expect.any(AbortSignal),
    });
    expect(stdout.read()).toBe('CLI 已是版本 0.1.0。\n');
  });
});
