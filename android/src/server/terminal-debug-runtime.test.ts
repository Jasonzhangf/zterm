import { describe, expect, it, vi } from 'vitest';
import { createRuntimeDebugStore } from './runtime-debug-store';
import { createTerminalDebugRuntime } from './terminal-debug-runtime';

describe('terminal debug runtime daemon metadata truth', () => {
  it('stores daemon runtime metadata separately from client runtime logs when enabled', () => {
    const clientRuntimeDebugStore = createRuntimeDebugStore();
    const daemonRuntimeDebugStore = createRuntimeDebugStore();
    const runtime = createTerminalDebugRuntime({
      daemonRuntimeDebugEnabled: true,
      maxClientDebugBatchLogEntries: 8,
      maxClientDebugLogPayloadChars: 900,
      clientRuntimeDebugStore,
      daemonRuntimeDebugStore,
      sessions: new Map(),
    });

    runtime.daemonRuntimeDebug('input-write', {
      transportId: 'transport-1',
      sessionId: 'session-1',
      sessionName: 'demo',
      bytes: 4,
      durationMs: 2,
      queueDepth: 0,
      payload: 'pwd\r',
    });

    expect(clientRuntimeDebugStore.getSummary().totalEntries).toBe(0);
    const entries = daemonRuntimeDebugStore.listEntries({ scopeIncludes: 'input' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sessionId: 'session-1',
      tmuxSessionName: 'demo',
      scope: 'input-write',
    });
    expect(entries[0]?.payload).toContain('"bytes":4');
    expect(entries[0]?.payload).toContain('"durationMs":2');
    expect(entries[0]?.payload).toContain('"queueDepth":0');
    expect(entries[0]?.payload).not.toContain('pwd');
  });

  it('allows remote control to enable daemon debug without process restart', () => {
    const daemonRuntimeDebugStore = createRuntimeDebugStore();
    const runtime = createTerminalDebugRuntime({
      daemonRuntimeDebugEnabled: false,
      maxClientDebugBatchLogEntries: 8,
      maxClientDebugLogPayloadChars: 900,
      clientRuntimeDebugStore: createRuntimeDebugStore(),
      daemonRuntimeDebugStore,
      sessions: new Map(),
    });

    runtime.daemonRuntimeDebug('input-drop', { sessionId: 'session-1', reason: 'before-enable' });
    expect(daemonRuntimeDebugStore.getSummary().totalEntries).toBe(0);

    runtime.setDaemonRuntimeDebugEnabled(true);
    runtime.daemonRuntimeDebug('input-drop', { sessionId: 'session-1', reason: 'after-enable' });

    expect(daemonRuntimeDebugStore.listEntries({ scopeIncludes: 'input-drop' })).toHaveLength(1);
  });

  it('does not mirror daemon input payload content to console output', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const runtime = createTerminalDebugRuntime({
      daemonRuntimeDebugEnabled: true,
      maxClientDebugBatchLogEntries: 8,
      maxClientDebugLogPayloadChars: 900,
      clientRuntimeDebugStore: createRuntimeDebugStore(),
      daemonRuntimeDebugStore: createRuntimeDebugStore(),
      sessions: new Map(),
    });

    runtime.daemonRuntimeDebug('input-receive', {
      sessionId: 'session-1',
      sessionName: 'demo',
      bytes: 4,
      payload: 'pwd\r',
    });

    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('pwd');
    debugSpy.mockRestore();
  });
});
