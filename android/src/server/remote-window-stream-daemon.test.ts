import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteWindowStreamStartRequestPayload,
  RemoteWindowStreamStartRequestV2Payload,
  RemoteWindowStreamStatusPayload,
} from '@zterm/shared/protocol';

// Unit/protocol coverage injects every media primitive it exercises. Keep the
// native addon out of this process so its global teardown cannot turn a green
// deterministic corpus into a post-run SIGSEGV; real PeerConnection coverage
// runs in the dedicated process-isolated loopback gate.
vi.mock('@roamhq/wrtc', () => ({
  default: {
    RTCPeerConnection: class {
      constructor() {
        throw new Error('remote-window daemon unit test must inject RTCPeerConnection');
      }
    },
    RTCSessionDescription: class {
      type: RTCSdpType;
      sdp: string;
      constructor(description: RTCSessionDescriptionInit) {
        this.type = description.type!;
        this.sdp = description.sdp || '';
      }
    },
    RTCIceCandidate: class {
      constructor(candidate: RTCIceCandidateInit) {
        Object.assign(this, candidate);
      }
    },
    MediaStream: class {
      id: string;
      constructor(init?: { id?: string }) {
        this.id = init?.id || '';
      }
    },
    nonstandard: {
      RTCVideoSource: class {
        constructor() {
          throw new Error('remote-window daemon unit test must inject RTCVideoSource');
        }
      },
      rgbaToI420: () => {
        throw new Error('remote-window daemon unit test must inject rgbaToI420');
      },
    },
  },
}));
import type {
  RemoteWindowCaptureFrameSource,
  RemoteWindowCaptureSourceFactory,
} from './remote-window-capture';
import {
  RemoteWindowCaptureTargetOutOfDisplayError,
  RemoteWindowCaptureTargetUnavailableError,
} from './remote-window-capture';
import {
  buildScreenCaptureKitStartupTimeoutMessage,
  buildScreenCaptureKitConfig,
  buildRemoteWindowImagePasteInputPayloads,
  buildRemoteWindowInputConfig,
  buildMacosAppWindowTargets,
  buildRemoteWindowStreamTargets,
  createDefaultRemoteWindowInputHelper,
  createRemoteWindowStreamDaemonRuntime as createRemoteWindowStreamDaemonRuntimeSource,
  flattenIterm2SplitTree,
  isRemoteWindowInputConfigStale,
  MACOS_REMOTE_WINDOW_INPUT_SWIFT,
  SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT,
  parseTmuxClientTargets,
  resolveRemoteWindowInputConfigStaleMs,
  resolveRemoteWindowInputHelperTimeoutMs,
  shouldCoalesceRemoteWindowQueuedFocusBeforeInput,
  startScreenCaptureKitFrameSource,
  summarizeRemoteWindowCatalogError,
  type Iterm2RawCatalog,
  type Iterm2RawNode,
  type MacosAppWindowCatalog,
  type RemoteWindowInputEventRunner,
} from './remote-window-stream-daemon';
import { makeRemoteWindowVideoProfileFixture } from './remote-window-video-profile-test-fixture';

const smoothVideoProfile = makeRemoteWindowVideoProfileFixture('smooth');
const qualityVideoProfile = makeRemoteWindowVideoProfileFixture('quality');

function reliableInputControl(sequence: string) {
  return {
    version: 1 as const,
    sequence,
    lane: 'reliable' as const,
    attempt: 1,
    sentAtMs: Date.now(),
  };
}

function continuousInputControl(sequence: string) {
  return {
    version: 1 as const,
    sequence,
    lane: 'continuous' as const,
    attempt: 1,
    sentAtMs: Date.now(),
  };
}

function makeControllableCaptureSource(
  options: Parameters<RemoteWindowCaptureSourceFactory>[1],
  stop = vi.fn(),
) {
  let frameRate = options.frameRate;
  let maxCaptureWidth = options.maxCaptureWidth ?? smoothVideoProfile.maxCaptureWidth;
  let maxCaptureHeight = options.maxCaptureHeight ?? smoothVideoProfile.maxCaptureHeight;
  return {
    width: 2,
    height: 2,
    get frameRate() {
      return frameRate;
    },
    get maxCaptureWidth() {
      return maxCaptureWidth;
    },
    get maxCaptureHeight() {
      return maxCaptureHeight;
    },
    updateVideoProfile: vi.fn(async (profile: {
      maxFrameRateFps: number;
      maxCaptureWidth: number;
      maxCaptureHeight: number;
    }) => {
      frameRate = profile.maxFrameRateFps;
      maxCaptureWidth = profile.maxCaptureWidth;
      maxCaptureHeight = profile.maxCaptureHeight;
    }),
    stop,
  };
}

function createRemoteWindowStreamDaemonRuntime(
  deps: Parameters<typeof createRemoteWindowStreamDaemonRuntimeSource>[0],
) {
  const captureSourceFactory = deps.captureSourceFactory
    ? async (
        target: Parameters<RemoteWindowCaptureSourceFactory>[0],
        options: Parameters<RemoteWindowCaptureSourceFactory>[1],
      ): Promise<RemoteWindowCaptureFrameSource> => {
        const source = await deps.captureSourceFactory!(target, options);
        if (
          source.updateVideoProfile
          && Number.isFinite(source.maxCaptureWidth)
          && Number.isFinite(source.maxCaptureHeight)
        ) {
          return source;
        }
        let frameRate = source.frameRate;
        let maxCaptureWidth = options.maxCaptureWidth ?? smoothVideoProfile.maxCaptureWidth;
        let maxCaptureHeight = options.maxCaptureHeight ?? smoothVideoProfile.maxCaptureHeight;
        return {
          ...source,
          get width() {
            return source.width;
          },
          get height() {
            return source.height;
          },
          get frameRate() {
            return frameRate;
          },
          get maxCaptureWidth() {
            return maxCaptureWidth;
          },
          get maxCaptureHeight() {
            return maxCaptureHeight;
          },
          updateVideoProfile: vi.fn(async (profile) => {
            frameRate = profile.maxFrameRateFps;
            maxCaptureWidth = profile.maxCaptureWidth;
            maxCaptureHeight = profile.maxCaptureHeight;
          }),
        };
      }
    : undefined;
  const runtime = createRemoteWindowStreamDaemonRuntimeSource({
    ...deps,
    ...(captureSourceFactory ? { captureSourceFactory } : {}),
  });
  return {
    ...runtime,
    startStream: (
      payload: Omit<RemoteWindowStreamStartRequestPayload | RemoteWindowStreamStartRequestV2Payload, 'videoProfile'> & {
        videoProfile?: RemoteWindowStreamStartRequestPayload['videoProfile'];
      },
      handlers?: Parameters<typeof runtime.startStream>[1],
    ) => runtime.startStream({
      ...payload,
      videoProfile: payload.videoProfile ?? makeRemoteWindowVideoProfileFixture('smooth'),
    }, handlers),
  };
}

async function flushPromiseQueue() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function makeStreamTarget() {
  return {
    streamTargetId: 'iterm2-pane:window-1:tab-1:left',
    videoTarget: {
      kind: 'iterm2-pane' as const,
      appBundleId: 'com.googlecode.iterm2',
      pid: 123,
      windowId: 'window-1',
      title: 'left-pane',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 302, height: 250 },
      paneRectInContentPx: { x: 0, y: 0, width: 100, height: 200 },
      cropRectTopLeftPx: { x: 10, y: 70, width: 100, height: 200 },
      contentTopInsetPx: 50,
    },
    inputTarget: {
      kind: 'iterm2-pane' as const,
      itermSessionId: 'left',
      tty: '/dev/ttys001',
    },
    streamMode: 'view' as const,
    focusPolicy: 'bring-to-focus' as const,
    inputRoute: 'iterm2-api' as const,
    capture: {
      source: 'ScreenCaptureKit' as const,
      coordinateSpace: 'macos-top-left-px' as const,
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

function makeAppStreamTarget() {
  const target = makeStreamTarget();
  return {
    ...target,
    streamTargetId: 'app-window:123:456',
    videoTarget: {
      kind: 'app-window' as const,
      appBundleId: 'com.apple.TextEdit',
      pid: 123,
      windowId: '456',
      title: 'TextEdit',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
    },
    inputTarget: {
      kind: 'app-window' as const,
    },
    streamMode: 'interactive' as const,
    focusPolicy: 'bring-to-focus' as const,
    inputRoute: 'os-event' as const,
  };
}

class FakeRemoteWindowPeerConnection {
  public onicecandidate: ((event: { candidate: { toJSON: () => Record<string, unknown> } | null }) => void) | null = null;

  public onconnectionstatechange: (() => void) | null = null;

  public connectionState: RTCPeerConnectionState = 'connected';

  public localDescription: RTCSessionDescriptionInit | null = null;

  public remoteDescription: RTCSessionDescriptionInit | null = null;

  public addTrack = vi.fn(() => makeFakeRtpSender());

  public addTransceiver = vi.fn(() => ({ sender: makeFakeRtpSender() }));

  public close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  public addIceCandidate = vi.fn(async (candidate: RTCIceCandidateInit) => candidate);

  public setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
  });

  public createAnswer = vi.fn(async () => ({
    type: 'answer' as const,
    sdp: 'daemon-answer-sdp',
  }));

  public createOffer = vi.fn(async () => ({
    type: 'offer' as const,
    sdp: 'daemon-offer-sdp',
  }));

  public setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    this.onicecandidate?.({
      candidate: {
        toJSON: () => ({
          candidate: 'candidate:daemon',
          sdpMid: '0',
          sdpMLineIndex: 0,
          usernameFragment: 'daemon',
        }),
      },
    });
  });
}

function makeFakeMediaStreamTrack() {
  return { stop: vi.fn() } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}

function makeFakeRtpSender(
  initialParameters: RTCRtpSendParameters = { encodings: [{} as RTCRtpEncodingParameters] } as RTCRtpSendParameters,
) {
  let parameters: RTCRtpSendParameters = initialParameters;
  return {
    getParameters: vi.fn(() => parameters),
    setParameters: vi.fn(async (nextParameters: RTCRtpSendParameters) => {
      parameters = nextParameters;
    }),
  } as unknown as RTCRtpSender & {
    getParameters: ReturnType<typeof vi.fn>;
    setParameters: ReturnType<typeof vi.fn>;
  };
}

function makeNestedItermTree(): Iterm2RawNode {
  return {
    type: 'splitter',
    vertical: true,
    children: [
      {
        type: 'session',
        sessionId: 'left',
        title: 'left-pane',
        tty: '/dev/ttys001',
        frame: { x: 0, y: 0, width: 100, height: 200 },
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'right-top',
            title: 'right-top-pane',
            tty: '/dev/ttys002',
            frame: { x: 0, y: 0, width: 200, height: 100 },
          },
          {
            type: 'session',
            sessionId: 'right-bottom',
            title: 'right-bottom-pane',
            tty: '/dev/ttys003',
            frame: { x: 0, y: 101, width: 200, height: 99 },
          },
        ],
      },
    ],
  };
}

function makeCatalog(): Iterm2RawCatalog {
  return {
    windows: [{
      windowId: 'window-1',
      title: 'iTerm2 Gate',
      pid: 123,
      frame: { x: 10, y: 20, width: 302, height: 250 },
      tabs: [{
        tabId: 'tab-1',
        activeSessionId: 'left',
        root: makeNestedItermTree(),
      }],
    }],
  };
}

function makeAppWindowCatalog(): MacosAppWindowCatalog {
  return {
    windows: [
      {
        windowId: '64',
        ownerName: 'Google Chrome',
        appBundleId: 'com.google.Chrome',
        pid: 487,
        title: 'Chrome Window',
        frame: { x: 700, y: 139, width: 1200, height: 800 },
        displayId: '8',
        displayBoundsTopLeftPx: { x: 0, y: 0, width: 3840, height: 2160 },
      },
      {
        windowId: '33',
        ownerName: 'iTerm',
        appBundleId: 'com.googlecode.iterm2',
        pid: 479,
        title: 'Default (tmux)',
        frame: { x: 10, y: 20, width: 302, height: 250 },
        displayId: '8',
        displayBoundsTopLeftPx: { x: 0, y: 0, width: 3840, height: 2160 },
      },
    ],
  };
}

function makeTempExecutable(prefix: string, body: string) {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const executablePath = join(tempRoot, 'runner');
  writeFileSync(executablePath, body);
  chmodSync(executablePath, 0o755);
  return {
    executablePath,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function makeLiveComplexItermTree(): Iterm2RawNode {
  return {
    type: 'splitter',
    vertical: true,
    children: [
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'left-top',
            title: 'left-top',
            frame: { x: 0, y: 0, width: 801, height: 987 },
          },
          {
            type: 'session',
            sessionId: 'left-bottom',
            title: 'left-bottom',
            frame: { x: 0, y: 988, width: 801, height: 989 },
          },
        ],
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'splitter',
            vertical: true,
            children: [
              {
                type: 'session',
                sessionId: 'middle-a-top-left',
                title: 'middle-a-top-left',
                frame: { x: 0, y: 0, width: 682, height: 978 },
              },
              {
                type: 'session',
                sessionId: 'middle-a-top-right',
                title: 'middle-a-top-right',
                frame: { x: 683, y: 0, width: 710, height: 978 },
              },
            ],
          },
          {
            type: 'splitter',
            vertical: true,
            children: [
              {
                type: 'session',
                sessionId: 'middle-a-bottom-left',
                title: 'middle-a-bottom-left',
                frame: { x: 0, y: 0, width: 699, height: 998 },
              },
              {
                type: 'session',
                sessionId: 'middle-a-bottom-right',
                title: 'middle-a-bottom-right',
                frame: { x: 700, y: 0, width: 693, height: 998 },
              },
            ],
          },
        ],
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'middle-b-top',
            title: 'middle-b-top',
            frame: { x: 0, y: 0, width: 787, height: 978 },
          },
          {
            type: 'session',
            sessionId: 'middle-b-bottom',
            title: 'middle-b-bottom',
            frame: { x: 0, y: 979, width: 787, height: 998 },
          },
        ],
      },
      {
        type: 'splitter',
        vertical: false,
        children: [
          {
            type: 'session',
            sessionId: 'right-top',
            title: 'right-top',
            frame: { x: 0, y: 0, width: 815, height: 987 },
          },
          {
            type: 'session',
            sessionId: 'right-bottom',
            title: 'right-bottom',
            frame: { x: 0, y: 988, width: 815, height: 989 },
          },
        ],
      },
    ],
  };
}

