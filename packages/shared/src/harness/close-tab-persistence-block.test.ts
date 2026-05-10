import { describe, it, expect } from 'vitest';
import { createTestHarness } from './harness';
import { createOperation } from '../interaction/operation';
import {
  createCloseTabPersistenceBlock,
  OPEN_TABS_PROJECTION_KEY,
  CLOSED_TABS_PROJECTION_KEY,
} from './close-tab-persistence-block';

describe('close-tab-persistence-block', () => {
  it('closes an open tab and emits open-tab/closed event', () => {
    const harness = createTestHarness();
    const block = createCloseTabPersistenceBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a', 'session-b'],
    });

    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-a' }));

    const closed = harness.bus.last('open-tab/closed');
    expect(closed).toBeDefined();
    expect(closed!.payload.sessionId).toBe('session-a');

    const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
    expect(openTabs?.openSessionIds).toEqual(['session-b']);
  });

  it('adds closed session to tombstone list', () => {
    const harness = createTestHarness();
    const block = createCloseTabPersistenceBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a'],
    });

    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-a' }));

    const tombstones = harness.getProjection(CLOSED_TABS_PROJECTION_KEY);
    expect(tombstones?.closedSessionIds).toContain('session-a');
  });

  it('fails gracefully when closing a non-open session', () => {
    const harness = createTestHarness();
    const block = createCloseTabPersistenceBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a'],
    });

    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-c' }));

    const failed = harness.bus.last('operation/failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.error).toContain('not in open tabs');

    const closed = harness.bus.last('open-tab/closed');
    expect(closed).toBeUndefined();
  });

  it('does not duplicate tombstones when closing same session twice from open state', () => {
    const harness = createTestHarness();
    const block = createCloseTabPersistenceBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a'],
    });

    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-a' }));

    // session-a is no longer in open tabs, second close should fail
    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-a' }));

    const tombstones = harness.getProjection(CLOSED_TABS_PROJECTION_KEY);
    expect(tombstones?.closedSessionIds.filter(id => id === 'session-a').length).toBe(1);
  });

  it('removes session from open list when closed', () => {
    const harness = createTestHarness();
    const block = createCloseTabPersistenceBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: ['session-a', 'session-b', 'session-c'],
    });

    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-b' }));

    const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
    expect(openTabs?.openSessionIds).toEqual(['session-a', 'session-c']);
  });
});
