import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountClient, type AccountClientFetch } from '../account-client.js';
import {
  PromptCancelledError,
  type PromptChoice,
  type PromptPort,
} from '../prompts.js';
import {
  SharedConfigStore,
  getSharedConfigPath,
} from '../../../shared/src/node/shared-config.js';
import type { CliSlotBinding } from '../slot-store.js';
import type {
  RelayAccountDirectory,
} from '../../../shared/src/connection/relay-directory.js';
import type {
  TerminalBackendKind,
  TerminalSessionCatalog,
  TerminalSnapshotResultPayload,
} from '../../../shared/src/connection/protocol.js';
import {
  resolveSlotCommand,
  selectSlotCommand,
  slotListCommand,
  slotSetCommand,
  type SlotConnection,
  type SlotConnectionFactory,
  type SlotConnectionFactoryOptions,
  type SlotSetOptions,
} from './slots.js';

const USER = { id: 'user-1', username: 'jason' };
const SERVER = 'https://relay.example.test/zterm/';
const AUTH = {
  loginId: 'login-1',
  userId: USER.id,
  username: USER.username,
  accessToken: 'account-access-secret',
  authenticatedAt: '2026-10-20T00:00:00.000Z',
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function binding(name = 'work', stableId = 'tmux-stable-1'): CliSlotBinding {
  return {
    account: { relayBaseUrl: SERVER, userId: USER.id },
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
      displayName: 'Mac Studio',
    },
    session: { backend: 'tmux', stableId, name },
    widthMode: 'adaptive-phone',
  };
}

function directory(relayBaseUrl = SERVER): RelayAccountDirectory {
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
      {
        deviceId: 'device-no-daemon',
        deviceName: 'Phone only',
        platform: 'android',
        appVersion: '1.0.0',
        client: { connected: true, lastSeenAt: '2026-10-20T00:00:00.000Z' },
        daemon: null,
      },
    ],
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

