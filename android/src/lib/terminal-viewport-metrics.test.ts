// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { resolveTerminalOrientation, resolveTerminalViewportMetrics } from './terminal-viewport-metrics';

describe('terminal-viewport-metrics', () => {
  it('prefers stable layout viewport dimensions over transient visual viewport shrink', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1366 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        width: 900,
        height: 500,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
      },
    });

    const metrics = resolveTerminalViewportMetrics();
    expect(metrics.layoutWidth).toBe(1366);
    expect(metrics.layoutHeight).toBe(1024);
    expect(resolveTerminalOrientation()).toBe('landscape');
  });
});
