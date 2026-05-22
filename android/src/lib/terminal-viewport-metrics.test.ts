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

  it('switches to landscape after rotation even when stable portrait height was seen before', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 2400 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 2400 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 1200, height: 2400, offsetTop: 0, offsetLeft: 0, scale: 1 },
    });
    expect(resolveTerminalOrientation()).toBe('portrait');

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 2400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 2400 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 2400, height: 1200, offsetTop: 0, offsetLeft: 0, scale: 1 },
    });

    expect(resolveTerminalOrientation()).toBe('landscape');
  });

  it('does not reuse stable portrait height as landscape shell height after rotation', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 2400 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 2400 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 1200, height: 2400, offsetTop: 0, offsetLeft: 0, scale: 1 },
    });
    expect(resolveTerminalViewportMetrics().layoutHeight).toBe(2400);

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 2400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 1200 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 2400 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 2400, height: 1200, offsetTop: 0, offsetLeft: 0, scale: 1 },
    });

    const landscapeMetrics = resolveTerminalViewportMetrics();
    expect(landscapeMetrics.orientation).toBe('landscape');
    expect(landscapeMetrics.layoutHeight).toBe(1200);
  });

});
