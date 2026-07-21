import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamStatusPayload } from '@zterm/shared/protocol';
import {
  buildRemoteWindowInputConfig,
  buildMacosAppWindowTargets,
  buildRemoteWindowStreamTargets,
  createRemoteWindowStreamDaemonRuntime,
  flattenIterm2SplitTree,
  MACOS_REMOTE_WINDOW_INPUT_SWIFT,
  parseTmuxClientTargets,
  summarizeRemoteWindowCatalogError,
  type Iterm2RawCatalog,
  type Iterm2RawNode,
  type MacosAppWindowCatalog,
} from './remote-window-stream-daemon';

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
    focusPolicy: 'bring-to-focus' as const,
    inputRoute: 'os-event' as const,
  };
}

class FakeRemoteWindowPeerConnection {
  public onicecandidate: ((event: { candidate: { toJSON: () => Record<string, unknown> } | null }) => void) | null = null;

  public onconnectionstatechange: (() => void) | null = null;

  public connectionState: RTCPeerConnectionState = 'new';

  public localDescription: RTCSessionDescriptionInit | null = null;

  public remoteDescription: RTCSessionDescriptionInit | null = null;

  public addTrack = vi.fn();

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
      },
      {
        windowId: '33',
        ownerName: 'iTerm',
        appBundleId: 'com.googlecode.iterm2',
        pid: 479,
        title: 'Default (tmux)',
        frame: { x: 10, y: 20, width: 302, height: 250 },
      },
    ],
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
      requestId: 'rw-input-config',
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
    }, target);

    expect(config).toEqual({
      pid: 123,
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

  it('keeps scroll input compatible with the macOS helper schema', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let phase: String?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).not.toContain('let phase: String\n');
  });

  it('keeps gesture input compatible with the macOS helper schema', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('let gesture: String?');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('config.event.kind == "gesture"');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('remote gesture input missing delta or coordinates');
  });

  it('moves the macOS cursor to the remote input coordinate before scroll and gesture wheel events', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('func postMouseMove(x: Double, y: Double)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('postMouseMove(x: x, y: y)');
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toMatch(
      /func postScrollEvent[\s\S]*postMouseMove\(x: x, y: y\)[\s\S]*scrollWheelEvent2Source/,
    );
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toMatch(
      /config\.event\.kind == "gesture"[\s\S]*postScrollEvent\(x: pointX, y: pointY/,
    );
  });

  it('maps Command+V through a real macOS virtual key code for remote-window image paste', () => {
    expect(MACOS_REMOTE_WINDOW_INPUT_SWIFT).toContain('"KeyV": 9');
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
      focusPolicy: 'bring-to-focus',
      inputRoute: 'os-event',
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
        frameRate: 12,
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
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendIceCandidate: (payload) => candidates.push(payload),
      sendStatus: (payload) => statuses.push(payload),
    });

    expect('answer' in result ? result : null).toMatchObject({
      requestId: 'rw-start',
      streamId: 'stream-1',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      answer: { type: 'answer', sdp: 'daemon-answer-sdp' },
      capture: {
        source: 'ScreenCaptureKit',
        frameWidth: 2,
        frameHeight: 2,
        frameRate: 12,
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
        frameRate: 12,
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
      { requestId: 'rw-start', streamId: 'stream-1', phase: 'starting' },
      {
        requestId: 'rw-start',
        streamId: 'stream-1',
        phase: 'streaming',
        framesSent: 1,
        frameWidth: 2,
        frameHeight: 2,
      },
    ]);
    expect(candidates).toEqual([{
      requestId: 'rw-start',
      streamId: 'stream-1',
      candidate: {
        candidate: 'candidate:daemon',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'daemon',
      },
    }]);
  });

  it('applies requested video bitrate at stream start and on quality update', async () => {
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
        return {
          width: 2,
          height: 2,
          frameRate: 12,
          stop: vi.fn(),
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

    const started = await runtime.startStream({
      requestId: 'rw-bitrate-start',
      streamId: 'stream-bitrate',
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
    });

    expect('answer' in started ? started.capture.maxBitrateBps : null).toBe(5_000_000);
    expect(fakeSender.setParameters).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 5_000_000, maxFramerate: 8 })],
    }));

    const updated = await runtime.updateStreamQuality({
      requestId: 'rw-bitrate-update',
      streamId: 'stream-bitrate',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      videoBitrate: { preset: 'fullscreen', bitrateMbps: 20, maxBitrateBps: 20_000_000 },
    });

    expect(updated).toEqual({
      requestId: 'rw-bitrate-update',
      streamId: 'stream-bitrate',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      accepted: true,
      videoBitrate: { preset: 'fullscreen', bitrateMbps: 20, maxBitrateBps: 20_000_000, maxFrameRateFps: 12 },
    });
    expect(fakeSender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 20_000_000, maxFramerate: 12 })],
    }));
  });

  it('starts remote window stream without fabricating sender encodings for video bitrate', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeSender = makeFakeRtpSender({ encodings: [] } as unknown as RTCRtpSendParameters);
    fakePeer.addTrack.mockReturnValue(fakeSender);
    const fakeTrack = makeFakeMediaStreamTrack();
    const statuses: RemoteWindowStreamStatusPayload[] = [];
    const runtime = createRemoteWindowStreamDaemonRuntime({
      platform: 'darwin',
      captureSourceFactory: vi.fn(async (_target, options) => {
        options.onFrame({ width: 2, height: 2, rgba: new Uint8Array(16).fill(12) });
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
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
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
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
    expect(statuses[0]).toEqual({
      requestId: 'rw-bitrate-empty-start',
      streamId: 'stream-bitrate-empty',
      phase: 'starting',
      message: 'video bitrate not applied: remote window video bitrate sender has no encodings to update',
    });

    const updated = await runtime.updateStreamQuality({
      requestId: 'rw-bitrate-empty-update',
      streamId: 'stream-bitrate-empty',
      targetId: 'iterm2-pane:window-1:tab-1:left',
      videoBitrate: { preset: '10mbps', bitrateMbps: 10, maxBitrateBps: 10_000_000 },
    });

    expect(updated).toEqual({
      requestId: 'rw-bitrate-empty-update',
      streamId: 'stream-bitrate-empty',
      code: 'remote_window_stream_quality_failed',
      message: 'remote window video bitrate sender has no encodings to update',
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
        return { width: 2, height: 2, frameRate: 12, stop: vi.fn() };
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
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
      videoBitrate: { preset: '5mbps', bitrateMbps: 5, maxBitrateBps: 5_000_000 },
    });
    fakeSender.setParameters.mockClear();

    const updated = await runtime.updateStreamQuality({
      requestId: 'rw-bitrate-mismatch',
      streamId: 'stream-bitrate-mismatch',
      targetId: 'wrong-target',
      videoBitrate: { preset: '10mbps', bitrateMbps: 10, maxBitrateBps: 10_000_000 },
    });

    expect(updated).toEqual({
      requestId: 'rw-bitrate-mismatch',
      streamId: 'stream-bitrate-mismatch',
      code: 'remote_window_stream_quality_target_mismatch',
      message: 'remote window stream quality target mismatch: wrong-target',
    });
    expect(fakeSender.setParameters).not.toHaveBeenCalled();
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
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

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
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (payload) => statuses.push(payload),
    });

    expect('answer' in result).toBe(true);
    expect(() => {
      pushFrame({ width: 3, height: 3, rgba: new Uint8Array(36).fill(2) });
    }).not.toThrow();
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
    expect(await runtime.addIceCandidate({
      streamId: 'stream-late-frame-failure',
      candidate: { candidate: 'candidate:after-failure' },
    })).toBe(false);
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
      target: invalidTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toEqual({
      requestId: 'rw-invalid',
      streamId: 'stream-invalid',
      code: 'remote_window_stream_start_failed',
      message: 'remote window stream target requires cropRectTopLeftPx',
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
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    expect(result).toEqual({
      requestId: 'rw-capture-fail',
      streamId: 'stream-capture-fail',
      code: 'remote_window_stream_start_failed',
      message: 'ScreenCaptureKit capture start failure',
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

    await runtime.startStream({
      requestId: 'rw-start-stop',
      streamId: 'stream-stop',
      target: makeStreamTarget(),
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    }, {
      sendStatus: (payload) => statuses.push(payload),
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
    expect(await runtime.addIceCandidate({
      streamId: 'stream-stop',
      candidate: { candidate: 'candidate:late' },
    })).toBe(false);
    expect(statuses).toContainEqual(expect.objectContaining({
      requestId: 'rw-start-stop',
      streamId: 'stream-stop',
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
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const result = await runtime.injectInput({
      requestId: 'rw-input',
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
    });

    expect(result).toEqual({
      requestId: 'rw-input',
      streamId: 'stream-input',
      targetId: 'app-window:123:456',
      accepted: true,
    });
    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'rw-input',
        event: expect.objectContaining({ kind: 'pointer', x: 100 }),
      }),
      target,
      expect.objectContaining({ swiftBinary: 'swift' }),
    );

    runRemoteWindowInputEvent.mockClear();
    const scrollResult = await runtime.injectInput({
      requestId: 'rw-input-scroll',
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
    });
    expect(scrollResult).toEqual({
      requestId: 'rw-input-scroll',
      streamId: 'stream-input',
      targetId: 'app-window:123:456',
      accepted: true,
    });
	    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
	      expect.objectContaining({
	        requestId: 'rw-input-scroll',
	        event: expect.objectContaining({ kind: 'scroll', deltaY: 48 }),
	      }),
	      target,
	      expect.objectContaining({ swiftBinary: 'swift' }),
	    );

	    runRemoteWindowInputEvent.mockClear();
	    const gestureResult = await runtime.injectInput({
	      requestId: 'rw-input-gesture',
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
	    });
	    expect(gestureResult).toEqual({
	      requestId: 'rw-input-gesture',
	      streamId: 'stream-input',
	      targetId: 'app-window:123:456',
	      accepted: true,
	    });
	    expect(runRemoteWindowInputEvent).toHaveBeenCalledWith(
	      expect.objectContaining({
	        requestId: 'rw-input-gesture',
	        event: expect.objectContaining({ kind: 'gesture', gesture: 'swipe', deltaY: 50 }),
	      }),
	      target,
	      expect.objectContaining({ swiftBinary: 'swift' }),
	    );
	  });

  it('uses one persistent macOS input helper for pointer, scroll, gesture, and key events', async () => {
    const fakePeer = new FakeRemoteWindowPeerConnection();
    const fakeTrack = makeFakeMediaStreamTrack();
    const target = makeAppStreamTarget();
    const inputHelper = {
      send: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const remoteWindowInputHelperFactory = vi.fn(() => inputHelper);
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
      remoteWindowInputHelperFactory,
      runTmux: vi.fn(() => ({ ok: true as const, stdout: '' })),
    });

    await runtime.startStream({
      requestId: 'rw-input-start-helper',
      streamId: 'stream-input-helper',
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    await runtime.injectInput({
      requestId: 'rw-input-helper-pointer',
      streamId: 'stream-input-helper',
      targetId: target.streamTargetId,
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
    });
	    await runtime.injectInput({
	      requestId: 'rw-input-helper-scroll',
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
	    });
	    await runtime.injectInput({
	      requestId: 'rw-input-helper-gesture',
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
	    });
	    await runtime.injectInput({
	      requestId: 'rw-input-helper-key',
      streamId: 'stream-input-helper',
      targetId: target.streamTargetId,
      event: {
        kind: 'key',
        phase: 'down',
        key: 'Z',
        code: 'KeyZ',
	        text: 'Z',
	      },
	    });

    expect(remoteWindowInputHelperFactory).toHaveBeenCalledTimes(1);
    expect(inputHelper.send).toHaveBeenCalledTimes(4);
    expect(inputHelper.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: expect.objectContaining({ kind: 'pointer' }),
      window: expect.objectContaining({ bounds: target.videoTarget.windowBoundsTopLeftPx }),
    }));
    expect(inputHelper.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: expect.objectContaining({ kind: 'scroll', deltaY: 48 }),
    }));
    expect(inputHelper.send).toHaveBeenNthCalledWith(3, expect.objectContaining({
      event: expect.objectContaining({ kind: 'gesture', gesture: 'swipe', deltaY: 50 }),
    }));
    expect(inputHelper.send).toHaveBeenNthCalledWith(4, expect.objectContaining({
      event: expect.objectContaining({ kind: 'key', text: 'Z' }),
    }));

    runtime.dispose('helper lifecycle test complete');
    expect(inputHelper.dispose).toHaveBeenCalledTimes(1);
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
      target,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });

    const mismatch = await runtime.injectInput({
      requestId: 'rw-input-mismatch',
      streamId: 'stream-input-negative',
      targetId: 'other-target',
      event: {
        kind: 'key',
        phase: 'down',
        key: 'a',
        code: 'KeyA',
        text: 'a',
      },
    });
    expect(mismatch).toMatchObject({
      requestId: 'rw-input-mismatch',
      streamId: 'stream-input-negative',
      code: 'remote_window_input_failed',
      message: 'remote window input target mismatch: other-target',
    });

    const noFocusTarget = { ...target, focusPolicy: 'no-focus-steal' as const };
    await runtime.startStream({
      requestId: 'rw-input-start-no-focus',
      streamId: 'stream-input-no-focus',
      target: noFocusTarget,
      offer: { type: 'offer', sdp: 'android-offer-sdp' },
    });
    const noFocus = await runtime.injectInput({
      requestId: 'rw-input-no-focus',
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
    });
    expect(noFocus).toMatchObject({
      code: 'remote_window_input_failed',
      message: 'remote window OS input requires bring-to-focus policy',
    });

    const invalidScroll = await runtime.injectInput({
      requestId: 'rw-input-invalid-scroll',
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
    });
	    expect(invalidScroll).toMatchObject({
	      code: 'remote_window_input_failed',
	      message: 'remote window scroll input coordinates or delta are invalid',
	    });

	    const invalidGesture = await runtime.injectInput({
	      requestId: 'rw-input-invalid-gesture',
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
	    });
	    expect(invalidGesture).toMatchObject({
	      code: 'remote_window_input_failed',
	      message: 'remote window gesture input normalized coordinates are out of range',
	    });

    await runtime.stopStream({ requestId: 'rw-stop-input', streamId: 'stream-input-negative' });
    const stopped = await runtime.injectInput({
      requestId: 'rw-input-stopped',
      streamId: 'stream-input-negative',
      targetId: target.streamTargetId,
      event: {
        kind: 'key',
        phase: 'down',
        key: 'a',
        code: 'KeyA',
        text: 'a',
      },
    });
    expect(stopped).toMatchObject({
      requestId: 'rw-input-stopped',
      streamId: 'stream-input-negative',
      code: 'remote_window_input_stream_missing',
    });
    expect(runRemoteWindowInputEvent).not.toHaveBeenCalled();
  });
});
