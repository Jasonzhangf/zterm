import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SyncedSlot } from '../../shared/src/connection/cli-slot-config';
import { SharedConfigStore, getSharedConfigPath } from '../../shared/src/node/shared-config';
import { SlotStore, type CliSlotBinding } from './slot-store';

const signal = new AbortController().signal;
const AUTH = {
  loginId: 'login-1',
  userId: 'user-1',
  username: 'jason',
  accessToken: 'account-access-secret',
  authenticatedAt: '2026-10-20T00:00:00.000Z',
};

function binding(
  name: string,
  stableId = `${name}-id`,
  options: {
    alias?: string;
    displayName?: string;
    relayBaseUrl?: string;
    userId?: string;
    widthMode?: CliSlotBinding['widthMode'];
  } = {},
): CliSlotBinding {
  return {
    ...(options.alias === undefined ? {} : { alias: options.alias }),
    account: {
      relayBaseUrl: options.relayBaseUrl ?? 'https://relay.example.test/zterm/',
      userId: options.userId ?? 'user-1',
    },
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
      displayName: options.displayName ?? 'Mac Studio',
    },
    session: {
      backend: 'tmux',
      stableId,
      name,
    },
    widthMode: options.widthMode ?? 'adaptive-phone',
  };
}

function loggedInConfig(
  slots: Record<string, unknown> = {},
  cliOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    zterm: {
      cli: {
        authGeneration: 4,
        server: { relayBaseUrl: 'https://relay.example.test/zterm/' },
        auth: AUTH,
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

function syncedSlot(
  slot: number,
  name: string,
  overrides: Partial<SyncedSlot> = {},
): SyncedSlot {
  const local = binding(name);
  return {
    slot,
    server: local.server,
    session: local.session,
    widthMode: local.widthMode,
    ...overrides,
  };
}

async function createHarness(initial: Record<string, unknown>) {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-slots-'));
  const store = new SharedConfigStore({ homeDir });
  await store.update((latest) => {
    Object.assign(latest, initial);
    return { value: undefined, changed: true };
  }, signal);
  return { homeDir, store, slots: new SlotStore(store) };
}

test('slot read does not create a missing configuration file', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-slots-'));
  try {
    const slots = new SlotStore(new SharedConfigStore({ homeDir }));
    assert.equal(await slots.read(1, signal), undefined);
    assert.equal(existsSync(getSharedConfigPath(homeDir)), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('conditional save rejects a changed target slot and preserves the latest binding', async () => {
  const original = binding('original');
  const latest = binding('latest');
  const { homeDir, slots } = await createHarness({
    zterm: {
      cli: {
        slots: { '3': latest },
      },
    },
  });
  try {
    const result = await slots.saveIfUnchanged({
      slot: 3,
      expected: original,
      binding: binding('draft'),
      signal,
    });
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(result, {
      kind: 'slot_changed',
      current: latest,
    });
    assert.deepEqual(parsed.zterm.cli.slots['3'], latest);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('conditional save commits one binding and preserves unrelated configuration', async () => {
  const { homeDir, slots } = await createHarness({
    zterm: {
      cli: {
        authGeneration: 8,
        unknownCliField: { keep: true },
        slots: {
          '2': binding('two'),
        },
      },
      android: {
        daemon: {
          host: '127.0.0.1',
          futureDaemonField: ['keep'],
        },
      },
    },
    rootUnknown: { nested: true },
  });
  try {
    const expected = binding('two');
    const next = binding('changed', 'changed-id');
    const result = await slots.saveIfUnchanged({
      slot: 2,
      expected,
      binding: next,
      signal,
    });
    const parsed = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(result, { kind: 'saved', slot: 2, binding: next });
    assert.deepEqual(parsed.zterm.cli.slots['2'], next);
    assert.equal(parsed.zterm.cli.authGeneration, 8);
    assert.deepEqual(parsed.zterm.cli.unknownCliField, { keep: true });
    assert.deepEqual(parsed.zterm.android.daemon.futureDaemonField, ['keep']);
    assert.deepEqual(parsed.rootUnknown, { nested: true });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('slot numbers are limited to 1 through 20', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-slots-'));
  try {
    const slots = new SlotStore(new SharedConfigStore({ homeDir }));
    await assert.rejects(slots.read(0, signal), /slot/i);
    await assert.rejects(slots.read(21, signal), /slot/i);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('sync baseline captures all local slots from one logged-in snapshot', async () => {
  const current = binding('current', 'current-id', { alias: 'Current' });
  const foreign = binding('foreign', 'foreign-id', { userId: 'user-2' });
  const { slots } = await createHarness(loggedInConfig({
    '4': foreign,
    '1': current,
  }));
  const loggedOutHomeDir = mkdtempSync(join(tmpdir(), 'zterm-cli-slots-logged-out-'));
  const loggedOut = new SlotStore(new SharedConfigStore({ homeDir: loggedOutHomeDir }));

  try {
    const baseline = await slots.readSyncBaseline({ kind: 'all' }, signal);

    assert.deepEqual(baseline, {
      scope: { kind: 'all' },
      account: {
        authGeneration: 4,
        auth: {
          relayBaseUrl: 'https://relay.example.test/zterm/',
          ...AUTH,
        },
      },
      entries: [
        { slot: 1, binding: current },
        { slot: 4, binding: foreign },
      ],
    });
    assert.equal(await loggedOut.readSyncBaseline({ kind: 'one', slot: 1 }, signal), undefined);
  } finally {
    rmSync(loggedOutHomeDir, { recursive: true, force: true });
  }
});

test('sync checks ignore unrelated edits and detect affected slot or auth changes', async () => {
  const original = binding('original');
  const { slots, store } = await createHarness(
    loggedInConfig({ '1': original, '3': binding('three') }),
  );
  const baseline = await slots.readSyncBaseline({ kind: 'one', slot: 1 }, signal);
  assert.ok(baseline);

  await slots.saveIfUnchanged({
    slot: 3,
    expected: binding('three'),
    binding: binding('three-changed'),
    signal,
  });
  assert.deepEqual(await slots.checkSyncBaseline(baseline, signal), { kind: 'unchanged' });

  await slots.saveIfUnchanged({
    slot: 1,
    expected: original,
    binding: binding('one-changed'),
    signal,
  });
  assert.deepEqual(await slots.checkSyncBaseline(baseline, signal), { kind: 'slot_changed' });

  const authBaseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
  assert.ok(authBaseline);
  await store.update((latest) => {
    latest.rootUnknown = { changed: true };
    return { value: undefined, changed: true };
  });
  assert.deepEqual(await slots.checkSyncBaseline(authBaseline, signal), { kind: 'unchanged' });

  await store.update((latest) => {
    const zterm = latest.zterm as Record<string, unknown>;
    const cli = zterm.cli as Record<string, unknown>;
    cli.authGeneration = 5;
    return { value: undefined, changed: true };
  }, signal);
  assert.deepEqual(await slots.checkSyncBaseline(authBaseline, signal), { kind: 'auth_changed' });
});

test('single pull preserves foreign slots and constructs only local account authority', async () => {
  const foreign = binding('foreign', 'foreign-id', { userId: 'user-2' });
  const { homeDir, slots } = await createHarness(loggedInConfig({
    '1': binding('local'),
    '2': foreign,
  }));
  const baseline = await slots.readSyncBaseline({ kind: 'one', slot: 1 }, signal);
  assert.ok(baseline);

  try {
    const result = await slots.applyPulledSlots({
      baseline,
      slots: [
        syncedSlot(1, 'pulled', {
          alias: '  pulled alias  ',
          widthMode: 'mirror-fixed',
          server: {
            deviceId: 'device-2',
            daemonHostId: 'daemon-2',
            displayName: 'MacBook Air',
          },
        }),
      ],
      signal,
    });
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(result, {
      kind: 'saved',
      slots: [
        {
          slot: 1,
          binding: {
            alias: 'pulled alias',
            account: {
              relayBaseUrl: 'https://relay.example.test/zterm/',
              userId: 'user-1',
            },
            server: {
              deviceId: 'device-2',
              daemonHostId: 'daemon-2',
              displayName: 'MacBook Air',
            },
            session: {
              backend: 'tmux',
              stableId: 'pulled-id',
              name: 'pulled',
            },
            widthMode: 'mirror-fixed',
          },
        },
        { slot: 2, binding: foreign },
      ],
    });
    assert.deepEqual(config.zterm.cli.slots['2'], foreign);
    assert.equal(config.zterm.cli.authGeneration, 4);
    assert.deepEqual(config.zterm.cli.auth, AUTH);
    assert.deepEqual(config.zterm.android.daemon.futureDaemonField, ['keep']);
    assert.deepEqual(config.rootUnknown, { keep: true });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('single pull ignores foreign collisions outside the selected slot; full pull rejects the same map', async () => {
  const foreign = binding('foreign', 'foreign-id', { userId: 'user-2' });
  const localOne = binding('local-one', 'local-one-id');
  const { homeDir, slots } = await createHarness(loggedInConfig({
    '1': localOne,
    '2': foreign,
  }));
  const cloud = [
    syncedSlot(1, 'cloud-one', { alias: 'Cloud One' }),
    syncedSlot(2, 'cloud-two'),
  ];

  try {
    const singleBaseline = await slots.readSyncBaseline({ kind: 'one', slot: 1 }, signal);
    assert.ok(singleBaseline);
    const single = await slots.applyPulledSlots({
      baseline: singleBaseline,
      slots: cloud,
      signal,
    });
    const afterSingleConfig = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(single, {
      kind: 'saved',
      slots: [
        { slot: 1, binding: afterSingleConfig.zterm.cli.slots['1'] },
        { slot: 2, binding: foreign },
      ],
    });
    assert.notDeepEqual(afterSingleConfig.zterm.cli.slots['1'], localOne);
    assert.equal(afterSingleConfig.zterm.cli.slots['1'].session.name, 'cloud-one');
    assert.equal(afterSingleConfig.zterm.cli.slots['1'].alias, 'Cloud One');
    assert.deepEqual(afterSingleConfig.zterm.cli.slots['2'], foreign);

    const allBaseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
    assert.ok(allBaseline);
    const beforeFull = readFileSync(getSharedConfigPath(homeDir), 'utf8');
    assert.deepEqual(
      await slots.applyPulledSlots({
        baseline: allBaseline,
        slots: cloud,
        signal,
      }),
      { kind: 'foreign_slot_conflict', slots: [2] },
    );
    assert.equal(readFileSync(getSharedConfigPath(homeDir), 'utf8'), beforeFull);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('single pull still rejects an invalid entry outside the selected slot', async () => {
  const { homeDir, slots } = await createHarness(loggedInConfig({ '1': binding('one') }));
  const baseline = await slots.readSyncBaseline({ kind: 'one', slot: 1 }, signal);
  assert.ok(baseline);

  try {
    const before = readFileSync(getSharedConfigPath(homeDir), 'utf8');
    await assert.rejects(
      slots.applyPulledSlots({
        baseline,
        slots: [
          syncedSlot(1, 'valid'),
          {
            ...syncedSlot(2, 'invalid'),
            session: {
              backend: 'invalid',
              stableId: 'invalid-id',
              name: 'invalid',
            },
          } as unknown as SyncedSlot,
        ],
        signal,
      }),
      /backend/i,
    );
    assert.equal(readFileSync(getSharedConfigPath(homeDir), 'utf8'), before);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('full pull replaces only the current account and preserves foreign slots', async () => {
  const foreign = binding('foreign', 'foreign-id', { userId: 'user-2' });
  const { homeDir, slots } = await createHarness(loggedInConfig({
    '1': binding('one'),
    '2': foreign,
    '3': binding('three'),
  }));
  const baseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
  assert.ok(baseline);

  try {
    const result = await slots.applyPulledSlots({
      baseline,
      slots: [
        syncedSlot(4, 'four', { alias: 'Four' }),
        syncedSlot(1, 'one-pulled', { widthMode: 'mirror-fixed' }),
      ],
      signal,
    });
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.equal(config.zterm.cli.slots['2'].account.userId, 'user-2');
    assert.equal(config.zterm.cli.slots['3'], undefined);
    assert.equal(config.zterm.cli.slots['1'].alias, undefined);
    assert.equal(config.zterm.cli.slots['1'].widthMode, 'mirror-fixed');
    assert.equal(config.zterm.cli.slots['4'].account.userId, 'user-1');
    assert.equal(config.zterm.cli.slots['4'].alias, 'Four');
    assert.deepEqual(result, {
      kind: 'saved',
      slots: [
        { slot: 1, binding: config.zterm.cli.slots['1'] },
        { slot: 2, binding: foreign },
        { slot: 4, binding: config.zterm.cli.slots['4'] },
      ],
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('an explicitly empty full pull clears only current-account slots', async () => {
  const foreign = binding('foreign', 'foreign-id', { userId: 'user-2' });
  const { homeDir, slots } = await createHarness(loggedInConfig({
    '1': binding('one'),
    '2': foreign,
    '3': binding('three'),
  }));
  const baseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
  assert.ok(baseline);

  try {
    const result = await slots.applyPulledSlots({ baseline, slots: [], signal });
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(result, {
      kind: 'saved',
      slots: [{ slot: 2, binding: foreign }],
    });
    assert.deepEqual(Object.keys(config.zterm.cli.slots), ['2']);
    assert.deepEqual(config.zterm.cli.slots['2'], foreign);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('pull rejects incoming foreign collisions and invalid payloads without partial writes', async () => {
  const foreign = binding('foreign', 'foreign-id', { userId: 'user-2' });
  const { homeDir, slots } = await createHarness(loggedInConfig({
    '1': binding('one'),
    '2': foreign,
  }));
  const baseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
  assert.ok(baseline);

  try {
    const before = readFileSync(getSharedConfigPath(homeDir), 'utf8');
    const conflict = await slots.applyPulledSlots({
      baseline,
      slots: [syncedSlot(1, 'valid'), syncedSlot(2, 'collision')],
      signal,
    });

    assert.deepEqual(conflict, {
      kind: 'foreign_slot_conflict',
      slots: [2],
    });
    assert.equal(readFileSync(getSharedConfigPath(homeDir), 'utf8'), before);

    await assert.rejects(
      slots.applyPulledSlots({
        baseline,
        slots: [
          syncedSlot(1, 'valid'),
          {
            ...syncedSlot(4, 'invalid'),
            session: {
              backend: 'invalid',
              stableId: 'invalid-id',
              name: 'invalid',
            },
          } as unknown as SyncedSlot,
        ],
        signal,
      }),
      /backend/i,
    );
    assert.equal(readFileSync(getSharedConfigPath(homeDir), 'utf8'), before);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('pull rejects concurrent auth, new current-account slots, and single-slot creation', async () => {
  const { homeDir, slots, store } = await createHarness(
    loggedInConfig({ '1': binding('one') }),
  );
  const fullBaseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
  assert.ok(fullBaseline);
  await slots.saveIfUnchanged({
    slot: 5,
    expected: undefined,
    binding: binding('five'),
    signal,
  });

  try {
    const afterNewSlot = readFileSync(getSharedConfigPath(homeDir), 'utf8');
    assert.deepEqual(
      await slots.applyPulledSlots({ baseline: fullBaseline, slots: [], signal }),
      { kind: 'slot_changed' },
    );
    assert.equal(readFileSync(getSharedConfigPath(homeDir), 'utf8'), afterNewSlot);

    const oneBaseline = await slots.readSyncBaseline({ kind: 'one', slot: 3 }, signal);
    assert.ok(oneBaseline);
    await slots.saveIfUnchanged({
      slot: 3,
      expected: undefined,
      binding: binding('three'),
      signal,
    });
    assert.deepEqual(
      await slots.applyPulledSlots({
        baseline: oneBaseline,
        slots: [syncedSlot(3, 'three-pulled')],
        signal,
      }),
      { kind: 'slot_changed' },
    );

    const authBaseline = await slots.readSyncBaseline({ kind: 'all' }, signal);
    assert.ok(authBaseline);
    await store.update((latest) => {
      const zterm = latest.zterm as Record<string, unknown>;
      const cli = zterm.cli as Record<string, unknown>;
      cli.authGeneration = 9;
      return { value: undefined, changed: true };
    }, signal);
    assert.deepEqual(
      await slots.applyPulledSlots({ baseline: authBaseline, slots: [], signal }),
      { kind: 'auth_changed' },
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('single pull reports a missing cloud slot without a local write', async () => {
  const { homeDir, slots } = await createHarness(loggedInConfig({ '1': binding('one') }));
  const baseline = await slots.readSyncBaseline({ kind: 'one', slot: 1 }, signal);
  assert.ok(baseline);

  try {
    const before = readFileSync(getSharedConfigPath(homeDir), 'utf8');
    assert.deepEqual(
      await slots.applyPulledSlots({
        baseline,
        slots: [syncedSlot(2, 'two')],
        signal,
      }),
      { kind: 'cloud_slot_missing' },
    );
    assert.equal(readFileSync(getSharedConfigPath(homeDir), 'utf8'), before);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('rename changes only the alias and rejects stale or missing targets', async () => {
  const original = {
    ...binding('original', 'original-id', { widthMode: 'mirror-fixed' }),
    futureBindingField: { keep: true },
  };
  const { homeDir, slots, store } = await createHarness({
    zterm: {
      cli: {
        slots: { '2': original },
        unknownCliField: { keep: true },
      },
      android: { daemon: { host: '127.0.0.1' } },
    },
  });

  try {
    const renamed = await slots.renameIfUnchanged({
      slot: 2,
      expectedOriginal: original,
      alias: '  工作台  ',
      signal,
    });
    const config = JSON.parse(readFileSync(getSharedConfigPath(homeDir), 'utf8'));

    assert.deepEqual(renamed, {
      kind: 'saved',
      slot: 2,
      binding: { ...original, alias: '工作台' },
    });
    assert.deepEqual(config.zterm.cli.slots['2'], { ...original, alias: '工作台' });
    assert.deepEqual(config.zterm.cli.unknownCliField, { keep: true });
    assert.deepEqual(config.zterm.android.daemon, { host: '127.0.0.1' });
    assert.equal(config.zterm.cli.auth, undefined);

    assert.deepEqual(
      await slots.renameIfUnchanged({
        slot: 2,
        expectedOriginal: original,
        alias: 'stale',
        signal,
      }),
      {
        kind: 'slot_changed',
        current: { ...original, alias: '工作台' },
      },
    );
    assert.deepEqual(
      await slots.renameIfUnchanged({
        slot: 8,
        expectedOriginal: undefined,
        alias: 'missing',
        signal,
      }),
      { kind: 'slot_missing' },
    );

    await store.update((latest) => {
      const zterm = latest.zterm as Record<string, unknown>;
      const cli = zterm.cli as Record<string, unknown>;
      const savedSlots = cli.slots as Record<string, unknown>;
      delete savedSlots['2'];
      return { value: undefined, changed: true };
    }, signal);
    assert.deepEqual(
      await slots.renameIfUnchanged({
        slot: 2,
        expectedOriginal: { ...original, alias: '工作台' },
        alias: 'removed-concurrently',
        signal,
      }),
      { kind: 'slot_changed', current: undefined },
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
