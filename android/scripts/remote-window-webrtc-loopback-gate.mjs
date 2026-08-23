import wrtc from '@roamhq/wrtc';

const {
  RTCPeerConnection,
  MediaStream,
  nonstandard: { RTCVideoSource, RTCVideoSink },
} = wrtc;

function waitFor(predicate, label, timeoutMs = 5_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`remote-window loopback timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function runPlan(mediaPlan) {
  const needsOverview = mediaPlan === 'overview-plus-focus';
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const sender = new RTCPeerConnection({ iceServers: [] });
  const sources = [];
  const tracks = [];
  const receivedRoles = [];
  const receivedFramesByRole = new Map();
  const sinks = [];
  const pendingCandidates = new Map([[receiver, []], [sender, []]]);
  const candidateArrival = new Map([[receiver, []], [sender, []]]);
  const candidateApplied = new Map([[receiver, []], [sender, []]]);

  const candidateKey = (candidate) => JSON.stringify(candidate.toJSON?.() ?? candidate);
  const applyCandidate = async (peer, candidate) => {
    await peer.addIceCandidate(candidate);
    candidateApplied.get(peer).push(candidateKey(candidate));
  };
  const forwardCandidate = (peer, candidate) => {
    if (!candidate || peer.signalingState === 'closed') return;
    candidateArrival.get(peer).push(candidateKey(candidate));
    if (!peer.remoteDescription) {
      pendingCandidates.get(peer).push(candidate);
      return;
    }
    void applyCandidate(peer, candidate).catch((error) => {
      if (peer.signalingState !== 'closed') {
        process.stderr.write(`remote-window loopback ICE failure: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
  };

  receiver.onicecandidate = ({ candidate }) => {
    forwardCandidate(sender, candidate);
  };
  sender.onicecandidate = ({ candidate }) => {
    forwardCandidate(receiver, candidate);
  };
  receiver.ontrack = (event) => {
    const role = event.streams[0]?.id === 'overview' ? 'overview' : 'focus';
    receivedRoles.push(role);
    receivedFramesByRole.set(role, 0);
    const sink = new RTCVideoSink(event.track);
    sink.onframe = () => {
      receivedFramesByRole.set(role, (receivedFramesByRole.get(role) ?? 0) + 1);
    };
    sinks.push(sink);
  };

  try {
    receiver.addTransceiver('video', { direction: 'recvonly' });
    if (needsOverview) receiver.addTransceiver('video', { direction: 'recvonly' });

    const focusSource = new RTCVideoSource({ isScreencast: true });
    const focusTrack = focusSource.createTrack();
    sources.push(focusSource);
    tracks.push(focusTrack);
    sender.addTrack(focusTrack);

    if (needsOverview) {
      const overviewSource = new RTCVideoSource({ isScreencast: true });
      const overviewTrack = overviewSource.createTrack();
      const overviewStream = new MediaStream({ id: 'overview' });
      sources.push(overviewSource);
      tracks.push(overviewTrack);
      sender.addTrack(overviewTrack, overviewStream);
    }

    const offer = await receiver.createOffer();
    await receiver.setLocalDescription(offer);
    await sender.setRemoteDescription(offer);
    for (const candidate of pendingCandidates.get(sender).splice(0)) {
      await applyCandidate(sender, candidate);
    }
    const answer = await sender.createAnswer();
    await sender.setLocalDescription(answer);
    await receiver.setRemoteDescription(answer);
    for (const candidate of pendingCandidates.get(receiver).splice(0)) {
      await applyCandidate(receiver, candidate);
    }

    for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
      sources.forEach((source, laneIndex) => {
        source.onFrame({
          width: 2,
          height: 2,
          data: Buffer.alloc(6, laneIndex + frameIndex + 1),
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const expectedRoles = needsOverview ? ['focus', 'overview'] : ['focus'];
    await waitFor(() => expectedRoles.every((role) => receivedRoles.includes(role)), `${mediaPlan} tracks`);
    await waitFor(
      () => expectedRoles.every((role) => (receivedFramesByRole.get(role) ?? 0) >= 3),
      `${mediaPlan} continuous frames`,
    );
    await waitFor(
      () => receiver.iceGatheringState === 'complete' && sender.iceGatheringState === 'complete',
      `${mediaPlan} ICE gathering`,
    );
    await waitFor(
      () => [receiver, sender].every((peer) => (
        candidateApplied.get(peer).length === candidateArrival.get(peer).length
      )),
      `${mediaPlan} ICE application`,
    );
    if (receiver.getTransceivers().length !== expectedRoles.length) {
      throw new Error(`${mediaPlan} negotiated ${receiver.getTransceivers().length} receiver lanes; expected ${expectedRoles.length}`);
    }
    for (const peer of [receiver, sender]) {
      const arrived = candidateArrival.get(peer);
      const applied = candidateApplied.get(peer);
      if (arrived.length === 0) {
        throw new Error(`${mediaPlan} did not gather an ICE candidate`);
      }
      if (applied.some((candidate, index) => candidate !== arrived[index])) {
        throw new Error(`${mediaPlan} ICE candidate order changed while flushing`);
      }
    }
    return {
      mediaPlan,
      receivedRoles: receivedRoles.slice().sort(),
      framesByRole: Object.fromEntries(receivedFramesByRole),
      iceOrderPreserved: true,
    };
  } finally {
    receiver.onicecandidate = null;
    receiver.ontrack = null;
    sender.onicecandidate = null;
    sinks.forEach((sink) => sink.stop());
    tracks.forEach((track) => track.stop());
    receiver.close();
    sender.close();
    if (tracks.some((track) => track.readyState !== 'ended')) {
      throw new Error(`${mediaPlan} left a live local track after cleanup`);
    }
  }
}

const results = [];
results.push(await runPlan('single-focus'));
results.push(await runPlan('overview-plus-focus'));
await new Promise((resolve) => setTimeout(resolve, 250));
process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
