import { describe, expect, it } from 'vitest';
import { evaluateApkSmokeTerminalRuntime, type ApkSmokeRuntimeLogs, type ApkSmokeRuntimeSnapshot } from './android-apk-smoke-runtime-verifier';

function buildHealthySnapshot(): ApkSmokeRuntimeSnapshot {
  return {
    clientDebugSnapshots: [
      {
        sessionId: 'session-1',
        updatedAt: '2026-05-12T10:00:00.000Z',
        snapshot: {
          sources: {
            'app-shell': {
              page: 'terminal',
              activeRuntimeSessionId: 'session-1',
              terminalActiveSessionId: 'session-1',
            },
            'terminal-page': {
              activeSessionId: 'session-1',
              activeSessionState: 'connected',
              sessionCount: 1,
              splitVisible: false,
            },
          },
        },
      },
    ],
    clientSessions: [
      {
        id: 'session-1',
        sessionName: 'zterm',
        connectedSent: true,
        requestOrigin: 'http://100.66.1.82:3333',
      },
    ],
  };
}

function buildHealthyLogs(): ApkSmokeRuntimeLogs {
  return {
    entries: [
      {
        seq: 4,
        ts: '2026-05-12T10:00:02.000Z',
        scope: 'session.render-gate.flush.inspect',
        payload: JSON.stringify({
          sessionId: 'session-1',
          projected: {
            revision: 10,
            endIndex: 120,
          },
        }),
      },
      {
        seq: 3,
        ts: '2026-05-12T10:00:01.500Z',
        scope: 'session.buffer.applied',
        payload: JSON.stringify({
          sessionId: 'session-1',
          revision: 10,
          endIndex: 120,
        }),
      },
      {
        seq: 2,
        ts: '2026-05-12T10:00:01.000Z',
        scope: 'session.buffer.head',
        payload: JSON.stringify({
          sessionId: 'session-1',
          localRevision: 10,
          localEndIndex: 120,
          latestRevision: 10,
          latestEndIndex: 120,
        }),
      },
      {
        seq: 1,
        ts: '2026-05-12T10:00:00.500Z',
        scope: 'session.ws.connect.buffer-sync',
        payload: JSON.stringify({
          sessionId: 'session-1',
          payload: {
            revision: 10,
            startIndex: 100,
            endIndex: 120,
            lineCount: 20,
          },
        }),
      },
    ],
  };
}

describe('android apk smoke runtime verifier', () => {
  it('fails when app launched but no active client runtime snapshot reached daemon', () => {
    const verdict = evaluateApkSmokeTerminalRuntime(
      {
        clientDebugSnapshots: [],
        clientSessions: [{ id: 'session-1' }],
      },
      { entries: [] },
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failedChecks).toContain('clientSnapshotPresent');
    expect(verdict.failedChecks).toContain('activeSessionResolved');
  });

  it('fails when active session exists but no buffer-sync/apply progression was observed', () => {
    const verdict = evaluateApkSmokeTerminalRuntime(
      buildHealthySnapshot(),
      {
        entries: [
          {
            seq: 1,
            ts: '2026-05-12T10:00:01.000Z',
            scope: 'session.buffer.head',
            payload: JSON.stringify({
              sessionId: 'session-1',
              localRevision: 0,
              localEndIndex: 0,
              latestRevision: 0,
              latestEndIndex: 0,
            }),
          },
        ],
      },
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failedChecks).toContain('bufferSyncObserved');
    expect(verdict.failedChecks).toContain('bufferAppliedOrRenderedObserved');
  });

  it('fails when runtime logs prove local truth stalled after a newer buffer-sync', () => {
    const verdict = evaluateApkSmokeTerminalRuntime(
      buildHealthySnapshot(),
      {
        entries: [
          {
            seq: 2,
            ts: '2026-05-12T10:00:01.000Z',
            scope: 'session.buffer.head',
            payload: JSON.stringify({
              sessionId: 'session-1',
              localRevision: 8,
              localEndIndex: 118,
              latestRevision: 10,
              latestEndIndex: 120,
            }),
          },
          {
            seq: 1,
            ts: '2026-05-12T10:00:00.500Z',
            scope: 'session.ws.connect.buffer-sync',
            payload: JSON.stringify({
              sessionId: 'session-1',
              payload: {
                revision: 10,
                startIndex: 100,
                endIndex: 120,
                lineCount: 20,
              },
            }),
          },
        ],
      },
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.failedChecks).toContain('localTruthHealthy');
  });

  it('passes only when terminal active session, buffer sync, apply, and render progression are all present', () => {
    const verdict = evaluateApkSmokeTerminalRuntime(
      buildHealthySnapshot(),
      buildHealthyLogs(),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.activeSessionId).toBe('session-1');
    expect(verdict.failedChecks).toEqual([]);
    expect(verdict.checks).toMatchObject({
      clientSnapshotPresent: true,
      terminalPageActive: true,
      activeSessionResolved: true,
      activeSessionKnownToDaemon: true,
      bufferHeadObserved: true,
      bufferSyncObserved: true,
      bufferAppliedOrRenderedObserved: true,
      localTruthHealthy: true,
    });
  });
});
