import {
  errorControlOutcome,
  createControlErrorChain,
  type ControlAuditEntry,
  type ControlCapabilityId,
  type ControlCenterError,
  type ControlCommand,
  type ControlOutcome,
} from '@zterm/shared/terminal/control-contract';

export interface DaemonControlCommandOwner<
  C = unknown,
  R = unknown,
  E = unknown,
  CTX = unknown,
> {
  readonly ownerId: string;
  execute(
    command: Readonly<ControlCommand<C>>,
    context: Readonly<CTX>,
  ): Promise<ControlOutcome<R, E>>;
}

export interface DaemonControlExecutionRequest<C, CTX> {
  readonly command: Readonly<ControlCommand<C>>;
  readonly subject: string;
  readonly capabilities: readonly ControlCapabilityId[];
  readonly context: Readonly<CTX>;
  readonly deadlineMs?: number;
  readonly idempotencyKey?: string;
}

export interface DaemonControlCenterOptions {
  readonly now?: () => number;
  readonly defaultDeadlineMs?: number;
  readonly maxAuditEntries?: number;
}

class DaemonControlDeadlineError extends Error {
  constructor(
    readonly commandType: string,
    readonly deadlineMs: number,
  ) {
    super(`daemon control deadline exceeded: ${commandType}`);
  }
}

export class DaemonControlCenter {
  private readonly owners = new Map<string, DaemonControlCommandOwner>();
  private readonly requiredCapabilities = new Map<string, ControlCapabilityId>();
  private readonly audit: ControlAuditEntry[] = [];
  private readonly idempotentOutcomes = new Map<
    string,
    Promise<ControlOutcome<unknown, unknown>>
  >();
  private readonly now: () => number;
  private readonly defaultDeadlineMs: number;
  private readonly maxAuditEntries: number;

  constructor(options: DaemonControlCenterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
    this.maxAuditEntries = Math.max(1, Math.floor(options.maxAuditEntries ?? 1_000));
  }

  register<C, R, E, CTX>(
    commandType: string,
    owner: DaemonControlCommandOwner<C, R, E, CTX>,
    requiredCapability?: ControlCapabilityId,
  ): void {
    if (this.owners.has(commandType)) {
      throw new Error(`duplicate daemon command owner: ${commandType}`);
    }
    this.owners.set(commandType, owner);
    this.requiredCapabilities.set(commandType, requiredCapability ?? '');
  }

  has(commandType: string): boolean {
    return this.owners.has(commandType);
  }

  getCommandTypes(): readonly string[] {
    return [...this.owners.keys()];
  }

  async execute<C, CTX, R, E>(
    request: DaemonControlExecutionRequest<C, CTX>,
  ): Promise<ControlOutcome<R, E | ControlCenterError>> {
    const startedAtMs = this.now();
    const {
      command,
      subject,
      capabilities,
      context,
      deadlineMs,
      idempotencyKey,
    } = request;
    const commandType = command.commandType;

    if (
      !isNonEmpty(command.commandId) ||
      !isNonEmpty(command.correlationId) ||
      !isNonEmpty(command.commandType) ||
      !isNonEmpty(subject)
    ) {
      this.recordAudit(command, subject, 'error', startedAtMs);
      return errorControlOutcome({
        code: 'invalid_command',
        commandType,
        message: 'command id, correlation id, command type, and subject are required',
      });
    }

    const owner = this.owners.get(commandType);
    if (!owner) {
      this.recordAudit(command, subject, 'unknown', startedAtMs);
      return errorControlOutcome({
        code: 'unknown_command',
        commandType,
      });
    }

    const requiredCapability = this.requiredCapabilities.get(commandType) ?? '';
    if (requiredCapability && !capabilities.includes(requiredCapability)) {
      this.recordAudit(command, subject, 'denied', startedAtMs);
      return errorControlOutcome({
        code: 'capability_denied',
        commandType,
        requiredCapability,
      });
    }

    if (idempotencyKey && this.idempotentOutcomes.has(idempotencyKey)) {
      this.recordAudit(command, subject, 'duplicate', startedAtMs);
      return (await this.idempotentOutcomes.get(
        idempotencyKey,
      )) as ControlOutcome<R, E | ControlCenterError>;
    }

    const timeoutMs = deadlineMs ?? this.defaultDeadlineMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      this.recordAudit(command, subject, 'error', startedAtMs);
      return errorControlOutcome({
        code: 'invalid_deadline',
        commandType,
        message: 'deadlineMs must be a non-negative safe integer',
        chain: createControlErrorChain(
          'invalid_deadline',
          'deadlineMs must be a non-negative safe integer',
          'daemon.control_center',
        ),
      });
    }
    const execution = this.executeOwner(
      owner,
      command,
      context,
      commandType,
      timeoutMs,
      startedAtMs,
      subject,
      idempotencyKey,
    );
    if (idempotencyKey) {
      this.idempotentOutcomes.set(idempotencyKey, execution);
    }
    return execution as unknown as Promise<ControlOutcome<R, E | ControlCenterError>>;
  }

  private async executeOwner(
    owner: DaemonControlCommandOwner,
    command: Readonly<ControlCommand<unknown>>,
    context: Readonly<unknown>,
    commandType: string,
    timeoutMs: number,
    startedAtMs: number,
    subject: string,
    idempotencyKey?: string,
  ): Promise<ControlOutcome<unknown, unknown>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        owner.execute(command, context),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new DaemonControlDeadlineError(commandType, timeoutMs));
          }, timeoutMs);
        }),
      ]);
      this.recordAudit(
        command,
        subject,
        result.ok ? 'ok' : 'error',
        startedAtMs,
      );
      return result as unknown as ControlOutcome<unknown, unknown>;
    } catch (error) {
      if (error instanceof DaemonControlDeadlineError) {
        if (idempotencyKey) this.idempotentOutcomes.delete(idempotencyKey);
        this.recordAudit(command, subject, 'timeout', startedAtMs);
        return errorControlOutcome({
          code: 'deadline_exceeded',
          commandType,
          deadlineMs: timeoutMs,
          chain: createControlErrorChain(
            'deadline_exceeded',
            `control deadline exceeded: ${commandType}`,
            'daemon.control_center',
          ),
        });
      }
      this.recordAudit(command, subject, 'error', startedAtMs);
      const message = error instanceof Error ? error.message : String(error);
      return errorControlOutcome({
        code: 'handler_failed',
        commandType,
        message,
        chain: createControlErrorChain(
          'handler_failed',
          message,
          'daemon.control_center',
        ),
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  getAuditEntries(): readonly ControlAuditEntry[] {
    return this.audit;
  }

  private recordAudit(
    command: Readonly<ControlCommand<unknown>>,
    subject: string,
    result: ControlAuditEntry['result'],
    startedAtMs: number,
  ): void {
    this.audit.push({
      commandId: command.commandId,
      correlationId: command.correlationId,
      commandType: command.commandType,
      subject,
      result,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, this.now() - startedAtMs),
    });
    if (this.audit.length > this.maxAuditEntries) {
      this.audit.shift();
    }
  }
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
