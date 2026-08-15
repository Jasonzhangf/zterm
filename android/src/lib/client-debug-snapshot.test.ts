// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectClientDebugSnapshot,
  registerClientDebugSnapshotSource,
  resetClientDebugSnapshotForTests,
} from './client-debug-snapshot';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  resetClientDebugSnapshotForTests();
});

beforeEach(() => {
  resetClientDebugSnapshotForTests();
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

  it('returns versioned immutable snapshot metadata', () => {
    const first = collectClientDebugSnapshot({ reason: 'first' });
    const second = collectClientDebugSnapshot({ reason: 'second' });

    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(first.nodeId).toBe('client.runtime.debug');
    expect(first.sensitivity).toBe('internal');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('rejects duplicate debug snapshot producers', () => {
    const cleanup = registerClientDebugSnapshotSource('duplicate-source', () => ({ value: 1 }));

    expect(() =>
      registerClientDebugSnapshotSource('duplicate-source', () => ({ value: 2 })),
    ).toThrow(/duplicate debug producer/);

    cleanup();
  });
});
