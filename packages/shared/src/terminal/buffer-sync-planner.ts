/**
 * buffer-sync-planner.ts — Pure decision functions for terminal buffer sync planning.
 *
 * These functions evaluate whether to request a tail refresh, catch-up follow tail,
 * or pull visible-range buffer based on local and remote state.
 */

export interface ShouldPullFollowBufferParams {
  localHasWindow: boolean;
  distanceToHead: number;
  cacheLines: number;
  localEndIndex: number;
  desiredEndIndex: number;
  daemonRevision: number;
  localRevision: number;
}

/**
 * Determine if the client should pull the follow buffer (tail refresh).
 *
 * Returns true when any of the following conditions hold:
 * - There is no local window
 * - The distance to head exceeds cache lines
 * - The local end index is less than the desired end index
 * - The same-end revision has advanced (local and remote heads equal, but remote revision newer)
 */
export function shouldPullFollowBuffer(params: ShouldPullFollowBufferParams): boolean {
  const sameEndRevisionAdvanced = params.localHasWindow
    && params.distanceToHead === 0
    && params.daemonRevision > params.localRevision;

  if (
    !params.localHasWindow
    || params.distanceToHead > params.cacheLines
    || params.localEndIndex < params.desiredEndIndex
  ) {
    return true;
  }
  return sameEndRevisionAdvanced;
}

export interface ShouldCatchUpFollowTailAfterBufferApplyParams {
  localHasWindow: boolean;
  distanceToHead: number;
  cacheLines: number;
  localEndIndex: number;
  desiredEndIndex: number;
  daemonRevision: number;
  localRevision: number;
  forceSameEndRefresh?: boolean;
}

/**
 * Determine if the client should catch-up follow tail after applying a buffer update.
 *
 * Returns true when:
 * - No local window exists
 * - Distance to head exceeds cache lines
 * - Local end index is less than desired end index
 * - Same-end revision has advanced
 * - Force same-end refresh is requested and daemon revision is newer
 */
export function shouldCatchUpFollowTailAfterBufferApply(params: ShouldCatchUpFollowTailAfterBufferApplyParams): boolean {
  const sameEndRevisionAdvanced = params.localHasWindow
    && params.distanceToHead === 0
    && params.daemonRevision > params.localRevision;

  return (
    !params.localHasWindow
    || params.distanceToHead > params.cacheLines
    || params.localEndIndex < params.desiredEndIndex
    || sameEndRevisionAdvanced
    || (Boolean(params.forceSameEndRefresh) && params.daemonRevision > params.localRevision)
  );
}
