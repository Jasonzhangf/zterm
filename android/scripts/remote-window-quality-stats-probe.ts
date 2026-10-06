import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import wrtc from '@roamhq/wrtc';

import {
  createRemoteWindowReceiverRuntime,
  type RemoteWindowReceiverStartResult,
} from '../src/lib/remote-window-receiver-runtime';
import {
  resolveRemoteWindowVideoAdaptiveDecision,
  type RemoteWindowVideoStatsSample,
} from '../src/lib/remote-window-video-quality';
import { resolveRemoteWindowStreamGroupBudget } from '../src/server/remote-window-quality';
import type {
  RemoteWindowStreamAnswerV2Payload,
  RemoteWindowStreamIceCandidate,
  RemoteWindowStreamRtcDescription,
  RemoteWindowStreamStartedOfferV2Payload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowVideoProfile,
} from '../src/lib/types';

type LaneRole = 'focus' | 'overview';
type CaseName = 'policy-pressure' | 'policy-recovery' | 'receiver-lanes' | 'receiver-restart';
type ReceiverCaseName = 'receiver-lanes' | 'receiver-restart';

const CASES: readonly CaseName[] = ['policy-pressure', 'policy-recovery', 'receiver-lanes', 'receiver-restart'];
const RECEIVER_CASES: readonly ReceiverCaseName[] = ['receiver-lanes', 'receiver-restart'];

// Hash only the Q1 product surface so the value is comparable to the frozen
// candidate patch (tests + source), independent of this probe's own edits.
const PRODUCT_FILES = [
  'android/src/lib/remote-window-receiver-runtime.ts',
  'android/src/lib/remote-window-video-quality.ts',
  'android/src/lib/remote-window-receiver-runtime.test.ts',
  'android/src/lib/remote-window-video-quality.test.ts',
] as const;

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

interface ProbeVideoSource {
  createTrack(): MediaStreamTrack;
  onFrame(frame: { width: number; height: number; data: Uint8Array }): void;
}

interface ProbeVideoSink {
  onframe: ((event: { frame: { width: number; height: number; data: Uint8Array } }) => void) | null;
  stop(): void;
}

// Real @roamhq/wrtc bindings. Types are the WebRTC polyfill API surface; the
// runtime receives the same objects the product would use on-device.
const {
  RTCPeerConnection: WrtcPeerConnection,
  MediaStream: WrtcMediaStream,
  nonstandard: {
    RTCVideoSource: WrtcVideoSourceCtor,
    RTCVideoSink: WrtcVideoSinkCtor,
  },
} = wrtc as unknown as {
  RTCPeerConnection: new (config?: RTCConfiguration) => RTCPeerConnection;
  MediaStream: new () => MediaStream;
  nonstandard: {
    RTCVideoSource: new (init?: { isScreencast?: boolean }) => ProbeVideoSource;
    RTCVideoSink: new (track: MediaStreamTrack) => ProbeVideoSink;
  };
};

class ConsumerBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerBlocked';
  }
}

class ConsumerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerFailure';
  }
}

interface CaseExecution {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  assertions: Record<string, boolean>;
  messages: string[];
  result: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface NativeRegistry {
  runtime: ReturnType<typeof createRemoteWindowReceiverRuntime> | null;
  receiverPeers: RTCPeerConnection[];
  senderPeers: RTCPeerConnection[];
  sinks: ProbeVideoSink[];
  tracks: MediaStreamTrack[];
  sources: ProbeVideoSource[];
  streams: MediaStream[];
}

interface ProbeStream {
  streamId: string;
  lanes: readonly LaneRole[];
  startResult: RemoteWindowReceiverStartResult;
  sender: {
    peer: RTCPeerConnection;
    sources: ProbeVideoSource[];
    tracks: MediaStreamTrack[];
    pendingCandidates: RemoteWindowStreamIceCandidate[];
    errors: string[];
  };
  sinks: ProbeVideoSink[];
  decodedFrames: Map<LaneRole, number>;
  committedFrames: Map<LaneRole, number>;
  frameIds: Map<LaneRole, number>;
  frameShapes: Map<LaneRole, { width: number; height: number; dataLength: number }>;
  emitFrames(rounds: number): Promise<void>;
}

function usage(): string {
  return [
    'usage: remote-window-quality-stats-probe.ts --case <case> --output-dir <dir>',
    `cases: ${CASES.join(', ')}`,
    'requires NODE_OPTIONS=--expose-gc for natural wrtc finalization.',
    'writes <output-dir>/<case>.json and <output-dir>/<case>.raw.json; natural exit 0 only on PASS.',
  ].join('\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shasum(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function resolveAddonPath(): string {
  const requireFromHere = createRequire(import.meta.url);
  const wrtcMainPath = requireFromHere.resolve('@roamhq/wrtc/lib/index.js');
  const platformMainPath = createRequire(wrtcMainPath).resolve('@roamhq/wrtc-darwin-arm64');
  const addonPath = join(dirname(platformMainPath), 'wrtc.node');
  if (!requireFromHere.resolve(addonPath)) {
    // unreachable: createRequire only used to keep the loader consistent
    throw new Error(`wrtc addon not resolvable at ${addonPath}`);
  }
  return addonPath;
}

function readWrtcVersion(): string {
  const requireFromHere = createRequire(import.meta.url);
  const mainPath = requireFromHere.resolve('@roamhq/wrtc/lib/index.js');
  const packageJsonPath = resolve(dirname(mainPath), '..', 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  return parsed.version ?? 'unknown';
}

function computeProductDiffSha(): string {
  const out = execFileSync('git', ['diff', '--', ...PRODUCT_FILES], { cwd: repoRoot });
  return createHash('sha256').update(out).digest('hex');
}

function parseArgs(argv: string[]): { caseName: CaseName; outputDir: string } {
  const args = argv.slice(2);
  let caseName: CaseName | null = null;
  let outputDir: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--case') {
      caseName = (args[index + 1] ?? null) as CaseName | null;
      index += 1;
    } else if (arg === '--output-dir') {
      outputDir = args[index + 1] ?? null;
      index += 1;
    }
  }
  if (!caseName || !outputDir) {
    throw new ConsumerFailure(`missing --case/--output-dir; ${usage()}`);
  }
  if (!CASES.includes(caseName)) {
    throw new ConsumerFailure(`unknown case ${caseName}; expected one of ${CASES.join(', ')}`);
  }
  return { caseName, outputDir };
}

function normalizeCandidate(candidate: {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}): RemoteWindowStreamIceCandidate {
  return {
    candidate: String(candidate.candidate ?? ''),
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = () => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        rejectPromise(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

function makeTarget(multiLane: boolean): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: multiLane ? 'target-dual' : 'target-single',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.apple.TextEdit',
      pid: 1,
      windowId: 'window-1',
      title: 'probe pane',
      windowBoundsTopLeftPx: { x: 0, y: 0, width: 960, height: 640 },
      cropRectTopLeftPx: { x: 0, y: 0, width: 960, height: 640 },
    },
    ...(multiLane
      ? {
          compositeWindows: [{
            windowId: 'window-2',
            title: 'overview pane',
            windowBoundsTopLeftPx: { x: 0, y: 0, width: 480, height: 320 },
            cropRectTopLeftPx: { x: 0, y: 0, width: 480, height: 320 },
          }],
        }
      : {}),
    inputTarget: { kind: 'app-window', itermSessionId: 'probe-session' },
    streamMode: 'view',
    focusPolicy: 'no-focus-steal',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-10-03T00:00:00.000Z',
    },
  };
}

