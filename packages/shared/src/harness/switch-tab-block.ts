/**
 * switch-tab-block.ts — Switch active tab domain block
 *
 * Handles session/switch-active: changes which session is the active tab.
 *
 * Projection: 'active-session-id' tracks the current active session.
 *
 * Emits:
 *   - open-tab/active-changed on successful switch
 *   - operation/failed when switching to a non-open session
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEvent } from '../interaction/event';
import type { BlockHandler, BlockContext } from './harness';
import { OPEN_TABS_PROJECTION_KEY, type OpenTabsProjection } from './close-tab-persistence-block';

export const ACTIVE_SESSION_ID_PROJECTION_KEY = 'active-session-id' as const;

export interface ActiveSessionProjection {
  activeSessionId: string | null;
}

export function createSwitchTabBlock(): {
  opTypes: OperationType[];
  handler: BlockHandler;
} {
  const opTypes: OperationType[] = ['session/switch-active'];

  const handler: BlockHandler = (op: TerminalOperation, ctx: BlockContext) => {
    if (op.type !== 'session/switch-active') return [];
    const events: TerminalEvent[] = [];
    const { sessionId } = op.payload;

    const openTabs = ctx.getProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY);
    const isOpen = openTabs?.openSessionIds.includes(sessionId) ?? false;
    if (!isOpen) {
      events.push(createEvent('operation/failed', {
        operationType: 'session/switch-active',
        error: `session ${sessionId} is not in open tabs`,
      }));
      return events;
    }

    const current = ctx.getProjection<ActiveSessionProjection>(ACTIVE_SESSION_ID_PROJECTION_KEY);
    const previousSessionId = current?.activeSessionId ?? undefined;

    ctx.setProjection<ActiveSessionProjection>(ACTIVE_SESSION_ID_PROJECTION_KEY, {
      activeSessionId: sessionId,
    });

    events.push(createEvent('open-tab/active-changed', {
      sessionId,
      previousSessionId,
    }));
    return events;
  };

  return { opTypes, handler };
}
