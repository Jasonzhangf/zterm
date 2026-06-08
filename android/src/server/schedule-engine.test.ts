import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ScheduleJob, ScheduleJobDraft } from '../../../packages/shared/src/schedule/types.ts';
import { ScheduleEngine } from './schedule-engine';

// ── helpers ──────────────────────────────────────────────

function makeJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: overrides.id || 'job-1',
    targetSessionName: overrides.targetSessionName || 'main',
    label: overrides.label || 'test',
    enabled: overrides.enabled ?? true,
    payload: overrides.payload || { text: 'echo hi', appendEnter: true },
    rule: overrides.rule || {
      kind: 'interval',
      intervalMs: 60_000,
      startAt: '2026-04-26T00:00:00.000Z',
      fireImmediately: false,
    },
    execution: overrides.execution || { maxRuns: 3, firedCount: 0 },
    nextFireAt: overrides.nextFireAt,
    lastFiredAt: overrides.lastFiredAt,
    lastResult: overrides.lastResult,
    lastError: overrides.lastError,
    createdAt: overrides.createdAt || '2026-04-26T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-26T00:00:00.000Z',
  };
}

function makeDraft(overrides: Partial<ScheduleJobDraft> = {}): ScheduleJobDraft {
  return {
    id: overrides.id,
    targetSessionName: overrides.targetSessionName || 'main',
    label: overrides.label || 'test',
    enabled: overrides.enabled,
    payload: overrides.payload || { text: 'echo hi', appendEnter: true },
    rule: overrides.rule || {
      kind: 'interval',
      intervalMs: 60_000,
      startAt: '2026-04-26T00:00:00.000Z',
      fireImmediately: false,
    },
    execution: overrides.execution,
  };
}

function lastItem<T>(items: T[]) {
  return items[items.length - 1];
}

// ═══════════════════════════════════════════════════════════
//  ScheduleEngine
// ═══════════════════════════════════════════════════════════

