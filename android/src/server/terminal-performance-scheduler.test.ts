import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveTerminalLiveSyncDelay,
  type TerminalLiveSyncSchedulerInput,
} from './terminal-performance-scheduler';

function input(overrides: Partial<TerminalLiveSyncSchedulerInput> = {}): TerminalLiveSyncSchedulerInput {
  return {
    requestedDelayMs: 33,
    activeDelayMs: 33,
    idleDelayMs: 120,
    now: 1_000,
    lastLiveActivityAt: 990,
    consecutiveFailures: 0,
    subscriberCount: 1,
    transportBufferedBytes: 0,
    transportBackpressureCount: 0,
    lastCaptureDurationMs: 8,
    lastCanonicalizeDurationMs: 4,
    flushInFlight: false,
    ...overrides,
  };
}

describe('terminal live performance scheduler', () => {
  it('uses fast lane for good transport with low capture cost and empty send queue', () => {
    expect(resolveTerminalLiveSyncDelay(input()).lane).toBe('fast');
    expect(resolveTerminalLiveSyncDelay(input()).delayMs).toBe(16);
  });

  it('keeps subscribed mirrors on active cadence even when live content has not changed recently', () => {
    const result = resolveTerminalLiveSyncDelay(input({
      requestedDelayMs: 33,
      now: 10_000,
      lastLiveActivityAt: 1_000,
      subscriberCount: 1,
      transportBufferedBytes: 0,
      transportBackpressureCount: 0,
      lastCaptureDurationMs: 8,
      lastCanonicalizeDurationMs: 4,
    }));

    expect(result.lane).toBe('fast');
    expect(result.delayMs).toBe(16);
    expect(result.reason).toBe('subscribed-good-transport-low-capture-cost');
  });

  it('slows down when transport buffered bytes show backpressure', () => {
    const result = resolveTerminalLiveSyncDelay(input({
      transportBufferedBytes: 512 * 1024,
      transportBackpressureCount: 2,
    }));

    expect(result.lane).toBe('slow');
    expect(result.delayMs).toBeGreaterThanOrEqual(120);
  });

  it('backs off over-budget capture without starving other mirrors forever', () => {
    const result = resolveTerminalLiveSyncDelay(input({
      lastCaptureDurationMs: 140,
      lastCanonicalizeDurationMs: 42,
    }));

    expect(result.lane).toBe('overloaded');
    expect(result.delayMs).toBeGreaterThanOrEqual(180);
    expect(result.delayMs).toBeLessThanOrEqual(1_000);
  });

  it('does not accept client UI state as scheduler input', () => {
    const source = readFileSync(
      join(__dirname, 'terminal-performance-scheduler.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/\bactiveSessionId\b/);
    expect(source).not.toMatch(/\bfollow\b/);
    expect(source).not.toMatch(/\breading\b/);
    expect(source).not.toMatch(/\bvisibleRange\b/);
    expect(source).not.toMatch(/\bviewport\b/);
  });
});

describe('R9 fast lane bounds', () => {
  it('flush-in-flight forces a minimum 16ms gap even when fast lane is otherwise active', () => {
    const decision = resolveTerminalLiveSyncDelay({
      requestedDelayMs: 16,
      activeDelayMs: 33,
      idleDelayMs: 120,
      now: Date.now(),
      lastLiveActivityAt: Date.now(),
      consecutiveFailures: 0,
      subscriberCount: 1,
      transportBufferedBytes: 0,
      transportBackpressureCount: 0,
      lastCaptureDurationMs: 0,
      lastCanonicalizeDurationMs: 0,
      flushInFlight: true,
    });
    expect(decision.lane).toBe('normal');
    expect(decision.delayMs).toBeGreaterThanOrEqual(16);
  });

  it('explicit-immediate (requestedDelayMs=0) returns 0 for attach/input first-frame path', () => {
    const decision = resolveTerminalLiveSyncDelay({
      requestedDelayMs: 0,
      activeDelayMs: 33,
      idleDelayMs: 120,
      now: Date.now(),
      lastLiveActivityAt: 0,
      consecutiveFailures: 0,
      subscriberCount: 1,
      transportBufferedBytes: 0,
      transportBackpressureCount: 0,
      lastCaptureDurationMs: 0,
      lastCanonicalizeDurationMs: 0,
      flushInFlight: false,
    });
    expect(decision.lane).toBe('fast');
    expect(decision.delayMs).toBe(0);
  });
});
