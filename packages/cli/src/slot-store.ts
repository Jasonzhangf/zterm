import { isDeepStrictEqual } from 'node:util';
import {
  ConfigStoreError,
  type JsonObject,
  type SharedConfigStore,
} from '../../shared/src/node/shared-config';

export interface CliSlotBinding {
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
    backend: string;
    stableId: string;
    name: string;
  };
  widthMode: 'adaptive-phone' | 'mirror-fixed';
}

export interface SlotListEntry {
  slot: number;
  binding: CliSlotBinding;
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
    const entries: SlotListEntry[] = [];
    for (let slot = 1; slot <= 20; slot += 1) {
      const binding = slots[String(slot)];
      if (binding !== undefined) {
        entries.push({ slot, binding: binding as CliSlotBinding });
      }
    }
    return entries;
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
}
