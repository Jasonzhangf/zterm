import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountClient,
  type AccountClientFetch,
  type AuthenticatedAccount,
} from '../account-client.js';
import {
  SharedConfigStore,
  getSharedConfigPath,
} from '../../../shared/src/node/shared-config.js';
import type { RelayAccountDirectory } from '../../../shared/src/connection/relay-directory.js';
import {
  PromptCancelledError,
  type PromptChoice,
  type PromptPort,
} from '../prompts.js';
import {
  loginCommand,
  logoutCommand,
  type LoginCommandOptions,
} from './auth.js';

const USER = { id: 'user-1', username: 'jason' };
const SERVER = 'https://relay.example.test/zterm/';
const OLD_AUTH = {
  loginId: 'login-old',
  userId: USER.id,
  username: USER.username,
  accessToken: 'old-access-secret',
  authenticatedAt: '2026-10-20T00:00:00.000Z',
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function directory(baseUrl: string): RelayAccountDirectory {
  return {
    schemaVersion: 1,
    user: USER,
    devices: [
      {
        deviceId: 'device-1',
        deviceName: 'Mac Studio',
        platform: 'darwin',
        appVersion: '1.0.0',
        client: { connected: true, lastSeenAt: '2026-10-20T00:00:00.000Z' },
        daemon: {
          hostId: 'daemon-1',
          version: '1.0.0',
          presence: { connected: true, lastSeenAt: '2026-10-20T00:00:00.000Z' },
          endpoints: [
            {
              id: 'lan-daemon',
              kind: 'lan',
              host: '127.0.0.1',
              port: 3333,
              authToken: 'daemon-endpoint-secret',
              authRequired: true,
              lastSeenAt: '2026-10-20T00:00:00.000Z',
            },
          ],
          sessions: [],
          lastPublishedAt: '2026-10-20T00:00:00.000Z',
        },
      },
    ],
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

function loginPayload(relayBaseUrl: string, accessToken = 'new-access-secret'): AuthenticatedAccount {
  return {
    relayBaseUrl,
    accessToken,
    user: USER,
    directory: directory(relayBaseUrl),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function relayFetch(
  handler: (input: {
    url: URL;
    init: RequestInit;
  }) => Response | Promise<Response>,
): AccountClientFetch {
  return async (input, init) => handler({
    url: new URL(input),
    init,
  });
}

async function createStore(initial?: Record<string, unknown>) {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-command-auth-'));
  const store = new SharedConfigStore({ homeDir });
  if (initial) {
    await store.update((latest) => {
      Object.assign(latest, initial);
      return { value: undefined, changed: true };
    });
  }
  cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, store };
}

class ControlledPrompts implements PromptPort {
  readonly texts: Array<{ message: string; answer: string }> = [];
  readonly passwords: string[] = [];
  readonly selections: Array<{ message: string; choices: readonly PromptChoice<unknown>[] }> = [];
  private selectIndex = 0;

  constructor(
    private readonly values: {
      text?: Array<string | Error>;
      password?: Array<string | Error>;
      select?: number[];
    } = {},
  ) {}

  async text(message: string): Promise<string> {
    const value = this.values.text?.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected text prompt: ${message}`);
    this.texts.push({ message, answer: value });
    return value;
  }

  async password(message: string): Promise<string> {
    this.passwords.push(message);
    const value = this.values.password?.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`unexpected password prompt: ${message}`);
    return value;
  }

  async select<T>(message: string, choices: readonly PromptChoice<T>[]): Promise<T> {
    this.selections.push({
      message,
      choices: choices as readonly PromptChoice<unknown>[],
    });
    const index = this.values.select?.shift() ?? this.selectIndex++;
    const choice = choices[index];
    if (!choice) throw new Error(`missing select answer for ${message}`);
    return choice.value;
  }

  async confirm(): Promise<boolean> {
    throw new Error('unexpected confirm prompt');
  }
}

function loginOptions(
  store: SharedConfigStore,
  account: Pick<AccountClient, 'login'>,
  prompts: PromptPort,
  fromConfig = false,
): LoginCommandOptions {
  return {
    store,
    account,
    prompts,
    fromConfig,
    createLoginId: () => 'login-new',
    now: () => '2026-10-20T00:10:00.000Z',
  };
}

describe('CLI auth commands', () => {
  it('registers generation before the network request and reuses one configured server', async () => {
    let observedGeneration: number | undefined;
    let requestCount = 0;
    const baseUrl = SERVER;
    const fetchImpl = relayFetch(async () => {
      requestCount += 1;
      const config = JSON.parse(
        readFileSync(getSharedConfigPath(harness.homeDir), 'utf8'),
      );
      observedGeneration = config.zterm.cli.authGeneration;
      await harness.store.update((latest) => {
        latest.networkMergedWhileAuthenticating = true;
        return { value: undefined, changed: true };
      });
      return jsonResponse(loginPayload(baseUrl));
    });
    const harness = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: baseUrl },
          authGeneration: 4,
          unknownCliField: { keep: true },
        },
      },
      unknownRoot: ['keep'],
    });
    const prompts = new ControlledPrompts({
      text: ['jason'],
      password: ['interactive-password-secret'],
    });
    const account = new AccountClient(fetchImpl);

    const result = await loginCommand(loginOptions(harness.store, account, prompts));
    const config = JSON.parse(readFileSync(getSharedConfigPath(harness.homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'ok',
      value: {
        relayBaseUrl: baseUrl,
        username: 'jason',
        source: 'interactive',
      },
    });
    expect(requestCount).toBe(1);
    expect(observedGeneration).toBe(5);
    expect(prompts.texts.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/账号|用户名/),
    ]);
    expect(prompts.passwords).toHaveLength(1);
    expect(config.zterm.cli.auth).toMatchObject({
      loginId: 'login-new',
      userId: USER.id,
      username: USER.username,
      accessToken: 'new-access-secret',
      authenticatedAt: '2026-10-20T00:10:00.000Z',
    });
    expect(config.zterm.cli.authGeneration).toBe(5);
    expect(config.zterm.cli.unknownCliField).toEqual({ keep: true });
    expect(config.unknownRoot).toEqual(['keep']);
    expect(config.networkMergedWhileAuthenticating).toBe(true);
    expect(JSON.stringify(result)).not.toContain('new-access-secret');
    expect(JSON.stringify(result)).not.toContain('interactive-password-secret');
  });

  it('prompts for a missing server exactly once and then uses the returned relay URL', async () => {
    let receivedPath = '';
    const baseUrl = 'https://relay.prompted.test/zterm/';
    const fetchImpl = relayFetch(({ url }) => {
      receivedPath = url.pathname;
      return jsonResponse(loginPayload(baseUrl));
    });
    const { store } = await createStore();
    const prompts = new ControlledPrompts({
      text: [baseUrl, 'jason'],
      password: ['interactive-password-secret'],
    });

    const result = await loginCommand(loginOptions(store, new AccountClient(fetchImpl), prompts));

    expect(result.kind).toBe('ok');
    expect(prompts.texts).toHaveLength(2);
    expect(prompts.texts[0].message).toMatch(/服务器|relay/i);
    expect(prompts.texts[1].message).toMatch(/账号|用户名/);
    expect(receivedPath).toBe('/zterm/api/auth/login');
  });

  it('consumes the from-config password before login and never prompts', async () => {
    const baseUrl = SERVER;
    let passwordConsumedAtNetwork = false;
    const fetchImpl = relayFetch(async () => {
      const networkConfig = JSON.parse(
        readFileSync(getSharedConfigPath(homeDir), 'utf8'),
      );
      passwordConsumedAtNetwork =
        networkConfig.zterm.cli.loginInput.password === undefined;
      return jsonResponse(loginPayload(baseUrl));
    });
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          authGeneration: 1,
          server: { relayBaseUrl: baseUrl },
          loginInput: {
            username: 'jason',
            password: 'one-shot-password-secret',
          },
          unknownCliField: { keep: true },
        },
      },
    });
    const prompts = new ControlledPrompts();

    const result = await loginCommand(loginOptions(store, new AccountClient(fetchImpl), prompts, true));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'ok',
      value: { source: 'config', username: 'jason' },
    });
    expect(prompts.texts).toHaveLength(0);
    expect(prompts.passwords).toHaveLength(0);
    expect(passwordConsumedAtNetwork).toBe(true);
    expect(config.zterm.cli.loginInput).toEqual({ username: 'jason' });
    expect(config.zterm.cli.unknownCliField).toEqual({ keep: true });
    expect(JSON.stringify(result)).not.toContain('one-shot-password-secret');
  });

  it('does not report success or restore the password when login returns 401', async () => {
    const baseUrl = SERVER;
    const fetchImpl = relayFetch(
      () => jsonResponse({ error: 'arbitrary upstream secret' }, 401),
    );
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          authGeneration: 2,
          server: { relayBaseUrl: baseUrl },
          loginInput: {
            username: 'jason',
            password: 'one-shot-password-secret',
          },
        },
      },
    });

    const result = await loginCommand(
      loginOptions(store, new AccountClient(fetchImpl), new ControlledPrompts(), true),
    );
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'authenticate',
      error: { code: 'auth_invalid', status: 401 },
    });
    expect(config.zterm.cli.authGeneration).toBe(3);
    expect(config.zterm.cli.auth).toBeUndefined();
    expect(config.zterm.cli.loginInput.password).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('one-shot-password-secret');
    expect(JSON.stringify(result)).not.toContain('arbitrary upstream secret');
  });

  it('keeps old auth and slot fields when interactive login is cancelled', async () => {
    let networkCalls = 0;
    const fetchImpl: AccountClientFetch = async () => {
      networkCalls += 1;
      throw new Error('network must not run');
    };
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          authGeneration: 7,
          server: { relayBaseUrl: SERVER },
          auth: OLD_AUTH,
          slots: { '1': { session: { name: 'keep' } } },
          unknownCliField: { keep: true },
        },
      },
      daemonUnknown: { keep: true },
    });
    const prompts = new ControlledPrompts({
      text: ['jason'],
      password: [new PromptCancelledError('password')],
    });

    const result = await loginCommand(
      loginOptions(store, new AccountClient(fetchImpl), prompts),
    );
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({ kind: 'cancelled', stage: 'credentials' });
    expect(networkCalls).toBe(0);
    expect(config.zterm.cli.authGeneration).toBe(8);
    expect(config.zterm.cli.auth).toEqual(OLD_AUTH);
    expect(config.zterm.cli.slots).toEqual({ '1': { session: { name: 'keep' } } });
    expect(config.zterm.cli.unknownCliField).toEqual({ keep: true });
    expect(config.daemonUnknown).toEqual({ keep: true });
  });

  it('returns a failure, not success, when the login commit cannot acquire the config lock', async () => {
    let homeDir = '';
    const baseUrl = SERVER;
    const fetchImpl = relayFetch(() => {
      writeFileSync(`${getSharedConfigPath(homeDir)}.lock`, 'held\n', { mode: 0o600 });
      return jsonResponse(loginPayload(baseUrl));
    });
    const harness = await createStore();
    homeDir = harness.homeDir;
    await harness.store.update((latest) => {
      latest.zterm = {
        cli: {
          authGeneration: 1,
          server: { relayBaseUrl: baseUrl },
          loginInput: { username: 'jason', password: 'one-shot-password-secret' },
        },
      };
      return { value: undefined, changed: true };
    });
    const store = new SharedConfigStore({
      homeDir,
      lockTimeoutMs: 30,
      lockRetryMs: 1,
    });

    const result = await loginCommand(
      loginOptions(store, new AccountClient(fetchImpl), new ControlledPrompts(), true),
    );

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'config_busy' },
    });
    expect(JSON.stringify(result)).not.toContain('one-shot-password-secret');
    expect(JSON.stringify(result)).not.toContain('new-access-secret');
  });

  it('rejects from-config login without a configured server and sends no request', async () => {
    let networkCalls = 0;
    const fetchImpl: AccountClientFetch = async () => {
      networkCalls += 1;
      throw new Error('network must not run');
    };
    const { store } = await createStore({
      zterm: {
        cli: {
          loginInput: { username: 'jason', password: 'one-shot-password-secret' },
        },
      },
    });

    const result = await loginCommand(
      loginOptions(store, new AccountClient(fetchImpl), new ControlledPrompts(), true),
    );

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'server',
      error: { code: 'server_required' },
    });
    expect(networkCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain('one-shot-password-secret');
  });

  it('logout delegates generation to AccountState and states the local-only scope', async () => {
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          authGeneration: 4,
          server: { relayBaseUrl: SERVER },
          auth: OLD_AUTH,
          slots: { '2': { session: { name: 'keep' } } },
        },
      },
    });

    const result = await logoutCommand({ store });
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'ok',
      value: { generation: 5 },
    });
    expect(result.kind === 'ok' ? result.value.message : '').toMatch(/本机/);
    expect(result.kind === 'ok' ? result.value.message : '').toMatch(/远端 token 撤销接口/);
    expect(config.zterm.cli.authGeneration).toBe(5);
    expect(config.zterm.cli.auth).toBeUndefined();
    expect(config.zterm.cli.server).toEqual({ relayBaseUrl: SERVER });
    expect(config.zterm.cli.slots).toEqual({ '2': { session: { name: 'keep' } } });
  });

  it('logout advances the generation even when no auth exists', async () => {
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          authGeneration: 9,
          server: { relayBaseUrl: SERVER },
          slots: { '1': { session: { name: 'keep' } } },
        },
      },
    });

    const result = await logoutCommand({ store });
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({ kind: 'ok', value: { generation: 10 } });
    expect(config.zterm.cli.authGeneration).toBe(10);
    expect(config.zterm.cli.auth).toBeUndefined();
    expect(config.zterm.cli.slots).toEqual({ '1': { session: { name: 'keep' } } });
  });
});
