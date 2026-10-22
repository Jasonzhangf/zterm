import { describe, expect, it } from 'vitest';

import {
  assertExternalRtcRelayEvidence,
  type ExternalRtcRouteDiagnostics,
} from './external-rtc-evidence.js';

function openTurnRelayPair(): ExternalRtcRouteDiagnostics {
  return {
    stage: 'open',
    resolvedPath: 'rtc-relay',
    resolvedRelayTransport: 'turn',
    selectedIcePair: {
      local: { candidateType: 'relay' },
      remote: { candidateType: 'relay' },
    },
  };
}

describe('external RTC relay evidence gate', () => {
  it('accepts only an open TURN relay path with both candidates relay', () => {
    expect(assertExternalRtcRelayEvidence(openTurnRelayPair())).toEqual({
      stage: 'open',
      path: 'rtc-relay',
      relayTransport: 'turn',
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
    });
  });

  it('rejects a direct path the previous gate accepted', () => {
    expect(() => assertExternalRtcRelayEvidence({
      ...openTurnRelayPair(),
      resolvedPath: 'rtc-direct',
      resolvedRelayTransport: 'direct',
      selectedIcePair: {
        local: { candidateType: 'host' },
        remote: { candidateType: 'host' },
      },
    })).toThrow();
  });

  it('rejects a mixed relay/host pair the previous gate accepted', () => {
    expect(() => assertExternalRtcRelayEvidence({
      ...openTurnRelayPair(),
      selectedIcePair: {
        local: { candidateType: 'relay' },
        remote: { candidateType: 'host' },
      },
    })).toThrow();
  });

  it('rejects a missing selected ICE pair', () => {
    expect(() => assertExternalRtcRelayEvidence({
      ...openTurnRelayPair(),
      selectedIcePair: undefined,
    })).toThrow();
  });

  it('rejects a path that is not open', () => {
    expect(() => assertExternalRtcRelayEvidence({
      ...openTurnRelayPair(),
      stage: 'connecting',
    })).toThrow();
  });

  it('rejects a non-relay resolved path', () => {
    expect(() => assertExternalRtcRelayEvidence({
      ...openTurnRelayPair(),
      resolvedPath: 'tailscale',
      resolvedRelayTransport: 'direct',
      selectedIcePair: {
        local: { candidateType: 'host' },
        remote: { candidateType: 'host' },
      },
    })).toThrow();
  });

  it('rejects a relay path without TURN transport', () => {
    expect(() => assertExternalRtcRelayEvidence({
      ...openTurnRelayPair(),
      resolvedRelayTransport: 'direct',
    })).toThrow();
  });

  it('rejects missing diagnostics', () => {
    expect(() => assertExternalRtcRelayEvidence(null)).toThrow();
  });
});
