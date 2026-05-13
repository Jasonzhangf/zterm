import type {
  BufferSyncRequestPayload,
  TerminalBufferPayload,
} from '../lib/types';
import {
  buildBufferSyncRepairSignature,
  doesBufferSyncSatisfyPullState as sharedSatisfiesPull,
  doesPullStateCoverRequest as sharedCoversRequest,
  doesPullStateMatchExactSnapshot as sharedMatchExact,
  type PullStateSnapshot,
  type BufferSyncPayloadSnapshot,
  type BufferSyncRequestSnapshot,
} from '@zterm/shared/terminal/pull-state-planner';

export type SessionPullPurpose = 'tail-refresh' | 'reading-repair';

export interface SessionPullState {
  purpose: SessionPullPurpose;
  startedAt: number;
  targetHeadRevision: number;
  targetStartIndex: number;
  targetEndIndex: number;
  requestKnownRevision: number;
  requestLocalStartIndex: number;
  requestLocalEndIndex: number;
  repairSignature?: string;
}

export type SessionPullStates = Partial<Record<SessionPullPurpose, SessionPullState>>;

function doesBufferSyncSatisfyPullState(
  pullState: SessionPullState,
  payload: TerminalBufferPayload,
): boolean {
  const snap: PullStateSnapshot = {
    purpose: pullState.purpose,
    startedAt: pullState.startedAt,
    targetHeadRevision: pullState.targetHeadRevision,
    targetStartIndex: pullState.targetStartIndex,
    targetEndIndex: pullState.targetEndIndex,
    requestKnownRevision: pullState.requestKnownRevision,
    requestLocalStartIndex: pullState.requestLocalStartIndex,
    requestLocalEndIndex: pullState.requestLocalEndIndex,
    repairSignature: pullState.repairSignature || '',
  };
  const payloadSnap: BufferSyncPayloadSnapshot = {
    revision: Number(payload.revision ?? 0),
    startIndex: Number(payload.startIndex ?? 0),
    endIndex: Number(payload.endIndex ?? 0),
    lineCount: Number(payload.lines?.length ?? 0),
  };
  return sharedSatisfiesPull(snap, payloadSnap);
}

export function hasActiveSessionPullState(pullStates?: SessionPullStates | null) {
  return Boolean(pullStates?.['tail-refresh'] || pullStates?.['reading-repair']);
}

export function getPrimarySessionPullState(pullStates?: SessionPullStates | null) {
  return pullStates?.['reading-repair'] || pullStates?.['tail-refresh'] || null;
}

export function settleSessionPullStatesWithBufferSync(
  pullStates: SessionPullStates | null | undefined,
  payload: TerminalBufferPayload,
) {
  if (!pullStates || !hasActiveSessionPullState(pullStates)) {
    return null;
  }

  const activePulls = Object.values(pullStates)
    .filter((item): item is SessionPullState => Boolean(item))
    .sort((left, right) => left.startedAt - right.startedAt);

  if (activePulls.length === 0) {
    return null;
  }

  if ((payload.lines?.length || 0) === 0) {
    return clearSessionPullStateEntry(pullStates, activePulls[0]!.purpose);
  }

  let next: SessionPullStates | null = pullStates;
  for (const pullState of activePulls) {
    if (!doesBufferSyncSatisfyPullState(pullState, payload)) {
      continue;
    }
    next = clearSessionPullStateEntry(next, pullState.purpose);
  }
  return next;
}

export function doesSessionPullStateCoverRequest(
  pullState: SessionPullState,
  payload: BufferSyncRequestPayload,
): boolean {
  const snap: PullStateSnapshot = {
    purpose: pullState.purpose,
    startedAt: pullState.startedAt,
    targetHeadRevision: pullState.targetHeadRevision,
    targetStartIndex: pullState.targetStartIndex,
    targetEndIndex: pullState.targetEndIndex,
    requestKnownRevision: pullState.requestKnownRevision,
    requestLocalStartIndex: pullState.requestLocalStartIndex,
    requestLocalEndIndex: pullState.requestLocalEndIndex,
    repairSignature: pullState.repairSignature || '',
  };
  const req: BufferSyncRequestSnapshot = {
    knownRevision: Number(payload.knownRevision ?? 0),
    localStartIndex: Number(payload.localStartIndex ?? 0),
    localEndIndex: Number(payload.localEndIndex ?? 0),
    requestStartIndex: Number(payload.requestStartIndex ?? 0),
    requestEndIndex: Number(payload.requestEndIndex ?? 0),
    repairSignature: buildBufferSyncRepairSignature(payload.missingRanges),
  };
  return sharedCoversRequest(snap, req);
}

export function doesSessionPullStateMatchExactLocalSnapshot(
  pullState: SessionPullState,
  payload: BufferSyncRequestPayload,
  targetHeadRevision?: number | null,
): boolean {
  const snap: PullStateSnapshot = {
    purpose: pullState.purpose,
    startedAt: pullState.startedAt,
    targetHeadRevision: pullState.targetHeadRevision,
    targetStartIndex: pullState.targetStartIndex,
    targetEndIndex: pullState.targetEndIndex,
    requestKnownRevision: pullState.requestKnownRevision,
    requestLocalStartIndex: pullState.requestLocalStartIndex,
    requestLocalEndIndex: pullState.requestLocalEndIndex,
    repairSignature: pullState.repairSignature || '',
  };
  const req: BufferSyncRequestSnapshot = {
    knownRevision: Number(payload.knownRevision ?? 0),
    localStartIndex: Number(payload.localStartIndex ?? 0),
    localEndIndex: Number(payload.localEndIndex ?? 0),
    requestStartIndex: Number(payload.requestStartIndex ?? 0),
    requestEndIndex: Number(payload.requestEndIndex ?? 0),
    repairSignature: buildBufferSyncRepairSignature(payload.missingRanges),
  };
  return sharedMatchExact(snap, req, targetHeadRevision);
}

export function clearSessionPullStateEntry(
  pullStates: SessionPullStates | null | undefined,
  purpose: SessionPullPurpose,
) {
  if (!pullStates || !pullStates[purpose]) {
    return pullStates || null;
  }
  const next = { ...pullStates };
  delete next[purpose];
  return hasActiveSessionPullState(next) ? next : null;
}
