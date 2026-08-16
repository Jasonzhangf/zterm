import { describe, expect, it, vi } from 'vitest';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { buildLifecycleRefreshTargets } from './session-context-lifecycle';
import { requestSessionBufferHeadRuntime, requestSessionBufferSyncRuntime } from './session-context-buffer-runtime';
import { createSessionBufferState } from '../lib/terminal-buffer';
import {
  createTerminalPerformanceTraceStore,
  summarizeTerminalPerformanceTrace,
} from '../lib/terminal-performance-trace';
import type { Session } from '../lib/types';

type TestSession = Session & { buffer: import('../lib/types').SessionBufferState };

function makeSession(sessionId: string): TestSession {
  return {
    id: sessionId,
    hostId: `host-${sessionId}`,
    connectionName: `conn-${sessionId}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `tmux-${sessionId}`,
    title: sessionId,
    ws: null,
    state: 'connected',
    hasUnread: false,
    buffer: createSessionBufferState({
      lines: ['alpha'],
      startIndex: 0,
      endIndex: 1,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 1,
      cols: 80,
      rows: 24,
      revision: 1,
      cacheLines: 1000,
    }),
    createdAt: 1,
  };
}

describe('multi-pane refresh truth', () => {
  it('builds one refresh target for the active session only', () => {
    expect(buildLifecycleRefreshTargets({
      activeSessionId: 's1',
      liveSessionIds: ['s1', 's2', 's3'],
    } as any)).toEqual(['s1']);
  });

  it('does not include passive visible pane sessions in the active refresh target list', () => {
    expect(buildLifecycleRefreshTargets({
      activeSessionId: 's1',
      liveSessionIds: ['s2', 's3'],
    } as any)).toEqual(['s1']);
  });

  it('debounces duplicate per-session sync requests even when multiple panes ask for the same session', () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'session-1';
      const session = makeSession(sessionId);
      const ws = { readyState: WebSocket.OPEN } as any;
      const sendSocketPayload = vi.fn();
      const refs = {
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        sessionVisibleRangeRef: {
          current: new Map([[sessionId, { startIndex: 0, endIndex: 1, viewportRows: 24 }]]),
        },
        sessionHeadStoreRef: { current: { getLiveHead: () => null } },
        sessionPullStateRef: { current: new Map() },
        tailRefreshStoreRef: { current: createSessionTailRefreshStore() },
      };

      const first = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: { reason: 'pane-1', purpose: 'tail-refresh' },
        refs,
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState: vi.fn(),
        sendSocketPayload,
        runtimeDebug: vi.fn(),
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });
      const second = requestSessionBufferSyncRuntime({
        sessionId,
        requestOptions: { reason: 'pane-2', purpose: 'tail-refresh' },
        refs,
        readSessionTransportSocket: () => ws,
        readSessionBufferSnapshot: () => session.buffer,
        clearSessionPullState: vi.fn(),
        sendSocketPayload,
        runtimeDebug: vi.fn(),
        resolveTerminalRefreshCadence: () => ({ pullRequestStaleMs: 1500, minTailRefreshGapMs: 33, readingSyncDelayMs: 24 }),
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates duplicate head requests for the same session when multiple panes share it', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const recordRefreshRequest = vi.fn();
    const lastHeadRequestAtRef = { current: new Map<string, number>() };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const first = requestSessionBufferHeadRuntime({
        sessionId,
        refs: {
          stateRef: { current: { sessions: [session] } },
          lastHeadRequestAtRef,
          sessionDebugMetricsStoreRef: { current: { recordRefreshRequest } },
        },
        readSessionTransportSocket: () => ws,
        sendSocketPayload,
        resolveTerminalRefreshCadence: () => ({ headTickMs: 33 }),
      });
      const second = requestSessionBufferHeadRuntime({
        sessionId,
        refs: {
          stateRef: { current: { sessions: [session] } },
          lastHeadRequestAtRef,
          sessionDebugMetricsStoreRef: { current: { recordRefreshRequest } },
        },
        readSessionTransportSocket: () => ws,
        sendSocketPayload,
        resolveTerminalRefreshCadence: () => ({ headTickMs: 33 }),
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(sendSocketPayload).toHaveBeenCalledTimes(1);
      expect(recordRefreshRequest).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('summarizes 3-pane capture-to-render latency so multi-pane freshness has a measurable SLA gate', () => {
    const store = createTerminalPerformanceTraceStore({ limit: 50 });
    const panes = [
      { sessionId: 'pane-1', start: 0, render: 42 },
      { sessionId: 'pane-2', start: 3, render: 70 },
      { sessionId: 'pane-3', start: 6, render: 95 },
    ];

    for (const pane of panes) {
      store.record({ sessionId: pane.sessionId, stage: 'capture-start', at: pane.start });
      store.record({ sessionId: pane.sessionId, stage: 'send-done', at: pane.start + 20, bytes: 900, lineCount: 6 });
      store.record({ sessionId: pane.sessionId, stage: 'client-rx', at: pane.start + 25, bytes: 900 });
      store.record({ sessionId: pane.sessionId, stage: 'buffer-apply-done', at: pane.start + 32 });
      store.record({ sessionId: pane.sessionId, stage: 'render-commit', at: pane.render });
    }

    const summary = summarizeTerminalPerformanceTrace(store.snapshot());

    expect(summary.sessions).toHaveLength(3);
    expect(summary.p95CaptureToRenderMs).toBe(89);
    expect(summary.p95CaptureToRenderMs).toBeLessThan(120);
  });
});
