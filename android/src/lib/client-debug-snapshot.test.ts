// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { collectClientDebugSnapshot, registerClientDebugSnapshotSource } from './client-debug-snapshot';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('client-debug-snapshot', () => {
  it('collects registered sources into a single snapshot truth', () => {
    cleanups.push(registerClientDebugSnapshotSource('app-shell', () => ({
      appUpdateStage: 'checking-manifest',
      runtimeVersionCode: 1011491,
      updateChecking: true,
    })));
    cleanups.push(registerClientDebugSnapshotSource('terminal-page', () => ({
      keyboardInset: 320,
      effectiveKeyboardLiftPx: 280,
      shellHeight: 1366,
      layoutViewportHeight: 1366,
      terminalChromeBottomPx: 84,
      splitVisible: true,
    })));

    const snapshot = collectClientDebugSnapshot({ reason: 'test' });
    expect(snapshot.extra).toEqual({ reason: 'test' });
    expect(snapshot.sources['app-shell']).toEqual(expect.objectContaining({
      appUpdateStage: 'checking-manifest',
      runtimeVersionCode: 1011491,
      updateChecking: true,
    }));
    expect(snapshot.sources['terminal-page']).toEqual(expect.objectContaining({
      keyboardInset: 320,
      effectiveKeyboardLiftPx: 280,
      shellHeight: 1366,
      layoutViewportHeight: 1366,
      terminalChromeBottomPx: 84,
      splitVisible: true,
    }));
  });
});
