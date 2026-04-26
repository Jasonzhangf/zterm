import type {
  BridgeSocketCloseLike,
  BridgeSocketMessageLike,
  BridgeTransportSocket,
  TraversalAttemptDiagnostic,
  TraversalDiagnostics,
  TraversalPlanCandidate,
  TraversalResolvedPath,
} from './types';
import { buildTraversalPlan } from './config';
import type { TraversalSettingsSource, TraversalTargetSource } from './types';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const WS_CANDIDATE_TIMEOUT_MS = 1800;
const RTC_CANDIDATE_TIMEOUT_MS = 8000;

type IceCandidateStatsLike = {
  candidateType?: string;
};

type Backend = {
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  start(handlers: {
    onopen: () => void;
    onmessage: (event: BridgeSocketMessageLike) => void;
    onerror: (reason?: string) => void;
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (path: TraversalResolvedPath) => void;
  }): void;
};

class WebSocketBackend implements Backend {
  public socket: WebSocket;

  public constructor(private readonly candidate: Extract<TraversalPlanCandidate, { kind: 'ws' }>) {
    this.socket = new WebSocket(candidate.url);
    this.socket.binaryType = 'arraybuffer';
  }

  public get readyState() {
    return this.socket.readyState;
  }

  public start(handlers: {
    onopen: () => void;
    onmessage: (event: BridgeSocketMessageLike) => void;
    onerror: (reason?: string) => void;
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (path: TraversalResolvedPath) => void;
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

  private currentResolvedPath: TraversalResolvedPath = 'rtc-direct';

  public constructor(private readonly candidate: Extract<TraversalPlanCandidate, { kind: 'rtc' }>) {}

  public get readyState() {
    if (this.dataChannel?.readyState === 'open') {
      return OPEN;
    }
    if (this.dataChannel?.readyState === 'closing' || this.dataChannel?.readyState === 'closed') {
      return this.dataChannel.readyState === 'closing' ? CLOSING : CLOSED;
    }
    return this.signalSocket?.readyState === WebSocket.CLOSING ? CLOSING : CONNECTING;
  }

  private async detectResolvedPath() {
    if (!this.peerConnection) {
      return this.currentResolvedPath;
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
        return this.currentResolvedPath;
      }
      const pair = selectedPair as RTCIceCandidatePairStats;
      const local = pair.localCandidateId ? stats.get(pair.localCandidateId) as IceCandidateStatsLike | undefined : undefined;
      const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) as IceCandidateStatsLike | undefined : undefined;
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') {
        this.currentResolvedPath = 'rtc-relay';
      } else {
        this.currentResolvedPath = 'rtc-direct';
      }
      return this.currentResolvedPath;
    } catch (error) {
      console.warn('[TraversalSocket] Failed to inspect RTC stats:', error);
      return this.currentResolvedPath;
    }
  }

  public start(handlers: {
    onopen: () => void;
    onmessage: (event: BridgeSocketMessageLike) => void;
    onerror: (reason?: string) => void;
    onclose: (event?: BridgeSocketCloseLike) => void;
    onpath?: (path: TraversalResolvedPath) => void;
  }) {
    const signalSocket = new WebSocket(this.candidate.signalUrl);
    signalSocket.onopen = async () => {
      try {
        this.signalSocket = signalSocket;
        const peerConnection = new RTCPeerConnection({
          iceServers: this.candidate.iceServers,
          iceTransportPolicy: 'all',
        });
        this.peerConnection = peerConnection;
        const channel = peerConnection.createDataChannel('zterm', {
          ordered: true,
        });
        this.dataChannel = channel;

        channel.binaryType = 'arraybuffer';
        channel.onopen = async () => {
          const nextPath = await this.detectResolvedPath();
          handlers.onpath?.(nextPath);
          handlers.onopen();
        };
        channel.onmessage = (event) => {
          handlers.onmessage({ data: event.data as string | ArrayBuffer });
        };
        channel.onerror = () => handlers.onerror('rtc data channel error');
        channel.onclose = () => handlers.onclose({ code: 1000, reason: 'rtc data channel closed' });

        peerConnection.onicecandidate = (event) => {
          if (!event.candidate) {
            return;
          }
          signalSocket.send(JSON.stringify({
            type: 'rtc-candidate',
            payload: event.candidate.toJSON(),
          }));
        };
        peerConnection.onconnectionstatechange = async () => {
          if (peerConnection.connectionState === 'failed') {
            handlers.onerror('rtc peer connection failed');
            return;
          }
          if (peerConnection.connectionState === 'closed' || peerConnection.connectionState === 'disconnected') {
            handlers.onclose({ code: 1000, reason: `rtc peer ${peerConnection.connectionState}` });
            return;
          }
          if (peerConnection.connectionState === 'connected') {
            const nextPath = await this.detectResolvedPath();
            handlers.onpath?.(nextPath);
          }
        };

        signalSocket.send(JSON.stringify({
          type: 'rtc-init',
          payload: {
            iceServers: this.candidate.iceServers,
          },
        }));

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalSocket.send(JSON.stringify({
          type: 'rtc-offer',
          payload: { sdp: offer.sdp, type: offer.type },
        }));
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
          handlers.onerror(typeof message.payload?.message === 'string' ? message.payload.message : 'rtc signaling error');
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

    signalSocket.onerror = () => handlers.onerror('rtc signaling websocket error');
    signalSocket.onclose = (event) => {
      if (this.dataChannel?.readyState === 'open') {
        return;
      }
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

  public close() {
    try {
      this.dataChannel?.close();
    } catch (error) {
      console.warn('[TraversalSocket] Failed to close RTC data channel:', error);
    }
    try {
      this.peerConnection?.close();
    } catch (error) {
      console.warn('[TraversalSocket] Failed to close RTC peer connection:', error);
    }
    try {
      this.signalSocket?.close();
    } catch (error) {
      console.warn('[TraversalSocket] Failed to close RTC signaling socket:', error);
    }
  }
}

export class TraversalSocket implements BridgeTransportSocket {
  public onopen: ((event?: Event) => void) | null = null;

  public onmessage: ((event: BridgeSocketMessageLike) => void) | null = null;

  public onerror: ((event?: Event) => void) | null = null;

  public onclose: ((event?: BridgeSocketCloseLike) => void) | null = null;

  private readonly diagnostics: TraversalDiagnostics;

  private readonly candidates: TraversalPlanCandidate[];

  private backend: Backend | null = null;

  private activeAttempt: TraversalAttemptDiagnostic | null = null;

  private nextIndex = 0;

  private closedByClient = false;

  public constructor(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options?: {
      overrideUrl?: string;
    },
  ) {
    const plan = buildTraversalPlan(target, settings, options?.overrideUrl);
    this.candidates = plan.candidates;
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

  public getDiagnostics() {
    return {
      ...this.diagnostics,
      attempts: [...this.diagnostics.attempts],
    };
  }

  private markAttempt(candidate: TraversalPlanCandidate, stage: TraversalAttemptDiagnostic['stage'], ok: boolean, reason?: string) {
    if (this.activeAttempt) {
      this.activeAttempt.stage = stage;
      this.activeAttempt.ok = ok;
      this.activeAttempt.reason = reason;
      return;
    }
    const attempt: TraversalAttemptDiagnostic = {
      kind: candidate.kind,
      path: candidate.path,
      endpoint: candidate.endpoint,
      ok,
      stage,
      reason,
    };
    this.diagnostics.attempts.push(attempt);
    this.activeAttempt = attempt;
  }

  private finishFailure(reason: string) {
    this.diagnostics.stage = 'error';
    this.diagnostics.reason = reason;
    this.onclose?.({ code: 1006, reason });
  }

  private connectNext() {
    if (this.closedByClient) {
      return;
    }
    const candidate = this.candidates[this.nextIndex++];
    if (!candidate) {
      this.finishFailure(this.diagnostics.reason || 'No traversal path succeeded');
      return;
    }

    this.activeAttempt = null;
    this.markAttempt(candidate, 'connecting', false);
    const backend: Backend = candidate.kind === 'ws'
      ? new WebSocketBackend(candidate)
      : new WebRtcBackend(candidate);
    this.backend = backend;
    const timeoutMs = candidate.kind === 'ws' ? WS_CANDIDATE_TIMEOUT_MS : RTC_CANDIDATE_TIMEOUT_MS;
    let settled = false;
    let advanced = false;
    const timer = window.setTimeout(() => {
      if (settled || advanced || this.closedByClient) {
        return;
      }
      advanced = true;
      this.diagnostics.reason = `${candidate.kind} connect timeout`;
      this.markAttempt(candidate, 'error', false, this.diagnostics.reason);
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
        this.markAttempt(candidate, 'open', true);
        this.diagnostics.stage = 'open';
        this.diagnostics.reason = undefined;
        this.diagnostics.resolvedPath = candidate.kind === 'rtc' ? 'rtc-direct' : candidate.path;
        this.diagnostics.resolvedEndpoint = candidate.endpoint;
        this.onopen?.();
      },
      onmessage: (event) => {
        this.onmessage?.(event);
      },
      onerror: (reason) => {
        this.diagnostics.reason = reason || `${candidate.kind} error`;
        this.markAttempt(candidate, 'error', false, this.diagnostics.reason);
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
          this.connectNext();
          return;
        }
        this.diagnostics.stage = this.closedByClient ? 'closed' : 'error';
        if (event?.reason) {
          this.diagnostics.reason = event.reason;
        }
        this.onclose?.(event);
      },
      onpath: (path) => {
        this.diagnostics.resolvedPath = path;
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
    this.diagnostics.stage = 'closed';
    this.backend?.close(code, reason);
  }
}
