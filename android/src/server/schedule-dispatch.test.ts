import { describe, expect, it, vi } from 'vitest';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import { dispatchScheduledJob } from './schedule-dispatch';

function makeJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: overrides.id || 'job-1',
    targetSessionName: overrides.targetSessionName || 'main',
    terminalBackend: overrides.terminalBackend,
    label: overrides.label || 'daily status',
    enabled: overrides.enabled ?? true,
    payload: overrides.payload || { text: 'status', appendEnter: true },
    rule: overrides.rule || {
      kind: 'alarm',
      timezone: 'Asia/Shanghai',
      date: '2026-04-26',
      time: '09:30',
      repeat: 'once',
    },
    execution: overrides.execution || { maxRuns: 3, firedCount: 0 },
    createdAt: overrides.createdAt || '2026-04-26T01:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-26T01:00:00.000Z',
  };
}

describe('schedule-dispatch', () => {
  it('routes attached and unattached schedules through the same backend queue', async () => {
    const enqueueBackendInput = vi.fn(async () => true);

    const result = await dispatchScheduledJob(
      { enqueueBackendInput },
      makeJob({ payload: { text: 'uptime', appendEnter: true } }),
    );

    expect(result).toEqual({ ok: true });
    expect(enqueueBackendInput).toHaveBeenCalledWith('main', 'uptime', true, 'tmux');
  });

  it('preserves appendEnter semantics for unattached schedule payloads', async () => {
    const enqueueBackendInput = vi.fn(async () => true);

    const result = await dispatchScheduledJob(
      { enqueueBackendInput },
      makeJob({ payload: { text: 'echo ok', appendEnter: false } }),
    );

    expect(result).toEqual({ ok: true });
    expect(enqueueBackendInput).toHaveBeenCalledWith('main', 'echo ok', false, 'tmux');
  });

  it('explicitly disables invalid jobs that do not have a target session', async () => {
    const result = await dispatchScheduledJob(
      {
        enqueueBackendInput: vi.fn(async () => true),
      },
      makeJob({ targetSessionName: '   ' }),
    );

    expect(result).toEqual({ ok: false, message: 'missing target session', disable: true });
  });

  it('rejects Herdr targets before the queue so a same-name tmux session cannot receive the command', async () => {
    const enqueueBackendInput = vi.fn(async () => true);

    const result = await dispatchScheduledJob(
      { enqueueBackendInput, isHerdrSession: () => true },
      makeJob({ targetSessionName: 'hd-codex', terminalBackend: 'herdr' }),
    );

    expect(result).toEqual({
      ok: false,
      message: 'Herdr single-session backend does not support schedule commands',
      disable: true,
    });
    expect(enqueueBackendInput).not.toHaveBeenCalled();
  });

  it('keeps a same-named tmux job on the tmux backend queue', async () => {
    const enqueueBackendInput = vi.fn(async () => true);
    const isHerdrSession = vi.fn(() => true);

    const result = await dispatchScheduledJob(
      { enqueueBackendInput, isHerdrSession },
      makeJob({ targetSessionName: 'same-name', terminalBackend: 'tmux' }),
    );

    expect(result).toEqual({ ok: true });
    expect(isHerdrSession).not.toHaveBeenCalled();
    expect(enqueueBackendInput).toHaveBeenCalledWith('same-name', 'status', true, 'tmux');
  });

  it('keeps ordinary tmux jobs independent from Herdr catalog availability', async () => {
    const enqueueBackendInput = vi.fn(async () => true);
    const isHerdrSession = vi.fn(() => false);

    const result = await dispatchScheduledJob(
      { enqueueBackendInput, isHerdrSession },
      makeJob({ targetSessionName: 'tmux-main' }),
    );

    expect(result).toEqual({ ok: true });
    expect(isHerdrSession).not.toHaveBeenCalled();
    expect(enqueueBackendInput).toHaveBeenCalledWith('tmux-main', 'status', true, 'tmux');
  });

  it('surfaces queue errors and only disables jobs for terminal-not-found classes of failure', async () => {
    const missingSessionResult = await dispatchScheduledJob(
      {
        enqueueBackendInput: vi.fn(async () => {
          throw new Error("can't find session: main");
        }),
      },
      makeJob(),
    );

    expect(missingSessionResult).toEqual({
      ok: false,
      message: "can't find session: main",
      disable: true,
    });

    const transientResult = await dispatchScheduledJob(
      {
        enqueueBackendInput: vi.fn(async () => {
          throw new Error('temporary write failure');
        }),
      },
      makeJob(),
    );

    expect(transientResult).toEqual({
      ok: false,
      message: 'temporary write failure',
      disable: false,
    });
  });
});
