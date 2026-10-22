import type {
  AttemptId,
  AttemptFailure,
  BridgeSocketCloseLike,
  BridgeSocketMessageLike,
  BridgeTransportSocket,
  FailureDecision,
  InitialAttemptControl,
  InitialAttemptPort,
  TraversalDataChannelLike,
  TraversalResolvedRelayTransport,
  TraversalIceCandidateDiagnostic,
  TraversalIceCandidateInit,
  TraversalIceCandidateLike,
  TraversalAttemptDiagnostic,
  TraversalDiagnostics,
  TraversalPlanCandidate,
  TraversalPeerConnectionLike,
  TraversalPlatform,
  TraversalResolvedPath,
  TraversalRouteHealthRecord,
  TraversalSelectedIcePairDiagnostic,
  TraversalStatsRecord,
  TraversalTimerHandle,
  TraversalWebSocketLike,
} from './types';
import { buildTraversalPlanCached } from './config';
import type { TraversalSettingsSource, TraversalTargetSource } from './types';
import { selectBestTraversalRoute } from './route-selector';
import {
  defaultTraversalRouteHealthCache,
  TraversalRouteHealthCache,
  type TraversalRouteHealthScope,
} from './route-health-cache';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const WS_CANDIDATE_TIMEOUT_MS = 1800;
const RTC_DIRECT_OPEN_STABILITY_MS = 1000;
const RTC_DIRECT_CANDIDATE_TIMEOUT_MS = 5000 + RTC_DIRECT_OPEN_STABILITY_MS;
const RTC_DIRECT_FAILURE_RETRY_TIMEOUT_MS = 3000;
const RTC_RELAY_CANDIDATE_TIMEOUT_MS = 2500;
const RTC_DISCONNECTED_GRACE_MS = 10000;
const OPEN_CONFIRMATION_TIMEOUT_MS = 5000;
const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 5000;

function computeTraversalReconnectDelay(attempt: number) {
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

function parseRtcCandidateField(payload: { candidate?: string; address?: string }, offset: -2 | 0) {
  if (typeof payload.address === 'string' && payload.address.trim()) {
    return payload.address.trim();
  }
  const parts = String(payload.candidate || '').split(' ');
  const typIndex = parts.indexOf('typ');
  if (typIndex <= 0) {
    return '';
  }
  return parts[typIndex + offset] || '';
}

function rtcCandidateAddress(payload: { candidate?: string; address?: string }) {
  return parseRtcCandidateField(payload, -2);
}

function rtcCandidateType(payload: { candidate?: string }) {
  const parts = String(payload.candidate || '').split(' ');
  const typIndex = parts.indexOf('typ');
  return typIndex > 0 ? parts[typIndex + 1] : '';
}

function normalizeSocketMessageData(data: string | ArrayBuffer | Uint8Array) {
  if (typeof data === 'string' || data instanceof ArrayBuffer) {
    return data;
  }
  return Uint8Array.from(data).buffer;
}

function serializeIceCandidate(candidate: TraversalIceCandidateLike): TraversalIceCandidateInit {
  if (typeof candidate.toJSON === 'function') {
    return candidate.toJSON();
  }
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
    address: candidate.address,
  };
}

function isTailscaleIceAddress(value?: string) {
  if (!value) {
    return false;
  }
  return /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(value)
    || /^fd7a:115c:a1e0:/i.test(value);
}

function isTailscaleIceCandidate(payload: { candidate?: string; address?: string }) {
  const raw = String(payload.candidate || payload.address || '');
  return /100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|fd7a:115c:a1e0:/i.test(raw)
    || isTailscaleIceAddress(rtcCandidateAddress(payload));
}

function shouldSignalIceCandidate(plan: TraversalPlanCandidate, payload: { candidate?: string; address?: string }) {
  if (plan.kind !== 'rtc' || plan.path !== 'rtc-direct') {
    return true;
  }
  if (isTailscaleIceCandidate(payload)) {
    return false;
  }
  // Allow host, srflx, and prflx candidates for rtc-direct. Filtering host
  // candidates breaks same-NAT direct connections where host-to-host is the
  // only viable path (STUN srflx may be unreachable or slow).
  const type = rtcCandidateType(payload);
  if (type && type !== 'host' && type !== 'srflx' && type !== 'prflx') {
    return false;
  }
  return true;
}

function shouldAcceptIceCandidate(plan: TraversalPlanCandidate, payload: { candidate?: string; address?: string }) {
  if (plan.kind !== 'rtc' || plan.path !== 'rtc-direct') {
    return true;
  }
  if (isTailscaleIceCandidate(payload)) {
    return false;
  }
  const type = rtcCandidateType(payload);
  if (type && type !== 'host' && type !== 'srflx' && type !== 'prflx') {
    return false;
  }
  return true;
}

function stripRtcDirectSdp(sdp: string) {
  if (typeof sdp !== 'string') {
    return sdp;
  }
  return sdp.split(/\r?\n/).filter((line) => {
    if (!line.startsWith('a=candidate:')) {
      return true;
    }
    const payload = { candidate: line.slice(2) };
    if (isTailscaleIceCandidate(payload)) {
      return false;
    }
    const type = rtcCandidateType(payload);
    if (type && type !== 'host' && type !== 'srflx' && type !== 'prflx') {
      return false;
    }
    return true;
  }).join('\r\n');
}

type Backend = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  start(handlers: {
    onopen: () => void;
    onmessage: (event: BridgeSocketMessageLike) => void;
    onerror: (reason?: string) => void;
    onfailure: (failure: AttemptFailure) => void;
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (
      path: TraversalResolvedPath,
      relayTransport?: TraversalResolvedRelayTransport,
      selectedIcePair?: TraversalSelectedIcePairDiagnostic,
    ) => void;
  }): void;
};

function buildInitialRtcAttemptCandidate(
  candidate: Extract<TraversalPlanCandidate, { kind: 'rtc' }>,
  attemptId: AttemptId,
) {
  const signalUrl = new URL(candidate.signalUrl);
  const baseClientIdentity = signalUrl.searchParams.get('deviceId')?.trim() || '';
  if (!baseClientIdentity) {
    throw new Error('bound-initial RTC signaling URL requires a nonempty deviceId client identity');
  }
  signalUrl.searchParams.set('deviceId', `cli:${baseClientIdentity}:attempt:${attemptId}`);
  return {
    ...candidate,
    signalUrl: signalUrl.toString(),
  };
}

function resolveCandidateTimeoutMs(candidate: TraversalPlanCandidate, health: TraversalRouteHealthRecord | null) {
  if (candidate.kind === 'ws') {
    return WS_CANDIDATE_TIMEOUT_MS;
  }
  if (candidate.path === 'rtc-direct') {
    // P1-E: contract the direct-RTC budget while a recent failure is still
    // quarantined, keep the full budget inside the success lease.
    return health?.status === 'failure'
      ? RTC_DIRECT_FAILURE_RETRY_TIMEOUT_MS
      : RTC_DIRECT_CANDIDATE_TIMEOUT_MS;
  }
  return RTC_RELAY_CANDIDATE_TIMEOUT_MS;
}

class WebSocketBackend implements Backend {
  public socket: TraversalWebSocketLike;

  private failed = false;

  public constructor(
    private readonly candidate: Extract<TraversalPlanCandidate, { kind: 'ws' }>,
    platform: TraversalPlatform,
  ) {
    this.socket = platform.createWebSocket(candidate.url);
    this.socket.binaryType = 'arraybuffer';
  }

  public get readyState() {
    return this.socket.readyState;
  }

  public get bufferedAmount() {
    return Math.max(0, Math.floor(this.socket.bufferedAmount || 0));
  }