function buildI420Frame(width: number, height: number, round: number, laneIndex: number): Uint8Array {
  const ySize = width * height;
  const uvSize = (width >> 1) * (height >> 1);
  const data = new Uint8Array(ySize + uvSize * 2);
  // Low-entropy luma with a moving bar: real inter-frame motion, cheap to
  // encode so the encoder keeps pace with the probe's emission loop.
  data.fill(96, 0, ySize);
  const barWidth = 16;
  const barStart = (round * 13 + laneIndex * 7) % width;
  for (let y = 0; y < height; y += 1) {
    for (let offset = 0; offset < barWidth; offset += 1) {
      data[y * width + ((barStart + offset) % width)] = 200;
    }
  }
  data.fill(128, ySize);
  return data;
}

function plainBinding(binding: {
  streamId: string;
  mediaPlanVersion: number;
  lane: LaneRole;
  mediaEpoch: number;
  trackId: string;
}): Record<string, unknown> {
  return {
    streamId: binding.streamId,
    mediaPlanVersion: binding.mediaPlanVersion,
    lane: binding.lane,
    mediaEpoch: binding.mediaEpoch,
    trackId: binding.trackId,
  };
}

function plainSample(sample: RemoteWindowVideoStatsSample | null): Record<string, unknown> | null {
  if (!sample) {
    return null;
  }
  return {
    sampledAtMs: sample.sampledAtMs,
    lane: sample.lane ?? null,
    mediaEpoch: sample.mediaEpoch ?? null,
    trackId: sample.trackId ?? null,
    ssrc: sample.ssrc ?? null,
    mid: sample.mid ?? null,
    transportId: sample.transportId ?? null,
    selectedCandidatePairId: sample.selectedCandidatePairId ?? null,
    receivedBitrateBps: sample.receivedBitrateBps ?? null,
    rttMs: sample.rttMs ?? null,
    availableIncomingBitrateBps: sample.availableIncomingBitrateBps ?? null,
    framesPerSecond: sample.framesPerSecond ?? null,
    framesDropped: sample.framesDropped ?? null,
    freezeCount: sample.freezeCount ?? null,
    jitterBufferDelayMs: sample.jitterBufferDelayMs ?? null,
    receivedPacketLossRatio: sample.receivedPacketLossRatio ?? null,
  };
}

function createNativeRegistry(): NativeRegistry {
  return {
    runtime: null,
    receiverPeers: [],
    senderPeers: [],
    sinks: [],
    tracks: [],
    sources: [],
    streams: [],
  };
}

function releaseNative(registry: NativeRegistry): string[] {
  const errors: string[] = [];
  for (const sink of registry.sinks) {
    try {
      sink.onframe = null;
      sink.stop();
    } catch (error) {
      errors.push(`sink stop: ${messageOf(error)}`);
    }
  }
  for (const track of registry.tracks) {
    try {
      track.stop();
    } catch (error) {
      errors.push(`track stop: ${messageOf(error)}`);
    }
  }
  for (const peer of registry.senderPeers) {
    try {
      peer.onicecandidate = null;
      peer.close();
    } catch (error) {
      errors.push(`sender close: ${messageOf(error)}`);
    }
  }
  try {
    registry.runtime?.dispose('probe cleanup');
  } catch (error) {
    errors.push(`runtime dispose: ${messageOf(error)}`);
  }
  registry.sinks.length = 0;
  registry.tracks.length = 0;
  registry.sources.length = 0;
  registry.streams.length = 0;
  registry.senderPeers.length = 0;
  registry.receiverPeers.length = 0;
  registry.runtime = null;
  return errors;
}

async function releaseNativeMemory(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    return;
  }
  for (let index = 0; index < 4; index += 1) {
    gc();
    await delay(40);
  }
}

