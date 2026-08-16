import { describe, expect, it } from 'vitest';
import {
  createControlCommand,
  type ControlCommand,
  type ControlOutcome,
} from '@zterm/shared/terminal/control-contract';
import {
  ClientControlCenter,
  type ClientControlCommandOwner,
  type ClientControlExecutionRequest,
} from './client-control-center';

class RecordingOwner implements ClientControlCommandOwner<unknown, unknown> {
  readonly executions: unknown[] = [];

  constructor(
    private readonly handler: (
      params: unknown,
    ) => ControlOutcome<unknown, unknown> | Promise<ControlOutcome<unknown, unknown>>,
  ) {}

  readonly ownerId = 'recording-owner';

  async execute(
    command: Readonly<ControlCommand<unknown>>,
  ): Promise<ControlOutcome<unknown, unknown>> {
    this.executions.push(command.params);
    return this.handler(command.params);
  }
}

class NeverOwner implements ClientControlCommandOwner<unknown, unknown> {
  readonly ownerId = 'never-owner';

  execute(): Promise<ControlOutcome<unknown, unknown>> {
    return new Promise(() => {});
  }
}

function request(
  commandType: string,
  params: unknown,
  capabilities: readonly string[] = [],
  idempotencyKey?: string,
): ClientControlExecutionRequest<unknown> {
  return {
    command: createControlCommand(commandType, `command-${commandType}`, `correlation-${commandType}`, params),
    subject: 'app-shell',
    capabilities,
    idempotencyKey,
  };
}

describe('client control center', () => {
  it('routes one command to exactly one owner and records an audit entry', async () => {
    const center = new ClientControlCenter();
    const owner = new RecordingOwner((params) => ({
      ok: true,
      value: { applied: (params as { value: number }).value },
    }));
    center.register('test.command', owner);

    const result = await center.execute(
      request('test.command', { value: 42 }),
    );

    expect(result).toEqual({ ok: true, value: { applied: 42 } });
    expect(owner.executions).toHaveLength(1);
    expect(center.getAuditEntries()).toMatchObject([
      {
        commandType: 'test.command',
        subject: 'app-shell',
        result: 'ok',
      },
    ]);
  });

  it('fails explicitly for unknown commands and duplicate registrations', async () => {
    const center = new ClientControlCenter();

    const unknown = await center.execute(request('missing', {}));
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'unknown_command', commandType: 'missing' },
    });
    expect(center.getAuditEntries()[0]?.result).toBe('unknown');

    const owner = new RecordingOwner(() => ({ ok: true, value: undefined }));
    center.register('test.command', owner);
    expect(() => center.register('test.command', owner)).toThrow(
      /duplicate command owner/,
    );
  });

  it('denies capability-gated commands before the owner runs', async () => {
    const center = new ClientControlCenter();
    const owner = new RecordingOwner(() => ({ ok: true, value: undefined }));
    center.register('test.command', owner, 'test:capability');

    const result = await center.execute(request('test.command', {}, []));

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'capability_denied',
        commandType: 'test.command',
        requiredCapability: 'test:capability',
      },
    });
    expect(owner.executions).toHaveLength(0);
    expect(center.getAuditEntries()[0]?.result).toBe('denied');
  });

  it('returns the first outcome for an idempotency key and never re-runs the owner', async () => {
    const center = new ClientControlCenter();
    const owner = new RecordingOwner(() => ({ ok: true, value: { first: true } }));
    center.register('test.command', owner);
    const idempotencyKey = 'test.command:1';

    const first = await center.execute(
      request('test.command', { value: 1 }, [], idempotencyKey),
    );
    const second = await center.execute(
      request('test.command', { value: 2 }, [], idempotencyKey),
    );

    expect(first).toEqual({ ok: true, value: { first: true } });
    expect(second).toEqual(first);
    expect(owner.executions).toHaveLength(1);
    expect(center.getAuditEntries().filter((entry) => entry.result === 'duplicate')).toHaveLength(1);
  });

  it('returns an explicit deadline error without waiting forever', async () => {
    const center = new ClientControlCenter();
    center.register('test.slow', new NeverOwner());

    const result = await center.execute({
      ...request('test.slow', {}),
      deadlineMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'deadline_exceeded',
        commandType: 'test.slow',
        deadlineMs: 5,
      },
    });
    expect(center.getAuditEntries()[0]?.result).toBe('timeout');
  });

  it('rejects malformed control identity before routing', async () => {
    const center = new ClientControlCenter();
    const owner = new RecordingOwner(() => ({ ok: true, value: undefined }));
    center.register('test.command', owner);

    const result = await center.execute({
      command: createControlCommand('test.command', ' ', 'correlation', {}),
      subject: 'app-shell',
      capabilities: [],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_command',
        commandType: 'test.command',
        message: 'command id, correlation id, command type, and subject are required',
      },
    });
    expect(owner.executions).toHaveLength(0);
    expect(center.getAuditEntries()[0]?.result).toBe('error');
  });

  it('keeps the audit ledger bounded', async () => {
    const center = new ClientControlCenter({ maxAuditEntries: 2 });

    await center.execute(request('one', {}));
    await center.execute(request('two', {}));
    await center.execute(request('three', {}));

    expect(center.getAuditEntries()).toHaveLength(2);
    expect(center.getAuditEntries()[0]?.commandType).toBe('two');
    expect(center.getAuditEntries()[1]?.commandType).toBe('three');
  });
});
