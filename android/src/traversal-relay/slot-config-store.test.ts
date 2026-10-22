import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync as renameFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SlotConfigValidationError,
  type SyncedSlot,
  type SyncedSlotBinding,
} from '@zterm/shared/connection/cli-slot-config';
import {
  RelaySlotConfigStore,
  SlotConfigPersistenceError,
  SlotConfigUnavailableError,
} from './slot-config-store';

const createdDirectories: string[] = [];

function createStorePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'zterm-slot-config-'));
  createdDirectories.push(directory);
  return join(directory, 'cli-slot-config.json');
}

function binding(overrides: Partial<SyncedSlotBinding> = {}): SyncedSlotBinding {
  return {
    server: {
      deviceId: 'device-1',
      daemonHostId: 'daemon-1',
      displayName: 'Desk',
    },
    session: {
      backend: 'tmux',
      stableId: 'stable-1',
      name: 'main',
    },
    widthMode: 'mirror-fixed',
    ...overrides,
  };
}

function slot(
  slotNumber: number,
  overrides: Partial<SyncedSlotBinding> = {},
): SyncedSlot {
  return { slot: slotNumber, ...binding(overrides) };
}

function rawDocument(accounts: Array<{ userId: string; slots: unknown[] }>): string {
  return JSON.stringify({ schemaVersion: 1, accounts });
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RelaySlotConfigStore', () => {
  it('returns unconfigured without writing when the file is missing', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);

    expect(store.read('user-1')).toEqual({ configured: false });
    expect(existsSync(path)).toBe(false);
  });

  it('distinguishes an intentional empty account from a never-configured account', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);

    expect(store.replaceAll('user-1', [])).toEqual({ configured: true, slots: [] });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      accounts: [{ userId: 'user-1', slots: [] }],
    });

    const reloaded = new RelaySlotConfigStore(path);
    expect(reloaded.read('user-1')).toEqual({ configured: true, slots: [] });
    expect(reloaded.read('user-2')).toEqual({ configured: false });
  });

  it('isolates invalid load data without fallback or overwrite', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['invalid JSON', '{'],
      ['wrong schema', JSON.stringify({ schemaVersion: 2, accounts: [] })],
      ['unknown document key', JSON.stringify({ schemaVersion: 1, accounts: [], extra: true })],
      [
        'unknown account key',
        JSON.stringify({
          schemaVersion: 1,
          accounts: [{ userId: 'user-1', slots: [], extra: true }],
        }),
      ],
      ['empty account id', rawDocument([{ userId: '', slots: [] }])],
      [
        'duplicate account id',
        rawDocument([
          { userId: 'user-1', slots: [] },
          { userId: 'user-1', slots: [] },
        ]),
      ],
      [
        'unknown slot key',
        rawDocument([{ userId: 'user-1', slots: [{ ...slot(1), extra: true }] }]),
      ],
    ];

    for (const [label, raw] of cases) {
      const path = createStorePath();
      writeFileSync(path, raw);
      const store = new RelaySlotConfigStore(path);

      expect(() => store.read('user-1'), label).toThrow(SlotConfigUnavailableError);
      expect(() => store.replaceAll('user-1', []), label).toThrow(
        SlotConfigUnavailableError,
      );
      expect(readFileSync(path, 'utf8'), label).toBe(raw);
    }
  });

  it('marks non-ENOENT read failures unavailable without crashing the constructor', () => {
    const path = createStorePath();
    mkdirSync(path);

    const store = new RelaySlotConfigStore(path);

    expect(() => store.read('user-1')).toThrow(SlotConfigUnavailableError);
    expect(() => store.replaceAll('user-1', [])).toThrow(SlotConfigUnavailableError);
  });

  it('does not retry or reload an unavailable resource', () => {
    const path = createStorePath();
    writeFileSync(path, '{');
    const store = new RelaySlotConfigStore(path);

    expect(() => store.read('user-1')).toThrow(SlotConfigUnavailableError);

    writeFileSync(path, rawDocument([{ userId: 'user-1', slots: [] }]));
    expect(() => store.read('user-1')).toThrow(SlotConfigUnavailableError);

    const repaired = new RelaySlotConfigStore(path);
    expect(repaired.read('user-1')).toEqual({ configured: true, slots: [] });
  });

  it('rejects invalid single and full inputs without changing memory or disk', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);

    expect(store.replaceAll('user-1', [slot(1)])).toEqual({
      configured: true,
      slots: [slot(1)],
    });
    const priorDocument = readFileSync(path, 'utf8');

    expect(() => store.replaceAll('user-1', [slot(2), slot(2)])).toThrow(
      SlotConfigValidationError,
    );
    expect(() =>
      store.replaceAll('user-1', [
        slot(3),
        { ...slot(4), extra: true } as unknown as SyncedSlot,
      ]),
    ).toThrow(SlotConfigValidationError);
    expect(() => store.replaceSlot('user-1', 0, binding())).toThrow(
      SlotConfigValidationError,
    );
    expect(() =>
      store.replaceSlot('user-1', 2, {
        ...binding(),
        extra: true,
      } as unknown as SyncedSlotBinding),
    ).toThrow(SlotConfigValidationError);
    expect(() => store.read('')).toThrow(SlotConfigValidationError);

    expect(store.read('user-1')).toEqual({ configured: true, slots: [slot(1)] });
    expect(readFileSync(path, 'utf8')).toBe(priorDocument);
    expect(readdirSync(dirname(path))).toEqual(['cli-slot-config.json']);
  });

  it('keeps two accounts separate and full replace affects only one account', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);

    store.replaceAll('user-a', [slot(2), slot(1)]);
    store.replaceAll('user-b', [slot(3)]);

    expect(store.read('user-a')).toEqual({
      configured: true,
      slots: [slot(1), slot(2)],
    });
    expect(store.read('user-b')).toEqual({ configured: true, slots: [slot(3)] });

    store.replaceAll('user-a', [slot(4)]);

    expect(store.read('user-a')).toEqual({ configured: true, slots: [slot(4)] });
    expect(store.read('user-b')).toEqual({ configured: true, slots: [slot(3)] });
  });

  it('single replacement preserves other slots and accounts and creates an absent account', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);
    store.replaceAll('user-a', [slot(1), slot(2)]);
    store.replaceAll('user-b', [slot(1)]);

    const changed = binding({
      server: {
        deviceId: 'device-2',
        daemonHostId: 'daemon-1',
        displayName: 'Desk',
      },
    });
    store.replaceSlot('user-a', 2, changed);

    expect(store.read('user-a')).toEqual({
      configured: true,
      slots: [slot(1), { slot: 2, ...changed }],
    });
    expect(store.read('user-b')).toEqual({ configured: true, slots: [slot(1)] });

    store.replaceSlot('user-c', 5, binding({ alias: 'new' }));

    expect(store.read('user-c')).toEqual({
      configured: true,
      slots: [slot(5, { alias: 'new' })],
    });
  });

  it('returns isolated copies and does not retain caller-owned objects', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);
    const input = [slot(1)];

    store.replaceAll('user-1', input);
    const firstRead = store.read('user-1');
    expect(firstRead.configured).toBe(true);
    if (!firstRead.configured) {
      throw new Error('expected configured state');
    }
    firstRead.slots[0].server.deviceId = 'mutated-through-read';
    firstRead.slots.push(slot(2));
    input[0].server.deviceId = 'mutated-through-input';

    expect(store.read('user-1')).toEqual({ configured: true, slots: [slot(1)] });
  });

  it('persists accepted writes across a new store instance', () => {
    const path = createStorePath();
    const store = new RelaySlotConfigStore(path);

    store.replaceAll('user-1', [slot(2), slot(1)]);
    store.replaceSlot('user-2', 4, binding({ alias: 'remote' }));

    const reloaded = new RelaySlotConfigStore(path);
    expect(reloaded.read('user-1')).toEqual({
      configured: true,
      slots: [slot(1), slot(2)],
    });
    expect(reloaded.read('user-2')).toEqual({
      configured: true,
      slots: [slot(4, { alias: 'remote' })],
    });
  });

  it('keeps prior memory and disk after write or rename failure and does not resurrect failed candidates', () => {
    const path = createStorePath();
    let failWrite = false;
    let failRename = false;
    const store = new RelaySlotConfigStore(path, {
      writeFileSync: (descriptor, data) => {
        if (failWrite) {
          throw new Error('injected write failure');
        }
        writeFileSync(descriptor, data);
      },
      renameSync: (from, to) => {
        if (failRename) {
          throw new Error('injected rename failure');
        }
        renameFileSync(from, to);
      },
    });

    store.replaceAll('user-1', [slot(1)]);
    const priorDocument = readFileSync(path, 'utf8');

    failWrite = true;
    expect(() => store.replaceAll('user-1', [slot(2)])).toThrow(
      SlotConfigPersistenceError,
    );
    expect(store.read('user-1')).toEqual({ configured: true, slots: [slot(1)] });
    expect(readFileSync(path, 'utf8')).toBe(priorDocument);

    failWrite = false;
    failRename = true;
    expect(() => store.replaceAll('user-1', [slot(3)])).toThrow(
      SlotConfigPersistenceError,
    );
    expect(store.read('user-1')).toEqual({ configured: true, slots: [slot(1)] });
    expect(readFileSync(path, 'utf8')).toBe(priorDocument);

    failRename = false;
    expect(store.replaceAll('user-1', [slot(4)])).toEqual({
      configured: true,
      slots: [slot(4)],
    });
    expect(new RelaySlotConfigStore(path).read('user-1')).toEqual({
      configured: true,
      slots: [slot(4)],
    });
    expect(readdirSync(dirname(path))).toEqual(['cli-slot-config.json']);
  });
});
