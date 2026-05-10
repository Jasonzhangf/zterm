/**
 * close-tab-persistence-block.ts — Close tab persistence domain block
 *
 * Handles open-tab/close operations: removes tab from open list,
 * marks it as closed (tombstone) so it does not reopen on cold start.
 *
 * Emits:
 *   - open-tab/closed when a tab is successfully closed
 *   - operation/failed when attempting to close a non-open tab
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEvent } from '../interaction/event';
import type { BlockHandler, BlockContext } from './harness';

export const OPEN_TABS_PROJECTION_KEY = 'open-tabs' as const;
export const CLOSED_TABS_PROJECTION_KEY = 'closed-tabs-tombstones' as const;

export interface OpenTabsProjection {
  openSessionIds: string[];
}

export interface ClosedTabsProjection {
  closedSessionIds: string[];
}

export function createCloseTabPersistenceBlock(): {
  opTypes: OperationType[];
  handler: BlockHandler;
} {
  const opTypes: OperationType[] = ['open-tab/close'];

  const handler: BlockHandler = (op: TerminalOperation, ctx: BlockContext) => {
    if (op.type !== 'open-tab/close') return [];
    const events: TerminalEvent[] = [];
    const { sessionId } = op.payload;
    const openTabs = ctx.getProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY);
    const closedTabs = ctx.getProjection<ClosedTabsProjection>(CLOSED_TABS_PROJECTION_KEY);

    const isOpen = openTabs?.openSessionIds.includes(sessionId) ?? false;
    if (!isOpen) {
      events.push(createEvent('operation/failed', {
        operationType: 'open-tab/close',
        error: `session ${sessionId} is not in open tabs`,
      }));
      return events;
    }

    // Remove from open list
    ctx.setProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: (openTabs?.openSessionIds ?? []).filter(id => id !== sessionId),
    });

    // Add to tombstone list
    const existing = closedTabs?.closedSessionIds ?? [];
    if (!existing.includes(sessionId)) {
      ctx.setProjection<ClosedTabsProjection>(CLOSED_TABS_PROJECTION_KEY, {
        closedSessionIds: [...existing, sessionId],
      });
    }

    events.push(createEvent('open-tab/closed', { sessionId }));
    return events;
  };

  return { opTypes, handler };
}
