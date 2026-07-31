import { describe, expect, it } from 'vitest';
import { classifySessionActivities, SESSION_IDLE_STOPPED_THRESHOLD_MS } from './terminal-session-activity-runtime';
import type { SessionMirror } from './terminal-runtime-types';

function makeMirror(sessionName: string, lastLiveActivityAt: number): SessionMirror {
  const base: SessionMirror = {
    key: sessionName,
    sessionName,
    scratchBridge: null,
    lifecycle: 'ready',
    cols: 80,
    rows: 24,
    consecutiveFailures: 0,
    cursorKeysApp: false,
    revision: 0,
    lastScrollbackCount: 0,
    bufferStartIndex: 0,
    bufferLines: [],
    cursor: null,
    lastFlushStartedAt: 0,
    lastFlushCompletedAt: 0,
    lastLiveActivityAt,
    lastHeadBroadcastAt: 0,
    flushInFlight: false,
    flushPromise: null,
    liveSyncTimer: null,
    subscribers: new Set(),
  };
  return base;
}

describe('classifySessionActivities', () => {
  const now = 100_000;
  const threshold = SESSION_IDLE_STOPPED_THRESHOLD_MS;

  it('returns empty array for empty map', () => {
    const result = classifySessionActivities(new Map(), now, threshold);
    expect(result).toEqual([]);
  });

  it('filters out mirrors with lastLiveActivityAt === 0 (uninitialized)', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['s1', makeMirror('s1', 0)],
    ]);
    const result = classifySessionActivities(mirrors, now, threshold);
    expect(result).toEqual([]);
  });

  it('reports stopped: false for recently active session', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['active', makeMirror('active', now - 1_000)],
    ]);
    const result = classifySessionActivities(mirrors, now, threshold);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'active', stopped: false });
  });

  it('reports stopped: true when idle exceeds threshold', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['stale', makeMirror('stale', now - threshold - 1)],
    ]);
    const result = classifySessionActivities(mirrors, now, threshold);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'stale', stopped: true });
  });

  it('reports stopped: true when idle exactly at threshold (boundary)', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['boundary', makeMirror('boundary', now - threshold)],
    ]);
    const result = classifySessionActivities(mirrors, now, threshold);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'boundary', stopped: true });
  });

  it('handles stopped->active resume', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['resume', makeMirror('resume', now - 1_000)],
    ]);
    const staleNow = now + threshold + 5_000;
    const staleResult = classifySessionActivities(mirrors, staleNow, threshold);
    expect(staleResult[0]).toMatchObject({ name: 'resume', stopped: true });
    mirrors.get('resume')!.lastLiveActivityAt = staleNow - 500;
    const resumedResult = classifySessionActivities(mirrors, staleNow, threshold);
    expect(resumedResult[0]).toMatchObject({ name: 'resume', stopped: false });
  });

  it('handles multiple mirrors independently', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['s1', makeMirror('s1', now - 1_000)],
      ['s2', makeMirror('s2', 0)],
      ['s3', makeMirror('s3', now - threshold - 1)],
      ['s4', makeMirror('s4', now - 500)],
    ]);
    const result = classifySessionActivities(mirrors, now, threshold);
    expect(result).toHaveLength(3);
    expect(result.map((r) => ({ name: r.name, stopped: r.stopped }))).toEqual([
      { name: 's1', stopped: false },
      { name: 's3', stopped: true },
      { name: 's4', stopped: false },
    ]);
  });

  it('sorts sessions alphabetically by name', () => {
    const mirrors = new Map<string, SessionMirror>([
      ['z', makeMirror('z', now - 1_000)],
      ['a', makeMirror('a', now - 1_000)],
    ]);
    const result = classifySessionActivities(mirrors, now, threshold);
    expect(result.map((r) => r.name)).toEqual(['a', 'z']);
  });
});
