import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTerminalRefreshCadence } from './mobile-config';

function mockConnection(effectiveType: string, saveData = false) {
  Object.defineProperty(globalThis.navigator, 'connection', {
    configurable: true,
    value: { effectiveType, saveData },
  });
}

describe('mobile-config refresh cadence', () => {
  afterEach(() => {
    Object.defineProperty(globalThis.navigator, 'connection', {
      configurable: true,
      value: undefined,
    });
    vi.restoreAllMocks();
  });

  it('uses fast cadence on good networks', () => {
    mockConnection('4g', false);
    const cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(33);
    expect(cadence.minTailRefreshGapMs).toBe(33);
    expect(cadence.renderCommitMs).toBe(33);
    expect(cadence.readingSyncDelayMs).toBe(24);
  });

  it('uses middle cadence on 3g', () => {
    mockConnection('3g', false);
    const cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(66);
    expect(cadence.minTailRefreshGapMs).toBe(66);
    expect(cadence.renderCommitMs).toBe(66);
    expect(cadence.readingSyncDelayMs).toBe(48);
  });

  it('uses low refresh cadence on slow networks or save-data', () => {
    mockConnection('2g', false);
    let cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(120);
    expect(cadence.minTailRefreshGapMs).toBe(120);
    expect(cadence.renderCommitMs).toBe(120);
    expect(cadence.readingSyncDelayMs).toBe(72);

    mockConnection('4g', true);
    cadence = resolveTerminalRefreshCadence();
    expect(cadence.headTickMs).toBe(120);
    expect(cadence.renderCommitMs).toBe(120);
  });
});
