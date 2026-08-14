import { describe, expect, it } from 'vitest';
import {
  filterApkSmokeRuntimeSnapshot,
  resolveApkSmokeDaemonSessionId,
  resolveApkSmokeSnapshotActiveSessionId,
  resolveApkSmokeSnapshotDaemonSessionId,
  resolveApkSmokeSnapshotTmuxSessionName,
  selectFreshApkSmokeSnapshotRecord,
} from './android-apk-smoke-runtime-freshness';

const snapshot = {
  clientDebugSnapshots: [
    {
      sessionId: 'stale-session',
      updatedAt: '2026-05-14T02:46:33.379Z',
      snapshot: {
        sources: {
          'app-shell': { page: 'terminal', activeRuntimeSessionId: 'stale-session' },
          'terminal-page': { activeSessionId: 'stale-session', activeSessionState: 'connected' },
        },
      },
    },
    {
      sessionId: 'fresh-transport',
      tmuxSessionName: 'fin',
      requestOrigin: 'http://100.66.1.82:3333',
      updatedAt: '2026-05-14T03:21:40.000Z',
      snapshot: {
        sources: {
          'app-shell': { page: 'terminal', activeRuntimeSessionId: 'fresh-app-session' },
          'terminal-page': { activeSessionId: 'fresh-app-session', activeSessionState: 'connected' },
        },
      },
    },
  ],
  clientSessions: [{ id: 'fresh-transport' }],
};

describe('android apk smoke runtime freshness', () => {
  it('maps the client session to the exact daemon mux subscriber session', () => {
    const daemonSessionId = resolveApkSmokeDaemonSessionId({
      transportSubscribers: [
        {
          id: 'transport-a:channel:other',
          muxChannelId: 'channel:other',
        },
        {
          id: 'transport-b:channel:fresh-app-session',
          muxChannelId: 'channel:fresh-app-session',
        },
      ],
    }, 'fresh-app-session');

    expect(daemonSessionId).toBe('transport-b:channel:fresh-app-session');
  });

  it('does not select an unrelated daemon subscriber when the client channel is absent', () => {
    expect(resolveApkSmokeDaemonSessionId({
      transportSubscribers: [{
        id: 'transport-a:channel:other',
        muxChannelId: 'channel:other',
      }],
    }, 'missing-client-session')).toBeNull();
  });

  it('ignores stale daemon snapshots from older app launches when selecting the current smoke candidate', () => {
    const record = selectFreshApkSmokeSnapshotRecord(snapshot, '2026-05-14T03:00:00.000Z');
    expect(record?.sessionId).toBe('fresh-transport');
    expect(resolveApkSmokeSnapshotActiveSessionId(record)).toBe('fresh-app-session');
    expect(resolveApkSmokeSnapshotDaemonSessionId(record)).toBe('fresh-transport');
    expect(resolveApkSmokeSnapshotTmuxSessionName(record)).toBe('fin');
  });

  it('filters snapshot payload down to records created during the current smoke run', () => {
    const filtered = filterApkSmokeRuntimeSnapshot(snapshot, '2026-05-14T03:00:00.000Z');
    expect(filtered.clientDebugSnapshots).toHaveLength(1);
    expect(filtered.clientDebugSnapshots?.[0]?.sessionId).toBe('fresh-transport');
  });
});
