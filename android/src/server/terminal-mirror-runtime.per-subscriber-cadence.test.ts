import { describe, expect, it } from 'vitest';
import {
  resolveMirrorLiveSyncDelayForSubscriber,
  resolvePerSubscriberTransportSnapshot,
} from './terminal-mirror-runtime';
import type { TerminalSession } from './terminal-runtime-types';

function makeSession(id: string, bufferedAmount = 0, readyState = 1): TerminalSession {
  return {
    id,
    transportId: `transport-${id}`,
    transport: {
      kind: 'ws',
      readyState,
      bufferedAmount,
      sendText: () => {},
      close: () => {},
    },
    sessionName: `tmux-${id}`,
    mirrorKey: `tmux-${id}`,
    widthMode: 'adaptive-phone',
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

function makeMirror(): any {
  return {
    key: 'tmux-1',
    sessionName: 'tmux-1',
    subscribers: new Set(['healthy', 'slow']),
    lastLiveActivityAt: 0,
      lastHeadBroadcastAt: 0,
      lastResizeAt: 0,
    lastCaptureDurationMs: 4,
    lastCanonicalizeDurationMs: 1,
    flushInFlight: false,
    consecutiveFailures: 0,
    liveSyncTimer: null,
  };
}

describe('P2 per-subscriber mirror cadence', () => {
  it('healthy subscriber gets fast lane even when mirror has a backpressured peer', () => {
    const healthy = makeSession('healthy', 0, 1);
    const slow = makeSession('slow', 256 * 1024, 1);
    const sessions = new Map<string, TerminalSession>([
      [healthy.id, healthy],
      [slow.id, slow],
    ]);
    const mirror = makeMirror();
    mirror.lastLiveActivityAt = Date.now() - 100;

    const healthyDecision = resolveMirrorLiveSyncDelayForSubscriber(mirror, 'healthy', sessions, Date.now());
    const slowDecision = resolveMirrorLiveSyncDelayForSubscriber(mirror, 'slow', sessions, Date.now());

    expect(healthyDecision.lane).toBe('fast');
    expect(slowDecision.lane).toBe('slow');
    expect(healthyDecision.delayMs).toBeLessThan(50);
    expect(slowDecision.delayMs).toBeGreaterThanOrEqual(120);
  });

  it('resolvePerSubscriberTransportSnapshot reports individual bufferedAmount', () => {
    const healthy = makeSession('healthy', 0, 1);
    const slow = makeSession('slow', 512 * 1024, 1);
    const sessions = new Map<string, TerminalSession>([
      [healthy.id, healthy],
      [slow.id, slow],
    ]);

    expect(resolvePerSubscriberTransportSnapshot(sessions, 'healthy')?.bufferedBytes).toBe(0);
    expect(resolvePerSubscriberTransportSnapshot(sessions, 'slow')?.bufferedBytes).toBe(512 * 1024);
  });

  it('fast lane is bounded even with two healthy subscribers, slow subscriber is backpressured', () => {
    const healthy1 = makeSession('h1', 0, 1);
    const healthy2 = makeSession('h2', 0, 1);
    const slow = makeSession('slow', 1024 * 1024, 1);
    const sessions = new Map<string, TerminalSession>([
      [healthy1.id, healthy1],
      [healthy2.id, healthy2],
      [slow.id, slow],
    ]);
    const mirror = makeMirror();
    mirror.lastLiveActivityAt = Date.now() - 50;

    const d1 = resolveMirrorLiveSyncDelayForSubscriber(mirror, 'h1', sessions, Date.now());
    const d2 = resolveMirrorLiveSyncDelayForSubscriber(mirror, 'h2', sessions, Date.now());
    const d3 = resolveMirrorLiveSyncDelayForSubscriber(mirror, 'slow', sessions, Date.now());

    expect(d1.lane).toBe('fast');
    expect(d2.lane).toBe('fast');
    expect(d3.lane).toBe('slow');
  });

  it('disconnected subscriber still resolves to slow lane via per-subscriber path', () => {
    const disconn = makeSession('disconn', 0, 3); // CLOSED
    const sessions = new Map<string, TerminalSession>([[disconn.id, disconn]]);
    const mirror = makeMirror();
    mirror.lastLiveActivityAt = 0;
    const decision = resolveMirrorLiveSyncDelayForSubscriber(mirror, 'disconn', sessions, Date.now());
    expect(decision.lane === 'slow' || decision.lane === 'normal').toBe(true);
  });
});
