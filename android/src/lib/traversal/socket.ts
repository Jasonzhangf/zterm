import type {
  BridgeSocketCloseLike,
  BridgeSocketMessageLike,
  BridgeTransportSocket,
  TraversalResolvedRelayTransport,
  TraversalIceCandidateDiagnostic,
  TraversalAttemptDiagnostic,
  TraversalDiagnostics,
  TraversalPlanCandidate,
  TraversalResolvedPath,
  TraversalRouteHealthRecord,
  TraversalSelectedIcePairDiagnostic,
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

type IceCandidateStatsLike = {
  id?: string;
  candidateType?: string;
  address?: string;
  ip?: string;
  port?: number;
  protocol?: string;
  networkType?: string;
  relayProtocol?: string;
  url?: string;
};

function computeTraversalReconnectDelay(attempt: number) {
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
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
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (
      path: TraversalResolvedPath,
      relayTransport?: TraversalResolvedRelayTransport,
      selectedIcePair?: TraversalSelectedIcePairDiagnostic,
    ) => void;
  }): void;
};

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
  public socket: WebSocket;

  public constructor(private readonly candidate: Extract<TraversalPlanCandidate, { kind: 'ws' }>) {
    this.socket = new WebSocket(candidate.url);
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
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (
      path: TraversalResolvedPath,
      relayTransport?: TraversalResolvedRelayTransport,
      selectedIcePair?: TraversalSelectedIcePairDiagnostic,
    ) => void;
  }) {
    this.socket.onopen = () => {
      handlers.onpath?.(this.candidate.path);
      handlers.onopen();
    };
    this.socket.onmessage = (event) => {
      handlers.onmessage({ data: event.data as string | ArrayBuffer });
    };
    this.socket.onerror = () => handlers.onerror('websocket error');
    this.socket.onclose = (event) => handlers.onclose({
      code: typeof event?.code === 'number' ? event.code : 1000,
      reason: typeof event?.reason === 'string' ? event.reason : '',
    });
  }

  public send(data: string | ArrayBuffer) {
    this.socket.send(data);
  }

  public close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }
}

class WebRtcBackend implements Backend {
  private signalSocket: WebSocket | null = null;

  private peerConnection: RTCPeerConnection | null = null;

  private dataChannel: RTCDataChannel | null = null;

  private disconnectedTimer: number | null = null;

  private openStabilityTimer: number | null = null;

  private openPublished = false;

  private disposed = false;

  private currentResolvedPath: TraversalResolvedPath;
  private currentResolvedRelayTransport: TraversalResolvedRelayTransport | undefined;

  public constructor(private readonly candidate: Extract<TraversalPlanCandidate, { kind: 'rtc' }>) {
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
    return this.signalSocket?.readyState === WebSocket.CLOSING ? CLOSING : CONNECTING;
  }

  public get bufferedAmount() {
    return Math.max(0, Math.floor(this.dataChannel?.bufferedAmount || 0));
  }

  private buildIceCandidateDiagnostic(report?: IceCandidateStatsLike): TraversalIceCandidateDiagnostic | undefined {
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
      let selectedPair: RTCStats | null = null;
      stats.forEach((report) => {
        if (!selectedPair && report.type === 'candidate-pair' && (report as RTCIceCandidatePairStats).state === 'succeeded' && (report as RTCIceCandidatePairStats).nominated) {
          selectedPair = report;
        }
      });
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
      const pair = selectedPair as RTCIceCandidatePairStats;
      const local = pair.localCandidateId ? stats.get(pair.localCandidateId) as IceCandidateStatsLike | undefined : undefined;
      const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) as IceCandidateStatsLike | undefined : undefined;
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