async function startProbeStream(
  runtime: ReturnType<typeof createRemoteWindowReceiverRuntime>,
  registry: NativeRegistry,
  receivedTracks: Map<string, MediaStreamTrack>,
  streamId: string,
  lanes: readonly LaneRole[],
): Promise<ProbeStream> {
  const target = makeTarget(lanes.includes('overview'));
  const peer = new WrtcPeerConnection({ iceServers: [] });
  registry.senderPeers.push(peer);
  const sources: ProbeVideoSource[] = [];
  const tracks: MediaStreamTrack[] = [];
  const pendingCandidates: RemoteWindowStreamIceCandidate[] = [];
  const errors: string[] = [];

  peer.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    const candidate = normalizeCandidate(event.candidate);
    void runtime.addIceCandidate({ streamId, candidate }).catch((error) => {
      errors.push(`sender->receiver candidate rejected: ${messageOf(error)}`);
    });
  };

  const startRemote = async (
    _offer: RemoteWindowStreamRtcDescription | undefined,
  ): Promise<RemoteWindowStreamStartedOfferV2Payload> => {
    const mediaBindings: Array<{ role: LaneRole; epoch: number; mediaStreamId: string; trackId: string }> = [];
    for (const lane of lanes) {
      const source = new WrtcVideoSourceCtor({ isScreencast: true });
      const track = source.createTrack();
      const stream = new WrtcMediaStream();
      peer.addTrack(track, stream);
      sources.push(source);
      tracks.push(track);
      registry.sources.push(source);
      registry.tracks.push(track);
      registry.streams.push(stream);
      mediaBindings.push({ role: lane, epoch: 0, mediaStreamId: `${streamId}:${lane}`, trackId: track.id });
    }
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const sdp = peer.localDescription?.sdp ?? offer.sdp ?? '';
    return {
      requestId: `rw-${streamId}`,
      streamId,
      mediaPlan: lanes.includes('overview') ? 'overview-plus-focus' : 'single-focus',
      mediaPlanVersion: 2,
      targetId: target.streamTargetId,
      offer: { type: 'offer', sdp },
      mediaBindings,
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: FRAME_WIDTH,
        frameHeight: FRAME_HEIGHT,
        frameRate: 30,
        targetKind: 'app-window',
      },
      transport: { kind: 'webrtc-video' },
    };
  };

  const sendIceCandidate = (candidate: RemoteWindowStreamIceCandidate, _requestId?: string) => {
    if (!peer.remoteDescription) {
      pendingCandidates.push(candidate);
      return;
    }
    void peer.addIceCandidate(candidate).catch((error) => {
      errors.push(`receiver->sender candidate rejected: ${messageOf(error)}`);
    });
  };

  const sendAnswer = async (answer: RemoteWindowStreamAnswerV2Payload) => {
    await peer.setRemoteDescription(answer.answer);
    for (const candidate of pendingCandidates.splice(0)) {
      await peer.addIceCandidate(candidate);
    }
  };

  const startResult = await runtime.startStream({
    streamId,
    target,
    iceServers: [],
    protocolVersion: 2,
    sendIceCandidate,
    startRemote,
    sendAnswer,
  });

  const sinks: ProbeVideoSink[] = [];
  const decodedFrames = new Map<LaneRole, number>();
  const committedFrames = new Map<LaneRole, number>();
  const frameIds = new Map<LaneRole, number>();
  const frameShapes = new Map<LaneRole, { width: number; height: number; dataLength: number }>();

  for (const binding of startResult.bindings) {
    const track = receivedTracks.get(binding.trackId)
      ?? binding.mediaStream.getTracks().find((candidate) => candidate.id === binding.trackId)
      ?? (binding.mediaStream.getTracks().length === 1 ? binding.mediaStream.getTracks()[0] : undefined);
    if (!track) {
      throw new ConsumerFailure(
        `receiver binding ${binding.lane} (trackId=${binding.trackId}) exposes no local track in stream ${streamId}`,
      );
    }
    const sink = new WrtcVideoSinkCtor(track);
    registry.sinks.push(sink);
    decodedFrames.set(binding.lane, 0);
    committedFrames.set(binding.lane, 0);
    frameIds.set(binding.lane, 0);
    sink.onframe = (event) => {
      const frame = event.frame;
      if (!frame) {
        return;
      }
      decodedFrames.set(binding.lane, (decodedFrames.get(binding.lane) ?? 0) + 1);
      frameShapes.set(binding.lane, { width: frame.width, height: frame.height, dataLength: frame.data.length });
      const frameId = (frameIds.get(binding.lane) ?? 0) + 1;
      frameIds.set(binding.lane, frameId);
      const accepted = startResult.commitDecodedFrame({
        streamId,
        mediaPlanVersion: 2,
        lane: binding.lane,
        mediaEpoch: binding.mediaEpoch,
        trackId: binding.trackId,
        frameId,
        width: frame.width,
        height: frame.height,
      });
      if (accepted) {
        committedFrames.set(binding.lane, (committedFrames.get(binding.lane) ?? 0) + 1);
      }
    };
    sinks.push(sink);
  }

  const emitFrames = async (rounds: number) => {
    for (let round = 0; round < rounds; round += 1) {
      sources.forEach((source, laneIndex) => {
        source.onFrame({
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          data: buildI420Frame(FRAME_WIDTH, FRAME_HEIGHT, round, laneIndex),
        });
      });
      await delay(33);
    }
  };

  return {
    streamId,
    lanes,
    startResult,
    sender: { peer, sources, tracks, pendingCandidates, errors },
    sinks,
    decodedFrames,
    committedFrames,
    frameIds,
    frameShapes,
    emitFrames,
  };
}