  public start(handlers: {
    onopen: () => void;
    onmessage: (event: BridgeSocketMessageLike) => void;
    onerror: (reason?: string) => void;
    onfailure: (failure: AttemptFailure) => void;
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (
      path: TraversalResolvedPath,
      relayTransport?: TraversalResolvedRelayTransport,
      selectedIcePair?: TraversalSelectedIcePairDiagnostic,
    ) => void;
  }) {
    this.failed = false;
    this.socket.onopen = () => {
      handlers.onpath?.(this.candidate.path);
      handlers.onopen();
    };
    this.socket.onmessage = (event) => {
      handlers.onmessage({ data: normalizeSocketMessageData(event.data) });
    };
    if ('onfailure' in this.socket) {
      this.socket.onfailure = (failure) => {
        if (this.failed) {
          return;
        }
        this.failed = true;
        handlers.onfailure(failure);
      };
    }
    this.socket.onerror = (event) => {
      if (!this.failed) {
        this.failed = true;
        handlers.onfailure({
          stage: 'connect',
          kind: 'unknown',
          cause: event,
        });
      }
      handlers.onerror('websocket error');
    };
    this.socket.onclose = (event) => {
      const reason = typeof event?.reason === 'string' ? event.reason : '';
      const hadFailure = this.failed;
      this.failed = true;
      if (!hadFailure) {
        handlers.onfailure({
          stage: 'connect',
          kind: 'ws-close',
          ...(typeof event?.code === 'number' ? { code: event.code } : {}),
          ...(reason ? { reason } : {}),
          cause: event,
        });
      }
      handlers.onclose({
        code: typeof event?.code === 'number' ? event.code : 1000,
        reason,
      });
    };
  }

  public send(data: string | ArrayBuffer) {
    this.socket.send(data);
  }

  public close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }
}

class WebRtcBackend implements Backend {
  private static readonly MAX_PENDING_REMOTE_ICE_CANDIDATES = 64;

  private signalSocket: TraversalWebSocketLike | null = null;

  private peerConnection: TraversalPeerConnectionLike | null = null;

  private dataChannel: TraversalDataChannelLike | null = null;

  private disconnectedTimer: TraversalTimerHandle | null = null;

  private openStabilityTimer: TraversalTimerHandle | null = null;

  private openPublished = false;

  private disposed = false;

  private channelFailureReported = false;

  private socketFailureReported = false;

  private pendingRemoteIceCandidates: TraversalIceCandidateInit[] = [];

  private currentResolvedPath: TraversalResolvedPath;
  private currentResolvedRelayTransport: TraversalResolvedRelayTransport | undefined;

  public constructor(
    private readonly candidate: Extract<TraversalPlanCandidate, { kind: 'rtc' }>,
    private readonly platform: TraversalPlatform,
  ) {
    this.currentResolvedPath = candidate.path;
  }

  public get readyState() {
    if (this.disposed) {
      return CLOSED;
    }
    if (this.openPublished && this.dataChannel?.readyState === 'open') {
      return OPEN;
    }
    if (this.dataChannel?.readyState === 'closing' || this.dataChannel?.readyState === 'closed') {
      return this.dataChannel.readyState === 'closing' ? CLOSING : CLOSED;
    }
    return this.signalSocket?.readyState === CLOSING ? CLOSING : CONNECTING;
  }

  public get bufferedAmount() {
    return Math.max(0, Math.floor(this.dataChannel?.bufferedAmount || 0));
  }

  private buildIceCandidateDiagnostic(report?: TraversalStatsRecord): TraversalIceCandidateDiagnostic | undefined {
    if (!report) {
      return undefined;
    }
    const address = typeof report.address === 'string' && report.address.trim()
      ? report.address.trim()
      : typeof report.ip === 'string' && report.ip.trim()
        ? report.ip.trim()
        : undefined;
    const port = typeof report.port === 'number' && Number.isFinite(report.port)
      ? Math.max(0, Math.floor(report.port))
      : undefined;
    return {
      id: typeof report.id === 'string' ? report.id : undefined,
      candidateType: typeof report.candidateType === 'string' ? report.candidateType : undefined,
      address,
      port,
      protocol: typeof report.protocol === 'string' ? report.protocol : undefined,
      networkType: typeof report.networkType === 'string' ? report.networkType : undefined,
      relayProtocol: typeof report.relayProtocol === 'string' ? report.relayProtocol : undefined,
      url: typeof report.url === 'string' ? report.url : undefined,
    };
  }

