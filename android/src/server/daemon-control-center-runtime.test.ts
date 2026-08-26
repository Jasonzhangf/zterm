import { describe, expect, it, vi } from 'vitest';
import {
  createControlCommand,
  type ControlCommand,
  type ControlOutcome,
} from '@zterm/shared/terminal/control-contract';
import {
  DaemonControlCenter,
  type DaemonControlExecutionRequest,
} from './daemon-control-center-runtime';

interface TestContext {
  readonly marker: string;
}

function command(
  commandType: string,
  params: unknown = {},
  commandId = 'command-1',
  correlationId = 'correlation-1',
): ControlCommand<unknown> {
  return createControlCommand(commandType, commandId, correlationId, params);
}

function request(
  centerCommand: ControlCommand<unknown>,
  overrides: Partial<DaemonControlExecutionRequest<unknown, TestContext>> = {},
): DaemonControlExecutionRequest<unknown, TestContext> {
  return {
    command: centerCommand,
    subject: 'subject-1',
    capabilities: ['test:capability'],
    context: { marker: 'context-1' },
    ...overrides,
  };
}

describe('DaemonControlCenter', () => {
  it('routes each command type to exactly one owner and audits success', async () => {
    const center = new DaemonControlCenter({ now: () => 1000 });
    const execute = vi.fn(async (
      receivedCommand: Readonly<ControlCommand<unknown>>,
      context: Readonly<TestContext>,
    ): Promise<ControlOutcome<string, never>> => {
      const resultValue = `${receivedCommand.commandType}:${context.marker}`;
      return { ok: true, value: resultValue };
    });

    center.register<unknown, string, never, TestContext>(
      'test:command',
      { ownerId: 'test-owner', execute },
      'test:capability',
    );

    const result = await center.execute<unknown, TestContext, string, never>(
      request(command('test:command', { input: true })),
    );

    expect(result).toEqual({ ok: true, value: 'test:command:context-1' });
    expect(execute).toHaveBeenCalledOnce();
    expect(center.getAuditEntries()).toEqual([
      expect.objectContaining({
        commandId: 'command-1',
        commandType: 'test:command',
        subject: 'subject-1',
        result: 'ok',
      }),
    ]);
  });

  it('rejects duplicate owners for the same command type', () => {
    const center = new DaemonControlCenter();
    const owner = {
      ownerId: 'test-owner',
      async execute() {
        return { ok: true as const, value: null };
      },
    };

    center.register('test:command', owner);
    expect(() => center.register('test:command', owner)).toThrow(
      'duplicate daemon command owner: test:command',
    );
  });

  it('returns unknown_command before owner execution and audits unknown', async () => {
    const center = new DaemonControlCenter({ now: () => 2000 });
    const execute = vi.fn();

    const result = await center.execute(request(command('missing:command')));

    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown_command', commandType: 'missing:command' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(center.getAuditEntries()[0]?.result).toBe('unknown');
  });

  it('denies capability before owner execution and audits denied', async () => {
    const center = new DaemonControlCenter({ now: () => 3000 });
    const execute = vi.fn(async () => ({ ok: true as const, value: null }));
    center.register('test:command', { ownerId: 'test-owner', execute }, 'required:capability');

    const result = await center.execute(
      request(command('test:command'), { capabilities: ['other:capability'] }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'capability_denied',
        commandType: 'test:command',
        requiredCapability: 'required:capability',
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(center.getAuditEntries()[0]?.result).toBe('denied');
  });

  it('reuses an idempotent outcome without running the owner again', async () => {
    const center = new DaemonControlCenter({ now: () => 4000 });
    const execute = vi.fn(async () => ({ ok: true as const, value: { ran: true } }));
    center.register('test:command', { ownerId: 'test-owner', execute });

    const first = await center.execute(
      request(command('test:command'), { idempotencyKey: 'idempotency-1' }),
    );
    const second = await center.execute(
      request(command('test:command'), { idempotencyKey: 'idempotency-1' }),
    );

    expect(first).toEqual({ ok: true, value: { ran: true } });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
    expect(center.getAuditEntries().map((entry) => entry.result)).toEqual(['ok', 'duplicate']);
  });

  it('returns deadline_exceeded when the owner exceeds the requested deadline', async () => {
    vi.useFakeTimers();
    const now = vi.fn(() => 5000);
    const center = new DaemonControlCenter({ now });
    const execute = vi.fn(() => new Promise<never>(() => {}));
    center.register('test:command', { ownerId: 'test-owner', execute });

    const pending = center.execute(
      request(command('test:command'), { deadlineMs: 100 }),
    );
    vi.advanceTimersByTime(100);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'deadline_exceeded',
        commandType: 'test:command',
        deadlineMs: 100,
        chain: [{
          code: 'deadline_exceeded',
          message: 'control deadline exceeded: test:command',
          source: 'daemon.control_center',
        }],
      },
    });
    expect(center.getAuditEntries()[0]?.result).toBe('timeout');
    vi.useRealTimers();
  });

  it('projects owner throws into the daemon error chain', async () => {
    const center = new DaemonControlCenter();
    center.register('test:throw', {
      ownerId: 'throw-owner',
      async execute() {
        throw new Error('daemon owner exploded');
      },
    });

    await expect(center.execute(request(command('test:throw')))).resolves.toEqual({
      ok: false,
      error: {
        code: 'handler_failed',
        commandType: 'test:throw',
        message: 'daemon owner exploded',
        chain: [{
          code: 'handler_failed',
          message: 'daemon owner exploded',
          source: 'daemon.control_center',
        }],
      },
    });
  });

  it('coalesces concurrent idempotent commands before owner execution', async () => {
    const center = new DaemonControlCenter();
    let resolveOwner!: (outcome: ControlOutcome<unknown, unknown>) => void;
    const execute = vi.fn(() => new Promise<ControlOutcome<unknown, unknown>>((resolve) => {
      resolveOwner = resolve;
    }));
    center.register('test:concurrent', { ownerId: 'owner', execute });
    const first = center.execute(request(command('test:concurrent'), { idempotencyKey: 'same-key' }));
    const second = center.execute(request(command('test:concurrent'), { idempotencyKey: 'same-key' }));
    expect(execute).toHaveBeenCalledOnce();
    resolveOwner({ ok: true, value: 'committed' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value: 'committed' },
      { ok: true, value: 'committed' },
    ]);
  });

  it('rejects invalid deadlines without invoking owner', async () => {
    const center = new DaemonControlCenter();
    const execute = vi.fn(async () => ({ ok: true as const, value: null }));
    center.register('test:deadline', { ownerId: 'owner', execute });
    const result = await center.execute(
      request(command('test:deadline'), { deadlineMs: -1 }),
    );
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    if (!result.ok) {
      expect((result.error as { chain?: readonly { code: string }[] }).chain?.[0]?.code)
        .toBe('invalid_deadline');
    }
  });

  it('rejects malformed command identity before owner execution', async () => {
    const center = new DaemonControlCenter({ now: () => 6000 });
    const execute = vi.fn();
    center.register('test:command', { ownerId: 'test-owner', execute });

    const result = await center.execute(
      request(command('test:command', {}, '', '')),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_command',
        commandType: 'test:command',
        message: 'command id, correlation id, command type, and subject are required',
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(center.getAuditEntries()[0]?.result).toBe('error');
  });

  it('keeps audit bounded to the configured maximum', async () => {
    const center = new DaemonControlCenter({
      now: () => 7000,
      maxAuditEntries: 2,
    });
    center.register('test:command', {
      ownerId: 'test-owner',
      async execute() {
        return { ok: true as const, value: null };
      },
    });

    for (let index = 0; index < 4; index += 1) {
      await center.execute(
        request(command('test:command', {}, `command-${index}`, `correlation-${index}`)),
      );
    }

    expect(center.getAuditEntries()).toHaveLength(2);
    expect(center.getAuditEntries()[0]?.commandId).toBe('command-2');
    expect(center.getAuditEntries()[1]?.commandId).toBe('command-3');
  });
});
