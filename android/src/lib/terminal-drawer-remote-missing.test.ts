import { describe, expect, it } from 'vitest';
import { resolveSessionRemoteMissing } from './terminal-drawer-remote-missing';
import type { Session, SessionGroupHistory } from './types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id || 'session-1',
    hostId: overrides.hostId || 'host-1',
    connectionName: overrides.connectionName || 'Main Host',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    sessionName: overrides.sessionName || 'logs',
    authToken: overrides.authToken || 'token-a',
    title: overrides.title || 'logs',
    ws: null,
    state: overrides.state || 'connected',
    hasUnread: overrides.hasUnread || false,
    createdAt: overrides.createdAt || 20,
    remoteMissing: overrides.remoteMissing,
    buffer: overrides.buffer || {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
      revision: 1,
    },
  };
}

function makeGroup(overrides: Partial<SessionGroupHistory> = {}): SessionGroupHistory {
  return {
    id: overrides.id || 'group-1',
    name: overrides.name || 'server group',
    bridgeHost: overrides.bridgeHost || '100.64.0.10',
    bridgePort: overrides.bridgePort || 3333,
    daemonHostId: overrides.daemonHostId,
    authToken: overrides.authToken || 'token-a',
    sessionNames: overrides.sessionNames || ['main', 'logs'],
    missingSessionNames: overrides.missingSessionNames || [],
    lastOpenedAt: overrides.lastOpenedAt || 30,
  };
}

describe('resolveSessionRemoteMissing', () => {
  it('marks a session missing when the matching owner group reports it missing', () => {
    const session = makeSession({
      daemonHostId: 'daemon-a',
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      sessionName: 'ghost',
    });
    const groups = [
      makeGroup({
        daemonHostId: 'daemon-a',
        bridgeHost: '100.64.0.10',
        bridgePort: 3333,
        sessionNames: ['main', 'ghost'],
        missingSessionNames: ['ghost'],
      }),
    ];

    expect(resolveSessionRemoteMissing(session, groups)).toBe(true);
  });

  it('does not mark a session missing when a different owner reports the same name missing', () => {
    const session = makeSession({
      daemonHostId: 'daemon-a',
      bridgeHost: '100.64.0.10',
      bridgePort: 3333,
      sessionName: 'ghost',
    });
    const groups = [
      makeGroup({
        daemonHostId: 'daemon-b',
        bridgeHost: '100.64.0.99',
        bridgePort: 3333,
        sessionNames: ['ghost'],
        missingSessionNames: ['ghost'],
      }),
    ];

    expect(resolveSessionRemoteMissing(session, groups)).toBe(false);
  });

  it('preserves explicit remoteMissing truth on the session', () => {
    expect(resolveSessionRemoteMissing(makeSession({ remoteMissing: true }), [])).toBe(true);
  });
});
