import { describe, it, expect } from 'vitest';
import {
  doesBufferSyncSatisfyPullState,
  doesPullStateCoverRequest,
  doesPullStateMatchExactSnapshot,
  type PullStateSnapshot,
  type BufferSyncPayloadSnapshot,
  type BufferSyncRequestSnapshot,
} from './pull-state-planner';

function makeTailPull(overrides?: Partial<PullStateSnapshot>): PullStateSnapshot {
  return {
    purpose: 'tail-refresh',
    startedAt: 1000,
    targetHeadRevision: 10,
    targetStartIndex: 0,
    targetEndIndex: 100,
    requestKnownRevision: 5,
    requestLocalStartIndex: 0,
    requestLocalEndIndex: 50,
    ...overrides,
  };
}

function makeReadingPull(overrides?: Partial<PullStateSnapshot>): PullStateSnapshot {
  return {
    purpose: 'reading-repair',
    startedAt: 1000,
    targetHeadRevision: 10,
    targetStartIndex: 20,
    targetEndIndex: 80,
    requestKnownRevision: 5,
    requestLocalStartIndex: 0,
    requestLocalEndIndex: 60,
    ...overrides,
  };
}

function makePayload(overrides?: Partial<BufferSyncPayloadSnapshot>): BufferSyncPayloadSnapshot {
  return {
    revision: 10,
    startIndex: 0,
    endIndex: 100,
    lineCount: 50,
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<BufferSyncRequestSnapshot>): BufferSyncRequestSnapshot {
  return {
    knownRevision: 5,
    localStartIndex: 0,
    localEndIndex: 50,
    requestStartIndex: 0,
    requestEndIndex: 100,
    ...overrides,
  };
}

describe('doesBufferSyncSatisfyPullState', () => {
  it('satisfies tail-refresh when payload covers target and revision advances', () => {
    expect(doesBufferSyncSatisfyPullState(makeTailPull(), makePayload())).toBe(true);
  });

  it('rejects tail-refresh when payload revision is too low', () => {
    expect(doesBufferSyncSatisfyPullState(makeTailPull(), makePayload({ revision: 5 }))).toBe(false);
  });

  it('satisfies reading-repair when payload covers target', () => {
    expect(doesBufferSyncSatisfyPullState(makeReadingPull(), makePayload({ startIndex: 0, endIndex: 100 }))).toBe(true);
  });

  it('rejects reading-repair when payload endIndex is too low', () => {
    expect(doesBufferSyncSatisfyPullState(makeReadingPull(), makePayload({ endIndex: 70 }))).toBe(false);
  });

  it('rejects tail-refresh when target range is far ahead (targetStartIndex > payload endIndex)', () => {
    // target range starts beyond what payload covers
    expect(doesBufferSyncSatisfyPullState(
      makeTailPull({ targetStartIndex: 150, targetEndIndex: 200 }),
      makePayload({ startIndex: 0, endIndex: 100 })
    )).toBe(false);
  });

  it('rejects tail-refresh when payload revision too low AND target not covered', () => {
    expect(doesBufferSyncSatisfyPullState(
      makeTailPull({ targetStartIndex: 150 }),
      makePayload({ revision: 5, endIndex: 100 })
    )).toBe(false);
  });
});

describe('doesPullStateCoverRequest', () => {
  it('returns true when pull state exactly matches request', () => {
    expect(doesPullStateCoverRequest(makeTailPull({ requestKnownRevision: 5, requestLocalStartIndex: 0, requestLocalEndIndex: 50 }), makeRequest())).toBe(true);
  });

  it('returns false when knownRevision differs', () => {
    expect(doesPullStateCoverRequest(makeTailPull({ requestKnownRevision: 3 }), makeRequest())).toBe(false);
  });

  it('returns false when target range does not cover request', () => {
    expect(doesPullStateCoverRequest(makeTailPull({ targetStartIndex: 50, targetEndIndex: 150 }), makeRequest())).toBe(false);
  });
});

describe('doesPullStateMatchExactSnapshot', () => {
  it('returns true when snapshot matches exactly', () => {
    expect(doesPullStateMatchExactSnapshot(makeTailPull({ requestKnownRevision: 5, requestLocalStartIndex: 0, requestLocalEndIndex: 50, targetStartIndex: 0, targetEndIndex: 100, targetHeadRevision: 10 }), makeRequest(), 10)).toBe(true);
  });

  it('returns false when targetHeadRevision differs', () => {
    expect(doesPullStateMatchExactSnapshot(makeTailPull({ targetHeadRevision: 10 }), makeRequest(), 15)).toBe(false);
  });

  it('returns true when targetHeadRevision is null (ignored)', () => {
    expect(doesPullStateMatchExactSnapshot(makeTailPull({ targetHeadRevision: 10 }), makeRequest(), null)).toBe(true);
  });

  it('returns false when requestStartIndex differs', () => {
    expect(doesPullStateMatchExactSnapshot(makeTailPull({ targetStartIndex: 10 }), makeRequest(), 10)).toBe(false);
  });
});