  private async detectResolvedRoute() {
    if (!this.peerConnection) {
      return {
        path: this.currentResolvedPath,
        relayTransport: this.currentResolvedRelayTransport,
        selectedIcePair: undefined,
      };
    }

    try {
      const stats = await this.peerConnection.getStats();
      const selectedPairRef: { value: TraversalStatsRecord | null } = { value: null };
      stats.forEach((report) => {
        if (
          !selectedPairRef.value
          && report.type === 'candidate-pair'
          && report.state === 'succeeded'
          && report.nominated
        ) {
          selectedPairRef.value = report;
        }
      });
      const selectedPair = selectedPairRef.value;
      if (!selectedPair) {
        if (this.candidate.path === 'rtc-relay') {
          this.currentResolvedPath = 'rtc-relay';
        }
        return {
          path: this.currentResolvedPath,
          relayTransport: this.currentResolvedRelayTransport,
          selectedIcePair: undefined,
        };
      }
      const pair = selectedPair;
      const local = pair.localCandidateId ? stats.get?.(pair.localCandidateId) : undefined;
      const remote = pair.remoteCandidateId ? stats.get?.(pair.remoteCandidateId) : undefined;
      const usesTurn = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      if (this.candidate.path === 'rtc-relay' || usesTurn) {
        this.currentResolvedPath = 'rtc-relay';
      }
      this.currentResolvedRelayTransport = usesTurn ? 'turn' : 'direct';
      const roundTripTimeMs = typeof pair.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime)
        ? Math.max(0, Math.round(pair.currentRoundTripTime * 1000))
        : undefined;
      return {
        path: this.currentResolvedPath,
        relayTransport: this.currentResolvedRelayTransport,
        selectedIcePair: {
          local: this.buildIceCandidateDiagnostic(local),
          remote: this.buildIceCandidateDiagnostic(remote),
          roundTripTimeMs,
        },
      };
    } catch (error) {
      console.warn('[TraversalSocket] Failed to inspect RTC stats:', error);
      if (this.candidate.path === 'rtc-relay') {
        this.currentResolvedPath = 'rtc-relay';
      }
      return {
        path: this.currentResolvedPath,
        relayTransport: this.currentResolvedRelayTransport,
        selectedIcePair: undefined,
      };
    }
  }

  private sendSignalMessage(signalSocket: TraversalWebSocketLike, message: { type: string; payload?: unknown }) {
    if (signalSocket.readyState !== OPEN) {
      return false;
    }
    try {
      signalSocket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.warn('[TraversalSocket] Failed to send RTC signaling message:', error);
      return false;
    }
  }

  private async flushPendingRemoteIceCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) {
      return;
    }
    const pending = this.pendingRemoteIceCandidates.splice(0);
    for (const candidate of pending) {
      await this.peerConnection.addIceCandidate(this.platform.createIceCandidate(candidate));
    }
  }

  private clearDisconnectedTimer() {
    if (this.disconnectedTimer === null) {
      return;
    }
    this.platform.timers.clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
  }

  private clearOpenStabilityTimer() {
    if (this.openStabilityTimer === null) {
      return;
    }
    this.platform.timers.clearTimeout(this.openStabilityTimer);
    this.openStabilityTimer = null;
  }

  private dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearDisconnectedTimer();
    this.clearOpenStabilityTimer();
    this.openPublished = false;
    this.pendingRemoteIceCandidates = [];

    const channel = this.dataChannel;
    const peerConnection = this.peerConnection;
    const signalSocket = this.signalSocket;
    this.dataChannel = null;
    this.peerConnection = null;
    this.signalSocket = null;

    if (channel) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onerror = null;
      channel.onclose = null;
      try {
        channel.close();
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close RTC data channel:', error);
      }
    }
    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      try {
        peerConnection.close();
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close RTC peer connection:', error);
      }
    }
    if (signalSocket) {
      signalSocket.onfailure = null;
      signalSocket.onopen = null;
      signalSocket.onmessage = null;
      signalSocket.onerror = null;
      signalSocket.onclose = null;
      try {
        signalSocket.close();
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close RTC signaling socket:', error);
      }
    }
  }

  private scheduleDisconnectedClose(
    peerConnection: TraversalPeerConnectionLike,
    signalSocket: TraversalWebSocketLike,
    handlers: {
      onfailure: (failure: AttemptFailure) => void;
      onclose: (event?: BridgeSocketCloseLike) => void;
    },
  ) {
    if (this.disconnectedTimer !== null) {
      return;
    }
    this.initiateIceRestart(peerConnection, signalSocket);
    this.disconnectedTimer = this.platform.timers.setTimeout(() => {
      this.disconnectedTimer = null;
      if (this.peerConnection !== peerConnection || peerConnection.connectionState !== 'disconnected') {
        return;
      }
      this.channelFailureReported = true;
      this.dispose();
      handlers.onfailure({
        stage: 'rtc',
        kind: 'rtc-state',
        state: 'disconnected-expired',
      });
      handlers.onclose({ code: 1006, reason: 'rtc peer disconnected' });
    }, RTC_DISCONNECTED_GRACE_MS);
  }

  private initiateIceRestart(
    peerConnection: TraversalPeerConnectionLike,
    signalSocket: TraversalWebSocketLike,
  ) {
    try {
      peerConnection.restartIce?.();
    } catch (error) {
      console.warn('[TraversalSocket] restartIce failed:', error);
    }
    void (async () => {
      try {
        if (this.peerConnection !== peerConnection
          || this.signalSocket !== signalSocket
          || signalSocket.readyState !== OPEN) {
          return;
        }
        const offer = await peerConnection.createOffer({ iceRestart: true });
        await peerConnection.setLocalDescription(offer);
        this.sendSignalMessage(signalSocket, {
          type: 'rtc-offer',
          payload: { sdp: offer.sdp, type: offer.type },
        });
      } catch (error) {
        console.warn('[TraversalSocket] ICE restart signaling failed:', error);
      }
    })();
  }

  public start(handlers: {
    onopen: () => void;
    onmessage: (event: BridgeSocketMessageLike) => void;
    onerror: (reason?: string) => void;
    onfailure: (failure: AttemptFailure) => void;
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (
      path: TraversalResolvedPath,
      relayTransport?: TraversalResolvedRelayTransport,
      selectedIcePair?: TraversalSelectedIcePairDiagnostic,
    ) => void;
  }) {
    const signalSocket = this.platform.createWebSocket(this.candidate.signalUrl);
    this.signalSocket = signalSocket;
    signalSocket.onopen = async () => {
      try {
        if (this.disposed || this.signalSocket !== signalSocket) {
          return;
        }
        const peerConnection = this.platform.createPeerConnection({
          iceServers: this.candidate.iceServers,
          iceTransportPolicy: this.candidate.iceTransportPolicy,
        });
        this.peerConnection = peerConnection;
        const channel = peerConnection.createDataChannel('zterm', {
          ordered: true,
        });
        this.dataChannel = channel;
        this.channelFailureReported = false;
        const publishOpen = async () => {
          if (this.disposed || this.openPublished || this.dataChannel !== channel || channel.readyState !== 'open') {
            return;
          }
          this.openPublished = true;
          const nextRoute = await this.detectResolvedRoute();
          handlers.onpath?.(nextRoute.path, nextRoute.relayTransport, nextRoute.selectedIcePair);
          handlers.onopen();
        };

        channel.binaryType = 'arraybuffer';
        channel.onopen = async () => {
          if (this.candidate.path !== 'rtc-direct') {
            await publishOpen();
            return;
          }
          this.clearOpenStabilityTimer();
          this.openStabilityTimer = this.platform.timers.setTimeout(() => {
            this.openStabilityTimer = null;
            void publishOpen();
          }, RTC_DIRECT_OPEN_STABILITY_MS);
        };
        channel.onmessage = (event) => {
          handlers.onmessage({ data: normalizeSocketMessageData(event.data) });
        };
        channel.onerror = () => {
          if (!this.channelFailureReported) {
            this.channelFailureReported = true;
            handlers.onfailure({
              stage: 'rtc',
              kind: 'unknown',
            });
          }
          handlers.onerror('rtc data channel error');
        };
        channel.onclose = () => {
          const hadFailure = this.channelFailureReported;
          this.channelFailureReported = true;
          this.dispose();
          if (!hadFailure) {
            handlers.onfailure({
              stage: 'rtc',
              kind: 'unknown',
            });
          }
          handlers.onclose({ code: 1000, reason: 'rtc data channel closed' });
        };

        peerConnection.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }
          const payload = serializeIceCandidate(event.candidate);
          if (!shouldSignalIceCandidate(this.candidate, payload)) {
            return;
          }
          this.sendSignalMessage(signalSocket, {
            type: 'rtc-candidate',
            payload,
          });
        };
        peerConnection.onconnectionstatechange = async () => {
          if (peerConnection.connectionState === 'failed') {
            this.channelFailureReported = true;
            this.dispose();
            handlers.onfailure({
              stage: 'rtc',
              kind: 'rtc-state',
              state: 'failed',
            });
            handlers.onclose({ code: 1006, reason: 'rtc peer connection failed' });
            return;
          }
          if (peerConnection.connectionState === 'closed') {
            this.channelFailureReported = true;
            this.dispose();
            handlers.onfailure({
              stage: 'rtc',
              kind: 'unknown',
            });
            handlers.onclose({ code: 1000, reason: `rtc peer ${peerConnection.connectionState}` });
            return;
          }
          if (peerConnection.connectionState === 'disconnected') {
            this.scheduleDisconnectedClose(peerConnection, signalSocket, handlers);
            return;
          }
          if (peerConnection.connectionState === 'connected') {
            this.clearDisconnectedTimer();
            const nextRoute = await this.detectResolvedRoute();
            handlers.onpath?.(nextRoute.path, nextRoute.relayTransport, nextRoute.selectedIcePair);
          }
        };

        if (!this.sendSignalMessage(signalSocket, {
          type: 'rtc-init',
          payload: {
            iceServers: this.candidate.iceServers,
            iceTransportPolicy: this.candidate.iceTransportPolicy,
          },
        })) {
          throw new Error('rtc signaling websocket closed before init');
        }

        const offer = await peerConnection.createOffer();
        if (this.candidate.path === 'rtc-direct') {
          offer.sdp = stripRtcDirectSdp(offer.sdp || '');
        }
        await peerConnection.setLocalDescription(offer);
        if (!this.sendSignalMessage(signalSocket, {
          type: 'rtc-offer',
          payload: { sdp: offer.sdp, type: offer.type },
        })) {
          throw new Error('rtc signaling websocket closed before offer');
        }
      } catch (error) {
        handlers.onfailure({
          stage: 'signal',
          kind: 'unknown',
          cause: error,
        });
        handlers.onerror(error instanceof Error ? error.message : 'rtc init error');
      }
    };

    signalSocket.onmessage = async (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type: 'rtc-answer' | 'rtc-candidate' | 'rtc-error';
          payload?: Record<string, unknown>;
        };
        if (message.type === 'rtc-error') {
          const reason = typeof message.payload?.message === 'string' ? message.payload.message : 'rtc signaling error';
          const rawCode = message.payload?.code;
          this.socketFailureReported = true;
          this.dispose();
          handlers.onfailure({
            stage: 'signal',
            kind: 'rtc-rejection',
            messageType: 'rtc-error',
            ...(typeof rawCode === 'string' || typeof rawCode === 'number' ? { code: rawCode } : {}),
            cause: message,
          });
          handlers.onclose({ code: 4004, reason });
          return;
        }
        if (message.type === 'rtc-answer') {
          if (!this.peerConnection) {
            handlers.onfailure({
              stage: 'signal',
              kind: 'protocol',
              code: 'unexpected-frame',
              cause: message,
            });
            handlers.onerror('rtc answer before peer init');
            return;
          }
          const rawSdp = typeof message.payload?.sdp === 'string' ? message.payload.sdp : '';
          const sdp = this.candidate.path === 'rtc-direct' ? stripRtcDirectSdp(rawSdp) : rawSdp;
          await this.peerConnection.setRemoteDescription(this.platform.createSessionDescription({
            type: 'answer',
            sdp,
          }));
          await this.flushPendingRemoteIceCandidates();
          return;
        }
        if (message.type === 'rtc-candidate' && this.peerConnection && message.payload?.candidate) {
          const candidate = message.payload as TraversalIceCandidateInit;
          if (!shouldAcceptIceCandidate(this.candidate, candidate)) {
            return;
          }
          if (!this.peerConnection.remoteDescription) {
            if (this.pendingRemoteIceCandidates.length >= WebRtcBackend.MAX_PENDING_REMOTE_ICE_CANDIDATES) {
              throw new Error('rtc remote ICE candidate queue full before answer');
            }
            this.pendingRemoteIceCandidates.push(candidate);
            return;
          }
          await this.peerConnection.addIceCandidate(this.platform.createIceCandidate(candidate));
        }
      } catch (error) {
        handlers.onfailure({
          stage: 'signal',
          kind: 'protocol',
          code: 'invalid-json',
          cause: error,
        });
        handlers.onerror(error instanceof Error ? error.message : 'rtc signaling parse error');
      }
    };

    if ('onfailure' in signalSocket) {
      signalSocket.onfailure = (failure) => {
        if (this.socketFailureReported || this.dataChannel?.readyState === 'open') {
          return;
        }
        this.socketFailureReported = true;
        handlers.onfailure(failure);
      };
    }
    signalSocket.onerror = (event) => {
      if (this.dataChannel?.readyState === 'open') {
        return;
      }
      if (!this.socketFailureReported) {
        this.socketFailureReported = true;
        handlers.onfailure({
          stage: 'signal',
          kind: 'unknown',
          cause: event,
        });
      }
      handlers.onerror('rtc signaling websocket error');
    };
    signalSocket.onclose = (event) => {
      if (this.dataChannel?.readyState === 'open') {
        return;
      }
      const reason = typeof event?.reason === 'string' ? event.reason : '';
      const hadFailure = this.socketFailureReported;
      this.socketFailureReported = true;
      this.dispose();
      if (!hadFailure) {
        handlers.onfailure({
          stage: 'signal',
          kind: 'ws-close',
          ...(typeof event?.code === 'number' ? { code: event.code } : {}),
          ...(reason ? { reason } : {}),
          cause: event,
        });
      }
      handlers.onclose({ code: event?.code, reason: reason || 'rtc signaling websocket closed' });
    };
  }

  public send(data: string | ArrayBuffer) {
    if (!this.dataChannel) {
      return;
    }
    if (typeof data === 'string') {
      this.dataChannel.send(data);
      return;
    }
    this.dataChannel.send(data);
  }

  public close(_code?: number, _reason = 'rtc close') {
    this.dispose();
  }
}

