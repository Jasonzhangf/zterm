export const controlPlaneBrand: unique symbol = Symbol('zterm.runtime.control-plane');
export type ControlPlaneBrand = typeof controlPlaneBrand;

export interface ControlCommand<T> {
  readonly [controlPlaneBrand]: true;
  readonly commandId: string;
  readonly correlationId: string;
  readonly commandType: string;
  readonly params: T;
}

export function createControlCommand<T>(
  commandType: string, commandId: string, correlationId: string, params: T,
): ControlCommand<T> {
  return { [controlPlaneBrand]: true, commandId, correlationId, commandType, params };
}

export type ControlOutcome<R> =
  | { ok: true; value: R }
  | { ok: false; error: RuntimeError };

export interface RuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function okOutcome<R>(value: R): ControlOutcome<R> { return { ok: true, value }; }
export function errorOutcome(code: string, message: string, retryable = false): ControlOutcome<never> {
  return { ok: false, error: { code, message, retryable } };
}

const dataPlaneBrand: unique symbol = Symbol('zterm.runtime.data-plane');

export interface DataEnvelope<T> {
  readonly [dataPlaneBrand]: true;
  readonly channelId: string;
  readonly revision: number;
  readonly body: T;
}

export function createDataEnvelope<T>(channelId: string, revision: number, body: T): DataEnvelope<T> {
  return { [dataPlaneBrand]: true, channelId, revision, body };
}

export interface RuntimeEvent {
  readonly eventType: string;
  readonly correlationId?: string;
  readonly payload: unknown;
}

export interface RuntimeSnapshot {
  readonly revision: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface DataStreamRequest {
  readonly channelId: string;
  readonly mode: 'reliable' | 'lossy';
}

export interface Disposable {
  dispose(reason: string): void;
}

export interface RuntimeGateway {
  execute<C, R>(command: ControlCommand<C>): Promise<ControlOutcome<R>>;
  subscribe(listener: (event: RuntimeEvent) => void): Disposable;
  readSnapshot(): Promise<RuntimeSnapshot>;
  openDataStream(request: DataStreamRequest): Promise<DataStreamHandle>;
}

export interface DataStreamHandle extends Disposable {
  readonly channelId: string;
  send(chunk: Uint8Array): void;
}
