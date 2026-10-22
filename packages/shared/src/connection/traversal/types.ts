import type { BridgeSettings } from '../bridge-settings';
import type { Host } from '../types';
import type { RelayEndpointCandidate } from '../relay-directory';

export type TraversalTransportMode = 'auto' | 'websocket' | 'webrtc';
export type TraversalResolvedPath = 'lan' | 'tailscale' | 'ipv4' | 'ipv6' | 'rtc-direct' | 'rtc-relay';
export type TraversalResolvedRelayTransport = 'direct' | 'turn';
export type TraversalRtcIceTransportPolicy = 'all' | 'relay';
export type TraversalCandidateScope = 'mode-default' | 'bound-initial';

export type AttemptId = number;
export type FailureStage = 'connect' | 'signal' | 'rtc' | 'mux';

export type AttemptFailure = {
  stage: FailureStage;
  cause?: unknown;
} & (
  | { kind: 'http'; status?: number }
  | { kind: 'system'; code?: string }
  | { kind: 'ws-close'; code?: number; reason?: string }
  | { kind: 'rtc-state'; state: 'failed' | 'disconnected-expired' }
  | { kind: 'rtc-rejection'; messageType: 'rtc-error'; code?: string | number }
  | { kind: 'timeout'; timer: 'connect' | 'confirmation' | 'hello' }
  | { kind: 'protocol'; code: 'invalid-json' | 'invalid-mux' | 'unexpected-frame' }
  | { kind: 'binding'; expectedDaemonHostId: string; actualDaemonHostId: string }
  | { kind: 'mux-rejection'; code?: string }
  | { kind: 'unknown' }
);

export type FailureDecision =
  | { action: 'advance'; failure: AttemptFailure }
  | {
      action: 'terminate';
      category: 'auth' | 'protocol' | 'binding' | 'service' | 'unknown';
      failure: AttemptFailure;
    };

export type InitialAttemptEvent =
  | { type: 'begin'; attemptId: AttemptId }
  | {
      type: 'invalidated';
      attemptId: AttemptId;
      reason: 'failure' | 'cancel' | 'superseded';
      failure?: AttemptFailure;
    }
  | { type: 'message'; attemptId: AttemptId; data: string | ArrayBuffer }
  | { type: 'terminal'; attemptId?: AttemptId; failure: AttemptFailure };

export interface InitialAttemptPort {
  onEvent(event: InitialAttemptEvent): void;
}

export interface InitialAttemptControl {
  sendForAttempt(id: AttemptId, data: string | ArrayBuffer): boolean;
  confirmAttempt(id: AttemptId): boolean;
  failAttempt(id: AttemptId, failure: AttemptFailure): boolean;
}

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
  traversalPathPriority?: TraversalResolvedPath[];
  rtcIceTransportPolicy?: TraversalRtcIceTransportPolicy;
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
  tierCost?: number;
  healthCost?: number;
  reasons: string[];
  health?: TraversalRouteHealthRecord;
}

export interface TraversalRouteSelection {
  selected: TraversalPlanCandidate | null;
  diagnostics: TraversalRouteSelectionDiagnostic[];
}

export interface WebSocketTraversalCandidate extends TraversalPlanCandidateBase {
  kind: 'ws';
  path: 'lan' | 'tailscale' | 'ipv6' | 'ipv4';
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
  readonly transportOwnership?: 'client' | 'service';
  readonly bufferedAmount?: number;
  onopen: ((event?: Event) => void) | null;
  onmessage: ((event: BridgeSocketMessageLike) => void) | null;
  onerror: ((event?: Event) => void) | null;
  onclose: ((event?: BridgeSocketCloseLike) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  confirmTransportReady?(): void;
  reportFailure(reason: string, options?: { authFailure?: boolean }): void;
  getDiagnostics(): TraversalDiagnostics;
}

export type TraversalTimerHandle = unknown;

export interface TraversalTimerPort {
  setTimeout(callback: () => void, delayMs: number): TraversalTimerHandle;
  clearTimeout(handle: TraversalTimerHandle): void;
}

export interface TraversalWebSocketMessageEvent {
  data: string | ArrayBuffer | Uint8Array;
}

export interface TraversalWebSocketCloseEvent {
  code?: number;
  reason?: string;
}

export interface TraversalWebSocketLike {
  readyState: number;
  binaryType?: string;
  bufferedAmount?: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: TraversalWebSocketMessageEvent) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onfailure?: ((failure: AttemptFailure) => void) | null;
  onclose: ((event?: TraversalWebSocketCloseEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface TraversalDataChannelLike {
  readyState: string;
  binaryType?: string;
  bufferedAmount?: number;
  onopen: (() => void) | null;
  onmessage: ((event: TraversalWebSocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export interface TraversalSessionDescriptionInit {
  type: 'answer' | 'offer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface TraversalSessionDescriptionLike extends TraversalSessionDescriptionInit {
  sdp: string;
}

export interface TraversalIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
  address?: string;
}

export interface TraversalIceCandidateLike extends TraversalIceCandidateInit {
  toJSON?(): TraversalIceCandidateInit;
}

export interface TraversalPeerConnectionIceEventLike {
  candidate: TraversalIceCandidateLike | null;
}

export interface TraversalStatsRecord {
  id?: string;
  type?: string;
  state?: string;
  nominated?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  candidateType?: string;
  address?: string;
  ip?: string;
  port?: number;
  protocol?: string;
  networkType?: string;
  relayProtocol?: string;
  url?: string;
}

export interface TraversalStatsReport {
  forEach(callback: (report: TraversalStatsRecord) => void): void;
  get?(id: string): TraversalStatsRecord | undefined;
}

export interface TraversalPeerConnectionLike {
  readonly remoteDescription: unknown;
  readonly connectionState: string;
  onicecandidate: ((event: TraversalPeerConnectionIceEventLike) => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string, options?: { ordered?: boolean }): TraversalDataChannelLike;
  createOffer(options?: { iceRestart?: boolean }): Promise<TraversalSessionDescriptionInit>;
  setLocalDescription(description: TraversalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: TraversalSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: TraversalIceCandidateLike): Promise<void>;
  getStats(): Promise<TraversalStatsReport>;
  restartIce?(): void;
  close(): void;
}

export interface TraversalRtcConfiguration {
  iceServers: TraversalIceServer[];
  iceTransportPolicy: TraversalRtcIceTransportPolicy;
}

export interface TraversalPlatform {
  createWebSocket(url: string): TraversalWebSocketLike;
  createPeerConnection(config: TraversalRtcConfiguration): TraversalPeerConnectionLike;
  createSessionDescription(init: TraversalSessionDescriptionInit): TraversalSessionDescriptionLike;
  createIceCandidate(init: TraversalIceCandidateInit): TraversalIceCandidateLike;
  timers: TraversalTimerPort;
}
