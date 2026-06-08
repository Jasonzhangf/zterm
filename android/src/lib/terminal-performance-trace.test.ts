import { describe, expect, it } from 'vitest';
import {
  createTerminalPerformanceTraceStore,
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
});