describe('ScheduleEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads initial jobs and computes nextFireAt', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });

    const jobs = engine.listBySession('main');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('job-1');
    expect(jobs[0].nextFireAt).toBe('2026-04-26T00:01:00.000Z');

    engine.dispose();
  });

  it('normalizes legacy jobs that do not carry execution policy yet', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = new ScheduleEngine({
      initialJobs: [{
        ...makeJob({ id: 'legacy-job' }),
        execution: undefined,
      } as unknown as ScheduleJob],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });

    const jobs = engine.listBySession('main');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].execution).toEqual({ maxRuns: 3, firedCount: 0 });
    expect(jobs[0].nextFireAt).toBe('2026-04-26T00:01:00.000Z');

    engine.dispose();
  });

  it('upsert creates a new job with a uuid when no id is provided', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const savedJobs: ScheduleJob[][] = [];
    const engine = new ScheduleEngine({
      saveJobs: (jobs) => savedJobs.push(jobs),
      executeJob: () => ({ ok: true }),
    });

    const result = engine.upsert(makeDraft());
    expect(result.id).toBeTruthy();
    expect(result.nextFireAt).toBe('2026-04-26T00:01:00.000Z');

    const jobs = engine.listBySession('main');
    expect(jobs).toHaveLength(1);
    expect(savedJobs.length).toBeGreaterThan(0);

    engine.dispose();
  });

  it('upsert updates existing job preserving id', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1', label: 'old' })],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });

    const updated = engine.upsert(makeDraft({ id: 'job-1', label: 'new' }));
    expect(updated.id).toBe('job-1');
    expect(updated.label).toBe('new');

    engine.dispose();
  });

  it('delete removes a job and emits state', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const states: string[] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
      onStateChange: (sessionName) => states.push(sessionName),
    });

    const deleted = engine.delete('job-1');
    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe('job-1');
    expect(engine.listBySession('main')).toHaveLength(0);
    expect(states).toContain('main');

    engine.dispose();
  });

  it('delete returns null for unknown jobId', () => {
    const engine = new ScheduleEngine({
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });
    expect(engine.delete('nope')).toBeNull();
    engine.dispose();
  });

  it('toggle disables a job and clears nextFireAt', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });

    const toggled = engine.toggle('job-1', false);
    expect(toggled).not.toBeNull();
    expect(toggled!.enabled).toBe(false);
    expect(toggled!.nextFireAt).toBeUndefined();

    // Re-enable
    const reToggled = engine.toggle('job-1', true);
    expect(reToggled!.enabled).toBe(true);
    expect(reToggled!.nextFireAt).toBeDefined();

    engine.dispose();
  });

  it('runNow executes immediately and updates lastFiredAt', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const executed: string[] = [];
    const savedJobs: ScheduleJob[][] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: (jobs) => savedJobs.push(jobs),
      executeJob: (job) => {
        executed.push(job.id);
        return { ok: true };
      },
    });

    const result = await engine.runNow('job-1');
    expect(result).not.toBeNull();
    expect(executed).toEqual(['job-1']);
    expect(result!.lastFiredAt).toBe(now.toISOString());
    expect(result!.lastResult).toBe('ok');
    expect(result!.execution.firedCount).toBe(1);
    expect(lastItem(savedJobs)?.[0]).toMatchObject({
      id: 'job-1',
      lastFiredAt: now.toISOString(),
      execution: { firedCount: 1 },
    });

    engine.dispose();
  });

  it('removes a naturally completed finite-run job from memory and persistence', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const savedJobs: ScheduleJob[][] = [];
    const states: Array<{ sessionName: string; jobIds: string[] }> = [];
    const events: string[] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1', execution: { maxRuns: 1, firedCount: 0 } })],
      saveJobs: (jobs) => savedJobs.push(jobs),
      executeJob: () => ({ ok: true }),
      onStateChange: (sessionName, jobs) => states.push({ sessionName, jobIds: jobs.map((job) => job.id) }),
      onEvent: (event) => events.push(`${event.type}:${event.message || ''}`),
    });

    const result = await engine.runNow('job-1');
    expect(result).not.toBeNull();
    expect(engine.listBySession('main')).toHaveLength(0);
    expect(lastItem(savedJobs)).toEqual([]);
    expect(lastItem(states)).toEqual({ sessionName: 'main', jobIds: [] });
    expect(events).toContain('triggered:schedule reached max runs');

    engine.dispose();
  });

  it('removes an expired job instead of leaving a disabled disk orphan', async () => {
    const now = new Date('2026-04-26T00:10:00.000Z');
    vi.setSystemTime(now);

    const executed = vi.fn();
    const savedJobs: ScheduleJob[][] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({
        id: 'job-1',
        execution: {
          maxRuns: 0,
          firedCount: 0,
          endAt: '2026-04-26T00:05:00.000Z',
        },
      })],
      saveJobs: (jobs) => savedJobs.push(jobs),
      executeJob: () => {
        executed();
        return { ok: true };
      },
    });

    const result = await engine.runNow('job-1');
    expect(executed).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(engine.listBySession('main')).toHaveLength(0);
    expect(lastItem(savedJobs)).toEqual([]);

    engine.dispose();
  });

  it('timer fires due jobs at the right time', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const executed: string[] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: (job) => {
        executed.push(job.id);
        return { ok: true };
      },
    });

    // Not yet
    vi.advanceTimersByTime(59_000);
    expect(executed).toEqual([]);

    // Fire at 60s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(executed).toEqual(['job-1']);

    engine.dispose();
  });

  it('execution error marks job as error and disables when disable is true', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const events: string[] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: () => ({ ok: false, message: "can't find session: main", disable: true }),
      onEvent: (event) => events.push(`${event.type}:${event.jobId}`),
    });

    const result = await engine.runNow('job-1');
    expect(result).not.toBeNull();
    expect(result!.lastResult).toBe('error');
    expect(result!.lastError).toBe("can't find session: main");
    expect(result!.enabled).toBe(false);
    expect(events).toContain('error:job-1');

    engine.dispose();
  });

  it('records thrown execution errors and reschedules without a tight retry loop', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const savedJobs: ScheduleJob[][] = [];
    const events: string[] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: (jobs) => savedJobs.push(jobs),
      executeJob: () => {
        throw new Error('tmux write exploded');
      },
      onEvent: (event) => events.push(`${event.type}:${event.message || ''}`),
    });

    const result = await engine.runNow('job-1');
    expect(result).not.toBeNull();
    expect(result!.lastResult).toBe('error');
    expect(result!.lastError).toBe('tmux write exploded');
    expect(result!.execution.firedCount).toBe(1);
    expect(result!.enabled).toBe(true);
    expect(result!.nextFireAt).toBe('2026-04-26T00:01:00.000Z');
    expect(lastItem(savedJobs)?.[0]).toMatchObject({
      id: 'job-1',
      lastResult: 'error',
      lastError: 'tmux write exploded',
      execution: { firedCount: 1 },
      nextFireAt: '2026-04-26T00:01:00.000Z',
    });
    expect(events).toContain('error:tmux write exploded');

    engine.dispose();
  });

  it('renameSession moves jobs to the new session name', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1', targetSessionName: 'old' })],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });

    engine.renameSession('old', 'new');
    expect(engine.listBySession('old')).toHaveLength(0);
    expect(engine.listBySession('new')).toHaveLength(1);
    expect(engine.listBySession('new')[0].targetSessionName).toBe('new');

    engine.dispose();
  });

  it('markSessionMissing disables all jobs for that session', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const engine = new ScheduleEngine({
      initialJobs: [
        makeJob({ id: 'job-1', targetSessionName: 'dead' }),
        makeJob({ id: 'job-2', targetSessionName: 'alive' }),
      ],
      saveJobs: () => {},
      executeJob: () => ({ ok: true }),
    });

    engine.markSessionMissing('dead', 'session killed');

    const deadJobs = engine.listBySession('dead');
    expect(deadJobs[0].enabled).toBe(false);
    expect(deadJobs[0].lastResult).toBe('error');
    expect(deadJobs[0].lastError).toBe('session killed');

    const aliveJobs = engine.listBySession('alive');
    expect(aliveJobs[0].enabled).toBe(true);

    engine.dispose();
  });

  it('dispose clears the timer', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    const executed: string[] = [];
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: (job) => { executed.push(job.id); return { ok: true }; },
    });

    engine.dispose();
    vi.advanceTimersByTime(120_000);
    expect(executed).toEqual([]);
  });

  it('dispose prevents an in-flight due run from resurrecting a timer', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    let resolveExecution: (value: { ok: boolean }) => void = () => {};
    const engine = new ScheduleEngine({
      initialJobs: [makeJob({ id: 'job-1' })],
      saveJobs: () => {},
      executeJob: () => new Promise((resolve) => {
        resolveExecution = resolve;
      }),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);

    engine.dispose();
    resolveExecution?.({ ok: true });
    await vi.runOnlyPendingTimersAsync();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('concurrent timer: running lock prevents double execution', async () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    vi.setSystemTime(now);

    let callCount = 0;
    const engine = new ScheduleEngine({
      initialJobs: [
        makeJob({ id: 'job-1', rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false } }),
        makeJob({ id: 'job-2', rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false } }),
      ],
      saveJobs: () => {},
      executeJob: async () => {
        callCount++;
        return { ok: true };
      },
    });

    // Both jobs fire at T+60s
    await vi.advanceTimersByTimeAsync(60_000);
    // Should execute both (sequentially, not duplicated)
    expect(callCount).toBe(2);

    engine.dispose();
  });
});
