import { describe, it, expect } from 'vitest';
import { createTestHarness } from './harness';
import { createOperation } from '../interaction/operation';
import { createColdStartBlock } from './cold-start-block';
import {
  OPEN_TABS_PROJECTION_KEY,
  CLOSED_TABS_PROJECTION_KEY,
  createCloseTabPersistenceBlock,
} from './close-tab-persistence-block';

describe('cold-start-block', () => {
  it('restores persisted sessions that are not tombstoned', () => {
    const harness = createTestHarness();
    const block = createColdStartBlock();
    harness.registerBlock(block.opTypes, block.handler);

    const opened: string[] = [];
    harness.bus.onType('open-tab/opened', ev => { opened.push(ev.payload.sessionId); });

    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: ['session-a', 'session-b'],
      tombstonedSessionIds: [],
    }));

    expect(opened).toEqual(['session-a', 'session-b']);

    const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
    expect(openTabs?.openSessionIds).toEqual(['session-a', 'session-b']);
  });

  it('filters out tombstoned sessions on cold start', () => {
    const harness = createTestHarness();
    const block = createColdStartBlock();
    harness.registerBlock(block.opTypes, block.handler);

    const opened: string[] = [];
    harness.bus.onType('open-tab/opened', ev => { opened.push(ev.payload.sessionId); });

    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: ['session-a', 'session-b', 'session-c'],
      tombstonedSessionIds: ['session-b'],
    }));

    expect(opened).toEqual(['session-a', 'session-c']);

    const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
    expect(openTabs?.openSessionIds).toEqual(['session-a', 'session-c']);
  });

  it('preserves tombstone list in projection', () => {
    const harness = createTestHarness();
    const block = createColdStartBlock();
    harness.registerBlock(block.opTypes, block.handler);

    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: ['session-a'],
      tombstonedSessionIds: ['session-x', 'session-y'],
    }));

    const tombstones = harness.getProjection(CLOSED_TABS_PROJECTION_KEY);
    expect(tombstones?.closedSessionIds).toEqual(['session-x', 'session-y']);
  });

  it('emits no events when all persisted sessions are tombstoned', () => {
    const harness = createTestHarness();
    const block = createColdStartBlock();
    harness.registerBlock(block.opTypes, block.handler);

    const opened: string[] = [];
    harness.bus.onType('open-tab/opened', ev => { opened.push(ev.payload.sessionId); });

    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: ['session-a', 'session-b'],
      tombstonedSessionIds: ['session-a', 'session-b'],
    }));

    expect(opened).toHaveLength(0);

    const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
    expect(openTabs?.openSessionIds).toEqual([]);
  });

  it('handles empty persisted list gracefully', () => {
    const harness = createTestHarness();
    const block = createColdStartBlock();
    harness.registerBlock(block.opTypes, block.handler);

    const opened: string[] = [];
    harness.bus.onType('open-tab/opened', ev => { opened.push(ev.payload.sessionId); });

    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: [],
      tombstonedSessionIds: ['session-x'],
    }));

    expect(opened).toHaveLength(0);
  });

  it('cold start then close tab: end-to-end scenario', () => {
    const harness = createTestHarness();

    // Cold start with persisted sessions
    const coldBlock = createColdStartBlock();
    harness.registerBlock(coldBlock.opTypes, coldBlock.handler);
    harness.dispatch(createOperation('app/cold-start', {
      persistedSessionIds: ['session-a', 'session-b'],
      tombstonedSessionIds: [],
    }));

    // Now close one tab
    const closeBlock = createCloseTabPersistenceBlock();
    harness.registerBlock(closeBlock.opTypes, closeBlock.handler);
    harness.dispatch(createOperation('open-tab/close', { sessionId: 'session-a' }));

    // Verify projections
    const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
    expect(openTabs?.openSessionIds).toEqual(['session-b']);

    const tombstones = harness.getProjection(CLOSED_TABS_PROJECTION_KEY);
    expect(tombstones?.closedSessionIds).toContain('session-a');

    // Verify events
    const closed = harness.bus.last('open-tab/closed');
    expect(closed).toBeDefined();
    expect(closed!.payload.sessionId).toBe('session-a');
  });
});