const ADVANCE_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

const PROTOCOL_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1010]);

export function classifyInitialFailure(failure: AttemptFailure): FailureDecision {
  const terminate = (
    category: Extract<FailureDecision, { action: 'terminate' }>['category'],
  ): FailureDecision => ({
    action: 'terminate',
    category,
    failure,
  });
  const advance: FailureDecision = {
    action: 'advance',
    failure,
  };

  switch (failure.kind) {
    case 'system':
      return failure.code && ADVANCE_SYSTEM_CODES.has(failure.code)
        ? advance
        : terminate('unknown');
    case 'timeout':
    case 'rtc-state':
      return advance;
    case 'ws-close':
      if (failure.code === 1006) {
        return advance;
      }
      if (failure.code === 4001) {
        return terminate('auth');
      }
      if (failure.code !== undefined && PROTOCOL_CLOSE_CODES.has(failure.code)) {
        return terminate('protocol');
      }
      return terminate('unknown');
    case 'http':
      if (failure.status === 401 || failure.status === 403) {
        return terminate('auth');
      }
      return failure.status === undefined
        ? terminate('unknown')
        : terminate('service');
    case 'protocol':
      return terminate('protocol');
    case 'binding':
      return terminate('binding');
    case 'rtc-rejection':
    case 'mux-rejection':
      return terminate('service');
    case 'unknown':
      return terminate('unknown');
  }
}

function describeInitialFailure(failure: AttemptFailure) {
  switch (failure.kind) {
    case 'http':
      return `HTTP ${failure.status ?? 'unknown'}`;
    case 'system':
      return failure.code ? `system ${failure.code}` : 'system error';
    case 'ws-close':
      return failure.reason || `websocket close ${failure.code ?? 'unknown'}`;
    case 'rtc-state':
      return `RTC ${failure.state}`;
    case 'rtc-rejection':
      return failure.code === undefined
        ? 'RTC control rejection'
        : `RTC control rejection ${failure.code}`;
    case 'timeout':
      return `${failure.timer} timeout`;
    case 'protocol':
      return `protocol ${failure.code}`;
    case 'binding':
      return `daemon identity ${failure.actualDaemonHostId} does not match ${failure.expectedDaemonHostId}`;
    case 'mux-rejection':
      return failure.code ? `mux rejection ${failure.code}` : 'mux rejection';
    case 'unknown':
      return 'unknown initial attempt failure';
  }
}

interface TraversalSocketCommonOptions {
  platform: TraversalPlatform;
  overrideUrl?: string;
  routeHealthCache?: Pick<TraversalRouteHealthCache, 'get' | 'recordSuccess' | 'recordFailure'>;
  routeHealthScope?: TraversalRouteHealthScope;
  autoReconnect?: boolean;
  requireOpenConfirmation?: boolean;
}

export type TraversalSocketOptions =
  | (TraversalSocketCommonOptions & {
      candidateScope?: 'mode-default';
      initialAttemptPort?: never;
    })
  | (TraversalSocketCommonOptions & {
      candidateScope: 'bound-initial';
      initialAttemptPort: InitialAttemptPort;
    });

export class TraversalSocket implements BridgeTransportSocket, InitialAttemptControl {
  public onopen: ((event?: Event) => void) | null = null;

  public onmessage: ((event: BridgeSocketMessageLike) => void) | null = null;

  public onerror: ((event?: Event) => void) | null = null;

  public onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;

  private readonly diagnostics: TraversalDiagnostics;

  private readonly candidates: TraversalPlanCandidate[];

  private readonly traversalPathPriority: TraversalPlanCandidate['path'][];

  private backend: Backend | null = null;

  private activeAttempt: TraversalAttemptDiagnostic | null = null;

  private activeCandidate: TraversalPlanCandidate | null = null;

  private attemptedCandidateKeys = new Set<string>();

  private closedByClient = false;

  private reconnectAttempt = 0;

  private reconnectTimer: TraversalTimerHandle | null = null;

  private readonly platform: TraversalPlatform;

  private readonly routeHealthCache: Pick<TraversalRouteHealthCache, 'get' | 'recordSuccess' | 'recordFailure'>;

  private readonly routeHealthScope: TraversalRouteHealthScope;

  private readonly autoReconnect: boolean;

  private readonly requireOpenConfirmation: boolean;

  private readonly boundInitial: boolean;

  private readonly initialAttemptPort: InitialAttemptPort | null;

  private initialAttemptControl: {
    send: (id: number, data: string | ArrayBuffer) => boolean;
    confirm: (id: number) => boolean;
    fail: (id: number, failure: AttemptFailure) => boolean;
    cancel: () => void;
  } | null = null;

  private initialAttemptSequence = 0;

  private initialTerminalSent = false;

  private lastInitialFailure: AttemptFailure | null = null;

  private lastInitialAttemptId: number | undefined;

  private cancelActiveBatch: ((code?: number, reason?: string) => void) | null = null;

  private pendingConfirmationTimer: TraversalTimerHandle | null = null;

  private pendingSettle: (() => void) | null = null;

  public constructor(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options: TraversalSocketOptions,
  ) {
    this.platform = options.platform;
    const candidateScope = options.candidateScope || 'mode-default';
    this.boundInitial = candidateScope === 'bound-initial';
    if (this.boundInitial && !options.initialAttemptPort) {
      throw new Error('bound-initial requires an initial attempt port');
    }
    this.initialAttemptPort = this.boundInitial ? options.initialAttemptPort ?? null : null;
    const plan = buildTraversalPlanCached(
      target,
      settings,
      options.overrideUrl,
      candidateScope,
    );
    this.candidates = plan.candidates;
    this.traversalPathPriority = plan.candidates
      .map((candidate) => candidate.path)
      .filter((path, index, paths) => paths.indexOf(path) === index);
    this.routeHealthCache = options.routeHealthCache || defaultTraversalRouteHealthCache;
    this.routeHealthScope = options.routeHealthScope || {
      accountId: settings.traversalRelay?.userId,
      daemonHostId: target.relayHostId || target.daemonHostId,
    };
    this.autoReconnect = !this.boundInitial && options.autoReconnect === true;
    this.requireOpenConfirmation = options.requireOpenConfirmation === true;
    this.diagnostics = {
      mode: plan.mode,
      stage: 'connecting',
      attempts: [],
    };
    queueMicrotask(() => this.connectNext());
  }

