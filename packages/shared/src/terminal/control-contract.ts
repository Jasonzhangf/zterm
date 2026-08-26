export const controlPlaneBrand: unique symbol = Symbol('zterm.control-plane');

export type ControlPlaneBrand = typeof controlPlaneBrand;

export interface ControlCommand<T> {
  readonly [controlPlaneBrand]: true;
  readonly commandId: string;
  readonly correlationId: string;
  readonly commandType: string;
  readonly params: T;
}

export function createControlCommand<T>(
  commandType: string,
  commandId: string,
  correlationId: string,
  params: T,
): ControlCommand<T> {
  return {
    [controlPlaneBrand]: true,
    commandId,
    correlationId,
    commandType,
    params,
  };
}

export interface ControlResult<R> {
  readonly commandId: string;
  readonly correlationId: string;
  readonly value: R;
}

export function createControlResult<R>(
  commandId: string,
  correlationId: string,
  value: R,
): ControlResult<R> {
  return { commandId, correlationId, value };
}

export type ControlCapabilityId = string;

export type ControlAuditResult =
  | 'ok'
  | 'error'
  | 'denied'
  | 'timeout'
  | 'duplicate'
  | 'unknown';

export interface ControlErrorFrame {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
}

export type ControlErrorChain = readonly ControlErrorFrame[];

export interface ControlAuditEntry {
  readonly commandId: string;
  readonly correlationId: string;
  readonly commandType: string;
  readonly subject: string;
  readonly result: ControlAuditResult;
  readonly startedAt: string;
  readonly durationMs: number;
}

export type ControlCenterError = (
  {
      readonly code: 'unknown_command';
      readonly commandType: string;
    }
  | {
      readonly code: 'capability_denied';
      readonly commandType: string;
      readonly requiredCapability: ControlCapabilityId;
    }
  | {
      readonly code: 'deadline_exceeded';
      readonly commandType: string;
      readonly deadlineMs: number;
    }
  | {
      readonly code: 'invalid_command';
      readonly commandType: string;
      readonly message: string;
    }
  | {
      readonly code: 'invalid_deadline';
      readonly commandType: string;
      readonly message: string;
    }
  | {
      readonly code: 'handler_failed';
      readonly commandType: string;
      readonly message: string;
    }
) & {
  readonly chain?: ControlErrorChain;
};

export function createControlErrorChain(
  code: string,
  message: string,
  source?: string,
): ControlErrorChain {
  return [{ code, message, ...(source ? { source } : {}) }];
}

export function appendControlErrorChain(
  chain: ControlErrorChain,
  code: string,
  message: string,
  source?: string,
): ControlErrorChain {
  return [
    ...chain,
    { code, message, ...(source ? { source } : {}) },
  ];
}

export type ControlOutcome<R, E> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: E };

export function okControlOutcome<R>(value: R): ControlOutcome<R, never> {
  return { ok: true, value };
}

export function errorControlOutcome<E>(error: E): ControlOutcome<never, E> {
  return { ok: false, error };
}
