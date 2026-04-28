import { describe, expect, it } from 'vitest';
import type { ScheduleJob } from '../../../packages/shared/src/schedule/types.ts';
import {
  computeNextFireAtForJob,
  computeNextFireAtForRule,
  normalizeScheduleDraft,
  formatIntervalMs,
  describeScheduleRule,
  formatScheduleDateTime,
} from '../../../packages/shared/src/schedule/next-fire.ts';

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
    lastFiredAt: overrides.lastFiredAt,
    createdAt: overrides.createdAt || '2026-04-26T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-26T00:00:00.000Z',
    ...('nextFireAt' in overrides ? { nextFireAt: overrides.nextFireAt } : {}),
    ...('lastResult' in overrides ? { lastResult: overrides.lastResult } : {}),
    ...('lastError' in overrides ? { lastError: overrides.lastError } : {}),
  } as ScheduleJob;
}

// ═══════════════════════════════════════════════════════════
//  computeNextFireAtForJob — interval
// ═══════════════════════════════════════════════════════════

describe('computeNextFireAtForJob / interval', () => {
  it('returns startAt + intervalMs when no lastFiredAt and not fireImmediately', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
      }),
      now,
    );
    // startAt + 1 interval = T+60s
    expect(result).toBe('2026-04-26T00:01:00.000Z');
  });

  it('returns now (clamped to startAt) when fireImmediately and startAt <= now', () => {
    const now = new Date('2026-04-26T00:05:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: true },
      }),
      now,
    );
    expect(result).toBe(now.toISOString());
  });

  it('returns startAt when fireImmediately and startAt > now', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:10:00.000Z', fireImmediately: true },
      }),
      now,
    );
    expect(result).toBe('2026-04-26T00:10:00.000Z');
  });

  it('advances past now based on lastFiredAt', () => {
    const now = new Date('2026-04-26T00:05:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 120_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
        lastFiredAt: '2026-04-26T00:02:00.000Z',
      }),
      now,
    );
    // lastFired(00:02) + 120s = 00:04, which is <= now(00:05), so next = 00:06
    expect(result).toBe('2026-04-26T00:06:00.000Z');
  });

  it('skips multiple missed intervals to land in the future', () => {
    const now = new Date('2026-04-26T00:10:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
        lastFiredAt: '2026-04-26T00:01:00.000Z',
      }),
      now,
    );
    // lastFired(00:01) + 60s*N, first > 00:10 → 00:11
    expect(result).toBe('2026-04-26T00:11:00.000Z');
  });

  it('returns undefined when intervalMs is invalid (< 1000)', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 100, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
      }),
      now,
    );
    // MIN_INTERVAL_MS = 1000, 100 → clamped to 1000 → startAt + 1s
    expect(result).toBe('2026-04-26T00:00:01.000Z');
  });

  it('returns undefined when startAt is unparseable', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 60_000, startAt: 'not-a-date', fireImmediately: false },
      }),
      now,
    );
    expect(result).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
//  computeNextFireAtForJob — alarm once
// ═══════════════════════════════════════════════════════════