async function stopProbeStream(runtime: ReturnType<typeof createRemoteWindowReceiverRuntime>, stream: ProbeStream) {
  for (const sink of stream.sinks) {
    sink.onframe = null;
    sink.stop();
  }
  stream.sender.peer.onicecandidate = null;
  for (const track of stream.sender.tracks) {
    try {
      track.stop();
    } catch {
      // sender track cleanup must not mask stream cleanup
    }
  }
  try {
    stream.sender.peer.close();
  } catch {
    // sender close is best-effort
  }
  runtime.stopStream(stream.streamId);
}

function buildPressuringSample(sampledAtMs: number): RemoteWindowVideoStatsSample {
  return {
    sampledAtMs,
    receivedBitrateBps: 20_000_000,
    framesDropped: 0,
    freezeCount: 0,
    rttMs: 20,
    availableOutgoingBitrateBps: 8_000_000,
    receivedPacketLossRatio: 0.08,
  };
}

function buildHealthySample(sampledAtMs: number): RemoteWindowVideoStatsSample {
  return {
    sampledAtMs,
    availableOutgoingBitrateBps: 30_000_000,
    // Health needs an established received interval: both the received-bitrate
    // gauge and a usable (non-null) receive-loss interval. An fps-only or
    // zero-traffic tick is unknown under R3 and must hold, never prove recovery.
    receivedBitrateBps: 30_000_000,
    receivedPacketLossRatio: 0,
    framesPerSecond: 30,
    rttMs: 20,
  };
}

// R3 freezes `profile.maxBitrateBps` as the group total budget:
// `overviewMaxBitrateBps` is a share inside that total, and only the daemon's
// `resolveRemoteWindowStreamGroupBudget` derives the per-lane focus budget
// (focus = total - overview). The policy must never pre-deduct the overview
// share from the group total.
function groupTotal(profile: RemoteWindowVideoProfile): number {
  return profile.maxBitrateBps;
}

function daemonBudget(profile: RemoteWindowVideoProfile) {
  return resolveRemoteWindowStreamGroupBudget({
    requested: profile,
    hasOverview: true,
  });
}

function assertProfileGroupBudget(
  check: (name: string, condition: boolean, detail?: string) => void,
  name: string,
  profile: RemoteWindowVideoProfile,
) {
  const budget = daemonBudget(profile);
  check(`${name}.profile-total-is-group-total`, profile.maxBitrateBps === budget.totalMaxBitrateBps, `profile=${profile.maxBitrateBps} daemon=${budget.totalMaxBitrateBps}`);
  check(`${name}.overview-within-total`, profile.overviewMaxBitrateBps <= profile.maxBitrateBps, `overview=${profile.overviewMaxBitrateBps} total=${profile.maxBitrateBps}`);
  check(
    `${name}.daemon-focus-plus-overview-equals-total`,
    budget.focus.maxBitrateBps + (budget.overview?.maxBitrateBps ?? 0) === budget.totalMaxBitrateBps,
    `focus=${budget.focus.maxBitrateBps} overview=${budget.overview?.maxBitrateBps} total=${budget.totalMaxBitrateBps}`,
  );
  check(`${name}.daemon-focus-nonnegative`, budget.focus.maxBitrateBps >= 0, `focus=${budget.focus.maxBitrateBps}`);
  check(`${name}.daemon-overview-share`, budget.overview?.maxBitrateBps === profile.overviewMaxBitrateBps, `overview=${budget.overview?.maxBitrateBps} profile=${profile.overviewMaxBitrateBps}`);
}

