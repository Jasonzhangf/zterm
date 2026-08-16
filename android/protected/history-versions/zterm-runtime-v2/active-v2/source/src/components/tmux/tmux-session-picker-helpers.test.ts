/**
 * Submodule tests: tmux-session-picker-helpers (client.connection_home).
 */
import { describe, expect, it } from 'vitest';
import {
  formatRefreshAge,
  formatRefreshClock,
  getTargetRelayHostId,
  hasRelayRtcEndpointCandidate,
} from './tmux-session-picker-helpers';

describe('tmux-session-picker-helpers', () => {
  it('formats refresh age buckets', () => {
    expect(formatRefreshAge(undefined)).toBe('未刷新');
    expect(formatRefreshAge(Date.now())).toBe('刚刚');
    expect(formatRefreshAge(Date.now() - 5_000)).toBe('5s ago');
    expect(formatRefreshAge(Date.now() - 5 * 60_000)).toBe('5m ago');
  });

  it('formats refresh clocks with a fallback', () => {
    expect(formatRefreshClock(undefined)).toBe('--:--:--');
    expect(formatRefreshClock(1)).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('resolves relay host ids preferring relayHostId', () => {
    expect(getTargetRelayHostId({ relayHostId: ' r1 ', daemonHostId: 'd1' })).toBe('r1');
    expect(getTargetRelayHostId({ daemonHostId: ' d1 ' })).toBe('d1');
    expect(getTargetRelayHostId({})).toBe('');
  });

  it('detects relay rtc endpoint candidates', () => {
    expect(hasRelayRtcEndpointCandidate({ relayEndpointCandidates: [{ kind: 'relay-rtc', relayHostId: 'r1' } as never] })).toBe(true);
    expect(hasRelayRtcEndpointCandidate({ relayEndpointCandidates: [{ kind: 'direct' } as never] })).toBe(false);
  });
});