  private sendSignalMessage(signalSocket: WebSocket, message: { type: string; payload?: unknown }) {
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

  private clearDisconnectedTimer() {
    if (this.disconnectedTimer === null) {
      return;
    }
    window.clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
  }

  private clearOpenStabilityTimer() {
    if (this.openStabilityTimer === null) {
      return;
    }
    window.clearTimeout(this.openStabilityTimer);
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
    peerConnection: RTCPeerConnection,
    signalSocket: WebSocket,
    handlers: {
      onclose: (event?: BridgeSocketCloseLike) => void;
    },
  ) {
    if (this.disconnectedTimer !== null) {
      return;
    }
    this.initiateIceRestart(peerConnection, signalSocket);
    this.disconnectedTimer = window.setTimeout(() => {
      this.disconnectedTimer = null;
      if (this.peerConnection !== peerConnection || peerConnection.connectionState !== 'disconnected') {
        return;
      }
      this.dispose();
      handlers.onclose({ code: 1006, reason: 'rtc peer disconnected' });
    }, RTC_DISCONNECTED_GRACE_MS);
  }

  private initiateIceRestart(
    peerConnection: RTCPeerConnection,
    signalSocket: WebSocket,
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
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (
      path: TraversalResolvedPath,
      relayTransport?: TraversalResolvedRelayTransport,
      selectedIcePair?: TraversalSelectedIcePairDiagnostic,
    ) => void;
  }) {
    const signalSocket = new WebSocket(this.candidate.signalUrl);
    this.signalSocket = signalSocket;
    signalSocket.onopen = async () => {
      try {
        if (this.disposed || this.signalSocket !== signalSocket) {
          return;
        }
        const peerConnection = new RTCPeerConnection({
          iceServers: this.candidate.iceServers,
          iceTransportPolicy: this.candidate.iceTransportPolicy,
        });
        this.peerConnection = peerConnection;
        const channel = peerConnection.createDataChannel('zterm', {
          ordered: true,
        });
        this.dataChannel = channel;
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
          this.openStabilityTimer = window.setTimeout(() => {
            this.openStabilityTimer = null;
            void publishOpen();
          }, RTC_DIRECT_OPEN_STABILITY_MS);
        };
        channel.onmessage = (event) => {
          handlers.onmessage({ data: event.data as string | ArrayBuffer });
        };
        channel.onerror = () => handlers.onerror('rtc data channel error');
        channel.onclose = () => {
          this.dispose();
          handlers.onclose({ code: 1000, reason: 'rtc data channel closed' });
        };

        peerConnection.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }
          this.sendSignalMessage(signalSocket, {
            type: 'rtc-candidate',
            payload: event.candidate.toJSON(),
          });
        };
        peerConnection.onconnectionstatechange = async () => {
          if (peerConnection.connectionState === 'failed') {
            this.dispose();
            handlers.onclose({ code: 1006, reason: 'rtc peer connection failed' });
            return;
          }
          if (peerConnection.connectionState === 'closed') {
            this.dispose();
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
        await peerConnection.setLocalDescription(offer);
        if (!this.sendSignalMessage(signalSocket, {
          type: 'rtc-offer',
          payload: { sdp: offer.sdp, type: offer.type },
        })) {
          throw new Error('rtc signaling websocket closed before offer');
        }
      } catch (error) {
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
          this.dispose();
          handlers.onclose({ code: 4004, reason });
          return;
        }
        if (message.type === 'rtc-answer') {
          if (!this.peerConnection) {
            handlers.onerror('rtc answer before peer init');
            return;
          }
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: typeof message.payload?.sdp === 'string' ? message.payload.sdp : '',
          }));
          return;
        }
        if (message.type === 'rtc-candidate' && this.peerConnection && message.payload?.candidate) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(message.payload as RTCIceCandidateInit));
        }
      } catch (error) {
        handlers.onerror(error instanceof Error ? error.message : 'rtc signaling parse error');
      }
    };

    signalSocket.onerror = () => {
      if (this.dataChannel?.readyState === 'open') {
        return;
      }
      handlers.onerror('rtc signaling websocket error');
    };
    signalSocket.onclose = (event) => {
      if (this.dataChannel?.readyState === 'open') {
        return;
      }
      this.dispose();
      handlers.onclose({ code: event.code, reason: event.reason || 'rtc signaling websocket closed' });
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

export class TraversalSocket implements BridgeTransportSocket {
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

  private reconnectTimer: number | null = null;

  private readonly routeHealthCache: Pick<TraversalRouteHealthCache, 'get' | 'recordSuccess' | 'recordFailure'>;

  private readonly routeHealthScope: TraversalRouteHealthScope;

  private readonly autoReconnect: boolean;

  private readonly requireOpenConfirmation: boolean;

  private cancelActiveBatch: ((code?: number, reason?: string) => void) | null = null;

  private pendingConfirmationTimer: number | null = null;

  private pendingSettle: (() => void) | null = null;

  public constructor(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options?: {
      overrideUrl?: string;
      routeHealthCache?: Pick<TraversalRouteHealthCache, 'get' | 'recordSuccess' | 'recordFailure'>;
      routeHealthScope?: TraversalRouteHealthScope;
      autoReconnect?: boolean;
      requireOpenConfirmation?: boolean;
    },
  ) {
    const plan = buildTraversalPlanCached(target, settings, options?.overrideUrl);
    this.candidates = plan.candidates;
    this.traversalPathPriority = plan.candidates
      .map((candidate) => candidate.path)
      .filter((path, index, paths) => paths.indexOf(path) === index);
    this.routeHealthCache = options?.routeHealthCache || defaultTraversalRouteHealthCache;
    this.routeHealthScope = options?.routeHealthScope || {
      accountId: settings.traversalRelay?.userId,
      daemonHostId: target.relayHostId || target.daemonHostId,
    };
    this.autoReconnect = options?.autoReconnect === true;
    this.requireOpenConfirmation = options?.requireOpenConfirmation === true;
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
    window.clearTimeout(this.reconnectTimer);
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
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByClient) {
        return;
      }
      this.attemptedCandidateKeys.clear();
      this.connectNext();
    }, delay);
  }

  private connectNext() {
    if (this.closedByClient) {
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
      this.finishFailure(this.diagnostics.reason || 'No traversal path succeeded');
      return;
    }
    // Parallel batch: every selectable ws candidate races with the head of the
    // rtc queue (rtc-direct before rtc-relay, preserving the signal-session
    // ordering). The first onopen wins and closes the rest. Failed ws
    // candidates retire within the batch; rtc candidates stay ordered.
    const selectableDiagnostics = selection.diagnostics.filter((item) => item.selectable);
    const pool = selectableDiagnostics.length > 0 ? selectableDiagnostics : selection.diagnostics;
    const poolIds = new Set(pool.map((item) => item.candidateId));
    const poolCandidates = remainingCandidates.filter((item) => poolIds.has(item.id));
    const wsBatch = poolCandidates.filter((item) => item.kind === 'ws');
    const rtcQueue = poolCandidates.filter((item) => item.kind === 'rtc');
    const rtcHead = rtcQueue[0] ?? null;
    const batch = rtcHead ? [...wsBatch, rtcHead] : wsBatch;
    if (batch.length === 0) {
      this.finishFailure(this.diagnostics.reason || 'No traversal path succeeded');
      return;
    }

    // The whole batch is claimed up-front so concurrent callbacks and the next
    // connectNext() (after a batch-wide failure) cannot re-select a candidate.
    for (const item of batch) {
      this.attemptedCandidateKeys.add(this.candidateKey(item));
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
      timer: number | null;
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
        backend: item.kind === 'ws' ? new WebSocketBackend(item) : new WebRtcBackend(item),
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
          window.clearTimeout(attempt.timer);
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
        window.clearTimeout(candidate.timer);
        candidate.timer = null;
      }
      this.backend = candidate.backend;
      this.activeCandidate = candidate.candidate;
      this.pendingSettle = () => settleWinner(candidate);
      this.pendingConfirmationTimer = window.setTimeout(() => {
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
        window.clearTimeout(attempt.timer);
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
        window.clearTimeout(attempt.timer);
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
          window.clearTimeout(other.timer);
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
      attempt.timer = window.setTimeout(() => {
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
              window.clearTimeout(attempt.timer);
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
    if (this.pendingConfirmationTimer !== null) {
      window.clearTimeout(this.pendingConfirmationTimer);
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
      window.clearTimeout(this.pendingConfirmationTimer);
      this.pendingConfirmationTimer = null;
    }
    this.pendingSettle = null;
    this.diagnostics.stage = 'closed';
    this.cancelActiveBatch?.(code, reason);
    this.backend?.close(code, reason);
  }

  public reportFailure(reason: string, options?: { authFailure?: boolean }) {
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
