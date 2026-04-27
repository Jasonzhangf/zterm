import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { detectRuntimeSequenceAnomalies, parseRuntimeSequenceEntries } from './runtime-debug-sequence';

describe('runtime debug sequence analyzer', () => {
  it('flags when later head/request entries still report stale local truth after a newer buffer-sync was observed', () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'evidence', 'runtime-audit', '2026-04-26', 'logs-after-apk.json'), 'utf8'),
    ) as { entries: Array<{ seq?: number; ts?: string; scope?: string; payload?: string | null }> };

    const events = parseRuntimeSequenceEntries(raw.entries);
    const anomalies = detectRuntimeSequenceAnomalies(events);

    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies.some((item) => (
      item.kind === 'local-truth-stalled-after-buffer-sync'
      && item.scope === 'session.buffer.head'
      && item.previousBufferSyncRevision === 45
      && item.previousBufferSyncEndIndex === 57788
      && item.observedLocalRevision === 22
      && item.observedLocalEndIndex === 57783
    ))).toBe(true);
    expect(anomalies[0]).toMatchObject({
      kind: 'local-truth-stalled-after-buffer-sync',
      scope: expect.any(String),
    });
  });

  it('does not report a false anomaly when local truth matches the latest observed buffer-sync progress', () => {
    const events = parseRuntimeSequenceEntries([
      {
        seq: 1,
        ts: '2026-04-27T00:00:00.000Z',
        scope: 'session.ws.connect.buffer-sync',
        payload: JSON.stringify({
          sessionId: 's1',
          payload: {
            revision: 10,
            startIndex: 100,
            endIndex: 120,
          },
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
});
