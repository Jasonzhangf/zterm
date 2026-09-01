import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteWindowMessageRuntime,
  isRemoteWindowControlMessage,
  REMOTE_WINDOW_INPUT_QUALITY_FLUSH_INTERVAL_MS,
  REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS,
  REMOTE_WINDOW_STREAM_START_REQUEST_TIMEOUT_MS,
  REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS,
} from './remote-window-message-runtime';
import type { ServerMessage } from './types';
import type { RemoteWindowStreamTargetManifest } from './types';
import { buildRemoteWindowVideoProfile } from './remote-window-video-quality';

const smoothVideoProfile = buildRemoteWindowVideoProfile('smooth');
const qualityVideoProfile = buildRemoteWindowVideoProfile('quality');

function makeSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any;
}

function makeTarget(id = 'pane-1'): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind: 'iterm2-pane',
      appBundleId: 'com.googlecode.iterm2',
      pid: 123,
      windowId: 'window-1',
      title: 'zterm pane',
      windowBoundsTopLeftPx: { x: 0, y: 80, width: 1000, height: 800 },
      paneRectInContentPx: { x: 0, y: 20, width: 1000, height: 400 },
      cropRectTopLeftPx: { x: 0, y: 100, width: 1000, height: 400 },
      contentTopInsetPx: 20,
    },
    inputTarget: {
      kind: 'tmux-pane',
      itermSessionId: 'iterm-1',
      tty: '/dev/ttys001',
      tmuxSession: 'zterm',
      tmuxWindowId: '@1',
      tmuxPaneId: '%2',
    },
    streamMode: 'view',
    focusPolicy: 'no-focus-steal',
    inputRoute: 'tmux-input',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

