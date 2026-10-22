import { isDeepStrictEqual } from 'node:util';
import {
  normalizeSlotAlias,
  parseSyncedSlots,
  type SyncedSlot,
} from '../../shared/src/connection/cli-slot-config';
import {
  ConfigStoreError,
  type JsonObject,
  type SharedConfigStore,
} from '../../shared/src/node/shared-config';
import {
  projectCliAuthBaseline,
  type CliAuthBaseline,
} from './commands/auth';

export interface CliSlotBinding {
  alias?: string;
  account: {
    relayBaseUrl: string;
    userId: string;
  };
  server: {
    deviceId: string;
    daemonHostId: string;
    displayName: string;
  };
  session: {
    backend: 'tmux' | 'herdr';
    stableId: string;
    name: string;
  };
  widthMode: 'adaptive-phone' | 'mirror-fixed';
}

export interface SlotListEntry {
  slot: number;
  binding: CliSlotBinding;
}

export type SlotSyncScope =
  | { kind: 'one'; slot: number }
  | { kind: 'all' };

export interface SlotSyncBaseline {
  scope: SlotSyncScope;
  account: CliAuthBaseline;
  entries: SlotListEntry[];
}

export type SaveSlotResult =
  | { kind: 'saved'; slot: number; binding: CliSlotBinding }
  | { kind: 'slot_changed'; current: CliSlotBinding | undefined };

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSlot(slot: number, path: string) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 20) {
    throw new ConfigStoreError(
      'invalid_config',
      `slot must be an integer from 1 through 20: ${slot}`,
      path,
    );
  }
}

function assertSyncScope(scope: SlotSyncScope, path: string) {
  if (!isJsonObject(scope)) {
    throw new ConfigStoreError('invalid_config', 'sync scope is invalid', path);
  }
  if (scope.kind === 'one') {
    assertSlot(scope.slot, path);
    return;
  }
  if (scope.kind === 'all') return;
  throw new ConfigStoreError('invalid_config', 'sync scope is invalid', path);
}

function readSlots(config: JsonObject, path: string): JsonObject {
  if (config.zterm === undefined) {
    return {};
  }
  if (!isJsonObject(config.zterm)) {
    throw new ConfigStoreError('invalid_config', 'zterm must be a JSON object', path);
  }
  if (config.zterm.cli === undefined) {
    return {};
  }
  if (!isJsonObject(config.zterm.cli)) {
    throw new ConfigStoreError('invalid_config', 'zterm.cli must be a JSON object', path);
  }
  const slots = config.zterm.cli.slots;
  if (slots === undefined) {
    return {};
  }
  if (!isJsonObject(slots)) {
    throw new ConfigStoreError(
      'invalid_config',
      'zterm.cli.slots must be a JSON object',
      path,
    );
  }
  return slots;
}

function writeSlots(config: JsonObject, path: string) {
  if (config.zterm !== undefined && !isJsonObject(config.zterm)) {
    throw new ConfigStoreError('invalid_config', 'zterm must be a JSON object', path);
  }
  const zterm: JsonObject = isJsonObject(config.zterm) ? config.zterm : {};
  config.zterm = zterm;
  if (zterm.cli !== undefined && !isJsonObject(zterm.cli)) {
    throw new ConfigStoreError('invalid_config', 'zterm.cli must be a JSON object', path);
  }
  const cli: JsonObject = isJsonObject(zterm.cli) ? zterm.cli : {};
  zterm.cli = cli;
  const slots = cli.slots;
  if (slots === undefined) {
    cli.slots = {};
  } else if (!isJsonObject(slots)) {
    throw new ConfigStoreError(
      'invalid_config',
      'zterm.cli.slots must be a JSON object',
      path,
    );
  }
  return cli.slots as JsonObject;
}

function slotEntries(slots: JsonObject): SlotListEntry[] {
  const entries: SlotListEntry[] = [];
  for (let slot = 1; slot <= 20; slot += 1) {
    const binding = slots[String(slot)];
    if (binding !== undefined) {
      entries.push({ slot, binding: binding as CliSlotBinding });
    }
  }
  return entries;
}

function entryForSlot(
  entries: readonly SlotListEntry[],
  slot: number,
): SlotListEntry | undefined {
  return entries.find((entry) => entry.slot === slot);
}

function belongsToAccount(
  binding: unknown,
  auth: CliAuthBaseline['auth'],
): boolean {
  if (!isJsonObject(binding)) return false;
  const account = binding.account;
  return isJsonObject(account)
    && account.relayBaseUrl === auth.relayBaseUrl
    && account.userId === auth.userId;
}

