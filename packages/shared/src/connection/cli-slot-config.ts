export const CLI_SLOT_CONFIG_SCHEMA_VERSION = 1;

export interface SyncedSlotBinding {
  alias?: string;
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

export interface SyncedSlot extends SyncedSlotBinding {
  slot: number;
}

export type CloudSlotState =
  | { configured: false }
  | { configured: true; slots: SyncedSlot[] };

export interface CloudSlotResponse {
  userId: string;
  config: CloudSlotState;
}

export class SlotConfigValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'SlotConfigValidationError';
    this.field = field;
  }
}

const BINDING_KEYS = ['alias', 'server', 'session', 'widthMode'] as const;
const SLOT_KEYS = ['slot', 'alias', 'server', 'session', 'widthMode'] as const;
const SERVER_KEYS = ['deviceId', 'daemonHostId', 'displayName'] as const;
const SESSION_KEYS = ['backend', 'stableId', 'name'] as const;
const UNCONFIGURED_KEYS = ['configured'] as const;
const CONFIGURED_KEYS = ['configured', 'slots'] as const;

const UNSAFE_CHARACTER_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u206F]/u;

const utf8Encoder = new TextEncoder();

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SlotConfigValidationError(field, 'must be an object');
  }
  return value as Record<string, unknown>;
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SlotConfigValidationError(field, 'must be a string');
  }
  return value;
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}

function parseIdentityString(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text.length === 0) {
    throw new SlotConfigValidationError(field, 'must not be empty');
  }
  if (utf8Encoder.encode(text).byteLength > 1024) {
    throw new SlotConfigValidationError(
      field,
      'must be at most 1024 UTF-8 bytes',
    );
  }
  return text;
}

function parseDisplayString(value: unknown, field: string): string {
  const text = requireString(value, field);
  const length = codePointCount(text);
  if (length === 0) {
    throw new SlotConfigValidationError(field, 'must not be empty');
  }
  if (length > 256) {
    throw new SlotConfigValidationError(
      field,
      'must be at most 256 Unicode code points',
    );
  }
  if (UNSAFE_CHARACTER_PATTERN.test(text)) {
    throw new SlotConfigValidationError(
      field,
      'must not contain terminal control characters',
    );
  }
  return text;
}

function parseSlotNumber(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 20
  ) {
    throw new SlotConfigValidationError(
      field,
      'must be an integer from 1 to 20',
    );
  }
  return value;
}

function normalizeSlotAliasAt(input: unknown, field: string): string {
  const value = requireString(input, field);
  const normalized = value.trim();
  const length = codePointCount(normalized);
  if (length < 1 || length > 80) {
    throw new SlotConfigValidationError(
      field,
      'must contain 1 to 80 Unicode code points',
    );
  }
  if (UNSAFE_CHARACTER_PATTERN.test(normalized)) {
    throw new SlotConfigValidationError(
      field,
      'must not contain control or bidi characters',
    );
  }
  return normalized;
}

export function normalizeSlotAlias(input: unknown): string {
  return normalizeSlotAliasAt(input, 'alias');
}

function parseBackend(
  value: unknown,
  field: string,
): SyncedSlotBinding['session']['backend'] {
  if (value !== 'tmux' && value !== 'herdr') {
    throw new SlotConfigValidationError(
      field,
      "must be 'tmux' or 'herdr'",
    );
  }
  return value;
}

function parseWidthMode(
  value: unknown,
  field: string,
): SyncedSlotBinding['widthMode'] {
  if (value !== 'adaptive-phone' && value !== 'mirror-fixed') {
    throw new SlotConfigValidationError(
      field,
      "must be 'adaptive-phone' or 'mirror-fixed'",
    );
  }
  return value;
}

function parseServer(
  value: unknown,
  field: string,
): SyncedSlotBinding['server'] {
  const record = requireRecord(value, field);
  assertKnownKeys(record, SERVER_KEYS, field);
  return {
    deviceId: parseIdentityString(record.deviceId, `${field}.deviceId`),
    daemonHostId: parseIdentityString(
      record.daemonHostId,
      `${field}.daemonHostId`,
    ),
    displayName: parseDisplayString(record.displayName, `${field}.displayName`),
  };
}

