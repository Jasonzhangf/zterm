// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowOverlay } from './RemoteWindowOverlay';
import type {
  RemoteWindowStreamQualityRequestPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from '../../lib/types';

const backListeners: Array<() => void> = [];

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, handler: () => void) => {
      backListeners.push(handler);
      return {
        remove: vi.fn(() => {
          const index = backListeners.indexOf(handler);
          if (index >= 0) {
            backListeners.splice(index, 1);
          }
        }),
      };
    }),
  },
}));

const originalWindowInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const originalWindowInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const originalWindowVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function restoreWindowViewport() {
  if (originalWindowInnerWidth) {
    Object.defineProperty(window, 'innerWidth', originalWindowInnerWidth);
  }
  if (originalWindowInnerHeight) {
    Object.defineProperty(window, 'innerHeight', originalWindowInnerHeight);
  }
  if (originalWindowVisualViewport) {
    Object.defineProperty(window, 'visualViewport', originalWindowVisualViewport);
  } else {
    Reflect.deleteProperty(window, 'visualViewport');
  }
}

function makeTarget(id: string, title: string, kind: 'app-window' | 'iterm2-pane'): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind,
      appBundleId: kind === 'iterm2-pane' ? 'com.googlecode.iterm2' : 'com.apple.TextEdit',
      pid: 123,
      windowId: 'window-1',
      title,
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 40, width: 800, height: 560 },
    },
    inputTarget: kind === 'iterm2-pane'
      ? { kind: 'tmux-pane', itermSessionId: 'iterm-1', tty: '/dev/ttys001', tmuxSession: 'zterm', tmuxWindowId: '@1', tmuxPaneId: '%2' }
      : { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: kind === 'iterm2-pane' ? 'tmux-input' : 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

function makeStartedPayload(
  streamId: string,
  targetId: string,
  frameWidth: number,
  frameHeight: number,
) {
  return {
    requestId: `rw-started-${streamId}`,
    streamId,
    targetId,
    mediaPlan: 'single-focus' as const,
    mediaPlanVersion: 1 as const,
    answer: { type: 'answer' as const, sdp: 'daemon-answer-sdp' },
    capture: {
      source: 'ScreenCaptureKit' as const,
      frameWidth,
      frameHeight,
      frameRate: 12,
      targetKind: 'app-window' as const,
    },
    transport: { kind: 'webrtc-video' as const },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function expandItermPaneGroup() {
  fireEvent.click(await screen.findByTestId('remote-window-iterm-pane-group'));
}

async function revealVideoThroughBoundPlayback(video: HTMLElement) {
  const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  try {
    fireEvent.loadedData(video);
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-video-wallpaper').style.opacity).toBe('0');
    });
  } finally {
    playSpy.mockRestore();
  }
}

function remoteInputPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return sendInput.mock.calls.map((call) => call[1]);
}

function actionRemoteInputPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return remoteInputPayloads(sendInput).filter(Boolean);
}

function expectNoRemoteInputFocus(sendInput: ReturnType<typeof vi.fn>) {
  expect(remoteInputPayloads(sendInput).some((payload) => payload?.event?.kind === 'focus')).toBe(false);
}

function expectEveryRemoteInputIsActionOnly(sendInput: ReturnType<typeof vi.fn>) {
  expectNoRemoteInputFocus(sendInput);
  expect(remoteInputPayloads(sendInput).every((payload) => Boolean(payload?.streamId && payload?.targetId && payload?.event))).toBe(true);
}

async function flushRemoteWindowSurfaceLayout() {
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
}

async function waitForActionRemoteInputCount(sendInput: ReturnType<typeof vi.fn>, count: number) {
  await waitFor(() => {
    expect(actionRemoteInputPayloads(sendInput)).toHaveLength(count);
  });
}

function createAppliedQualityMock() {
  return vi.fn(async (_sessionId: string, payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>) => ({
    requestId: `quality-${payload.revision}`,
    streamId: payload.streamId,
    streamGroupId: payload.streamGroupId,
    mediaPlan: 'single-focus' as const,
    mediaPlanVersion: 1 as const,
    revision: payload.revision,
    targetId: payload.targetId,
    status: 'applied' as const,
    requestedVideoProfile: payload.videoProfile,
    appliedVideoProfile: payload.videoProfile,
  }));
}

