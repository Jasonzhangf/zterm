import type {
  BufferSyncRequestPayload,
  TerminalBufferPayload,
} from '../lib/types';

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
}

export type SessionPullStates = Partial<Record<SessionPullPurpose, SessionPullState>>;

function doesBufferSyncSatisfyPullState(
  pullState: SessionPullState,
  payload: TerminalBufferPayload,
) {
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
) {
  return (
    pullState.requestKnownRevision === Math.max(0, Math.floor(payload.knownRevision || 0))
    && pullState.requestLocalStartIndex === Math.max(0, Math.floor(payload.localStartIndex || 0))
    && pullState.requestLocalEndIndex === Math.max(0, Math.floor(payload.localEndIndex || 0))
    && pullState.targetStartIndex <= Math.max(0, Math.floor(payload.requestStartIndex || 0))
    && pullState.targetEndIndex >= Math.max(0, Math.floor(payload.requestEndIndex || 0))
  );
}

export function doesSessionPullStateMatchExactLocalSnapshot(
  pullState: SessionPullState,
  payload: BufferSyncRequestPayload,
  targetHeadRevision?: number | null,
) {
  return (
    pullState.requestKnownRevision === Math.max(0, Math.floor(payload.knownRevision || 0))
    && pullState.requestLocalStartIndex === Math.max(0, Math.floor(payload.localStartIndex || 0))
    && pullState.requestLocalEndIndex === Math.max(0, Math.floor(payload.localEndIndex || 0))
    && pullState.targetStartIndex === Math.max(0, Math.floor(payload.requestStartIndex || 0))
    && pullState.targetEndIndex === Math.max(0, Math.floor(payload.requestEndIndex || 0))
    && (
      targetHeadRevision === undefined
      || targetHeadRevision === null
      || pullState.targetHeadRevision === Math.max(0, Math.floor(targetHeadRevision || 0))
    )
  );
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
