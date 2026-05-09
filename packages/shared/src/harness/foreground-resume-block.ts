/**
 * foreground-resume-block.ts — Foreground resume domain block
 *
 * Handles foreground/resume operations using shared pure decision logic.
 * Emits app/foreground-resumed when conditions are met, or operation/failed with skip reason.
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEvent } from '../interaction/event';
import type { BlockHandler, BlockContext } from './harness';
import {
  shouldResumeForeground,
  type ForegroundResumeState,
} from '../terminal/foreground-resume';

export const FOREGROUND_RESUME_PROJECTION_KEY = 'foreground-resume-state' as const;

export interface ForegroundResumeBlockDeps {
  now: () => number;
  debounceMs?: number;
}

export function createForegroundResumeBlock(deps: ForegroundResumeBlockDeps): {
  opTypes: OperationType[];
  handler: BlockHandler;
} {
  const opTypes: OperationType[] = ['foreground/resume'];

  const handler: BlockHandler = (op: TerminalOperation, ctx: BlockContext) => {
    if (op.type !== 'foreground/resume') return [];

    const events: TerminalEvent[] = [];
    const state = ctx.getProjection<ForegroundResumeState>(FOREGROUND_RESUME_PROJECTION_KEY);
    const now = deps.now();

    // In harness, we assume sessions exist and there is an active session
    const hasSessions = true;
    const hasActiveSession = true;

    const decision = shouldResumeForeground(
      now,
      state?.lastResumeAt ?? 0,
      deps.debounceMs ?? 800,
      state?.wasHidden ?? false,
      hasSessions,
      hasActiveSession,
    );

    // Update state
    ctx.setProjection<ForegroundResumeState>(FOREGROUND_RESUME_PROJECTION_KEY, {
      wasHidden: false,
      lastResumeAt: decision.shouldResume ? now : (state?.lastResumeAt ?? 0),
    });

    if (decision.shouldResume) {
      events.push(createEvent('app/foreground-resumed', {}));
    } else {
      events.push(createEvent('operation/failed', {
        operationType: 'foreground/resume',
        error: `skipped: ${decision.skipReason}`,
      }));
    }

    return events;
  };

  return { opTypes, handler };
}

/**
 * Helper to mark the foreground resume state as hidden (called when app goes to background).
 * Uses the harness directly (provided as TestHarness).
 */
export function markForegroundHidden(harness: { setProjection: <T>(key: string, value: T) => void; getProjection: <T>(key: string) => T | undefined }): void {
  const state = harness.getProjection<ForegroundResumeState>(FOREGROUND_RESUME_PROJECTION_KEY);
  harness.setProjection<ForegroundResumeState>(FOREGROUND_RESUME_PROJECTION_KEY, {
    wasHidden: true,
    lastResumeAt: state?.lastResumeAt ?? 0,
  });
}
