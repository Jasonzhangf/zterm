import type { TerminalTransportSubscriber } from './terminal-runtime-types';

// The daemon holds a tmux mirror only while a foreground client renews the
// session attach lease. Background mux-ping keeps the physical transport alive
// but must not renew this lease.
export const TERMINAL_SESSION_ATTACH_LEASE_MS = 90_000;

export function markSessionAttachHeartbeat(
  subscriber: TerminalTransportSubscriber,
  now = Date.now(),
) {
  subscriber.sessionAttachHeartbeatAt = now;
}

export function clearSessionAttachHeartbeat(subscriber: TerminalTransportSubscriber) {
  subscriber.sessionAttachHeartbeatAt = undefined;
}

export function isSessionAttachLeaseExpired(
  subscriber: TerminalTransportSubscriber,
  now = Date.now(),
) {
  if (subscriber.bodySubscribed === false) {
    return false;
  }
  const heartbeatAt = Math.max(0, Math.floor(subscriber.sessionAttachHeartbeatAt || 0));
  if (heartbeatAt <= 0) {
    return true;
  }
  return now - heartbeatAt > TERMINAL_SESSION_ATTACH_LEASE_MS;
}
