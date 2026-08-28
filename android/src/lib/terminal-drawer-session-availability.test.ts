// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Session } from './types';
import {
  isDrawerSessionRetryable,
  isDrawerSessionUnavailable,
  resolveDrawerSessionAvailability,
  resolveDrawerSessionAvailabilityForItem,
} from './terminal-drawer-session-availability';

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    stableKey: 's1',
    name: 'demo',
    sessionName: 'demo',
    hostKey: 'daemon-a',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    daemonHostId: 'host-a',
    terminalBackend: 'tmux',
    state: 'connected',
    remoteMissing: false,
    ...overrides,
  } as Session;
}

describe('resolveDrawerSessionAvailability', () => {
  it('returns available for a connected tmux session', () => {
    expect(resolveDrawerSessionAvailability(sessionFixture(), [])).toBe('available');
  });

  it('returns closed for a closed tmux session', () => {
    expect(
      resolveDrawerSessionAvailability(sessionFixture({ state: 'closed', terminalBackend: 'tmux' }), []),
    ).toBe('closed');
  });

  it('returns remote-missing when the catalog reports the session as gone', () => {
    expect(
      resolveDrawerSessionAvailability(
        sessionFixture({ remoteMissing: true, state: 'connected' }),
        [],
      ),
    ).toBe('remote-missing');
  });
});

describe('resolveDrawerSessionAvailabilityForItem', () => {
  it('classifies a closed item as closed without inferring backend health', () => {
    expect(
      resolveDrawerSessionAvailabilityForItem({ id: 'a', status: 'closed' }),
    ).toBe('closed');
    expect(
      resolveDrawerSessionAvailabilityForItem({ id: 'a', status: 'closed' }),
    ).toBe('closed');
  });
});

describe('isDrawerSessionUnavailable', () => {
  it('treats only remote-missing as unavailable', () => {
    expect(isDrawerSessionUnavailable('remote-missing')).toBe(true);
    expect(isDrawerSessionUnavailable('closed')).toBe(false);
    expect(isDrawerSessionUnavailable('available')).toBe(false);
    expect(isDrawerSessionUnavailable(undefined)).toBe(false);
  });
});

describe('isDrawerSessionRetryable', () => {
  it('treats closed as retryable without making remote health claims', () => {
    expect(isDrawerSessionRetryable('closed')).toBe(true);
    expect(isDrawerSessionRetryable('available')).toBe(false);
    expect(isDrawerSessionRetryable('remote-missing')).toBe(false);
    expect(isDrawerSessionRetryable(undefined)).toBe(false);
  });
});
