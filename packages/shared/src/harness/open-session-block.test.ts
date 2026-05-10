import { describe, it, expect } from 'vitest';
import { createTestHarness } from './harness';
import { createOperation } from '../interaction/operation';
import { createOpenSessionBlock } from './open-session-block';
import { OPEN_TABS_PROJECTION_KEY } from './close-tab-persistence-block';
import { ACTIVE_SESSION_ID_PROJECTION_KEY, createSwitchTabBlock } from './switch-tab-block';
import { createColdStartBlock } from './cold-start-block';

describe('open-session-block', () => {
  describe('session/create', () => {
    it('creates a session, adds to open tabs, and sets active', () => {
      const harness = createTestHarness();
      const block = createOpenSessionBlock();
      harness.registerBlock(block.opTypes, block.handler);

      harness.dispatch(createOperation('session/create', {
        sessionName: 'test-session',
        host: 'localhost',
        port: 2200,
      }));

      const sessionId = 'session-test-session';

      // Verify events
      const created = harness.bus.last('session/created');
      expect(created).toBeDefined();
      expect(created!.payload.sessionName).toBe('test-session');
      expect(created!.payload.host).toBe('localhost');
      expect(created!.payload.port).toBe(2200);

      const opened = harness.bus.last('open-tab/opened');
      expect(opened).toBeDefined();
      expect(opened!.payload.sessionId).toBe(sessionId);

      const changed = harness.bus.last('open-tab/active-changed');
      expect(changed).toBeDefined();
      expect(changed!.payload.sessionId).toBe(sessionId);

      // Verify projections
      const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
      expect(openTabs?.openSessionIds).toContain(sessionId);

      const active = harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY);
      expect(active?.activeSessionId).toBe(sessionId);
    });

    it('fails when creating a duplicate session', () => {
      const harness = createTestHarness();
      const block = createOpenSessionBlock();
      harness.registerBlock(block.opTypes, block.handler);

      harness.dispatch(createOperation('session/create', {
        sessionName: 'test-session',
        host: 'localhost',
        port: 2200,
      }));

      // Second create with same name
      harness.dispatch(createOperation('session/create', {
        sessionName: 'test-session',
        host: 'otherhost',
        port: 2201,
      }));

      const failed = harness.bus.last('operation/failed');
      expect(failed).toBeDefined();
      expect(failed!.payload.error).toContain('already exists');
    });

    it('adds to existing open tabs list', () => {
      const harness = createTestHarness();
      const block = createOpenSessionBlock();
      harness.registerBlock(block.opTypes, block.handler);

      harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
        openSessionIds: ['existing-session'],
      });

      harness.dispatch(createOperation('session/create', {
        sessionName: 'new-session',
        host: 'localhost',
        port: 2200,
      }));

      const openTabs = harness.getProjection(OPEN_TABS_PROJECTION_KEY);
      expect(openTabs?.openSessionIds).toEqual(['existing-session', 'session-new-session']);
    });
  });

  describe('session/attach', () => {
    it('attaches to an existing session and sets active', () => {
      const harness = createTestHarness();
      const block = createOpenSessionBlock();
      harness.registerBlock(block.opTypes, block.handler);

      harness.dispatch(createOperation('session/attach', { sessionId: 'existing-session-id' }));

      const attached = harness.bus.last('session/attached');
      expect(attached).toBeDefined();
      expect(attached!.payload.sessionId).toBe('existing-session-id');

      const opened = harness.bus.last('open-tab/opened');
      expect(opened).toBeDefined();
      expect(opened!.payload.sessionId).toBe('existing-session-id');

      const changed = harness.bus.last('open-tab/active-changed');
      expect(changed).toBeDefined();
      expect(changed!.payload.sessionId).toBe('existing-session-id');

      const active = harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY);
      expect(active?.activeSessionId).toBe('existing-session-id');
    });

    it('fails when attaching to an already-open session', () => {
      const harness = createTestHarness();
      const block = createOpenSessionBlock();
      harness.registerBlock(block.opTypes, block.handler);

      harness.setProjection(OPEN_TABS_PROJECTION_KEY, {
        openSessionIds: ['already-open'],
      });

      harness.dispatch(createOperation('session/attach', { sessionId: 'already-open' }));

      const failed = harness.bus.last('operation/failed');
      expect(failed).toBeDefined();
      expect(failed!.payload.error).toContain('already open');
    });
  });

  describe('end-to-end: cold-start → open session → switch tab', () => {
    it('full lifecycle scenario', () => {
      const harness = createTestHarness();

      // 1. Cold start with no persisted sessions
        const coldBlock = createColdStartBlock();
      harness.registerBlock(coldBlock.opTypes, coldBlock.handler);
      harness.dispatch(createOperation('app/cold-start', {
        persistedSessionIds: [],
        tombstonedSessionIds: [],
      }));

      // 2. Open a session
      const openBlock = createOpenSessionBlock();
      harness.registerBlock(openBlock.opTypes, openBlock.handler);
      harness.dispatch(createOperation('session/create', {
        sessionName: 'main',
        host: 'localhost',
        port: 2200,
      }));

      expect(harness.getProjection(OPEN_TABS_PROJECTION_KEY)?.openSessionIds)
        .toContain('session-main');
      expect(harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY)?.activeSessionId)
        .toBe('session-main');

      // 3. Create another session
      harness.dispatch(createOperation('session/create', {
        sessionName: 'secondary',
        host: 'otherhost',
        port: 2201,
      }));

      expect(harness.getProjection(OPEN_TABS_PROJECTION_KEY)?.openSessionIds)
        .toEqual(['session-main', 'session-secondary']);
      expect(harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY)?.activeSessionId)
        .toBe('session-secondary');

      // 4. Switch back to first
      const switchBlock = createSwitchTabBlock();
      harness.registerBlock(switchBlock.opTypes, switchBlock.handler);
      harness.dispatch(createOperation('session/switch-active', { sessionId: 'session-main' }));

      expect(harness.getProjection(ACTIVE_SESSION_ID_PROJECTION_KEY)?.activeSessionId)
        .toBe('session-main');
    });
  });
});