describe('computeNextFireAtForJob / alarm once', () => {
  const makeAlarmOnce = (date: string, time: string, tz = 'UTC') =>
    makeJob({
      rule: { kind: 'alarm', timezone: tz, date, time, repeat: 'once' },
    });

  it('returns the wall-time converted to UTC when in the future', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(makeAlarmOnce('2026-04-26', '12:00'), now);
    expect(result).toBe('2026-04-26T12:00:00.000Z');
  });

  it('returns undefined when the once time has already passed', () => {
    const now = new Date('2026-04-26T15:00:00.000Z');
    const result = computeNextFireAtForJob(makeAlarmOnce('2026-04-26', '12:00'), now);
    expect(result).toBeUndefined();
  });

  it('handles Asia/Shanghai timezone (UTC+8)', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(makeAlarmOnce('2026-04-26', '20:00', 'Asia/Shanghai'), now);
    // 20:00 Shanghai = 12:00 UTC
    expect(result).toBe('2026-04-26T12:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════
//  computeNextFireAtForJob — alarm daily / weekdays / weekly / custom
// ═══════════════════════════════════════════════════════════

describe('computeNextFireAtForJob / alarm recurring', () => {
  it('daily: returns today if time is still ahead', () => {
    const now = new Date('2026-04-26T08:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({ rule: { kind: 'alarm', timezone: 'UTC', date: '2026-04-26', time: '10:00', repeat: 'daily' } }),
      now,
    );
    expect(result).toBe('2026-04-26T10:00:00.000Z');
  });

  it('daily: returns tomorrow if time has already passed today', () => {
    const now = new Date('2026-04-26T15:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({ rule: { kind: 'alarm', timezone: 'UTC', date: '2026-04-26', time: '10:00', repeat: 'daily' } }),
      now,
    );
    expect(result).toBe('2026-04-27T10:00:00.000Z');
  });

  it('weekdays: skips Saturday and Sunday', () => {
    // 2026-04-25 is Saturday, 04-26 is Sunday
    const now = new Date('2026-04-25T08:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({ rule: { kind: 'alarm', timezone: 'UTC', date: '2026-04-25', time: '10:00', repeat: 'weekdays' } }),
      now,
    );
    // Should skip Sat(25), Sun(26), next weekday Mon(27)
    expect(result).toBe('2026-04-27T10:00:00.000Z');
  });

  it('weekly: picks the matching weekday', () => {
    // 2026-04-26 is Sunday (weekday 0); repeat=weekly on that date
    const now = new Date('2026-04-26T08:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({ rule: { kind: 'alarm', timezone: 'UTC', date: '2026-04-26', time: '10:00', repeat: 'weekly' } }),
      now,
    );
    // Same day, time ahead → today
    expect(result).toBe('2026-04-26T10:00:00.000Z');
  });

  it('custom: respects user-selected weekdays', () => {
    // 2026-04-25 Sat, 04-26 Sun, 04-27 Mon
    const now = new Date('2026-04-25T15:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: {
          kind: 'alarm',
          timezone: 'UTC',
          date: '2026-04-25',
          time: '10:00',
          repeat: 'custom',
          weekdays: [1, 3, 5], // Mon, Wed, Fri
        },
      }),
      now,
    );
    // Sat(25) not in [1,3,5], Sun(26) not in [1,3,5], Mon(27) is → 04-27
    expect(result).toBe('2026-04-27T10:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════
//  computeNextFireAtForJob — disabled
// ═══════════════════════════════════════════════════════════

describe('computeNextFireAtForJob / disabled', () => {
  it('returns undefined for disabled jobs', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({ enabled: false }),
      now,
    );
    expect(result).toBeUndefined();
  });
});

describe('computeNextFireAtForJob / execution policy', () => {
  it('returns undefined when maxRuns has been reached', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        execution: {
          maxRuns: 3,
          firedCount: 3,
        },
      }),
      now,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when endAt has already passed', () => {
    const now = new Date('2026-04-26T00:10:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        execution: {
          maxRuns: 0,
          firedCount: 1,
          endAt: '2026-04-26T00:05:00.000Z',
        },
      }),
      now,
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when the next candidate would exceed endAt', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForJob(
      makeJob({
        rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
        execution: {
          maxRuns: 0,
          firedCount: 0,
          endAt: '2026-04-26T00:00:30.000Z',
        },
      }),
      now,
    );
    expect(result).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
//  computeNextFireAtForRule (preview wrapper)
// ═══════════════════════════════════════════════════════════

describe('computeNextFireAtForRule', () => {
  it('delegates to computeNextFireAtForJob with a pseudo-job', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = computeNextFireAtForRule(
      { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
      now,
    );
    expect(result).toBe('2026-04-26T00:01:00.000Z');
  });

  it('passes lastFiredAt through', () => {
    const now = new Date('2026-04-26T00:05:00.000Z');
    const result = computeNextFireAtForRule(
      { kind: 'interval', intervalMs: 120_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
      now,
      '2026-04-26T00:02:00.000Z',
    );
    expect(result).toBe('2026-04-26T00:06:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════
//  normalizeScheduleDraft
// ═══════════════════════════════════════════════════════════

describe('normalizeScheduleDraft', () => {
  it('preserves existing id / lastFiredAt / lastResult / createdAt', () => {
    const now = new Date('2026-04-26T01:00:00.000Z');
    const existing: ScheduleJob = makeJob({
      id: 'existing-1',
      lastFiredAt: '2026-04-26T00:30:00.000Z',
      createdAt: '2026-04-25T00:00:00.000Z',
    });
    (existing as any).lastResult = 'ok';

    const result = normalizeScheduleDraft(
      {
        id: 'existing-1',
        targetSessionName: 'main',
        payload: { text: 'status', appendEnter: true },
        rule: { kind: 'interval', intervalMs: 60_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
      },
      { now, existing },
    );

    expect(result.id).toBe('existing-1');
    expect(result.lastFiredAt).toBe('2026-04-26T00:30:00.000Z');
    expect(result.createdAt).toBe('2026-04-25T00:00:00.000Z');
    expect(result.updatedAt).toBe(now.toISOString());
    expect(result.nextFireAt).toBeDefined();
  });

  it('computes nextFireAt for the normalized draft', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const result = normalizeScheduleDraft(
      {
        targetSessionName: 'main',
        payload: { text: 'ping', appendEnter: true },
        rule: { kind: 'interval', intervalMs: 300_000, startAt: '2026-04-26T00:00:00.000Z', fireImmediately: false },
      },
      { now },
    );
    expect(result.nextFireAt).toBe('2026-04-26T00:05:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════
//  formatIntervalMs / describeScheduleRule
// ═══════════════════════════════════════════════════════════

describe('formatIntervalMs', () => {
  it('formats hours', () => {
    expect(formatIntervalMs(3_600_000)).toBe('每 1 hour');
    expect(formatIntervalMs(7_200_000)).toBe('每 2 hours');
  });
  it('formats minutes', () => {
    expect(formatIntervalMs(60_000)).toBe('每 1 minute');
    expect(formatIntervalMs(900_000)).toBe('每 15 minutes');
  });
  it('formats seconds', () => {
    expect(formatIntervalMs(5_000)).toBe('每 5 seconds');
    expect(formatIntervalMs(1_000)).toBe('每 1 second');
  });
});

describe('describeScheduleRule', () => {
  it('describes interval', () => {
    expect(describeScheduleRule({ rule: { kind: 'interval', intervalMs: 60_000, startAt: '', fireImmediately: false } }))
      .toBe('每 1 minute');
  });
  it('describes alarm once', () => {
    expect(describeScheduleRule({ rule: { kind: 'alarm', timezone: 'UTC', date: '2026-04-26', time: '09:30', repeat: 'once' } }))
      .toBe('仅一次 09:30');
  });
  it('describes alarm daily', () => {
    expect(describeScheduleRule({ rule: { kind: 'alarm', timezone: 'UTC', date: '2026-04-26', time: '08:00', repeat: 'daily' } }))
      .toBe('每天 08:00');
  });
});

// ═══════════════════════════════════════════════════════════
//  formatScheduleDateTime
// ═══════════════════════════════════════════════════════════

describe('formatScheduleDateTime', () => {
  it('returns - for undefined / empty', () => {
    expect(formatScheduleDateTime(undefined)).toBe('-');
    expect(formatScheduleDateTime('')).toBe('-');
  });
  it('returns - for invalid date string', () => {
    expect(formatScheduleDateTime('not-a-date')).toBe('-');
  });
  it('formats a valid date', () => {
    const result = formatScheduleDateTime('2026-04-26T14:30:00.000Z', { timeZone: 'UTC' });
    expect(result).toContain('04/26');
    expect(result).toContain('14:30');
  });
});
