import { describe, expect, it } from 'vitest';
import { createRuntimeDebugStore, resolveDebugRouteLimit } from './runtime-debug-store';

describe('runtime debug store', () => {
  it('stores bounded client runtime logs and returns latest-first query results', () => {
    const store = createRuntimeDebugStore({ maxEntries: 3 });
    store.appendBatch(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
      },
      [
        { seq: 1, ts: '2026-04-23T10:00:00.000Z', scope: 'a' },
        { seq: 2, ts: '2026-04-23T10:00:01.000Z', scope: 'b' },
      ],
    );
    store.appendBatch(
      {
        sessionId: 's2',
        tmuxSessionName: 'beta',
      },
      [
        { seq: 3, ts: '2026-04-23T10:00:02.000Z', scope: 'c' },
        { seq: 4, ts: '2026-04-23T10:00:03.000Z', scope: 'd' },
      ],
    );

    const entries = store.listEntries({ limit: 10 });
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.seq)).toEqual([4, 3, 2]);
  });

  it('filters by session / tmux session / scope substring', () => {
    const store = createRuntimeDebugStore();
    store.appendBatch(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
        requestOrigin: 'http://phone-a',
      },
      [
        { seq: 1, ts: '2026-04-23T10:00:00.000Z', scope: 'session.ws.connected' },
        { seq: 2, ts: '2026-04-23T10:00:01.000Z', scope: 'session.buffer.tail-refresh' },
      ],
    );
    store.appendBatch(
      {
        sessionId: 's2',
        tmuxSessionName: 'beta',
        requestOrigin: 'http://phone-b',
      },
      [
        { seq: 1, ts: '2026-04-23T10:00:02.000Z', scope: 'session.ws.connected' },
      ],
    );

    expect(store.listEntries({ sessionId: 's1' }).map((entry) => entry.scope)).toEqual([
      'session.buffer.tail-refresh',
      'session.ws.connected',
    ]);
    expect(store.listEntries({ tmuxSessionName: 'beta' }).map((entry) => entry.sessionId)).toEqual(['s2']);
    expect(store.listEntries({ scopeIncludes: 'tail' }).map((entry) => entry.scope)).toEqual([
      'session.buffer.tail-refresh',
    ]);
  });

  it('builds per-session summary from the latest ingested entry', () => {
    const store = createRuntimeDebugStore();
    store.appendBatch(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
      },
      [
        { seq: 2, ts: '2026-04-23T10:00:01.000Z', scope: 'scope-2' },
        { seq: 3, ts: '2026-04-23T10:00:02.000Z', scope: 'scope-3' },
      ],
    );

    const summary = store.getSummary();
    expect(summary.totalEntries).toBe(2);
    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0]).toMatchObject({
      sessionId: 's1',
      tmuxSessionName: 'alpha',
      entryCount: 2,
      latestSeq: 3,
      latestScope: 'scope-3',
      latestTs: '2026-04-23T10:00:02.000Z',
    });
  });

  it('clamps debug route limit to a safe range', () => {
    expect(resolveDebugRouteLimit(undefined)).toBe(200);
    expect(resolveDebugRouteLimit('0')).toBe(1);
    expect(resolveDebugRouteLimit('1200')).toBe(1000);
    expect(resolveDebugRouteLimit('50')).toBe(50);
  });
});
