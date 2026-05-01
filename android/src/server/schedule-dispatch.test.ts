import { describe, expect, it, vi } from 'vitest';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import { dispatchScheduledJob } from './schedule-dispatch';

function makeJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: overrides.id || 'job-1',
    targetSessionName: overrides.targetSessionName || 'main',
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
  it('writes to the live mirror first and does not hit tmux again when the live session is already attached', () => {
    const writeToLiveMirror = vi.fn(() => true);
    const writeToTmuxSession = vi.fn();

    const result = dispatchScheduledJob(
      { writeToLiveMirror, writeToTmuxSession },
      makeJob({ payload: { text: 'uptime', appendEnter: true } }),
    );

    expect(result).toEqual({ ok: true });
    expect(writeToLiveMirror).toHaveBeenCalledWith('main', 'uptime\r', false);
    expect(writeToTmuxSession).not.toHaveBeenCalled();
  });

  it('falls through to tmux when the live mirror is absent and preserves appendEnter semantics', () => {
    const writeToLiveMirror = vi.fn(() => false);
    const writeToTmuxSession = vi.fn();

    const result = dispatchScheduledJob(
      { writeToLiveMirror, writeToTmuxSession },
      makeJob({ payload: { text: 'echo ok', appendEnter: false } }),
    );

    expect(result).toEqual({ ok: true });
    expect(writeToTmuxSession).toHaveBeenCalledWith('main', 'echo ok', false);
  });

  it('explicitly disables invalid jobs that do not have a target session', () => {
    const result = dispatchScheduledJob(
      {
        writeToLiveMirror: vi.fn(() => false),
        writeToTmuxSession: vi.fn(),
      },
      makeJob({ targetSessionName: '   ' }),
    );

    expect(result).toEqual({ ok: false, message: 'missing target session', disable: true });
  });

  it('surfaces tmux errors and only disables jobs for terminal-not-found classes of failure', () => {
    const missingSessionResult = dispatchScheduledJob(
      {
        writeToLiveMirror: vi.fn(() => false),
        writeToTmuxSession: vi.fn(() => {
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

    const transientResult = dispatchScheduledJob(
      {
        writeToLiveMirror: vi.fn(() => false),
        writeToTmuxSession: vi.fn(() => {
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
