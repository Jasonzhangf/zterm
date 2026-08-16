import { describe, expect, it, vi } from 'vitest';
import { createSessionHeadStore } from './session-head-store';

describe('session-head-store merged head truth', () => {
  it('starts with an empty renderer snapshot and no live planner head', () => {
    const store = createSessionHeadStore();
    expect(store.getSnapshot('s1')).toEqual({
      revision: 0,
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
    });
    expect(store.getLiveHead('s1')).toBeNull();
  });

  it('setLiveHead records planner truth and publishes renderer head in one write', () => {
    const store = createSessionHeadStore();
    const listener = vi.fn();
    store.subscribe('s1', listener);

    const changed = store.setLiveHead('s1', {
      revision: 7,
      latestEndIndex: 120,
      availableStartIndex: 20,
      availableEndIndex: 120,
      seenAt: 555,
    });

    expect(changed).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('s1')).toEqual({
      revision: 1,
      daemonHeadRevision: 7,
      daemonHeadEndIndex: 120,
    });
    expect(store.getLiveHead('s1')).toEqual({
      revision: 7,
      latestEndIndex: 120,
      availableStartIndex: 20,
      availableEndIndex: 120,
      seenAt: 555,
    });
  });

  it('setLiveHead with same renderer head updates planner truth without notifying renderer', () => {
    const store = createSessionHeadStore();
    const listener = vi.fn();
    store.setLiveHead('s1', { revision: 7, latestEndIndex: 120, seenAt: 1 });
    store.subscribe('s1', listener);

    const changed = store.setLiveHead('s1', {
      revision: 7,
      latestEndIndex: 120,
      availableStartIndex: 40,
      availableEndIndex: 120,
      seenAt: 2,
    });

    expect(changed).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot('s1').revision).toBe(1);
    expect(store.getLiveHead('s1')).toMatchObject({
      availableStartIndex: 40,
      seenAt: 2,
    });
  });

  it('setLiveHead with publishRenderer=false keeps planner truth without renderer publish', () => {
    const store = createSessionHeadStore();
    const listener = vi.fn();
    store.subscribe('s1', listener);

    const changed = store.setLiveHead(
      's1',
      { revision: 3, latestEndIndex: 30, seenAt: 9 },
      { publishRenderer: false },
    );

    expect(changed).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot('s1')).toEqual({
      revision: 0,
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
    });
    expect(store.getLiveHead('s1')).toMatchObject({
      revision: 3,
      latestEndIndex: 30,
    });
  });

  it('setHead publishes renderer head only and does not create live planner truth', () => {
    const store = createSessionHeadStore();
    const listener = vi.fn();
    store.subscribe('s1', listener);

    const changed = store.setHead('s1', { daemonHeadRevision: 5, daemonHeadEndIndex: 50 });

    expect(changed).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('s1')).toEqual({
      revision: 1,
      daemonHeadRevision: 5,
      daemonHeadEndIndex: 50,
    });
    expect(store.getLiveHead('s1')).toBeNull();
  });

  it('setHead is a renderer no-op when head metadata does not change', () => {
    const store = createSessionHeadStore();
    store.setHead('s1', { daemonHeadRevision: 5, daemonHeadEndIndex: 50 });
    const listener = vi.fn();
    store.subscribe('s1', listener);

    expect(store.setHead('s1', { daemonHeadRevision: 5, daemonHeadEndIndex: 50 })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot('s1').revision).toBe(1);
  });

  it('setHead publishing a zero head bumps the renderer snapshot from empty', () => {
    const store = createSessionHeadStore();
    expect(store.setHead('s1', { daemonHeadRevision: 0, daemonHeadEndIndex: 0 })).toBe(true);
    expect(store.getSnapshot('s1')).toEqual({
      revision: 1,
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 0,
    });
    expect(store.setHead('s1', { daemonHeadRevision: 0, daemonHeadEndIndex: 0 })).toBe(false);
  });

  it('clearLiveHead drops planner truth but keeps renderer head metadata silently', () => {
    const store = createSessionHeadStore();
    store.setLiveHead('s1', { revision: 7, latestEndIndex: 120, seenAt: 1 });
    const listener = vi.fn();
    store.subscribe('s1', listener);

    store.clearLiveHead('s1');

    expect(store.getLiveHead('s1')).toBeNull();
    expect(store.getSnapshot('s1')).toEqual({
      revision: 1,
      daemonHeadRevision: 7,
      daemonHeadEndIndex: 120,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('deleteSession clears everything and notifies subscribers', () => {
    const store = createSessionHeadStore();
    store.setLiveHead('s1', { revision: 7, latestEndIndex: 120, seenAt: 1 });
    const listener = vi.fn();
    store.subscribe('s1', listener);

    store.deleteSession('s1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('s1').revision).toBe(0);
    expect(store.getLiveHead('s1')).toBeNull();
  });

  it('normalizes negative and fractional head values on both write paths', () => {
    const store = createSessionHeadStore();
    store.setLiveHead('s1', {
      revision: 7.9,
      latestEndIndex: -3,
      availableStartIndex: 2.7,
      availableEndIndex: Number.NaN,
      seenAt: -1,
    });
    expect(store.getLiveHead('s1')).toEqual({
      revision: 7,
      latestEndIndex: 0,
      availableStartIndex: 2,
      availableEndIndex: undefined,
      seenAt: 0,
    });
    store.setHead('s2', { daemonHeadRevision: -4, daemonHeadEndIndex: 9.5 });
    expect(store.getSnapshot('s2')).toEqual({
      revision: 1,
      daemonHeadRevision: 0,
      daemonHeadEndIndex: 9,
    });
  });
});
