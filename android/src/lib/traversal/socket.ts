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
  TraversalSelectedIcePairDiagnostic,
} from './types';
import { buildTraversalPlan } from './config';
import type { TraversalSettingsSource, TraversalTargetSource } from './types';
import { selectBestTraversalRoute } from './route-selector';
import {
  defaultTraversalRouteHealthCache,
  type TraversalRouteHealthCache,
  type TraversalRouteHealthScope,
} from './route-health-cache';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const WS_CANDIDATE_TIMEOUT_MS = 1800;
const RTC_DIRECT_OPEN_STABILITY_MS = 1000;
const RTC_DIRECT_CANDIDATE_TIMEOUT_MS = 5000 + RTC_DIRECT_OPEN_STABILITY_MS;
const RTC_RELAY_CANDIDATE_TIMEOUT_MS = 2500;
const RTC_DISCONNECTED_GRACE_MS = 10000;
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

function resolveCandidateTimeoutMs(candidate: TraversalPlanCandidate) {
  if (candidate.kind === 'ws') {
    return WS_CANDIDATE_TIMEOUT_MS;
  }
  return candidate.path === 'rtc-direct'
    ? RTC_DIRECT_CANDIDATE_TIMEOUT_MS
    : RTC_RELAY_CANDIDATE_TIMEOUT_MS;
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
    handlers: {
      onclose: (event?: BridgeSocketCloseLike) => void;
    },
  ) {
    if (this.disconnectedTimer !== null) {
      return;
    }
    try {
      peerConnection.restartIce?.();
    } catch (error) {
      console.warn('[TraversalSocket] Failed to restart RTC ICE after disconnected:', error);
    }
    this.disconnectedTimer = window.setTimeout(() => {
      this.disconnectedTimer = null;
      if (this.peerConnection !== peerConnection || peerConnection.connectionState !== 'disconnected') {
        return;
      }
      this.dispose();
      handlers.onclose({ code: 1006, reason: 'rtc peer disconnected' });
    }, RTC_DISCONNECTED_GRACE_MS);
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
            this.scheduleDisconnectedClose(peerConnection, handlers);
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

  public constructor(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options?: {
      overrideUrl?: string;
      routeHealthCache?: Pick<TraversalRouteHealthCache, 'get' | 'recordSuccess' | 'recordFailure'>;
      routeHealthScope?: TraversalRouteHealthScope;
      autoReconnect?: boolean;
    },
  ) {
    const plan = buildTraversalPlan(target, settings, options?.overrideUrl);
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

  private markAttempt(candidate: TraversalPlanCandidate, stage: TraversalAttemptDiagnostic['stage'], ok: boolean, reason?: string, rttMs?: number, score?: number) {
    if (this.activeAttempt) {
      this.activeAttempt.stage = stage;
      this.activeAttempt.ok = ok;
      this.activeAttempt.reason = reason;
      this.activeAttempt.rttMs = rttMs ?? this.activeAttempt.rttMs;
      this.activeAttempt.score = score ?? this.activeAttempt.score;
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
    const candidate = selection.selected;
    if (!candidate) {
      this.finishFailure(this.diagnostics.reason || 'No traversal path succeeded');
      return;
    }
    const selectedDiagnostic = selection.diagnostics.find((item) =>
      item.path === candidate.path
      && item.endpoint === candidate.endpoint
      && item.candidateId === candidate.id);
    this.attemptedCandidateKeys.add(this.candidateKey(candidate));

    this.activeAttempt = null;
    this.activeCandidate = candidate;
    this.diagnostics.resolvedPath = undefined;
    this.diagnostics.resolvedEndpoint = undefined;
    this.diagnostics.resolvedRelayTransport = undefined;
    this.diagnostics.selectedIcePair = undefined;
    this.markAttempt(candidate, 'connecting', false, undefined, undefined, selectedDiagnostic?.score);
    const backend: Backend = candidate.kind === 'ws'
      ? new WebSocketBackend(candidate)
      : new WebRtcBackend(candidate);
    this.backend = backend;
    const timeoutMs = resolveCandidateTimeoutMs(candidate);
    let settled = false;
    let advanced = false;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      if (settled || advanced || this.closedByClient) {
        return;
      }
      advanced = true;
      this.diagnostics.reason = `${candidate.kind} connect timeout`;
      this.markAttempt(candidate, 'error', false, this.diagnostics.reason);
      this.routeHealthCache.recordFailure(this.routeHealthScope, candidate, this.diagnostics.reason);
      try {
        backend.close(4000, 'connect timeout');
      } catch (error) {
        console.warn('[TraversalSocket] Failed to close timed out backend:', error);
      }
      this.connectNext();
    }, timeoutMs);

    backend.start({
      onopen: () => {
        if (settled || this.closedByClient) {
          return;
        }
        settled = true;
        advanced = true;
        window.clearTimeout(timer);
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        const rttMs = Date.now() - startedAt;
        this.routeHealthCache.recordSuccess(this.routeHealthScope, candidate, rttMs);
        this.markAttempt(candidate, 'open', true, undefined, rttMs, selectedDiagnostic?.score);
        this.diagnostics.stage = 'open';
        this.diagnostics.reason = undefined;
        this.diagnostics.resolvedPath = this.diagnostics.resolvedPath || candidate.path;
        this.diagnostics.resolvedEndpoint = candidate.endpoint;
        this.onopen?.();
      },
      onmessage: (event) => {
        this.onmessage?.(event);
      },
      onerror: (reason) => {
        this.diagnostics.reason = reason || `${candidate.kind} error`;
        this.markAttempt(candidate, 'error', false, this.diagnostics.reason);
        if (!settled) {
          this.routeHealthCache.recordFailure(this.routeHealthScope, candidate, this.diagnostics.reason, {
            authFailure: this.isAuthFailure(this.diagnostics.reason),
          });
        }
        if (settled) {
          this.diagnostics.stage = 'error';
          this.onerror?.();
        }
      },
      onclose: (event) => {
        if (!settled && !this.closedByClient) {
          if (advanced) {
            return;
          }
          advanced = true;
          window.clearTimeout(timer);
          this.diagnostics.reason = event?.reason || `${candidate.kind} closed`;
          this.markAttempt(candidate, this.diagnostics.stage === 'open' ? 'closed' : 'closed', Boolean(settled), this.diagnostics.reason);
          this.routeHealthCache.recordFailure(this.routeHealthScope, candidate, this.diagnostics.reason, {
            authFailure: this.isAuthFailure(this.diagnostics.reason),
          });
          this.connectNext();
          return;
        }
        if (settled && !this.closedByClient) {
          const reason = event?.reason || `${candidate.kind} closed`;
          this.markAttempt(candidate, 'closed', true, reason);
          this.routeHealthCache.recordFailure(this.routeHealthScope, candidate, reason, {
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

  public send(data: string | ArrayBuffer) {
    if (!this.backend || this.backend.readyState !== OPEN) {
      throw new Error('Traversal socket is not open');
    }
    this.backend.send(data);
  }

  public close(code?: number, reason?: string) {
    this.closedByClient = true;
    this.clearReconnectTimer();
    this.diagnostics.stage = 'closed';
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