async function startAccountFixture() {
  let requestCount = 0;
  const baseUrl = SERVER;
  const fetchImpl: AccountClientFetch = async (input) => {
    requestCount += 1;
    const url = new URL(input);
    if (url.pathname === '/zterm/api/auth/me') {
      return new Response(JSON.stringify({
        user: USER,
        directory: directory(baseUrl),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/zterm/api/directory') {
      return new Response(JSON.stringify({
        user: USER,
        directory: directory(baseUrl),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    baseUrl,
    account: new AccountClient(fetchImpl),
    requestCount: () => requestCount,
    fetchImpl,
  };
}

async function createStore(initial?: Record<string, unknown>) {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-command-slots-'));
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
  readonly textMessages: string[] = [];
  readonly passwordMessages: string[] = [];
  readonly selections: Array<{
    message: string;
    labels: string[];
    values: unknown[];
  }> = [];
  readonly confirms: string[] = [];

  constructor(
    private readonly values: {
      select?: number[];
      confirm?: Array<boolean | Error>;
    } = {},
  ) {}

  async text(message: string): Promise<string> {
    this.textMessages.push(message);
    throw new Error('unexpected text prompt');
  }

  async password(message: string): Promise<string> {
    this.passwordMessages.push(message);
    throw new Error('unexpected password prompt');
  }

  async select<T>(message: string, choices: readonly PromptChoice<T>[]): Promise<T> {
    this.selections.push({
      message,
      labels: choices.map((choice) => choice.label),
      values: choices.map((choice) => choice.value),
    });
    const index = this.values.select?.shift() ?? 0;
    const choice = choices[index];
    if (!choice) throw new Error(`missing select answer for ${message}`);
    return choice.value;
  }

  async confirm(message: string): Promise<boolean> {
    this.confirms.push(message);
    const value = this.values.confirm?.shift() ?? false;
    if (value instanceof Error) throw value;
    return value;
  }
}

function connection(overrides: Partial<SlotConnection> = {}): SlotConnection {
  const sessions: TerminalSessionCatalog = {
    sessionNames: ['work', 'unsafe-name-only'],
    sessionCatalog: [
      {
        name: 'work',
        backend: 'tmux' as TerminalBackendKind,
        stableId: 'tmux-stable-1',
        cwd: '/work',
      },
      {
        name: 'unsafe-name-only',
        backend: 'tmux' as TerminalBackendKind,
      },
    ],
  };
  const snapshot: TerminalSnapshotResultPayload = {
    status: 'available',
    backend: 'tmux',
    stableId: 'tmux-stable-1',
    head: {
      sessionId: 'session-1',
      revision: 7,
      latestEndIndex: 1,
    },
    body: {
      revision: 7,
      startIndex: 0,
      endIndex: 1,
      cols: 20,
      rows: 1,
      cursorKeysApp: true,
      lines: [{ i: 0, t: 'hello' }],
    },
  };
  return {
    listSessions: vi.fn(async () => sessions),
    readSnapshot: vi.fn(async () => snapshot),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function slotSetOptions(
  store: SharedConfigStore,
  prompts: PromptPort,
  factory: SlotConnectionFactory,
  overrides: Partial<SlotSetOptions> = {},
): SlotSetOptions {
  return {
    store,
    account: new AccountClient(),
    prompts,
    connectionFactory: factory,
    renderPreview: vi.fn(async () => undefined),
    slot: 1,
    maxLines: 80,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('CLI slot read and selection commands', () => {
  it('list is local-only and missing config is not created', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'zterm-command-slots-empty-'));
    const store = new SharedConfigStore({ homeDir });
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));

    const result = await slotListCommand({ store });

    expect(result).toEqual({ kind: 'ok', value: { slots: [] } });
    expect(existsSync(getSharedConfigPath(homeDir))).toBe(false);
  });

  it('no-argument selection returns the exact saved binding without network or prompts for target', async () => {
    const saved = binding('selected', 'exact-stable-id');
    const { store } = await createStore({
      zterm: { cli: { slots: { '2': saved, '5': binding('other') } } },
      unknownRoot: { keep: true },
    });
    const prompts = new ControlledPrompts({ select: [1] });

    const result = await selectSlotCommand({ store, prompts });

    expect(result).toMatchObject({
      kind: 'ok',
      value: { slot: 5, binding: binding('other') },
    });
    expect(prompts.selections).toHaveLength(1);
    expect(prompts.textMessages).toHaveLength(0);
    expect(prompts.passwordMessages).toHaveLength(0);
  });

  it('numbered lookup returns the exact saved binding without selection or writes', async () => {
    const saved = binding('numbered', 'numbered-exact-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          slots: { '7': saved },
          unknownCliField: { keep: true },
        },
      },
      unknownRoot: ['keep'],
    });
    const before = readFileSync(getSharedConfigPath(homeDir), 'utf8');

    const result = await resolveSlotCommand({ store, slot: 7 });
    const after = readFileSync(getSharedConfigPath(homeDir), 'utf8');

    expect(result).toEqual({
      kind: 'ok',
      value: { slot: 7, binding: saved },
    });
    expect(after).toBe(before);
  });

  it('numbered lookup rejects invalid and unconfigured slots', async () => {
    const { store } = await createStore({
      zterm: { cli: { slots: { '3': binding('saved') } } },
    });

    await expect(resolveSlotCommand({ store, slot: 0 })).resolves.toMatchObject({
      kind: 'failed',
      stage: 'validate',
      error: { code: 'invalid_slot' },
    });
    await expect(resolveSlotCommand({ store, slot: 20 })).resolves.toMatchObject({
      kind: 'failed',
      stage: 'resolve',
      error: { code: 'slot_not_found' },
    });
  });
});

describe('CLI slot set command', () => {
  it('validates 1 through 20 before account or connection work', async () => {
    const { store } = await createStore();
    let factoryCalls = 0;
    const factory: SlotConnectionFactory = async () => {
      factoryCalls += 1;
      return connection();
    };

    const result = await slotSetCommand(
      slotSetOptions(store, new ControlledPrompts(), factory, { slot: 21 }),
    );

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'validate',
      error: { code: 'invalid_slot' },
    });
    expect(factoryCalls).toBe(0);
  });

  it('lists daemon servers, requires backend plus stableId, previews read-only, then saves', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          authGeneration: 3,
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
          unknownCliField: { keep: true },
        },
        android: { daemon: { host: '127.0.0.1' } },
      },
      unknownRoot: ['keep'],
    });
    const ownConnection = connection();
    const factoryCalls: SlotConnectionFactoryOptions[] = [];
    const factory: SlotConnectionFactory = async (options) => {
      factoryCalls.push(options);
      return ownConnection;
    };
    const renderPreview = vi.fn(async () => undefined);
    const prompts = new ControlledPrompts({
      select: [0, 0],
      confirm: [true, true],
    });

    const result = await slotSetCommand(slotSetOptions(store, prompts, factory, {
      account: fixture.account,
      renderPreview,
    }));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'ok',
      value: {
        slot: 1,
        binding: {
          account: { relayBaseUrl: fixture.baseUrl, userId: USER.id },
          server: {
            deviceId: 'device-1',
            daemonHostId: 'daemon-1',
            displayName: 'Mac Studio',
          },
          session: {
            backend: 'tmux',
            stableId: 'tmux-stable-1',
            name: 'work',
          },
          widthMode: 'adaptive-phone',
        },
      },
    });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].server).toMatchObject({
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
    });
    expect(ownConnection.listSessions).toHaveBeenCalledTimes(1);
    expect(ownConnection.readSnapshot).toHaveBeenCalledWith(
      {
        backend: 'tmux',
        stableId: 'tmux-stable-1',
        name: 'work',
      },
      80,
    );
    expect(renderPreview).toHaveBeenCalledTimes(1);
    expect(renderPreview).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'available', stableId: 'tmux-stable-1' }),
      {
        backend: 'tmux',
        stableId: 'tmux-stable-1',
        name: 'work',
      },
    );
    expect(ownConnection.close).toHaveBeenCalledWith('slot-configure-complete');
    expect(config.zterm.cli.slots['1'].session.stableId).toBe('tmux-stable-1');
    expect(config.zterm.cli.slots['1'].widthMode).toBe('adaptive-phone');
    expect(config.zterm.cli.unknownCliField).toEqual({ keep: true });
    expect(config.zterm.android.daemon).toEqual({ host: '127.0.0.1' });
    expect(config.unknownRoot).toEqual(['keep']);
    expect(prompts.selections[0].labels.join('\n')).not.toContain('daemon-endpoint-secret');
    expect(prompts.selections[0].labels.join('\n')).toContain('Mac Studio');
    expect(prompts.selections[0].labels.join('\n')).not.toContain('Phone only');
    expect(prompts.selections[1].labels.join('\n')).toContain('tmux-stable-1');
    expect(prompts.selections[1].labels).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('account-access-secret');
    expect(JSON.stringify(result)).not.toContain('daemon-endpoint-secret');
  });

  it('persists an explicitly typed mirror-fixed width mode', async () => {
    const fixture = await startAccountFixture();
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
        },
      },
    });
    const ownConnection = connection();
    const prompts = new ControlledPrompts({
      select: [0, 0],
      confirm: [false, true],
    });

    const result = await slotSetCommand(slotSetOptions(
      store,
      prompts,
      async () => ownConnection,
      {
        account: fixture.account,
        widthMode: 'mirror-fixed',
      },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'ok',
      value: {
        slot: 1,
        binding: { widthMode: 'mirror-fixed' },
      },
    });
    expect(config.zterm.cli.slots['1'].widthMode).toBe('mirror-fixed');
    expect(ownConnection.readSnapshot).not.toHaveBeenCalled();
    expect(ownConnection.close).toHaveBeenCalledTimes(1);
  });

  it('allows an explicitly confirmed save when no ready mirror exists', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
        },
      },
    });
    const ownConnection = connection({
      readSnapshot: vi.fn(
        async (): Promise<TerminalSnapshotResultPayload> => ({
          status: 'unavailable',
          reason: 'mirror_not_present',
        }),
      ),
    });
    const renderPreview = vi.fn(async () => undefined);
    const prompts = new ControlledPrompts({
      select: [0, 0],
      confirm: [true, true],
    });

    const result = await slotSetCommand(slotSetOptions(
      store,
      prompts,
      async () => ownConnection,
      { account: fixture.account, renderPreview },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result.kind).toBe('ok');
    expect(renderPreview).toHaveBeenCalledWith(
      { status: 'unavailable', reason: 'mirror_not_present' },
      {
        backend: 'tmux',
        stableId: 'tmux-stable-1',
        name: 'work',
      },
    );
    expect(config.zterm.cli.slots['1'].session.stableId).toBe('tmux-stable-1');
    expect(ownConnection.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the original slot and unknown fields when confirmation is cancelled', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
          unknownCliField: { keep: true },
        },
      },
      daemonUnknown: { keep: true },
    });
    const ownConnection = connection();
    const prompts = new ControlledPrompts({
      select: [0, 0],
      confirm: [false],
    });

    const result = await slotSetCommand(slotSetOptions(
      store,
      prompts,
      async () => ownConnection,
      { account: fixture.account },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({ kind: 'cancelled', stage: 'confirm' });
    expect(config.zterm.cli.slots['1']).toEqual(original);
    expect(config.zterm.cli.unknownCliField).toEqual({ keep: true });
    expect(config.daemonUnknown).toEqual({ keep: true });
    expect(ownConnection.close).toHaveBeenCalledTimes(1);
  });

  it('does not save when snapshot identity fails and still closes only its own connection', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
        },
      },
    });
    const ownConnection = connection({
      readSnapshot: vi.fn(
        async (): Promise<TerminalSnapshotResultPayload> => ({
          status: 'failed',
          code: 'session_identity_mismatch',
        }),
      ),
    });
    const prompts = new ControlledPrompts({
      select: [0, 0],
      confirm: [true],
    });

    const result = await slotSetCommand(slotSetOptions(
      store,
      prompts,
      async () => ownConnection,
      { account: fixture.account },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'preview',
      error: { code: 'session_identity_mismatch' },
    });
    expect(config.zterm.cli.slots['1']).toEqual(original);
    expect(ownConnection.close).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a slot changed by another writer after selection', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const latest = binding('latest-writer', 'latest-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
        },
      },
    });
    const ownConnection = connection();
    const factoryCalls: Array<SlotConnectionFactoryOptions> = [];
    const factory: SlotConnectionFactory = async (options) => {
      factoryCalls.push(options);
      await store.update((config) => {
        const zterm = config.zterm as Record<string, unknown>;
        const cli = zterm.cli as Record<string, unknown>;
        const slots = cli.slots as Record<string, unknown>;
        slots['1'] = latest;
        return { value: undefined, changed: true };
      });
      return ownConnection;
    };
    const prompts = new ControlledPrompts({
      select: [0, 0],
      confirm: [false, true],
    });

    const result = await slotSetCommand(slotSetOptions(
      store,
      prompts,
      factory,
      { account: fixture.account },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'save',
      error: { code: 'slot_changed' },
      current: latest,
    });
    expect(config.zterm.cli.slots['1']).toEqual(latest);
    expect(ownConnection.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a session catalog without a stable identity and writes nothing', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
        },
      },
    });
    const ownConnection = connection({
      listSessions: vi.fn(async (): Promise<TerminalSessionCatalog> => ({
        sessionNames: ['work'],
        sessionCatalog: [{ name: 'work', backend: 'tmux' }],
      })),
    });

    const result = await slotSetCommand(slotSetOptions(
      store,
      new ControlledPrompts({ select: [0] }),
      async () => ownConnection,
      { account: fixture.account },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'sessions',
      error: { code: 'stable_session_unavailable' },
    });
    expect(config.zterm.cli.slots['1']).toEqual(original);
    expect(ownConnection.close).toHaveBeenCalledTimes(1);
  });

  it('reports cancellation at a prompt and preserves old auth and slot truth', async () => {
    const fixture = await startAccountFixture();
    const original = binding('original', 'original-id');
    const { homeDir, store } = await createStore({
      zterm: {
        cli: {
          server: { relayBaseUrl: fixture.baseUrl },
          auth: AUTH,
          slots: { '1': original },
          unknownCliField: { keep: true },
        },
      },
    });

    class CancellingPrompts extends ControlledPrompts {
      override async select<T>(): Promise<T> {
        throw new PromptCancelledError('server');
      }
    }

    const result = await slotSetCommand(slotSetOptions(
      store,
      new CancellingPrompts(),
      async () => connection(),
      { account: fixture.account },
    ));
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    expect(result).toMatchObject({ kind: 'cancelled', stage: 'server' });
    expect(config.zterm.cli.auth).toEqual(AUTH);
    expect(config.zterm.cli.slots['1']).toEqual(original);
    expect(config.zterm.cli.unknownCliField).toEqual({ keep: true });
  });
});
