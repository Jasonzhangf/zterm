import { describe, expect, it } from 'vitest';
import {
  deletePendingSessionTransportOpenIntent,
  findPendingSessionTransportOpenIntentByRequestId,
  getPendingSessionTransportOpenIntent,
  hasPendingSessionTransportOpenIntent,
  isPendingSessionTransportOpenIntentStale,
  setPendingSessionTransportOpenIntent,
  type PendingSessionTransportOpenIntentStore,
} from './session-context-open-intent-store';
import type { PendingSessionTransportOpenIntent } from './session-sync-helpers';

function createIntent(
  overrides?: Partial<PendingSessionTransportOpenIntent>,
): PendingSessionTransportOpenIntent {
  return {
    sessionId: 'session-1',
    openRequestId: 'session-1:open:1',
    createdAt: 1000,
    host: {
      id: 'host-1',
      name: 'host',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      authToken: 'token',
      sessionName: 'tmux-1',
      authType: 'password',
      tags: [],
      pinned: false,
      createdAt: Date.now(),
    },
    resolvedSessionName: 'tmux-1',
    debugScope: 'connect',
    finalizeFailure: () => undefined,
    onConnected: () => undefined,
    ...overrides,
  };
}

describe('session-context-open-intent-store', () => {
  it('stores and reads pending intent by sessionId through one helper', () => {
    const store: PendingSessionTransportOpenIntentStore = new Map();
    const intent = createIntent();
    setPendingSessionTransportOpenIntent(store, intent);

    expect(hasPendingSessionTransportOpenIntent(store, 'session-1')).toBe(true);
    expect(getPendingSessionTransportOpenIntent(store, 'session-1')).toBe(intent);
  });

  it('finds pending intent by one-shot openRequestId', () => {
    const store: PendingSessionTransportOpenIntentStore = new Map();
    const intent1 = createIntent();
    const intent2 = createIntent({
      sessionId: 'session-2',
      openRequestId: 'session-2:open:9',
    });
    setPendingSessionTransportOpenIntent(store, intent1);
    setPendingSessionTransportOpenIntent(store, intent2);

    expect(findPendingSessionTransportOpenIntentByRequestId(store, 'session-2:open:9')).toBe(intent2);
    expect(findPendingSessionTransportOpenIntentByRequestId(store, 'missing')).toBeNull();
  });

  it('deletes by stable sessionId owner only', () => {
    const store: PendingSessionTransportOpenIntentStore = new Map();
    const intent = createIntent();
    setPendingSessionTransportOpenIntent(store, intent);

    expect(deletePendingSessionTransportOpenIntent(store, 'session-1')).toBe(true);
    expect(hasPendingSessionTransportOpenIntent(store, 'session-1')).toBe(false);
  });

  it('marks a pending intent stale once its age exceeds the threshold', () => {
    const store: PendingSessionTransportOpenIntentStore = new Map();
    setPendingSessionTransportOpenIntent(store, createIntent({ createdAt: 1000 }));

    expect(isPendingSessionTransportOpenIntentStale(store, 'session-1', 5999, 5000)).toBe(false);
    expect(isPendingSessionTransportOpenIntentStale(store, 'session-1', 6000, 5000)).toBe(true);
  });
});
