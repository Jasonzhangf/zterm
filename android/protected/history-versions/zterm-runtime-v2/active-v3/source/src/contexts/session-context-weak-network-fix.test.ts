// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { resolveTerminalRefreshCadence } from '../lib/mobile-config';

describe('weak-network fix: cadence RTT-aware', () => {
  it('falls back to fast cadence without RTT', () => {
    const original = (navigator as any).connection;
    Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined });
    const cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(33);
    expect(cadence.pullRequestStaleMs).toBe(1500);
    Object.defineProperty(navigator, 'connection', { configurable: true, value: original });
  });

  it('uses slow cadence when RTT >= 800ms', () => {
    const original = (navigator as any).connection;
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType: '4g', saveData: false, rtt: 900 },
    });
    const cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(120);
    expect(cadence.pullRequestStaleMs).toBe(2500);
    Object.defineProperty(navigator, 'connection', { configurable: true, value: original });
  });

  it('uses mid cadence when RTT >= 300ms and < 800ms', () => {
    const original = (navigator as any).connection;
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType: '4g', saveData: false, rtt: 420 },
    });
    const cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(66);
    expect(cadence.pullRequestStaleMs).toBe(2000);
    Object.defineProperty(navigator, 'connection', { configurable: true, value: original });
  });
});
