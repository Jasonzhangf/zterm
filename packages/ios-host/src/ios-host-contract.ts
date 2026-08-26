import type {
  ControlCommand,
  ControlOutcome,
  DataStreamHandle,
  DataStreamRequest,
  Disposable,
  RuntimeEvent,
  RuntimeGateway,
  RuntimeSnapshot,
} from '@zterm/runtime-contracts';

export const IOS_COMMAND_CHANNEL = 'zterm:ios:command' as const;
export const IOS_EVENT_CHANNEL = 'zterm:ios:event' as const;
export const IOS_SNAPSHOT_CHANNEL = 'zterm:ios:snapshot' as const;

const KNOWN_COMMANDS = new Set(['session.open', 'session.close', 'session.list']);
const CONTROL_KEYS = new Set([
  'connected',
  'connectionType',
  'connectivity',
  'debug',
  'health',
  'metadata',
  'provider',
  'retry',
  'scope',
  'snapshot',
  'stopless',
  'servertool',
  'transport',
]);

export interface IosCommandWire {
  readonly commandType: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly params: unknown;
  readonly generation: number;
}

export interface IosCommandResultWire {
  readonly commandId: string;
  readonly generation: number;
  readonly outcome: ControlOutcome<unknown>;
}

export interface IosEventWire extends RuntimeEvent {
  readonly generation: number;
}

export interface IosSnapshotWire extends RuntimeSnapshot {
  readonly generation: number;
}

export interface IosHostTransport {
  execute(wire: IosCommandWire): Promise<IosCommandResultWire>;
  readSnapshot(): Promise<IosSnapshotWire>;
  openDataStream?(request: DataStreamRequest): Promise<DataStreamHandle>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertBusinessPayload(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBusinessPayload(item, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (CONTROL_KEYS.has(key)) throw new TypeError(`${field} contains control field: ${key}`);
    assertBusinessPayload(child, `${field}.${key}`);
  }
}

function parseJson(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${field} must be valid JSON`);
  }
  if (!isRecord(parsed)) throw new TypeError(`${field} must be an object`);
  return parsed;
}

function requireString(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field}.${key} must be non-empty`);
  return value;
}

function requireGeneration(record: Record<string, unknown>, field: string): number {
  const generation = record.generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new TypeError(`${field}.generation must be a positive integer`);
  }
  return generation as number;
}

function decodeCommandObject(record: Record<string, unknown>): IosCommandWire {
  const commandType = requireString(record, 'commandType', 'command');
  if (!KNOWN_COMMANDS.has(commandType)) throw new TypeError(`unknown command: ${commandType}`);
  const commandId = requireString(record, 'commandId', 'command');
  const correlationId = requireString(record, 'correlationId', 'command');
  if (!Object.prototype.hasOwnProperty.call(record, 'params')) throw new TypeError('command.params is required');
  assertBusinessPayload(record.params, 'command.params');
  return { commandType, commandId, correlationId, params: record.params, generation: requireGeneration(record, 'command') };
}

export function decodeIosCommand(value: string): IosCommandWire {
  return decodeCommandObject(parseJson(value, 'command'));
}

export function encodeIosCommand(command: IosCommandWire): string {
  return JSON.stringify(decodeCommandObject(command as unknown as Record<string, unknown>));
}

export function decodeIosEvent(value: string): IosEventWire {
  const record = parseJson(value, 'event');
  const eventType = requireString(record, 'eventType', 'event');
  if (!Object.prototype.hasOwnProperty.call(record, 'payload')) throw new TypeError('event.payload is required');
  assertBusinessPayload(record.payload, 'event.payload');
  const correlationId = record.correlationId;
  if (correlationId !== undefined && typeof correlationId !== 'string') {
    throw new TypeError('event.correlationId must be a string');
  }
  return { eventType, correlationId, payload: record.payload, generation: requireGeneration(record, 'event') };
}

export function decodeIosSnapshot(value: string): IosSnapshotWire {
  const record = parseJson(value, 'snapshot');
  const revision = record.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new TypeError('snapshot.revision must be non-negative');
  if (!Object.prototype.hasOwnProperty.call(record, 'data') || !isRecord(record.data)) throw new TypeError('snapshot.data must be an object');
  assertBusinessPayload(record.data, 'snapshot.data');
  return { revision: revision as number, generation: requireGeneration(record, 'snapshot'), data: record.data };
}

export type IosLifecycleSignal = 'foreground-resume' | 'background-entered';

export function isIosLifecycleSignal(value: unknown): value is IosLifecycleSignal {
  return value === 'foreground-resume' || value === 'background-entered';
}

export class IosHostGateway implements RuntimeGateway {
  #generation = 0;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(private readonly transport: IosHostTransport) {}

  async execute<C, R>(command: ControlCommand<C>): Promise<ControlOutcome<R>> {
    const generation = this.#generation + 1;
    const wire = decodeCommandObject({
      commandType: command.commandType,
      commandId: command.commandId,
      correlationId: command.correlationId,
      params: command.params,
      generation,
    });
    const result = await this.transport.execute(wire);
    if (result.generation < this.#generation) throw new Error(`stale generation ${result.generation} < current ${this.#generation}`);
    if (result.generation !== generation || result.commandId !== command.commandId) throw new Error('command result identity mismatch');
    this.#generation = result.generation;
    return result.outcome as ControlOutcome<R>;
  }

  subscribe(listener: (event: RuntimeEvent) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  async readSnapshot(): Promise<IosSnapshotWire> {
    const snapshot = decodeIosSnapshot(JSON.stringify(await this.transport.readSnapshot()));
    if (snapshot.generation < this.#generation) throw new Error(`stale snapshot generation ${snapshot.generation} < current ${this.#generation}`);
    this.#generation = snapshot.generation;
    return snapshot;
  }

  async openDataStream(request: DataStreamRequest): Promise<DataStreamHandle> {
    if (!this.transport.openDataStream) throw new Error(`iOS data stream transport is not configured: ${request.channelId}`);
    return this.transport.openDataStream(request);
  }

  async acceptEvent(value: string): Promise<unknown> {
    const event = decodeIosEvent(value);
    if (event.generation < this.#generation) throw new Error(`stale generation ${event.generation} < current ${this.#generation}`);
    this.#generation = event.generation;
    for (const listener of this.#listeners) listener(event);
    return event.payload;
  }

  currentGeneration(): number {
    return this.#generation;
  }
}