function currentAccountSlots(
  entries: readonly SlotListEntry[],
  auth: CliAuthBaseline['auth'],
): Record<string, CliSlotBinding> {
  const result: Record<string, CliSlotBinding> = {};
  for (const entry of entries) {
    if (belongsToAccount(entry.binding, auth)) {
      result[String(entry.slot)] = entry.binding;
    }
  }
  return result;
}

function localBinding(
  synced: SyncedSlot,
  auth: CliAuthBaseline['auth'],
): CliSlotBinding {
  return {
    ...(synced.alias === undefined ? {} : { alias: synced.alias }),
    account: {
      relayBaseUrl: auth.relayBaseUrl,
      userId: auth.userId,
    },
    server: {
      deviceId: synced.server.deviceId,
      daemonHostId: synced.server.daemonHostId,
      displayName: synced.server.displayName,
    },
    session: {
      backend: synced.session.backend,
      stableId: synced.session.stableId,
      name: synced.session.name,
    },
    widthMode: synced.widthMode,
  };
}

export class SlotStore {
  private readonly store: SharedConfigStore;

  constructor(store: SharedConfigStore) {
    this.store = store;
  }

  async read(slot: number, signal?: AbortSignal): Promise<CliSlotBinding | undefined> {
    signal?.throwIfAborted();
    assertSlot(slot, this.store.path);
    const snapshot = await this.store.read();
    const slots = readSlots(snapshot.config, snapshot.path);
    const value = slots[String(slot)];
    return value === undefined ? undefined : value as CliSlotBinding;
  }

  async list(signal?: AbortSignal): Promise<SlotListEntry[]> {
    signal?.throwIfAborted();
    const snapshot = await this.store.read();
    const slots = readSlots(snapshot.config, snapshot.path);
    return slotEntries(slots);
  }

  async readSyncBaseline(
    scope: SlotSyncScope,
    signal?: AbortSignal,
  ): Promise<SlotSyncBaseline | undefined> {
    signal?.throwIfAborted();
    assertSyncScope(scope, this.store.path);
    const snapshot = await this.store.read();
    const account = projectCliAuthBaseline(snapshot.config);
    if (!account) return undefined;
    const entries = slotEntries(readSlots(snapshot.config, snapshot.path));
    return {
      scope: scope.kind === 'one'
        ? { kind: 'one', slot: scope.slot }
        : { kind: 'all' },
      account,
      entries,
    };
  }

  async checkSyncBaseline(
    baseline: SlotSyncBaseline,
    signal?: AbortSignal,
  ): Promise<
    { kind: 'unchanged' }
    | { kind: 'auth_changed' }
    | { kind: 'slot_changed' }
  > {
    signal?.throwIfAborted();
    assertSyncScope(baseline.scope, this.store.path);
    const snapshot = await this.store.read();
    const latestAccount = projectCliAuthBaseline(snapshot.config);
    if (!isDeepStrictEqual(latestAccount, baseline.account)) {
      return { kind: 'auth_changed' };
    }

    const latestEntries = slotEntries(readSlots(snapshot.config, snapshot.path));
    if (baseline.scope.kind === 'one') {
      const original = entryForSlot(baseline.entries, baseline.scope.slot);
      const latest = entryForSlot(latestEntries, baseline.scope.slot);
      return isDeepStrictEqual(original?.binding, latest?.binding)
        ? { kind: 'unchanged' }
        : { kind: 'slot_changed' };
    }

    const original = currentAccountSlots(baseline.entries, baseline.account.auth);
    const latest = currentAccountSlots(latestEntries, baseline.account.auth);
    return isDeepStrictEqual(original, latest)
      ? { kind: 'unchanged' }
      : { kind: 'slot_changed' };
  }

