import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import {
  CLI_SLOT_CONFIG_SCHEMA_VERSION,
  SlotConfigValidationError,
  parseSyncedSlot,
  parseSyncedSlotBinding,
  parseSyncedSlots,
  type CloudSlotState,
  type SyncedSlot,
  type SyncedSlotBinding,
} from '@zterm/shared/connection/cli-slot-config';

export class SlotConfigUnavailableError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SlotConfigUnavailableError';
  }
}

export class SlotConfigPersistenceError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SlotConfigPersistenceError';
  }
}

interface SlotConfigFileSystem {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  openSync(path: string, flags: 'wx', mode: number): number;
  writeFileSync(descriptor: number, data: string): void;
  fsyncSync(descriptor: number): void;
  closeSync(descriptor: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

interface SlotConfigFileSystemOverrides {
  readFileSync?: SlotConfigFileSystem['readFileSync'];
  existsSync?: SlotConfigFileSystem['existsSync'];
  mkdirSync?: SlotConfigFileSystem['mkdirSync'];
  openSync?: SlotConfigFileSystem['openSync'];
  writeFileSync?: SlotConfigFileSystem['writeFileSync'];
  fsyncSync?: SlotConfigFileSystem['fsyncSync'];
  closeSync?: SlotConfigFileSystem['closeSync'];
  renameSync?: SlotConfigFileSystem['renameSync'];
  unlinkSync?: SlotConfigFileSystem['unlinkSync'];
}

const nodeSlotConfigFileSystem: SlotConfigFileSystem = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  existsSync: (path) => existsSync(path),
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  writeFileSync: (descriptor, data) => writeFileSync(descriptor, data),
  fsyncSync: (descriptor) => fsyncSync(descriptor),
  closeSync: (descriptor) => closeSync(descriptor),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
};

interface SlotConfigAccount {
  userId: string;
  slots: SyncedSlot[];
}

interface SlotConfigDocument {
  schemaVersion: typeof CLI_SLOT_CONFIG_SCHEMA_VERSION;
  accounts: SlotConfigAccount[];
}

const DOCUMENT_KEYS = ['schemaVersion', 'accounts'] as const;
const ACCOUNT_KEYS = ['userId', 'slots'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SlotConfigValidationError(field, 'must be an object');
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new SlotConfigValidationError(`${field}.${key}`, 'unknown field');
    }
  }
}

function validateUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new SlotConfigValidationError('userId', 'must be a non-empty string');
  }
  return userId;
}

