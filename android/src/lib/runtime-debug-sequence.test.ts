import { describe, expect, it } from 'vitest';
import { detectRuntimeSequenceAnomalies, parseRuntimeSequenceEntries } from './runtime-debug-sequence';

describe('runtime debug sequence analyzer', () => {
  it('flags when a head/request reports stale local truth after the sparse buffer applied newer progress', () => {
    const events = parseRuntimeSequenceEntries([
      {
        seq: 1,
        ts: '2026-04-27T00:00:00.000Z',
        scope: 'session.buffer.applied',
        payload: JSON.stringify({
          sessionId: 's1',
          previousRevision: 21,
          previousEndIndex: 57782,
          nextRevision: 45,
          nextEndIndex: 57788,
        }),
      },
      {
        seq: 2,
        ts: '2026-04-27T00:00:00.010Z',
        scope: 'session.buffer.head',
        payload: JSON.stringify({
          sessionId: 's1',
          localRevision: 22,
          localEndIndex: 57783,
        }),
      },
    ]);
    const anomalies = detectRuntimeSequenceAnomalies(events);

    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies.some((item) => (
      item.kind === 'local-truth-stalled-after-buffer-sync'
      && item.scope === 'session.buffer.head'
      && item.previousAppliedRevision === 45
      && item.previousAppliedEndIndex === 57788
      && item.observedLocalRevision === 22
      && item.observedLocalEndIndex === 57783
    ))).toBe(true);
    expect(anomalies[0]).toMatchObject({
      kind: 'local-truth-stalled-after-buffer-sync',
      scope: expect.any(String),
    });
  });

  it('does not report a false anomaly when local truth matches the latest applied buffer progress', () => {
    const events = parseRuntimeSequenceEntries([
      {
        seq: 1,
        ts: '2026-04-27T00:00:00.000Z',
        scope: 'session.buffer.applied',
        payload: JSON.stringify({
          sessionId: 's1',
          nextRevision: 10,
          nextEndIndex: 120,
        }),
      },
      {
        seq: 2,
        ts: '2026-04-27T00:00:00.010Z',
        scope: 'session.buffer.head',
        payload: JSON.stringify({
          sessionId: 's1',
          localRevision: 10,
          localEndIndex: 120,
        }),
      },
      {
        seq: 3,
        ts: '2026-04-27T00:00:00.020Z',
        scope: 'session.buffer.request',
        payload: JSON.stringify({
          sessionId: 's1',
          payload: {
            knownRevision: 10,
            localEndIndex: 120,
            requestStartIndex: 120,
            requestEndIndex: 121,
          },
        }),
      },
    ]);

    expect(detectRuntimeSequenceAnomalies(events)).toEqual([]);
  });

  it('treats wire buffer-sync-before-apply as a benign startup ordering once the local apply follows', () => {
    const events = parseRuntimeSequenceEntries([
      {
        seq: 10,
        ts: '2026-04-27T00:00:00.000Z',
        scope: 'session.ws.connect.buffer-sync',
        payload: JSON.stringify({
          sessionId: 's1',
          payload: {
            revision: 1,
            endIndex: 778,
          },
        }),
      },
      {
        seq: 11,
        ts: '2026-04-27T00:00:00.010Z',
        scope: 'session.buffer.head',
        payload: JSON.stringify({
          sessionId: 's1',
          localRevision: 0,
          localEndIndex: 0,
        }),
      },
      {
        seq: 12,
        ts: '2026-04-27T00:00:00.020Z',
        scope: 'session.buffer.request',
        payload: JSON.stringify({
          sessionId: 's1',
          payload: {
            knownRevision: 0,
            localEndIndex: 0,
          },
        }),
      },
      {
        seq: 13,
        ts: '2026-04-27T00:00:00.060Z',
        scope: 'session.buffer.applied',
        payload: JSON.stringify({
          sessionId: 's1',
          nextRevision: 2,
          nextEndIndex: 1013,
        }),
      },
      {
        seq: 14,
        ts: '2026-04-27T00:00:00.070Z',
        scope: 'session.buffer.head',
        payload: JSON.stringify({
          sessionId: 's1',
          localRevision: 2,
          localEndIndex: 1013,
        }),
      },
    ]);

    expect(detectRuntimeSequenceAnomalies(events)).toEqual([]);
  });

  it('keeps flagging when a head/request stays stale after local apply progressed', () => {
    const events = parseRuntimeSequenceEntries([
      {
        seq: 20,
        ts: '2026-04-27T00:00:00.000Z',
        scope: 'session.buffer.applied',
        payload: JSON.stringify({
          sessionId: 's1',
          nextRevision: 2,
          nextEndIndex: 1013,
        }),
      },
      {
        seq: 21,
        ts: '2026-04-27T00:00:00.010Z',
        scope: 'session.buffer.head',
        payload: JSON.stringify({
          sessionId: 's1',
          localRevision: 0,
          localEndIndex: 0,
        }),
      },
    ]);

    const anomalies = detectRuntimeSequenceAnomalies(events);
    expect(anomalies).toMatchObject([{
      kind: 'local-truth-stalled-after-buffer-sync',
      seq: 21,
      scope: 'session.buffer.head',
      previousAppliedRevision: 2,
      previousAppliedEndIndex: 1013,
      observedLocalRevision: 0,
      observedLocalEndIndex: 0,
    }]);
  });
});