describe('remote window stream daemon owner', () => {
  it('builds remote input config with target window focus metadata', () => {
    const target = makeAppStreamTarget();
    const config = buildRemoteWindowInputConfig({
      streamId: 'stream-input-config',
      targetId: target.streamTargetId,
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 12,
        deltaY: 24,
        x: 120,
        y: 140,
        normalizedX: 0.2,
        normalizedY: 0.3,
      },
    }, target, { daemonReceivedAtMs: 7_777 });

    expect(config).toEqual({
      daemonReceivedAtMs: 7_777,
      pid: 123,
      appBundleId: 'com.apple.TextEdit',
      focusPolicy: 'bring-to-focus',
      window: {
        windowId: '456',
        title: 'TextEdit',
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      },
      event: expect.objectContaining({
        kind: 'scroll',
        deltaX: 12,
        deltaY: 24,
      }),
    });
  });

  it('maps composite input through the published canvas/source rectangles', () => {
    const target = {
      ...makeAppStreamTarget(),
      compositeWindows: [{
        appBundleId: 'com.apple.TextEdit',
        pid: 123,
        windowId: 'secondary',
        title: 'Secondary',
        windowBoundsTopLeftPx: { x: 1_000, y: 500, width: 400, height: 300 },
      }],
    };
    const config = buildRemoteWindowInputConfig({
      streamId: 'stream-input-composite',
      targetId: target.streamTargetId,
      layoutGeneration: 7,
      event: {
        kind: 'click',
        pointerId: 1,
        button: 'left',
        x: 410,
        y: 320,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    }, target, {
      canvasLayout: {
        version: 1,
        layoutGeneration: 7,
        canvasSize: { width: 800, height: 600 },
        focusTargetId: target.streamTargetId,
        windows: [{
          windowId: 'secondary',
          sourceRectTopLeftPx: { x: 1_000, y: 500, width: 400, height: 300 },
          canvasRectPx: { x: 200, y: 100, width: 400, height: 400 },
          zIndex: 0,
        }],
      },
    });
    expect(config.event).toMatchObject({ kind: 'click', x: 1_200, y: 650 });
  });

  it('negotiates v2 as sender-owned offerer with initial encodings', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const videoSource = {
      createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
      onFrame: vi.fn(),
    };
    const captureSource = makeControllableCaptureSource({
      frameRate: smoothVideoProfile.maxFrameRateFps,
      maxCaptureWidth: smoothVideoProfile.maxCaptureWidth,
      maxCaptureHeight: smoothVideoProfile.maxCaptureHeight,
      startupTimeoutMs: 100,
      swiftBinary: 'swift',
      captureBinary: '/tmp/capture',
      onFrame: () => undefined,
      onError: () => undefined,
    });
    let offerSeen: any;
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      captureBinary: '/tmp/capture',
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      videoSourceFactory: vi.fn(() => videoSource),
      captureSourceFactory: vi.fn(async () => captureSource),
      runTmux: () => ({ ok: true, stdout: '' }),
    });
    const resultPromise = runtime.startStream({
      requestId: 'v2-request',
      streamId: 'v2-stream',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      target: makeStreamTarget(),
      videoProfile: smoothVideoProfile,
    } as never, {
      sendOffer: (offer) => {
        offerSeen = offer;
        void runtime.acceptAnswer?.({
          requestId: offer.requestId,
          streamId: offer.streamId,
          mediaPlanVersion: 2,
          answer: { type: 'answer', sdp: 'client-answer-sdp' },
        });
      },
    });
    const result = await resultPromise;
    expect(offerSeen).toMatchObject({ mediaPlanVersion: 2, offer: { type: 'offer', sdp: 'daemon-offer-sdp' } });
    expect(fakePeer.addTransceiver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      direction: 'sendonly',
      sendEncodings: [{
        maxBitrate: smoothVideoProfile.maxBitrateBps,
        maxFramerate: smoothVideoProfile.maxFrameRateFps,
      }],
    }));
    expect(fakePeer.remoteDescription).toEqual({ type: 'answer', sdp: 'client-answer-sdp' });
    expect(result).toMatchObject({ mediaPlanVersion: 2 });
  });

  it('fails composite input outside the published layout instead of selecting a fallback window', () => {
    const target = {
      ...makeAppStreamTarget(),
      compositeWindows: [{
        appBundleId: 'com.apple.TextEdit',
        pid: 123,
        windowId: 'secondary',
        title: 'Secondary',
        windowBoundsTopLeftPx: { x: 1_000, y: 500, width: 400, height: 300 },
      }],
    };
    expect(() => buildRemoteWindowInputConfig({
      streamId: 'stream-input-outside',
      targetId: target.streamTargetId,
      layoutGeneration: 7,
      event: {
        kind: 'click',
        pointerId: 1,
        button: 'left',
        x: 790,
        y: 590,
        normalizedX: 0.99,
        normalizedY: 0.99,
      },
    }, target, {
      canvasLayout: {
        version: 1,
        layoutGeneration: 7,
        canvasSize: { width: 800, height: 600 },
        focusTargetId: target.streamTargetId,
        windows: [{
          windowId: 'secondary',
          sourceRectTopLeftPx: { x: 1_000, y: 500, width: 400, height: 300 },
          canvasRectPx: { x: 200, y: 100, width: 400, height: 400 },
          zIndex: 0,
        }],
      },
    })).toThrow('outside the published layout');
  });

  it('uses daemon-local receive time, not client wall clock, for input stale checks', () => {
    expect(isRemoteWindowInputConfigStale({
      daemonReceivedAtMs: 20_000,
    }, 20_999)).toBe(false);
    expect(isRemoteWindowInputConfigStale({
      daemonReceivedAtMs: 20_000,
    }, 21_001)).toBe(true);
    expect(isRemoteWindowInputConfigStale({
      daemonReceivedAtMs: Number.NaN,
    }, 20_001)).toBe(true);
  });

  it('keeps action execution bounded while real input keeps the one-second queued realtime budget', () => {
    const target = makeAppStreamTarget();
    const focusConfig = buildRemoteWindowInputConfig({
      streamId: 'stream-timeout-policy',
      targetId: target.streamTargetId,
      event: { kind: 'focus' },
    }, target, { daemonReceivedAtMs: 20_000 });
    const pointerConfig = buildRemoteWindowInputConfig({
      streamId: 'stream-timeout-policy',
      targetId: target.streamTargetId,
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 1,
        button: 'left',
        buttons: 1,
        x: 120,
        y: 140,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    }, target, { daemonReceivedAtMs: 20_000 });
    const otherWindowPointerConfig = {
      ...pointerConfig,
      window: {
        ...pointerConfig.window,
        windowId: 'other-window',
      },
    };

    expect(resolveRemoteWindowInputHelperTimeoutMs(focusConfig)).toBe(3_000);
    expect(resolveRemoteWindowInputHelperTimeoutMs(pointerConfig)).toBe(3_000);
    expect(resolveRemoteWindowInputConfigStaleMs(pointerConfig)).toBe(1_000);
    expect(isRemoteWindowInputConfigStale(
      focusConfig,
      22_500,
      resolveRemoteWindowInputHelperTimeoutMs(focusConfig),
    )).toBe(false);
    expect(isRemoteWindowInputConfigStale(
      pointerConfig,
      21_001,
      resolveRemoteWindowInputConfigStaleMs(pointerConfig),
    )).toBe(true);
    expect(shouldCoalesceRemoteWindowQueuedFocusBeforeInput(focusConfig, pointerConfig)).toBe(true);
    expect(shouldCoalesceRemoteWindowQueuedFocusBeforeInput(focusConfig, otherWindowPointerConfig)).toBe(false);
    expect(shouldCoalesceRemoteWindowQueuedFocusBeforeInput(pointerConfig, focusConfig)).toBe(false);
  });

  it('keeps reliable input independent from queued age after an explicit standalone focus', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const childEvents = new EventEmitter();
    const fakeChild = {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn((signal?: NodeJS.Signals) => {
        fakeChild.killed = true;
        childEvents.emit('exit', null, signal || null);
        return true;
      }),
      on: childEvents.on.bind(childEvents),
    };
    const processFactory = vi.fn(() => {
      process.nextTick(() => stdout.write(`${JSON.stringify({ ready: true })}\n`));
      return fakeChild as any;
    });
    let inputBuffer = '';
    const writtenKinds: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      inputBuffer += String(chunk);
      let index = inputBuffer.indexOf('\n');
      while (index >= 0) {
        const raw = inputBuffer.slice(0, index).trim();
        inputBuffer = inputBuffer.slice(index + 1);
        if (raw) {
          const config = JSON.parse(raw) as { event?: { kind?: string } };
          writtenKinds.push(String(config.event?.kind || 'unknown'));
          const delay = config.event?.kind === 'focus' ? 1200 : 0;
          setTimeout(() => {
            stdout.write(`${JSON.stringify({ ok: true, kind: config.event?.kind })}\n`);
          }, delay);
        }
        index = inputBuffer.indexOf('\n');
      }
    });
    const helper = createDefaultRemoteWindowInputHelper({
      swiftBinary: 'fake-swift',
      processFactory,
    });
    const target = makeAppStreamTarget();

    try {
      await helper.warm();
      const daemonReceivedAtMs = Date.now();
      const focusConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-slow-focus',
        targetId: target.streamTargetId,
        event: { kind: 'focus' },
      }, target, { daemonReceivedAtMs });
      const pointerConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-slow-focus',
        targetId: target.streamTargetId,
        event: {
          kind: 'pointer',
          phase: 'down',
          pointerId: 1,
          button: 'left',
          buttons: 1,
          x: 120,
          y: 140,
          normalizedX: 0.5,
          normalizedY: 0.5,
        },
      }, target, { daemonReceivedAtMs });
      const focusPromise = helper.send(focusConfig, { lane: 'reliable' });
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      const pointerPromise = helper.send(pointerConfig, { lane: 'reliable' });
      await expect(Promise.all([focusPromise, pointerPromise])).resolves.toEqual([undefined, undefined]);
      expect(writtenKinds).toEqual(['focus', 'pointer']);
    } finally {
      helper.dispose();
    }
  }, 10_000);

  it('allows a real action to spend its focus budget after passing the queued stale gate', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const childEvents = new EventEmitter();
    const fakeChild = {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn((signal?: NodeJS.Signals) => {
        fakeChild.killed = true;
        childEvents.emit('exit', null, signal || null);
        return true;
      }),
      on: childEvents.on.bind(childEvents),
    };
    const processFactory = vi.fn(() => {
      process.nextTick(() => stdout.write(`${JSON.stringify({ ready: true })}\n`));
      return fakeChild as any;
    });
    const writtenKinds: string[] = [];
    let inputBuffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      inputBuffer += String(chunk);
      let index = inputBuffer.indexOf('\n');
      while (index >= 0) {
        const raw = inputBuffer.slice(0, index).trim();
        inputBuffer = inputBuffer.slice(index + 1);
        if (raw) {
          const config = JSON.parse(raw) as { event?: { kind?: string } };
          writtenKinds.push(String(config.event?.kind || 'unknown'));
          setTimeout(() => {
            stdout.write(`${JSON.stringify({ ok: true })}\n`);
          }, 1200);
        }
        index = inputBuffer.indexOf('\n');
      }
    });
    const helper = createDefaultRemoteWindowInputHelper({
      swiftBinary: 'fake-swift',
      processFactory,
    });
    const target = makeAppStreamTarget();

    try {
      await helper.warm();
      const daemonReceivedAtMs = Date.now();
      const clickConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-click-focus-budget',
        targetId: target.streamTargetId,
        event: {
          kind: 'click',
          pointerId: 1,
          button: 'left',
          clickCount: 1,
          x: 120,
          y: 140,
          normalizedX: 0.5,
          normalizedY: 0.5,
        },
      }, target, { daemonReceivedAtMs });

      await expect(helper.send(clickConfig)).resolves.toBeUndefined();
      expect(writtenKinds).toEqual(['click']);
    } finally {
      helper.dispose();
    }
  }, 10_000);

  it('coalesces redundant same-target focus bursts so real actions do not stale behind focus work', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const childEvents = new EventEmitter();
    const fakeChild = {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn((signal?: NodeJS.Signals) => {
        fakeChild.killed = true;
        childEvents.emit('exit', null, signal || null);
        return true;
      }),
      on: childEvents.on.bind(childEvents),
    };
    const processFactory = vi.fn(() => {
      process.nextTick(() => stdout.write(`${JSON.stringify({ ready: true })}\n`));
      return fakeChild as any;
    });
    let inputBuffer = '';
    const writtenPointerIds: number[] = [];
    const writtenKinds: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      inputBuffer += String(chunk);
      let index = inputBuffer.indexOf('\n');
      while (index >= 0) {
        const raw = inputBuffer.slice(0, index).trim();
        inputBuffer = inputBuffer.slice(index + 1);
        if (raw) {
          const config = JSON.parse(raw) as { event?: { kind?: string; pointerId?: number } };
          if (typeof config.event?.pointerId === 'number') {
            writtenPointerIds.push(config.event.pointerId);
          }
          writtenKinds.push(String(config.event?.kind || 'unknown'));
          setTimeout(() => {
            stdout.write(`${JSON.stringify({ ok: true })}\n`);
          }, 650);
        }
        index = inputBuffer.indexOf('\n');
      }
    });
    const helper = createDefaultRemoteWindowInputHelper({
      swiftBinary: 'fake-swift',
      processFactory,
    });
    const target = makeAppStreamTarget();

    const makeConfigPair = (index: number) => {
      const daemonReceivedAtMs = Date.now();
      const focusConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-burst-focus',
        targetId: target.streamTargetId,
        event: { kind: 'focus' },
      }, target, { daemonReceivedAtMs });
      const pointerConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-burst-focus',
        targetId: target.streamTargetId,
        event: {
          kind: 'pointer',
          phase: 'down',
          pointerId: index,
          button: 'left',
          buttons: 1,
          x: 120,
          y: 140,
          normalizedX: 0.5,
          normalizedY: 0.5,
        },
      }, target, { daemonReceivedAtMs });
      return [focusConfig, pointerConfig] as const;
    };

    try {
      await helper.warm();
      const configs = [1, 2, 3].flatMap((index) => [...makeConfigPair(index)]);
      await expect(Promise.all(configs.map((config) => helper.send(config)))).resolves.toHaveLength(6);
      expect(writtenPointerIds).toEqual([1, 2, 3]);
      expect(writtenKinds).toEqual(['pointer', 'pointer', 'pointer']);
    } finally {
      helper.dispose();
    }
  }, 10_000);

  it('does not refresh continuous age while reliable actions continue in order', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const childEvents = new EventEmitter();
    const fakeChild = {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn((signal?: NodeJS.Signals) => {
        fakeChild.killed = true;
        childEvents.emit('exit', null, signal || null);
        return true;
      }),
      on: childEvents.on.bind(childEvents),
    };
    const processFactory = vi.fn(() => {
      process.nextTick(() => stdout.write(`${JSON.stringify({ ready: true })}\n`));
      return fakeChild as any;
    });
    let inputBuffer = '';
    const writtenKinds: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      inputBuffer += String(chunk);
      let index = inputBuffer.indexOf('\n');
      while (index >= 0) {
        const raw = inputBuffer.slice(0, index).trim();
        inputBuffer = inputBuffer.slice(index + 1);
        if (raw) {
          const config = JSON.parse(raw) as { event?: { kind?: string; phase?: string } };
          writtenKinds.push(
            config.event?.kind === 'key'
              ? `key:${config.event.phase || 'unknown'}`
              : String(config.event?.kind || 'unknown'),
          );
          setTimeout(() => {
            stdout.write(`${JSON.stringify({ ok: true })}\n`);
          }, 1200);
        }
        index = inputBuffer.indexOf('\n');
      }
    });
    const helper = createDefaultRemoteWindowInputHelper({
      swiftBinary: 'fake-swift',
      processFactory,
    });
    const target = makeAppStreamTarget();

    try {
      await helper.warm();
      const daemonReceivedAtMs = Date.now();
      const configs = [
        buildRemoteWindowInputConfig({
          streamId: 'stream-action-burst',
          targetId: target.streamTargetId,
          event: {
            kind: 'click',
            pointerId: 1,
            button: 'left',
            clickCount: 1,
            x: 120,
            y: 140,
            normalizedX: 0.5,
            normalizedY: 0.5,
          },
        }, target, { daemonReceivedAtMs }),
        buildRemoteWindowInputConfig({
          streamId: 'stream-action-burst',
          targetId: target.streamTargetId,
          event: {
            kind: 'gesture',
            gesture: 'swipe',
            phase: 'end',
            unit: 'pixel',
            pointerId: 2,
            startX: 120,
            startY: 220,
            x: 120,
            y: 80,
            startNormalizedX: 0.5,
            startNormalizedY: 0.7,
            normalizedX: 0.5,
            normalizedY: 0.3,
            deltaX: 0,
            deltaY: -140,
            durationMs: 420,
            velocityX: 0,
            velocityY: -140 / 420,
          },
        }, target, { daemonReceivedAtMs }),
        buildRemoteWindowInputConfig({
          streamId: 'stream-action-burst',
          targetId: target.streamTargetId,
          event: {
            kind: 'scroll',
            unit: 'pixel',
            deltaX: 0,
            deltaY: 96,
            x: 120,
            y: 140,
            normalizedX: 0.5,
            normalizedY: 0.5,
          },
        }, target, { daemonReceivedAtMs }),
        buildRemoteWindowInputConfig({
          streamId: 'stream-action-burst',
          targetId: target.streamTargetId,
          event: {
            kind: 'key',
            phase: 'down',
            key: 'z',
            code: 'KeyZ',
            text: 'z',
          },
        }, target, { daemonReceivedAtMs }),
        buildRemoteWindowInputConfig({
          streamId: 'stream-action-burst',
          targetId: target.streamTargetId,
          event: {
            kind: 'key',
            phase: 'up',
            key: 'z',
            code: 'KeyZ',
            text: 'z',
          },
        }, target, { daemonReceivedAtMs }),
      ];

      const settled = await Promise.allSettled(configs.map((config, index) => helper.send(
        config,
        index === 2 ? { lane: 'continuous', maxAgeMs: 1_000 } : { lane: 'reliable' },
      )));
      expect(settled.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
      ]);
      expect(settled[2]).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'remote window input stale' }),
      });
      expect(writtenKinds).toEqual(['click', 'gesture', 'key:down', 'key:up']);
    } finally {
      helper.dispose();
    }
  }, 12_000);

  it('still drops stale queued action-only input for a different target', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const childEvents = new EventEmitter();
    const fakeChild = {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: vi.fn((signal?: NodeJS.Signals) => {
        fakeChild.killed = true;
        childEvents.emit('exit', null, signal || null);
        return true;
      }),
      on: childEvents.on.bind(childEvents),
    };
    const processFactory = vi.fn(() => {
      process.nextTick(() => stdout.write(`${JSON.stringify({ ready: true })}\n`));
      return fakeChild as any;
    });
    let inputBuffer = '';
    const writtenKinds: string[] = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      inputBuffer += String(chunk);
      let index = inputBuffer.indexOf('\n');
      while (index >= 0) {
        const raw = inputBuffer.slice(0, index).trim();
        inputBuffer = inputBuffer.slice(index + 1);
        if (raw) {
          const config = JSON.parse(raw) as { event?: { kind?: string } };
          writtenKinds.push(String(config.event?.kind || 'unknown'));
          setTimeout(() => {
            stdout.write(`${JSON.stringify({ ok: true })}\n`);
          }, 1200);
        }
        index = inputBuffer.indexOf('\n');
      }
    });
    const helper = createDefaultRemoteWindowInputHelper({
      swiftBinary: 'fake-swift',
      processFactory,
    });
    const target = makeAppStreamTarget();
    const otherTarget = {
      ...target,
      streamTargetId: 'app-window:123:999',
      videoTarget: {
        ...target.videoTarget,
        windowId: '999',
        title: 'Other TextEdit',
      },
    };

    try {
      await helper.warm();
      const daemonReceivedAtMs = Date.now();
      const clickConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-stale-other',
        targetId: target.streamTargetId,
        event: {
          kind: 'click',
          pointerId: 1,
          button: 'left',
          clickCount: 1,
          x: 120,
          y: 140,
          normalizedX: 0.5,
          normalizedY: 0.5,
        },
      }, target, { daemonReceivedAtMs });
      const otherScrollConfig = buildRemoteWindowInputConfig({
        streamId: 'stream-stale-other',
        targetId: otherTarget.streamTargetId,
        event: {
          kind: 'scroll',
          unit: 'pixel',
          deltaX: 0,
          deltaY: 96,
          x: 120,
          y: 140,
          normalizedX: 0.5,
          normalizedY: 0.5,
        },
      }, otherTarget, { daemonReceivedAtMs });

      await expect(Promise.all([
        helper.send(clickConfig, { lane: 'reliable' }),
        helper.send(otherScrollConfig, { lane: 'continuous', maxAgeMs: 1_000 }),
      ])).rejects.toThrow('remote window input stale');
      expect(writtenKinds).toEqual(['click']);
    } finally {
      helper.dispose();
    }
  }, 10_000);

  it('keeps scroll input compatible with the macOS helper schema', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let phase: String?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('let phase: String\n');
  });

  it('marks the persistent macOS input helper ready before it accepts realtime input', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func writeReady()');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('writeReady()');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('"{\\"ready\\":true}"');
  });

  it('keeps gesture input compatible with the macOS helper schema', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let gesture: String?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('config.event.kind == "gesture"');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('remote gesture input missing delta or coordinates');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('usleep(sleepMicros)');
  });

  it('replays touch swipe gestures as bounded scroll steps instead of one unbounded wheel event', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let REMOTE_GESTURE_REPLAY_MAX_STEP_PX = 120.0');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let REMOTE_GESTURE_REPLAY_MAX_STEPS = 12');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func boundedGestureReplayStepCount(deltaX: Double, deltaY: Double) -> Int');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('Int(ceil(magnitude / REMOTE_GESTURE_REPLAY_MAX_STEP_PX))');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func postGestureSwipeScrollEvent');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toMatch(
      /for step in 0..<stepCount[\s\S]*postScrollEvent\(x: stepX, y: stepY, deltaX: stepDeltaX, deltaY: stepDeltaY/,
    );
  });

  it('requires macOS helper focus verification before reporting input success', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func activateTargetApplication(_ config: InputConfig, _ app: NSRunningApplication)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func frontmostProcessPidFromSystemEvents() -> Int32?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func waitForRunningApplication(_ pid: Int32) -> NSRunningApplication?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('usleep(50000)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('tell application \\"System Events\\" to get unix id of first application process whose frontmost is true');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('System Events\\" to set frontmost of first process whose unix id is');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('/usr/bin/osascript');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('kAXFrontmostAttribute');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('frontmostPidMatches');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('focusedWindowMatchesTarget');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('config.event.kind == "focus"');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('remote input target app is not running pid=');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('remote input target app did not become frontmost');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('remote input target window did not become focused');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('NSAppleScript');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('NSWorkspace.shared.frontmostApplication');
  });

  it('short-circuits repeated focus when the target window is already focused', () => {
    const fastPathIndex = MACOS_REMOTE_WINDOW_INPUT_SWIFT.indexOf(
      'frontmostPidMatches(config.pid)',
    );
    const focusAttemptIndex = MACOS_REMOTE_WINDOW_INPUT_SWIFT.indexOf('for attempt in 0..<3');

    expect(fastPathIndex).toBeGreaterThan(0);
    expect(focusAttemptIndex).toBeGreaterThan(fastPathIndex);
  });

  it('moves the macOS cursor to the remote input coordinate before scroll and gesture wheel events', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func postMouseMove(x: Double, y: Double)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('postMouseMove(x: x, y: y)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toMatch(
      /func postScrollEvent[\s\S]*postMouseMove\(x: x, y: y\)[\s\S]*scrollWheelEvent2Source/,
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toMatch(
      /config\.event\.kind == "gesture"[\s\S]*postGestureSwipeScrollEvent\(/,
    );
  });

  it('maps pressed left pointer movement to a macOS dragged mouse event', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func mouseType(phase: String, button: String?, buttons: Int?)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toMatch(
      /phase == "move"[\s\S]*buttons[\s\S]*\.leftMouseDragged/,
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('mouseType(phase: phase, button: config.event.button, buttons: config.event.buttons)');
  });

  it('maps Command+V through a real macOS virtual key code for remote-window image paste', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('"KeyV": 9');
  });

  it('builds remote-window image paste Command+V as action-only payloads', () => {
    const payloads = buildRemoteWindowImagePasteInputPayloads({
      requestPrefix: 'paste-image-rw',
      streamId: 'stream-paste',
      targetId: 'app-window:123:456',
    });

    expect(payloads).toEqual([
      {
        streamId: 'stream-paste',
        targetId: 'app-window:123:456',
        event: {
          kind: 'key',
          phase: 'down',
          key: 'v',
          code: 'KeyV',
          metaKey: true,
        },
      },
      {
        streamId: 'stream-paste',
        targetId: 'app-window:123:456',
        event: {
          kind: 'key',
          phase: 'up',
          key: 'v',
          code: 'KeyV',
          metaKey: true,
        },
      },
    ]);
  });

  it('builds selectable non-iTerm2 app-window manifests from the macOS app catalog', () => {
    const targets = buildMacosAppWindowTargets(makeAppWindowCatalog(), '2026-07-19T00:00:00.000Z');
    const chrome = targets.find((target) => target.videoTarget.appBundleId === 'com.google.Chrome');

    expect(targets).toHaveLength(2);
    expect(chrome).toMatchObject({
      streamTargetId: 'app-window:487:64',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.google.Chrome',
        pid: 487,
        windowId: '64',
        title: 'Chrome Window',
        cropRectTopLeftPx: { x: 700, y: 139, width: 1200, height: 800 },
      },
      inputTarget: {
        kind: 'app-window',
      },
      streamMode: 'interactive',
      focusPolicy: 'bring-to-focus',
      inputRoute: 'os-event',
      capture: {
        displayId: '8',
        displayBoundsTopLeftPx: { x: 0, y: 0, width: 3840, height: 2160 },
      },
    });
  });

  it('uses the ScreenCaptureKit window frame when AX contentFrame has a title-bar offset', () => {
    const targets = buildMacosAppWindowTargets({
      windows: [{
        ...makeAppWindowCatalog().windows[0],
        contentFrame: { x: 700, y: 168, width: 1200, height: 771 },
      }],
    }, '2026-07-19T00:00:00.000Z');

    expect(targets[0]?.videoTarget).toMatchObject({
      windowBoundsTopLeftPx: { x: 700, y: 139, width: 1200, height: 800 },
      cropRectTopLeftPx: { x: 700, y: 139, width: 1200, height: 800 },
    });
  });

  it('flattens nested iTerm2 splitters before applying top-left crop math', () => {
    const panes = flattenIterm2SplitTree(makeNestedItermTree());

    expect(panes.map((pane) => [pane.sessionId, pane.frame])).toEqual([
      ['left', { x: 0, y: 0, width: 100, height: 200 }],
      ['right-top', { x: 101, y: 0, width: 200, height: 100 }],
      ['right-bottom', { x: 101, y: 101, width: 200, height: 99 }],
    ]);
  });

  it('does not double-count positioned leaf offsets in a real nested iTerm2 split tree', () => {
    const panes = flattenIterm2SplitTree(makeLiveComplexItermTree());
    const paneById = new Map(panes.map((pane) => [pane.sessionId, pane]));

    expect(paneById.get('middle-a-top-left')?.frame.x).toBe(802);
    expect(paneById.get('middle-a-top-right')?.frame.x).toBe(1485);
    expect(paneById.get('middle-b-top')?.frame.x).toBe(2196);
    expect(paneById.get('right-top')?.frame.x).toBe(2984);
    expect(paneById.get('right-bottom')?.frame).toEqual({
      x: 2984,
      y: 988,
      width: 815,
      height: 989,
    });

    const catalog: Iterm2RawCatalog = {
      windows: [{
        windowId: 'live-complex-window',
        title: 'iTerm2',
        frame: { x: 0, y: 85, width: 3799, height: 2045 },
        tabs: [{
          tabId: 'live-complex-tab',
          root: makeLiveComplexItermTree(),
        }],
      }],
    };
    const targets = buildRemoteWindowStreamTargets(
      catalog,
      new Map(),
      '2026-07-19T00:00:00.000Z',
    );

    for (const target of targets.filter((entry) => entry.videoTarget.kind === 'iterm2-pane')) {
      const windowBounds = target.videoTarget.windowBoundsTopLeftPx;
      const crop = target.videoTarget.cropRectTopLeftPx;
      expect(crop).toBeDefined();
      expect(crop!.x).toBeGreaterThanOrEqual(windowBounds.x);
      expect(crop!.y).toBeGreaterThanOrEqual(windowBounds.y);
      expect(crop!.x + crop!.width).toBeLessThanOrEqual(windowBounds.x + windowBounds.width);
      expect(crop!.y + crop!.height).toBeLessThanOrEqual(windowBounds.y + windowBounds.height);
    }
  });

  it('rejects pane manifests whose flattened content exceeds the owning window', () => {
    const catalog = makeCatalog();
    catalog.windows[0]!.frame.width = 300;

    expect(() => buildRemoteWindowStreamTargets(
      catalog,
      new Map(),
      '2026-07-19T00:00:00.000Z',
    )).toThrow('content bounds exceed window bounds');
  });

  it('builds app-window and pane manifests with tmux reverse lookup and no inverted-y crop', () => {
    const tmuxTargets = parseTmuxClientTargets([
      '/dev/ttys002\tzterm\t@1\t%2',
      '/dev/ttys999\tother\t@3\t%4',
    ].join('\n'));

    const targets = buildRemoteWindowStreamTargets(makeCatalog(), tmuxTargets, '2026-07-19T00:00:00.000Z');
    const appTarget = targets.find((target) => target.videoTarget.kind === 'app-window');
    const paneTargets = targets.filter((target) => target.videoTarget.kind === 'iterm2-pane');
    const tmuxPane = paneTargets.find((target) => target.inputTarget.itermSessionId === 'right-top');
    const bottomPane = paneTargets.find((target) => target.inputTarget.itermSessionId === 'right-bottom');

    expect(appTarget?.videoTarget.cropRectTopLeftPx).toEqual({ x: 10, y: 20, width: 302, height: 250 });
    expect(appTarget?.streamMode).toBe('interactive');
    expect(paneTargets).toHaveLength(3);
    expect(tmuxPane?.inputTarget).toMatchObject({
      kind: 'tmux-pane',
      tty: '/dev/ttys002',
      tmuxSession: 'zterm',
      tmuxWindowId: '@1',
      tmuxPaneId: '%2',
    });
    expect(tmuxPane?.focusPolicy).toBe('no-focus-steal');
    expect(tmuxPane?.inputRoute).toBe('tmux-input');
    expect(tmuxPane?.streamMode).toBe('view');
    expect(tmuxPane?.videoTarget.windowId).toBe('window-1');
    expect(tmuxPane?.videoTarget.cropRectTopLeftPx).toEqual({ x: 111, y: 70, width: 200, height: 100 });
    expect(bottomPane?.videoTarget.cropRectTopLeftPx).toEqual({ x: 111, y: 171, width: 200, height: 99 });
    expect(bottomPane?.videoTarget.cropRectTopLeftPx?.y).not.toBe(70);
  });

  it('keeps non-tmux iTerm2 panes selectable without fake tmux metadata', () => {
    const targets = buildRemoteWindowStreamTargets(
      makeCatalog(),
      new Map(),
      '2026-07-19T00:00:00.000Z',
      { includeAppWindowTargets: false },
    );

    expect(targets).toHaveLength(3);
    for (const target of targets) {
      expect(target.inputTarget).toMatchObject({
        kind: 'iterm2-pane',
      });
      expect(target.streamMode).toBe('view');
      expect(target.inputTarget.tmuxSession).toBeUndefined();
      expect(target.focusPolicy).toBe('bring-to-focus');
      expect(target.inputRoute).toBe('iterm2-api');
    }
  });

  it('returns an explicit unsupported-platform error without querying iTerm2', async () => {
    const runIterm2Python = vi.fn(async () => JSON.stringify(makeCatalog()));
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify(makeAppWindowCatalog()));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'linux',
      runIterm2Python,
      runMacosAppWindowCatalog,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-linux' });

    expect(runIterm2Python).not.toHaveBeenCalled();
    expect(runMacosAppWindowCatalog).not.toHaveBeenCalled();
    expect(response).toEqual({
      requestId: 'rw-linux',
      code: 'remote_window_platform_unsupported',
      message: 'remote window stream catalog is only available on macOS daemon hosts',
    });
  });

  it('queries iTerm2 and returns typed target manifests on macOS daemon hosts', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      now: () => '2026-07-19T00:00:00.000Z',
      runIterm2Python: vi.fn(async () => JSON.stringify(makeCatalog())),
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '/dev/ttys001\talpha\t@5\t%6\n' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-darwin', includeAppWindows: false });

    expect('targets' in response ? response.targets.length : 0).toBe(3);
    expect('targets' in response ? response.targets[0]?.inputTarget : null).toMatchObject({
      kind: 'tmux-pane',
      tmuxSession: 'alpha',
      tmuxWindowId: '@5',
      tmuxPaneId: '%6',
    });
    expect('targets' in response ? response.targets[0]?.videoTarget.windowId : null).toBe('33');
  });

  it('returns non-iTerm2 app windows and non-tmux iTerm2 panes in the same catalog response', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      now: () => '2026-07-19T00:00:00.000Z',
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runIterm2Python: vi.fn(async () => JSON.stringify(makeCatalog())),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-combined' });
    expect('targets' in response ? response.targets : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          streamTargetId: 'app-window:487:64',
          videoTarget: expect.objectContaining({
            kind: 'app-window',
            appBundleId: 'com.google.Chrome',
          }),
          inputTarget: { kind: 'app-window' },
        }),
        expect.objectContaining({
          streamTargetId: 'iterm2-pane:window-1:tab-1:left',
          videoTarget: expect.objectContaining({
            windowId: '33',
          }),
          inputTarget: expect.objectContaining({
            kind: 'iterm2-pane',
          }),
        }),
      ]),
    );
    expect('targets' in response ? response.targets.filter((target) => target.videoTarget.kind === 'app-window') : []).toHaveLength(2);
    expect('targets' in response ? response.targets.filter((target) => target.videoTarget.kind === 'iterm2-pane') : []).toHaveLength(3);
  });

  it('returns stale daemon target catalog immediately while a background refresh runs', async () => {
    let nowMs = 10_000;
    const refreshGate: { release?: (value: string) => void } = {};
    const firstCatalog = makeAppWindowCatalog();
    const secondCatalog = makeAppWindowCatalog();
    secondCatalog.windows = [{
      ...secondCatalog.windows[0]!,
      windowId: '99',
      title: 'New cached window',
    }];
    const runMacosAppWindowCatalog = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(firstCatalog))
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        refreshGate.release = resolve;
      }));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      nowMs: () => nowMs,
      targetCatalogCacheTtlMs: 500,
      runMacosAppWindowCatalog,
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const first = await runtime.listTargets({
      requestId: 'rw-first',
      includeIterm2: false,
    });
    expect('targets' in first ? first.targets.map((target) => target.videoTarget.title) : []).toContain('Chrome Window');

    nowMs += 501;
    const second = await runtime.listTargets({
      requestId: 'rw-second',
      includeIterm2: false,
    });
    expect('targets' in second ? second.targets.map((target) => target.videoTarget.title) : []).toContain('Chrome Window');
    expect('targets' in second ? second.requestId : '').toBe('rw-second');
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(2);

    refreshGate.release?.(JSON.stringify(secondCatalog));
    await flushPromiseQueue();

    nowMs += 1;
    const third = await runtime.listTargets({
      requestId: 'rw-third',
      includeIterm2: false,
    });
    expect('targets' in third ? third.targets.map((target) => target.videoTarget.title) : []).toContain('New cached window');
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(2);
  });

  it('honors force-refresh by bypassing the daemon target catalog cache', async () => {
    const firstCatalog = makeAppWindowCatalog();
    const secondCatalog = makeAppWindowCatalog();
    secondCatalog.windows = [{
      ...secondCatalog.windows[0]!,
      windowId: '100',
      title: 'Forced catalog window',
    }];
    const runMacosAppWindowCatalog = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(firstCatalog))
      .mockResolvedValueOnce(JSON.stringify(secondCatalog));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      targetCatalogCacheTtlMs: 60_000,
      runMacosAppWindowCatalog,
      runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.listTargets({ requestId: 'rw-first', includeIterm2: false });
    const refreshed = await runtime.listTargets({
      requestId: 'rw-refresh',
      includeIterm2: false,
      forceRefresh: true,
    });

    expect('targets' in refreshed ? refreshed.targets.map((target) => target.videoTarget.title) : []).toContain('Forced catalog window');
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(2);
  });

  it('warms the daemon target catalog cache for the first picker request', async () => {
    const runMacosAppWindowCatalog = vi.fn(async () => JSON.stringify(makeAppWindowCatalog()));
    const runIterm2Python = vi.fn(async () => JSON.stringify(makeCatalog()));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      warmTargetCatalogOnStart: true,
      runMacosAppWindowCatalog,
      runIterm2Python,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-warmed' });

    expect('targets' in response ? response.targets.length : 0).toBeGreaterThan(0);
    expect(runMacosAppWindowCatalog).toHaveBeenCalledTimes(1);
    expect(runIterm2Python).toHaveBeenCalledTimes(1);
  });

  it('keeps app-window targets selectable while surfacing iTerm2 catalog errors explicitly', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runIterm2Python: vi.fn(async () => {
        throw new Error('No module named iterm2');
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-partial' });

    expect('targets' in response ? response.targets.map((target) => target.streamTargetId) : []).toContain('app-window:487:64');
    expect('errors' in response ? response.errors : []).toEqual([{
      requestId: 'rw-partial',
      code: 'iterm2_api_unavailable',
      message: 'iTerm2 Python API unavailable: missing Python module iterm2',
    }]);
  });

  it('does not expose the inline Python catalog script in user-visible daemon errors', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runMacosAppWindowCatalog: vi.fn(async () => JSON.stringify(makeAppWindowCatalog())),
      runIterm2Python: vi.fn(async () => {
        throw new Error([
          'Command failed: python3 -c import json import iterm2 def frame_dict(frame): return {"x": frame.origin.x}',
          'Traceback (most recent call last):',
          '  File "<string>", line 3, in <module>',
          "ModuleNotFoundError: No module named 'iterm2'",
        ].join('\n'));
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-short-error' });
    const errorMessage = 'errors' in response ? response.errors?.[0]?.message || '' : '';

    expect(errorMessage).toBe('iTerm2 Python API unavailable: missing Python module iterm2');
    expect(errorMessage).not.toContain('python3 -c');
    expect(errorMessage).not.toContain('frame_dict');
  });

  it('summarizes long catalog failures without dropping the explicit failure reason', () => {
    const message = summarizeRemoteWindowCatalogError(
      new Error([
        'Command failed: swift -e import AppKit func number(_ value: Any?) -> Double? { return nil }',
        'remote permission denied while listing windows',
      ].join('\n')),
      'macOS app window catalog unavailable',
    );

    expect(message).toBe('remote permission denied while listing windows');
    expect(message).not.toContain('swift -e');
    expect(message.length).toBeLessThanOrEqual(220);
  });

  it('reports app-window catalog timeout without exposing the inline Swift script', async () => {
    const runner = makeTempExecutable('zterm-remote-window-catalog-timeout-', `#!/bin/sh
sleep 2
`);
    try {
      const runtime = createRemoteWindowStreamDaemonRuntime({
        platform: 'darwin',
        swiftBinary: runner.executablePath,
        appWindowCatalogTimeoutMs: 80,
        runIterm2Python: vi.fn(async () => JSON.stringify({ windows: [] })),
        runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
      });

      const response = await runtime.listTargets({
        requestId: 'rw-catalog-timeout',
        includeAppWindows: true,
        includeIterm2: false,
        forceRefresh: true,
      });

      expect(response).toEqual({
        requestId: 'rw-catalog-timeout',
        code: 'app_window_catalog_unavailable',
        message: 'macOS app window catalog timed out after 80ms',
      });
      const message = 'message' in response ? response.message : '';
      expect(message).not.toContain('swift -e');
      expect(message).not.toContain('import AppKit');
    } finally {
      runner.cleanup();
    }
  });

  it('adds timeout and stderr detail to ScreenCaptureKit startup timeout errors', async () => {
    expect(buildScreenCaptureKitStartupTimeoutMessage(
      'ScreenCaptureKit capture start waiting for frame permission gate\n',
      80,
    )).toBe(
      'ScreenCaptureKit capture did not produce a frame before timeout after 80ms: ScreenCaptureKit capture start waiting for frame permission gate',
    );

    const runner = makeTempExecutable('zterm-remote-window-capture-timeout-', `#!/bin/sh
echo "ScreenCaptureKit capture start waiting for frame permission gate" >&2
sleep 2
`);
    try {
      await expect(startScreenCaptureKitFrameSource(makeAppStreamTarget(), {
        frameRate: 12,
        startupTimeoutMs: 80,
        swiftBinary: runner.executablePath,
        captureBinary: runner.executablePath,
        validateTargets: async () => undefined,
        onFrame: vi.fn(),
        onError: vi.fn(),
      })).rejects.toThrow('ScreenCaptureKit capture did not produce a frame before timeout after 80ms');
    } finally {
      runner.cleanup();
    }
  });

  it('formats ScreenCaptureKit startup timeout without stderr detail', () => {
    expect(buildScreenCaptureKitStartupTimeoutMessage('', 20_000)).toBe(
      'ScreenCaptureKit capture did not produce a frame before timeout after 20000ms',
    );
  });

  it('configures ScreenCaptureKit with bounded frame queue depth and explicit FPS interval', async () => {
    expect(buildScreenCaptureKitConfig(makeAppStreamTarget(), 60)).toMatchObject({
      frameRate: 60,
      queueDepth: 3,
      cropRect: { x: 10, y: 20, width: 800, height: 600 },
    });
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('streamConfiguration.queueDepth = max(3, min(3, queueDepth))');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('streamConfiguration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, frameRate)))');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).not.toContain('SCScreenshotManager');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('DispatchQueue.global(qos: .userInitiated).async');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('Task {');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('Screen Recording permission is required');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('windowId: command.windowId');
    expect(SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT).toContain('remote window capture target not found in SCShareableContent');
    expect(buildScreenCaptureKitConfig(makeAppStreamTarget(), 60)).toMatchObject({
      frameRate: 60,
      queueDepth: 3,
    });
  });

  it('keeps the ScreenCaptureKit command channel open and updates capture dimensions', async () => {
    const runner = makeTempExecutable('zterm-remote-window-capture-update-', `#!/usr/bin/env node
function writeFrame(width, height) {
  const rgba = Buffer.alloc(width * height * 4, 12);
  const header = Buffer.alloc(16);
  header.write('ZRW1', 0, 'ascii');
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt32LE(rgba.length, 12);
  process.stdout.write(Buffer.concat([header, rgba]));
}
writeFrame(2, 2);
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const command = JSON.parse(line);
      const width = Math.max(1, Math.round(command.cropRect.width));
      const height = Math.max(1, Math.round(command.cropRect.height));
      process.stderr.write('ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE ' + JSON.stringify({ seq: command.seq, ok: true, width, height }) + '\\n');
      writeFrame(width, height);
    }
    newline = buffer.indexOf('\\n');
  }
});
setInterval(() => {}, 1000);
`);
    const frames: Array<{ width: number; height: number }> = [];
    try {
      const source = await startScreenCaptureKitFrameSource(makeAppStreamTarget(), {
        frameRate: 30,
        startupTimeoutMs: 10_000,
        swiftBinary: runner.executablePath,
        captureBinary: runner.executablePath,
        validateTargets: async () => undefined,
        onFrame: (frame) => frames.push({ width: frame.width, height: frame.height }),
        onError: vi.fn(),
      });
      const nextTarget = makeAppStreamTarget();
      nextTarget.videoTarget.windowBoundsTopLeftPx = { x: 10, y: 20, width: 800, height: 1477 };
      nextTarget.videoTarget.cropRectTopLeftPx = { x: 10, y: 20, width: 800, height: 1477 };

      if (!source.updateTarget) {
        throw new Error('expected updateTarget to be available');
      }
      await source.updateTarget(nextTarget);

      expect(source.width).toBe(800);
      expect(source.height).toBe(1477);
      expect(frames).toContainEqual({ width: 2, height: 2 });
      await vi.waitFor(() => {
        expect(frames).toContainEqual({ width: 800, height: 1477 });
      });
      expect(frames).toContainEqual({ width: 800, height: 1477 });
      source.stop();
    } finally {
      runner.cleanup();
    }
  });

  it('surfaces iTerm2 API failures explicitly instead of falling back to screenshot or terminal buffer truth', async () => {
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      runIterm2Python: vi.fn(async () => {
        throw new Error('No module named iterm2');
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const response = await runtime.listTargets({ requestId: 'rw-error', includeAppWindows: false });

    expect(response).toEqual({
      requestId: 'rw-error',
      code: 'iterm2_api_unavailable',
      message: 'iTerm2 Python API unavailable: missing Python module iterm2',
    });
  });

  it('starts a real stream lifecycle with capture frames feeding only the WebRTC video source', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    const captureStop = vi.fn();
    const statuses: unknown[] = [];
    const candidates: unknown[] = [];
    const captureSourceFactory = vi.fn(async (_target, options) => {
      options.onFrame({
        width: 2,
        height: 2,
        rgba: new Uint8Array(16).fill(12),
      });
      return {
        width: 2,
        height: 2,
        frameRate: options.frameRate,
        stop: captureStop,
      };
    });
    const rgbaToI420 = vi.fn((_rgba, i420) => {
      i420.data.fill(7);
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-start',
      streamId: 'stream-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendIceCandidate: (payload) => candidates.push(payload),
      sendStatus: (payload) => statuses.push(payload),
    });
    await flushPromiseQueue();

    expect('answer' in result ? result : null).toMatchObject({
      requestId: 'rw-start',
      streamId: 'stream-1',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      answer: { type: 'answer', sdp: 'daemon-answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 2,
        frameHeight: 2,
        frameRate: 30,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video' },
    });
    expect(fakePeer.setRemoteDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: 'android-offer-sdp',
    });
    expect(fakePeer.addTrack).toHaveBeenCalledWith(fakeTrack);
    expect(captureSourceFactory).toHaveBeenCalledWith(
      makeStreamTarget(),
      expect.objectContaining({
        frameRate: 30,
        swiftBinary: 'swift',
        onFrame: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(rgbaToI420).toHaveBeenCalled();
    expect(fakeVideoSource.onFrame).toHaveBeenCalledWith({
      width: 2,
      height: 2,
      data: new Uint8Array(6).fill(7),
    });
    expect(statuses).toEqual([
      {
        requestId: 'rw-start',
        streamId: 'stream-1',
        purpose: 'focus',
        phase: 'starting',
        stage: 'capability-verified',
        capability: {
          mediaPlan: 'single-focus' as const,
          mediaPlanVersion: 1 as const,
          lanes: [{ role: 'focus', requiredForStart: true }],
          maxVideoLanes: 1,
          screenCaptureKit: true,
          typedPerLaneStatus: true,
          preflight: {
            wrtc: 'available',
            abi: 'supported',
            swiftHelper: 'configured',
            screenRecordingPermission: 'pending-capture',
            capture: 'pending',
            senderNegotiation: 'pending',
          },
        },
      },
      { requestId: 'rw-start', streamId: 'stream-1', purpose: 'focus', phase: 'starting' },
      {
        requestId: 'rw-start',
        streamId: 'stream-1',
        purpose: 'focus',
        phase: 'starting',
        stage: 'capture-started',
        lane: 'focus',
      },
      {
        requestId: 'rw-start',
        streamId: 'stream-1',
        purpose: 'focus',
        phase: 'streaming',
        framesSent: 1,
        frameWidth: 2,
        frameHeight: 2,
      },
    ]);
    expect(candidates).toEqual([{
      requestId: 'rw-start',
      streamId: 'stream-1',
      purpose: 'focus',
      candidate: {
        candidate: 'candidate:daemon',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'daemon',
      },
    }]);
  });

  it('rejects an unsupported native WebRTC ABI before allocating peer or capture resources', async () => {
    const captureSourceFactory = vi.fn();
    const peerConnectionFactory = vi.fn();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      arch: 'ia32',
      captureSourceFactory,
      peerConnectionFactory,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await expect(runtime.startStream({
      requestId: 'rw-unsupported-abi',
      streamId: 'stream-unsupported-abi',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    })).resolves.toEqual({
      requestId: 'rw-unsupported-abi',
      streamId: 'stream-unsupported-abi',
      code: 'remote_window_webrtc_abi_unsupported',
      message: 'remote window WebRTC ABI is unsupported: darwin-ia32',
      failureStage: 'platform-capability',
    });
    expect(peerConnectionFactory).not.toHaveBeenCalled();
    expect(captureSourceFactory).not.toHaveBeenCalled();
  });

  it('fails negotiation explicitly without rewriting SDP or starting capture', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    fakePeer.setRemoteDescription.mockRejectedValueOnce(new Error('offer rejected'));
    const captureSourceFactory = vi.fn();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn(),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    const result = await runtime.startStream({
      requestId: 'rw-negotiation-fail',
      streamId: 'stream-negotiation-fail',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'invalid-client-offer' },
    });
    expect(result).toMatchObject({
      requestId: 'rw-negotiation-fail',
      streamId: 'stream-negotiation-fail',
      code: 'remote_window_stream_start_failed',
      message: 'offer rejected',
      failureStage: 'offer-apply',
    });
    expect(fakePeer.setRemoteDescription).toHaveBeenCalledTimes(1);
    expect(fakePeer.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'invalid-client-offer' });
    expect(captureSourceFactory).not.toHaveBeenCalled();
    expect(fakePeer.close).toHaveBeenCalledTimes(1);
  });

  it('projects stale fresh-content validation as target-validation instead of generic startup failure', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async () => {
        throw new RemoteWindowCaptureTargetUnavailableError(['16260']);
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn(),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-stale-target',
      streamId: 'stream-stale-target',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeAppStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toMatchObject({
      requestId: 'rw-stale-target',
      streamId: 'stream-stale-target',
      code: 'remote_window_target_not_found',
      message: 'remote window target not found in fresh SCShareableContent: 16260',
      failureStage: 'target-validation',
    });
    expect(fakePeer.close).toHaveBeenCalledTimes(1);
  });

  it('projects composite target frames outside the display as typed target-validation failure', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async () => {
        throw new RemoteWindowCaptureTargetOutOfDisplayError('200', {
          x: 2694,
          y: 873,
          width: 1347,
          height: 679,
        }, {
          x: 0,
          y: 0,
          width: 3840,
          height: 2160,
        });
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn(),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-out-of-display',
      streamId: 'stream-out-of-display',
      mediaPlan: 'overview-plus-focus' as const,
      mediaPlanVersion: 1 as const,
      target: {
        ...makeAppStreamTarget(),
        compositeWindows: [{
          windowId: '200',
          title: 'Preview',
          windowBoundsTopLeftPx: { x: 2694, y: 873, width: 1347, height: 679 },
          cropRectTopLeftPx: { x: 2694, y: 873, width: 1347, height: 679 },
        }],
        capture: {
          ...makeAppStreamTarget().capture,
          displayBoundsTopLeftPx: { x: 0, y: 0, width: 3840, height: 2160 },
        },
      },
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toMatchObject({
      requestId: 'rw-out-of-display',
      streamId: 'stream-out-of-display',
      code: 'remote_window_target_out_of_display',
      message: expect.stringContaining('remote window target frame is outside display'),
      failureStage: 'target-validation',
    });
    expect(fakePeer.close).toHaveBeenCalledTimes(0);
  });

  it('rejects a missing or mismatched media plan before creating peer/capture resources', async () => {
    const peerConnectionFactory = vi.fn();
    const captureSourceFactory = vi.fn();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      peerConnectionFactory,
      captureSourceFactory,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    const base = {
      requestId: 'rw-plan-contract',
      streamId: 'stream-plan-contract',
      target: makeStreamTarget(),
      offer: { type: 'offer' as const, sdp: 'android-offer-sdp' },
    };

    await expect(runtime.startStream(base as never)).resolves.toMatchObject({
      code: 'remote_window_stream_media_plan_mismatch',
      message: 'remote window media plan mismatch: expected single-focus, got undefined',
    });
    await expect(runtime.startStream({
      ...base,
      requestId: 'rw-plan-contract-mismatch',
      streamId: 'stream-plan-contract-mismatch',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 1 as const,
    })).resolves.toMatchObject({
      code: 'remote_window_stream_media_plan_mismatch',
      message: 'remote window media plan mismatch: expected single-focus, got overview-plus-focus',
    });
    await expect(runtime.startStream({
      ...base,
      requestId: 'rw-plan-version-mismatch',
      streamId: 'stream-plan-version-mismatch',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2,
    } as never)).resolves.toMatchObject({
      code: 'remote_window_stream_media_plan_version_mismatch',
      message: 'remote window media plan version mismatch: expected 1, got 2',
      failureStage: 'media-plan-validation',
    });
    expect(peerConnectionFactory).not.toHaveBeenCalled();
    expect(captureSourceFactory).not.toHaveBeenCalled();
  });

  it('keeps low-rate preview and high-quality focus streams independent in daemon lifecycle', async () => {
    const canvasPeer = new FakeRemoteWindowPeerConnection();
    const focusPeer = new FakeRemoteWindowPeerConnection();
    canvasPeer.addTrack.mockReturnValue(makeFakeRtpSender());
    focusPeer.addTrack.mockReturnValue(makeFakeRtpSender());
    const peers = [canvasPeer, focusPeer];
    const tracks = [makeFakeMediaStreamTrack(), makeFakeMediaStreamTrack()];
    const videoSources = tracks.map((track) => ({
      createTrack: vi.fn(() => track),
      onFrame: vi.fn(),
    }));
    const captureStops = [vi.fn(), vi.fn()];
    let captureIndex = 0;
    const captureSourceFactory: RemoteWindowCaptureSourceFactory = vi.fn(async (_target, options) => {
      options.onFrame({
        width: 2,
        height: 2,
        rgba: new Uint8Array(16).fill(12),
      });
      const index = captureIndex;
      captureIndex += 1;
      return makeControllableCaptureSource(options, captureStops[index]!);
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => peers.shift() as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => videoSources.shift() as any),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await expect(runtime.startStream({
      requestId: 'rw-canvas',
      streamId: 'canvas-stream',
      purpose: 'preview',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'canvas-offer' },
      videoProfile: smoothVideoProfile,
    })).resolves.toMatchObject({
      streamId: 'canvas-stream',
      purpose: 'preview',
      capture: { maxBitrateBps: 6_000_000 },
    });
    await expect(runtime.startStream({
      requestId: 'rw-focus',
      streamId: 'focus-stream',
      purpose: 'focus',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'focus-offer' },
      videoProfile: qualityVideoProfile,
    })).resolves.toMatchObject({
      streamId: 'focus-stream',
      purpose: 'focus',
      capture: { maxBitrateBps: 16_000_000 },
    });

    await expect(runtime.stopStream({
      requestId: 'rw-stop-focus',
      streamId: 'focus-stream',
      purpose: 'focus',
    })).resolves.toMatchObject({
      streamId: 'focus-stream',
      purpose: 'focus',
      phase: 'stopped',
    });
    await expect(runtime.addIceCandidate({
      streamId: 'canvas-stream',
      candidate: { candidate: 'candidate:canvas' },
    })).resolves.toBe(true);
    expect(captureStops[0]).not.toHaveBeenCalled();
    expect(captureStops[1]).toHaveBeenCalledTimes(1);
  });

  it('defers the first capture frame only until the sender local description is ready', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    fakePeer.connectionState = 'new';
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    const statuses: unknown[] = [];
    let pushFrame: (frame: { width: number; height: number; rgba: Uint8Array }) => void = () => undefined;
    const captureSourceFactory = vi.fn(async (_target, options) => {
      pushFrame = options.onFrame;
      options.onFrame({
        width: 2,
        height: 2,
        rgba: new Uint8Array(16).fill(12),
      });
      return {
        width: 2,
        height: 2,
        frameRate: options.frameRate,
        stop: vi.fn(),
      };
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-early-frame',
      streamId: 'stream-early-frame',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (payload) => statuses.push(payload),
    });
    await flushPromiseQueue();

    expect('answer' in result).toBe(true);
    expect(fakePeer.connectionState).toBe('new');
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(1);
    expect(fakeVideoSource.onFrame).toHaveBeenCalledWith({
      width: 2,
      height: 2,
      data: new Uint8Array(6).fill(7),
    });
    pushFrame({
      width: 2,
      height: 2,
      rgba: new Uint8Array(16).fill(13),
    });
    await flushPromiseQueue();
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      {
        requestId: 'rw-early-frame',
        streamId: 'stream-early-frame',
        purpose: 'focus',
        phase: 'starting',
        stage: 'capability-verified',
        capability: { mediaPlan: 'single-focus' as const, mediaPlanVersion: 1 as const, lanes: [{ role: 'focus', requiredForStart: true }], maxVideoLanes: 1, screenCaptureKit: true, typedPerLaneStatus: true, preflight: { wrtc: 'available', abi: 'supported', swiftHelper: 'configured', screenRecordingPermission: 'pending-capture', capture: 'pending', senderNegotiation: 'pending' } },
      },
      { requestId: 'rw-early-frame', streamId: 'stream-early-frame', purpose: 'focus', phase: 'starting' },
      { requestId: 'rw-early-frame', streamId: 'stream-early-frame', purpose: 'focus', phase: 'starting', stage: 'capture-started', lane: 'focus' },
      {
        requestId: 'rw-early-frame',
        streamId: 'stream-early-frame',
        purpose: 'focus',
        phase: 'streaming',
        framesSent: 1,
        frameWidth: 2,
        frameHeight: 2,
      },
    ]);
  });

  it('keeps one latest focus frame, drops over-age work, and applies the active age budget', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    let clockMs = 1_000;
    let pushFrame: (frame: {
      width: number;
      height: number;
      rgba: Uint8Array;
      capturedAtMs?: number;
    }) => void = () => undefined;
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      nowMs: () => clockMs,
      captureSourceFactory: vi.fn(async (_target, options) => {
        pushFrame = options.onFrame;
        return makeControllableCaptureSource(options);
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420: vi.fn((rgba, i420) => {
        i420.data.fill(rgba.data[0] ?? 0);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-latest-focus',
      streamId: 'stream-latest-focus',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 1,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoProfile: smoothVideoProfile,
    });

    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1), capturedAtMs: clockMs });
    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(2), capturedAtMs: clockMs });
    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(3), capturedAtMs: clockMs });
    await flushPromiseQueue();
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(1);
    expect(fakeVideoSource.onFrame).toHaveBeenLastCalledWith({
      width: 2,
      height: 2,
      data: new Uint8Array(6).fill(3),
    });

    clockMs = 1_120;
    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(4), capturedAtMs: 1_000 });
    await flushPromiseQueue();
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(1);

    await runtime.updateStreamQuality({
      requestId: 'rw-latest-focus-quality',
      streamId: 'stream-latest-focus',
      streamGroupId: 'stream-latest-focus',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 1,
      revision: 1,
      targetId: makeStreamTarget().streamTargetId,
      videoProfile: qualityVideoProfile,
    });
    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(5), capturedAtMs: 1_000 });
    await flushPromiseQueue();
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(2);
    expect(fakeVideoSource.onFrame).toHaveBeenLastCalledWith({
      width: 2,
      height: 2,
      data: new Uint8Array(6).fill(5),
    });

    await runtime.stopStream({
      requestId: 'rw-latest-focus-stop',
      streamId: 'stream-latest-focus',
    });
    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(6), capturedAtMs: clockMs });
    await flushPromiseQueue();
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(2);
  });

  it('drains focus and overview through independent latest-frame slots', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const focusVideoSource = {
      createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
      onFrame: vi.fn(),
    };
    const overviewVideoSource = {
      createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
      onFrame: vi.fn(),
    };
    const videoSources = [focusVideoSource, overviewVideoSource];
    let videoSourceIndex = 0;
    let focusFrame: Parameters<RemoteWindowCaptureSourceFactory>[1]['onFrame'] = () => undefined;
    let overviewFrame: Parameters<RemoteWindowCaptureSourceFactory>[1]['onFrame'] = () => undefined;
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      nowMs: () => 2_000,
      captureSourceFactory: vi.fn(async (target, options) => {
        if (target.compositeWindows?.length) {
          overviewFrame = options.onFrame;
        } else {
          focusFrame = options.onFrame;
        }
        return makeControllableCaptureSource(options);
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => videoSources[videoSourceIndex++] as any),
      rgbaToI420: vi.fn((rgba, i420) => {
        i420.data.fill(rgba.data[0] ?? 0);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    const compositeTarget = {
      ...makeStreamTarget(),
      videoTarget: {
        ...makeStreamTarget().videoTarget,
        kind: 'app-window' as const,
        appBundleId: 'com.google.Chrome',
        windowId: 'app-window:487:64',
      },
      compositeWindows: [{
        windowId: 'app-window:487:65',
        title: 'Second window',
        windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
      }],
    };

    await runtime.startStream({
      requestId: 'rw-independent-lanes',
      streamId: 'stream-independent-lanes',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 1,
      target: compositeTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    focusFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1), capturedAtMs: 2_000 });
    focusFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(2), capturedAtMs: 2_000 });
    overviewFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(9), capturedAtMs: 2_000 });
    await flushPromiseQueue();

    expect(focusVideoSource.onFrame).toHaveBeenCalledTimes(1);
    expect(focusVideoSource.onFrame).toHaveBeenCalledWith({
      width: 2,
      height: 2,
      data: new Uint8Array(6).fill(2),
    });
    expect(overviewVideoSource.onFrame).toHaveBeenCalledTimes(1);
    expect(overviewVideoSource.onFrame).toHaveBeenCalledWith({
      width: 2,
      height: 2,
      data: new Uint8Array(6).fill(9),
    });
  });

  it('does not replay frames after the stream is stopped', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    fakePeer.connectionState = 'new';
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    const captureStop = vi.fn();
    const statuses: unknown[] = [];
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({
          width: 2,
          height: 2,
          rgba: new Uint8Array(16).fill(12),
        });
        return {
          width: 2,
          height: 2,
          frameRate: options.frameRate,
          stop: captureStop,
        };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-early-frame-stop',
      streamId: 'stream-early-frame-stop',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (payload) => statuses.push(payload),
    });
    await flushPromiseQueue();

    expect('answer' in result).toBe(true);
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(1);

    const stopped = await runtime.stopStream({
      requestId: 'rw-stop-before-connected',
      streamId: 'stream-early-frame-stop',
    });
    fakePeer.connectionState = 'connected';
    fakePeer.onconnectionstatechange?.();

    expect(stopped).toMatchObject({
      requestId: 'rw-stop-before-connected',
      streamId: 'stream-early-frame-stop',
      phase: 'stopped',
      framesSent: 1,
    });
    expect(captureStop).toHaveBeenCalledTimes(1);
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      {
        requestId: 'rw-early-frame-stop',
        streamId: 'stream-early-frame-stop',
        purpose: 'focus',
        phase: 'starting',
        stage: 'capability-verified',
        capability: { mediaPlan: 'single-focus' as const, mediaPlanVersion: 1 as const, lanes: [{ role: 'focus', requiredForStart: true }], maxVideoLanes: 1, screenCaptureKit: true, typedPerLaneStatus: true, preflight: { wrtc: 'available', abi: 'supported', swiftHelper: 'configured', screenRecordingPermission: 'pending-capture', capture: 'pending', senderNegotiation: 'pending' } },
      },
      { requestId: 'rw-early-frame-stop', streamId: 'stream-early-frame-stop', purpose: 'focus', phase: 'starting' },
      { requestId: 'rw-early-frame-stop', streamId: 'stream-early-frame-stop', purpose: 'focus', phase: 'starting', stage: 'capture-started', lane: 'focus' },
      {
        requestId: 'rw-early-frame-stop',
        streamId: 'stream-early-frame-stop',
        purpose: 'focus',
        phase: 'streaming',
        framesSent: 1,
        frameWidth: 2,
        frameHeight: 2,
      },
      {
        requestId: 'rw-early-frame-stop',
        streamId: 'stream-early-frame-stop',
        purpose: 'focus',
        phase: 'stopped',
        framesSent: 1,
        message: 'remote window stream stopped',
      },
    ]);
  });

  it('uses addTrack for stream start so bitrate requests still negotiate a sendonly video track', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeSender = makeFakeRtpSender();
    fakePeer.addTrack.mockReturnValue(fakeSender);
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({
          width: 2,
          height: 2,
          rgba: new Uint8Array(16).fill(12),
        });
        return makeControllableCaptureSource(options);
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const started = await runtime.startStream({
      requestId: 'rw-bitrate-start',
      streamId: 'stream-bitrate',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoProfile: smoothVideoProfile,
    });

    expect('answer' in started ? started.capture.maxBitrateBps : null).toBe(6_000_000);
    expect(fakePeer.addTrack).toHaveBeenCalledWith(fakeTrack);
    expect(fakePeer.addTransceiver).not.toHaveBeenCalled();
    expect(fakeSender.setParameters).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 6_000_000, maxFramerate: 30 })],
    }));
    expect(fakePeer.setLocalDescription.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSender.setParameters.mock.invocationCallOrder[0]!,
    );

    const updated = await runtime.updateStreamQuality({
      requestId: 'rw-bitrate-update',
      streamId: 'stream-bitrate',
      streamGroupId: 'stream-bitrate',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'iterm2-pane:window-1:tab-1:left',
      videoProfile: qualityVideoProfile,
    });

    expect(updated).toEqual({
      requestId: 'rw-bitrate-update',
      streamId: 'stream-bitrate',
      streamGroupId: 'stream-bitrate',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      purpose: 'focus',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      status: 'applied',
      requestedVideoProfile: qualityVideoProfile,
      appliedVideoProfile: qualityVideoProfile,
      appliedGroupBudget: {
        totalMaxBitrateBps: 16_000_000,
        focus: {
          maxBitrateBps: 16_000_000,
          maxFrameRateFps: 30,
          maxCaptureWidth: 1920,
          maxCaptureHeight: 1200,
          maxFrameAgeMs: 150,
        },
      },
    });
    expect(fakeSender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 16_000_000, maxFramerate: 30 })],
    }));
  });

  it('starts remote window stream without fabricating sender encodings for video bitrate', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeSender = makeFakeRtpSender({ encodings: [] } as unknown as RTCRtpSendParameters);
    fakePeer.addTransceiver = undefined as unknown as FakeRemoteWindowPeerConnection['addTransceiver'];
    fakePeer.addTrack.mockReturnValue(fakeSender);
    const fakeTrack = makeFakeMediaStreamTrack();
    const statuses: RemoteWindowStreamStatusPayload[] = [];
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(12) });
        return makeControllableCaptureSource(options);
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const started = await runtime.startStream({
      requestId: 'rw-bitrate-empty-start',
      streamId: 'stream-bitrate-empty',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoProfile: smoothVideoProfile,
    }, {
      sendStatus: (status) => {
        statuses.push(status);
      },
    });

    expect('answer' in started).toBe(true);
    if ('answer' in started) {
      expect(started.capture).not.toHaveProperty('maxBitrateBps');
    }
    expect(fakeSender.setParameters).not.toHaveBeenCalled();
    expect(statuses).toContainEqual({
      requestId: 'rw-bitrate-empty-start',
      streamId: 'stream-bitrate-empty',
      purpose: 'focus',
      phase: 'starting',
      message: 'video profile not applied: remote window quality sender has no encodings to update',
    });

    const updated = await runtime.updateStreamQuality({
      requestId: 'rw-bitrate-empty-update',
      streamId: 'stream-bitrate-empty',
      streamGroupId: 'stream-bitrate-empty',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'iterm2-pane:window-1:tab-1:left',
      videoProfile: qualityVideoProfile,
    });

    expect(updated).toEqual({
      requestId: 'rw-bitrate-empty-update',
      streamId: 'stream-bitrate-empty',
      streamGroupId: 'stream-bitrate-empty',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      purpose: 'focus',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      status: 'rejected',
      requestedVideoProfile: qualityVideoProfile,
      error: {
        code: 'remote_window_stream_quality_failed',
        message: 'remote window quality sender has no encodings to update',
      },
    });
    expect(fakeSender.setParameters).not.toHaveBeenCalled();

    const planMismatch = await runtime.updateStreamQuality({
      requestId: 'rw-quality-plan-mismatch',
      streamId: 'stream-bitrate-empty',
      streamGroupId: 'stream-bitrate-empty',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 1,
      revision: 1,
      targetId: makeStreamTarget().streamTargetId,
      videoProfile: qualityVideoProfile,
    });
    expect(planMismatch).toMatchObject({
      status: 'rejected',
      error: {
        code: 'remote_window_stream_quality_media_plan_mismatch',
        message: 'remote window stream quality media plan mismatch: expected single-focus@1, got overview-plus-focus@1',
      },
    });
    expect(fakeSender.setParameters).not.toHaveBeenCalled();
  });

  it('rejects stream quality updates for the wrong target without changing sender parameters', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeSender = makeFakeRtpSender();
    fakePeer.addTrack.mockReturnValue(fakeSender);
    const fakeTrack = makeFakeMediaStreamTrack();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(12) });
        return makeControllableCaptureSource(options);
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-bitrate-mismatch-start',
      streamId: 'stream-bitrate-mismatch',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoProfile: smoothVideoProfile,
    });
    fakeSender.setParameters.mockClear();

    const updated = await runtime.updateStreamQuality({
      requestId: 'rw-bitrate-mismatch',
      streamId: 'stream-bitrate-mismatch',
      streamGroupId: 'stream-bitrate-mismatch',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'wrong-target',
      videoProfile: qualityVideoProfile,
    });

    expect(updated).toEqual({
      requestId: 'rw-bitrate-mismatch',
      streamId: 'stream-bitrate-mismatch',
      streamGroupId: 'stream-bitrate-mismatch',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      purpose: 'focus',
      targetId: 'wrong-target',
      status: 'rejected',
      requestedVideoProfile: qualityVideoProfile,
      error: {
        code: 'remote_window_stream_quality_target_mismatch',
        message: 'remote window stream quality target mismatch: wrong-target',
      },
    });
    expect(fakeSender.setParameters).not.toHaveBeenCalled();
  });

  it('rejects a concurrent quality revision while the current group transaction is applying', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeSender = makeFakeRtpSender();
    let releaseApply: () => void = () => undefined;
    fakePeer.addTrack.mockReturnValue(fakeSender);
    const fakeTrack = makeFakeMediaStreamTrack();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => makeControllableCaptureSource(options)),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(7);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    await runtime.startStream({
      requestId: 'rw-quality-busy-start',
      streamId: 'stream-quality-busy',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    fakeSender.setParameters.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseApply = resolve;
    }));
    const first = runtime.updateStreamQuality({
      requestId: 'rw-quality-busy-1',
      streamId: 'stream-quality-busy',
      streamGroupId: 'stream-quality-busy',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 1,
      targetId: 'iterm2-pane:window-1:tab-1:left',
      videoProfile: qualityVideoProfile,
    });
    await Promise.resolve();

    const concurrent = await runtime.updateStreamQuality({
      requestId: 'rw-quality-busy-2',
      streamId: 'stream-quality-busy',
      streamGroupId: 'stream-quality-busy',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 2,
      targetId: 'iterm2-pane:window-1:tab-1:left',
      videoProfile: makeRemoteWindowVideoProfileFixture('quality', true),
    });
    expect(concurrent).toMatchObject({
      status: 'rejected',
      revision: 2,
      error: { code: 'remote_window_stream_quality_busy' },
    });
    releaseApply();
    await expect(first).resolves.toMatchObject({ status: 'applied', revision: 1 });
  });

  it('allocates I420 planes correctly for odd-sized capture frames', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    const target = makeStreamTarget();
    target.videoTarget.windowBoundsTopLeftPx = { x: 10, y: 20, width: 1037, height: 1177 };
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 20, width: 1037, height: 1177 };
    const expectedI420Bytes = 1037 * 1177 + Math.ceil(1037 / 2) * Math.ceil(1177 / 2) * 2;
    const rgbaToI420 = vi.fn((_rgba, i420) => {
      i420.data.fill(11);
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({
          width: 1037,
          height: 1177,
          rgba: new Uint8Array(1037 * 1177 * 4).fill(12),
        });
        return {
          width: 1037,
          height: 1177,
          frameRate: 12,
          stop: vi.fn(),
        };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-odd-start',
      streamId: 'stream-odd',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    await flushPromiseQueue();

    expect('answer' in result).toBe(true);
    expect(rgbaToI420).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1037,
        height: 1177,
        data: expect.objectContaining({ byteLength: 1037 * 1177 * 4 }),
      }),
      expect.objectContaining({
        width: 1037,
        height: 1177,
        data: expect.objectContaining({ byteLength: expectedI420Bytes }),
      }),
    );
    expect(fakeVideoSource.onFrame).toHaveBeenCalledWith({
      width: 1037,
      height: 1177,
      data: new Uint8Array(expectedI420Bytes).fill(11),
    });
  });

  it('stops the stream instead of crashing when a later frame conversion fails', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    let pushFrame: (frame: { width: number; height: number; rgba: Uint8Array }) => void = () => undefined;
    const captureStop = vi.fn();
    const statuses: unknown[] = [];
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        pushFrame = options.onFrame;
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: captureStop };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420: vi.fn((rgba, i420) => {
        if (rgba.width === 3) {
          throw new Error('odd frame converter failure');
        }
        i420.data.fill(9);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-late-frame-failure',
      streamId: 'stream-late-frame-failure',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (payload) => statuses.push(payload),
    });
    await flushPromiseQueue();
    expect('answer' in result).toBe(true);
    expect(() => {
      pushFrame({ width: 3, height: 3, rgba: new Uint8Array(36).fill(2) });
    }).not.toThrow();
    await flushPromiseQueue();
    expect(captureStop).toHaveBeenCalledTimes(1);
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1);
    expect(fakePeer.close).toHaveBeenCalledTimes(1);
    expect(statuses).toContainEqual(expect.objectContaining({
      requestId: 'rw-late-frame-failure',
      streamId: 'stream-late-frame-failure',
      phase: 'stopped',
      framesSent: 1,
      message: 'remote window frame conversion failed: odd frame converter failure',
    }));
    await expect(runtime.addIceCandidate({
      streamId: 'stream-late-frame-failure',
      candidate: { candidate: 'candidate:after-failure' },
    })).rejects.toMatchObject({ name: 'remote_window_stream_candidate_closed' });
  });

  it('rejects invalid stream targets without starting capture or screenshot fallback', async () => {
    const captureSourceFactory = vi.fn();
    const invalidTarget = makeStreamTarget() as any;
    delete invalidTarget.videoTarget.cropRectTopLeftPx;
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => new FakeRemoteWindowPeerConnection() as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => makeFakeMediaStreamTrack()),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn(),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-invalid',
      streamId: 'stream-invalid',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: invalidTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toEqual({
      requestId: 'rw-invalid',
      streamId: 'stream-invalid',
      code: 'remote_window_stream_start_failed',
      message: 'remote window stream target requires cropRectTopLeftPx',
      failureStage: 'request-validation',
    });
    expect(captureSourceFactory).not.toHaveBeenCalled();
  });

  it('fails without capture when the installed ScreenCaptureKit binary is missing', async () => {
    const captureSourceFactory = vi.fn();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      captureBinary: '',
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-missing-capture-binary',
      streamId: 'stream-missing-capture-binary',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toEqual({
      requestId: 'rw-missing-capture-binary',
      streamId: 'stream-missing-capture-binary',
      code: 'remote_window_capture_binary_missing',
      message: 'installed ScreenCaptureKit capture binary is required',
      failureStage: 'platform-capability',
    });
    expect(captureSourceFactory).not.toHaveBeenCalled();
  });

  it('cleans peer and track resources when capture start fails', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async () => {
        throw new Error('ScreenCaptureKit capture start failure');
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn(),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-capture-fail',
      streamId: 'stream-capture-fail',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toEqual({
      requestId: 'rw-capture-fail',
      streamId: 'stream-capture-fail',
      code: 'remote_window_stream_start_failed',
      message: 'ScreenCaptureKit capture start failure',
      failureStage: 'focus-capture-start',
    });
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1);
    expect(fakePeer.close).toHaveBeenCalledTimes(1);
  });

  it('adds ICE candidates, stops exactly once, and ignores late capture frames after close', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const fakeVideoSource = {
      createTrack: vi.fn(() => fakeTrack),
      onFrame: vi.fn(),
    };
    const captureStop = vi.fn();
    let pushFrame: (frame: { width: number; height: number; rgba: Uint8Array }) => void = () => undefined;
    const statuses: unknown[] = [];
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        pushFrame = options.onFrame;
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: captureStop };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      rtcIceCandidateFactory: vi.fn((candidate) => candidate as RTCIceCandidate),
      videoSourceFactory: vi.fn(() => fakeVideoSource as any),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    expect(await runtime.addIceCandidate({
      requestId: 'rw-candidate-early',
      streamId: 'stream-stop',
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    })).toBe(true);
    expect(fakePeer.addIceCandidate).not.toHaveBeenCalled();
    await expect(runtime.addIceCandidate({
      requestId: 'rw-candidate-early-duplicate',
      streamId: 'stream-stop',
      candidate: { candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0 },
    })).rejects.toMatchObject({ name: 'remote_window_stream_candidate_duplicate' });

    await runtime.startStream({
      requestId: 'rw-start-stop',
      streamId: 'stream-stop',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (payload) => statuses.push(payload),
    });
    await flushPromiseQueue();
    expect(fakePeer.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:early',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });

    expect(await runtime.addIceCandidate({
      requestId: 'rw-candidate',
      streamId: 'stream-stop',
      candidate: { candidate: 'candidate:android', sdpMid: '0', sdpMLineIndex: 0 },
    })).toBe(true);
    expect(fakePeer.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:android',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    });

    const stopped = await runtime.stopStream({ requestId: 'rw-stop', streamId: 'stream-stop' });
    const stoppedAgain = await runtime.stopStream({ requestId: 'rw-stop-2', streamId: 'stream-stop' });
    pushFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(2) });

    expect(stopped).toMatchObject({
      requestId: 'rw-stop',
      streamId: 'stream-stop',
      purpose: 'focus',
      phase: 'stopped',
      framesSent: 1,
    });
    expect(stoppedAgain).toMatchObject({
      requestId: 'rw-stop-2',
      streamId: 'stream-stop',
      phase: 'stopped',
      framesSent: 0,
    });
    expect(captureStop).toHaveBeenCalledTimes(1);
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1);
    expect(fakePeer.close).toHaveBeenCalledTimes(1);
    expect(fakeVideoSource.onFrame).toHaveBeenCalledTimes(1);
    await expect(runtime.addIceCandidate({
      streamId: 'stream-stop',
      candidate: { candidate: 'candidate:late' },
    })).rejects.toMatchObject({ name: 'remote_window_stream_candidate_closed' });
    expect(statuses).toContainEqual(expect.objectContaining({
      requestId: 'rw-start-stop',
      streamId: 'stream-stop',
      purpose: 'focus',
      phase: 'stopped',
      framesSent: 1,
    }));
  });

  it('injects os-event input only into the active selected stream target', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const runRemoteWindowInputEvent = vi.fn(async () => undefined);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-input-start',
      streamId: 'stream-input',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const focusResult = await runtime.injectInput({
      streamId: 'stream-input',
      targetId: 'app-window:123:456',
      event: {
        kind: 'focus',
      },
    }, reliableInputControl('rw-input-focus'));

    expect(focusResult).toMatchObject({
      control: { sequence: 'rw-input-focus', accepted: true, duplicate: false },
      payload: { streamId: 'stream-input', targetId: 'app-window:123:456' },
    });
    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { kind: 'focus' },
      }),
      target,
      expect.objectContaining({ swiftBinary: 'swift' }),
    );
    runRemoteWindowInputEvent.mockClear();

    const result = await runtime.injectInput({
      streamId: 'stream-input',
      targetId: 'app-window:123:456',
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 1,
        button: 'left',
        buttons: 1,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.6,
      },
    }, reliableInputControl('rw-input'));

    expect(result).toMatchObject({
      control: { sequence: 'rw-input', accepted: true },
      payload: { streamId: 'stream-input', targetId: 'app-window:123:456' },
    });
    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: 'pointer', x: 100 }),
      }),
      target,
      expect.objectContaining({ swiftBinary: 'swift' }),
    );

    runRemoteWindowInputEvent.mockClear();
    const scrollResult = await runtime.injectInput({
      streamId: 'stream-input',
      targetId: 'app-window:123:456',
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 48,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.6,
      },
    }, continuousInputControl('rw-input-scroll'));
    expect(scrollResult).toBeNull();
	    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
	      expect.objectContaining({
	        event: expect.objectContaining({ kind: 'scroll', deltaY: 48 }),
	      }),
	      target,
	      expect.objectContaining({ swiftBinary: 'swift' }),
	    );

	    runRemoteWindowInputEvent.mockClear();
	    const gestureResult = await runtime.injectInput({
	      streamId: 'stream-input',
	      targetId: 'app-window:123:456',
	      event: {
	        kind: 'gesture',
	        gesture: 'swipe',
	        phase: 'end',
	        unit: 'pixel',
	        pointerId: 1,
	        startX: 100,
	        startY: 170,
	        x: 100,
	        y: 120,
	        startNormalizedX: 0.5,
	        startNormalizedY: 0.85,
	        normalizedX: 0.5,
	        normalizedY: 0.6,
	        deltaX: 0,
	        deltaY: 50,
	        durationMs: 120,
	        velocityX: 0,
	        velocityY: 416.67,
	      },
	    }, reliableInputControl('rw-input-gesture'));
	    expect(gestureResult).toMatchObject({
	      control: { sequence: 'rw-input-gesture', accepted: true },
	      payload: { streamId: 'stream-input', targetId: 'app-window:123:456' },
	    });
	    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
	      expect.objectContaining({
	        event: expect.objectContaining({ kind: 'gesture', gesture: 'swipe', deltaY: 50 }),
	      }),
	      target,
	      expect.objectContaining({ swiftBinary: 'swift' }),
	    );
	  });

  it('deduplicates and serializes reliable input by delivery sequence', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const inputResolvers: Array<() => void> = [];
    const runRemoteWindowInputEvent = vi.fn<
      Parameters<RemoteWindowInputEventRunner>,
      ReturnType<RemoteWindowInputEventRunner>
    >(() => new Promise<void>((resolve) => {
      inputResolvers.push(resolve);
    }));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    await runtime.startStream({
      requestId: 'rw-input-order-start',
      streamId: 'stream-input-order',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 1,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    const clickPayload = {
      streamId: 'stream-input-order',
      targetId: target.streamTargetId,
      event: {
        kind: 'click' as const,
        pointerId: 1,
        button: 'left' as const,
        clickCount: 1,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.6,
      },
    };

    const first = runtime.injectInput(clickPayload, reliableInputControl('rw-input-dedupe'));
    const duplicateInFlight = runtime.injectInput(clickPayload, reliableInputControl('rw-input-dedupe'));
    await flushPromiseQueue();
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(1);
    inputResolvers.shift()!();
    await expect(first).resolves.toMatchObject({ control: { accepted: true, duplicate: false } });
    await expect(duplicateInFlight).resolves.toMatchObject({ control: { accepted: true, duplicate: true } });
    await expect(runtime.injectInput(clickPayload, reliableInputControl('rw-input-dedupe')))
      .resolves.toMatchObject({ control: { accepted: true, duplicate: true } });
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(1);

    const down = runtime.injectInput({
      ...clickPayload,
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 2,
        button: 'left',
        buttons: 1,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.6,
      },
    }, reliableInputControl('rw-input-down-order'));
    const up = runtime.injectInput({
      ...clickPayload,
      event: {
        kind: 'pointer',
        phase: 'up',
        pointerId: 2,
        button: 'left',
        buttons: 0,
        x: 120,
        y: 140,
        normalizedX: 0.6,
        normalizedY: 0.7,
      },
    }, reliableInputControl('rw-input-up-order'));
    await flushPromiseQueue();
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(2);
    expect(runRemoteWindowInputEvent.mock.calls[1]?.[0].event).toMatchObject({ phase: 'down' });
    inputResolvers.shift()!();
    await down;
    await flushPromiseQueue();
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(3);
    expect(runRemoteWindowInputEvent.mock.calls[2]?.[0].event).toMatchObject({ phase: 'up' });
    inputResolvers.shift()!();
    await up;
  });

  it('bounds continuous input to latest move plus merged scroll and drops stale or stopped tails', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    let admissionNowMs = 10_000;
    const runRemoteWindowInputEvent = vi.fn<
      Parameters<RemoteWindowInputEventRunner>,
      ReturnType<RemoteWindowInputEventRunner>
    >(async () => undefined);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      nowMs: () => admissionNowMs,
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    await runtime.startStream({
      requestId: 'rw-input-continuous-start',
      streamId: 'stream-input-continuous',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 1,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    const move = (sequence: string, x: number) => runtime.injectInput({
      streamId: 'stream-input-continuous',
      targetId: target.streamTargetId,
      event: {
        kind: 'pointer',
        phase: 'move',
        pointerId: 1,
        button: 'left',
        buttons: 1,
        x,
        y: 120,
        normalizedX: x / 200,
        normalizedY: 0.6,
      },
    }, continuousInputControl(sequence));
    const scroll = (sequence: string, deltaY: number) => runtime.injectInput({
      streamId: 'stream-input-continuous',
      targetId: target.streamTargetId,
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.6,
      },
    }, continuousInputControl(sequence));

    await Promise.all([
      move('rw-move-1', 90),
      move('rw-move-2', 100),
      scroll('rw-scroll-1', 12),
      scroll('rw-scroll-2', 18),
    ]);
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(2);
    expect(runRemoteWindowInputEvent.mock.calls[0]?.[0].event).toMatchObject({ kind: 'pointer', x: 100 });
    expect(runRemoteWindowInputEvent.mock.calls[1]?.[0].event).toMatchObject({ kind: 'scroll', deltaY: 30 });

    runRemoteWindowInputEvent.mockClear();
    const staleScroll = scroll('rw-scroll-stale', 20);
    admissionNowMs += 101;
    await expect(staleScroll).resolves.toBeNull();
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();

    const stoppedScroll = scroll('rw-scroll-stopped', 20);
    await runtime.stopStream({ requestId: 'rw-stop-continuous', streamId: 'stream-input-continuous' });
    await expect(stoppedScroll).resolves.toBeNull();
    await flushPromiseQueue();
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();
  });

  it('rejects delivery lane mismatch without injecting the user action', async () => {
    const target = makeAppStreamTarget();
    const runRemoteWindowInputEvent = vi.fn(async () => undefined);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => new FakeRemoteWindowPeerConnection() as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({ createTrack: vi.fn(() => makeFakeMediaStreamTrack()), onFrame: vi.fn() } as any)),
      rgbaToI420: vi.fn(),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    await runtime.startStream({
      requestId: 'rw-input-lane-start',
      streamId: 'stream-input-lane',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 1,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const result = await runtime.injectInput({
      streamId: 'stream-input-lane',
      targetId: target.streamTargetId,
      event: { kind: 'focus' },
    }, continuousInputControl('rw-input-lane-mismatch'));
    expect(result).toMatchObject({
      control: {
        accepted: false,
        error: {
          code: 'remote_window_input_delivery_invalid',
          message: 'remote window input delivery lane mismatch: expected reliable',
        },
      },
    });
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();
  });

  it('applies app-window resize to the active capture source and returns target/capture truth', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    let captureWidth = 800;
    let captureHeight = 600;
    const updateTarget = vi.fn(async (nextTarget) => {
      captureWidth = nextTarget.videoTarget.cropRectTopLeftPx?.width || 0;
      captureHeight = nextTarget.videoTarget.cropRectTopLeftPx?.height || 0;
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      now: () => '2026-07-25T00:00:00.000Z',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: captureWidth, height: captureHeight, rgba: new Uint8Array(captureWidth * captureHeight * 4).fill(1) });
        return {
          get width() {
            return captureWidth;
          },
          get height() {
            return captureHeight;
          },
          frameRate: 30,
          updateTarget,
          stop: vi.fn(),
        };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent: vi.fn(async () => undefined),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-resize-start',
      streamId: 'stream-resize',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const result = await runtime.injectInput({
      streamId: 'stream-resize',
      targetId: target.streamTargetId,
      event: {
        kind: 'window-resize',
        width: 800,
        height: 1477,
      },
    }, reliableInputControl('rw-resize'));

    expect(updateTarget).toHaveBeenCalledWith(expect.objectContaining({
      streamTargetId: target.streamTargetId,
      videoTarget: expect.objectContaining({
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 1477 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 1477 },
      }),
    }));
    expect(result).toEqual({
      control: expect.objectContaining({ sequence: 'rw-resize', accepted: true }),
      payload: {
        streamId: 'stream-resize',
        targetId: target.streamTargetId,
        target: expect.objectContaining({
        videoTarget: expect.objectContaining({
          windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 1477 },
          cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 1477 },
        }),
        }),
        capture: {
          source: 'ScreenCaptureKit',
          frameWidth: 800,
          frameHeight: 1477,
          frameRate: 30,
          targetKind: 'app-window',
        },
      },
    });
  });

  it('rejects app-window resize when the active capture source cannot update target truth', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent: vi.fn(async () => undefined),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-resize-missing-start',
      streamId: 'stream-resize-missing',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const result = await runtime.injectInput({
      streamId: 'stream-resize-missing',
      targetId: target.streamTargetId,
      event: {
        kind: 'window-resize',
        width: 800,
        height: 1477,
      },
    }, reliableInputControl('rw-resize-missing'));

    expect(result).toMatchObject({
      control: {
        sequence: 'rw-resize-missing',
        accepted: false,
        error: {
          code: 'remote_window_input_failed',
          message: 'remote window active capture source cannot update target resize',
        },
      },
      payload: { streamId: 'stream-resize-missing', targetId: target.streamTargetId },
    });
  });

  it('uses daemon admission time without reconstructing it from delivery sentAtMs', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const runRemoteWindowInputEvent = vi.fn(async () => undefined);
    const nowMs = vi.fn(() => 50_000);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      nowMs,
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-input-start-clock-skew',
      streamId: 'stream-input-clock-skew',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const missingTimestampResult = await runtime.injectInput({
      streamId: 'stream-input-clock-skew',
      targetId: target.streamTargetId,
      event: {
        kind: 'key',
        phase: 'down',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    }, reliableInputControl('rw-input-missing-sent-at'));

    expect(missingTimestampResult).toMatchObject({
      control: { sequence: 'rw-input-missing-sent-at', accepted: true },
      payload: { streamId: 'stream-input-clock-skew', targetId: target.streamTargetId },
    });
    expect(runRemoteWindowInputEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ kind: 'key', phase: 'down' }) }),
      target,
      expect.objectContaining({ daemonReceivedAtMs: 50_000 }),
    );

    const staleLookingClientClockResult = await runtime.injectInput({
      streamId: 'stream-input-clock-skew',
      targetId: target.streamTargetId,
      event: {
        kind: 'key',
        phase: 'up',
        key: 'v',
        code: 'KeyV',
        metaKey: true,
      },
    }, {
      ...reliableInputControl('rw-input-client-clock-old'),
      sentAtMs: 1,
    });

    expect(staleLookingClientClockResult).toMatchObject({
      control: { sequence: 'rw-input-client-clock-old', accepted: true },
      payload: { streamId: 'stream-input-clock-skew', targetId: target.streamTargetId },
    });
    expect(runRemoteWindowInputEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ kind: 'key', phase: 'up' }) }),
      target,
      expect.objectContaining({ daemonReceivedAtMs: 50_000 }),
    );
  });

  it('uses one persistent macOS input helper for pointer, scroll, gesture, and key events', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const inputHelper = {
      warm: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const remoteWindowInputHelperFactory = vi.fn(() => inputHelper);
    const nowMs = vi.fn(() => 88_000);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      nowMs,
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      remoteWindowInputHelperFactory,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-input-start-helper',
      streamId: 'stream-input-helper',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    await runtime.injectInput({
      streamId: 'stream-input-helper',
      targetId: target.streamTargetId,
      event: {
        kind: 'click',
        pointerId: 1,
        button: 'left',
        clickCount: 1,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.6,
      },
    }, reliableInputControl('rw-input-helper-click'));
	    await runtime.injectInput({
	      streamId: 'stream-input-helper',
      targetId: target.streamTargetId,
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 4,
        deltaY: 48,
        x: 100,
        y: 120,
        normalizedX: 0.5,
	        normalizedY: 0.6,
	      },
	    }, continuousInputControl('rw-input-helper-scroll'));
	    await runtime.injectInput({
	      streamId: 'stream-input-helper',
	      targetId: target.streamTargetId,
	      event: {
	        kind: 'gesture',
	        gesture: 'swipe',
	        phase: 'end',
	        unit: 'pixel',
	        pointerId: 1,
	        startX: 100,
	        startY: 170,
	        x: 100,
	        y: 120,
	        startNormalizedX: 0.5,
	        startNormalizedY: 0.85,
	        normalizedX: 0.5,
	        normalizedY: 0.6,
	        deltaX: 0,
	        deltaY: 50,
	        durationMs: 120,
	        velocityX: 0,
	        velocityY: 416.67,
	      },
	    }, reliableInputControl('rw-input-helper-gesture'));
	    await runtime.injectInput({
      streamId: 'stream-input-helper',
      targetId: target.streamTargetId,
      event: {
        kind: 'key',
        phase: 'down',
        key: 'Z',
        code: 'KeyZ',
	        text: 'Z',
	      },
	    }, reliableInputControl('rw-input-helper-key'));

    expect(remoteWindowInputHelperFactory).toHaveBeenCalledTimes(1);
    expect(inputHelper.warm).toHaveBeenCalledTimes(1);
    expect(inputHelper.send).toHaveBeenCalledTimes(4);
    expect(inputHelper.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      daemonReceivedAtMs: 88_000,
      event: expect.objectContaining({ kind: 'click' }),
      window: expect.objectContaining({ bounds: target.videoTarget.windowBoundsTopLeftPx }),
    }), { lane: 'reliable' });
    expect(inputHelper.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: expect.objectContaining({ kind: 'scroll', deltaY: 48 }),
    }), { lane: 'continuous', maxAgeMs: 100 });
    expect(inputHelper.send).toHaveBeenNthCalledWith(3, expect.objectContaining({
      event: expect.objectContaining({ kind: 'gesture', gesture: 'swipe', deltaY: 50 }),
    }), { lane: 'reliable' });
    expect(inputHelper.send).toHaveBeenNthCalledWith(4, expect.objectContaining({
      event: expect.objectContaining({ kind: 'key', text: 'Z' }),
    }), { lane: 'reliable' });

    runtime.dispose('helper lifecycle test complete');
    expect(inputHelper.dispose).toHaveBeenCalledTimes(1);
  });

  it('warms the macOS input helper during stream start without emitting focus or pointer input', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const inputHelper = {
      warm: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      remoteWindowInputHelperFactory: vi.fn(() => inputHelper),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const started = await runtime.startStream({
      requestId: 'rw-input-warm-start',
      streamId: 'stream-input-warm',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(started).toMatchObject({
      requestId: 'rw-input-warm-start',
      streamId: 'stream-input-warm',
      targetId: target.streamTargetId,
    });
    expect(inputHelper.warm).toHaveBeenCalledTimes(1);
    expect(inputHelper.send).not.toHaveBeenCalled();
  });

  it('fails interactive stream start explicitly when the input helper is not ready', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const captureStop = vi.fn();
    const inputHelper = {
      warm: vi.fn(async () => {
        throw new Error('remote window input helper did not become ready before timeout');
      }),
      send: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: captureStop };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      remoteWindowInputHelperFactory: vi.fn(() => inputHelper),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    const result = await runtime.startStream({
      requestId: 'rw-input-warm-timeout',
      streamId: 'stream-input-warm-timeout',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toMatchObject({
      requestId: 'rw-input-warm-timeout',
      streamId: 'stream-input-warm-timeout',
      code: 'remote_window_stream_start_failed',
      message: 'remote window input helper did not become ready before timeout',
    });
    expect(captureStop).toHaveBeenCalledTimes(1);
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1);
    expect(fakePeer.close).toHaveBeenCalledTimes(1);
    expect(inputHelper.send).not.toHaveBeenCalled();
  });

  it('rejects remote input for target mismatch, stopped streams, and no-focus generic os-event policy', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const runRemoteWindowInputEvent = vi.fn(async () => undefined);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(1) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-input-start-negative',
      streamId: 'stream-input-negative',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const mismatch = await runtime.injectInput({
      streamId: 'stream-input-negative',
      targetId: 'other-target',
      event: {
        kind: 'key',
        phase: 'down',
        key: 'a',
        code: 'KeyA',
        text: 'a',
      },
    }, reliableInputControl('rw-input-mismatch'));
    expect(mismatch).toMatchObject({
      control: {
        sequence: 'rw-input-mismatch',
        accepted: false,
        error: {
          code: 'remote_window_input_failed',
          message: 'remote window input target mismatch: other-target',
        },
      },
    });

    const noFocusTarget = { ...target, focusPolicy: 'no-focus-steal' as const };
    await runtime.startStream({
      requestId: 'rw-input-start-no-focus',
      streamId: 'stream-input-no-focus',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: noFocusTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    const noFocus = await runtime.injectInput({
      streamId: 'stream-input-no-focus',
      targetId: noFocusTarget.streamTargetId,
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 2,
        button: 'left',
        buttons: 1,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    }, reliableInputControl('rw-input-no-focus'));
    expect(noFocus).toMatchObject({
      control: {
        accepted: false,
        error: {
          code: 'remote_window_input_failed',
          message: 'remote window OS input requires bring-to-focus policy',
        },
      },
    });

    const invalidScroll = await runtime.injectInput({
      streamId: 'stream-input-negative',
      targetId: target.streamTargetId,
      event: {
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: Number.NaN,
        x: 100,
        y: 120,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    }, continuousInputControl('rw-input-invalid-scroll'));
	    expect(invalidScroll).toMatchObject({
	      control: {
	        accepted: false,
	        error: {
	          code: 'remote_window_input_failed',
	          message: 'remote window scroll input coordinates or delta are invalid',
	        },
	      },
	    });

	    const invalidGesture = await runtime.injectInput({
	      streamId: 'stream-input-negative',
	      targetId: target.streamTargetId,
	      event: {
	        kind: 'gesture',
	        gesture: 'swipe',
	        phase: 'end',
	        unit: 'pixel',
	        pointerId: 1,
	        startX: 100,
	        startY: 170,
	        x: 100,
	        y: 120,
	        startNormalizedX: 0.5,
	        startNormalizedY: 1.2,
	        normalizedX: 0.5,
	        normalizedY: 0.6,
	        deltaX: 0,
	        deltaY: 50,
	        durationMs: 120,
	        velocityX: 0,
	        velocityY: 416.67,
	      },
	    }, reliableInputControl('rw-input-invalid-gesture'));
	    expect(invalidGesture).toMatchObject({
	      control: {
	        accepted: false,
	        error: {
	          code: 'remote_window_input_failed',
	          message: 'remote window gesture input normalized coordinates are out of range',
	        },
	      },
	    });

    await runtime.stopStream({ requestId: 'rw-stop-input', streamId: 'stream-input-negative' });
    const stopped = await runtime.injectInput({
      streamId: 'stream-input-negative',
      targetId: target.streamTargetId,
      event: {
        kind: 'key',
        phase: 'down',
        key: 'a',
        code: 'KeyA',
        text: 'a',
      },
    }, reliableInputControl('rw-input-stopped'));
    expect(stopped).toMatchObject({
      control: {
        sequence: 'rw-input-stopped',
        accepted: false,
        error: { code: 'remote_window_input_stream_missing' },
      },
      payload: { streamId: 'stream-input-negative' },
    });
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();
  });
});

describe('remote window stream update-focus pending gate', () => {
  it('rejects a second updateFocus while the previous focus-ready is still pending', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeStreamTarget();
    const updateTarget = vi.fn(async () => undefined);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async () => {
        // No immediate frame: pendingFocusReady stays set until a frame arrives.
        return {
          width: 2,
          height: 2,
          frameRate: 30,
          updateTarget,
          stop: vi.fn(),
        };
      }),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-focus-busy-start',
      streamId: 'stream-focus-busy',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const first = await runtime.updateFocus({
      requestId: 'rw-focus-busy-1',
      streamId: 'stream-focus-busy',
      revision: 1,
      target: {
        ...target,
        videoTarget: { ...target.videoTarget, windowId: 'window-1' },
      },
    });
    expect('phase' in first && first.phase).toBe('accepted');

    const second = await runtime.updateFocus({
      requestId: 'rw-focus-busy-2',
      streamId: 'stream-focus-busy',
      revision: 2,
      target: {
        ...target,
        videoTarget: { ...target.videoTarget, windowId: 'window-2' },
      },
    });
    expect(second).toEqual({
      requestId: 'rw-focus-busy-2',
      streamId: 'stream-focus-busy',
      code: 'remote_window_stream_update_focus_busy',
      message: 'remote window focus update already in flight',
    });
  });

  it('propagates capture updateTarget rejection so the router can emit update_focus_failed', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeStreamTarget();
    const updateTarget = vi.fn(async () => {
      throw new Error('target window not found in fresh shareable content');
    });
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async () => ({
        width: 2,
        height: 2,
        frameRate: 30,
        updateTarget,
        stop: vi.fn(),
      })),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-focus-reject-start',
      streamId: 'stream-focus-reject',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    await expect(runtime.updateFocus({
      requestId: 'rw-focus-reject',
      streamId: 'stream-focus-reject',
      revision: 1,
      target: {
        ...target,
        videoTarget: { ...target.videoTarget, windowId: 'window-ghost' },
      },
    })).rejects.toThrow('target window not found in fresh shareable content');
  });
});

