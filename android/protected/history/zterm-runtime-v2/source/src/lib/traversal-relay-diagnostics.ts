import type { TraversalRelayClientSettings } from './bridge-settings';

export interface TraversalRelayTurnDiagnosticResult {
  ok: boolean;
  hostId: string;
  iceTransportPolicy: 'relay';
  selectedPairFound: boolean;
  candidateTypes: {
    local: string | null;
    remote: string | null;
  };
}

type CandidateStatsLike = {
  candidateType?: string;
};

function requireBrowserRtc() {
  if (typeof WebSocket === 'undefined' || typeof RTCPeerConnection === 'undefined') {
    throw new Error('当前 WebView 不支持 WebRTC/TURN 诊断');
  }
}

async function readSelectedCandidateTypes(peerConnection: RTCPeerConnection) {
  const stats = await peerConnection.getStats();
  let selectedPair: any = null;
  stats.forEach((report) => {
    if (
      !selectedPair
      && report.type === 'candidate-pair'
      && (report as any).state === 'succeeded'
      && (report as any).nominated
    ) {
      selectedPair = report as any;
    }
  });
  const local = selectedPair?.localCandidateId ? stats.get(selectedPair.localCandidateId) as CandidateStatsLike | undefined : undefined;
  const remote = selectedPair?.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) as CandidateStatsLike | undefined : undefined;
  return {
    selectedPairFound: Boolean(selectedPair),
    candidateTypes: {
      local: local?.candidateType || null,
      remote: remote?.candidateType || null,
    },
  };
}

export async function runTraversalRelayTurnDiagnostic(options: {
  relaySettings: TraversalRelayClientSettings;
  hostId: string;
  timeoutMs?: number;
}): Promise<TraversalRelayTurnDiagnosticResult> {
  requireBrowserRtc();
  const hostId = options.hostId.trim();
  if (!hostId) {
    throw new Error('TURN 诊断需要先选择 daemon hostId');
  }
  if (!options.relaySettings.wsClientUrl || !options.relaySettings.accessToken || !options.relaySettings.turnUrl) {
    throw new Error('TURN 诊断缺少 relay ws/client 或 TURN 配置');
  }

  return await new Promise<TraversalRelayTurnDiagnosticResult>((resolve, reject) => {
    const signalUrl = new URL(options.relaySettings.wsClientUrl);
    signalUrl.searchParams.set('token', options.relaySettings.accessToken);
    signalUrl.searchParams.set('hostId', hostId);
    const signalSocket = new WebSocket(signalUrl.toString());
    const peerConnection = new RTCPeerConnection({
      iceServers: [{
        urls: options.relaySettings.turnUrl,
        username: options.relaySettings.turnUsername || undefined,
        credential: options.relaySettings.turnCredential || undefined,
      }],
      iceTransportPolicy: 'relay',
    });
    const channel = peerConnection.createDataChannel('zterm-turn-diagnostic', { ordered: true });
    let settled = false;

    const cleanup = () => {
      try { channel.close(); } catch {}
      try { peerConnection.close(); } catch {}
      try { signalSocket.close(); } catch {}
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const timeout = window.setTimeout(() => fail(new Error('TURN relay-only 诊断超时')), options.timeoutMs || 25000);

    signalSocket.onopen = async () => {
      try {
        signalSocket.send(JSON.stringify({
          type: 'rtc-init',
          payload: {
            iceServers: [{
              urls: options.relaySettings.turnUrl,
              username: options.relaySettings.turnUsername || undefined,
              credential: options.relaySettings.turnCredential || undefined,
            }],
          },
        }));
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalSocket.send(JSON.stringify({ type: 'rtc-offer', payload: { type: offer.type, sdp: offer.sdp } }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    signalSocket.onmessage = async (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type: string; payload?: Record<string, unknown> };
        if (message.type === 'rtc-answer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: String(message.payload?.sdp || ''),
          }));
          return;
        }
        if (message.type === 'rtc-candidate' && message.payload?.candidate) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(message.payload as RTCIceCandidateInit));
          return;
        }
        if (message.type === 'rtc-error') {
          fail(new Error(String(message.payload?.message || 'rtc-error')));
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate || signalSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      signalSocket.send(JSON.stringify({ type: 'rtc-candidate', payload: event.candidate.toJSON() }));
    };
    channel.onopen = async () => {
      try {
        const stats = await readSelectedCandidateTypes(peerConnection);
        const result: TraversalRelayTurnDiagnosticResult = {
          ok: stats.candidateTypes.local === 'relay',
          hostId,
          iceTransportPolicy: 'relay',
          selectedPairFound: stats.selectedPairFound,
          candidateTypes: stats.candidateTypes,
        };
        settled = true;
        window.clearTimeout(timeout);
        cleanup();
        resolve(result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    channel.onerror = () => fail(new Error('TURN relay-only data channel error'));
    signalSocket.onerror = () => fail(new Error('TURN relay-only signaling error'));
    signalSocket.onclose = () => {
      if (!settled) {
        fail(new Error('TURN relay-only signaling closed'));
      }
    };
  });
}
