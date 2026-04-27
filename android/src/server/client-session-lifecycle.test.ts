import { describe, expect, it, vi } from 'vitest';
import {
  attachClientSessionTransport,
  closeClientSession,
  detachClientSessionTransport,
  shutdownClientSessions,
  type ClientSessionLifecycleState,
} from './client-session-lifecycle';

function createSession(id = 'client-1'): ClientSessionLifecycleState {
  return {
    clientSessionId: id,
    state: 'connected',
    mirrorKey: 'mirror-1',
    transportId: 'transport-1',
  };
}

describe('client session lifecycle truth', () => {
  it('detaches transport without deleting logical client session truth', () => {
    const sessions = new Map<string, ClientSessionLifecycleState>([
      ['client-1', createSession()],
    ]);

    detachClientSessionTransport(sessions, 'client-1');

    expect(sessions.has('client-1')).toBe(true);
    expect(sessions.get('client-1')).toMatchObject({
      clientSessionId: 'client-1',
      transportId: null,
      mirrorKey: 'mirror-1',
    });
  });

  it('rebinds a reconnect transport onto the same logical client session', () => {
    const session = createSession();

    const rebound = attachClientSessionTransport(session, 'transport-2');

    expect(rebound.clientSessionId).toBe('client-1');
    expect(rebound.transportId).toBe('transport-2');
    expect(rebound.replacedTransportId).toBe('transport-1');
  });

  it('only explicit close removes the logical client session from daemon truth', () => {
    const sessions = new Map<string, ClientSessionLifecycleState>([
      ['client-1', createSession()],
    ]);

    closeClientSession(sessions, 'client-1');

    expect(sessions.has('client-1')).toBe(false);
  });

  it('daemon shutdown closes every transport and clears logical client sessions together', () => {
    const closeTransport = vi.fn();
    const sessions = new Map<string, ClientSessionLifecycleState>([
      ['client-1', { ...createSession('client-1'), closeTransport }],
      ['client-2', { ...createSession('client-2'), transportId: null, closeTransport }],
    ]);

    shutdownClientSessions(sessions, 'daemon shutdown');

    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledWith('daemon shutdown');
    expect(sessions.size).toBe(0);
  });
});
