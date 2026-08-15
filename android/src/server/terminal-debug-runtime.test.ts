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

  it('keeps raw debug payload out of daemon metadata and accepts explicit summaries only', () => {
    const daemonRuntimeDebugStore = createRuntimeDebugStore();
    const runtime = createTerminalDebugRuntime({
      daemonRuntimeDebugEnabled: true,
      maxClientDebugBatchLogEntries: 8,
      maxClientDebugLogPayloadChars: 900,
      clientRuntimeDebugStore: createRuntimeDebugStore(),
      daemonRuntimeDebugStore,
    });

    runtime.daemonRuntimeDebug('send', {
      sessionId: 'session-1',
      sessionName: 'demo',
      type: 'buffer-sync',
      payload: {
        lines: [{ index: 1, text: 'secret-terminal-row' }],
      },
      payloadSummary: {
        revision: 7,
        lineCount: 1,
      },
    });

    const entries = daemonRuntimeDebugStore.listEntries({ scopeIncludes: 'send' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toContain('"payloadSummary":{"revision":7,"lineCount":1}');
    expect(entries[0]?.payload).not.toContain('secret-terminal-row');
    expect(entries[0]?.payload).not.toContain('"lines"');
  });

  it('defaults daemon debug control to deny and expires an explicit lease', () => {
    const daemonRuntimeDebugStore = createRuntimeDebugStore();
    const runtime = createTerminalDebugRuntime({
      daemonRuntimeDebugEnabled: false,
      maxClientDebugBatchLogEntries: 8,
      maxClientDebugLogPayloadChars: 900,
      clientRuntimeDebugStore: createRuntimeDebugStore(),
      daemonRuntimeDebugStore,
    });

    runtime.setDaemonRuntimeDebugLease(true, 50);
    vi.useFakeTimers();
    try {
      runtime.daemonRuntimeDebug('input-drop', { sessionId: 'session-1', reason: 'inside-lease' });
      vi.advanceTimersByTime(51);
      runtime.daemonRuntimeDebug('input-drop', { sessionId: 'session-1', reason: 'after-lease' });
    } finally {
      vi.useRealTimers();
    }

    const entries = daemonRuntimeDebugStore.listEntries({ scopeIncludes: 'input-drop' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toContain('inside-lease');
  });

  it('exposes bounded typed debug events and permission summary through the runtime', () => {
    const runtime = createTerminalDebugRuntime({
      daemonRuntimeDebugEnabled: true,
      maxClientDebugBatchLogEntries: 8,
      maxClientDebugLogPayloadChars: 900,
      clientRuntimeDebugStore: createRuntimeDebugStore(),
      daemonRuntimeDebugStore: createRuntimeDebugStore(),
    });

    runtime.daemonRuntimeDebug('input-write', {
      transportId: 'transport-1',
      sessionId: 'session-1',
      bytes: 4,
    });

    expect(runtime.getDebugPermissionSummary()).toMatchObject({
      capability: 'debug:control',
    });
    expect(runtime.listDebugEvents()).toHaveLength(1);
    expect(runtime.listDebugEvents()[0]).toMatchObject({
      nodeId: 'daemon.runtime.debug',
      kind: 'daemon.input-write',
      sensitivity: 'internal',
    });
    expect(runtime.getDebugDropCount()).toBe(0);
  });
});
