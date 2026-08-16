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
    expect(summary.snapshotCount).toBe(0);
  });

  it('stores latest snapshot per session and exposes it in updated-first order', () => {
    const store = createRuntimeDebugStore();
    store.setSnapshot(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
        requestOrigin: 'http://device-a',
      },
      { ime: { inset: 240 } },
    );
    store.setSnapshot(
      {
        sessionId: 's2',
        tmuxSessionName: 'beta',
        requestOrigin: 'http://device-b',
      },
      { ime: { inset: 120 } },
    );

    expect(store.getSnapshot('s1')).toMatchObject({
      sessionId: 's1',
      tmuxSessionName: 'alpha',
      requestOrigin: 'http://device-a',
      snapshot: { ime: { inset: 240 } },
    });
    expect(store.getSnapshot('s1')).toMatchObject({
      schemaVersion: 1,
      generation: 1,
      sequence: 1,
      sensitivity: 'internal',
    });
    expect(store.getSnapshot('s1')?.snapshotId).toContain('daemon.runtime.debug:s1');
    expect(store.listSnapshots().map((item) => item.sessionId).sort()).toEqual(['s1', 's2']);
    expect(store.getSummary().snapshotCount).toBe(2);
  });

  it('versions repeated snapshots for the same session', () => {
    const store = createRuntimeDebugStore();
    store.setSnapshot(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
      },
      { revision: 1 },
    );
    const second = store.getSnapshot('s1');
    store.setSnapshot(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
      },
      { revision: 2 },
    );
    const third = store.getSnapshot('s1');

    expect(second?.sequence).toBe(1);
    expect(third?.sequence).toBe(2);
    expect(second?.snapshotId).not.toBe(third?.snapshotId);
    expect(third?.snapshot).toEqual({ revision: 2 });
  });

  it('reports bounded history drops', () => {
    const store = createRuntimeDebugStore({ maxEntries: 2 });
    store.appendBatch(
      {
        sessionId: 's1',
        tmuxSessionName: 'alpha',
      },
      [
        { seq: 1, ts: '2026-04-23T10:00:00.000Z', scope: 'a' },
        { seq: 2, ts: '2026-04-23T10:00:01.000Z', scope: 'b' },
        { seq: 3, ts: '2026-04-23T10:00:02.000Z', scope: 'c' },
      ],
    );

    expect(store.getSummary().totalEntries).toBe(2);
    expect(store.getSummary().droppedEntries).toBe(1);
    expect(store.getDroppedEntryCount()).toBe(1);
  });

  it('clamps debug route limit to a safe range', () => {
    expect(resolveDebugRouteLimit(undefined)).toBe(200);
    expect(resolveDebugRouteLimit('0')).toBe(1);
    expect(resolveDebugRouteLimit('1200')).toBe(1000);
    expect(resolveDebugRouteLimit('50')).toBe(50);
  });
});