function executePolicyCase(caseName: 'policy-pressure' | 'policy-recovery'): CaseExecution {
  const assertions: Record<string, boolean> = {};
  const messages: string[] = [];
  const raw: Record<string, unknown> = {};
  const check = (name: string, condition: boolean, detail?: string) => {
    assertions[name] = condition;
    if (condition) {
      messages.push(`assert ${name} PASS`);
    } else {
      messages.push(`assert ${name} FAIL${detail ? ` (${detail})` : ''}`);
    }
  };

  if (caseName === 'policy-pressure') {
    const userMaxBitrateBps = 10_000_000;
    const lastAcknowledgedMaxBitrateBps = 2_000_000;
    const first = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps,
      lastAcknowledgedMaxBitrateBps,
      sample: buildPressuringSample(1_000),
    });
    const degraded = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      userMaxBitrateBps,
      lastAcknowledgedMaxBitrateBps,
      previous: first.state,
      sample: buildPressuringSample(3_000),
    });
    const holdUnknownUser = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: null,
      lastAcknowledgedMaxBitrateBps: 3_000_000,
      sample: buildPressuringSample(1_000),
    });
    const holdUnknownAck = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 3_000_000,
      lastAcknowledgedMaxBitrateBps: null,
      sample: buildPressuringSample(1_000),
    });
    const smoothFirst = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 4_000_000,
      lastAcknowledgedMaxBitrateBps: 4_000_000,
      sample: buildPressuringSample(1_000),
    });
    const smoothDegraded = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'smooth',
      userMaxBitrateBps: 4_000_000,
      lastAcknowledgedMaxBitrateBps: 4_000_000,
      previous: smoothFirst.state,
      sample: buildPressuringSample(2_000),
    });
    // R3 budget contract: an 8 Mbps group cap with a 0.3 Mbps overview share
    // must keep the group total at 8 Mbps; the daemon derives focus as
    // 8 - 0.3 = 7.7 Mbps. The policy must not pre-deduct the overview share.
    const groupBudget = resolveRemoteWindowVideoAdaptiveDecision({
      preference: 'quality',
      qualityTier: 'ultra-2160',
      userMaxBitrateBps: 8_000_000,
      lastAcknowledgedMaxBitrateBps: 8_000_000,
      sample: buildPressuringSample(1_000),
    });
    check('unknown-user-cap-hold', holdUnknownUser.reason === 'hold' && holdUnknownUser.state.level === 0);
    check('unknown-ack-cap-hold', holdUnknownAck.reason === 'hold' && holdUnknownAck.state.level === 0);
    check('pressure-downgrade-after-threshold', degraded.reason === 'downgrade' && degraded.state.level === 1, degraded.reason);
    check(
      'pressure-total-under-min-cap',
      groupTotal(degraded.profile) <= Math.min(userMaxBitrateBps, lastAcknowledgedMaxBitrateBps),
      `total=${groupTotal(degraded.profile)} cap=${Math.min(userMaxBitrateBps, lastAcknowledgedMaxBitrateBps)}`,
    );
    check('pressure-total-not-increase', groupTotal(degraded.profile) <= groupTotal(first.profile));
    assertProfileGroupBudget(check, 'pressure', degraded.profile);
    check('pressure-fps-ceiling-preserved', degraded.profile.maxFrameRateFps <= first.profile.maxFrameRateFps);
    check(
      'fps-mbps-independent-smooth',
      smoothDegraded.profile.maxFrameRateFps === smoothFirst.profile.maxFrameRateFps
        && smoothDegraded.profile.maxBitrateBps < smoothFirst.profile.maxBitrateBps,
      `fps=${smoothFirst.profile.maxFrameRateFps}/${smoothDegraded.profile.maxFrameRateFps} mbps=${smoothFirst.profile.maxBitrateBps}/${smoothDegraded.profile.maxBitrateBps}`,
    );
    const groupBudgetDaemon = daemonBudget(groupBudget.profile);
    check(
      'group-budget-total-8mbps',
      groupBudget.profile.maxBitrateBps === 8_000_000 && groupBudgetDaemon.totalMaxBitrateBps === 8_000_000,
      `profile=${groupBudget.profile.maxBitrateBps} daemon=${groupBudgetDaemon.totalMaxBitrateBps}`,
    );
    check(
      'group-budget-focus-7.7mbps',
      groupBudgetDaemon.focus.maxBitrateBps === 7_700_000,
      `focus=${groupBudgetDaemon.focus.maxBitrateBps}`,
    );
    check(
      'group-budget-overview-0.3mbps',
      groupBudgetDaemon.overview?.maxBitrateBps === 300_000 && groupBudget.profile.overviewMaxBitrateBps === 300_000,
      `overview=${groupBudgetDaemon.overview?.maxBitrateBps} profile=${groupBudget.profile.overviewMaxBitrateBps}`,
    );
    raw.policyPressure = {
      first,
      degraded,
      holdUnknownUser,
      holdUnknownAck,
      smoothFirst,
      smoothDegraded,
      groupBudget,
    };
    const failed = Object.entries(assertions).filter(([, value]) => !value);
    if (failed.length > 0) {
      throw new ConsumerFailure(`policy-pressure assertions failed: ${failed.map(([name]) => name).join(', ')}`);
    }
    messages.push('policy-pressure PASS');
    return {
      status: 'PASS',
      assertions,
      messages,
      result: {
      assertions,
      decisions: { first, degraded, holdUnknownUser, holdUnknownAck, smoothFirst, smoothDegraded, groupBudget },
    },
      raw,
    };
  }

  const userMaxBitrateBps = 10_000_000;
  const lastAcknowledgedMaxBitrateBps = 2_000_000;
  const p1 = resolveRemoteWindowVideoAdaptiveDecision({
    preference: 'quality',
    userMaxBitrateBps,
    lastAcknowledgedMaxBitrateBps,
    sample: buildPressuringSample(1_000),
  });
  const p2 = resolveRemoteWindowVideoAdaptiveDecision({
    preference: 'quality',
    userMaxBitrateBps,
    lastAcknowledgedMaxBitrateBps,
    previous: p1.state,
    sample: buildPressuringSample(3_000),
  });
  const h1 = resolveRemoteWindowVideoAdaptiveDecision({
    preference: 'quality',
    userMaxBitrateBps,
    lastAcknowledgedMaxBitrateBps,
    previous: p2.state,
    sample: buildHealthySample(4_000),
  });
  const h2 = resolveRemoteWindowVideoAdaptiveDecision({
    preference: 'quality',
    userMaxBitrateBps,
    lastAcknowledgedMaxBitrateBps,
    previous: h1.state,
    sample: buildHealthySample(5_000),
  });
  const r1 = resolveRemoteWindowVideoAdaptiveDecision({
    preference: 'quality',
    userMaxBitrateBps,
    lastAcknowledgedMaxBitrateBps,
    previous: h2.state,
    sample: buildHealthySample(20_000),
  });
  check('recovery-hold-within-stable-window', h2.reason === 'hold' && h2.state.level === 1, h2.reason);
  check('recovery-restore-after-stable-window', r1.reason === 'restore', r1.reason);
  check('recovery-not-locked-to-low-ack', groupTotal(r1.profile) > lastAcknowledgedMaxBitrateBps);
  check('recovery-toward-user-cap', groupTotal(r1.profile) <= userMaxBitrateBps);
  check('recovery-level-steps-down', r1.state.level < p2.state.level);
  assertProfileGroupBudget(check, 'recovery', r1.profile);
  check('recovery-fps-ceiling-preserved', r1.profile.maxFrameRateFps <= 30);
  raw.policyRecovery = { p1, p2, h1, h2, r1 };
  const failed = Object.entries(assertions).filter(([, value]) => !value);
  if (failed.length > 0) {
    throw new ConsumerFailure(`policy-recovery assertions failed: ${failed.map(([name]) => name).join(', ')}`);
  }
  messages.push('policy-recovery PASS');
  return {
    status: 'PASS',
    assertions,
    messages,
    result: { assertions, decisions: { p1, p2, h1, h2, r1 } },
    raw,
  };
}

