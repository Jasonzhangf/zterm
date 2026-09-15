import { describe, expect, it } from 'vitest';
import {
  TERMINAL_SESSION_ATTACH_LEASE_MS,
  clearSessionAttachHeartbeat,
  isSessionAttachLeaseExpired,
  markSessionAttachHeartbeat,
} from './terminal-session-attach-lease-runtime';
import type { TerminalTransportSubscriber } from './terminal-runtime-types';

function createSubscriber(): TerminalTransportSubscriber {
  return {
    id: 'sub-1',
    transportId: 'transport-1',
    transport: null,
    sessionName: 'demo',
    mirrorKey: null,
    bodySubscribed: true,
    sessionAttachHeartbeatAt: 0,
    pendingPasteImage: null,
    pendingAttachFile: null,
  };
}

describe('terminal session attach lease', () => {
  it('expires when no foreground heartbeat renews the lease', () => {
    const subscriber = createSubscriber();
    markSessionAttachHeartbeat(subscriber, 1_000);

    expect(isSessionAttachLeaseExpired(subscriber, 1_000 + TERMINAL_SESSION_ATTACH_LEASE_MS)).toBe(false);
    expect(isSessionAttachLeaseExpired(subscriber, 1_001 + TERMINAL_SESSION_ATTACH_LEASE_MS)).toBe(true);
  });

  it('treats a missing heartbeat as already expired', () => {
    const subscriber = createSubscriber();

    expect(isSessionAttachLeaseExpired(subscriber, 1_000)).toBe(true);
  });

  it('never expires a session that already dropped body demand', () => {
    const subscriber = createSubscriber();
    subscriber.bodySubscribed = false;

    expect(isSessionAttachLeaseExpired(subscriber, 1_000_000)).toBe(false);
  });

  it('clears the heartbeat when body demand is released', () => {
    const subscriber = createSubscriber();
    markSessionAttachHeartbeat(subscriber, 5_000);
    clearSessionAttachHeartbeat(subscriber);

    expect(subscriber.sessionAttachHeartbeatAt).toBeUndefined();
    expect(isSessionAttachLeaseExpired(subscriber, 5_000)).toBe(true);
  });
});