describe('remote window message runtime', () => {
  it('sends a catalog request and resolves the matching response', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 42,
      setTimeoutFn: vi.fn(() => 7) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestTargets('session-1', {
      ws: makeSocket(),
      sendSocketPayload,
    });
    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent).toMatchObject({
      type: 'remote-window-targets-request',
      payload: {
        requestId: expect.stringMatching(/^rw-42-/),
        includeAppWindows: true,
        includeIterm2: true,
      },
    });

    runtime.handleTargetsResponse({
      requestId: sent.payload.requestId,
      targets: [],
      errors: [{
        requestId: sent.payload.requestId,
        code: 'iterm2_api_unavailable',
        message: 'iTerm2 API unavailable',
      }],
    });

    await expect(request).resolves.toMatchObject({
      requestId: sent.payload.requestId,
      targets: [],
      errors: [{ code: 'iterm2_api_unavailable' }],
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('rejects explicit daemon catalog errors', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 43,
      setTimeoutFn: vi.fn(() => 8) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestTargets('session-1', {
      ws: makeSocket(),
      request: { includeAppWindows: false, includeIterm2: true },
      sendSocketPayload,
    });
    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent.payload.includeAppWindows).toBe(false);

    runtime.handleError({
      requestId: sent.payload.requestId,
      code: 'screen_recording_permission_missing',
      message: 'Screen Recording permission missing',
    });

    await expect(request).rejects.toMatchObject({
      name: 'screen_recording_permission_missing',
      message: 'Screen Recording permission missing',
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('carries explicit force-refresh to the daemon catalog owner', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 45,
      setTimeoutFn: vi.fn(() => 10) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    void runtime.requestTargets('session-1', {
      ws: makeSocket(),
      request: { forceRefresh: true },
      sendSocketPayload,
    });

    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent).toMatchObject({
      type: 'remote-window-targets-request',
      payload: {
        requestId: expect.stringMatching(/^rw-45-/),
        includeAppWindows: true,
        includeIterm2: true,
        forceRefresh: true,
      },
    });
  });

  it('times out requests without pretending an empty catalog is success', async () => {
    const timeoutHandlers: Array<() => void> = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 44,
      setTimeoutFn: vi.fn((handler) => {
        timeoutHandlers.push(handler as () => void);
        return 9;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestTargets('session-1', {
      ws: makeSocket(),
      sendSocketPayload: vi.fn(),
    });

    timeoutHandlers[0]?.();

    await expect(request).rejects.toThrow('Remote window target catalog timed out');
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('uses a stream-start timeout that outlives daemon capture startup', () => {
    const timeoutDelays: number[] = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 441,
      setTimeoutFn: vi.fn((_handler, delay) => {
        timeoutDelays.push(Number(delay));
        return timeoutDelays.length;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    void runtime.requestTargets('session-1', {
      ws: makeSocket(),
      sendSocketPayload: vi.fn(),
    });
    void runtime.requestStreamStart('session-1', {
      ws: makeSocket(),
      streamId: 'stream-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2 as const,
      target: makeTarget(),
      videoProfile: smoothVideoProfile,
      sendSocketPayload: vi.fn(),
    });

    expect(timeoutDelays).toEqual([
      REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS,
      REMOTE_WINDOW_STREAM_START_REQUEST_TIMEOUT_MS,
    ]);
    expect(REMOTE_WINDOW_STREAM_START_REQUEST_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(REMOTE_WINDOW_STREAM_START_REQUEST_TIMEOUT_MS).toBeGreaterThan(REMOTE_WINDOW_TARGETS_REQUEST_TIMEOUT_MS);
  });

  it('classifies only remote window control messages', () => {
    expect(isRemoteWindowControlMessage({
      type: 'remote-window-error',
      payload: { requestId: 'rw-1', code: 'x', message: 'x' },
    } as ServerMessage)).toBe(true);
    expect(isRemoteWindowControlMessage({
      type: 'remote-window-stream-started',
      payload: {
        requestId: 'rw-start-1',
        streamId: 'stream-1',
        targetId: 'pane-1',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        answer: { type: 'answer', sdp: 'answer-sdp' },
        capture: {
          source: 'ScreenCaptureKit',
          frameWidth: 640,
          frameHeight: 360,
          frameRate: 5,
          targetKind: 'iterm2-pane',
        },
        transport: { kind: 'webrtc-video' },
      },
    } as ServerMessage)).toBe(true);
    expect(isRemoteWindowControlMessage({
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: 'rw-input-1',
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 1,
      },
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
      },
    } as ServerMessage)).toBe(true);
    expect(isRemoteWindowControlMessage({
      type: 'remote-screenshot-status',
      payload: { requestId: 'rs-1', phase: 'capturing' },
    } as ServerMessage)).toBe(false);
  });

  it('sends a stream start request with the selected manifest and resolves the matching answer', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 45,
      setTimeoutFn: vi.fn(() => 10) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestStreamStart('session-1', {
      ws: makeSocket(),
      streamId: 'stream-1',
      purpose: 'preview',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2 as const,
      target: makeTarget(),
      iceServers: [{ urls: 'stun:relay.codewhisper.cc:3478' }],
      videoProfile: qualityVideoProfile,
      sendSocketPayload,
    });

    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent).toMatchObject({
      type: 'remote-window-stream-start-v2-request',
      payload: {
        requestId: expect.stringMatching(/^rw-start-45-/),
        streamId: 'stream-1',
        purpose: 'preview',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 2 as const,
        target: { streamTargetId: 'pane-1' },
        videoProfile: qualityVideoProfile,
      },
    });

    runtime.handleStreamOfferV2({
      requestId: sent.payload.requestId,
      streamId: 'stream-1',
      purpose: 'preview',
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2 as const,
      offer: { type: 'offer', sdp: 'daemon-offer-sdp' },
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 640,
        frameHeight: 360,
        frameRate: 5,
        targetKind: 'iterm2-pane',
      },
      transport: { kind: 'webrtc-video', selectedRoute: 'rtc-direct' },
    });

    await expect(request).resolves.toMatchObject({
      streamId: 'stream-1',
      targetId: 'pane-1',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2 as const,
      offer: { type: 'offer', sdp: 'daemon-offer-sdp' },
      capture: { source: 'ScreenCaptureKit', frameWidth: 640 },
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('rejects stream start errors and does not turn them into catalog success', async () => {
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 46,
      setTimeoutFn: vi.fn(() => 11) as any,
      clearTimeoutFn: vi.fn() as any,
    });

    const request = runtime.requestStreamStart('session-1', {
      ws: makeSocket(),
      streamId: 'stream-2',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 2 as const,
      target: makeTarget('pane-2'),
      videoProfile: smoothVideoProfile,
      sendSocketPayload: vi.fn(),
    });

    runtime.handleError({
      requestId: 'rw-start-46-broken',
      streamId: 'stream-other',
      code: 'ignored',
      message: 'wrong request',
    });
    expect(runtime.getPendingCount()).toBe(1);

    const requestId = runtime.getPendingRequestIds()[0]!;
    runtime.handleError({
      requestId,
      streamId: 'stream-2',
      code: 'screen_capture_failed',
      message: 'ScreenCaptureKit capture start failure',
      failureStage: 'focus-capture-start',
    });

    await expect(request).rejects.toMatchObject({
      name: 'screen_capture_failed',
      message: 'ScreenCaptureKit capture start failure',
      failureStage: 'focus-capture-start',
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('sends candidate and stop messages tied to the stream id', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 47 });
    const ws = makeSocket();

    runtime.sendStreamIceCandidate('session-1', {
      ws,
      streamId: 'stream-3',
      purpose: 'focus',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      sendSocketPayload,
    });
    const stopRequest = runtime.stopStream('session-1', {
      ws,
      streamId: 'stream-3',
      purpose: 'focus',
      sendSocketPayload,
    });

    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'remote-window-stream-ice-candidate',
      payload: {
        streamId: 'stream-3',
        purpose: 'focus',
        candidate: { candidate: 'candidate:1' },
      },
    });
    expect(JSON.parse(sendSocketPayload.mock.calls[1][2] as string)).toMatchObject({
      type: 'remote-window-stream-stop-request',
      payload: {
        requestId: expect.stringMatching(/^rw-stop-47-/),
        streamId: 'stream-3',
        purpose: 'focus',
      },
    });
    const requestId = JSON.parse(sendSocketPayload.mock.calls[1][2] as string).payload.requestId;
    expect(runtime.getPendingRequestIds()).toContain(requestId);
    expect(runtime.dispatch({
      type: 'remote-window-stream-status',
      payload: {
        requestId,
        streamId: 'stream-3',
        purpose: 'focus',
        phase: 'stopped',
        framesSent: 1,
      },
    })).toBe(true);
    await expect(stopRequest).resolves.toMatchObject({
      requestId,
      streamId: 'stream-3',
      purpose: 'focus',
      phase: 'stopped',
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('rejects stop requests from daemon stop errors by request id', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 47 });
    const ws = makeSocket();

    const stopRequest = runtime.stopStream('session-1', {
      ws,
      streamId: 'stream-3',
      sendSocketPayload,
    });
    const requestId = JSON.parse(sendSocketPayload.mock.calls[0][2] as string).payload.requestId;

    expect(runtime.dispatch({
      type: 'remote-window-error',
      payload: {
        requestId,
        streamId: 'stream-3',
        code: 'remote_window_stream_stop_failed',
        message: 'daemon stop failed',
      },
    })).toBe(true);
    await expect(stopRequest).rejects.toMatchObject({
      name: 'remote_window_stream_stop_failed',
      message: 'daemon stop failed',
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('sends stream quality requests and classifies the daemon result as remote-window control', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 471 });
    const ws = makeSocket();

    runtime.sendStreamQuality('session-1', {
      ws,
      payload: {
        streamId: 'stream-3',
        streamGroupId: 'stream-3',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 4,
        purpose: 'focus',
        targetId: 'target-3',
        videoProfile: smoothVideoProfile,
      },
      sendSocketPayload,
    });

    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: expect.stringMatching(/^rw-quality-471-/),
        streamId: 'stream-3',
        streamGroupId: 'stream-3',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 4,
        purpose: 'focus',
        targetId: 'target-3',
        videoProfile: smoothVideoProfile,
      },
    });
    expect(isRemoteWindowControlMessage({
      type: 'remote-window-stream-quality-result',
      payload: {
        requestId: 'rw-quality-1',
        streamId: 'stream-3',
        streamGroupId: 'stream-3',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 4,
        purpose: 'focus',
        targetId: 'target-3',
        status: 'applied',
        requestedVideoProfile: smoothVideoProfile,
        appliedVideoProfile: smoothVideoProfile,
      },
    } as ServerMessage)).toBe(true);
  });

  it('resolves quality ACK only for the exact request stream group and revision', async () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 472 });
    const request = runtime.sendStreamQuality('session-1', {
      ws: makeSocket(),
      payload: {
        streamId: 'stream-3',
        streamGroupId: 'group-3',
        mediaPlan: 'single-focus' as const,
        mediaPlanVersion: 1 as const,
        revision: 5,
        targetId: 'target-3',
        videoProfile: smoothVideoProfile,
      },
      sendSocketPayload,
    });
    const requestId = JSON.parse(sendSocketPayload.mock.calls[0][2] as string).payload.requestId;
    const result = {
      requestId,
      streamId: 'stream-3',
      streamGroupId: 'wrong-group',
      mediaPlan: 'single-focus' as const,
      mediaPlanVersion: 1 as const,
      revision: 5,
      targetId: 'target-3',
      status: 'applied' as const,
      requestedVideoProfile: smoothVideoProfile,
      appliedVideoProfile: smoothVideoProfile,
    };
    expect(runtime.dispatch({ type: 'remote-window-stream-quality-result', payload: result })).toBe(false);
    expect(runtime.getPendingCount()).toBe(1);
    const exact = { ...result, streamGroupId: 'group-3' };
    expect(runtime.dispatch({ type: 'remote-window-stream-quality-result', payload: exact })).toBe(true);
    await expect(request).resolves.toEqual(exact);
  });

  it('sends reliable remote input with delivery control outside the business payload', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 48 });
    const ws = makeSocket();

    runtime.sendInputEvent('session-1', {
      ws,
      payload: {
        streamId: 'stream-5',
        targetId: 'target-5',
        event: {
          kind: 'pointer',
          phase: 'down',
          pointerId: 7,
          button: 'left',
          buttons: 1,
          x: 100,
          y: 120,
          normalizedX: 0.5,
          normalizedY: 0.6,
        },
      },
      sendSocketPayload,
    });

    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'remote-window-input',
      control: {
        version: 1,
        sequence: expect.stringMatching(/^rw-input-48-/),
        lane: 'reliable',
        attempt: 1,
        sentAtMs: 48,
      },
      payload: {
        streamId: 'stream-5',
        targetId: 'target-5',
        event: {
          kind: 'pointer',
          phase: 'down',
          x: 100,
          y: 120,
        },
      },
    });
    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent.payload).not.toHaveProperty('requestId');
    expect(sent.payload).not.toHaveProperty('clientSentAt');
  });

  it('dispatches stream candidates and status to the receiver listener without treating them as catalog responses', () => {
    const onStreamIceCandidate = vi.fn();
    const onStreamStatus = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      onStreamIceCandidate,
      onStreamStatus,
    });

    expect(runtime.dispatch({
      type: 'remote-window-stream-ice-candidate',
      payload: {
        streamId: 'stream-4',
        candidate: { candidate: 'candidate:remote', sdpMid: '0', sdpMLineIndex: 0 },
      },
    })).toBe(true);
    expect(runtime.dispatch({
      type: 'remote-window-stream-status',
      payload: {
        streamId: 'stream-4',
        phase: 'streaming',
        framesSent: 3,
      },
    })).toBe(true);

    expect(onStreamIceCandidate).toHaveBeenCalledWith({
      streamId: 'stream-4',
      candidate: { candidate: 'candidate:remote', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(onStreamStatus).toHaveBeenCalledWith({
      streamId: 'stream-4',
      phase: 'streaming',
      framesSent: 3,
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('dispatches unmatched input ACK and NACK control to subscribers', () => {
    const runtime = createRemoteWindowMessageRuntime();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    const resizedTarget = makeTarget('target-1');
    resizedTarget.videoTarget.windowBoundsTopLeftPx = { x: 0, y: 80, width: 1000, height: 1800 };
    resizedTarget.videoTarget.cropRectTopLeftPx = { x: 0, y: 80, width: 1000, height: 1800 };

    expect(runtime.dispatch({
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: 'rw-input-1',
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 1,
      },
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
        target: resizedTarget,
        capture: {
          source: 'ScreenCaptureKit',
          frameWidth: 1000,
          frameHeight: 1800,
          frameRate: 30,
          targetKind: 'iterm2-pane',
        },
      },
    })).toBe(true);
    expect(runtime.dispatch({
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: 'rw-input-2',
        accepted: false,
        retryable: false,
        duplicate: false,
        receivedAtMs: 2,
        error: {
          code: 'remote_window_input_failed',
          message: 'remote window input stale',
        },
      },
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
      },
    })).toBe(true);

    expect(listener).toHaveBeenNthCalledWith(1, {
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: 'rw-input-1',
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 1,
      },
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
        target: resizedTarget,
        capture: {
          source: 'ScreenCaptureKit',
          frameWidth: 1000,
          frameHeight: 1800,
          frameRate: 30,
          targetKind: 'iterm2-pane',
        },
      },
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: 'rw-input-2',
        accepted: false,
        retryable: false,
        duplicate: false,
        receivedAtMs: 2,
        error: {
          code: 'remote_window_input_failed',
          message: 'remote window input stale',
        },
      },
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
      },
    });

    unsubscribe();
    expect(runtime.dispatch({
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: 'rw-input-3',
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 3,
      },
      payload: {
        streamId: 'stream-1',
        targetId: 'target-1',
      },
    })).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('coalesces 120Hz continuous scroll into one smooth-profile delivery frame', () => {
    const sendSocketPayload = vi.fn();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 100,
      setTimeoutFn: vi.fn((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    const options = {
      ws: makeSocket(),
      payload: {
        streamId: 'stream-scroll',
        targetId: 'target-scroll',
        event: {
          kind: 'scroll' as const,
          unit: 'pixel' as const,
          deltaX: 0,
          deltaY: 1,
          x: 100,
          y: 120,
          normalizedX: 0.5,
          normalizedY: 0.5,
          moveCursor: false,
        },
      },
      sendSocketPayload,
    };

    for (let index = 0; index < 120; index += 1) {
      runtime.sendInputEvent('session-1', options);
    }

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delay).toBeGreaterThanOrEqual(22);
    timers[0]!.callback();
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(sendSocketPayload.mock.calls[0]![2] as string);
    expect(sent).toEqual({
      type: 'remote-window-input',
      control: {
        version: 1,
        sequence: expect.any(String),
        lane: 'continuous',
        attempt: 1,
        sentAtMs: 100,
      },
      payload: {
        ...options.payload,
        event: {
          ...options.payload.event,
          deltaY: 120,
        },
      },
    });
    expect(sent.payload).not.toHaveProperty('requestId');
    expect(sent.payload).not.toHaveProperty('clientSentAt');
  });

  it('keeps one reliable input in flight and retries only a retryable NACK with the same sequence', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 200 });
    const base = {
      ws: makeSocket(),
      sendSocketPayload,
    };
    runtime.sendInputEvent('session-1', {
      ...base,
      payload: {
        streamId: 'stream-drag',
        targetId: 'target-drag',
        event: {
          kind: 'pointer',
          phase: 'down',
          pointerId: 7,
          button: 'left',
          buttons: 1,
          x: 10,
          y: 20,
          normalizedX: 0.1,
          normalizedY: 0.2,
        },
      },
    });
    runtime.sendInputEvent('session-1', {
      ...base,
      payload: {
        streamId: 'stream-drag',
        targetId: 'target-drag',
        event: {
          kind: 'pointer',
          phase: 'up',
          pointerId: 7,
          button: 'left',
          buttons: 0,
          x: 30,
          y: 40,
          normalizedX: 0.3,
          normalizedY: 0.4,
        },
      },
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const first = JSON.parse(sendSocketPayload.mock.calls[0]![2] as string);
    expect(first.control).toMatchObject({ lane: 'reliable', attempt: 1 });
    expect(first.payload.event).toMatchObject({ phase: 'down' });

    expect(runtime.dispatch({
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: first.control.sequence,
        accepted: false,
        retryable: true,
        duplicate: false,
        receivedAtMs: 201,
        error: { code: 'remote_window_input_busy', message: 'busy' },
      },
      payload: { streamId: 'stream-drag', targetId: 'target-drag' },
    } as any)).toBe(true);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(sendSocketPayload.mock.calls[1]![2] as string);
    expect(retry.control).toMatchObject({
      sequence: first.control.sequence,
      lane: 'reliable',
      attempt: 2,
    });

    runtime.dispatch({
      type: 'remote-window-input-ack',
      control: {
        version: 1,
        sequence: first.control.sequence,
        accepted: true,
        retryable: false,
        duplicate: false,
        receivedAtMs: 202,
      },
      payload: { streamId: 'stream-drag', targetId: 'target-drag' },
    } as any);
    expect(sendSocketPayload).toHaveBeenCalledTimes(3);
    const release = JSON.parse(sendSocketPayload.mock.calls[2]![2] as string);
    expect(release.payload.event).toMatchObject({ phase: 'up' });
    expect(release.control.sequence).not.toBe(first.control.sequence);
  });

  it('flushes continuous gestures independently while a reliable barrier is awaiting ACK', () => {
    const sendSocketPayload = vi.fn();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 210,
      setTimeoutFn: vi.fn((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    const shared = { ws: makeSocket(), sendSocketPayload };
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-independent',
        targetId: 'target-independent',
        event: {
          kind: 'pointer',
          phase: 'down',
          pointerId: 1,
          button: 'left',
          buttons: 1,
          x: 10,
          y: 10,
          normalizedX: 0.1,
          normalizedY: 0.1,
        },
      },
    });
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-independent',
        targetId: 'target-independent',
        event: {
          kind: 'scroll',
          unit: 'pixel',
          deltaX: 0,
          deltaY: 12,
          x: 10,
          y: 10,
          normalizedX: 0.1,
          normalizedY: 0.1,
          moveCursor: false,
        },
      },
    });

    expect(timers).toHaveLength(2);
    timers.find((timer) => timer.delay < REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS)!.callback();
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const continuous = JSON.parse(sendSocketPayload.mock.calls[1]![2] as string);
    expect(continuous.control.lane).toBe('continuous');
    expect(continuous.payload.event.deltaY).toBe(12);
  });

  it('retries a reliable ACK timeout once with the same sequence before advancing the barrier', () => {
    const sendSocketPayload = vi.fn();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const listener = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 250,
      setTimeoutFn: vi.fn((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    runtime.subscribe(listener);
    const shared = { ws: makeSocket(), sendSocketPayload };
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-timeout',
        targetId: 'target-timeout',
        event: {
          kind: 'click',
          pointerId: 1,
          button: 'left',
          clickCount: 1,
          x: 10,
          y: 20,
          normalizedX: 0.1,
          normalizedY: 0.2,
        },
      },
    });
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-timeout',
        targetId: 'target-timeout',
        event: { kind: 'close-window' },
      },
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(timers[0]?.delay).toBe(REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS);
    const first = JSON.parse(sendSocketPayload.mock.calls[0]![2] as string);
    timers[0]!.callback();
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(sendSocketPayload.mock.calls[1]![2] as string);
    expect(retry.control).toMatchObject({ sequence: first.control.sequence, attempt: 2 });

    expect(timers[1]?.delay).toBe(REMOTE_WINDOW_INPUT_RELIABLE_ACK_TIMEOUT_MS);
    timers[1]!.callback();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'remote-window-input-ack',
      control: expect.objectContaining({
        sequence: first.control.sequence,
        accepted: false,
        retryable: false,
        error: expect.objectContaining({ code: 'remote_window_input_ack_timeout' }),
      }),
    }));
    expect(sendSocketPayload).toHaveBeenCalledTimes(3);
    const barrier = JSON.parse(sendSocketPayload.mock.calls[2]![2] as string);
    expect(barrier.payload.event.kind).toBe('close-window');
    expect(barrier.control.sequence).not.toBe(first.control.sequence);
  });

  it('keeps only the latest pointer move and uses the quality cadence', () => {
    const sendSocketPayload = vi.fn();
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 275,
      setTimeoutFn: vi.fn((callback: () => void, delay: number) => {
        timers.push({ callback, delay });
        return timers.length;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    void runtime.requestStreamStart('session-1', {
      ws: makeSocket(),
      streamId: 'stream-quality-move',
      mediaPlan: 'single-focus',
      mediaPlanVersion: 2,
      target: makeTarget(),
      videoProfile: qualityVideoProfile,
      sendSocketPayload,
    });
    sendSocketPayload.mockClear();
    const shared = { ws: makeSocket(), sendSocketPayload };
    for (let index = 1; index <= 10; index += 1) {
      runtime.sendInputEvent('session-1', {
        ...shared,
        payload: {
          streamId: 'stream-quality-move',
          targetId: 'target-quality-move',
          event: {
            kind: 'pointer',
            phase: 'move',
            pointerId: 1,
            button: 'left',
            buttons: 1,
            x: index,
            y: index * 2,
            normalizedX: index / 100,
            normalizedY: index / 50,
          },
        },
      });
    }

    const flushTimer = timers.find((timer) => timer.delay === REMOTE_WINDOW_INPUT_QUALITY_FLUSH_INTERVAL_MS);
    expect(flushTimer).toBeDefined();
    flushTimer!.callback();
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(sendSocketPayload.mock.calls[0]![2] as string);
    expect(sent.control.lane).toBe('continuous');
    expect(sent.payload.event).toMatchObject({ kind: 'pointer', phase: 'move', x: 10, y: 20 });
  });

  it('discards pending input on stream stop and ignores stale timeout callbacks', () => {
    const sendSocketPayload = vi.fn();
    const timers: Array<() => void> = [];
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 290,
      setTimeoutFn: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length;
      }) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    const shared = { ws: makeSocket(), sendSocketPayload };
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-discard',
        targetId: 'target-discard',
        event: { kind: 'focus' },
      },
    });
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-discard',
        targetId: 'target-discard',
        event: { kind: 'close-window' },
      },
    });
    runtime.dispose();
    timers.forEach((callback) => callback());
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
  });

  it('keeps continuous input independent from a reliable barrier', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({
      now: () => 300,
      setTimeoutFn: vi.fn(() => 1) as any,
      clearTimeoutFn: vi.fn() as any,
    });
    const shared = { ws: makeSocket(), sendSocketPayload };
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-barrier',
        targetId: 'target-barrier',
        event: {
          kind: 'scroll',
          unit: 'pixel',
          deltaX: 0,
          deltaY: 12,
          x: 10,
          y: 20,
          normalizedX: 0.1,
          normalizedY: 0.2,
        },
      },
    });
    runtime.sendInputEvent('session-1', {
      ...shared,
      payload: {
        streamId: 'stream-barrier',
        targetId: 'target-barrier',
        event: { kind: 'close-window' },
      },
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    const reliable = JSON.parse(sendSocketPayload.mock.calls[0]![2] as string);
    expect(reliable.control.lane).toBe('reliable');
    expect(reliable.payload.event.kind).toBe('close-window');
  });
});
