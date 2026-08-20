import type { BridgeSettings } from '../bridge-settings';
import type { Host } from '../types';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';

export type TraversalTransportMode = 'auto' | 'websocket' | 'webrtc';
export type TraversalResolvedPath = 'rtc-direct' | 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';
export type TraversalResolvedRelayTransport = 'direct' | 'turn';
export type TraversalRtcIceTransportPolicy = 'all' | 'relay';

export interface TraversalIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TraversalAttemptDiagnostic {
  kind: 'ws' | 'rtc';
  path: TraversalResolvedPath;
  endpoint: string;
  candidateId?: string;
  ok: boolean;
  stage: 'connecting' | 'open' | 'closed' | 'error' | 'skipped';
  reason?: string;
  rttMs?: number;
  score?: number;
}

export interface TraversalIceCandidateDiagnostic {
  id?: string;
  candidateType?: string;
  address?: string;
  port?: number;
  protocol?: string;
  networkType?: string;
  relayProtocol?: string;
  url?: string;
}

export interface TraversalSelectedIcePairDiagnostic {
  local?: TraversalIceCandidateDiagnostic;
  remote?: TraversalIceCandidateDiagnostic;
  roundTripTimeMs?: number;
}

export interface TraversalDiagnostics {
  mode: TraversalTransportMode;
  resolvedPath?: TraversalResolvedPath;
  resolvedEndpoint?: string;
  resolvedRelayTransport?: TraversalResolvedRelayTransport;
  selectedIcePair?: TraversalSelectedIcePairDiagnostic;
  stage: 'idle' | 'connecting' | 'open' | 'closed' | 'error';
  reason?: string;
  attempts: TraversalAttemptDiagnostic[];
}

export interface TraversalSettingsSource {
  signalUrl?: BridgeSettings['signalUrl'];
  turnServerUrl?: BridgeSettings['turnServerUrl'];
  turnUsername?: BridgeSettings['turnUsername'];
  turnCredential?: BridgeSettings['turnCredential'];
  transportMode?: BridgeSettings['transportMode'];
  traversalRelay?: BridgeSettings['traversalRelay'];
  traversalPathPriority?: import('../bridge-settings').TraversalPath[];
}

export interface TraversalTargetSource {
  bridgeHost: Host['bridgeHost'];
  bridgePort: Host['bridgePort'];
  authToken?: Host['authToken'];
  relayHostId?: Host['relayHostId'];
  daemonHostId?: Host['daemonHostId'];
  tailscaleHost?: Host['tailscaleHost'];
  ipv6Host?: Host['ipv6Host'];
  ipv4Host?: Host['ipv4Host'];
  relayEndpointCandidates?: RelayEndpointCandidate[];
  signalUrl?: Host['signalUrl'];
  transportMode?: Host['transportMode'];
}

export interface TraversalPlanCandidateBase {
  id?: string;
  endpoint: string;
}

export interface TraversalRouteHealthRecord {
  key: string;
  path: TraversalResolvedPath;
  endpoint: string;
  candidateId?: string;
  status: 'success' | 'failure' | 'auth-failure';
  updatedAt: number;
  rttMs?: number;
  error?: string;
}

export interface TraversalRouteSelectionDiagnostic {
  candidateId?: string;
  path: TraversalResolvedPath;
  endpoint: string;
  selectable: boolean;
  score: number;
  reasons: string[];
  health?: TraversalRouteHealthRecord;
}

export interface TraversalRouteSelection {
  selected: TraversalPlanCandidate | null;
  diagnostics: TraversalRouteSelectionDiagnostic[];
}

export interface WebSocketTraversalCandidate extends TraversalPlanCandidateBase {
  kind: 'ws';
  path: 'tailscale' | 'ipv6' | 'ipv4';
  url: string;
}

export interface RtcTraversalCandidate extends TraversalPlanCandidateBase {
  kind: 'rtc';
  path: 'rtc-direct' | 'rtc-relay';
  signalUrl: string;
  iceServers: TraversalIceServer[];
  iceTransportPolicy: TraversalRtcIceTransportPolicy;
}

export type TraversalPlanCandidate = WebSocketTraversalCandidate | RtcTraversalCandidate;

export interface BridgeSocketCloseLike {
  code?: number;
  reason?: string;
}

export interface BridgeSocketMessageLike {
  data: string | ArrayBuffer;
}

export interface BridgeTransportSocket {
  readonly readyState: number;
  /** Physical lifecycle owner. Service-owned sockets already negotiated mux. */
  readonly transportOwnership?: 'client' | 'service';
  readonly bufferedAmount?: number;
  onopen: ((event?: Event) => void) | null;
  onmessage: ((event: BridgeSocketMessageLike) => void) | null;
  onerror: ((event?: Event) => void) | null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  reportFailure(reason: string, options?: { authFailure?: boolean }): void;
  getDiagnostics(): TraversalDiagnostics;
}
