import {
  createControlCommand,
  type ControlCommand,
  type ControlOutcome,
  type RuntimeError,
} from '@zterm/runtime-contracts';
import { KernelContractError, requireNonEmpty } from './errors.ts';

export interface ControlExecutionRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly commandType: string;
  readonly params?: unknown;
  readonly subject: string;
  readonly capabilities: readonly string[];
  readonly idempotencyKey?: string;
  readonly deadlineMs?: number;
}

export interface ControlAuditEntry {
  readonly commandId: string;
  readonly correlationId: string;
  readonly commandType: string;
  readonly subject: string;
  readonly result: 'ok' | 'error' | 'denied' | 'unknown' | 'duplicate' | 'timeout';
  readonly startedAt: number;
  readonly durationMs: number;
}

type ControlHandler = (command: ControlCommand<unknown>) => unknown | Promise<unknown>;

interface ControlRegistration {
  readonly requiredCapability?: string;
  readonly handler: ControlHandler;
}

export interface ControlCenterOptions {
  readonly now?: () => number;
  readonly defaultDeadlineMs?: number;
  readonly maxAuditEntries?: number;
}

export class ControlCenter {
  private readonly registrations = new Map<string, ControlRegistration>();
  private readonly idempotentOutcomes = new Map<string, ControlOutcome<unknown>>();
  private readonly audit: ControlAuditEntry[] = [];
  private readonly now: () => number;
  private readonly defaultDeadlineMs: number;
  private readonly maxAuditEntries: number;

  constructor(options: ControlCenterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
    this.maxAuditEntries = Math.max(1, Math.floor(options.maxAuditEntries ?? 1_000));
  }

  register(
    commandType: string,
    requiredCapability: string | undefined,
    handler: ControlHandler,
  ): void {
    const type = requireNonEmpty(commandType, 'commandType');
    if (this.registrations.has(type)) {
      throw new KernelContractError('duplicate_command', `duplicate command owner: ${type}`);
    }
    this.registrations.set(type, {
      requiredCapability: requiredCapability === undefined
        ? undefined
        : requireNonEmpty(requiredCapability, 'requiredCapability'),
      handler,
    });
  }

  async execute<R = unknown>(request: ControlExecutionRequest): Promise<ControlOutcome<R>> {
    const startedAt = this.now();
    const commandType = request.commandType;
    const command = createControlCommand(
      commandType,
      request.commandId,
      request.correlationId,
      request.params,
    );
    if (!isValidRequest(request)) {
      this.record(command, request.subject, 'error', startedAt);
      return { ok: false, error: { code: 'invalid_command', message: 'command fields and subject are required', retryable: false } };
    }

    const registration = this.registrations.get(commandType);
    if (!registration) {
      this.record(command, request.subject, 'unknown', startedAt);
      return { ok: false, error: runtimeError('unknown_command', `unknown command: ${commandType}`) };
    }
    if (!isAuthorized(request.capabilities, registration.requiredCapability)) {
      this.record(command, request.subject, 'denied', startedAt);
      return { ok: false, error: runtimeError('capability_denied', `capability denied: ${commandType}`) };
    }
    if (request.idempotencyKey && this.idempotentOutcomes.has(request.idempotencyKey)) {
      this.record(command, request.subject, 'duplicate', startedAt);
      return this.idempotentOutcomes.get(request.idempotencyKey) as ControlOutcome<R>;
    }

    const deadlineMs = request.deadlineMs ?? this.defaultDeadlineMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
      this.record(command, request.subject, 'error', startedAt);
      return { ok: false, error: runtimeError('invalid_deadline', 'deadlineMs must be a non-negative safe integer') };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        registration.handler(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new KernelContractError(
            'deadline_exceeded',
            `control deadline exceeded: ${commandType}`,
          )), deadlineMs);
        }),
      ]) as ControlOutcome<R> | R;
      const outcome: ControlOutcome<R> = isOutcome(result)
        ? result as ControlOutcome<R>
        : { ok: true, value: result as R };
      if (request.idempotencyKey) this.idempotentOutcomes.set(request.idempotencyKey, outcome as ControlOutcome<unknown>);
      this.record(command, request.subject, outcome.ok ? 'ok' : 'error', startedAt);
      return outcome;
    } catch (error) {
      if (error instanceof KernelContractError && error.code === 'deadline_exceeded') {
        this.record(command, request.subject, 'timeout', startedAt);
        return { ok: false, error: runtimeError('deadline_exceeded', error.message, { deadlineMs }) };
      }
      this.record(command, request.subject, 'error', startedAt);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  readAudit(): readonly ControlAuditEntry[] {
    return this.audit.slice();
  }

  private record(
    command: ControlCommand<unknown>,
    subject: string,
    result: ControlAuditEntry['result'],
    startedAt: number,
  ): void {
    this.audit.push({
      commandId: command.commandId,
      correlationId: command.correlationId,
      commandType: command.commandType,
      subject,
      result,
      startedAt,
      durationMs: Math.max(0, this.now() - startedAt),
    });
    if (this.audit.length > this.maxAuditEntries) this.audit.shift();
  }
}

function runtimeError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): RuntimeError {
  return { code, message, retryable: false, ...extra } as RuntimeError;
}

function isAuthorized(capabilities: readonly string[], requiredCapability: string | undefined): boolean {
  return requiredCapability === undefined || capabilities.includes(requiredCapability);
}

function isValidRequest(request: ControlExecutionRequest): boolean {
  return [request.commandId, request.correlationId, request.commandType, request.subject]
    .every((value) => typeof value === 'string' && value.trim().length > 0);
}

function isOutcome(value: unknown): value is ControlOutcome<unknown> {
  return typeof value === 'object'
    && value !== null
    && ('ok' in value)
    && typeof (value as { ok: unknown }).ok === 'boolean';
}
