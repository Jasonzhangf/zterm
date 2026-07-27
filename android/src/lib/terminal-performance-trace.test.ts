import { describe, expect, it } from 'vitest';
import {
  createTerminalPerformanceTraceStore,
  parseRuntimeDebugPerformanceTraceRecords,
  summarizeTerminalPerformanceTrace,
} from './terminal-performance-trace';

describe('terminal performance trace', () => {
  it('builds per-session capture-to-render latency summary for multi-pane traces', () => {
    const store = createTerminalPerformanceTraceStore({ limit: 20 });
    store.record({ sessionId: 'pane-1', stage: 'capture-start', at: 0 });
    store.record({ sessionId: 'pane-1', stage: 'send-done', at: 20, bytes: 800, lineCount: 5 });
    store.record({ sessionId: 'pane-1', stage: 'client-rx', at: 24, bytes: 800 });
    store.record({ sessionId: 'pane-1', stage: 'buffer-apply-done', at: 30 });
    store.record({ sessionId: 'pane-1', stage: 'render-commit', at: 44 });

    store.record({ sessionId: 'pane-2', stage: 'capture-start', at: 4 });
    store.record({ sessionId: 'pane-2', stage: 'send-done', at: 32, bytes: 1200, lineCount: 8 });
    store.record({ sessionId: 'pane-2', stage: 'client-rx', at: 38, bytes: 1200 });
    store.record({ sessionId: 'pane-2', stage: 'buffer-apply-done', at: 48 });
    store.record({ sessionId: 'pane-2', stage: 'render-commit', at: 68 });

    const summary = summarizeTerminalPerformanceTrace(store.snapshot());

    expect(summary.sessions).toHaveLength(2);
    expect(summary.sessions.find((item) => item.sessionId === 'pane-1')).toMatchObject({
      captureToRenderMs: 44,
      sendToRxMs: 4,
      rxToRenderMs: 20,
      bytes: 1600,
      lineCount: 5,
    });
    expect(summary.p95CaptureToRenderMs).toBe(64);
  });

  it('does not merge the same session across different trace revisions into synthetic latency', () => {
    const store = createTerminalPerformanceTraceStore({ limit: 20 });
    store.record({
      sessionId: 'pane-1',
      traceId: 'trace-a',
      mirrorRevision: 10,
      subscriberId: 'sub-1',
      stage: 'capture-start',
      at: 0,
    });
    store.record({
      sessionId: 'pane-1',
      traceId: 'trace-b',
      mirrorRevision: 11,
      subscriberId: 'sub-1',
      stage: 'render-commit',
      at: 50,
    });

    const summary = summarizeTerminalPerformanceTrace(store.snapshot());

    expect(summary.sessions).toHaveLength(2);
    expect(summary.sessions.map((item) => item.captureToRenderMs)).toEqual([null, null]);
    expect(summary.p95CaptureToRenderMs).toBeNull();
  });

  it('joins daemon mux-channel trace ids with client local session trace ids', () => {
    const store = createTerminalPerformanceTraceStore({ limit: 20 });
    store.record({
      sessionId: 'target-1:channel:session-abc',
      traceId: 'target-1:channel:session-abc:77',
      mirrorRevision: 77,
      subscriberId: 'target-1:channel:session-abc',
      stage: 'send-done',
      at: 100,
      bytes: 900,
      lineCount: 12,
    });
    store.record({
      sessionId: 'session-abc',
      traceId: 'session-abc:77',
      mirrorRevision: 77,
      subscriberId: 'session-abc',
      stage: 'client-rx',
      at: 112,
      bytes: 900,
    });
    store.record({
      sessionId: 'session-abc',
      traceId: 'session-abc:77',
      mirrorRevision: 77,
      subscriberId: 'session-abc',
      stage: 'render-commit',
      at: 145,
      lineCount: 12,
    });

    const summary = summarizeTerminalPerformanceTrace(store.snapshot());

    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0]).toMatchObject({
      traceId: 'target-1:channel:session-abc:77',
      mirrorRevision: 77,
      subscriberId: 'target-1:channel:session-abc',
      sendToRxMs: 12,
      rxToRenderMs: 33,
      bytes: 1800,
      lineCount: 12,
    });
  });

  it('stores metadata only and rejects terminal payload content', () => {
    const store = createTerminalPerformanceTraceStore({ limit: 20 });

    expect(() => store.record({
      sessionId: 'pane-1',
      stage: 'send-done',
      at: 10,
      bytes: 4,
      // @ts-expect-error payload content is intentionally forbidden in trace records
      payload: 'real terminal text',
    })).toThrow('terminal performance trace must not store payload content');
  });

  it('parses runtime debug trace entries without accepting terminal payload content', () => {
    const records = parseRuntimeDebugPerformanceTraceRecords([
      {
        sessionId: 'pane-1',
        scope: 'terminal.performance.trace',
        payload: JSON.stringify({
          stage: 'client-rx',
          traceId: 'trace-1',
          mirrorRevision: 9,
          subscriberId: 'sub-1',
          at: 120,
          bytes: 512,
          lineCount: 4,
          text: 'secret terminal output',
        }),
      },
      {
        sessionId: 'pane-1',
        scope: 'session.buffer.apply.inspect',
        payload: JSON.stringify({ stage: 'buffer-apply-done', at: 130 }),
      },
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: 'pane-1',
      stage: 'client-rx',
      traceId: 'trace-1',
      mirrorRevision: 9,
      subscriberId: 'sub-1',
      at: 120,
      bytes: 512,
      lineCount: 4,
    });
    expect(JSON.stringify(records)).not.toContain('secret terminal output');
  });
});
