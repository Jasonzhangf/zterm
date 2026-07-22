// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowOverlay } from './RemoteWindowOverlay';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY } from '../../lib/remote-window-video-quality';

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

async function expandItermPaneGroup() {
  fireEvent.click(await screen.findByTestId('remote-window-iterm-pane-group'));
}

function remoteInputPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return sendInput.mock.calls.map((call) => call[1]);
}

function nonFocusRemoteInputPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return remoteInputPayloads(sendInput).filter((payload) => payload?.event?.kind !== 'focus');
}

function expectFirstRemoteInputFocus(sendInput: ReturnType<typeof vi.fn>) {
  expect(sendInput.mock.calls[0]?.[1]).toMatchObject({
    event: { kind: 'focus' },
  });
}

function expectEveryNonFocusInputIsFocusFirst(sendInput: ReturnType<typeof vi.fn>) {
  const payloads = remoteInputPayloads(sendInput);
  payloads.forEach((payload, index) => {
    if (payload?.event?.kind === 'focus') {
      return;
    }
    expect(payloads[index - 1]?.event).toMatchObject({ kind: 'focus' });
    expect(payloads[index - 1]).toMatchObject({
      streamId: payload.streamId,
      targetId: payload.targetId,
    });
  });
}

async function waitForNonFocusRemoteInputCount(sendInput: ReturnType<typeof vi.fn>, count: number) {
  await waitFor(() => {
    expect(nonFocusRemoteInputPayloads(sendInput)).toHaveLength(count);
  });
}

