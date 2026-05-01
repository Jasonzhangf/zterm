export interface MirrorLifecycleSessionLike {
  id: string;
  mirrorKey: string | null;
}

export interface MirrorDetachResult {
  nextSubscribers: Set<string>;
  remainingSubscribers: number;
  shouldReconcileGeometry: boolean;
  keepMirrorAlive: boolean;
}

export function detachMirrorSubscriber(
  subscribers: Iterable<string>,
  sessionId: string,
): MirrorDetachResult {
  const nextSubscribers = new Set(subscribers);
  nextSubscribers.delete(sessionId);
  return {
    nextSubscribers,
    remainingSubscribers: nextSubscribers.size,
    shouldReconcileGeometry: nextSubscribers.size > 0,
    keepMirrorAlive: true,
  };
}

export function releaseMirrorSubscribers<T extends MirrorLifecycleSessionLike>(
  sessions: Map<string, T>,
  subscriberIds: Iterable<string>,
) {
  const releasedSessionIds: string[] = [];
  for (const sessionId of subscriberIds) {
    const session = sessions.get(sessionId);
    if (!session) {
      continue;
    }
    session.mirrorKey = null;
    releasedSessionIds.push(sessionId);
  }
  return releasedSessionIds;
}
