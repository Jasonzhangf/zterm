export interface ExternalRtcRouteDiagnostics {
  stage: string;
  resolvedPath?: string;
  resolvedRelayTransport?: string;
  selectedIcePair?: {
    local?: { candidateType?: string };
    remote?: { candidateType?: string };
  } | null;
}

export interface ExternalRtcRouteEvidence {
  stage: string;
  path: string;
  relayTransport: string;
  localCandidateType: string;
  remoteCandidateType: string;
}

export function assertExternalRtcRelayEvidence(
  diagnostics: ExternalRtcRouteDiagnostics | null,
): ExternalRtcRouteEvidence {
  if (!diagnostics) {
    throw new Error('external RTC receipt consumer requires traversal diagnostics');
  }
  if (diagnostics.stage !== 'open') {
    throw new Error('external RTC receipt consumer requires traversal stage open');
  }
  if (diagnostics.resolvedPath !== 'rtc-relay') {
    throw new Error('external RTC receipt consumer requires resolved path rtc-relay');
  }
  if (diagnostics.resolvedRelayTransport !== 'turn') {
    throw new Error('external RTC receipt consumer requires resolved relay transport turn');
  }
  const selected = diagnostics.selectedIcePair;
  if (!selected) {
    throw new Error('external RTC receipt consumer requires selected ICE pair');
  }
  const localCandidateType = selected.local?.candidateType ?? null;
  const remoteCandidateType = selected.remote?.candidateType ?? null;
  if (localCandidateType !== 'relay' || remoteCandidateType !== 'relay') {
    throw new Error('external RTC receipt consumer requires both ICE candidates relay');
  }
  return {
    stage: diagnostics.stage,
    path: diagnostics.resolvedPath,
    relayTransport: diagnostics.resolvedRelayTransport,
    localCandidateType,
    remoteCandidateType,
  };
}