describe('RemoteWindowOverlay', () => {
  afterEach(() => {
    cleanup();
    backListeners.splice(0, backListeners.length);
    window.localStorage.clear();
    Reflect.deleteProperty(navigator, 'connection');
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

  it('fails the picker locally when the daemon catalog promise never settles', async () => {
    vi.useFakeTimers();
    const requestTargets = vi.fn(() => new Promise<never>(() => undefined));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    expect(screen.getByTestId('remote-window-picker-loading')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(8_000);
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
    expect(screen.getByTestId('remote-window-video-wallpaper').textContent).toContain('ZTERM');

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
      }), expect.stringMatching(/^rw-stream-/), {
        videoBitrate: { preset: '2mbps', bitrateMbps: 2, maxBitrateBps: 2_000_000, maxFrameRateFps: 5 },
      });
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

  it('keeps the ZTERM engraved wallpaper behind an unplayed receiver video', async () => {
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

    expect(screen.getByTestId('remote-window-video-wallpaper').textContent).toContain('ZTERM');
  });

  it('caps fullscreen quality to low bitrate and 5fps when network information reports poor connectivity', async () => {
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
    const updateStreamQuality = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateStreamQuality={updateStreamQuality}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    fireEvent.click(await screen.findByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    expect(startStream).toHaveBeenCalledWith('session-1', expect.objectContaining({
      streamTargetId: 'app-1',
    }), expect.stringMatching(/^rw-stream-/), {
      videoBitrate: {
        preset: '2mbps',
        bitrateMbps: 2,
        maxBitrateBps: 2_000_000,
        maxFrameRateFps: 5,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('fullscreen');
    expect(updateStreamQuality).not.toHaveBeenCalled();
  });

  it('remembers a high bitrate selection without raising the floating preview bitrate', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('app-1', 'TextEdit', 'app-window')],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const updateStreamQuality = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateStreamQuality={updateStreamQuality}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    fireEvent.change(screen.getByTestId('remote-window-bitrate-select'), {
      target: { value: '20mbps' },
    });

    expect(screen.getByTestId('remote-window-bitrate-select')).toHaveProperty('value', '20mbps');
    expect(updateStreamQuality).not.toHaveBeenCalled();
    expect(startStream).toHaveBeenCalledTimes(1);
  });

  it('keeps Android fullscreen projection from upgrading the desktop-area bitrate preset', async () => {
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    window.localStorage.setItem(REMOTE_WINDOW_VIDEO_BITRATE_STORAGE_KEY, JSON.stringify({
      version: 1,
      byTarget: {
        'app-window|com.apple.TextEdit|window-1|TextEdit': '2mbps',
      },
      byResolution: {},
    }));
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));
    const startStream = vi.fn(async (_sessionId: string, _target: RemoteWindowStreamTargetManifest, streamId: string) => ({
      streamId,
      mediaStream,
    }));
    const updateStreamQuality = vi.fn();

    render(
      <RemoteWindowOverlay
        activeSessionId="session-1"
        requestTargets={requestTargets}
        startStream={startStream}
        updateStreamQuality={updateStreamQuality}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    expect(startStream).toHaveBeenCalledWith('session-1', expect.objectContaining({
      streamTargetId: 'app-1',
    }), expect.stringMatching(/^rw-stream-/), {
      videoBitrate: { preset: '2mbps', bitrateMbps: 2, maxBitrateBps: 2_000_000, maxFrameRateFps: 5 },
    });

    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-bitrate-select')).toHaveProperty('value', '2mbps');
    });
    expect(updateStreamQuality).not.toHaveBeenCalled();

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
    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 2, pointerType: 'touch', clientX: 270, clientY: 100, button: 0, buttons: 1 });

    expect(startStream).toHaveBeenCalledTimes(1);
    expect(updateStreamQuality).not.toHaveBeenCalled();
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

  it('lets the remote window floating entry move instead of opening while dragged', async () => {
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

    fireEvent.pointerDown(entry, { pointerId: 9, pointerType: 'touch', clientX: 352, clientY: 742, button: 0 });
    fireEvent.pointerMove(entry, { pointerId: 9, pointerType: 'touch', clientX: 280, clientY: 640, button: 0 });
    fireEvent.pointerUp(entry, { pointerId: 9, pointerType: 'touch', clientX: 280, clientY: 640, button: 0 });
    fireEvent.click(entry);

    expect(requestTargets).not.toHaveBeenCalled();
    expect(entry.getAttribute('style') || '').toContain('transform: translate(-72px, -102px)');
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
    expect(setPointerCapture).toHaveBeenCalledWith(9);
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
  });

  it('keeps moving the floating entry when Android WebView delivers drag moves to window', async () => {
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

    fireEvent.pointerDown(entry, { pointerId: 19, pointerType: 'touch', clientX: 352, clientY: 742, button: 0 });
    fireEvent.pointerMove(window, { pointerId: 19, pointerType: 'touch', clientX: 210, clientY: 520, button: 0 });
    fireEvent.pointerUp(window, { pointerId: 19, pointerType: 'touch', clientX: 210, clientY: 520, button: 0 });
    fireEvent.click(entry);

    expect(requestTargets).not.toHaveBeenCalled();
    expect(entry.getAttribute('style') || '').toContain('transform: translate(-142px, -222px)');
    expect(screen.queryByTestId('remote-window-picker')).toBeNull();
  });

  it('lets a long press arm remote window entry dragging before the touch moves', async () => {
    vi.useFakeTimers();
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

    fireEvent.pointerDown(entry, { pointerId: 29, pointerType: 'touch', clientX: 352, clientY: 742, button: 0 });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerMove(window, { pointerId: 29, pointerType: 'touch', clientX: 300, clientY: 690, button: 0 });
    fireEvent.pointerUp(window, { pointerId: 29, pointerType: 'touch', clientX: 300, clientY: 690, button: 0 });
    fireEvent.click(entry);

    expect(requestTargets).not.toHaveBeenCalled();
    expect(entry.getAttribute('style') || '').toContain('transform: translate(-52px, -52px)');
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

  it('does not focus on stream setup and focuses only before wheel or key input', async () => {
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
      'focus',
      'scroll',
    ]);

    sendInput.mockClear();
    fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' });
    expect(remoteInputPayloads(sendInput).map((payload) => payload.event.kind)).toEqual([
      'focus',
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
      }));
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

    expect(overlay.style.transform).toBe('translate(6px, 20px)');
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

    await waitForNonFocusRemoteInputCount(sendInput, 2);
    expectFirstRemoteInputFocus(sendInput);
    expectEveryNonFocusInputIsFocusFirst(sendInput);
    expect(remoteInputPayloads(sendInput).map((payload) => payload.event.kind)).toEqual([
      'focus',
      'pointer',
      'focus',
      'pointer',
    ]);
    const inputPayloads = nonFocusRemoteInputPayloads(sendInput);
    expect(inputPayloads).toHaveLength(2);
    expect(sendInput.mock.calls[0][0]).toBe('session-1');
    expect(inputPayloads[0]).toMatchObject({
      streamId: expect.stringMatching(/^rw-stream-/),
      targetId: 'app-1',
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 7,
        normalizedX: 0.5,
        normalizedY: 0.5,
        x: 410,
        y: 320,
      },
    });
    expect(inputPayloads[1].event.phase).toBe('up');
  });

  it('maps a touch drag on the video surface to a remote gesture command instead of pointer drag', async () => {
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
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 21, pointerType: 'touch', clientX: 100, clientY: 40, button: 0, buttons: 0 });
    await waitForNonFocusRemoteInputCount(sendInput, 1);
    expectEveryNonFocusInputIsFocusFirst(sendInput);
    expect(remoteInputPayloads(sendInput).map((payload) => payload.event.kind)).toEqual([
      'focus',
      'gesture',
    ]);

    const payload = nonFocusRemoteInputPayloads(sendInput)[0];
    expect(payload.event.kind).toBe('gesture');
    if (payload.event.kind !== 'gesture') {
      throw new Error('expected gesture payload');
    }
    expect(payload.event.gesture).toBe('swipe');
    expect(payload.event.phase).toBe('end');
    expect(payload.event.deltaX).toBe(0);
    expect(payload.event.deltaY).toBe(-168);
    expect(payload.event.unit).toBe('pixel');
    expect(payload.event.startNormalizedX).toBeCloseTo(0.5, 3);
    expect(payload.event.startNormalizedY).toBeCloseTo(0.7, 3);
    expect(payload.event.normalizedX).toBeCloseTo(0.5, 3);
    expect(payload.event.normalizedY).toBeCloseTo(0.4, 3);
    expect(nonFocusRemoteInputPayloads(sendInput)).toHaveLength(1);
  });

  it('coalesces an unzoomed touch drag into one remote gesture command on release', async () => {
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
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 22, pointerType: 'touch', clientX: 120, clientY: 40, button: 0, buttons: 0 });
    await waitForNonFocusRemoteInputCount(sendInput, 1);
    expectEveryNonFocusInputIsFocusFirst(sendInput);
    expect(nonFocusRemoteInputPayloads(sendInput)[0].event).toMatchObject({
      kind: 'gesture',
      gesture: 'swipe',
      phase: 'end',
      pointerId: 22,
      deltaX: 0,
      deltaY: -224,
      startNormalizedX: 0.64,
      startNormalizedY: 0.8,
      normalizedX: 0.64,
      normalizedY: 0.4,
    });
  });

  it('drops stale touch gestures instead of sending delayed remote actions', async () => {
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
    vi.advanceTimersByTime(1_001);
    fireEvent.pointerUp(surface, { pointerId: 23, pointerType: 'touch', clientX: 120, clientY: 40, button: 0, buttons: 0 });

    expect(sendInput).not.toHaveBeenCalled();
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

  it('sends unzoomed fullscreen touch drag as one remote gesture even when the IME inset is present', async () => {
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
    const content = screen.getByTestId('remote-window-video-content');
    const topBeforeScroll = Number.parseFloat(content.style.top || '0');

    fireEvent.pointerDown(surface, { pointerId: 52, pointerType: 'touch', clientX: 120, clientY: 300, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 52, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 1 });
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 52, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 0 });

    await waitForNonFocusRemoteInputCount(sendInput, 1);
    expectEveryNonFocusInputIsFocusFirst(sendInput);
    expect(nonFocusRemoteInputPayloads(sendInput)[0].event).toMatchObject({
      kind: 'gesture',
      gesture: 'swipe',
      phase: 'end',
      deltaX: 0,
      deltaY: -133.33333333333337,
    });
    expect(Number.parseFloat(content.style.top || '0')).toBeCloseTo(topBeforeScroll, 1);
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

    await waitForNonFocusRemoteInputCount(sendInput, 2);
    expectFirstRemoteInputFocus(sendInput);
    expectEveryNonFocusInputIsFocusFirst(sendInput);
    const inputPayloads = nonFocusRemoteInputPayloads(sendInput);
    expect(inputPayloads).toHaveLength(2);
    expect(inputPayloads[0]).toMatchObject({
      targetId: 'app-1',
      event: {
        kind: 'pointer',
        phase: 'down',
        pointerId: 11,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    });
  });

  it('defaults fullscreen to complete fit and switches to aspect-fill cover without stretching', async () => {
    const target = makeTarget('app-1', 'TextEdit', 'app-window');
    target.videoTarget.cropRectTopLeftPx = { x: 10, y: 40, width: 800, height: 600 };
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [target],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
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
      expect(overlay.getAttribute('data-display-mode')).toBe('fit');
      expect(Number.parseFloat(content.style.left)).toBeCloseTo(16.67, 1);
      expect(Number.parseFloat(content.style.top)).toBeCloseTo(0, 1);
      expect(Number.parseFloat(content.style.width)).toBeCloseTo(266.67, 1);
      expect(Number.parseFloat(content.style.height)).toBeCloseTo(200, 1);
    });

    fireEvent.click(screen.getByTestId('remote-window-fullscreen-display-toggle'));

    await waitFor(() => {
      expect(overlay.getAttribute('data-display-mode')).toBe('fill');
      expect(Number.parseFloat(content.style.left)).toBeCloseTo(0, 1);
      expect(Number.parseFloat(content.style.top)).toBeCloseTo(-12.5, 1);
      expect(Number.parseFloat(content.style.width)).toBeCloseTo(300, 1);
      expect(Number.parseFloat(content.style.height)).toBeCloseTo(225, 1);
    });
    expect(screen.getByRole('button', { name: '切换为完整显示' })).toBeTruthy();
  });

  it('maps fullscreen fill input through the cropped cover content rect', async () => {
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

    await waitForNonFocusRemoteInputCount(sendInput, 2);
    expectFirstRemoteInputFocus(sendInput);
    const event = nonFocusRemoteInputPayloads(sendInput)[0].event;
    expect(event.kind).toBe('pointer');
    if (event.kind !== 'pointer') {
      throw new Error('expected pointer payload');
    }
    expect(event.normalizedX).toBeCloseTo(0.5, 3);
    expect(event.normalizedY).toBeCloseTo(1 / 18, 3);
    expect(event.x).toBeCloseTo(410, 3);
    expect(event.y).toBeCloseTo(73.33, 1);
  });

  it('supports fullscreen pinch zoom, single-finger local pan, and minimap viewport after zoom', async () => {
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

    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerDown(surface, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 100, button: 0, buttons: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-minimap')).toBeTruthy();
    });
    const content = screen.getByTestId('remote-window-video-content');
    const leftAfterPinch = Number.parseFloat(content.style.left || '0');

    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, button: 0, buttons: 0 });
    fireEvent.pointerUp(surface, { pointerId: 2, pointerType: 'touch', clientX: 260, clientY: 100, button: 0, buttons: 0 });
    fireEvent.pointerDown(surface, { pointerId: 3, pointerType: 'touch', clientX: 150, clientY: 110, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 3, pointerType: 'touch', clientX: 100, clientY: 90, button: 0, buttons: 1 });

    await waitFor(() => {
      expect(Number.parseFloat(content.style.left || '0')).not.toBe(leftAfterPinch);
      expect(screen.getByTestId('remote-window-minimap-viewport')).toBeTruthy();
    });
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('lifts the fullscreen display container above IME without stealing unzoomed remote gesture', async () => {
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
    const content = screen.getByTestId('remote-window-video-content');
    const topBeforePan = Number.parseFloat(content.style.top || '0');

    fireEvent.pointerDown(surface, { pointerId: 41, pointerType: 'touch', clientX: 120, clientY: 300, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { pointerId: 41, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 1 });
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 41, pointerType: 'touch', clientX: 120, clientY: 250, button: 0, buttons: 0 });

    await waitForNonFocusRemoteInputCount(sendInput, 1);
    expect(nonFocusRemoteInputPayloads(sendInput)[0].event).toMatchObject({
      kind: 'gesture',
      gesture: 'swipe',
      phase: 'end',
      deltaX: 0,
      deltaY: -133.33333333333337,
    });
    expect(Number.parseFloat(content.style.top || '0')).toBeCloseTo(topBeforePan, 1);
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

  it('keeps exact-fill fullscreen IME projection stable while unzoomed drag sends a remote gesture', async () => {
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
    expect(sendInput).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, { pointerId: 51, pointerType: 'touch', clientX: 120, clientY: 220, button: 0, buttons: 0 });

    await waitForNonFocusRemoteInputCount(sendInput, 1);
    expect(nonFocusRemoteInputPayloads(sendInput)[0].event).toMatchObject({
      kind: 'gesture',
      gesture: 'swipe',
      phase: 'end',
      deltaX: 0,
      deltaY: -80,
    });
    expect(Number.parseFloat(content.style.top || '0')).toBeCloseTo(0, 1);
    expect(overlay.style.paddingBottom).toBe('280px');
  });
});