interface LaneSamples {
  byLane: Map<LaneRole, { first: RemoteWindowVideoStatsSample | null; second: RemoteWindowVideoStatsSample | null; third: RemoteWindowVideoStatsSample | null }>;
  pair: {
    selectedCandidatePairId: string | null;
    currentRoundTripTimeMs: number | null;
  };
}

async function emitUntilDecoded(
  stream: ProbeStream,
  lanes: readonly LaneRole[],
  extraPerLane: number,
): Promise<void> {
  const targets = new Map<LaneRole, number>();
  for (const lane of lanes) {
    targets.set(lane, (stream.decodedFrames.get(lane) ?? 0) + extraPerLane);
  }
  for (let round = 0; round < 120; round += 1) {
    const reached = lanes.every((lane) => (stream.decodedFrames.get(lane) ?? 0) >= (targets.get(lane) ?? 0));
    if (reached) {
      return;
    }
    await stream.emitFrames(1);
  }
  throw new ConsumerFailure(
    `decoded frames did not reach ${JSON.stringify([...targets])} for ${stream.streamId}`,
  );
}

async function collectLaneSamples(
  runtime: ReturnType<typeof createRemoteWindowReceiverRuntime>,
  stream: ProbeStream,
  receiverPeer: RTCPeerConnection,
  lanes: readonly LaneRole[],
): Promise<LaneSamples> {
  await waitFor(
    () => receiverPeer.connectionState === 'connected' || receiverPeer.iceConnectionState === 'connected'
      || receiverPeer.iceConnectionState === 'completed',
    'receiver peer connected',
  );
  const emitUntil = (extraPerLane: number) => emitUntilDecoded(stream, lanes, extraPerLane);

  await emitUntil(2);
  await delay(100);
  const firstByLane = new Map<LaneRole, RemoteWindowVideoStatsSample | null>();
  for (const lane of lanes) {
    firstByLane.set(lane, await runtime.getStatsSample(stream.streamId, lane));
  }
  await emitUntil(4);
  await delay(120);
  const secondByLane = new Map<LaneRole, RemoteWindowVideoStatsSample | null>();
  for (const lane of lanes) {
    secondByLane.set(lane, await runtime.getStatsSample(stream.streamId, lane));
  }
  // Deliberately shorter third window than the second: a per-interval delta
  // must shrink with less traffic, while a cumulative counter would keep rising.
  await emitUntil(2);
  await delay(120);
  const thirdByLane = new Map<LaneRole, RemoteWindowVideoStatsSample | null>();
  for (const lane of lanes) {
    thirdByLane.set(lane, await runtime.getStatsSample(stream.streamId, lane));
  }

  const report = await receiverPeer.getStats();
  const items: Array<Record<string, unknown>> = [];
  report.forEach((item: unknown) => {
    items.push(item as Record<string, unknown>);
  });
  const transport = items.find((item) => item.type === 'transport');
  const selectedCandidatePairId = typeof transport?.selectedCandidatePairId === 'string'
    ? transport.selectedCandidatePairId
    : null;
  const pair = selectedCandidatePairId === null
    ? undefined
    : items.find((item) => item.type === 'candidate-pair' && item.id === selectedCandidatePairId);
  const currentRoundTripTimeMs = typeof pair?.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime)
    ? pair.currentRoundTripTime * 1000
    : null;

  const byLane = new Map<LaneRole, { first: RemoteWindowVideoStatsSample | null; second: RemoteWindowVideoStatsSample | null; third: RemoteWindowVideoStatsSample | null }>();
  for (const lane of lanes) {
    byLane.set(lane, {
      first: firstByLane.get(lane) ?? null,
      second: secondByLane.get(lane) ?? null,
      third: thirdByLane.get(lane) ?? null,
    });
  }
  return { byLane, pair: { selectedCandidatePairId, currentRoundTripTimeMs } };
}