function parseSession(
  value: unknown,
  field: string,
): SyncedSlotBinding['session'] {
  const record = requireRecord(value, field);
  assertKnownKeys(record, SESSION_KEYS, field);
  return {
    backend: parseBackend(record.backend, `${field}.backend`),
    stableId: parseIdentityString(record.stableId, `${field}.stableId`),
    name: parseDisplayString(record.name, `${field}.name`),
  };
}

function parseSyncedSlotBindingAt(
  input: unknown,
  field: string,
): SyncedSlotBinding {
  const record = requireRecord(input, field);
  assertKnownKeys(record, BINDING_KEYS, field);
  const server = parseServer(record.server, `${field}.server`);
  const session = parseSession(record.session, `${field}.session`);
  const widthMode = parseWidthMode(record.widthMode, `${field}.widthMode`);
  if (hasOwn(record, 'alias')) {
    return {
      alias: normalizeSlotAliasAt(record.alias, `${field}.alias`),
      server,
      session,
      widthMode,
    };
  }
  return { server, session, widthMode };
}

export function parseSyncedSlotBinding(input: unknown): SyncedSlotBinding {
  return parseSyncedSlotBindingAt(input, 'binding');
}

function parseSyncedSlotAt(input: unknown, field: string): SyncedSlot {
  const record = requireRecord(input, field);
  assertKnownKeys(record, SLOT_KEYS, field);
  const slot = parseSlotNumber(record.slot, field);
  const bindingInput: Record<string, unknown> = {
    server: record.server,
    session: record.session,
    widthMode: record.widthMode,
  };
  if (hasOwn(record, 'alias')) {
    bindingInput.alias = record.alias;
  }
  return { slot, ...parseSyncedSlotBindingAt(bindingInput, field) };
}

export function parseSyncedSlot(input: unknown): SyncedSlot {
  return parseSyncedSlotAt(input, 'slot');
}

function parseSyncedSlotsAt(input: unknown, field: string): SyncedSlot[] {
  if (!Array.isArray(input)) {
    throw new SlotConfigValidationError(field, 'must be an array');
  }
  if (input.length > 20) {
    throw new SlotConfigValidationError(
      field,
      'must contain at most 20 records',
    );
  }
  const entries = input as unknown[];
  const slots = Array.from(entries, (entry, index) =>
    parseSyncedSlotAt(entry, `${field}[${index}]`),
  );
  const seen = new Set<number>();
  for (const [index, slot] of slots.entries()) {
    if (seen.has(slot.slot)) {
      throw new SlotConfigValidationError(
        `${field}[${index}]`,
        'duplicate slot number',
      );
    }
    seen.add(slot.slot);
  }
  slots.sort((left, right) => left.slot - right.slot);
  return slots;
}

export function parseSyncedSlots(input: unknown): SyncedSlot[] {
  return parseSyncedSlotsAt(input, 'slots');
}

export function parseCloudSlotState(input: unknown): CloudSlotState {
  const record = requireRecord(input, 'config');
  const configured = record.configured;
  if (typeof configured !== 'boolean') {
    throw new SlotConfigValidationError(
      'config.configured',
      'must be a boolean',
    );
  }
  if (!configured) {
    assertKnownKeys(record, UNCONFIGURED_KEYS, 'config');
    return { configured: false };
  }
  assertKnownKeys(record, CONFIGURED_KEYS, 'config');
  if (!hasOwn(record, 'slots')) {
    throw new SlotConfigValidationError(
      'config.slots',
      'is required when configured is true',
    );
  }
  return {
    configured: true,
    slots: parseSyncedSlotsAt(record.slots, 'config.slots'),
  };
}

function pickKnownFields(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const record = requireRecord(value, field);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = record[key];
  }
  return result;
}

export function projectSyncedSlot(
  slot: number,
  localBinding: unknown,
): SyncedSlot {
  const binding = requireRecord(localBinding, 'binding');
  const projected: Record<string, unknown> = {
    slot,
    server: pickKnownFields(binding.server, SERVER_KEYS, 'binding.server'),
    session: pickKnownFields(binding.session, SESSION_KEYS, 'binding.session'),
    widthMode: binding.widthMode,
  };
  if (hasOwn(binding, 'alias')) {
    projected.alias = binding.alias;
  }
  return parseSyncedSlot(projected);
}