  async applyPulledSlots(options: {
    baseline: SlotSyncBaseline;
    slots: readonly SyncedSlot[];
    signal?: AbortSignal;
  }): Promise<
    | { kind: 'saved'; slots: SlotListEntry[] }
    | { kind: 'auth_changed' }
    | { kind: 'slot_changed' }
    | { kind: 'foreign_slot_conflict'; slots: number[] }
    | { kind: 'cloud_slot_missing' }
  > {
    options.signal?.throwIfAborted();
    assertSyncScope(options.baseline.scope, this.store.path);
    const incoming = parseSyncedSlots(options.slots);
    let selected: SyncedSlot | undefined;
    if (options.baseline.scope.kind === 'one') {
      const slot = options.baseline.scope.slot;
      selected = incoming.find((entry) => entry.slot === slot);
      if (!selected) {
        return { kind: 'cloud_slot_missing' };
      }
    }

    return this.store.update<
      | { kind: 'saved'; slots: SlotListEntry[] }
      | { kind: 'auth_changed' }
      | { kind: 'slot_changed' }
      | { kind: 'foreign_slot_conflict'; slots: number[] }
    >((latest) => {
      const latestAccount = projectCliAuthBaseline(latest);
      if (!isDeepStrictEqual(latestAccount, options.baseline.account)) {
        return { value: { kind: 'auth_changed' }, changed: false };
      }

      const slots = readSlots(latest, this.store.path);
      const latestEntries = slotEntries(slots);
      if (options.baseline.scope.kind === 'one') {
        const original = entryForSlot(
          options.baseline.entries,
          options.baseline.scope.slot,
        );
        const current = entryForSlot(latestEntries, options.baseline.scope.slot);
        if (!isDeepStrictEqual(original?.binding, current?.binding)) {
          return { value: { kind: 'slot_changed' }, changed: false };
        }
      } else {
        const original = currentAccountSlots(
          options.baseline.entries,
          options.baseline.account.auth,
        );
        const current = currentAccountSlots(
          latestEntries,
          options.baseline.account.auth,
        );
        if (!isDeepStrictEqual(original, current)) {
          return { value: { kind: 'slot_changed' }, changed: false };
        }
      }

      // A single-slot pull applies and checks only the selected entry. The full
      // cloud map was still validated above.
      const conflictCandidates = options.baseline.scope.kind === 'one'
        ? [selected!]
        : incoming;
      const conflicts = conflictCandidates
        .filter((slot) => {
          const occupant = slots[String(slot.slot)];
          return occupant !== undefined
            && !belongsToAccount(occupant, options.baseline.account.auth);
        })
        .map((slot) => slot.slot)
        .sort((left, right) => left - right);
      if (conflicts.length > 0) {
        return {
          value: { kind: 'foreign_slot_conflict', slots: conflicts },
          changed: false,
        };
      }

      const nextSlots: JsonObject = {};
      if (options.baseline.scope.kind === 'one') {
        Object.assign(nextSlots, slots);
        nextSlots[String(selected!.slot)] = localBinding(
          selected!,
          options.baseline.account.auth,
        );
      } else {
        for (const [key, value] of Object.entries(slots)) {
          if (!belongsToAccount(value, options.baseline.account.auth)) {
            nextSlots[key] = value;
          }
        }
        for (const slot of incoming) {
          nextSlots[String(slot.slot)] = localBinding(
            slot,
            options.baseline.account.auth,
          );
        }
      }

      if (isDeepStrictEqual(slots, nextSlots)) {
        return {
          value: { kind: 'saved', slots: slotEntries(slots) },
          changed: false,
        };
      }

      const writable = writeSlots(latest, this.store.path);
      for (const key of Object.keys(writable)) delete writable[key];
      Object.assign(writable, nextSlots);
      return {
        value: { kind: 'saved', slots: slotEntries(writable) },
        changed: true,
      };
    }, options.signal);
  }

  async saveIfUnchanged(options: {
    slot: number;
    expected: CliSlotBinding | undefined;
    binding: CliSlotBinding;
    signal?: AbortSignal;
  }): Promise<SaveSlotResult> {
    assertSlot(options.slot, this.store.path);
    return this.store.update<SaveSlotResult>((latest) => {
      const slots = writeSlots(latest, this.store.path);
      const current = slots[String(options.slot)] as CliSlotBinding | undefined;
      if (!isDeepStrictEqual(current, options.expected)) {
        return {
          value: { kind: 'slot_changed', current },
          changed: false,
        };
      }
      slots[String(options.slot)] = options.binding;
      return {
        value: { kind: 'saved', slot: options.slot, binding: options.binding },
        changed: true,
      };
    }, options.signal);
  }

  async renameIfUnchanged(options: {
    slot: number;
    expectedOriginal: CliSlotBinding | undefined;
    alias: string;
    signal?: AbortSignal;
  }): Promise<SaveSlotResult | { kind: 'slot_missing' }> {
    options.signal?.throwIfAborted();
    assertSlot(options.slot, this.store.path);
    const alias = normalizeSlotAlias(options.alias);
    return this.store.update<SaveSlotResult | { kind: 'slot_missing' }>((latest) => {
      const slots = writeSlots(latest, this.store.path);
      const current = slots[String(options.slot)] as CliSlotBinding | undefined;
      if (current === undefined) {
        return {
          value: isDeepStrictEqual(current, options.expectedOriginal)
            ? { kind: 'slot_missing' }
            : { kind: 'slot_changed', current },
          changed: false,
        };
      }
      if (!isDeepStrictEqual(current, options.expectedOriginal)) {
        return {
          value: { kind: 'slot_changed', current },
          changed: false,
        };
      }
      const binding = { ...current, alias };
      if (isDeepStrictEqual(current, binding)) {
        return {
          value: { kind: 'saved', slot: options.slot, binding },
          changed: false,
        };
      }
      slots[String(options.slot)] = binding;
      return {
        value: { kind: 'saved', slot: options.slot, binding },
        changed: true,
      };
    }, options.signal);
  }
}