function createCapabilityStatusChannel() {
  let handler: ((msg: any) => void) | null = null;
  return {
    onRemoteWindowMessage: vi.fn((next: (msg: any) => void) => {
      handler = next;
      return () => {
        if (handler === next) {
          handler = null;
        }
      };
    }),
    publishCapabilityStatus(streamId: string) {
      handler?.({
        type: 'remote-window-stream-status',
        payload: {
          requestId: 'capability-status-1',
          streamId,
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
      });
    },
  };
}

describe('RemoteWindowOverlay', () => {
  beforeEach(() => {
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: {
        configurable: true,
        value: vi.fn(() => 1),
      },
      cancelVideoFrameCallback: {
        configurable: true,
        value: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    restoreWindowViewport();
    backListeners.splice(0, backListeners.length);
    window.localStorage.clear();
    Reflect.deleteProperty(navigator, 'connection');
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
    vi.useRealTimers();
  });

  it('opens the picker with app windows visible and iTerm2 panes collapsed until expanded', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [
        makeTarget('app-1', 'TextEdit', 'app-window'),
        makeTarget('pane-1', 'zterm pane', 'iterm2-pane'),
      ],
      errors: [{ requestId: 'rw-1', code: 'iterm2_partial', message: 'partial source warning' }],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    expect(requestTargets).toHaveBeenCalledWith('session-1');
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-target-app-1')).toBeTruthy();
      expect(screen.getByTestId('remote-window-iterm-pane-group')).toBeTruthy();
      expect(screen.queryByTestId('remote-window-target-pane-1')).toBeNull();
      expect(screen.queryByTestId('remote-window-partial-errors')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('remote-window-iterm-pane-group'));
    expect(screen.getByTestId('remote-window-target-pane-1')).toBeTruthy();
  });

  it('exposes stream lifecycle variables from the floating status panel', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-status-1',
      targets: [makeTarget('app-status', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-status" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-target-app-status')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('remote-window-target-app-status'));

    fireEvent.click(screen.getByTestId('remote-window-more-toggle'));
    const panel = screen.getByTestId('remote-window-stream-status-panel');
    fireEvent.click(screen.getByText('开发诊断'));
    expect(panel.textContent).toContain('session: session-status');
    expect(panel.textContent).toContain('phase: targetLocked');
    expect(panel.textContent).toContain('target: app-status');

    fireEvent.click(screen.getByTestId('remote-window-more-toggle'));
    expect(screen.queryByTestId('remote-window-stream-status-panel')).toBeNull();
  });

  it('keeps the fullscreen overlay explicitly viewport-sized after a resize event', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-rotation-1',
      targets: [makeTarget('app-rotation', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-rotation" requestTargets={requestTargets} />);
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await waitFor(() => expect(screen.getByTestId('remote-window-target-app-rotation')).toBeTruthy());
    fireEvent.click(screen.getByTestId('remote-window-target-app-rotation'));
    fireEvent.doubleClick(screen.getByTestId('remote-window-video-surface'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    expect((overlay as HTMLElement).style.width).toBe('100%');
    expect((overlay as HTMLElement).style.height).toBe('100%');
    expect((overlay as HTMLElement).style.minHeight).toBe('100%');
    window.dispatchEvent(new Event('orientationchange'));
    window.dispatchEvent(new Event('resize'));
    expect(screen.getByTestId('remote-window-more-toggle')).toBeTruthy();
  });

  it('lists an app group as one picker row and switches sibling windows inside the video surface', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390, height: 844, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow: RemoteWindowStreamTargetManifest = {
      ...makeTarget('app-child', 'WeChat Image', 'app-window'),
      videoTarget: {
        ...mainWindow.videoTarget,
        windowId: 'window-2',
        title: 'WeChat Image',
        windowBoundsTopLeftPx: { x: 120, y: 90, width: 320, height: 240 },
        cropRectTopLeftPx: { x: 120, y: 90, width: 320, height: 240 },
      },
    };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [childWindow, mainWindow],
    }));
    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-app-group-com-apple-TextEdit-123')).toBeTruthy();
    });

    const group = screen.getByTestId('remote-window-app-group-com-apple-TextEdit-123');
    expect(group.dataset.primaryTargetId).toBe('app-main');
    expect(screen.queryByTestId('remote-window-target-app-child')).toBeNull();
    fireEvent.click(group);
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
    const videoGroup = screen.getByTestId('remote-window-video-window-switcher');
    expect(videoGroup).toBeTruthy();
    expect(videoGroup.getAttribute('data-window-group-secondary-placement')).toBe('before');
    expect(videoGroup.firstElementChild?.contains(screen.getByTestId('remote-window-video-window-option-app-child'))).toBe(true);
    expect(videoGroup.lastElementChild?.contains(screen.getByTestId('remote-window-video-surface'))).toBe(true);
    expect(videoGroup.contains(screen.getByTestId('remote-window-video-surface'))).toBe(true);
    expect(screen.queryByTestId('remote-window-video-window-option-app-main')).toBeNull();
    expect(screen.getByTestId('remote-window-video-window-option-app-child')).toBeTruthy();
    expect(screen.getByTestId('remote-window-video-window-thumbnail-app-child')).toBeTruthy();

    expect(screen.getByTestId('remote-window-video-window-option-app-child')).toBeTruthy();
  });

  it('opens an active app-title switch list and switches to another target without reopening the picker', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const appOne = makeTarget('app-1', 'TextEdit', 'app-window');
    const appTwo = {
      ...makeTarget('app-2', 'Safari', 'app-window'),
      videoTarget: {
        ...makeTarget('app-2', 'Safari', 'app-window').videoTarget,
        appBundleId: 'com.apple.Safari',
        pid: 456,
        windowId: 'window-2',
      },
    };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [appOne, appTwo],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const stopStream = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        stopStream={stopStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    const firstVideo = await screen.findByTestId('remote-window-video');
    await revealVideoThroughBoundPlayback(firstVideo);
    expect(screen.getByTestId('remote-window-video-wallpaper').style.opacity).toBe('0');

    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-button'));

    expect(screen.getByTestId('remote-window-active-app-switch-list')).toBeTruthy();
    expect(screen.getByTestId('remote-window-active-app-switch-target-app-1').getAttribute('aria-current')).toBe('true');

    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-target-app-2'));

    await waitFor(() => {
      expect(stopStream).toHaveBeenCalledWith('session-1', expect.stringMatching(/^rw-stream-/));
      expect(startStream).toHaveBeenCalledTimes(2);
      expect(startStream.mock.calls[1]?.[1]).toMatchObject({ streamTargetId: 'app-2' });
    });
    expect(screen.queryByTestId('remote-window-active-app-switch-list')).toBeNull();
    expect(screen.getByTestId('remote-window-active-app-switch-button').textContent).toContain('Safari');
    expect(screen.getByTestId('remote-window-video-wallpaper')).toBeTruthy();
    expect((screen.getByTestId('remote-window-video') as HTMLVideoElement).style.visibility).toBe('visible');
  });

  it('keeps the same video element when the stream id changes (no remount, srcObject swap on one element)', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const appOne = makeTarget('app-1', 'TextEdit', 'app-window');
    const appTwo = {
      ...makeTarget('app-2', 'Safari', 'app-window'),
      videoTarget: {
        ...makeTarget('app-2', 'Safari', 'app-window').videoTarget,
        appBundleId: 'com.apple.Safari',
        pid: 456,
        windowId: 'window-2',
      },
    };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [appOne, appTwo],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    const firstVideo = await screen.findByTestId('remote-window-video');
    await revealVideoThroughBoundPlayback(firstVideo);

    // 切换到 sibling 目标：streamId 变化但 video 元素必须保持同一实例，
    // 仅 srcObject 替换（Android WebView 对重建元素绑 WebRTC 流只渲染首帧会冻结）
    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-button'));
    fireEvent.click(await screen.findByTestId('remote-window-active-app-switch-target-app-2'));

    await waitFor(() => {
      expect(startStream.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByTestId('remote-window-video')).toBe(firstVideo);
    });
  });

  it('surfaces old stream cleanup failure after a committed handoff', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const appOne = makeTarget('app-1', 'TextEdit', 'app-window');
    const appTwo = {
      ...makeTarget('app-2', 'Safari', 'app-window'),
      videoTarget: {
        ...makeTarget('app-2', 'Safari', 'app-window').videoTarget,
        appBundleId: 'com.apple.Safari',
        pid: 456,
        windowId: 'window-2',
      },
    };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [appOne, appTwo],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const stopStream = vi.fn(async () => {
      throw new Error('stop failed');
    });

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        stopStream={stopStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-button'));
    fireEvent.click(screen.getByTestId('remote-window-active-app-switch-target-app-2'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-active-app-switch-button').textContent).toContain('Safari');
      expect(screen.getByTestId('remote-window-stream-cleanup-error').textContent).toContain('stop failed');
    });
    expect(screen.queryByTestId('remote-window-stream-error')).toBeNull();
  });

  it('switches sibling windows through the existing focus stream', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow = {
      ...makeTarget('app-child', 'WeChat Image', 'app-window'),
      videoTarget: { ...mainWindow.videoTarget, windowId: 'window-2', title: 'WeChat Image' },
    };
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-1', targets: [mainWindow, childWindow] }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({ streamId, mediaStream }));
    const updateFocus = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateFocus={updateFocus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-app-group-com-apple-TextEdit-123'));
    await screen.findByTestId('remote-window-video');
    await waitFor(() => expect(updateFocus).not.toHaveBeenCalled());
    const focusStreamId = startStream.mock.calls[0]?.[2] as string;

    fireEvent.click(screen.getByTestId('remote-window-video-window-option-app-child'));
    await waitFor(() => expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-dual-stream-phase')).toBe('overview-crop-visible'));
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(updateFocus).toHaveBeenCalledWith('session-1', focusStreamId, childWindow, 1);
  });

  it('surfaces a matching focus error and ignores stale focus errors', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow = { ...makeTarget('app-child', 'WeChat Image', 'app-window'), videoTarget: { ...mainWindow.videoTarget, windowId: 'window-2' } };
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-1', targets: [mainWindow, childWindow] }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({ streamId, mediaStream }));
    const updateFocus = vi.fn();
    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} startStream={startStream} updateFocus={updateFocus} />);
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-app-group-com-apple-TextEdit-123'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByTestId('remote-window-video-window-option-app-child'));
    await waitFor(() => expect(updateFocus).toHaveBeenCalledTimes(1));
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(updateFocus).toHaveBeenCalledWith('session-1', expect.any(String), childWindow, 1);
  });

  it('syncs the active stream catalog on a light cadence and applies the resized target truth', async () => {
    vi.useFakeTimers();
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const target = makeTarget('app-main', 'WeChat', 'app-window');
    const syncedTarget: RemoteWindowStreamTargetManifest = {
      ...target,
      videoTarget: {
        ...target.videoTarget,
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 1200 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 1200 },
      },
    };
    const childTarget: RemoteWindowStreamTargetManifest = {
      ...makeTarget('app-child', 'WeChat Dialog', 'app-window'),
      videoTarget: {
        ...target.videoTarget,
        windowId: 'window-dialog',
        title: 'WeChat Dialog',
        windowBoundsTopLeftPx: { x: 40, y: 80, width: 420, height: 280 },
        cropRectTopLeftPx: { x: 40, y: 80, width: 420, height: 280 },
      },
    };
    const requestTargets = vi.fn(async (_sessionId: string, options?: { forceRefresh?: boolean }) => ({
      requestId: options?.forceRefresh ? 'rw-sync' : 'rw-1',
      targets: options?.forceRefresh ? [syncedTarget, childTarget] : [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('remote-window-target-app-main'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestTargets).toHaveBeenCalledWith('session-1', { forceRefresh: true });
    expect(screen.getByTestId('remote-window-video-window-option-app-child')).toBeTruthy();
    expect(screen.getByTestId('remote-window-video-surface').style.aspectRatio).toBe('800 / 1200');

    await act(async () => {
      vi.advanceTimersByTime(4_000);
      await Promise.resolve();
    });
    expect(requestTargets.mock.calls.filter((call) => call[1]?.forceRefresh === true)).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(requestTargets.mock.calls.filter((call) => call[1]?.forceRefresh === true)).toHaveLength(2);
  });

  it('fails the picker locally when the daemon catalog promise never settles', async () => {
    vi.useFakeTimers();
    const requestTargets = vi.fn(() => new Promise<never>(() => undefined));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    expect(screen.getByTestId('remote-window-picker-loading')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });

    expect(screen.queryByTestId('remote-window-picker-loading')).toBeNull();
    expect(screen.getByTestId('remote-window-picker-error').textContent).toContain('远程窗口列表读取超时');
  });

  it('reopens the remote-window picker from the cached catalog without a blank loading panel', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口选择' }));
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    expect(screen.queryByTestId('remote-window-picker-loading')).toBeNull();
    expect(screen.getByTestId('remote-window-target-app-1')).toBeTruthy();
    expect(requestTargets).toHaveBeenCalledTimes(1);
  });

  it('keeps cached target rows visible while an explicit catalog refresh runs', async () => {
    let resolveRefresh: ((payload: { requestId: string; targets: RemoteWindowStreamTargetManifest[] }) => void) | null = null;
    const requestTargets = vi.fn()
      .mockResolvedValueOnce({
        requestId: 'rw-1',
        targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRefresh = resolve;
      }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByRole('button', { name: '刷新远程窗口列表' }));

    expect(requestTargets).toHaveBeenLastCalledWith('session-1', { forceRefresh: true });
    expect(screen.queryByTestId('remote-window-picker-loading')).toBeNull();
    expect(screen.getByTestId('remote-window-target-app-1')).toBeTruthy();
    expect(screen.getByText(/更新中/)).toBeTruthy();

    await act(async () => {
      resolveRefresh?.({
        requestId: 'rw-2',
        targets: [makeTarget('app-2', 'Safari', 'app-window')],
      });
    });

    await screen.findByTestId('remote-window-target-app-2');
    expect(screen.queryByTestId('remote-window-target-app-1')).toBeNull();
  });

  it('selects a target, expands to fullscreen, shrinks on Back, and closes explicitly', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('floating');
    expect(screen.getByText('等待视频流')).toBeTruthy();
    const wallpaper = screen.getByTestId('remote-window-video-wallpaper');
    expect(wallpaper.textContent).not.toContain('ZTERM');
    expect(screen.getByTestId('remote-window-video-wallpaper-logo')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('fullscreen');
    });
    expect(backListeners.length).toBe(1);

    backListeners[0]?.();
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('floating');
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    await waitFor(() => {
      expect(screen.queryByTestId('remote-window-locked-overlay')).toBeNull();
      expect(screen.getByRole('button', { name: '打开远程窗口' })).toBeTruthy();
    });
  });

  it('starts a stream after selecting a target, renders only the receiver media stream, and stops on close', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const stopStream = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        stopStream={stopStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    await waitFor(() => {
      expect(startStream).toHaveBeenCalledWith('session-1', expect.objectContaining({
        streamTargetId: 'pane-1',
      }), expect.stringMatching(/^rw-stream-/), expect.objectContaining({
        purpose: 'focus',
      }));
    });
    await waitFor(() => {
      const video = screen.getByTestId('remote-window-video') as HTMLVideoElement;
      expect(video.srcObject).toBe(mediaStream);
      expect(video.style.pointerEvents).toBe('none');
    });
    expect(screen.queryByText('等待视频流')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    await waitFor(() => {
      expect(stopStream).toHaveBeenCalledWith('session-1', expect.stringMatching(/^rw-stream-/));
      expect(screen.queryByTestId('remote-window-video')).toBeNull();
    });
  });

  it('stops the stream and reports unsupported decoded-frame projection', async () => {
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
    const mediaStream = { id: 'media-stream-no-frame-callback' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-no-frame-callback',
      targets: [makeTarget('pane-no-frame-callback', 'zterm pane', 'iterm2-pane')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const stopStream = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        stopStream={stopStream}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-no-frame-callback'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-stream-error').textContent)
        .toContain('remote window decoded-frame callback is unavailable');
    });
    expect(stopStream).toHaveBeenCalledTimes(1);
    expect(stopStream).toHaveBeenCalledWith('session-1', expect.stringMatching(/^rw-stream-/));
    expect(screen.queryByTestId('remote-window-video')).toBeNull();
  });

  it('rejects a late focus stream after the overlay has closed', async () => {
    const focusStream = { id: 'focus-stream' } as MediaStream;
    const focusStart = createDeferred<{ streamId: string; mediaStream: MediaStream }>();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn((
      _sessionId: string,
      _target: RemoteWindowStreamTargetManifest,
      streamId: string,
      options?: { purpose?: string },
    ) => {
      if (options?.purpose === 'focus') {
        return focusStart.promise.then((result) => ({ ...result, streamId }));
      }
      return Promise.resolve({ streamId, mediaStream: focusStream });
    });
    const stopStream = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        stopStream={stopStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(1);
    });
    const focusStreamId = startStream.mock.calls[0]?.[2] as string;

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    await waitFor(() => {
      expect(stopStream).toHaveBeenCalledWith('session-1', focusStreamId);
    });

    await act(async () => {
      focusStart.resolve({ streamId: focusStreamId, mediaStream: focusStream });
      await focusStart.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId('remote-window-video')).toBeNull();
    });
  });

  it('publishes the active remote-window input context before requesting the keyboard', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const onInputContextChange = vi.fn();
    const onRequestKeyboard = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        onInputContextChange={onInputContextChange}
        onRequestKeyboard={onRequestKeyboard}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    onInputContextChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '调起远程窗口键盘' }));

    expect(onInputContextChange).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      targetId: 'app-1',
      inputRoute: 'os-event',
      focusPolicy: 'bring-to-focus',
    }));
    expect(onRequestKeyboard).toHaveBeenCalledTimes(1);
  });

  it('keeps the logo-only wallpaper behind an unplayed receiver video', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    const wallpaper = screen.getByTestId('remote-window-video-wallpaper');
    expect(wallpaper.textContent).not.toContain('ZTERM');
    const logo = screen.getByTestId('remote-window-video-wallpaper-logo');
    expect(logo).toBeTruthy();
    expect((logo as HTMLImageElement).src).toContain('logo_engraved');
    expect(logo.style.mixBlendMode).toBe('');
    expect(logo.style.filter).not.toContain('drop-shadow');
    expect((screen.getByTestId('remote-window-video') as HTMLVideoElement).poster).toContain('logo_engraved');
  });

  it('keeps the native video hidden on media readiness until playback starts', async () => {
    const pendingPlay = { resolve: undefined as undefined | (() => void) };
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => new Promise<void>((resolve) => {
        pendingPlay.resolve = resolve;
      }));
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    try {
      render(
        <RemoteWindowOverlay
          activeSessionId="session-1"
          requestTargets={requestTargets}
          startStream={startStream}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
      fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
      const video = await screen.findByTestId('remote-window-video');
      expect(screen.getByTestId('remote-window-video-wallpaper')).toBeTruthy();

      fireEvent.loadedData(video);

      expect(screen.getByTestId('remote-window-video-wallpaper')).toBeTruthy();
      expect((video as HTMLVideoElement).style.opacity).toBe('0');
      expect((video as HTMLVideoElement).style.visibility).toBe('visible');

      pendingPlay.resolve?.();

      await waitFor(() => {
        expect(screen.getByTestId('remote-window-video-wallpaper').style.opacity).toBe('0');
      });
      expect((video as HTMLVideoElement).style.visibility).toBe('visible');
    } finally {
      playSpy.mockRestore();
    }
  });

  it('reveals an attached receiver only after a real video frame callback', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => new Promise<void>(() => {}));
    const videoPrototype = HTMLVideoElement.prototype as unknown as {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    const originalRequestVideoFrameCallback = videoPrototype.requestVideoFrameCallback;
    const frameCallbacks: Array<(now?: number, metadata?: { presentedFrames?: number }) => void> = [];
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: vi.fn((callback: (now?: number, metadata?: { presentedFrames?: number }) => void) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    });
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    try {
      render(
        <RemoteWindowOverlay
          activeSessionId="session-1"
          requestTargets={requestTargets}
          startStream={startStream}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
      fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
      const video = await screen.findByTestId('remote-window-video');
      expect(screen.getByTestId('remote-window-video-wallpaper')).toBeTruthy();
      expect((video as HTMLVideoElement).style.visibility).toBe('visible');

      act(() => {
        frameCallbacks.slice().forEach((callback) => callback(0, { presentedFrames: 1 }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('remote-window-video-wallpaper').style.opacity).toBe('0');
      });
      expect((video as HTMLVideoElement).style.visibility).toBe('visible');
    } finally {
      playSpy.mockRestore();
      if (originalRequestVideoFrameCallback) {
        Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
          configurable: true,
          value: originalRequestVideoFrameCallback,
        });
      } else {
        delete videoPrototype.requestVideoFrameCallback;
      }
    }
  });

  it('does not expose the native video placeholder when WebView rejects play()', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.reject(new Error('autoplay blocked')));
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const onVideoDebug = vi.fn();

    try {
      render(
        <RemoteWindowOverlay
          activeSessionId="session-1"
          requestTargets={requestTargets}
          startStream={startStream}
          onVideoDebug={onVideoDebug}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
      fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
      const video = await screen.findByTestId('remote-window-video');
      fireEvent.canPlay(video);

      await waitFor(() => {
        expect(playSpy).toHaveBeenCalled();
      });
      expect(screen.getByTestId('remote-window-video-wallpaper')).toBeTruthy();
      expect((video as HTMLVideoElement).style.opacity).toBe('0');
      expect((video as HTMLVideoElement).style.visibility).toBe('visible');
      await waitFor(() => {
        expect(onVideoDebug).toHaveBeenCalledWith(expect.objectContaining({
          lastEvent: 'play-rejected',
          visible: false,
          playRejected: expect.any(Number),
        }));
      });
    } finally {
      playSpy.mockRestore();
    }
  });

  it('keeps a playing receiver visible across overlay state changes for the same media stream', async () => {
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve());
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    try {
      render(
        <RemoteWindowOverlay
          activeSessionId="session-1"
          requestTargets={requestTargets}
          startStream={startStream}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
      fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
      await screen.findByTestId('remote-window-video');
      await waitFor(() => {
        expect(screen.getByTestId('remote-window-video-wallpaper').style.opacity).toBe('0');
      });

      fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

      expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('fullscreen');
      expect(screen.getByTestId('remote-window-video-wallpaper').style.opacity).toBe('0');
    } finally {
      playSpy.mockRestore();
    }
  });

  it('caps fullscreen quality to low bitrate and 30fps when network information reports poor connectivity', async () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: {
        effectiveType: '2g',
        downlink: 0.4,
        rtt: 900,
        saveData: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const updateStreamQuality = createAppliedQualityMock();
    const capabilityStatus = createCapabilityStatusChannel();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateStreamQuality={updateStreamQuality}
        onRemoteWindowMessage={capabilityStatus.onRemoteWindowMessage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    capabilityStatus.publishCapabilityStatus(startStream.mock.calls[0]![2] as string);
    expect(startStream).toHaveBeenCalledWith('session-1', expect.objectContaining({
      streamTargetId: 'app-1',
    }), expect.stringMatching(/^rw-stream-/), {
      purpose: 'focus',
      videoProfile: {
        preference: 'smooth',
        maxBitrateBps: 1_000_000,
        maxFrameRateFps: 15,
        maxCaptureWidth: 720,
        maxCaptureHeight: 720,
        maxFrameAgeMs: 120,
        interactionActive: false,
        overviewMaxBitrateBps: 100_000,
        overviewMaxFrameRateFps: 1,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('fullscreen');
    await waitFor(() => expect(updateStreamQuality).toHaveBeenCalledTimes(1));
  });

  it('downgrades active stream quality from WebRTC stats without restarting the stream', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const collectStats = vi.fn(async () => ({
      sampledAtMs: 1_000,
      availableOutgoingBitrateBps: 250_000,
      rttMs: 500,
      framesPerSecond: 8,
      framesDropped: 10,
      freezeCount: 1,
      qualityLimitationReason: 'bandwidth',
    }));
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
      collectStats,
    }));
    const updateStreamQuality = createAppliedQualityMock();
    const capabilityStatus = createCapabilityStatusChannel();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateStreamQuality={updateStreamQuality}
        onRemoteWindowMessage={capabilityStatus.onRemoteWindowMessage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    capabilityStatus.publishCapabilityStatus(startStream.mock.calls[0]![2] as string);

    await waitFor(() => {
      expect(updateStreamQuality).toHaveBeenCalledWith('session-1', expect.objectContaining({
        videoProfile: expect.objectContaining({
          preference: 'smooth',
          maxBitrateBps: 2_000_000,
          maxFrameRateFps: 30,
          maxCaptureWidth: 720,
        }),
      }));
    }, { timeout: 5500 });
    expect(startStream).toHaveBeenCalledTimes(1);

    expect(startStream).toHaveBeenCalledTimes(1);
  });

  it('sizes the floating preview from the selected app window aspect ratio', async () => {
    const tallTarget = makeTarget('app-tall', 'WeChat', 'app-window');
    tallTarget.videoTarget.windowBoundsTopLeftPx = { x: 80, y: 90, width: 320, height: 640 };
    tallTarget.videoTarget.cropRectTopLeftPx = { x: 80, y: 90, width: 320, height: 640 };
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [tallTarget],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-tall');
    fireEvent.click(screen.getByTestId('remote-window-target-app-tall'));
    await screen.findByTestId('remote-window-video');

    const overlayStyle = screen.getByTestId('remote-window-locked-overlay').getAttribute('style') || '';
    const surfaceStyle = screen.getByTestId('remote-window-video-surface').getAttribute('style') || '';
    expect(overlayStyle).toContain('width: 64vw');
    expect(overlayStyle).toContain('max-width: 220px');
    expect(surfaceStyle).toContain('aspect-ratio: 320 / 640');
  });

  it('lifts the locked floating preview with the Android keyboard bottom inset', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        bottomInsetPx={320}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-locked-overlay').style.bottom).toBe('438px');
    });
  });

  it('lets the floating entry toggle the picker open and closed like the file button', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    const entry = screen.getByRole('button', { name: '打开远程窗口' });
    fireEvent.click(entry);

    await waitFor(() => {
      expect(requestTargets).toHaveBeenCalledWith('session-1');
      expect(screen.getByTestId('remote-window-picker')).toBeTruthy();
      // picker 打开时浮钮仍在（与文件按键一致），再点关闭
      expect(screen.getByRole('button', { name: '打开远程窗口' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    await waitFor(() => {
      expect(screen.queryByTestId('remote-window-picker')).toBeNull();
      expect(screen.getByRole('button', { name: '打开远程窗口' })).toBeTruthy();
    });
  });

  it('closes the picker from the floating entry while enumeration is still in flight', async () => {
    let resolveTargets: (payload: RemoteWindowStreamTargetsResponsePayload) => void = () => {};
    const requestTargets = vi.fn(() => new Promise<RemoteWindowStreamTargetsResponsePayload>((resolve) => {
      resolveTargets = resolve;
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    const entry = screen.getByRole('button', { name: '打开远程窗口' });
    fireEvent.click(entry);

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-picker-loading')).toBeTruthy();
    });

    // 枚举尚未返回时再点浮钮关闭（与文件按键一致：直接关闭）
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    await waitFor(() => {
      expect(screen.queryByTestId('remote-window-picker')).toBeNull();
    });

    // 迟到的枚举结果不得复活 picker
    await act(async () => {
      resolveTargets({
        requestId: 'rw-1',
        targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
      });
    });
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
  });

  it('moves the floating entry when dragged with mouse like the file bubble without opening the picker', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    const entry = screen.getByRole('button', { name: '打开远程窗口' });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(entry, 'setPointerCapture', { value: setPointerCapture, configurable: true });
    Object.defineProperty(entry, 'releasePointerCapture', { value: releasePointerCapture, configurable: true });
    Object.defineProperty(entry, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 330,
        y: 720,
        left: 330,
        top: 720,
        right: 374,
        bottom: 764,
        width: 44,
        height: 44,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(entry, { pointerId: 9, pointerType: 'mouse', clientX: 352, clientY: 742, button: 0 });
    fireEvent.pointerMove(entry, { pointerId: 9, pointerType: 'mouse', clientX: 280, clientY: 640, button: 0 });
    fireEvent.pointerUp(entry, { pointerId: 9, pointerType: 'mouse', clientX: 280, clientY: 640, button: 0 });
    fireEvent.click(entry);

    expect(requestTargets).not.toHaveBeenCalled();
    expect(entry.getAttribute('style') || '').toContain('left: 258px; top: 618px');
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
    expect(setPointerCapture).toHaveBeenCalledWith(9);
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
  });

  it('moves the floating entry when dragged with touch like the file bubble without opening the picker', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    const entry = screen.getByRole('button', { name: '打开远程窗口' });
    Object.defineProperty(entry, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 330,
        y: 720,
        left: 330,
        top: 720,
        right: 374,
        bottom: 764,
        width: 44,
        height: 44,
        toJSON: () => ({}),
      }),
    });

    fireEvent.touchStart(entry, { touches: [{ clientX: 352, clientY: 742 }] });
    fireEvent.touchMove(entry, { touches: [{ clientX: 280, clientY: 640 }] });
    fireEvent.touchEnd(entry);
    fireEvent.click(entry);

    expect(requestTargets).not.toHaveBeenCalled();
    expect(entry.getAttribute('style') || '').toContain('left: 258px; top: 618px');
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
  });

  it('keeps the floating entry position stable across repeated drags without drift', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    const entry = screen.getByRole('button', { name: '打开远程窗口' });
    const baseRect = { x: 330, y: 720, left: 330, top: 720, right: 374, bottom: 764, width: 44, height: 44, toJSON: () => ({}) };
    Object.defineProperty(entry, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        // 第二次拖动时元素已用 left/top 定位，rect 应反映当前位置（关键防漂移点）
        const style = entry.getAttribute('style') || '';
        const leftMatch = /left: (\d+)px/.exec(style);
        const topMatch = /top: (\d+)px/.exec(style);
        if (leftMatch && topMatch) {
          const left = Number(leftMatch[1]);
          const top = Number(topMatch[1]);
          return { ...baseRect, x: left, y: top, left, top, right: left + 44, bottom: top + 44 };
        }
        return baseRect;
      },
    });

    // 第一次拖：330,720 -> 258,618
    fireEvent.touchStart(entry, { touches: [{ clientX: 352, clientY: 742 }] });
    fireEvent.touchMove(entry, { touches: [{ clientX: 280, clientY: 640 }] });
    fireEvent.touchEnd(entry);
    expect(entry.getAttribute('style') || '').toContain('left: 258px; top: 618px');

    // 第二次拖：从当前 258,618 位置继续拖 (-80,-140) -> 178,478，不得跳回原始位置
    fireEvent.touchStart(entry, { touches: [{ clientX: 280, clientY: 640 }] });
    fireEvent.touchMove(entry, { touches: [{ clientX: 200, clientY: 500 }] });
    fireEvent.touchEnd(entry);
    expect(entry.getAttribute('style') || '').toContain('left: 178px; top: 478px');
    expect(requestTargets).not.toHaveBeenCalled();
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
  });

  it('surfaces stream setup failure without rendering fake video', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));
    const startStream = vi.fn(async () => {
      throw new Error('ScreenCaptureKit capture start failure');
    });

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-stream-error').textContent).toContain('ScreenCaptureKit capture start failure');
    });
    expect(screen.queryByTestId('remote-window-video')).toBeNull();
  });

  it('surfaces missing active session as an explicit picker error', async () => {
    render(<RemoteWindowOverlay activeSessionId={null} requestTargets={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-picker-error').textContent).toContain('当前没有可用的 daemon session');
    });
  });

  it('reports quickbar suppression only for picker and body suppression for fullscreen', async () => {
    const onOpenStateChange = vi.fn();
    const onBodySubscriptionSuppressedChange = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        onOpenStateChange={onOpenStateChange}
        onBodySubscriptionSuppressedChange={onBodySubscriptionSuppressedChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    expect(onOpenStateChange).toHaveBeenCalledWith(true);
    expect(onBodySubscriptionSuppressedChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));
    await waitFor(() => {
      expect(onOpenStateChange).toHaveBeenLastCalledWith(false);
      expect(onBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    await waitFor(() => {
      expect(onOpenStateChange).toHaveBeenLastCalledWith(false);
      expect(onBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(true);
    });
    fireEvent.click(screen.getByRole('button', { name: '缩小远程窗口' }));
    await waitFor(() => {
      expect(onOpenStateChange).toHaveBeenLastCalledWith(false);
      expect(onBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));

    await waitFor(() => {
      expect(onOpenStateChange).toHaveBeenLastCalledWith(false);
      expect(onBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('publishes and clears the active remote-window input context for the selected stream', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const onInputContextChange = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        onInputContextChange={onInputContextChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));

    await waitFor(() => {
      expect(onInputContextChange).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        targetId: 'app-1',
        targetKind: 'app-window',
        inputTargetKind: 'app-window',
        inputRoute: 'os-event',
        focusPolicy: 'bring-to-focus',
        streamId: expect.stringMatching(/^rw-stream-/),
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    await waitFor(() => {
      expect(onInputContextChange).toHaveBeenLastCalledWith(null);
    });
  });

  it('does not focus on stream setup and sends later wheel or key input as single action events', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '缩小远程窗口' }));
    expect(sendInput).not.toHaveBeenCalled();

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    sendInput.mockClear();
    fireEvent.wheel(surface, { clientX: 100, clientY: 50, deltaX: 0, deltaY: 64 });
    expect(remoteInputPayloads(sendInput).map((payload) => payload.event.kind)).toEqual([
      'scroll',
    ]);

    sendInput.mockClear();
    fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' });
    expect(remoteInputPayloads(sendInput).map((payload) => payload.event.kind)).toEqual([
      'key',
    ]);
  });

  it('captures a selected remote-window screenshot without focusing the desktop app', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    let resolveScreenshot: ((result: { fileName: string; savedPath: string }) => void) | null = null;
    const requestScreenshot = vi.fn(() => new Promise<{ fileName: string; savedPath: string }>((resolve) => {
      resolveScreenshot = resolve;
    }));
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
        requestScreenshot={requestScreenshot}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '截屏远程窗口' }));

    expect(screen.getByTestId('remote-window-screenshot-status').getAttribute('data-phase')).toBe('capturing');
    expect(screen.getByTestId('remote-window-screenshot-status').textContent).toContain('远程原始截屏中');
    expect(screen.getByTestId('remote-window-screenshot-spinner')).toBeTruthy();
    expect(screen.getByRole('button', { name: '截屏远程窗口' }).getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveScreenshot?.({
        fileName: 'remote-window-TextEdit.png',
        savedPath: '/storage/emulated/0/Download/zterm/remote-window-TextEdit.png',
      });
    });

    await waitFor(() => {
      expect(requestScreenshot).toHaveBeenCalledWith('session-1', expect.objectContaining({
        streamTargetId: 'app-1',
      }), { persist: true });
      expect(screen.getByTestId('remote-window-screenshot-status').getAttribute('data-phase')).toBe('saved');
      expect(screen.getByTestId('remote-window-screenshot-status').textContent).toContain('原始截图已保存');
    });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('marks iTerm pane streams as read-only and does not emit unsupported input', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const onInputContextChange = vi.fn();
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
        onInputContextChange={onInputContextChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));
    await screen.findByTestId('remote-window-video');

    expect(screen.getByTestId('remote-window-input-mode').textContent).toContain('只读');

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, { pointerId: 17, pointerType: 'touch', clientX: 100, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 17, pointerType: 'touch', clientX: 100, clientY: 50, button: 0, buttons: 0 });
    fireEvent.wheel(surface, { clientX: 100, clientY: 50, deltaX: 0, deltaY: 64 });
    fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' });
    fireEvent.keyUp(surface, { key: 'a', code: 'KeyA' });

    expect(sendInput).not.toHaveBeenCalled();
    expect(onInputContextChange.mock.calls.some(([context]) => context?.targetId === 'pane-1')).toBe(false);
  });

  it('moves the floating overlay from the toolbar without entering fullscreen', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const toolbar = screen.getByTestId('remote-window-drag-handle');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      value: () => ({
        x: 600,
        y: 420,
        left: 600,
        top: 420,
        right: 960,
        bottom: 645,
        width: 360,
        height: 225,
        toJSON: () => ({}),
      }),
    });

    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(toolbar, 'setPointerCapture', { value: setPointerCapture, configurable: true });
    Object.defineProperty(toolbar, 'releasePointerCapture', { value: releasePointerCapture, configurable: true });

    fireEvent.pointerDown(toolbar, { pointerId: 1, clientX: 700, clientY: 440 });
    fireEvent.pointerMove(toolbar, { pointerId: 1, clientX: 620, clientY: 380 });
    fireEvent.pointerUp(toolbar, { pointerId: 1, clientX: 620, clientY: 380 });

    expect(overlay.style.transform).toBe('translate(-80px, -60px)');
    expect(overlay.getAttribute('data-mode')).toBe('floating');
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('keeps primary controls structurally valid with 48px touch targets and no child close action', async () => {
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow = {
      ...makeTarget('app-child', 'WeChat Image', 'app-window'),
      videoTarget: { ...mainWindow.videoTarget, windowId: 'window-2', title: 'WeChat Image' },
    };
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-controls', targets: [mainWindow, childWindow] }));

    render(<RemoteWindowOverlay activeSessionId="session-controls" requestTargets={requestTargets} />);
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-app-group-com-apple-TextEdit-123'));

    const controls = [
      ...screen.getByTestId('remote-window-primary-actions').querySelectorAll('button'),
      ...screen.getByTestId('remote-window-control-strip').querySelectorAll('button'),
      screen.getByTestId('remote-window-active-app-switch-button'),
    ] as HTMLElement[];
    for (const control of controls) {
      expect(Number.parseFloat(control.style.width || control.style.minWidth)).toBeGreaterThanOrEqual(48);
      expect(Number.parseFloat(control.style.height || control.style.minHeight)).toBeGreaterThanOrEqual(48);
      expect(control.querySelector('button')).toBeNull();
    }
    expect(screen.queryByLabelText('关闭子窗口')).toBeNull();
  });

  it('remotely closes the locked host window without using the local overlay close action', async () => {
    const sendInput = vi.fn();
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream: { id: 'remote-close-stream' } as MediaStream,
    }));
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-remote-close',
      targets: [makeTarget('app-remote-close', 'TextEdit', 'app-window')],
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-remote-close"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-remote-close');
    fireEvent.click(screen.getByTestId('remote-window-target-app-remote-close'));
    await screen.findByTestId('remote-window-video');

    fireEvent.click(screen.getByTestId('remote-window-remote-close'));

    await waitForActionRemoteInputCount(sendInput, 1);
    expect(actionRemoteInputPayloads(sendInput)[0]).toMatchObject({
      streamId: expect.stringMatching(/^rw-stream-/),
      targetId: 'app-remote-close',
      event: { kind: 'close-window' },
    });
    expect(screen.queryByTestId('remote-window-locked-overlay')).toBeNull();
  });

  it('resizes the floating overlay from the edge while preserving the source aspect ratio', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const surface = screen.getByTestId('remote-window-video-surface');
    const resizeHandle = screen.getByTestId('remote-window-resize-handle');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 600,
        y: 420,
        left: 600,
        top: 420,
        right: 960,
        bottom: 714,
        width: 360,
        height: 294,
        toJSON: () => ({}),
      }),
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(resizeHandle, 'setPointerCapture', { value: setPointerCapture, configurable: true });
    Object.defineProperty(resizeHandle, 'releasePointerCapture', { value: releasePointerCapture, configurable: true });

    fireEvent.pointerDown(resizeHandle, { pointerId: 8, pointerType: 'touch', clientX: 600, clientY: 560, button: 0 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 8, pointerType: 'touch', clientX: 540, clientY: 560, button: 0 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 8, pointerType: 'touch', clientX: 540, clientY: 560, button: 0 });

    expect(overlay.style.width).toBe('420px');
    expect(overlay.style.transform).toBe('translate(0px, 0px)');
    expect(surface.style.aspectRatio).toBe('800 / 560');
    expect(surface.style.height).toBe('294px');
    expect(setPointerCapture).toHaveBeenCalledWith(8);
    expect(releasePointerCapture).toHaveBeenCalledWith(8);

    const toolbar = screen.getByTestId('remote-window-drag-handle');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 540,
        y: 420,
        left: 540,
        top: 420,
        right: 960,
        bottom: 756,
        width: 420,
        height: 336,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(toolbar, { pointerId: 9, clientX: 700, clientY: 440 });
    fireEvent.pointerMove(toolbar, { pointerId: 9, clientX: 660, clientY: 410 });
    fireEvent.pointerUp(toolbar, { pointerId: 9, clientX: 660, clientY: 410 });

    expect(overlay.style.transform).toBe('translate(-40px, -30px)');
  });

  it('resizes the floating overlay from the right-bottom corner while keeping the left edge stable', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const surface = screen.getByTestId('remote-window-video-surface');
    const resizeHandle = screen.getByTestId('remote-window-resize-handle-right');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 540,
        y: 420,
        left: 540,
        top: 420,
        right: 900,
        bottom: 714,
        width: 360,
        height: 294,
        toJSON: () => ({}),
      }),
    });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperty(resizeHandle, 'setPointerCapture', { value: setPointerCapture, configurable: true });
    Object.defineProperty(resizeHandle, 'releasePointerCapture', { value: releasePointerCapture, configurable: true });

    fireEvent.pointerDown(resizeHandle, { pointerId: 18, pointerType: 'touch', clientX: 900, clientY: 714, button: 0 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 18, pointerType: 'touch', clientX: 960, clientY: 714, button: 0 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 18, pointerType: 'touch', clientX: 960, clientY: 714, button: 0 });

    expect(overlay.style.width).toBe('420px');
    expect(overlay.style.transform).toBe('translate(60px, 0px)');
    expect(surface.style.aspectRatio).toBe('800 / 560');
    expect(surface.style.height).toBe('294px');
    expect(setPointerCapture).toHaveBeenCalledWith(18);
    expect(releasePointerCapture).toHaveBeenCalledWith(18);
  });

  it('caps floating resize so the toolbar remains reachable after enlargement', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const toolbar = screen.getByTestId('remote-window-drag-handle');
    const resizeHandle = screen.getByTestId('remote-window-resize-handle-right');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 540,
        y: 20,
        left: 540,
        top: 20,
        right: 960,
        bottom: 356,
        width: 420,
        height: 336,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(resizeHandle, { pointerId: 28, pointerType: 'touch', clientX: 960, clientY: 356, button: 0 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 28, pointerType: 'touch', clientX: 1100, clientY: 356, button: 0 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 28, pointerType: 'touch', clientX: 1100, clientY: 356, button: 0 });

    expect(Number.parseFloat(overlay.style.width)).toBeLessThanOrEqual(426);

    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 546,
        y: 8,
        left: 546,
        top: 8,
        right: 972,
        bottom: 356,
        width: 426,
        height: 348,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(toolbar, { pointerId: 29, clientX: 700, clientY: 24 });
    fireEvent.pointerMove(toolbar, { pointerId: 29, clientX: 700, clientY: 44 });
    fireEvent.pointerUp(toolbar, { pointerId: 29, clientX: 700, clientY: 44 });

    expect(overlay.style.transform).toBe('translate(6px, 68px)');
  });

  it('does not move the overlay from toolbar pointer gestures in fullscreen', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await expandItermPaneGroup();
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const toolbar = screen.getByTestId('remote-window-drag-handle');
    fireEvent.pointerDown(toolbar, { pointerId: 2, clientX: 300, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 100, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 100, clientY: 120 });

    expect(overlay.getAttribute('data-mode')).toBe('fullscreen');
    expect(overlay.style.transform).toBe('');
  });

  it('maps video surface pointer input to selected remote window coordinates', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, { pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 7, pointerType: 'touch', clientX: 100, clientY: 50, button: 0, buttons: 0 });

    await waitForActionRemoteInputCount(sendInput, 1);
    expectNoRemoteInputFocus(sendInput);
    expectEveryRemoteInputIsActionOnly(sendInput);
    expect(remoteInputPayloads(sendInput).map((payload) => payload.event.kind)).toEqual([
      'click',
    ]);
    const inputPayloads = actionRemoteInputPayloads(sendInput);
    expect(inputPayloads).toHaveLength(1);
    expect(sendInput.mock.calls[0][0]).toBe('session-1');
    expect(inputPayloads[0]).toMatchObject({
      streamId: expect.stringMatching(/^rw-stream-/),
      targetId: 'app-1',
      event: {
        kind: 'click',
        pointerId: 7,
        button: 'left',
        normalizedX: 0.5,
        normalizedY: 0.5,
        x: 410,
        y: 320,
      },
    });
  });

  it('maps a touch drag on the video surface to realtime remote scroll', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, { pointerId: 21, pointerType: 'touch', clientX: 100, clientY: 70, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 21, pointerType: 'touch', clientX: 100, clientY: 40, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 21, pointerType: 'touch', clientX: 100, clientY: 40, button: 0, buttons: 0 });
    await waitForActionRemoteInputCount(sendInput, 1);
    expectEveryRemoteInputIsActionOnly(sendInput);
    const dragEvent = remoteInputPayloads(sendInput)[0]?.event;
    expect(dragEvent?.kind).toBe('scroll');

    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
        unit: 'pixel',
        normalizedX: expect.any(Number),
        normalizedY: expect.any(Number),
      }),
    ]);
  });

  it('marks the active stream failed when the daemon reports that the stream is missing', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const props = {
      activeSessionId: 'session-1',
      requestTargets,
      startStream,
    };
    const { rerender } = render(
      <RemoteWindowOverlay
        {...props}
        streamInvalidation={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(1);
    });
    const streamId = startStream.mock.calls[0]?.[2] || '';
    expect(streamId).toEqual(expect.stringMatching(/^rw-stream-/));

    rerender(
      <RemoteWindowOverlay
        {...props}
        streamInvalidation={{
          streamId,
          message: 'remote window stream is not active',
          nonce: 1,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-stream-error').textContent).toContain('remote window stream is not active');
    });
    expect(screen.queryByTestId('remote-window-video')).toBeNull();
  });

  it('maps an unzoomed touch drag to realtime scroll without release replay', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, { pointerId: 22, pointerType: 'touch', clientX: 120, clientY: 80, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 22, pointerType: 'touch', clientX: 120, clientY: 64, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 22, pointerType: 'touch', clientX: 120, clientY: 52, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 22, pointerType: 'touch', clientX: 120, clientY: 40, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 22, pointerType: 'touch', clientX: 120, clientY: 40, button: 0, buttons: 0 });
    await waitForActionRemoteInputCount(sendInput, 3);
    expectEveryRemoteInputIsActionOnly(sendInput);
    const events = actionRemoteInputPayloads(sendInput).map((payload) => payload.event);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.kind === 'scroll')).toBe(true);
  });

  it('keeps move-phase scroll valid and emits no delayed release replay', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    fireEvent.pointerDown(surface, { pointerId: 23, pointerType: 'touch', clientX: 120, clientY: 80, button: 0, buttons: 1 });
    vi.advanceTimersByTime(20);
    fireEvent.pointerMove(surface, { pointerId: 23, pointerType: 'touch', clientX: 120, clientY: 40, button: 0, buttons: 1 });
    expect(sendInput).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_001);
    fireEvent.pointerUp(surface, { pointerId: 23, pointerType: 'touch', clientX: 120, clientY: 40, button: 0, buttons: 0 });

    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('sizes the receiver projection from daemon capture frame aspect after stream start', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 800, height: 600 };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
      started: makeStartedPayload(streamId, target.streamTargetId, 640, 360),
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));

    await screen.findByTestId('remote-window-video');
    const surface = screen.getByTestId('remote-window-video-surface');
    await waitFor(() => {
      expect(surface.style.aspectRatio).toBe('640 / 360');
    });
  });

  it('sends unzoomed fullscreen touch drag as realtime scroll even when the IME inset is present', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
        bottomInsetPx={280}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 500,
        width: 300,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await flushRemoteWindowSurfaceLayout();
    const content = screen.getByTestId('remote-window-video-content');
    const topBeforeScroll = Number.parseFloat(content.style.top || '0');

    fireEvent.pointerDown(surface, { pointerId: 52, pointerType: 'touch', clientX: 120, clientY: 300, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 52, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 52, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 0 });

    await waitForActionRemoteInputCount(sendInput, 1);
    expectNoRemoteInputFocus(sendInput);
    expectEveryRemoteInputIsActionOnly(sendInput);
    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
      }),
    ]);
    expect(topBeforeScroll).toEqual(expect.any(Number));
  });

  it('keeps fullscreen video surface interactive for remote input at scale one', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 280,
        bottom: 140,
        width: 280,
        height: 140,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, { pointerId: 11, pointerType: 'touch', clientX: 140, clientY: 70, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 11, pointerType: 'touch', clientX: 140, clientY: 70, button: 0, buttons: 0 });

    await waitForActionRemoteInputCount(sendInput, 1);
    expectNoRemoteInputFocus(sendInput);
    expectEveryRemoteInputIsActionOnly(sendInput);
    const inputPayloads = actionRemoteInputPayloads(sendInput);
    expect(inputPayloads).toHaveLength(1);
    expect(inputPayloads[0]).toMatchObject({
      targetId: 'app-1',
      event: {
        kind: 'click',
        pointerId: 11,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    });
  });

  it('keeps fullscreen display geometry local to the projection surface', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390, height: 844, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 800, height: 600 };
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const toolbar = screen.getByTestId('remote-window-locked-toolbar');
    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 390,
        bottom: 844,
        width: 390,
        height: 844,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(toolbar, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 16,
        left: 0,
        top: 16,
        right: 390,
        bottom: 124,
        width: 390,
        height: 108,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const content = screen.getByTestId('remote-window-video-content');
    await waitFor(() => {
      expect(overlay.getAttribute('data-display-mode')).toBe('fill');
      expect(Number.parseFloat(content.style.left)).toBeCloseTo(0, 1);
      expect(Number.parseFloat(content.style.top)).toBeCloseTo(-12.5, 1);
      expect(Number.parseFloat(content.style.width)).toBeCloseTo(300, 1);
      expect(Number.parseFloat(content.style.height)).toBeCloseTo(225, 1);
    });

    await waitFor(() => {
      expect(Number.parseFloat(content.style.left)).toBeCloseTo(0, 1);
      expect(Number.parseFloat(content.style.top)).toBeCloseTo(-12.5, 1);
      expect(Number.parseFloat(content.style.width)).toBeCloseTo(300, 1);
      expect(Number.parseFloat(content.style.height)).toBeCloseTo(225, 1);
    });
    expect(overlay.getAttribute('data-display-mode')).toBe('fill');
    fireEvent.click(screen.getByTestId('remote-window-more-toggle'));
    expect(screen.getByTestId('remote-window-fullscreen-display-toggle')).toBeTruthy();
  });

  it('requests a unified 1080p short-edge remote window resize on entry and on fill', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390, height: 844, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 800, height: 600 };
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const resizeTargetWindow = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        resizeTargetWindow={resizeTargetWindow}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const toolbar = screen.getByTestId('remote-window-locked-toolbar');
    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 390,
        bottom: 844,
        width: 390,
        height: 844,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(toolbar, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 16,
        left: 0,
        top: 16,
        right: 390,
        bottom: 124,
        width: 390,
        height: 108,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    await waitFor(() => {
      expect(resizeTargetWindow).toHaveBeenCalledTimes(1);
    });
    const first = resizeTargetWindow.mock.calls[0]?.[1];
    expect(first).toMatchObject({
      streamId: expect.any(String),
      targetId: 'app-1',
      event: {
        kind: 'window-resize',
        width: 1080,
        height: 2337,
      },
    });

    fireEvent.click(screen.getByTestId('remote-window-more-toggle'));
    fireEvent.click(screen.getByTestId('remote-window-fullscreen-display-toggle'));
    await waitFor(() => {
      expect(resizeTargetWindow).toHaveBeenCalledTimes(2);
    });
  });

  it('requests the same 1080p short-edge resize while embedded preview is active', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390, height: 844, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const resizeTargetWindow = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        embedded
        requestTargets={requestTargets}
        startStream={startStream}
        resizeTargetWindow={resizeTargetWindow}
      />,
    );

    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    await waitFor(() => {
      expect(resizeTargetWindow).toHaveBeenCalledTimes(1);
    });
    expect(resizeTargetWindow).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        event: {
          kind: 'window-resize',
          width: 1080,
          height: 2337,
        },
      }),
    );
  });

  it('fills the embedded preview surface with the largest projected content rect', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 390, height: 844, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        embedded
        requestTargets={requestTargets}
        startStream={startStream}
      />,
    );

    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    const content = screen.getByTestId('remote-window-video-content');
    await waitFor(() => {
      expect(Number.parseFloat(content.style.left)).toBeCloseTo(0, 1);
      expect(Number.parseFloat(content.style.width)).toBeCloseTo(300, 1);
      expect(Number.parseFloat(content.style.top)).toBeCloseTo(-5, 1);
      expect(Number.parseFloat(content.style.height)).toBeCloseTo(210, 1);
    });
  });

  it('keeps a resize ACK target in the cached picker catalog after the stream closes', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    const resizedTarget: RemoteWindowStreamTargetManifest = {
      ...target,
      videoTarget: {
        ...target.videoTarget,
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 1000 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 1000 },
      },
    };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    let remoteWindowMessageHandler: ((msg: any) => void) | null = null;
    const onRemoteWindowMessage = vi.fn((handler: (msg: any) => void) => {
      remoteWindowMessageHandler = handler;
      return () => {
        if (remoteWindowMessageHandler === handler) {
          remoteWindowMessageHandler = null;
        }
      };
    });

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        onRemoteWindowMessage={onRemoteWindowMessage}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(1);
    });
    const streamId = startStream.mock.calls[0]?.[2] || '';

    act(() => {
      remoteWindowMessageHandler?.({
        type: 'remote-window-input-ack',
        control: {
          version: 1,
          sequence: 'rw-resize-ack',
          accepted: true,
          retryable: false,
          duplicate: false,
          receivedAtMs: 1,
        },
        payload: {
          streamId,
          targetId: 'app-1',
          target: resizedTarget,
          capture: {
            source: 'ScreenCaptureKit',
            frameWidth: 800,
            frameHeight: 1000,
            frameRate: 30,
            targetKind: 'app-window',
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-video-surface').style.aspectRatio).toBe('800 / 1000');
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    expect(screen.queryByTestId('remote-window-picker-loading')).toBeNull();
    expect(screen.getByTestId('remote-window-target-app-1').textContent).toContain('800x1000');
  });

  it('maps fullscreen input through the same fill content rect after a target resize request', async () => {
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 800, height: 600 };
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    fireEvent.click(screen.getByTestId('remote-window-more-toggle'));
    fireEvent.click(screen.getByTestId('remote-window-fullscreen-display-toggle'));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 150,
      clientY: 0,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerUp(surface, {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 150,
      clientY: 0,
      button: 0,
      buttons: 0,
    });

    await waitForActionRemoteInputCount(sendInput, 1);
    expectNoRemoteInputFocus(sendInput);
    const event = actionRemoteInputPayloads(sendInput)[0].event;
    expect(event.kind).toBe('click');
    if (event.kind !== 'click') {
      throw new Error('expected click payload');
    }
    expect(event.normalizedX).toBeCloseTo(0.5, 3);
    expect(event.normalizedY).toBeCloseTo(1 / 18, 3);
    expect(event.x).toBeCloseTo(410, 3);
    expect(event.y).toBeCloseTo(73.33, 1);
  });

  it('supports fullscreen pinch zoom, zoomed single-finger pan, and two-finger scroll', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const fullscreenOverlayStyle = screen.getByTestId('remote-window-locked-overlay').getAttribute('style') || '';
    expect(fullscreenOverlayStyle).toContain('padding-top:');
    expect(fullscreenOverlayStyle).toContain('safe-area-inset-top');

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'touch', clientX: 70, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 100, button: 0, buttons: 1 });
    const content = screen.getByTestId('remote-window-video-content');
    const fitWidth = Math.min(300 / 800, 200 / 560) * 800;
    await waitFor(() => {
      expect(Number.parseFloat(content.style.width || '0')).toBeGreaterThan(fitWidth);
    });
    const leftAfterPinch = Number.parseFloat(content.style.left || '0');

    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'touch', clientX: 70, clientY: 100, button: 0, buttons: 0 });
    fireEvent.pointerMove(surface, { pointerId: 2, pointerType: 'touch', clientX: 230, clientY: 120, button: 0, buttons: 1 });
    await waitFor(() => {
      expect(Number.parseFloat(content.style.left || '0')).not.toBe(leftAfterPinch);
    });
    sendInput.mockClear();
    fireEvent.pointerUp(surface, { pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 100, button: 0, buttons: 0 });
    fireEvent.pointerDown(surface, { pointerId: 5, pointerType: 'touch', clientX: 150, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 5, pointerType: 'touch', clientX: 150, clientY: 100, button: 0, buttons: 0 });
    await waitForActionRemoteInputCount(sendInput, 1);
    expectEveryRemoteInputIsActionOnly(sendInput);
    expect(actionRemoteInputPayloads(sendInput)[0].event).toEqual(expect.objectContaining({
      kind: 'click',
      pointerId: 5,
    }));
    sendInput.mockClear();

    fireEvent.pointerDown(surface, { pointerId: 3, pointerType: 'touch', clientX: 100, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 4, pointerType: 'touch', clientX: 150, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 3, pointerType: 'touch', clientX: 120, clientY: 110, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 4, pointerType: 'touch', clientX: 170, clientY: 110, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 3, pointerType: 'touch', clientX: 135, clientY: 125, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 4, pointerType: 'touch', clientX: 185, clientY: 125, button: 0, buttons: 1 });

    await waitFor(() => {
      expect(Number.parseFloat(content.style.width || '0')).toBeGreaterThanOrEqual(fitWidth);
    });
    expect(screen.queryByTestId('remote-window-minimap')).toBeNull();
    expect(actionRemoteInputPayloads(sendInput).some((payload) => payload.event.kind === 'scroll')).toBe(true);
  });

  it('routes floating two-finger vertical movement to realtime remote scroll actions without entering fullscreen', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, { pointerId: 51, pointerType: 'touch', clientX: 110, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 52, pointerType: 'touch', clientX: 190, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 51, pointerType: 'touch', clientX: 110, clientY: 90, button: 0, buttons: 1 });
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerMove(surface, { pointerId: 52, pointerType: 'touch', clientX: 190, clientY: 90, button: 0, buttons: 1 });
    await waitForActionRemoteInputCount(sendInput, 1);
    fireEvent.pointerMove(surface, { pointerId: 51, pointerType: 'touch', clientX: 110, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 52, pointerType: 'touch', clientX: 190, clientY: 50, button: 0, buttons: 1 });
    await waitForActionRemoteInputCount(sendInput, 3);
    fireEvent.pointerUp(surface, { pointerId: 51, pointerType: 'touch', clientX: 110, clientY: 50, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 52, pointerType: 'touch', clientX: 190, clientY: 50, button: 0, buttons: 0 });
    await waitForActionRemoteInputCount(sendInput, 3);
    expectEveryRemoteInputIsActionOnly(sendInput);
    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('floating');
    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 56,
      }),
      expect.objectContaining({
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 56,
      }),
      expect.objectContaining({
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 56,
      }),
    ]);
  });

  it('keeps nearly parallel two-finger vertical movement as scroll instead of pinch zoom', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    fireEvent.pointerDown(surface, { pointerId: 53, pointerType: 'touch', clientX: 110, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 54, pointerType: 'touch', clientX: 190, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 53, pointerType: 'touch', clientX: 105, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 54, pointerType: 'touch', clientX: 195, clientY: 90, button: 0, buttons: 1 });
    await waitForActionRemoteInputCount(sendInput, 1);
    fireEvent.pointerUp(surface, { pointerId: 53, pointerType: 'touch', clientX: 105, clientY: 90, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 54, pointerType: 'touch', clientX: 195, clientY: 90, button: 0, buttons: 0 });
    await waitForActionRemoteInputCount(sendInput, 1);
    expectEveryRemoteInputIsActionOnly(sendInput);
    expect(screen.queryByTestId('remote-window-minimap')).toBeNull();
    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 56,
      }),
    ]);
  });

  it('keeps vertical two-finger movement as scroll when distance changes but pinch axis intent is not clear', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    fireEvent.pointerDown(surface, { pointerId: 71, pointerType: 'touch', clientX: 110, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 72, pointerType: 'touch', clientX: 190, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 71, pointerType: 'touch', clientX: 140, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 72, pointerType: 'touch', clientX: 220, clientY: 90, button: 0, buttons: 1 });
    await waitForActionRemoteInputCount(sendInput, 1);
    fireEvent.pointerUp(surface, { pointerId: 71, pointerType: 'touch', clientX: 140, clientY: 90, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 72, pointerType: 'touch', clientX: 220, clientY: 90, button: 0, buttons: 0 });
    await waitForActionRemoteInputCount(sendInput, 1);
    expectEveryRemoteInputIsActionOnly(sendInput);
    expect(screen.queryByTestId('remote-window-minimap')).toBeNull();
    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
        unit: 'pixel',
        deltaX: 0,
        deltaY: 56,
      }),
    ]);
  });

  it('treats clear opposite-axis fullscreen pinch with vertical drift as zoom instead of scroll', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    const content = screen.getByTestId('remote-window-video-content');
    const widthBeforePinch = Number.parseFloat(content.style.width || '0');
    fireEvent.pointerDown(surface, { pointerId: 91, pointerType: 'touch', clientX: 110, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 92, pointerType: 'touch', clientX: 190, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 91, pointerType: 'touch', clientX: 80, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 92, pointerType: 'touch', clientX: 220, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 91, pointerType: 'touch', clientX: 80, clientY: 90, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 92, pointerType: 'touch', clientX: 220, clientY: 90, button: 0, buttons: 0 });

    await waitFor(() => {
      expect(Number.parseFloat(content.style.width || '0')).toBeGreaterThan(widthBeforePinch);
    });
    const widthAfterFirstPinch = Number.parseFloat(content.style.width || '0');

    fireEvent.pointerDown(surface, { pointerId: 93, pointerType: 'touch', clientX: 110, clientY: 120, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 94, pointerType: 'touch', clientX: 190, clientY: 120, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 93, pointerType: 'touch', clientX: 80, clientY: 120, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 94, pointerType: 'touch', clientX: 220, clientY: 120, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 93, pointerType: 'touch', clientX: 100, clientY: 120, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 94, pointerType: 'touch', clientX: 200, clientY: 120, button: 0, buttons: 0 });

    await waitFor(() => {
      expect(Number.parseFloat(content.style.width || '0')).toBeGreaterThan(widthAfterFirstPinch);
    });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('lets an active two-finger scroll become pinch zoom only after clear distance change', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    fireEvent.pointerDown(surface, { pointerId: 81, pointerType: 'touch', clientX: 110, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 82, pointerType: 'touch', clientX: 190, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 81, pointerType: 'touch', clientX: 110, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 82, pointerType: 'touch', clientX: 190, clientY: 90, button: 0, buttons: 1 });
    await waitForActionRemoteInputCount(sendInput, 1);
    sendInput.mockClear();

    fireEvent.pointerMove(surface, { pointerId: 81, pointerType: 'touch', clientX: 70, clientY: 90, button: 0, buttons: 1 });
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerMove(surface, { pointerId: 82, pointerType: 'touch', clientX: 230, clientY: 90, button: 0, buttons: 1 });

    expect(screen.queryByTestId('remote-window-minimap')).toBeNull();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('routes zoomed fullscreen two-finger vertical movement to remote scroll', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
        width: 300,
        height: 200,
        toJSON: () => ({}),
      }),
    });
    await flushRemoteWindowSurfaceLayout();

    fireEvent.pointerDown(surface, { pointerId: 61, pointerType: 'touch', clientX: 100, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 62, pointerType: 'touch', clientX: 200, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 61, pointerType: 'touch', clientX: 70, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 62, pointerType: 'touch', clientX: 260, clientY: 100, button: 0, buttons: 1 });
    expect(screen.queryByTestId('remote-window-minimap')).toBeNull();
    fireEvent.pointerUp(surface, { pointerId: 61, pointerType: 'touch', clientX: 70, clientY: 100, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 62, pointerType: 'touch', clientX: 260, clientY: 100, button: 0, buttons: 0 });

    sendInput.mockClear();

    fireEvent.pointerDown(surface, { pointerId: 63, pointerType: 'touch', clientX: 110, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 64, pointerType: 'touch', clientX: 190, clientY: 130, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 63, pointerType: 'touch', clientX: 110, clientY: 90, button: 0, buttons: 1 });
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerMove(surface, { pointerId: 64, pointerType: 'touch', clientX: 190, clientY: 90, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 63, pointerType: 'touch', clientX: 110, clientY: 70, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 64, pointerType: 'touch', clientX: 190, clientY: 70, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 63, pointerType: 'touch', clientX: 110, clientY: 50, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 64, pointerType: 'touch', clientX: 190, clientY: 50, button: 0, buttons: 1 });
    await waitFor(() => expect(sendInput).toHaveBeenCalled());
    fireEvent.pointerUp(surface, { pointerId: 63, pointerType: 'touch', clientX: 110, clientY: 90, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 64, pointerType: 'touch', clientX: 190, clientY: 90, button: 0, buttons: 0 });

    expect(actionRemoteInputPayloads(sendInput).some((payload) => payload.event.kind === 'scroll')).toBe(true);
  });

  it('lifts the fullscreen display container above IME without stealing unzoomed remote scroll control', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
        bottomInsetPx={280}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    expect(overlay.style.paddingBottom).toBe('280px');

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 500,
        width: 300,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await flushRemoteWindowSurfaceLayout();
    const content = screen.getByTestId('remote-window-video-content');
    const topBeforePan = Number.parseFloat(content.style.top || '0');

    fireEvent.pointerDown(surface, { pointerId: 41, pointerType: 'touch', clientX: 120, clientY: 300, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 41, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 41, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 0 });

    await waitForActionRemoteInputCount(sendInput, 1);
    expectNoRemoteInputFocus(sendInput);
    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
      }),
    ]);
    expect(topBeforePan).toEqual(expect.any(Number));
  });

  it('automatically lifts fullscreen content by the quickbar chrome when the IME opens', async () => {
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 300, height: 500 };
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
        bottomInsetPx={280}
        bottomChromeInsetPx={80}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 500,
        width: 300,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const content = screen.getByTestId('remote-window-video-content');
    await waitFor(() => {
      expect(Number.parseFloat(content.style.top || '0')).toBeCloseTo(-80, 1);
      expect(overlay.style.paddingBottom).toBe('200px');
    });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps exact-fill fullscreen IME projection stable while unzoomed drag sends remote scroll', async () => {
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 300, height: 500 };
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const sendInput = vi.fn();
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        sendInput={sendInput}
        bottomInsetPx={280}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 500,
        width: 300,
        height: 500,
        toJSON: () => ({}),
      }),
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const content = screen.getByTestId('remote-window-video-content');
    await waitFor(() => {
      expect(Number.parseFloat(content.style.top || '0')).toBeCloseTo(0, 1);
      expect(overlay.style.paddingBottom).toBe('280px');
    });

    fireEvent.pointerDown(surface, { pointerId: 51, pointerType: 'touch', clientX: 120, clientY: 300, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 51, pointerType: 'touch', clientX: 120, clientY: 220, button: 0, buttons: 1 });
    fireEvent.pointerUp(surface, { pointerId: 51, pointerType: 'touch', clientX: 120, clientY: 220, button: 0, buttons: 0 });

    await waitForActionRemoteInputCount(sendInput, 1);
    expectNoRemoteInputFocus(sendInput);
    expect(actionRemoteInputPayloads(sendInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'scroll',
      }),
    ]);
    expect(Number.parseFloat(content.style.top || '0')).toBeCloseTo(0, 1);
    expect(overlay.style.paddingBottom).toBe('280px');
  });

  it('keeps the decode video hidden while the overview crop canvas remains the visible projection', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow = {
      ...makeTarget('app-child', 'WeChat Image', 'app-window'),
      videoTarget: { ...mainWindow.videoTarget, windowId: 'window-2', title: 'WeChat Image' },
    };
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-1', targets: [mainWindow, childWindow] }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({ streamId, mediaStream }));
    const updateFocus = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateFocus={updateFocus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-app-group-com-apple-TextEdit-123'));
    const video = await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByTestId('remote-window-video-window-option-app-child'));

    await waitFor(() => expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-dual-stream-phase')).toBe('overview-crop-visible'));

    // 让 video 进入已播放状态(首帧后 videoHasPlayed=true)
    fireEvent.playing(video);

    // Android WebView 以 canvas 为唯一可见投影，video 只做解码面。
    expect((video as HTMLVideoElement).style.opacity).toBe('0');
    expect((video as HTMLVideoElement).style.visibility).toBe('visible');
  });

  it('times out a stuck overview crop switch and falls back to focus-committed', async () => {
    vi.useFakeTimers();
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow = {
      ...makeTarget('app-child', 'WeChat Image', 'app-window'),
      videoTarget: { ...mainWindow.videoTarget, windowId: 'window-2', title: 'WeChat Image' },
    };
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-1', targets: [mainWindow, childWindow] }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({ streamId, mediaStream }));
    const updateFocus = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateFocus={updateFocus}
      />,
    );

    const flush = () => act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await flush();
    fireEvent.click(screen.getByTestId('remote-window-app-group-com-apple-TextEdit-123'));
    await flush();
    fireEvent.click(screen.getByTestId('remote-window-video-window-option-app-child'));
    await flush();

    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-dual-stream-phase')).toBe('overview-crop-visible');

    // 消息一直不回来(focus-result 被吞):3s 后必须自动回退,不能永久黑屏
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-dual-stream-phase')).toBe('focus-committed');
    vi.useRealTimers();
  });

  it('resets an in-flight dual-stream switch when shrinking back to floating', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const mainWindow = makeTarget('app-main', 'WeChat', 'app-window');
    const childWindow = {
      ...makeTarget('app-child', 'WeChat Image', 'app-window'),
      videoTarget: { ...mainWindow.videoTarget, windowId: 'window-2', title: 'WeChat Image' },
    };
    const requestTargets = vi.fn(async () => ({ requestId: 'rw-1', targets: [mainWindow, childWindow] }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({ streamId, mediaStream }));
    const updateFocus = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateFocus={updateFocus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-app-group-com-apple-TextEdit-123'));
    await screen.findByTestId('remote-window-video');
    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    fireEvent.click(screen.getByTestId('remote-window-video-window-option-app-child'));

    await waitFor(() => expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-dual-stream-phase')).toBe('overview-crop-visible'));

    fireEvent.click(screen.getByRole('button', { name: '缩小远程窗口' }));

    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-dual-stream-phase')).toBe('focus-committed');
  });
});
