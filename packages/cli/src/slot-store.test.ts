import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SharedConfigStore, getSharedConfigPath } from '../../shared/src/node/shared-config';
import { SlotStore, type CliSlotBinding } from './slot-store';

const signal = new AbortController().signal;

function binding(name: string, stableId = `${name}-id`): CliSlotBinding {
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
      stableId,
      name,
    },
    widthMode: 'adaptive-phone',
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
