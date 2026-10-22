import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncedSlot } from '../../../shared/src/connection/cli-slot-config.js';
import {
  SharedConfigStore,
  type JsonObject,
} from '../../../shared/src/node/shared-config.js';
import {
  AccountClient,
  type AccountClientFetch,
} from '../account-client.js';
import { AccountState } from '../account-state.js';
import {
  SlotStore,
  type CliSlotBinding,
} from '../slot-store.js';
import { slotSyncCommand } from './slot-sync.js';

const SERVER = 'https://relay.example.test/zterm/';
const USER = { id: 'user-1', username: 'jason' };
const OTHER = { id: 'user-2', username: 'other' };
const AUTH = {
  loginId: 'login-1',
  userId: USER.id,
  username: USER.username,
  accessToken: 'account-access-secret',
  authenticatedAt: '2026-10-20T00:00:00.000Z',
};

const homeDirs: string[] = [];

afterEach(() => {
  for (const homeDir of homeDirs.splice(0)) {
    rmSync(homeDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function binding(
  name: string,
  options: {
    alias?: string;
    stableId?: string;
    userId?: string;
    relayBaseUrl?: string;
    widthMode?: CliSlotBinding['widthMode'];
    displayName?: string;
  } = {},
): CliSlotBinding {
  return {
    ...(options.alias === undefined ? {} : { alias: options.alias }),
    account: {
      relayBaseUrl: options.relayBaseUrl ?? SERVER,
      userId: options.userId ?? USER.id,
    },
    server: {
      deviceId: `${name}-device`,
      daemonHostId: `${name}-daemon`,
      displayName: options.displayName ?? 'Mac Studio',
    },
    session: {
      backend: 'tmux',
      stableId: options.stableId ?? `${name}-stable`,
      name,
    },
    widthMode: options.widthMode ?? 'adaptive-phone',
  };
}

function synced(
  slot: number,
  name: string,
  overrides: Partial<SyncedSlot> = {},
): SyncedSlot {
  const local = binding(name);
  const value: SyncedSlot = {
    slot,
    server: overrides.server ?? local.server,
    session: overrides.session ?? local.session,
    widthMode: overrides.widthMode ?? local.widthMode,
  };
  if (overrides.alias !== undefined) {
    value.alias = overrides.alias;
  }
  return value;
}

function config(
  slots: Record<string, CliSlotBinding> = {},
  cliOverrides: JsonObject = {},
): JsonObject {
  return {
    zterm: {
      cli: {
        authGeneration: 4,
        server: { relayBaseUrl: SERVER },
        auth: { ...AUTH },
        slots,
        unknownCliField: { keep: true },
        ...cliOverrides,
      },
      android: {
        daemon: {
          host: '127.0.0.1',
          futureDaemonField: ['keep'],
        },
      },
    },
    rootUnknown: { keep: true },
  };
}

function loggedOutConfig(slots: Record<string, CliSlotBinding> = {}): JsonObject {
  const value = config(slots);
  delete cliOf(value).auth;
  return value;
}

function cliOf(value: JsonObject): JsonObject {
  return (value.zterm as JsonObject).cli as JsonObject;
}

function slotsOf(value: JsonObject): Record<string, unknown> {
  return cliOf(value).slots as Record<string, unknown>;
}

interface FetchRecord {
  url: string;
  method: string;
  body: unknown;
  headers: HeadersInit | undefined;
}

function recordFetch(
  handler: (record: FetchRecord) => Promise<Response> | Response,
) {
  const requests: FetchRecord[] = [];
  const fetchImpl: AccountClientFetch = async (input, init) => {
    const record: FetchRecord = {
      url: input,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers,
    };
    requests.push(record);
    return handler(record);
  };
  return { fetchImpl, requests };
}

function controllableFetch() {
  const requests: FetchRecord[] = [];
  let release!: (response: Response) => void;
  let fail!: (error: unknown) => void;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const gate = new Promise<Response>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const fetchImpl: AccountClientFetch = async (input, init) => {
    requests.push({
      url: input,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers,
    });
    start();
    return gate;
  };
  return { fetchImpl, requests, started, release, fail };
}

async function createHarness(
  initial: JsonObject,
  fetchImpl: AccountClientFetch,
) {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-sync-'));
  homeDirs.push(homeDir);
  const store = new SharedConfigStore({ homeDir });
  await store.update((latest) => {
    Object.assign(latest, initial);
    return { value: undefined, changed: true };
  });
  return { homeDir, store, account: new AccountClient(fetchImpl) };
}

async function readConfig(store: SharedConfigStore): Promise<JsonObject> {
  return (await store.read()).config;
}

function cloudOk(
  userId = USER.id,
  cloud:
    | { configured: false }
    | { configured: true; slots: SyncedSlot[] } = {
    configured: true,
    slots: [],
  },
): Response {
  return new Response(JSON.stringify({
    ok: true,
    schemaVersion: 1,
    user: { id: userId },
    config: cloud,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function cloudError(status: number, code: string): Response {
  return new Response(JSON.stringify({
    ok: false,
    error: { code, message: 'server says no' },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function committedGatewayFetch(
  status: number,
  body: string,
  contentType: string,
) {
  const requests: FetchRecord[] = [];
  let remoteSlots: SyncedSlot[] = [synced(1, 'remote-old'), synced(2, 'remote-two')];
  const fetchImpl: AccountClientFetch = async (input, init) => {
    requests.push({
      url: input,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init.headers,
    });
    const slot = Number(input.slice(input.lastIndexOf('/') + 1));
    const payload = JSON.parse(String(init.body)) as {
      binding: Omit<SyncedSlot, 'slot'>;
    };
    remoteSlots = [
      ...remoteSlots.filter((entry) => entry.slot !== slot),
      { slot, ...payload.binding },
    ].sort((left, right) => left.slot - right.slot);
    return new Response(body, {
      status,
      headers: { 'content-type': contentType },
    });
  };
  return { fetchImpl, requests, remoteSlots: () => remoteSlots };
}

describe('slotSyncCommand pull', () => {
  it('pulls one slot and preserves foreign and unrelated config', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [
        synced(1, 'cloud-one', { alias: '新' }),
        synced(7, 'cloud-seven'),
      ],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one', { alias: '旧' }),
      '3': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
      count: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    const after = await readConfig(harness.store);
    expect(Object.keys(slotsOf(after)).sort()).toEqual(['1', '3']);
    expect(slotsOf(after)['1']).toMatchObject({
      alias: '新',
      session: { name: 'cloud-one' },
    });
    expect(slotsOf(after)['3']).toEqual(binding('foreign', { userId: OTHER.id }));
    expect(after.rootUnknown).toEqual({ keep: true });
    expect(cliOf(after).unknownCliField).toEqual({ keep: true });
  });

  it('pulls one slot when another cloud slot collides with a foreign local slot; full pull rejects the same map', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one'), synced(2, 'cloud-two')],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
      '2': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);

    const single = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });

    expect(single).toEqual({
      kind: 'ok',
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
      count: 1,
    });
    expect(requests).toHaveLength(1);
    const afterSingle = await readConfig(harness.store);
    expect(Object.keys(slotsOf(afterSingle)).sort()).toEqual(['1', '2']);
    expect((slotsOf(afterSingle)['1'] as CliSlotBinding).session.name).toBe('cloud-one');
    expect(slotsOf(afterSingle)['2']).toEqual(binding('foreign', { userId: OTHER.id }));

    const beforeFull = readFileSync(harness.store.path, 'utf8');
    const full = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });

    expect(full).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'foreign_slot_conflict' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(beforeFull);
  });

  it('pulls all slots and replaces only the current account map', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one'), synced(4, 'cloud-four')],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
      '2': binding('local-two'),
      '3': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'pull',
      scope: { kind: 'all' },
      count: 2,
    });
    const after = await readConfig(harness.store);
    expect(Object.keys(slotsOf(after)).sort()).toEqual(['1', '3', '4']);
    expect((slotsOf(after)['1'] as CliSlotBinding).session.name).toBe('cloud-one');
    expect((slotsOf(after)['3'] as CliSlotBinding).session.name).toBe('foreign');
    expect((slotsOf(after)['4'] as CliSlotBinding).session.name).toBe('cloud-four');
  });

  it('allows an intentionally empty cloud map and clears only current account slots', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
      '2': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'pull',
      scope: { kind: 'all' },
      count: 0,
    });
    const after = await readConfig(harness.store);
    expect(Object.keys(slotsOf(after))).toEqual(['2']);
    expect((slotsOf(after)['2'] as CliSlotBinding).session.name).toBe('foreign');
  });

  it('does not write when the cloud config is missing', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(USER.id, { configured: false }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'read',
      error: { code: 'cloud_config_missing' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });

  it('reports a missing cloud slot for single pull without writing', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'read',
      error: { code: 'cloud_slot_missing' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });

  it('rejects a foreign slot collision without changing any local slot', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [synced(2, 'cloud-two'), synced(3, 'cloud-three')],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
      '2': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'foreign_slot_conflict' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });

  it('rejects the full map when any cloud slot is invalid', async () => {
    const invalid = synced(1, 'cloud-one') as SyncedSlot & {
      server: Record<string, unknown>;
    };
    invalid.server = { ...invalid.server, extra: true };
    const { fetchImpl } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [invalid],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'read',
      error: { code: 'response_invalid' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });

  it('keeps local slots when the cloud response belongs to another account', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(OTHER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'read',
      error: { code: 'cloud_account_mismatch' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });
});

describe('slotSyncCommand pull lifecycle', () => {
  it('rejects a pull when the account logs out during the cloud read', async () => {
    const control = controllableFetch();
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });
    await control.started;
    await new AccountState({ store: harness.store }).logout();
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));

    const result = await pending;

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'auth_changed' },
    });
    const after = await readConfig(harness.store);
    expect(slotsOf(after)['1']).toEqual(binding('local-one'));
    expect(cliOf(after).auth).toBeUndefined();
  });

  it('rejects a pull when the account changes during the cloud read', async () => {
    const control = controllableFetch();
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });
    await control.started;
    const state = new AccountState({ store: harness.store });
    const begin = await state.beginLogin({ consumeConfigPassword: false });
    const committed = await state.commitLogin(
      begin.attempt,
      { relayBaseUrl: SERVER },
      {
        loginId: 'login-2',
        userId: OTHER.id,
        username: OTHER.username,
        accessToken: 'other-access-secret',
        authenticatedAt: '2026-10-21T00:00:00.000Z',
      },
    );
    expect(committed.kind).toBe('committed');
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));

    const result = await pending;

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'auth_changed' },
    });
    const after = await readConfig(harness.store);
    expect(slotsOf(after)['1']).toEqual(binding('local-one'));
    expect((cliOf(after).auth as JsonObject).userId).toBe(OTHER.id);
  });

  it('rejects a pull when the affected slot changes during the cloud read', async () => {
    const control = controllableFetch();
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });
    await control.started;
    const slots = new SlotStore(harness.store);
    await slots.saveIfUnchanged({
      slot: 1,
      expected: await slots.read(1),
      binding: binding('edited'),
    });
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));

    const result = await pending;

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'slot_changed' },
    });
    const after = await readConfig(harness.store);
    expect((slotsOf(after)['1'] as CliSlotBinding).session.name).toBe('edited');
  });

  it('rejects a full pull when a new current-account slot appears', async () => {
    const control = controllableFetch();
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
    });
    await control.started;
    const slots = new SlotStore(harness.store);
    await slots.saveIfUnchanged({
      slot: 5,
      expected: undefined,
      binding: binding('new-five'),
    });
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));

    const result = await pending;

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'commit',
      error: { code: 'slot_changed' },
    });
    const after = await readConfig(harness.store);
    expect((slotsOf(after)['5'] as CliSlotBinding).session.name).toBe('new-five');
  });

  it('preserves an unrelated daemon edit during a pull', async () => {
    const control = controllableFetch();
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
    });
    await control.started;
    await harness.store.update((latest) => {
      const zterm = latest.zterm as JsonObject;
      zterm.android = { daemon: { host: 'edited-during-pull' } };
      return { value: undefined, changed: true };
    });
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));

    const result = await pending;

    expect(result).toEqual({
      kind: 'ok',
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
      count: 1,
    });
    const after = await readConfig(harness.store);
    expect((after.zterm as JsonObject).android).toEqual({
      daemon: { host: 'edited-during-pull' },
    });
    expect((slotsOf(after)['1'] as CliSlotBinding).session.name).toBe('cloud-one');
  });

  it('reports cancellation before the local pull commit without writing', async () => {
    const control = controllableFetch();
    const controller = new AbortController();
    const harness = await createHarness(config({
      '1': binding('local-one'),
    }), control.fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 1 },
      signal: controller.signal,
    });
    await control.started;
    controller.abort();
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'cloud-one')],
    }));

    const result = await pending;

    expect(result).toEqual({ kind: 'cancelled', stage: 'commit' });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });
});