  public get readyState() {
    return this.backend?.readyState ?? (this.closedByClient ? CLOSED : CONNECTING);
  }

  public get bufferedAmount() {
    return Math.max(0, Math.floor(this.backend?.bufferedAmount || 0));
  }

  public getDiagnostics() {
    return {
      ...this.diagnostics,
      attempts: [...this.diagnostics.attempts],
    };
  }

  private candidateKey(candidate: TraversalPlanCandidate) {
    return candidate.id || `${candidate.path}:${candidate.endpoint}`;
  }

  private isAuthFailure(reason?: string) {
    return /auth|unauthorized|401|403|token/i.test(reason || '');
  }

  private markAttempt(
    candidate: TraversalPlanCandidate,
    stage: TraversalAttemptDiagnostic['stage'],
    ok: boolean,
    reason?: string,
    rttMs?: number,
    score?: number,
    record?: TraversalAttemptDiagnostic,
  ) {
    const target = record ?? this.activeAttempt;
    if (target) {
      target.stage = stage;
      target.ok = ok;
      target.reason = reason;
      target.rttMs = rttMs ?? target.rttMs;
      target.score = score ?? target.score;
      return;
    }
    const attempt: TraversalAttemptDiagnostic = {
      kind: candidate.kind,
      path: candidate.path,
      endpoint: candidate.endpoint,
      candidateId: candidate.id,
      ok,
      stage,
      reason,
      rttMs,
      score,
    };
    this.diagnostics.attempts.push(attempt);
    this.activeAttempt = attempt;
  }