describe('remote window single-window overview gate', () => {
  it('does not start an overview capture for a single app-window target (no duplicate full-res capture)', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    fakePeer.connectionState = 'new';
    const fakeTrack = makeFakeMediaStreamTrack();
    const captureSourceFactory = vi.fn(async () => ({
      width: 2,
      height: 2,
      frameRate: 30,
      stop: vi.fn(),
    }));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    const singleWindowTarget = {
      ...makeStreamTarget(),
      videoTarget: {
        ...makeStreamTarget().videoTarget,
        kind: 'app-window' as const,
        appBundleId: 'com.google.Chrome',
        windowId: 'app-window:487:64',
      },
    };

    await runtime.startStream({
      requestId: 'rw-single-overview',
      streamId: 'stream-single-overview',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      target: singleWindowTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    // Single app-window: only the focus capture may run; no overview lane.
    expect(captureSourceFactory).toHaveBeenCalledTimes(1);
  });

  it('starts a low-bitrate overview capture when the target has composite windows', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    fakePeer.connectionState = 'new';
    const fakeTrack = makeFakeMediaStreamTrack();
    const captureSourceFactory = vi.fn(async () => ({
      width: 2,
      height: 2,
      frameRate: 30,
      stop: vi.fn(),
    }));
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory,
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    const statuses: RemoteWindowStreamStatusPayload[] = [];

    const compositeTarget = {
      ...makeStreamTarget(),
      videoTarget: {
        ...makeStreamTarget().videoTarget,
        kind: 'app-window' as const,
        appBundleId: 'com.google.Chrome',
        windowId: 'app-window:487:64',
      },
      compositeWindows: [
        {
          windowId: 'app-window:487:65',
          title: 'Second window',
          windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
          cropRectTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
        },
      ],
    };

    await runtime.startStream({
      requestId: 'rw-composite-overview',
      streamId: 'stream-composite-overview',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 1 as const,
      target: compositeTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (status) => statuses.push(status),
    });

    // Composite target: focus + overview lanes both capture.
    expect(captureSourceFactory).toHaveBeenCalledTimes(2);
    expect(statuses).toContainEqual(expect.objectContaining({
      stage: 'capability-verified',
      capability: {
        mediaPlan: 'overview-plus-focus',
        mediaPlanVersion: 1 as const,
        lanes: [
          { role: 'focus', requiredForStart: true },
          { role: 'overview', requiredForStart: true },
        ],
        maxVideoLanes: 2,
        screenCaptureKit: true,
        typedPerLaneStatus: true,
          preflight: {
            wrtc: 'available',
            abi: 'supported',
            swiftHelper: 'configured',
            screenRecordingPermission: 'pending-capture',
            capture: 'pending',
            senderNegotiation: 'pending',
          },
      },
    }));
    expect(statuses).toContainEqual(expect.objectContaining({ stage: 'capture-started', lane: 'focus' }));
    expect(statuses).toContainEqual(expect.objectContaining({ stage: 'capture-started', lane: 'overview' }));
  });

  it('accepts only the currently published layout generation for composite coordinate input', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    fakePeer.connectionState = 'new';
    const fakeTrack = makeFakeMediaStreamTrack();
    const runRemoteWindowInputEvent = vi.fn(async () => undefined);
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => makeControllableCaptureSource(options)),
      peerConnectionFactory: vi.fn(() => fakePeer as unknown as RTCPeerConnection),
      rtcSessionDescriptionFactory: vi.fn((description) => description as RTCSessionDescription),
      videoSourceFactory: vi.fn(() => ({
        createTrack: vi.fn(() => fakeTrack),
        onFrame: vi.fn(),
      } as any)),
      rgbaToI420: vi.fn((_rgba, i420) => {
        i420.data.fill(9);
      }),
      runRemoteWindowInputEvent,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });
    const compositeTarget = {
      ...makeAppStreamTarget(),
      compositeWindows: [{
        appBundleId: 'com.apple.TextEdit',
        pid: 123,
        windowId: 'secondary',
        title: 'Secondary',
        windowBoundsTopLeftPx: { x: 1_000, y: 500, width: 400, height: 300 },
        cropRectTopLeftPx: { x: 1_000, y: 500, width: 400, height: 300 },
      }],
    };
    const started = await runtime.startStream({
      requestId: 'rw-layout-generation-start',
      streamId: 'stream-layout-generation',
      mediaPlan: 'overview-plus-focus',
      mediaPlanVersion: 1 as const,
      target: compositeTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    expect('answer' in started).toBe(true);
    if (!('answer' in started) || !started.canvasLayout) {
      throw new Error('composite stream did not publish canvas layout');
    }
    const canvasWindow = started.canvasLayout.windows[0]!;
    const clickEvent = {
      kind: 'click' as const,
      pointerId: 1,
      button: 'left' as const,
      x: canvasWindow.canvasRectPx.x + canvasWindow.canvasRectPx.width / 2,
      y: canvasWindow.canvasRectPx.y + canvasWindow.canvasRectPx.height / 2,
      normalizedX: 0.5,
      normalizedY: 0.5,
    };

    const stale = await runtime.injectInput({
      streamId: 'stream-layout-generation',
      targetId: compositeTarget.streamTargetId,
      layoutGeneration: started.canvasLayout.layoutGeneration - 1,
      event: clickEvent,
    }, reliableInputControl('rw-layout-generation-stale'));
    expect(stale).toMatchObject({
      control: {
        accepted: false,
        error: {
          code: 'remote_window_input_failed',
          message: expect.stringContaining('layout generation mismatch'),
        },
      },
    });
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();

    const accepted = await runtime.injectInput({
      streamId: 'stream-layout-generation',
      targetId: compositeTarget.streamTargetId,
      layoutGeneration: started.canvasLayout.layoutGeneration,
      event: clickEvent,
    }, reliableInputControl('rw-layout-generation-current'));
    expect(accepted).toMatchObject({ control: { accepted: true } });
    expect(runRemoteWindowInputEvent).toHaveBeenCalledTimes(1);
  });
});