function assertLaneSamples(
  lane: LaneRole,
  binding: { mediaEpoch: number; trackId: string } | undefined,
  samples: { first: RemoteWindowVideoStatsSample | null; second: RemoteWindowVideoStatsSample | null; third: RemoteWindowVideoStatsSample | null },
  decodedFrames: number,
  committedFrames: number,
  shape: { width: number; height: number; dataLength: number } | undefined,
  pair: { selectedCandidatePairId: string | null; currentRoundTripTimeMs: number | null },
  check: (name: string, condition: boolean, detail?: string) => void,
) {
  check(`${lane}.binding-present`, Boolean(binding), binding ? undefined : 'missing binding');
  check(`${lane}.binding-epoch-zero`, binding?.mediaEpoch === 0);
  const s1 = samples.first ?? null;
  const s2 = samples.second ?? null;
  const s3 = samples.third ?? null;
  check(`${lane}.sample-lane-bound`, s2?.lane === lane, `lane=${s2?.lane}`);
  check(`${lane}.sample-epoch-bound`, s2?.mediaEpoch === 0, `epoch=${s2?.mediaEpoch}`);
  check(`${lane}.sample-track-bound`, s2?.trackId === binding?.trackId, `track=${s2?.trackId} binding=${binding?.trackId}`);
  check(`${lane}.sample-mid`, typeof s2?.mid === 'string' && s2.mid.length > 0, `mid=${s2?.mid}`);
  check(`${lane}.sample-ssrc`, typeof s2?.ssrc === 'number', `ssrc=${s2?.ssrc}`);
  check(`${lane}.decoded-i420-frames`, decodedFrames > 0, `decoded=${decodedFrames}`);
  check(
    `${lane}.full-i420-frame`,
    Boolean(shape && shape.dataLength === shape.width * shape.height * 1.5),
    `shape=${JSON.stringify(shape)}`,
  );
  check(`${lane}.frame-commit-accepted`, committedFrames > 0, `committed=${committedFrames}`);
  check(`${lane}.first-interval-unknown`, s1?.receivedBitrateBps === null, `first.bitrate=${s1?.receivedBitrateBps}`);
  check(`${lane}.first-interval-loss-unknown`, s1?.receivedPacketLossRatio === null, `first.loss=${s1?.receivedPacketLossRatio}`);
  check(
    `${lane}.second-interval-delta`,
    typeof s2?.receivedBitrateBps === 'number' && s2.receivedBitrateBps > 0,
    `second.bitrate=${s2?.receivedBitrateBps}`,
  );
  check(
    `${lane}.second-interval-loss-finite`,
    typeof s2?.receivedPacketLossRatio === 'number'
      && Number.isFinite(s2.receivedPacketLossRatio)
      && s2.receivedPacketLossRatio >= 0
      && s2.receivedPacketLossRatio <= 1,
    `second.loss=${s2?.receivedPacketLossRatio}`,
  );
  check(
    `${lane}.third-interval-not-cumulative`,
    typeof s3?.receivedBitrateBps === 'number' && s3.receivedBitrateBps < (s2?.receivedBitrateBps ?? Number.POSITIVE_INFINITY),
    `third.bitrate=${s3?.receivedBitrateBps} second=${s2?.receivedBitrateBps}`,
  );
  check(
    `${lane}.fps-gauge-independent`,
    typeof s2?.framesPerSecond === 'number' && s2.framesPerSecond >= 0,
    `fps=${s2?.framesPerSecond}`,
  );
  check(
    `${lane}.selected-candidate-pair`,
    typeof s2?.selectedCandidatePairId === 'string' && s2.selectedCandidatePairId.length > 0,
    `pair=${s2?.selectedCandidatePairId}`,
  );
  check(
    `${lane}.standard-rtt`,
    typeof s2?.rttMs === 'number' && s2.rttMs >= 0,
    `rtt=${s2?.rttMs}`,
  );
  check(
    `${lane}.rtt-matches-standard-chain`,
    s2?.selectedCandidatePairId === pair.selectedCandidatePairId
      && pair.currentRoundTripTimeMs !== null
      && s2?.rttMs === pair.currentRoundTripTimeMs,
    `sample.pair=${s2?.selectedCandidatePairId} rtt=${s2?.rttMs} | report.pair=${pair.selectedCandidatePairId} rtt=${pair.currentRoundTripTimeMs}`,
  );
}

