import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';

export type PendingSessionTransportOpenIntentStore = Map<string, PendingSessionTransportOpenIntent>;
const DEFAULT_PENDING_OPEN_INTENT_STALE_MS = 5000;

export function getPendingSessionTransportOpenIntent(
  store: PendingSessionTransportOpenIntentStore,
  sessionId: string,
) {
  return store.get(sessionId) || null;
}

export function setPendingSessionTransportOpenIntent(
  store: PendingSessionTransportOpenIntentStore,
  intent: PendingSessionTransportOpenIntent,
) {
  store.set(intent.sessionId, intent);
  return intent;
}

export function deletePendingSessionTransportOpenIntent(
  store: PendingSessionTransportOpenIntentStore,
  sessionId: string,
) {
  return store.delete(sessionId);
}

export function hasPendingSessionTransportOpenIntent(
  store: PendingSessionTransportOpenIntentStore,
  sessionId: string,
) {
  return store.has(sessionId);
}

export function isPendingSessionTransportOpenIntentStale(
  store: PendingSessionTransportOpenIntentStore,
  sessionId: string,
  now = Date.now(),
  staleAfterMs = DEFAULT_PENDING_OPEN_INTENT_STALE_MS,
) {
  const intent = store.get(sessionId) || null;
  if (!intent) {
    return false;
  }
  const createdAt = Number.isFinite(intent.createdAt) ? intent.createdAt : 0;
  if (createdAt <= 0) {
    return false;
  }
  return now - createdAt >= staleAfterMs;
}

export function findPendingSessionTransportOpenIntentByRequestId(
  store: PendingSessionTransportOpenIntentStore,
  openRequestId: string,
) {
  for (const intent of store.values()) {
    if (intent.openRequestId === openRequestId) {
      return intent;
    }
  }
  return null;
}
