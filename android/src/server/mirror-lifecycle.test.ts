import { describe, expect, it } from 'vitest';
import {
  releaseMirrorSubscribers,
  detachMirrorSubscriber,
  type MirrorLifecycleSessionLike,
} from './mirror-lifecycle';

function buildSession(id: string, mirrorKey = 'fin'): MirrorLifecycleSessionLike {
  return {
    id,
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

  it('releases subscriber sessions from mirror truth without deleting bound sessions', () => {
    const session1 = buildSession('client-1');
    const session2 = buildSession('client-2');
    const sessions = new Map<string, MirrorLifecycleSessionLike>([
      [session1.id, session1],
      [session2.id, session2],
    ]);

    const released = releaseMirrorSubscribers(sessions, ['client-1', 'missing', 'client-2']);

    expect(released).toEqual(['client-1', 'client-2']);
    expect(sessions.size).toBe(2);
    expect(session1.mirrorKey).toBeNull();
    expect(session2.mirrorKey).toBeNull();
  });
});