describe('slotSyncCommand push', () => {
  it('pushes one slot with only the shared whitelist fields', async () => {
    const local = binding('work', { alias: '工作' });
    const { fetchImpl, requests } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'work', { alias: '工作' })],
    }));
    const harness = await createHarness(config({ '1': local }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
      count: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].url).toBe(`${SERVER}api/cli/slots/1`);
    expect(requests[0].body).toEqual({
      schemaVersion: 1,
      binding: {
        alias: '工作',
        server: local.server,
        session: local.session,
        widthMode: local.widthMode,
      },
    });
    const serialized = JSON.stringify(requests[0].body);
    expect(serialized).not.toContain('account');
    expect(serialized).not.toContain('accessToken');
  });

  it('filters foreign slots from a full push', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'one'), synced(3, 'three')],
    }));
    const harness = await createHarness(config({
      '1': binding('one'),
      '2': binding('foreign', { userId: OTHER.id }),
      '3': binding('three'),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'all' },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'push',
      scope: { kind: 'all' },
      count: 2,
    });
    const body = requests[0].body as { slots: SyncedSlot[] };
    expect(body.slots.map((slot) => slot.slot)).toEqual([1, 3]);
    expect(body.slots.every((slot) => slot.session.name !== 'foreign')).toBe(true);
  });

  it('ignores a malformed local entry during a full push', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'one')],
    }));
    const harness = await createHarness(config({
      '1': binding('one'),
      '2': null as unknown as CliSlotBinding,
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'all' },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'push',
      scope: { kind: 'all' },
      count: 1,
    });
    const body = requests[0].body as { slots: SyncedSlot[] };
    expect(body.slots.map((slot) => slot.slot)).toEqual([1]);
  });

  it('allows an intentional empty full push', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk(USER.id, {
      configured: true,
      slots: [],
    }));
    const harness = await createHarness(config({
      '2': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'all' },
    });

    expect(result).toEqual({
      kind: 'ok',
      direction: 'push',
      scope: { kind: 'all' },
      count: 0,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ schemaVersion: 1, slots: [] });
  });

  it('rejects a foreign single slot without sending a request', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk());
    const harness = await createHarness(config({
      '2': binding('foreign', { userId: OTHER.id }),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 2 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'select',
      error: { code: 'slot_account_mismatch' },
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects a missing local slot without sending a request', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk());
    const harness = await createHarness(config(), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 3 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'select',
      error: { code: 'slot_missing' },
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects a push without stored credentials', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk());
    const harness = await createHarness(loggedOutConfig({
      '1': binding('one'),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'auth',
      error: { code: 'login_required' },
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects a slot changed after capture and sends no request', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk());
    const harness = await createHarness(config({
      '1': binding('original'),
    }), fetchImpl);
    const external = new SharedConfigStore({ homeDir: harness.homeDir });
    const originalRead = harness.store.read.bind(harness.store);
    let reads = 0;
    vi.spyOn(harness.store, 'read').mockImplementation(async () => {
      const snapshot = await originalRead();
      reads += 1;
      if (reads === 2) {
        await external.update((latest) => {
          slotsOf(latest)['1'] = binding('changed');
          return { value: undefined, changed: true };
        });
        return external.read();
      }
      return snapshot;
    });

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'preflight',
      error: { code: 'slot_changed' },
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects an account change after capture and sends no request', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk());
    const harness = await createHarness(config({
      '1': binding('original'),
    }), fetchImpl);
    const external = new SharedConfigStore({ homeDir: harness.homeDir });
    const originalRead = harness.store.read.bind(harness.store);
    let reads = 0;
    vi.spyOn(harness.store, 'read').mockImplementation(async () => {
      const snapshot = await originalRead();
      reads += 1;
      if (reads === 2) {
        await new AccountState({ store: external }).logout();
        return external.read();
      }
      return snapshot;
    });

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'preflight',
      error: { code: 'auth_changed' },
    });
    expect(requests).toHaveLength(0);
  });

  it('cancels before dispatch with false dispatch metadata and no request', async () => {
    const control = controllableFetch();
    const controller = new AbortController();
    const harness = await createHarness(config({
      '1': binding('original'),
    }), control.fetchImpl);
    const originalRead = harness.store.read.bind(harness.store);
    let reads = 0;
    vi.spyOn(harness.store, 'read').mockImplementation(async () => {
      const snapshot = await originalRead();
      reads += 1;
      if (reads === 2) controller.abort();
      return snapshot;
    });

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: 'cancelled', stage: 'write' });
    expect(control.requests).toHaveLength(0);
  });

  it('reports a network failure after dispatch as unknown with no retry', async () => {
    const { fetchImpl, requests } = recordFetch(async () => {
      throw new TypeError('socket closed');
    });
    const harness = await createHarness(config({
      '1': binding('one'),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'write',
      error: { code: 'remote_commit_unknown' },
    });
    expect(requests).toHaveLength(1);
  });

  it('reports a cancellation after dispatch as unknown with no retry', async () => {
    const control = controllableFetch();
    const controller = new AbortController();
    const harness = await createHarness(config({
      '1': binding('one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
      signal: controller.signal,
    });
    await control.started;
    controller.abort();
    control.fail(new DOMException('aborted', 'AbortError'));

    const result = await pending;

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'write',
      error: { code: 'remote_commit_unknown' },
    });
    expect(control.requests).toHaveLength(1);
  });

  it('reports an invalid response after dispatch as unknown with no retry', async () => {
    const { fetchImpl, requests } = recordFetch(() => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const harness = await createHarness(config({
      '1': binding('one'),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'write',
      error: { code: 'remote_commit_unknown' },
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [502, '<html>bad gateway</html>', 'text/html'],
    [504, '<html>gateway timeout</html>', 'text/html'],
    [502, JSON.stringify({
      ok: false,
      error: { code: 'persistence_failed', message: 'proxy response' },
    }), 'application/json'],
    [504, JSON.stringify({
      ok: false,
      error: { code: 'gateway_timeout', message: 'proxy response' },
    }), 'application/json'],
  ])(
    'preserves remote snapshot uncertainty for HTTP %s %s responses',
    async (status, body, contentType) => {
      const gateway = committedGatewayFetch(status, body, contentType);
      const harness = await createHarness(config({
        '1': binding('one'),
        '3': binding('local-other'),
      }), gateway.fetchImpl);
      const before = readFileSync(harness.store.path, 'utf8');

      const result = await slotSyncCommand({
        store: harness.store,
        account: harness.account,
        direction: 'push',
        scope: { kind: 'one', slot: 1 },
      });

      expect(gateway.remoteSlots()).toEqual([
        synced(1, 'one'),
        synced(2, 'remote-two'),
      ]);
      expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
      expect(result).toEqual({
        kind: 'failed',
        stage: 'write',
        error: {
          code: 'remote_commit_unknown',
          message: '云端写入结果无法确认，本次推送可能已生效。',
          action: '请先重新读取云端槽位确认当前内容，再决定是否再次推送。',
        },
      });
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0].method).toBe('PUT');
    },
  );

  it('keeps a definite HTTP rejection and its status', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudError(503, 'persistence_failed'));
    const harness = await createHarness(config({
      '1': binding('one'),
    }), fetchImpl);

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'write',
      error: { code: 'persistence_failed', status: 503 },
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [400, 'invalid_request'],
    [400, 'invalid_slot_config'],
    [400, 'invalid_device_set'],
    [401, 'auth_invalid'],
    [409, 'device_cleanup_rejected'],
    [413, 'request_too_large'],
    [503, 'slot_config_unavailable'],
  ])(
    'keeps a recognized Relay HTTP %s %s rejection',
    async (status, code) => {
      const { fetchImpl, requests } = recordFetch(() => cloudError(status, code));
      const harness = await createHarness(config({
        '1': binding('one'),
      }), fetchImpl);

      const result = await slotSyncCommand({
        store: harness.store,
        account: harness.account,
        direction: 'push',
        scope: { kind: 'one', slot: 1 },
      });

      expect(result).toMatchObject({
        kind: 'failed',
        stage: 'write',
        error: { code, status },
      });
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    [503, { ok: false, error: { code: 'invalid_request', message: 'mismatch' } }],
    [400, { ok: false, error: { message: 'missing code' } }],
  ])(
    'does not treat malformed or mismatched HTTP %s errors as definite rejection',
    async (status, payload) => {
      const { fetchImpl, requests } = recordFetch(() => new Response(
        JSON.stringify(payload),
        {
          status,
          headers: { 'content-type': 'application/json' },
        },
      ));
      const harness = await createHarness(config({
        '1': binding('one'),
      }), fetchImpl);

      const result = await slotSyncCommand({
        store: harness.store,
        account: harness.account,
        direction: 'push',
        scope: { kind: 'one', slot: 1 },
      });

      expect(result).toMatchObject({
        kind: 'failed',
        stage: 'write',
        error: { code: 'remote_commit_unknown' },
      });
      expect(requests).toHaveLength(1);
    },
  );

  it('reports a valid acknowledgement received after abort as success', async () => {
    const control = controllableFetch();
    const controller = new AbortController();
    const harness = await createHarness(config({
      '1': binding('one'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
      signal: controller.signal,
    });
    await control.started;
    controller.abort();
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'one')],
    }));

    const result = await pending;

    expect(result).toEqual({
      kind: 'ok',
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
      count: 1,
    });
  });

  it('reports a wrong account response after write as unknown', async () => {
    const { fetchImpl } = recordFetch(() => cloudOk(OTHER.id, {
      configured: true,
      slots: [synced(1, 'one')],
    }));
    const harness = await createHarness(config({
      '1': binding('one'),
    }), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'write',
      error: { code: 'remote_commit_unknown' },
    });
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });

  it('does not change the submitted snapshot when a local edit follows dispatch', async () => {
    const control = controllableFetch();
    const harness = await createHarness(config({
      '1': binding('original'),
    }), control.fetchImpl);
    const pending = slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
    });
    await control.started;
    const submitted = control.requests[0].body as {
      binding: { session: { name: string } };
    };
    const slots = new SlotStore(harness.store);
    await slots.saveIfUnchanged({
      slot: 1,
      expected: await slots.read(1),
      binding: binding('edited'),
    });
    control.release(cloudOk(USER.id, {
      configured: true,
      slots: [synced(1, 'original')],
    }));

    const result = await pending;

    expect(result).toEqual({
      kind: 'ok',
      direction: 'push',
      scope: { kind: 'one', slot: 1 },
      count: 1,
    });
    expect(submitted.binding.session.name).toBe('original');
    const after = await readConfig(harness.store);
    expect((slotsOf(after)['1'] as CliSlotBinding).session.name).toBe('edited');
  });
});

describe('slotSyncCommand preflight', () => {
  it('validates the scope without touching storage or the network', async () => {
    const { fetchImpl, requests } = recordFetch(() => cloudOk());
    const harness = await createHarness(config(), fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'one', slot: 0 } as never,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      stage: 'validate',
      error: { code: 'invalid_scope' },
    });
    expect(requests).toHaveLength(0);
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });

  it('returns cancellation for a pre-aborted signal without side effects', async () => {
    const control = controllableFetch();
    const controller = new AbortController();
    controller.abort();
    const harness = await createHarness(config({
      '1': binding('one'),
    }), control.fetchImpl);
    const before = readFileSync(harness.store.path, 'utf8');

    const result = await slotSyncCommand({
      store: harness.store,
      account: harness.account,
      direction: 'pull',
      scope: { kind: 'all' },
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: 'cancelled', stage: 'preflight' });
    expect(control.requests).toHaveLength(0);
    expect(readFileSync(harness.store.path, 'utf8')).toBe(before);
  });
});
