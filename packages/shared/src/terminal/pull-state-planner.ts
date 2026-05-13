/**
 * pull-state-planner.ts — Pure decision functions for terminal buffer pull state management.
 *
 * These functions evaluate whether a buffer sync request/response satisfies
 * the conditions for settling pull states. All logic is pure: inputs are
 * primitives, no session dependency.
 */

export type PullPurpose = 'tail-refresh' | 'reading-repair';

export interface PullStateSnapshot {
  purpose: PullPurpose;
  startedAt: number;
  targetHeadRevision: number;
  targetStartIndex: number;
  targetEndIndex: number;
  requestKnownRevision: number;
  requestLocalStartIndex: number;
  requestLocalEndIndex: number;
  repairSignature?: string;
}

export interface BufferSyncPayloadSnapshot {
  revision: number;
  startIndex: number;
  endIndex: number;
  lineCount: number;
}

export interface BufferSyncRequestSnapshot {
  knownRevision: number;
  localStartIndex: number;
  localEndIndex: number;
  requestStartIndex: number;
  requestEndIndex: number;
  repairSignature?: string;
}

export function buildBufferSyncRepairSignature(
  missingRanges?: Array<{ startIndex?: number | null; endIndex?: number | null }> | null,
): string {
  if (!Array.isArray(missingRanges) || missingRanges.length === 0) {
    return '';
  }
  return JSON.stringify(missingRanges.map((range) => ({
    startIndex: Math.max(0, Math.floor(range?.startIndex ?? 0)),
    endIndex: Math.max(0, Math.floor(range?.endIndex ?? 0)),
  })));
}

/**
 * Check if a buffer sync payload satisfies a given pull state.
 */
export function doesBufferSyncSatisfyPullState(
  pullState: PullStateSnapshot,
  payload: BufferSyncPayloadSnapshot,
): boolean {
  const payloadRevision = Math.max(0, Math.floor(payload.revision || 0));
  const payloadStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const payloadEndIndex = Math.max(payloadStartIndex, Math.floor(payload.endIndex || 0));
  if (pullState.purpose === 'reading-repair') {
    return (
      payloadRevision >= pullState.requestKnownRevision
      && payloadStartIndex <= pullState.targetStartIndex
      && payloadEndIndex >= pullState.targetEndIndex
    );
  }
  const settlesExistingWindowRefresh = (
    pullState.requestLocalEndIndex >= pullState.targetEndIndex
    && pullState.requestLocalStartIndex <= pullState.targetStartIndex
    && pullState.requestKnownRevision < pullState.targetHeadRevision
    && payloadRevision >= pullState.targetHeadRevision
    && payloadEndIndex >= pullState.targetEndIndex
  );
  return (
    settlesExistingWindowRefresh
    || (
      payloadRevision >= pullState.targetHeadRevision
      && payloadStartIndex <= pullState.targetStartIndex
      && payloadEndIndex >= pullState.targetEndIndex
    )
  );
}

/**
 * Check if a pull state covers the given buffer sync request range.
 */
export function doesPullStateCoverRequest(
  pullState: PullStateSnapshot,
  request: BufferSyncRequestSnapshot,
): boolean {
  const pullRepairSignature = typeof pullState.repairSignature === 'string' ? pullState.repairSignature : '';
  const requestRepairSignature = typeof request.repairSignature === 'string' ? request.repairSignature : '';
  return (
    pullState.requestKnownRevision === Math.max(0, Math.floor(request.knownRevision || 0))
    && pullState.requestLocalStartIndex === Math.max(0, Math.floor(request.localStartIndex || 0))
    && pullState.requestLocalEndIndex === Math.max(0, Math.floor(request.localEndIndex || 0))
    && pullRepairSignature === requestRepairSignature
    && pullState.targetStartIndex <= Math.max(0, Math.floor(request.requestStartIndex || 0))
    && pullState.targetEndIndex >= Math.max(0, Math.floor(request.requestEndIndex || 0))
  );
}

/**
 * Check if a pull state matches the exact local snapshot (including head revision).
 */
export function doesPullStateMatchExactSnapshot(
  pullState: PullStateSnapshot,
  request: BufferSyncRequestSnapshot,
  targetHeadRevision?: number | null,
): boolean {
  const pullRepairSignature = typeof pullState.repairSignature === 'string' ? pullState.repairSignature : '';
  const requestRepairSignature = typeof request.repairSignature === 'string' ? request.repairSignature : '';
  return (
    pullState.requestKnownRevision === Math.max(0, Math.floor(request.knownRevision || 0))
    && pullState.requestLocalStartIndex === Math.max(0, Math.floor(request.localStartIndex || 0))
    && pullState.requestLocalEndIndex === Math.max(0, Math.floor(request.localEndIndex || 0))
    && pullState.targetStartIndex === Math.max(0, Math.floor(request.requestStartIndex || 0))
    && pullState.targetEndIndex === Math.max(0, Math.floor(request.requestEndIndex || 0))
    && pullRepairSignature === requestRepairSignature
    && (
      targetHeadRevision === undefined
      || targetHeadRevision === null
      || pullState.targetHeadRevision === Math.max(0, Math.floor(targetHeadRevision || 0))
    )
  );
}
