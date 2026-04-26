import { describe, expect, it } from 'vitest';
import {
  closeMirrorSubscribers,
  detachMirrorSubscriber,
  type MirrorLifecycleSessionLike,
} from './mirror-lifecycle';

function buildSession(id: string, mirrorKey = 'fin'): MirrorLifecycleSessionLike {
  return {
    id,
    state: 'connected',
    mirrorKey,
  };
}

describe('mirror lifecycle truth', () => {
  it('keeps mirror truth alive even when the last subscriber detaches', () => {
    const result = detachMirrorSubscriber(['client-1'], 'client-1');

    expect([...result.nextSubscribers]).toEqual([]);
    expect(result.remainingSubscribers).toBe(0);
    expect(result.shouldReconcileGeometry).toBe(false);
    expect(result.keepMirrorAlive).toBe(true);
  });

  it('closes and deletes subscriber sessions from daemon session truth', () => {
    const session1 = buildSession('client-1');
    const session2 = buildSession('client-2');
    const sessions = new Map<string, MirrorLifecycleSessionLike>([
      [session1.id, session1],
      [session2.id, session2],
    ]);

    const closed = closeMirrorSubscribers(sessions, ['client-1', 'missing', 'client-2']);

    expect(closed).toEqual(['client-1', 'client-2']);
    expect(sessions.size).toBe(0);
    expect(session1.state).toBe('closed');
    expect(session1.mirrorKey).toBeNull();
    expect(session2.state).toBe('closed');
    expect(session2.mirrorKey).toBeNull();
  });
});
