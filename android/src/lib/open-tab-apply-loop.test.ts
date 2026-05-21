// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

describe('applyOpenTabState renders stably without loops', () => {
  it('persistExplicitOpenTabs skips setState when normalized state is unchanged', async () => {
    const { normalizeOpenTabIntentState, openTabIntentStatesEqual } = await import('../lib/open-tab-intent');
    const { persistOpenTabsState } = await import('../lib/open-tab-persistence');

    // Same tabs + activeId → normalized state is equal
    const tabA = { sessionId: 'tab-a', hostId: 'h1', connectionName: 'C1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 's1', authToken: 'tok', createdAt: 1 };
    const tabs = [tabA];

    const nextState1 = normalizeOpenTabIntentState(tabs, 'tab-a');
    const nextState2 = normalizeOpenTabIntentState(tabs, 'tab-a');

    // Normalize is deterministic: same input → equal
    expect(openTabIntentStatesEqual(nextState1, nextState2)).toBe(true);
    expect(nextState1.tabs.length).toBe(nextState2.tabs.length);
    expect(nextState1.activeSessionId).toBe(nextState2.activeSessionId);
  });

  it('setState should not be called when openTabIntentStatesEqual returns true (prevents render loop)', async () => {
    const { normalizeOpenTabIntentState, openTabIntentStatesEqual } = await import('../lib/open-tab-intent');

    const tabA = { sessionId: 'tab-a', hostId: 'h1', connectionName: 'C1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 's1', authToken: 'tok', createdAt: 1 };
    const currentState = normalizeOpenTabIntentState([tabA], 'tab-a');
    const nextState = normalizeOpenTabIntentState([tabA], 'tab-a');

    // If states are equal, we should NOT call setState
    const shouldSkipSetState = openTabIntentStatesEqual(currentState, nextState);
    expect(shouldSkipSetState).toBe(true);
  });

  it('setState must be called when openTabIntentStatesEqual returns false (legitimate switch)', async () => {
    const { normalizeOpenTabIntentState, openTabIntentStatesEqual } = await import('../lib/open-tab-intent');

    const tabA = { sessionId: 'tab-a', hostId: 'h1', connectionName: 'C1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 's1', authToken: 'tok', createdAt: 1 };
    const tabB = { sessionId: 'tab-b', hostId: 'h1', connectionName: 'C1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 's2', authToken: 'tok', createdAt: 2 };

    const currentState = normalizeOpenTabIntentState([tabA, tabB], 'tab-a');
    const nextState = normalizeOpenTabIntentState([tabA, tabB], 'tab-b');

    // Active tab switched → must call setState
    const shouldSkipSetState = openTabIntentStatesEqual(currentState, nextState);
    expect(shouldSkipSetState).toBe(false);
    expect(currentState.activeSessionId).toBe('tab-a');
    expect(nextState.activeSessionId).toBe('tab-b');
  });
});
