/**
 * open-session-block.ts — Open session domain block
 *
 * Handles session/create and session/attach operations:
 * - session/create: creates a new session, adds to open tabs, sets active
 * - session/attach: attaches to an existing session (by sessionId), adds to open tabs
 *
 * Emits:
 *   - session/created on successful creation
 *   - open-tab/opened for the new tab
 *   - open-tab/active-changed when this becomes the active tab
 *   - operation/failed on error (e.g. duplicate session, missing sessionId)
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEvent } from '../interaction/event';
import type { BlockHandler, BlockContext } from './harness';
import {
  OPEN_TABS_PROJECTION_KEY,
  type OpenTabsProjection,
} from './close-tab-persistence-block';
import {
  ACTIVE_SESSION_ID_PROJECTION_KEY,
  type ActiveSessionProjection,
} from './switch-tab-block';

export function createOpenSessionBlock(): {
  opTypes: OperationType[];
  handler: BlockHandler;
} {
  const opTypes: OperationType[] = ['session/create', 'session/attach'];

  const handler: BlockHandler = (op: TerminalOperation, ctx: BlockContext) => {
    const events: TerminalEvent[] = [];

    if (op.type === 'session/create') {
      const { sessionName, host, port } = op.payload;
      const sessionId = `session-${sessionName}`;

      const openTabs = ctx.getProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY);
      if (openTabs?.openSessionIds.includes(sessionId)) {
        events.push(createEvent('operation/failed', {
          operationType: 'session/create',
          error: `session ${sessionId} already exists in open tabs`,
        }));
        return events;
      }

      // Add to open tabs
      ctx.setProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY, {
        openSessionIds: [...(openTabs?.openSessionIds ?? []), sessionId],
      });

      // Set as active
      const currentActive = ctx.getProjection<ActiveSessionProjection>(ACTIVE_SESSION_ID_PROJECTION_KEY);
      ctx.setProjection<ActiveSessionProjection>(ACTIVE_SESSION_ID_PROJECTION_KEY, {
        activeSessionId: sessionId,
      });

      events.push(createEvent('session/created', { sessionId, host, port, sessionName }));
      events.push(createEvent('open-tab/opened', { sessionId }));
      events.push(createEvent('open-tab/active-changed', {
        sessionId,
        previousSessionId: currentActive?.activeSessionId ?? undefined,
      }));
    }

    if (op.type === 'session/attach') {
      const { sessionId } = op.payload;

      const openTabs = ctx.getProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY);
      if (openTabs?.openSessionIds.includes(sessionId)) {
        events.push(createEvent('operation/failed', {
          operationType: 'session/attach',
          error: `session ${sessionId} is already open`,
        }));
        return events;
      }

      // Add to open tabs
      ctx.setProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY, {
        openSessionIds: [...(openTabs?.openSessionIds ?? []), sessionId],
      });

      // Set as active
      const currentActive = ctx.getProjection<ActiveSessionProjection>(ACTIVE_SESSION_ID_PROJECTION_KEY);
      ctx.setProjection<ActiveSessionProjection>(ACTIVE_SESSION_ID_PROJECTION_KEY, {
        activeSessionId: sessionId,
      });

      events.push(createEvent('session/attached', { sessionId }));
      events.push(createEvent('open-tab/opened', { sessionId }));
      events.push(createEvent('open-tab/active-changed', {
        sessionId,
        previousSessionId: currentActive?.activeSessionId ?? undefined,
      }));
    }

    return events;
  };

  return { opTypes, handler };
}
