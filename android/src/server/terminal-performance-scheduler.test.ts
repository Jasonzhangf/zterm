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
    lastProgressAt: 990,
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
