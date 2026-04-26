export interface MirrorLifecycleSessionLike {
  id: string;
  state: 'idle' | 'connecting' | 'connected' | 'error' | 'closed';
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

export function closeMirrorSubscribers<T extends MirrorLifecycleSessionLike>(
  sessions: Map<string, T>,
  subscriberIds: Iterable<string>,
) {
  const closedSessionIds: string[] = [];
  for (const sessionId of subscriberIds) {
    const session = sessions.get(sessionId);
    if (!session) {
      continue;
    }
    session.mirrorKey = null;
    session.state = 'closed';
    sessions.delete(sessionId);
    closedSessionIds.push(sessionId);
  }
  return closedSessionIds;
}