async function executeReceiverCase(caseName: ReceiverCaseName): Promise<CaseExecution> {
  const assertions: Record<string, boolean> = {};
  const messages: string[] = [];
  const failures: string[] = [];
  const raw: Record<string, unknown> = {};
  const check = (name: string, condition: boolean, detail?: string) => {
    assertions[name] = condition;
    if (condition) {
      messages.push(`assert ${name} PASS`);
    } else {
      failures.push(`${name}${detail ? ` (${detail})` : ''}`);
    }
  };

  const registry = createNativeRegistry();
  const receivedTracks = new Map<string, MediaStreamTrack>();
  const cleanupErrors: string[] = [];
  try {
    const runtime = createRemoteWindowReceiverRuntime({
      peerConnectionFactory: (config) => {
        const peer = new WrtcPeerConnection(config);
        registry.receiverPeers.push(peer);
        peer.addEventListener('track', (event) => {
          const track = (event as RTCTrackEvent).track;
          if (track) {
            receivedTracks.set(track.id, track);
          }
        });
        return peer;
      },
      mediaStreamFactory: () => new WrtcMediaStream(),
      trackTimeoutMs: 15_000,
    });
    registry.runtime = runtime;

    const lanes: readonly LaneRole[] = caseName === 'receiver-lanes' ? ['focus', 'overview'] : ['focus'];
    const streamIdA = `q1-${caseName}-a`;
    const streamA = await startProbeStream(runtime, registry, receivedTracks, streamIdA, lanes);
    raw.bindingsA = streamA.startResult.bindings.map(plainBinding);
    const receiverPeerA = registry.receiverPeers[registry.receiverPeers.length - 1];

    const samplesA = await collectLaneSamples(runtime, streamA, receiverPeerA, lanes);
    const lanesA: Record<string, unknown> = {};
    for (const lane of lanes) {
      const binding = streamA.startResult.bindings.find((item) => item.lane === lane);
      const laneSamples = samplesA.byLane.get(lane);
      assertLaneSamples(
        lane,
        binding,
        laneSamples ?? { first: null, second: null, third: null },
        streamA.decodedFrames.get(lane) ?? 0,
        streamA.committedFrames.get(lane) ?? 0,
        streamA.frameShapes.get(lane),
        samplesA.pair,
        check,
      );
      lanesA[lane] = {
        binding: binding ? plainBinding(binding) : null,
        first: plainSample(laneSamples?.first ?? null),
        second: plainSample(laneSamples?.second ?? null),
        third: plainSample(laneSamples?.third ?? null),
        decodedFrames: streamA.decodedFrames.get(lane) ?? 0,
        committedFrames: streamA.committedFrames.get(lane) ?? 0,
        shape: streamA.frameShapes.get(lane),
      };
    }
    raw.lanesA = lanesA;
    raw.pairA = samplesA.pair;
    raw.senderErrorsA = streamA.sender.errors;

    if (caseName === 'receiver-lanes') {
      check('receiver-lanes-two-bindings', streamA.startResult.bindings.length === 2);
      const focusS2 = samplesA.byLane.get('focus')?.second ?? null;
      const overviewS2 = samplesA.byLane.get('overview')?.second ?? null;
      check('receiver-lanes-distinct-ssrc', focusS2?.ssrc !== overviewS2?.ssrc, `focus=${focusS2?.ssrc} overview=${overviewS2?.ssrc}`);
      check('receiver-lanes-distinct-mid', focusS2?.mid !== overviewS2?.mid, `focus=${focusS2?.mid} overview=${overviewS2?.mid}`);
      check('receiver-lanes-distinct-track', focusS2?.trackId !== overviewS2?.trackId, `focus=${focusS2?.trackId} overview=${overviewS2?.trackId}`);
      check('receiver-lanes-both-decoded', (streamA.decodedFrames.get('focus') ?? 0) > 0 && (streamA.decodedFrames.get('overview') ?? 0) > 0);
    } else {
      // receiver-restart: stop stream A fully, then open a fresh stream B and
      // confirm the new stream's first interval is unknown again (per-stream
      // baseline reset, not a global counter).
      await stopProbeStream(runtime, streamA);
      const aSecond = samplesA.byLane.get('focus')?.second ?? null;
      check(
        'restart-a-had-baseline',
        aSecond !== null && typeof aSecond.receivedBitrateBps === 'number' && aSecond.receivedBitrateBps > 0,
      );
      check('restart-a-removed', !runtime.getActiveStreamIds().includes(streamIdA));
      check('restart-a-peer-closed', receiverPeerA.connectionState === 'closed', receiverPeerA.connectionState);

      const streamIdB = `q1-${caseName}-b`;
      const streamB = await startProbeStream(runtime, registry, receivedTracks, streamIdB, ['focus']);
      raw.bindingsB = streamB.startResult.bindings.map(plainBinding);
      const receiverPeerB = registry.receiverPeers[registry.receiverPeers.length - 1];
      await waitFor(
        () => receiverPeerB.connectionState === 'connected'
          || receiverPeerB.iceConnectionState === 'connected'
          || receiverPeerB.iceConnectionState === 'completed',
        'receiver peer connected (restart b)',
      );
      await emitUntilDecoded(streamB, ['focus'], 2);
      await delay(100);
      const bFirst = await runtime.getStatsSample(streamIdB, 'focus');
      raw.restartB = {
        bindings: streamB.startResult.bindings.map(plainBinding),
        first: plainSample(bFirst),
        decodedFrames: streamB.decodedFrames.get('focus') ?? 0,
      };
      check('restart-b-first-interval-unknown', bFirst?.receivedBitrateBps === null, `b.first.bitrate=${bFirst?.receivedBitrateBps}`);
      check('restart-b-first-has-identity', typeof bFirst?.ssrc === 'number' && typeof bFirst?.mid === 'string', `b.first=${plainSample(bFirst) && JSON.stringify(plainSample(bFirst))}`);
      check('restart-b-epoch-zero', bFirst?.mediaEpoch === 0);
      check('restart-b-track-bound', bFirst?.trackId === (streamB.startResult.bindings.find((item) => item.lane === 'focus')?.trackId ?? null));

      await stopProbeStream(runtime, streamB);
      check('restart-b-removed', !runtime.getActiveStreamIds().includes(streamIdB));
      check('restart-b-peer-closed', receiverPeerB.connectionState === 'closed', receiverPeerB.connectionState);
    }

    if (failures.length > 0) {
      throw new ConsumerFailure(`${caseName} assertions failed: ${failures.join('; ')}`);
    }
    messages.push(`${caseName} PASS`);
    const result: Record<string, unknown> = { assertions, lanes: lanesA };
    return { status: 'PASS', assertions, messages, result, raw };
  } catch (error) {
    if (error instanceof ConsumerBlocked || error instanceof ConsumerFailure) {
      throw error;
    }
    throw new ConsumerFailure(`${caseName} unexpected error: ${messageOf(error)}`);
  } finally {
    const errors = releaseNative(registry);
    if (errors.length > 0) {
      cleanupErrors.push(...errors);
    }
    receivedTracks.clear();
    if (cleanupErrors.length > 0) {
      raw.cleanupErrors = cleanupErrors;
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const { caseName, outputDir } = parseArgs(argv);

  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    process.stderr.write('remote-window-quality-stats-probe: --expose-gc is required for natural wrtc finalization; re-run with NODE_OPTIONS=--expose-gc\n');
    process.exitCode = 1;
    return 1;
  }

  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
  const productDiffSha = computeProductDiffSha();
  const consumerSha = shasum(fileURLToPath(import.meta.url));
  const wrtcAddonSha256 = shasum(resolveAddonPath());
  const wrtcVersion = readWrtcVersion();
  mkdirSync(outputDir, { recursive: true });

  let execution: CaseExecution;
  try {
    execution = RECEIVER_CASES.includes(caseName as ReceiverCaseName)
      ? await executeReceiverCase(caseName as ReceiverCaseName)
      : executePolicyCase(caseName as 'policy-pressure' | 'policy-recovery');
  } catch (error) {
    execution = {
      status: error instanceof ConsumerBlocked ? 'BLOCKED' : 'FAIL',
      assertions: {},
      messages: [messageOf(error)],
      result: {},
      raw: {},
    };
  }

  await releaseNativeMemory();

  const summary = {
    caseName,
    status: execution.status,
    assertions: execution.assertions,
    messages: execution.messages,
    result: execution.result,
    sourceHead,
    productDiffSha,
    consumerSha,
    wrtcAddonSha256,
    wrtcVersion,
    nodeVersion: process.version,
    exposesGc: true,
  };
  writeFileSync(join(outputDir, `${caseName}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outputDir, `${caseName}.raw.json`), `${JSON.stringify(execution.raw, null, 2)}\n`);
  process.exitCode = execution.status === 'PASS' ? 0 : 1;
  return process.exitCode;
}

main(process.argv).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`probe fatal: ${messageOf(error)}\n`);
    process.exitCode = 1;
  },
);
