import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteWindowMessageRuntime,
  isRemoteWindowControlMessage,
} from './remote-window-message-runtime';
import type { ServerMessage } from './types';
import type { RemoteWindowStreamTargetManifest } from './types';

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
      type: 'remote-window-input-result',
      payload: {
        requestId: 'rw-input-1',
        streamId: 'stream-1',
        targetId: 'target-1',
        accepted: true,
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
      target: makeTarget(),
      offer: { type: 'offer', sdp: 'offer-sdp' },
      iceServers: [{ urls: 'stun:relay.codewhisper.cc:3478' }],
      videoBitrate: { preset: '20mbps', bitrateMbps: 20, maxBitrateBps: 20_000_000 },
      sendSocketPayload,
    });

    const sent = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(sent).toMatchObject({
      type: 'remote-window-stream-start-request',
      payload: {
        requestId: expect.stringMatching(/^rw-start-45-/),
        streamId: 'stream-1',
        target: { streamTargetId: 'pane-1' },
        offer: { type: 'offer', sdp: 'offer-sdp' },
        videoBitrate: { preset: '20mbps', bitrateMbps: 20, maxBitrateBps: 20_000_000 },
      },
    });

    runtime.handleStreamStarted({
      requestId: sent.payload.requestId,
      streamId: 'stream-1',
      targetId: 'pane-1',
      answer: { type: 'answer', sdp: 'answer-sdp' },
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
      answer: { type: 'answer', sdp: 'answer-sdp' },
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
      target: makeTarget('pane-2'),
      offer: { type: 'offer', sdp: 'offer-sdp' },
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
    });

    await expect(request).rejects.toMatchObject({
      name: 'screen_capture_failed',
      message: 'ScreenCaptureKit capture start failure',
    });
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('sends candidate and stop messages tied to the stream id', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 47 });
    const ws = makeSocket();

    runtime.sendStreamIceCandidate('session-1', {
      ws,
      streamId: 'stream-3',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      sendSocketPayload,
    });
    runtime.stopStream('session-1', {
      ws,
      streamId: 'stream-3',
      sendSocketPayload,
    });

    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'remote-window-stream-ice-candidate',
      payload: {
        streamId: 'stream-3',
        candidate: { candidate: 'candidate:1' },
      },
    });
    expect(JSON.parse(sendSocketPayload.mock.calls[1][2] as string)).toMatchObject({
      type: 'remote-window-stream-stop-request',
      payload: {
        requestId: expect.stringMatching(/^rw-stop-47-/),
        streamId: 'stream-3',
      },
    });
  });

  it('sends stream quality requests and classifies the daemon result as remote-window control', () => {
    const sendSocketPayload = vi.fn();
    const runtime = createRemoteWindowMessageRuntime({ now: () => 471 });
    const ws = makeSocket();

    runtime.sendStreamQuality('session-1', {
      ws,
      payload: {
        streamId: 'stream-3',
        targetId: 'target-3',
        videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
      },
      sendSocketPayload,
    });

    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'remote-window-stream-quality-request',
      payload: {
        requestId: expect.stringMatching(/^rw-quality-471-/),
        streamId: 'stream-3',
        targetId: 'target-3',
        videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
      },
    });
    expect(isRemoteWindowControlMessage({
      type: 'remote-window-stream-quality-result',
      payload: {
        requestId: 'rw-quality-1',
        streamId: 'stream-3',
        targetId: 'target-3',
        accepted: true,
        videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
      },
    } as ServerMessage)).toBe(true);
  });

  it('sends remote input events with a generated request id', () => {
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
      payload: {
        requestId: expect.stringMatching(/^rw-input-48-/),
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
});
