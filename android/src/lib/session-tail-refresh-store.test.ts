import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSessionTailRefreshStore } from './session-tail-refresh-store';

describe('session tail refresh store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks pending input tail refresh once and reports repeat marks as already pending', () => {
    const store = createSessionTailRefreshStore();
    expect(store.hasPendingInputTailRefresh('s1')).toBe(false);
    expect(store.markPendingInputTailRefresh('s1', 7, 1000)).toBe(true);
    expect(store.markPendingInputTailRefresh('s1', 9, 2000)).toBe(false);
    expect(store.readPendingInputTailRefresh('s1')).toEqual({ requestedAt: 2000, localRevision: 9 });
    expect(store.hasPendingInputTailRefresh('s1')).toBe(true);
  });

  it('defaults pending input requestedAt to Date.now and floors negative revisions to zero', () => {
    vi.useFakeTimers();
    vi.setSystemTime(123456);
    const store = createSessionTailRefreshStore();
    store.markPendingInputTailRefresh('s1', -3.7);
    expect(store.readPendingInputTailRefresh('s1')).toEqual({ requestedAt: 123456, localRevision: 0 });
  });

  it('consumes pending input tail refresh one-shot', () => {
    const store = createSessionTailRefreshStore();
    store.markPendingInputTailRefresh('s1', 4, 10);
    store.clearPendingInputTailRefresh('s1');
    expect(store.readPendingInputTailRefresh('s1')).toBeNull();
    expect(store.hasPendingInputTailRefresh('s1')).toBe(false);
    // marking again after consume is a fresh first mark
    expect(store.markPendingInputTailRefresh('s1', 5, 20)).toBe(true);
  });

  it('tracks connect and resume tail refresh marks independently with one-shot consume', () => {
    const store = createSessionTailRefreshStore();
    store.markPendingConnectTailRefresh('s1');
    expect(store.hasPendingConnectTailRefresh('s1')).toBe(true);
    expect(store.hasPendingResumeTailRefresh('s1')).toBe(false);

    store.markPendingResumeTailRefresh('s1');
    store.clearPendingConnectTailRefresh('s1');
    expect(store.hasPendingConnectTailRefresh('s1')).toBe(false);
    expect(store.hasPendingResumeTailRefresh('s1')).toBe(true);
    store.clearPendingResumeTailRefresh('s1');
    expect(store.hasPendingResumeTailRefresh('s1')).toBe(false);
  });

  it('isolates all pending marks per session', () => {
    const store = createSessionTailRefreshStore();
    store.markPendingInputTailRefresh('s1', 1, 10);
    store.markPendingConnectTailRefresh('s1');
    store.markPendingResumeTailRefresh('s1');
    expect(store.hasPendingInputTailRefresh('s2')).toBe(false);
    expect(store.hasPendingConnectTailRefresh('s2')).toBe(false);
    expect(store.hasPendingResumeTailRefresh('s2')).toBe(false);

    store.markPendingConnectTailRefresh('s2');
    store.clearPendingTailRefreshMarks('s1');
    expect(store.hasPendingInputTailRefresh('s1')).toBe(false);
    expect(store.hasPendingConnectTailRefresh('s1')).toBe(false);
    expect(store.hasPendingResumeTailRefresh('s1')).toBe(false);
    expect(store.hasPendingConnectTailRefresh('s2')).toBe(true);
  });

  it('records and reads sync request debounce state per (session, purpose)', () => {
    const store = createSessionTailRefreshStore();
    const tailState = {
      sentAt: 100,
      requestStartIndex: 0,
      requestEndIndex: 24,
      knownRevision: 3,
      localStartIndex: 0,
      localEndIndex: 24,
      targetHeadRevision: 4,
      repairSignature: '',
    };
    const repairState = { ...tailState, sentAt: 130, repairSignature: '10-14' };
    store.recordSyncRequest('s1', 'tail-refresh', tailState);
    store.recordSyncRequest('s1', 'reading-repair', repairState);

    expect(store.readSyncRequest('s1', 'tail-refresh')).toEqual(tailState);
    expect(store.readSyncRequest('s1', 'reading-repair')).toEqual(repairState);
    expect(store.readSyncRequest('s2', 'tail-refresh')).toBeNull();
    expect(store.hasSyncRequest('s1', 'tail-refresh')).toBe(true);
    expect(store.hasSyncRequest('s2', 'tail-refresh')).toBe(false);

    store.clearSyncRequest('s1', 'tail-refresh');
    expect(store.readSyncRequest('s1', 'tail-refresh')).toBeNull();
    expect(store.readSyncRequest('s1', 'reading-repair')).toEqual(repairState);
  });

  it('deleteSession drops pending marks but leaves debounce entries (pre-store close semantics)', () => {
    const store = createSessionTailRefreshStore();
    store.markPendingInputTailRefresh('s1', 2, 10);
    store.markPendingConnectTailRefresh('s1');
    store.markPendingResumeTailRefresh('s1');
    const debounceState = {
      sentAt: 100,
      requestStartIndex: 0,
      requestEndIndex: 24,
      knownRevision: 3,
      localStartIndex: 0,
      localEndIndex: 24,
      targetHeadRevision: 4,
      repairSignature: '',
    };
    store.recordSyncRequest('s1', 'tail-refresh', debounceState);
    store.markPendingConnectTailRefresh('s2');

    store.deleteSession('s1');

    expect(store.hasPendingInputTailRefresh('s1')).toBe(false);
    expect(store.hasPendingConnectTailRefresh('s1')).toBe(false);
    expect(store.hasPendingResumeTailRefresh('s1')).toBe(false);
    expect(store.readSyncRequest('s1', 'tail-refresh')).toEqual(debounceState);
    expect(store.hasPendingConnectTailRefresh('s2')).toBe(true);
  });

  it('tracks visible non-gap repair guard separately from sync request debounce', () => {
    const store = createSessionTailRefreshStore();
    store.recordVisibleNonGapRepairRequest('s1', {
      requestedAt: 100,
      requestStartIndex: 10,
      requestEndIndex: 20,
      tailEndIndex: 30,
      targetRevision: 7,
    });

    expect(store.readVisibleNonGapRepairRequest('s1')).toEqual({
      requestedAt: 100,
      requestStartIndex: 10,
      requestEndIndex: 20,
      tailEndIndex: 30,
      targetRevision: 7,
    });
    expect(store.readVisibleNonGapRepairRequest('s2')).toBeNull();

    store.clearVisibleNonGapRepairRequest('s1');
    expect(store.readVisibleNonGapRepairRequest('s1')).toBeNull();
  });

  it('deleteSession clears visible non-gap repair guard with pending marks', () => {
    const store = createSessionTailRefreshStore();
    store.markPendingResumeTailRefresh('s1');
    store.recordVisibleNonGapRepairRequest('s1', {
      requestedAt: 100,
      requestStartIndex: 10,
      requestEndIndex: 20,
      tailEndIndex: 30,
      targetRevision: 7,
    });

    store.deleteSession('s1');

    expect(store.hasPendingResumeTailRefresh('s1')).toBe(false);
    expect(store.readVisibleNonGapRepairRequest('s1')).toBeNull();
  });
});