function parseDocument(input: unknown): SlotConfigDocument {
  const document = requireRecord(input, 'document');
  assertKnownKeys(document, DOCUMENT_KEYS, 'document');
  if (document.schemaVersion !== CLI_SLOT_CONFIG_SCHEMA_VERSION) {
    throw new SlotConfigValidationError(
      'document.schemaVersion',
      `must be ${CLI_SLOT_CONFIG_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(document.accounts)) {
    throw new SlotConfigValidationError('document.accounts', 'must be an array');
  }

  const accounts: SlotConfigAccount[] = [];
  const seenUserIds = new Set<string>();
  const entries = document.accounts as unknown[];
  entries.forEach((entry, index) => {
    const field = `document.accounts[${index}]`;
    const account = requireRecord(entry, field);
    assertKnownKeys(account, ACCOUNT_KEYS, field);
    const userId = validateUserId(account.userId);
    if (seenUserIds.has(userId)) {
      throw new SlotConfigValidationError(`${field}.userId`, 'must be unique');
    }
    seenUserIds.add(userId);
    accounts.push({
      userId,
      slots: parseSyncedSlots(account.slots),
    });
  });

  return { schemaVersion: CLI_SLOT_CONFIG_SCHEMA_VERSION, accounts };
}

function cloneSlot(slot: SyncedSlot): SyncedSlot {
  const copy: SyncedSlot = {
    slot: slot.slot,
    server: {
      deviceId: slot.server.deviceId,
      daemonHostId: slot.server.daemonHostId,
      displayName: slot.server.displayName,
    },
    session: {
      backend: slot.session.backend,
      stableId: slot.session.stableId,
      name: slot.session.name,
    },
    widthMode: slot.widthMode,
  };
  if (slot.alias !== undefined) {
    copy.alias = slot.alias;
  }
  return copy;
}

function configuredState(slots: readonly SyncedSlot[]): CloudSlotState {
  return { configured: true, slots: slots.map(cloneSlot) };
}

function upsertAccount(
  accounts: readonly SlotConfigAccount[],
  userId: string,
  slots: SyncedSlot[],
): SlotConfigAccount[] {
  const index = accounts.findIndex((account) => account.userId === userId);
  if (index === -1) {
    return [...accounts, { userId, slots }];
  }
  const next = accounts.slice();
  next[index] = { userId, slots };
  return next;
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return (error as { code?: unknown }).code;
}

export class RelaySlotConfigStore {
  private readonly fileSystem: SlotConfigFileSystem;
  private document: SlotConfigDocument | null;
  private unavailableError: SlotConfigUnavailableError | null;

  public constructor(
    private readonly path: string,
    fileSystemOverrides: SlotConfigFileSystemOverrides = {},
  ) {
    this.fileSystem = { ...nodeSlotConfigFileSystem, ...fileSystemOverrides };
    const loaded = this.load();
    this.document = loaded.document;
    this.unavailableError = loaded.unavailable;
  }

  public read(userId: string): CloudSlotState {
    const document = this.requireDocument();
    const validUserId = validateUserId(userId);
    const account = document.accounts.find(
      (entry) => entry.userId === validUserId,
    );
    if (account === undefined) {
      return { configured: false };
    }
    return configuredState(account.slots);
  }

  public replaceAll(
    userId: string,
    slots: readonly SyncedSlot[],
  ): CloudSlotState {
    const document = this.requireDocument();
    const validUserId = validateUserId(userId);
    const validatedSlots = parseSyncedSlots(slots);
    const candidate: SlotConfigDocument = {
      schemaVersion: CLI_SLOT_CONFIG_SCHEMA_VERSION,
      accounts: upsertAccount(document.accounts, validUserId, validatedSlots),
    };
    this.commit(candidate);
    return configuredState(validatedSlots);
  }

  public replaceSlot(
    userId: string,
    slot: number,
    binding: SyncedSlotBinding,
  ): CloudSlotState {
    const document = this.requireDocument();
    const validUserId = validateUserId(userId);
    const validatedBinding = parseSyncedSlotBinding(binding);
    const validatedSlot = parseSyncedSlot({ ...validatedBinding, slot });
    const account = document.accounts.find(
      (entry) => entry.userId === validUserId,
    );
    const slots = (account?.slots ?? []).filter(
      (entry) => entry.slot !== validatedSlot.slot,
    );
    slots.push(validatedSlot);
    slots.sort((left, right) => left.slot - right.slot);
    const candidate: SlotConfigDocument = {
      schemaVersion: CLI_SLOT_CONFIG_SCHEMA_VERSION,
      accounts: upsertAccount(document.accounts, validUserId, slots),
    };
    this.commit(candidate);
    return configuredState(slots);
  }

  private load(): {
    document: SlotConfigDocument | null;
    unavailable: SlotConfigUnavailableError | null;
  } {
    let raw: string;
    try {
      raw = this.fileSystem.readFileSync(this.path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return {
          document: {
            schemaVersion: CLI_SLOT_CONFIG_SCHEMA_VERSION,
            accounts: [],
          },
          unavailable: null,
        };
      }
      return {
        document: null,
        unavailable: new SlotConfigUnavailableError(
          'slot config file could not be read',
          error,
        ),
      };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      return { document: parseDocument(parsed), unavailable: null };
    } catch (error) {
      return {
        document: null,
        unavailable: new SlotConfigUnavailableError(
          'slot config file is invalid',
          error,
        ),
      };
    }
  }

  private requireDocument(): SlotConfigDocument {
    if (this.unavailableError !== null) {
      throw this.unavailableError;
    }
    if (this.document === null) {
      throw new SlotConfigUnavailableError('slot config is unavailable');
    }
    return this.document;
  }

  private commit(candidate: SlotConfigDocument): void {
    let temporaryPath: string | undefined;
    let descriptor: number | undefined;
    try {
      const parentDirectory = dirname(this.path);
      if (!this.fileSystem.existsSync(parentDirectory)) {
        this.fileSystem.mkdirSync(parentDirectory, { recursive: true });
      }
      temporaryPath = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
      descriptor = this.fileSystem.openSync(temporaryPath, 'wx', 0o600);
      this.fileSystem.writeFileSync(
        descriptor,
        JSON.stringify(candidate, null, 2),
      );
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = undefined;
      this.fileSystem.renameSync(temporaryPath, this.path);
      temporaryPath = undefined;
      this.document = candidate;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          this.fileSystem.closeSync(descriptor);
        } catch {
          // Keep the original persistence failure.
        }
      }
      if (temporaryPath !== undefined) {
        try {
          this.fileSystem.unlinkSync(temporaryPath);
        } catch {
          // Keep the original persistence failure.
        }
      }
      throw new SlotConfigPersistenceError(
        'failed to persist slot config',
        error,
      );
    }
  }
}
