import { describe, it, expect } from 'vitest';
import {
  shouldPullFollowBuffer,
  shouldCatchUpFollowTailAfterBufferApply,
  type ShouldPullFollowBufferParams,
  type ShouldCatchUpFollowTailAfterBufferApplyParams,
} from './buffer-sync-planner';

function makeParams(overrides?: Partial<ShouldPullFollowBufferParams>): ShouldPullFollowBufferParams {
  return {
    localHasWindow: true,
    distanceToHead: 0,
    cacheLines: 60,
    localEndIndex: 100,
    desiredEndIndex: 100,
    daemonRevision: 10,
    localRevision: 10,
    ...overrides,
  };
}

function makeCatchUpParams(overrides?: Partial<ShouldCatchUpFollowTailAfterBufferApplyParams>): ShouldCatchUpFollowTailAfterBufferApplyParams {
  return {
    localHasWindow: true,
    distanceToHead: 0,
    cacheLines: 60,
    localEndIndex: 100,
    desiredEndIndex: 100,
    daemonRevision: 10,
    localRevision: 10,
    ...overrides,
  };
}

describe('shouldPullFollowBuffer', () => {
  it('returns false when at head and same revision', () => {
    expect(shouldPullFollowBuffer(makeParams())).toBe(false);
  });

  it('returns true when no local window', () => {
    expect(shouldPullFollowBuffer(makeParams({ localHasWindow: false }))).toBe(true);
  });

  it('returns true when distance to head exceeds cache lines', () => {
    expect(shouldPullFollowBuffer(makeParams({ distanceToHead: 100, cacheLines: 60 }))).toBe(true);
  });

  it('returns true when local end index < desired end index', () => {
    expect(shouldPullFollowBuffer(makeParams({ localEndIndex: 50, desiredEndIndex: 100 }))).toBe(true);
  });

  it('returns true when same-end revision advanced', () => {
    expect(shouldPullFollowBuffer(makeParams({ daemonRevision: 15, localRevision: 10 }))).toBe(true);
  });

  it('returns false when same-end local revision newer', () => {
    expect(shouldPullFollowBuffer(makeParams({ daemonRevision: 5, localRevision: 10 }))).toBe(false);
  });

  it('returns false when distance is non-zero but within cache', () => {
    expect(shouldPullFollowBuffer(makeParams({ distanceToHead: 30, cacheLines: 60 }))).toBe(false);
  });

  it('returns true when multiple conditions met', () => {
    expect(shouldPullFollowBuffer(makeParams({ localHasWindow: false, daemonRevision: 15, localRevision: 10 }))).toBe(true);
  });
});

describe('shouldCatchUpFollowTailAfterBufferApply', () => {
  it('returns false at head same revision', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams())).toBe(false);
  });

  it('returns true when no local window', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ localHasWindow: false }))).toBe(true);
  });

  it('returns true when distance exceeds cache', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ distanceToHead: 100, cacheLines: 60 }))).toBe(true);
  });

  it('returns true when local end < desired end', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ localEndIndex: 50, desiredEndIndex: 100 }))).toBe(true);
  });

  it('returns true when same-end revision advanced', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ daemonRevision: 15, localRevision: 10 }))).toBe(true);
  });

  it('returns true when forceSameEndRefresh and revision advanced', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ daemonRevision: 15, localRevision: 10, forceSameEndRefresh: true }))).toBe(true);
  });

  it('returns false when forceSameEndRefresh but revision not advanced', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ forceSameEndRefresh: true }))).toBe(false);
  });

  it('returns false when local revision newer', () => {
    expect(shouldCatchUpFollowTailAfterBufferApply(makeCatchUpParams({ daemonRevision: 5, localRevision: 10 }))).toBe(false);
  });
});
