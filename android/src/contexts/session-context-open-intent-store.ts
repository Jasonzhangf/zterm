import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';

export type PendingSessionTransportOpenIntentStore = Map<string, PendingSessionTransportOpenIntent>;

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
