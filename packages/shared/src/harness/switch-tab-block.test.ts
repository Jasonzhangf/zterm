import { describe, it, expect } from 'vitest';
import { createTestHarness } from './harness';
import { createOperation } from '../interaction/operation';
import { createSwitchTabBlock, ACTIVE_SESSION_ID_PROJECTION_KEY } from './switch-tab-block';
import { OPEN_TABS_PROJECTION_KEY } from './close-tab-persistence-block';
import { createColdStartBlock } from './cold-start-block';

describe('switch-tab-block', () => {
  it('switches active session and emits active-changed event', () => {
    const harness = createTestHarness();
    const block = createSwitchTabBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a', 'session-b'],
    });
    harness.setProjection(ACTIVE_SESSION_ID_PROJECTION_KEY, {
      activeSessionId: 'session-a',
    });

    harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-b' }));

    const event = harness.bus.last('open-tab/active-changed');
    expect(event).toBeDefined();
    expect(event!.payload.sessionId).toBe('session-b');
    expect(event!.payload.previousSessionId).toBe('session-a');

    const active = harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY);
    expect(active?.activeSessionId).toBe('session-b');
  });

  it('fails when switching to a non-open session', () => {
    const harness = createTestHarness();
    const block = createSwitchTabBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a'],
    });

    harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-c' }));

    const failed = harness.bus.last('operation/failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.error).toContain('not in open tabs');

    const changed = harness.bus.last('open-tab/active-changed');
    expect(changed).toBeUndefined();
  });

  it('handles switch when no previous active session', () => {
    const harness = createTestHarness();
    const block = createSwitchTabBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a'],
    });

    harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-a' }));

    const event = harness.bus.last('open-tab/active-changed');
    expect(event).toBeDefined();
    expect(event!.payload.sessionId).toBe('session-a');
    expect(event!.payload.previousSessionId).toBeUndefined();
  });

  it('updates active session projection on switch', () => {
    const harness = createTestHarness();
    const block = createSwitchTabBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a', 'session-b', 'session-c'],
    });

    harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-a' }));
    expect(harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY)?.activeSessionId).toBe('session-a');

    harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-c' }));
    expect(harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY)?.activeSessionId).toBe('session-c');
  });

  it('cold-start then switch tab: end-to-end scenario', () => {
    const harness = createTestHarness();

    // Simulate cold start
    const coldBlock = createColdStartBlock();
    harness.registerBlock(coldBlock.opTypes, coldBlock.handler);
    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: ['session-a', 'session-b'],
      tombstonedSessionIds: [],
    }));

    // Register switch-tab block
    const block = createSwitchTabBlock();
    harness.registerBlock(block.opTypes, block.handler);

    // Set initial active
    harness.setProjection(ACTIVE_SESSION_ID_PROJECTION_KEY, {
      activeSessionId: 'session-a',
    });

    // Switch
    harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-b' }));

    const event = harness.bus.last('open-tab/active-changed');
    expect(event).toBeDefined();
    expect(event!.payload.sessionId).toBe('session-b');
    expect(event!.payload.previousSessionId).toBe('session-a');

    const active = harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY);
    expect(active?.activeSessionId).toBe('session-b');
  });
});
