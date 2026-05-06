import type { BridgeSettings } from '../bridge-settings';
import type { Host } from '../types';

export type TraversalTransportMode = 'auto' | 'websocket' | 'webrtc';
export type TraversalResolvedPath = 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';

export interface TraversalIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TraversalAttemptDiagnostic {
  kind: 'ws' | 'rtc';
  path: TraversalResolvedPath;
  endpoint: string;
  ok: boolean;
  stage: 'connecting' | 'open' | 'closed' | 'error';
  reason?: string;
}

export interface TraversalDiagnostics {
  mode: TraversalTransportMode;
  resolvedPath?: TraversalResolvedPath;
  resolvedEndpoint?: string;
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
}

export interface TraversalTargetSource {
  bridgeHost: Host['bridgeHost'];
  bridgePort: Host['bridgePort'];
  authToken?: Host['authToken'];
  relayHostId?: Host['relayHostId'];
  tailscaleHost?: Host['tailscaleHost'];
  ipv6Host?: Host['ipv6Host'];
  ipv4Host?: Host['ipv4Host'];
  signalUrl?: Host['signalUrl'];
  transportMode?: Host['transportMode'];
}

export interface TraversalPlanCandidateBase {
  endpoint: string;
}

export interface WebSocketTraversalCandidate extends TraversalPlanCandidateBase {
  kind: 'ws';
  path: 'tailscale' | 'ipv6' | 'ipv4';
  url: string;
}

export interface RtcTraversalCandidate extends TraversalPlanCandidateBase {
  kind: 'rtc';
  path: 'rtc-relay';
  signalUrl: string;
  iceServers: TraversalIceServer[];
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
  onopen: ((event?: Event) => void) | null;
  onmessage: ((event: BridgeSocketMessageLike) => void) | null;
  onerror: ((event?: Event) => void) | null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  getDiagnostics(): TraversalDiagnostics;
}