  private finishFailure(reason: string) {
    this.diagnostics.stage = 'error';
    this.diagnostics.reason = reason;
    this.onclose?.({ code: 1006, reason });
    if (this.autoReconnect && !this.closedByClient) {
      this.scheduleReconnect(reason);
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) {
      return;
    }
    this.platform.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(reason: string) {
    if (this.closedByClient || this.reconnectTimer !== null) {
      return;
    }
    this.diagnostics.stage = 'connecting';
    this.diagnostics.reason = reason;
    const delay = computeTraversalReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.platform.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByClient) {
        return;
      }
      this.attemptedCandidateKeys.clear();
      this.connectNext();
    }, delay);
  }

  private emitInitialTerminal(failure: AttemptFailure, attemptId?: number) {
    if (!this.boundInitial || this.initialTerminalSent || this.closedByClient || !this.initialAttemptPort) {
      return;
    }
    this.initialTerminalSent = true;
    this.diagnostics.stage = 'error';
    this.diagnostics.reason = describeInitialFailure(failure);
    this.initialAttemptPort.onEvent({
      type: 'terminal',
      ...(attemptId === undefined ? {} : { attemptId }),
      failure,
    });
  }

  private connectNext() {
    if (this.closedByClient || this.initialTerminalSent) {
      return;
    }
    const remainingCandidates = this.candidates.filter((item) => !this.attemptedCandidateKeys.has(this.candidateKey(item)));
    const selection = selectBestTraversalRoute({
      candidates: remainingCandidates,
      healthCache: this.routeHealthCache,
      scope: this.routeHealthScope,
      traversalPathPriority: this.traversalPathPriority,
    });
    if (selection.selected === null) {
      if (this.boundInitial) {
        const failure = this.lastInitialFailure || {
          stage: 'connect',
          kind: 'unknown',
        } satisfies AttemptFailure;
        this.emitInitialTerminal(failure, this.lastInitialAttemptId);
        return;
      }
      this.finishFailure(this.diagnostics.reason || 'No traversal path succeeded');
      return;
    }
    const selected = selection.selected;
    const selectableDiagnostics = selection.diagnostics.filter((item) => item.selectable);
    const pool = selectableDiagnostics.length > 0 ? selectableDiagnostics : selection.diagnostics;
    const poolIds = new Set(pool.map((item) => item.candidateId));
    const poolCandidates = remainingCandidates.filter((item) => poolIds.has(item.id));
    // Tier-first: the parallel batch is limited to the selected tier. A lower
    // tier (for example public WS/rtc-direct when Tailscale is selected) may
    // not race a higher tier and steal the resolved path via first-onopen; it
    // only enters after this batch fully fails and connectNext re-selects.
    const selectedDiagnostic = selection.diagnostics.find((item) =>
      item.candidateId === selected.id
      && item.path === selected.path
      && item.endpoint === selected.endpoint);
    const selectedTierCost = selectedDiagnostic?.tierCost;
    const batch = selectedTierCost === undefined
      ? poolCandidates.filter((item) => item.id === selected.id)
      : poolCandidates.filter((item) => {
          const diagnostic = selection.diagnostics.find((d) =>
            d.candidateId === item.id
            && d.path === item.path
            && d.endpoint === item.endpoint);
          return diagnostic?.tierCost === selectedTierCost;
        });
    if (batch.length === 0) {
      if (this.boundInitial) {
        const failure = this.lastInitialFailure || {
          stage: 'connect',
          kind: 'unknown',
        } satisfies AttemptFailure;
        this.emitInitialTerminal(failure, this.lastInitialAttemptId);
        return;
      }
      this.finishFailure(this.diagnostics.reason || 'No traversal path succeeded');
      return;
    }

    // The whole batch is claimed up-front so concurrent callbacks and the next
    // connectNext() (after a batch-wide failure) cannot re-select a candidate.
    for (const item of batch) {
      this.attemptedCandidateKeys.add(this.candidateKey(item));
    }

    if (this.boundInitial) {
      this.connectInitialBatch(batch, selection);
      return;
    }

    this.activeAttempt = null;
    this.diagnostics.resolvedPath = undefined;
    this.diagnostics.resolvedEndpoint = undefined;
    this.diagnostics.resolvedRelayTransport = undefined;
    this.diagnostics.selectedIcePair = undefined;

    const attempts: {
      candidate: TraversalPlanCandidate;
      record: TraversalAttemptDiagnostic;
      backend: Backend;
      settled: boolean;
      advanced: boolean;
      timer: TraversalTimerHandle | null;
      startedAt: number;
    }[] = batch.map((item) => {
      const diagnostic = selection.diagnostics.find((d) =>
        d.path === item.path && d.endpoint === item.endpoint && d.candidateId === item.id);
      const record: TraversalAttemptDiagnostic = {
        kind: item.kind,
        path: item.path,
        endpoint: item.endpoint,
        candidateId: item.id,
        ok: false,
        stage: 'connecting',
        score: diagnostic?.score,
      };
      this.diagnostics.attempts.push(record);
      this.activeAttempt = record;
      return {
        candidate: item,
        record,
        backend: item.kind === 'ws'
          ? new WebSocketBackend(item, this.platform)
          : new WebRtcBackend(item, this.platform),
        settled: false,
        advanced: false,
        timer: null,
        startedAt: 0,
      };
    });

    let winnerSettled = false;

    const releaseActiveBatch = () => {
      if (this.cancelActiveBatch === cancelBatch) {
        this.cancelActiveBatch = null;
      }
    };
    const cancelBatch = (code?: number, reason?: string) => {
      releaseActiveBatch();
      for (const attempt of attempts) {
        attempt.advanced = true;
        if (attempt.timer !== null) {
          this.platform.timers.clearTimeout(attempt.timer);
          attempt.timer = null;
        }
        try {
          attempt.backend.close(code, reason);
        } catch (error) {
          console.warn('[TraversalSocket] Failed to close cancelled backend:', error);
        }
      }
    };
    this.cancelActiveBatch = cancelBatch;

    // While waiting for mux-ready confirmation, the first physically opened
    // candidate is provisional. Runner-up backends stay connected as explicit
    // fallbacks; they neither notify the upper layer nor feed protocol frames
    // into it until they are promoted.
    let provisionalAttempt: (typeof attempts)[number] | null = null;
    const openedFallbacks: (typeof attempts)[number][] = [];

    const promoteOpenedCandidate = (candidate: (typeof attempts)[number], reason: string | undefined) => {
      provisionalAttempt = candidate;
      if (candidate.timer !== null) {
        this.platform.timers.clearTimeout(candidate.timer);
        candidate.timer = null;
      }
      this.backend = candidate.backend;
      this.activeCandidate = candidate.candidate;
      this.pendingSettle = () => settleWinner(candidate);
      this.pendingConfirmationTimer = this.platform.timers.setTimeout(() => {
        this.pendingConfirmationTimer = null;
        const failed = provisionalAttempt;
        this.pendingSettle = null;
        provisionalAttempt = null;
        if (!failed || failed.settled || failed.advanced || this.closedByClient) {
          return;
        }
        failAttempt(failed, reason || 'mux-ready confirmation timeout', 'error');
        const next = openedFallbacks.shift();
        if (next && !next.settled && !next.advanced && !this.closedByClient) {
          promoteOpenedCandidate(next, undefined);
          this.onopen?.();
        }
      }, OPEN_CONFIRMATION_TIMEOUT_MS);
    };

    const failAttempt = (attempt: (typeof attempts)[number], reason: string, stage: 'closed' | 'error') => {
      if (attempt.settled || attempt.advanced || this.closedByClient) {
        return;
      }
      const fallbackIndex = openedFallbacks.indexOf(attempt);
      if (fallbackIndex >= 0) {
        openedFallbacks.splice(fallbackIndex, 1);
      }
      attempt.advanced = true;
      if (attempt.timer !== null) {
        this.platform.timers.clearTimeout(attempt.timer);
        attempt.timer = null;
      }
      this.diagnostics.reason = reason;
      this.markAttempt(attempt.candidate, stage, false, reason, undefined, attempt.record.score, attempt.record);
      this.routeHealthCache.recordFailure(this.routeHealthScope, attempt.candidate, reason, {
        authFailure: this.isAuthFailure(reason),
      });
      try {
        attempt.backend.close(4000, reason);
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close failed backend:', error);
      }
      // Advance only once the whole batch is exhausted (or a winner appeared).
      if (!winnerSettled && attempts.every((item) => item.settled || item.advanced)) {
        releaseActiveBatch();
        this.connectNext();
      }
    };

    const settleWinner = (attempt: (typeof attempts)[number]) => {
      if (winnerSettled || attempt.settled || attempt.advanced || this.closedByClient) {
        return;
      }
      winnerSettled = true;
      attempt.settled = true;
      attempt.advanced = true;
      releaseActiveBatch();
      if (attempt.timer !== null) {
        this.platform.timers.clearTimeout(attempt.timer);
        attempt.timer = null;
      }
      for (const other of attempts) {
        if (other === attempt) {
          continue;
        }
        // Mark the loser as advanced (NOT settled): closing it must not
        // surface as a physical disconnect to the upper layer, and its
        // onclose handler returns silently on the advanced guard.
        const wasAlreadyAdvanced = other.advanced;
        other.advanced = true;
        if (other.timer !== null) {
          this.platform.timers.clearTimeout(other.timer);
          other.timer = null;
        }
        try {
          other.backend.close(4000, 'superseded by faster candidate');
        } catch (error) {
          console.warn('[TraversalSocket] Failed to close superseded backend:', error);
        }
        // Only an attempt that was still in flight is recorded as skipped;
        // one that already failed keeps its real failure record.
        if (!wasAlreadyAdvanced) {
          this.markAttempt(other.candidate, 'skipped', false, 'superseded by faster candidate', undefined, other.record.score, other.record);
        }
      }
      this.activeCandidate = attempt.candidate;
      this.backend = attempt.backend;
      this.clearReconnectTimer();
      this.reconnectAttempt = 0;
      const rttMs = Date.now() - attempt.startedAt;
      this.routeHealthCache.recordSuccess(this.routeHealthScope, attempt.candidate, rttMs);
      this.markAttempt(attempt.candidate, 'open', true, undefined, rttMs, attempt.record.score, attempt.record);
      this.diagnostics.stage = 'open';
      this.diagnostics.reason = undefined;
      this.diagnostics.resolvedPath = this.diagnostics.resolvedPath || attempt.candidate.path;
      this.diagnostics.resolvedEndpoint = attempt.candidate.endpoint;
      if (!this.requireOpenConfirmation) {
        this.onopen?.();
      }
    };

    for (const attempt of attempts) {
      attempt.startedAt = Date.now();
      const health = this.routeHealthCache.get(this.routeHealthScope, attempt.candidate);
      const timeoutMs = resolveCandidateTimeoutMs(attempt.candidate, health);
      attempt.timer = this.platform.timers.setTimeout(() => {
        failAttempt(attempt, `${attempt.candidate.kind} connect timeout`, 'error');
      }, timeoutMs);
      attempt.backend.start({
        onopen: () => {
          if (!this.requireOpenConfirmation) {
            settleWinner(attempt);
            return;
          }
          if (this.pendingSettle !== null) {
            // A faster candidate is already running the protocol handshake.
            // Keep this backend connected until that candidate settles or the
            // confirmation deadline promotes an opened fallback.
            if (attempt.timer !== null) {
              this.platform.timers.clearTimeout(attempt.timer);
              attempt.timer = null;
            }
            openedFallbacks.push(attempt);
            return;
          }
          promoteOpenedCandidate(attempt, undefined);
          this.onopen?.();
        },
        onmessage: (event) => {
          if (
            this.requireOpenConfirmation
            && !attempt.settled
            && attempt !== provisionalAttempt
          ) {
            return;
          }
          this.onmessage?.(event);
        },
        onerror: (reason) => {
          if (attempt.advanced && !attempt.settled) {
            return;
          }
          this.diagnostics.reason = reason || `${attempt.candidate.kind} error`;
          this.markAttempt(attempt.candidate, 'error', false, this.diagnostics.reason, undefined, attempt.record.score, attempt.record);
          if (!attempt.settled) {
            this.routeHealthCache.recordFailure(this.routeHealthScope, attempt.candidate, this.diagnostics.reason, {
              authFailure: this.isAuthFailure(this.diagnostics.reason),
            });
          }
          if (attempt.settled) {
            this.diagnostics.stage = 'error';
            this.onerror?.();
          }
        },
        onfailure: () => {},
        onclose: (event) => {
          if (attempt.advanced && !attempt.settled) {
            return;
          }
          if (!attempt.settled && !this.closedByClient) {
            if (attempt.advanced) {
              return;
            }
            const reason = event?.reason || `${attempt.candidate.kind} closed`;
            failAttempt(attempt, reason, 'closed');
            return;
          }
          if (attempt.settled && !this.closedByClient) {
            const reason = event?.reason || `${attempt.candidate.kind} closed`;
            this.markAttempt(attempt.candidate, 'closed', true, reason, undefined, attempt.record.score, attempt.record);
            this.routeHealthCache.recordFailure(this.routeHealthScope, attempt.candidate, reason, {
              authFailure: this.isAuthFailure(reason),
            });
            this.diagnostics.stage = this.closedByClient ? 'closed' : 'error';
            if (event?.reason) {
              this.diagnostics.reason = event.reason;
            }
            this.onclose?.(event);
            if (this.autoReconnect) {
              this.scheduleReconnect(reason);
            }
            return;
          }
          this.diagnostics.stage = this.closedByClient ? 'closed' : 'error';
          if (event?.reason) {
            this.diagnostics.reason = event.reason;
          }
          this.onclose?.(event);
        },
        onpath: (path, relayTransport, selectedIcePair) => {
          this.diagnostics.resolvedPath = path;
          this.diagnostics.resolvedRelayTransport = relayTransport;
          this.diagnostics.selectedIcePair = selectedIcePair;
        },
      });
    }
  }

  private connectInitialBatch(
    batch: TraversalPlanCandidate[],
    selection: ReturnType<typeof selectBestTraversalRoute>,
  ) {
    type InitialAttempt = {
      id: number;
      candidate: TraversalPlanCandidate;
      record: TraversalAttemptDiagnostic;
      backend: Backend;
      opened: boolean;
      settled: boolean;
      advanced: boolean;
      invalidated: boolean;
      timer: TraversalTimerHandle | null;
      startedAt: number;
      pathDiagnostic?: {
        path: TraversalResolvedPath;
        relayTransport?: TraversalResolvedRelayTransport;
        selectedIcePair?: TraversalSelectedIcePairDiagnostic;
      };
    };

    let transactionState: 'active' | 'committed' | 'closed' = 'active';
    let current: InitialAttempt | null = null;
    const openedFallbacks: InitialAttempt[] = [];

    this.activeAttempt = null;
    this.diagnostics.resolvedPath = undefined;
    this.diagnostics.resolvedEndpoint = undefined;
    this.diagnostics.resolvedRelayTransport = undefined;
    this.diagnostics.selectedIcePair = undefined;

    const attempts: InitialAttempt[] = batch.map((candidate) => {
      const attemptId: AttemptId = this.initialAttemptSequence + 1;
      this.initialAttemptSequence = attemptId;
      const diagnostic = selection.diagnostics.find((item) =>
        item.path === candidate.path
        && item.endpoint === candidate.endpoint
        && item.candidateId === candidate.id);
      const record: TraversalAttemptDiagnostic = {
        kind: candidate.kind,
        path: candidate.path,
        endpoint: candidate.endpoint,
        candidateId: candidate.id,
        ok: false,
        stage: 'connecting',
        score: diagnostic?.score,
      };
      this.diagnostics.attempts.push(record);
      this.activeAttempt = record;
      return {
        id: attemptId,
        candidate,
        record,
        backend: candidate.kind === 'ws'
          ? new WebSocketBackend(candidate, this.platform)
          : new WebRtcBackend(
            buildInitialRtcAttemptCandidate(candidate, attemptId),
            this.platform,
          ),
        opened: false,
        settled: false,
        advanced: false,
        invalidated: false,
        timer: null,
        startedAt: 0,
      };
    });

    const releaseActiveBatch = () => {
      if (this.cancelActiveBatch === cancelBatch) {
        this.cancelActiveBatch = null;
      }
    };
    const clearAttemptTimer = (attempt: InitialAttempt) => {
      if (attempt.timer === null) {
        return;
      }
      this.platform.timers.clearTimeout(attempt.timer);
      attempt.timer = null;
    };
    const clearConfirmationTimer = () => {
      if (this.pendingConfirmationTimer === null) {
        return;
      }
      this.platform.timers.clearTimeout(this.pendingConfirmationTimer);
      this.pendingConfirmationTimer = null;
    };
    const removeFallback = (attempt: InitialAttempt) => {
      const index = openedFallbacks.indexOf(attempt);
      if (index >= 0) {
        openedFallbacks.splice(index, 1);
      }
    };
    const closeAttempt = (attempt: InitialAttempt, reason: string) => {
      clearAttemptTimer(attempt);
      attempt.advanced = true;
      try {
        attempt.backend.close(4000, reason);
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close initial attempt:', error);
      }
    };
    const notifyInvalidated = (
      attempt: InitialAttempt,
      reason: 'failure' | 'cancel' | 'superseded',
      failure?: AttemptFailure,
    ) => {
      if (attempt.invalidated) {
        return;
      }
      attempt.invalidated = true;
      this.initialAttemptPort?.onEvent({
        type: 'invalidated',
        attemptId: attempt.id,
        reason,
        ...(failure ? { failure } : {}),
      });
    };
    const invalidateCurrent = (
      reason: 'failure' | 'cancel',
      failure?: AttemptFailure,
    ) => {
      const invalidated = current;
      if (!invalidated) {
        return;
      }
      current = null;
      clearConfirmationTimer();
      if (this.backend === invalidated.backend) {
        this.backend = null;
      }
      if (this.activeCandidate === invalidated.candidate) {
        this.activeCandidate = null;
      }
      removeFallback(invalidated);
      clearAttemptTimer(invalidated);
      invalidated.advanced = true;
      notifyInvalidated(invalidated, reason, failure);
      try {
        invalidated.backend.close(4000, failure ? describeInitialFailure(failure) : reason);
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close invalidated initial attempt:', error);
      }
    };
    const closeAllExcept = (winner: InitialAttempt | null) => {
      clearConfirmationTimer();
      for (const attempt of attempts) {
        if (attempt === winner) {
          continue;
        }
        removeFallback(attempt);
        closeAttempt(attempt, 'superseded by confirmed initial attempt');
      }
    };
    const applyAttemptPath = (attempt: InitialAttempt) => {
      this.diagnostics.resolvedPath =
        attempt.pathDiagnostic?.path || attempt.candidate.path;
      this.diagnostics.resolvedRelayTransport =
        attempt.pathDiagnostic?.relayTransport;
      this.diagnostics.selectedIcePair =
        attempt.pathDiagnostic?.selectedIcePair;
    };
    const promote = (attempt: InitialAttempt) => {
      if (
        transactionState !== 'active'
        || this.closedByClient
        || current !== null
        || attempt.settled
        || attempt.advanced
        || !attempt.opened
      ) {
        return;
      }
      removeFallback(attempt);
      clearAttemptTimer(attempt);
      current = attempt;
      this.backend = attempt.backend;
      this.activeCandidate = attempt.candidate;
      applyAttemptPath(attempt);
      this.pendingConfirmationTimer = this.platform.timers.setTimeout(() => {
        this.pendingConfirmationTimer = null;
        if (
          transactionState !== 'active'
          || this.closedByClient
          || current !== attempt
          || attempt.settled
        ) {
          return;
        }
        settleFailure(attempt, {
          stage: 'mux',
          kind: 'timeout',
          timer: 'confirmation',
        });
      }, OPEN_CONFIRMATION_TIMEOUT_MS);
      this.initialAttemptPort?.onEvent({
        type: 'begin',
        attemptId: attempt.id,
      });
    };
    const promoteNextOpenedFallback = () => {
      while (current === null && openedFallbacks.length > 0) {
        const next = openedFallbacks[0];
        if (!next || next.settled || next.advanced || !next.opened) {
          openedFallbacks.shift();
          continue;
        }
        promote(next);
        return;
      }
    };
    const finishTerminal = (attempt: InitialAttempt, failure: AttemptFailure) => {
      if (transactionState === 'closed' || this.initialTerminalSent || this.closedByClient) {
        return;
      }
      transactionState = 'closed';
      this.lastInitialFailure = failure;
      this.lastInitialAttemptId = attempt.id;
      if (current && current !== attempt) {
        invalidateCurrent('failure');
      }
      closeAllExcept(null);
      releaseActiveBatch();
      this.backend = null;
      this.activeCandidate = null;
      this.emitInitialTerminal(failure, attempt.id);
    };
    const advanceAfterFailure = () => {
      if (transactionState !== 'active' || this.closedByClient) {
        return;
      }
      if (current === null) {
        promoteNextOpenedFallback();
      }
      if (
        current === null
        && openedFallbacks.length === 0
        && attempts.every((attempt) => attempt.settled || attempt.advanced)
      ) {
        releaseActiveBatch();
        this.backend = null;
        this.activeCandidate = null;
        this.connectNext();
      }
    };
    const settleFailure = (attempt: InitialAttempt, failure: AttemptFailure) => {
      if (
        transactionState === 'closed'
        || this.closedByClient
        || attempt.settled
        || attempt.advanced
      ) {
        return;
      }
      attempt.settled = true;
      clearAttemptTimer(attempt);
      removeFallback(attempt);
      this.lastInitialFailure = failure;
      this.lastInitialAttemptId = attempt.id;
      const decision = classifyInitialFailure(failure);
      const reason = describeInitialFailure(failure);
      this.diagnostics.reason = reason;
      this.markAttempt(
        attempt.candidate,
        'error',
        false,
        reason,
        undefined,
        attempt.record.score,
        attempt.record,
      );
      this.routeHealthCache.recordFailure(
        this.routeHealthScope,
        attempt.candidate,
        reason,
        {
          authFailure: decision.action === 'terminate' && decision.category === 'auth',
        },
      );

      if (current === attempt) {
        invalidateCurrent('failure', failure);
      } else {
        closeAttempt(attempt, reason);
      }

      if (this.closedByClient || this.initialTerminalSent) {
        return;
      }
      if (decision.action === 'terminate') {
        finishTerminal(attempt, failure);
        return;
      }
      advanceAfterFailure();
    };
    const settleCommittedFailure = (attempt: InitialAttempt, failure: AttemptFailure) => {
      if (
        transactionState !== 'committed'
        || attempt !== current
        || this.closedByClient
        || this.initialTerminalSent
      ) {
        return;
      }
      const reason = describeInitialFailure(failure);
      this.diagnostics.reason = reason;
      this.markAttempt(
        attempt.candidate,
        'closed',
        true,
        reason,
        undefined,
        attempt.record.score,
        attempt.record,
      );
      const decision = classifyInitialFailure(failure);
      this.routeHealthCache.recordFailure(
        this.routeHealthScope,
        attempt.candidate,
        reason,
        {
          authFailure: decision.action === 'terminate' && decision.category === 'auth',
        },
      );
      finishTerminal(attempt, failure);
    };
    const cancelBatch = (_code?: number, reason?: string) => {
      if (transactionState === 'closed') {
        return;
      }
      transactionState = 'closed';
      clearConfirmationTimer();
      if (current) {
        invalidateCurrent('cancel');
      }
      for (const attempt of attempts) {
        removeFallback(attempt);
        closeAttempt(attempt, reason || 'initial attempt cancelled');
      }
      releaseActiveBatch();
      this.backend = null;
      this.activeCandidate = null;
      this.initialAttemptControl = null;
    };
    this.cancelActiveBatch = cancelBatch;

    this.initialAttemptControl = {
      send: (id, data) => {
        const attempt = current;
        if (
          transactionState !== 'active'
          || this.closedByClient
          || !attempt
          || attempt.id !== id
          || attempt.settled
          || attempt.advanced
        ) {
          return false;
        }
        attempt.backend.send(data);
        return true;
      },
      confirm: (id) => {
        const winner = current;
        if (
          transactionState !== 'active'
          || this.closedByClient
          || !winner
          || winner.id !== id
          || winner.settled
          || winner.advanced
          || !winner.opened
        ) {
          return false;
        }
        transactionState = 'committed';
        winner.settled = true;
        clearConfirmationTimer();
        this.pendingSettle = null;
        closeAllExcept(winner);
        releaseActiveBatch();
        this.initialAttemptControl = null;
        const rttMs = Date.now() - winner.startedAt;
        this.routeHealthCache.recordSuccess(this.routeHealthScope, winner.candidate, rttMs);
        this.markAttempt(
          winner.candidate,
          'open',
          true,
          undefined,
          rttMs,
          winner.record.score,
          winner.record,
        );
        this.diagnostics.stage = 'open';
        this.diagnostics.reason = undefined;
        this.diagnostics.resolvedPath =
          this.diagnostics.resolvedPath || winner.candidate.path;
        this.diagnostics.resolvedEndpoint = winner.candidate.endpoint;
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        return true;
      },
      fail: (id, failure) => {
        const attempt = current;
        if (
          transactionState !== 'active'
          || this.closedByClient
          || !attempt
          || attempt.id !== id
          || attempt.settled
          || attempt.advanced
        ) {
          return false;
        }
        settleFailure(attempt, failure);
        return true;
      },
      cancel: cancelBatch,
    };

    for (const attempt of attempts) {
      attempt.startedAt = Date.now();
      const health = this.routeHealthCache.get(this.routeHealthScope, attempt.candidate);
      const timeoutMs = resolveCandidateTimeoutMs(attempt.candidate, health);
      attempt.timer = this.platform.timers.setTimeout(() => {
        settleFailure(attempt, {
          stage: 'connect',
          kind: 'timeout',
          timer: 'connect',
        });
      }, timeoutMs);
      attempt.backend.start({
        onopen: () => {
          if (transactionState === 'closed' || this.closedByClient) {
            return;
          }
          attempt.opened = true;
          clearAttemptTimer(attempt);
          if (current) {
            openedFallbacks.push(attempt);
            return;
          }
          promote(attempt);
        },
        onmessage: (event) => {
          if (
            transactionState === 'closed'
            || attempt !== current
            || attempt.advanced
          ) {
            return;
          }
          this.initialAttemptPort?.onEvent({
            type: 'message',
            attemptId: attempt.id,
            data: event.data,
          });
        },
        onerror: () => {
          // Typed failures arrive through onfailure. onclose remains the
          // fallback for adapters that expose only the legacy close fact.
        },
        onfailure: (failure) => {
          if (transactionState === 'committed') {
            settleCommittedFailure(attempt, failure);
            return;
          }
          settleFailure(attempt, failure);
        },
        onclose: (event) => {
          if (transactionState === 'committed') {
            const reason = typeof event?.reason === 'string' ? event.reason : '';
            settleCommittedFailure(attempt, {
              stage: 'connect',
              kind: 'ws-close',
              ...(typeof event?.code === 'number' ? { code: event.code } : {}),
              ...(reason ? { reason } : {}),
              cause: event,
            });
            return;
          }
          if (
            transactionState === 'closed'
            || attempt.settled
            || attempt.advanced
          ) {
            return;
          }
          const reason = typeof event?.reason === 'string' ? event.reason : '';
          settleFailure(attempt, {
            stage: attempt.opened ? 'mux' : 'connect',
            kind: 'ws-close',
            ...(typeof event?.code === 'number' ? { code: event.code } : {}),
            ...(reason ? { reason } : {}),
            cause: event,
          });
        },
        onpath: (path, relayTransport, selectedIcePair) => {
          if (
            transactionState === 'closed'
            || this.closedByClient
            || attempt.invalidated
            || attempt.advanced
          ) {
            return;
          }
          attempt.pathDiagnostic = {
            path,
            relayTransport,
            selectedIcePair,
          };
          if (attempt === current) {
            applyAttemptPath(attempt);
          }
        },
      });
    }
  }

  public sendForAttempt(id: number, data: string | ArrayBuffer) {
    if (!this.boundInitial || this.closedByClient || this.initialTerminalSent) {
      return false;
    }
    return this.initialAttemptControl?.send(id, data) || false;
  }

  public confirmAttempt(id: number) {
    if (!this.boundInitial || this.closedByClient || this.initialTerminalSent) {
      return false;
    }
    return this.initialAttemptControl?.confirm(id) || false;
  }

  public failAttempt(id: number, failure: AttemptFailure) {
    if (!this.boundInitial || this.closedByClient || this.initialTerminalSent) {
      return false;
    }
    return this.initialAttemptControl?.fail(id, failure) || false;
  }

  public send(data: string | ArrayBuffer) {
    if (!this.backend || this.backend.readyState !== OPEN) {
      throw new Error('Traversal socket is not open');
    }
    this.backend.send(data);
  }

  /**
   * Upper layer confirms that mux handshake (or equivalent protocol-level
   * readiness) has succeeded on the winning candidate. Only after this call
   * does recordSuccess fire and runner-ups get closed.
   */
  public confirmTransportReady() {
    if (this.boundInitial) {
      return;
    }
    if (this.pendingConfirmationTimer !== null) {
      this.platform.timers.clearTimeout(this.pendingConfirmationTimer);
      this.pendingConfirmationTimer = null;
    }
    const settle = this.pendingSettle;
    this.pendingSettle = null;
    settle?.();
  }

  public close(code?: number, reason?: string) {
    this.closedByClient = true;
    this.clearReconnectTimer();
    if (this.pendingConfirmationTimer !== null) {
      this.platform.timers.clearTimeout(this.pendingConfirmationTimer);
      this.pendingConfirmationTimer = null;
    }
    this.pendingSettle = null;
    this.diagnostics.stage = 'closed';
    this.cancelActiveBatch?.(code, reason);
    this.backend?.close(code, reason);
  }

  public reportFailure(reason: string, options?: { authFailure?: boolean }) {
    if (this.boundInitial) {
      return;
    }
    const message = reason.trim() || 'route failed';
    this.diagnostics.stage = 'error';
    this.diagnostics.reason = message;
    if (!this.activeCandidate) {
      return;
    }
    this.markAttempt(this.activeCandidate, 'error', false, message);
    this.routeHealthCache.recordFailure(this.routeHealthScope, this.activeCandidate, message, {
      authFailure: options?.authFailure === true || this.isAuthFailure(message),
    });
  }
}
