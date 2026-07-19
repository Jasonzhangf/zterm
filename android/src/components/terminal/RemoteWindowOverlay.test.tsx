// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowOverlay } from './RemoteWindowOverlay';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

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

describe('RemoteWindowOverlay', () => {
  afterEach(() => {
    cleanup();
    backListeners.splice(0, backListeners.length);
    vi.useRealTimers();
  });

  it('opens the picker from the floating entry and renders daemon catalog rows', async () => {
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
      expect(screen.getByTestId('remote-window-target-pane-1')).toBeTruthy();
      expect(screen.queryByTestId('remote-window-partial-errors')).toBeNull();
    });
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

  it('selects a target, expands to fullscreen, shrinks on Back, and closes explicitly', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-pane-1');
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('floating');
    expect(screen.getByText('等待视频流')).toBeTruthy();

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
    await screen.findByTestId('remote-window-target-pane-1');
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    await waitFor(() => {
      expect(startStream).toHaveBeenCalledWith('session-1', expect.objectContaining({
        streamTargetId: 'pane-1',
      }), expect.stringMatching(/^rw-stream-/));
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
    await screen.findByTestId('remote-window-target-pane-1');
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
    await screen.findByTestId('remote-window-target-pane-1');
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

  it('moves the floating overlay from the toolbar without entering fullscreen', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-pane-1');
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

  it('does not move the overlay from toolbar pointer gestures in fullscreen', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-pane-1');
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

    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledTimes(2);
    });
    expect(sendInput.mock.calls[0][0]).toBe('session-1');
    expect(sendInput.mock.calls[0][1]).toMatchObject({
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
    expect(sendInput.mock.calls[1][1].event.phase).toBe('up');
  });

  it('maps a touch drag on the video surface to remote scroll instead of pointer drag', async () => {
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
    fireEvent.pointerUp(surface, { pointerId: 21, pointerType: 'touch', clientX: 100, clientY: 40, button: 0, buttons: 0 });

    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledTimes(1);
    });
    const payload = sendInput.mock.calls[0][1];
    expect(payload.event.kind).toBe('scroll');
    if (payload.event.kind !== 'scroll') {
      throw new Error('expected scroll payload');
    }
    expect(payload.event.deltaX).toBe(0);
    expect(payload.event.deltaY).toBe(30);
    expect(payload.event.unit).toBe('pixel');
    expect(payload.event.normalizedX).toBeCloseTo(0.5, 3);
    expect(payload.event.normalizedY).toBeCloseTo(0.4, 3);
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

    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledTimes(2);
    });
    expect(sendInput.mock.calls[0][1]).toMatchObject({
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

  it('supports fullscreen pinch zoom, single-finger pan, and minimap viewport', async () => {
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
        sendInput={vi.fn()}
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
  });
});
