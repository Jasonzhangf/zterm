import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountClient,
  type AccountClientFetch,
  type AuthenticatedAccount,
} from './account-client.js';
import type {
  SessionChannel,
  SessionConnection,
  SessionConnectionEvent,
} from './connection.js';
import { runMain } from './main.js';
import type { PromptPort } from './prompts.js';
import type { CliSlotBinding } from './slot-store.js';
import type { SyncedSlot } from '../../shared/src/connection/cli-slot-config.js';
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

class TestPromptInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
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

async function waitForOutput(
  capture: ReturnType<typeof outputCapture>,
  pattern: RegExp,
  timeoutMs = 1_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(capture.read())) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${pattern}: ${capture.read()}`);
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

const CLOUD_RELAY = 'https://relay.example.test/zterm/';
const CLOUD_SECRET = 'account-access-secret';

function cloudAuth(userId = 'user-1') {
  return {
    loginId: `login-${userId}`,
    userId,
    username: 'jason',
    accessToken: CLOUD_SECRET,
    authenticatedAt: '2026-10-20T00:00:00.000Z',
  };
}

function slotFor(
  slot: number,
  options: {
    alias?: string;
    name?: string;
    displayName?: string;
    userId?: string;
    widthMode?: CliSlotBinding['widthMode'];
  } = {},
): CliSlotBinding {
  const name = options.name ?? 'work';
  return {
    ...(options.alias === undefined ? {} : { alias: options.alias }),
    account: {
      relayBaseUrl: CLOUD_RELAY,
      userId: options.userId ?? 'user-1',
    },
    server: {
      deviceId: `device-${slot}`,
      daemonHostId: `daemon-${slot}`,
      displayName: options.displayName ?? 'Mac Studio',
    },
    session: {
      backend: 'tmux',
      stableId: `stable-${slot}-${name}`,
      name,
    },
    widthMode: options.widthMode ?? 'adaptive-phone',
  };
}

function syncedFor(
  slot: number,
  options: Parameters<typeof slotFor>[1] = {},
): SyncedSlot {
  const local = slotFor(slot, options);
  return {
    slot,
    ...(local.alias === undefined ? {} : { alias: local.alias }),
    server: local.server,
    session: local.session,
    widthMode: local.widthMode,
  };
}

function cloudOk(slots: SyncedSlot[], userId = 'user-1') {
  return {
    ok: true,
    schemaVersion: 1,
    user: { id: userId },
    config: { configured: true, slots },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function seedSlots(
  store: SharedConfigStore,
  slots: Record<string, CliSlotBinding>,
  loggedIn = true,
) {
  await store.update((config) => {
    config.zterm = {
      cli: {
        server: { relayBaseUrl: CLOUD_RELAY },
        ...(loggedIn ? { auth: cloudAuth() } : {}),
        slots,
      },
    };
    return { value: undefined, changed: true };
  });
}

function configText(homeDir: string): string | undefined {
  try {
    return readFileSync(getSharedConfigPath(homeDir), 'utf8');
  } catch {
    return undefined;
  }
}

function configSlots(homeDir: string): Record<string, CliSlotBinding> {
  const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));
  return config.zterm.cli.slots;
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

  it('cancels the default login prompt through the resolved command signal', async () => {
    const { store } = testStore();
    await store.update((config) => {
      config.zterm = {
        cli: {
          server: { relayBaseUrl: 'http://127.0.0.1:9/zterm/' },
        },
      };
      return { value: undefined, changed: true };
    });
    const controller = new AbortController();
    const input = new TestPromptInput();
    const stdout = outputCapture();
    const stderr = outputCapture();
    const accountClient = {
      login: vi.fn(),
      me: vi.fn(),
      directory: vi.fn(),
    } as unknown as Pick<AccountClient, 'login' | 'me' | 'directory'>;

    const pending = runMain(['login'], {
      store,
      accountClient,
      stdin: input,
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: controller.signal,
    });
    await waitForOutput(stdout, /账号/);
    controller.abort();

    const outcome = await Promise.race([
      pending,
      delay(500).then(() => 'timeout' as const),
    ]);
    if (outcome === 'timeout') {
      input.end();
      await pending.catch(() => undefined);
    }

    expect(outcome).toBe(130);
    expect(accountClient.login).not.toHaveBeenCalled();
    expect(input.listenerCount('keypress')).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(stderr.read()).toContain('登录已取消');
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

  it('serves slot help without any network request or config write', async () => {
    const { homeDir, store } = testStore();
    const fetchImpl = vi.fn(async () => {
      throw new Error('unexpected network request');
    });
    const cases: Array<[string[], RegExp]> = [
      [['slot', '--help'], /zterm slot rename <1\.\.20> <name>/],
      [['slot', 'list', '--help'], /zterm slot list/],
      [['slot', 'rename', '--help'], /zterm slot rename <1\.\.20> <name>/],
      [['slot', 'pull', '--help'], /zterm slot pull --all/],
      [['slot', 'push', '--help'], /zterm slot push --all/],
    ];

    for (const [args, pattern] of cases) {
      const stdout = outputCapture();
      const stderr = outputCapture();
      await expect(runMain(args, {
        store,
        accountClient: new AccountClient(fetchImpl),
        stdout: stdout.stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(0);
      expect(stdout.read()).toMatch(pattern);
      expect(stderr.read()).toBe('');
    }

    const topLevel = outputCapture();
    await expect(runMain(['--help'], {
      store,
      stdout: topLevel.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    })).resolves.toBe(0);
    expect(topLevel.read()).toContain('zterm slot pull --all');
    expect(topLevel.read()).toContain('zterm slot push --all');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(configText(homeDir)).toBeUndefined();
  });

  it('uses one label projection for slot list and the no-argument selector', async () => {
    const { store } = testStore();
    await seedSlots(store, {
      '1': slotFor(1, { alias: '工作台' }),
      '2': slotFor(2, { name: 'build', displayName: 'MacBook Air' }),
    });
    const listStdout = outputCapture();
    const listExit = await runMain(['slot', 'list'], {
      store,
      stdout: listStdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(listExit).toBe(0);
    expect(listStdout.read()).toContain(
      '槽位 1 · 工作台 · Mac Studio · work · tmux · adaptive-phone',
    );
    expect(listStdout.read()).toContain(
      '槽位 2 · MacBook Air / build · MacBook Air · build · tmux · adaptive-phone',
    );

    let labels: string[] = [];
    const select = vi.fn(async <T>(
      _message: string,
      choices: readonly { label: string; value: T }[],
    ): Promise<T> => {
      labels = choices.map((choice) => choice.label);
      return choices[0]!.value;
    }) as PromptPort['select'];
    const prompts: PromptPort = {
      text: vi.fn(async () => ''),
      password: vi.fn(async () => ''),
      select,
      confirm: vi.fn(async () => false),
    };
    const selectorExit = await runMain([], {
      store,
      prompts,
      stdout: outputCapture().stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(selectorExit).toBe(1);
    expect(labels).toEqual([
      '槽位 1 · 工作台 · Mac Studio · work · tmux · adaptive-phone',
      '槽位 2 · MacBook Air / build · MacBook Air · build · tmux · adaptive-phone',
    ]);
  });

  it('renames the alias only and works while logged out', async () => {
    const { homeDir, store } = testStore();
    const original = slotFor(1);
    await seedSlots(store, { '1': original }, false);
    const accountClient = {
      login: vi.fn(),
      me: vi.fn(),
      directory: vi.fn(),
    } as unknown as Pick<AccountClient, 'login' | 'me' | 'directory'>;
    const stdout = outputCapture();

    const exitCode = await runMain(['slot', 'rename', '1', '工作台'], {
      store,
      accountClient,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain('已保存槽位 1 的别名：工作台');
    expect(configSlots(homeDir)['1']).toEqual({ ...original, alias: '工作台' });
    expect(JSON.parse(configText(homeDir)!).zterm.cli.auth).toBeUndefined();
    expect(accountClient.login).not.toHaveBeenCalled();
    expect(accountClient.me).not.toHaveBeenCalled();
    expect(accountClient.directory).not.toHaveBeenCalled();
  });

  it('rejects rename usage, missing slots, and invalid aliases without mutation', async () => {
    const { homeDir, store } = testStore();
    await seedSlots(store, { '1': slotFor(1) }, false);
    const before = configText(homeDir);

    for (const args of [
      ['slot', 'rename'],
      ['slot', 'rename', '1'],
      ['slot', 'rename', '21', 'x'],
      ['slot', 'rename', '1', 'two', 'words'],
    ]) {
      const stdout = outputCapture();
      const stderr = outputCapture();
      await expect(runMain(args, {
        store,
        stdout: stdout.stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(2);
      expect(stdout.read()).toBe('');
      expect(stderr.read()).toContain('用法错误');
    }
    expect(configText(homeDir)).toBe(before);

    const missingStderr = outputCapture();
    await expect(runMain(['slot', 'rename', '2', 'x'], {
      store,
      stdout: outputCapture().stream,
      stderr: missingStderr.stream,
      signal: new AbortController().signal,
    })).resolves.toBe(1);
    expect(missingStderr.read()).toContain('槽位 2 未配置');
    expect(configText(homeDir)).toBe(before);

    const invalidStderr = outputCapture();
    await expect(runMain(['slot', 'rename', '1', '   '], {
      store,
      stdout: outputCapture().stream,
      stderr: invalidStderr.stream,
      signal: new AbortController().signal,
    })).resolves.toBe(1);
    expect(invalidStderr.read()).toContain('槽位别名无效');
    expect(configText(homeDir)).toBe(before);
  });

  it('pulls one slot through the real account client and reports the overwrite', async () => {
    const { homeDir, store } = testStore();
    await seedSlots(store, {
      '1': slotFor(1, { name: 'local' }),
      '2': slotFor(2, { name: 'keep' }),
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const accountClient = new AccountClient(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(cloudOk([
        syncedFor(1, { name: 'cloud', alias: '工作台' }),
      ]));
    });
    const stdout = outputCapture();

    const exitCode = await runMain(['slot', 'pull', '1'], {
      store,
      accountClient,
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${CLOUD_RELAY}api/cli/slots`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(stdout.read()).toContain('已用云端槽位 1 覆盖本地槽位 1');
    const slots = configSlots(homeDir);
    expect(slots['1']).toMatchObject({
      alias: '工作台',
      account: { relayBaseUrl: CLOUD_RELAY, userId: 'user-1' },
      session: { name: 'cloud' },
    });
    expect(slots['2']!.session.name).toBe('keep');
  });

  it('pulls an explicitly empty cloud scope and reports the local clear', async () => {
    const { homeDir, store } = testStore();
    await seedSlots(store, {
      '1': slotFor(1),
      '2': slotFor(2, { userId: 'user-2' }),
    });
    const stdout = outputCapture();

    const exitCode = await runMain(['slot', 'pull', '--all'], {
      store,
      accountClient: new AccountClient(async () => jsonResponse(cloudOk([]))),
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read()).toContain('已清空当前账号的本地槽位（共 0 个）');
    expect(Object.keys(configSlots(homeDir))).toEqual(['2']);
  });

  it('pushes one slot as a whitelisted cloud binding', async () => {
    const { store } = testStore();
    const local = slotFor(1, { alias: '工作台' });
    await seedSlots(store, { '1': local });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stdout = outputCapture();

    const exitCode = await runMain(['slot', 'push', '1'], {
      store,
      accountClient: new AccountClient(async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(cloudOk([syncedFor(1, { alias: '工作台' })]));
      }),
      stdout: stdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${CLOUD_RELAY}api/cli/slots/1`);
    expect(calls[0]!.init.method).toBe('PUT');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      schemaVersion: 1,
      binding: {
        alias: '工作台',
        server: local.server,
        session: local.session,
        widthMode: local.widthMode,
      },
    });
    expect(body.binding).not.toHaveProperty('slot');
    expect(JSON.stringify(body)).not.toContain('account');
    expect(stdout.read()).toContain('已用本地槽位 1 覆盖当前账号的云端槽位 1');
  });

  it('pushes all current-account slots and clears an empty account cloud scope', async () => {
    const first = testStore();
    await seedSlots(first.store, {
      '1': slotFor(1),
      '2': slotFor(2, { userId: 'user-2' }),
    });
    const firstCalls: Array<{ url: string; init: RequestInit }> = [];
    const firstStdout = outputCapture();

    const firstExit = await runMain(['slot', 'push', '--all'], {
      store: first.store,
      accountClient: new AccountClient(async (url, init) => {
        firstCalls.push({ url, init });
        return jsonResponse(cloudOk([]));
      }),
      stdout: firstStdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(firstExit).toBe(0);
    expect(firstCalls).toHaveLength(1);
    expect(firstCalls[0]!.url).toBe(`${CLOUD_RELAY}api/cli/slots`);
    const firstBody = JSON.parse(String(firstCalls[0]!.init.body));
    expect(firstBody.slots.map((slot: SyncedSlot) => slot.slot)).toEqual([1]);
    expect(firstStdout.read()).toContain(
      '已用当前账号的本地槽位覆盖云端槽位：共 1 个',
    );

    const empty = testStore();
    await seedSlots(empty.store, {
      '2': slotFor(2, { userId: 'user-2' }),
    });
    const emptyCalls: Array<{ url: string; init: RequestInit }> = [];
    const emptyStdout = outputCapture();

    const emptyExit = await runMain(['slot', 'push', '--all'], {
      store: empty.store,
      accountClient: new AccountClient(async (url, init) => {
        emptyCalls.push({ url, init });
        return jsonResponse(cloudOk([]));
      }),
      stdout: emptyStdout.stream,
      stderr: outputCapture().stream,
      signal: new AbortController().signal,
    });

    expect(emptyExit).toBe(0);
    const emptyBody = JSON.parse(String(emptyCalls[0]!.init.body));
    expect(emptyBody.slots).toEqual([]);
    expect(emptyStdout.read()).toContain('已清空当前账号的云端槽位（共 0 个）');
  });

  it('rejects bare, mixed, duplicate, out-of-range, and trailing arguments before any request', async () => {
    const { homeDir, store } = testStore();
    await seedSlots(store, { '1': slotFor(1) });
    const before = configText(homeDir);
    const fetchImpl = vi.fn(async () => jsonResponse(cloudOk([])));
    const cases: string[][] = [
      ['slot', 'pull'],
      ['slot', 'push'],
      ['slot', 'pull', '1', '--all'],
      ['slot', 'push', '1', '--all'],
      ['slot', 'pull', '--all', '--all'],
      ['slot', 'push', '--all', '--all'],
      ['slot', 'pull', '1', '2'],
      ['slot', 'pull', '0'],
      ['slot', 'push', '21'],
      ['slot', 'pull', '1.5'],
      ['slot', 'push', 'abc'],
      ['slot', 'pull', '1', 'extra'],
      ['slot', 'push', '--bogus'],
      ['slot', 'pull', '1', '--help'],
      ['slot', 'push', '--help', 'extra'],
    ];

    for (const args of cases) {
      const stdout = outputCapture();
      const stderr = outputCapture();
      await expect(runMain(args, {
        store,
        accountClient: new AccountClient(fetchImpl),
        stdout: stdout.stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(2);
      expect(stdout.read()).toBe('');
      expect(stderr.read()).toContain('用法错误');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(configText(homeDir)).toBe(before);
    }
  });

  it('maps sync failures to exit 1 with actionable messages', async () => {
    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) });
      const stderr = outputCapture();
      await expect(runMain(['slot', 'pull', '1'], {
        store,
        accountClient: new AccountClient(async () => jsonResponse({
          ok: true,
          schemaVersion: 1,
          user: { id: 'user-1' },
          config: { configured: false },
        })),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(stderr.read()).toContain('云端尚未配置槽位');
    }

    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) });
      const stderr = outputCapture();
      await expect(runMain(['slot', 'pull', '1'], {
        store,
        accountClient: new AccountClient(async () => jsonResponse({
          ok: false,
          error: { code: 'not_found' },
        }, 404)),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(stderr.read()).toContain('云槽同步接口不可用');
    }

    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) });
      const stderr = outputCapture();
      await expect(runMain(['slot', 'pull', '1'], {
        store,
        accountClient: {
          login: vi.fn(),
          me: vi.fn(),
          directory: vi.fn(),
        } as unknown as Pick<AccountClient, 'login' | 'me' | 'directory'>,
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(stderr.read()).toContain('不支持云端槽位同步');
    }

    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) });
      const stderr = outputCapture();
      await expect(runMain(['slot', 'push', '1'], {
        store,
        accountClient: new AccountClient(async () => {
          throw new Error('socket hang up');
        }),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(stderr.read()).toContain('云端写入结果无法确认');
    }

    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) }, false);
      const pullStderr = outputCapture();
      await expect(runMain(['slot', 'pull', '1'], {
        store,
        accountClient: new AccountClient(async () => jsonResponse(cloudOk([]))),
        stdout: outputCapture().stream,
        stderr: pullStderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(pullStderr.read()).toContain('未登录');

      const pushStderr = outputCapture();
      await expect(runMain(['slot', 'push', '--all'], {
        store,
        accountClient: new AccountClient(async () => jsonResponse(cloudOk([]))),
        stdout: outputCapture().stream,
        stderr: pushStderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(pushStderr.read()).toContain('未登录');
    }

    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) });
      const stderr = outputCapture();
      await expect(runMain(['slot', 'push', '2'], {
        store,
        accountClient: new AccountClient(async () => jsonResponse(cloudOk([]))),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(stderr.read()).toContain('本地槽位 2 未配置');
    }

    {
      const { store } = testStore();
      await seedSlots(store, { '1': slotFor(1) });
      const stderr = outputCapture();
      await expect(runMain(['slot', 'pull', '1'], {
        store,
        accountClient: new AccountClient(async () => jsonResponse(cloudOk([]))),
        stdout: outputCapture().stream,
        stderr: stderr.stream,
        signal: new AbortController().signal,
      })).resolves.toBe(1);
      expect(stderr.read()).toContain('云端没有槽位 1');
    }
  });
});
