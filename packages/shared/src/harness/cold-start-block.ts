/**
 * cold-start-block.ts — Cold start domain block
 *
 * Handles app/cold-start operation: restores open tabs from persistence,
 * filtering out tombstoned (previously closed) sessions.
 *
 * Emits:
 *   - open-tab/opened for each session that passes the tombstone filter
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEvent } from '../interaction/event';
import type { BlockHandler, BlockContext } from './harness';
import {
  OPEN_TABS_PROJECTION_KEY,
  CLOSED_TABS_PROJECTION_KEY,
  type OpenTabsProjection,
  type ClosedTabsProjection,
} from './close-tab-persistence-block';

export function createColdStartBlock(): {
  opTypes: OperationType[];
  handler: BlockHandler;
} {
  const opTypes: OperationType[] = ['app/cold-start'];

  const handler: BlockHandler = (op: TerminalOperation, ctx: BlockContext) => {
    if (op.type !== 'app/cold-start') return [];
    const events: TerminalEvent[] = [];
    const { persistedSessionIds, tombstonedSessionIds } = op.payload;

    // Filter out tombstoned sessions
    const validSessionIds = persistedSessionIds.filter(
      id => !tombstonedSessionIds.includes(id)
    );

    // Set open-tabs projection
    ctx.setProjection<OpenTabsProjection>(OPEN_TABS_PROJECTION_KEY, {
      openSessionIds: validSessionIds,
    });

    // Set tombstones projection (preserve any that were passed in)
    ctx.setProjection<ClosedTabsProjection>(CLOSED_TABS_PROJECTION_KEY, {
      closedSessionIds: [...tombstonedSessionIds],
    });

    // Emit opened event for each restored session
    for (const sessionId of validSessionIds) {
      events.push(createEvent('open-tab/opened', { sessionId }));
    }

    return events;
  };

  return { opTypes, handler };
}
