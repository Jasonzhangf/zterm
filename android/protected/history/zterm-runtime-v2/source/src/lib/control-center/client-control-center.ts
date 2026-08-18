import {
  errorControlOutcome,
  type ControlAuditEntry,
  type ControlCapabilityId,
  type ControlCenterError,
  type ControlCommand,
  type ControlOutcome,
} from '@zterm/shared/terminal/control-contract';

export interface ClientControlCommandOwner<R = unknown, E = unknown> {
  readonly ownerId: string;
  execute(
    command: Readonly<ControlCommand<unknown>>,
  ): Promise<ControlOutcome<R, E>>;
}

export interface ClientControlExecutionRequest<C> {
  readonly command: Readonly<ControlCommand<C>>;
  readonly subject: string;
  readonly capabilities: readonly ControlCapabilityId[];
  readonly deadlineMs?: number;
  readonly idempotencyKey?: string;
}

export interface ClientControlCenterOptions {
  readonly now?: () => number;
  readonly defaultDeadlineMs?: number;
  readonly maxAuditEntries?: number;
}

class ControlDeadlineError extends Error {
  constructor(
    readonly commandType: string,
    readonly deadlineMs: number,
  ) {
    super(`control deadline exceeded: ${commandType}`);
  }
}

export class ClientControlCenter {
  private readonly owners = new Map<string, ClientControlCommandOwner>();
  private readonly requiredCapabilities = new Map<string, ControlCapabilityId>();
  private readonly audit: ControlAuditEntry[] = [];
  private readonly idempotentOutcomes = new Map<
    string,
    ControlOutcome<unknown, unknown>
  >();
  private readonly now: () => number;
  private readonly defaultDeadlineMs: number;
  private readonly maxAuditEntries: number;

  constructor(options: ClientControlCenterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
    this.maxAuditEntries = Math.max(1, Math.floor(options.maxAuditEntries ?? 1_000));
  }

  register<R, E>(
    commandType: string,
    owner: ClientControlCommandOwner<R, E>,
    requiredCapability?: ControlCapabilityId,
  ): void {
    if (this.owners.has(commandType)) {
      throw new Error(`duplicate command owner: ${commandType}`);
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

  async execute<C, R, E>(
    request: ClientControlExecutionRequest<C>,
  ): Promise<ControlOutcome<R, E | ControlCenterError>> {
    const startedAtMs = this.now();
    const { command, subject, capabilities, deadlineMs, idempotencyKey } = request;
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
      return this.idempotentOutcomes.get(
        idempotencyKey,
      ) as unknown as ControlOutcome<R, E | ControlCenterError>;
    }

    const timeoutMs = deadlineMs ?? this.defaultDeadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        owner.execute(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ControlDeadlineError(commandType, timeoutMs));
          }, timeoutMs);
        }),
      ]);
      if (idempotencyKey) {
        this.idempotentOutcomes.set(idempotencyKey, result);
      }
      this.recordAudit(
        command,
        subject,
        result.ok ? 'ok' : 'error',
        startedAtMs,
      );
      return result as unknown as ControlOutcome<R, E | ControlCenterError>;
    } catch (error) {
      if (error instanceof ControlDeadlineError) {
        this.recordAudit(command, subject, 'timeout', startedAtMs);
        return errorControlOutcome({
          code: 'deadline_exceeded',
          commandType,
          deadlineMs: timeoutMs,
        });
      }
      this.recordAudit(command, subject, 'error', startedAtMs);
      throw error;
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
