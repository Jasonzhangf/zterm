// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';
import { RemoteWindowVideoContent } from './RemoteWindowVideoContent';

afterEach(cleanup);

const target: RemoteWindowStreamTargetManifest = {
  streamTargetId: 'target',
  videoTarget: {
    kind: 'app-window',
    appBundleId: 'com.example.app',
    pid: 42,
    windowId: 'window',
    title: 'Example',
    windowBoundsTopLeftPx: { x: 0, y: 0, width: 800, height: 600 },
  },
  inputTarget: { kind: 'app-window' },
  streamMode: 'interactive',
  focusPolicy: 'bring-to-focus',
  inputRoute: 'os-event',
  capture: {
    source: 'ScreenCaptureKit',
    coordinateSpace: 'macos-top-left-px',
    scale: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
  },
};

const refs = {
  overviewCanvasRef: { current: null },
  focusDisplayCanvasRef: { current: null },
  videoElementRef: { current: null },
  overviewVideoElementRef: { current: null },
};

describe('RemoteWindowVideoContent view owner', () => {
  it('renders attached media and emits media lifecycle intents', () => {
    const onVideoLifecycle = vi.fn();
    render(<RemoteWindowVideoContent
      streamStarted
      streamStatus="streaming"
      target={target}
      receiverAttached
      overviewCropVisible
      videoHasPlayed={false}
      
      focusedVideoStyle={null}
      {...refs}
      onVideoLifecycle={onVideoLifecycle}
    />);
    fireEvent.loadedMetadata(screen.getByTestId('remote-window-video'));
    fireEvent.canPlay(screen.getByTestId('remote-window-video'));
    expect(onVideoLifecycle).toHaveBeenNthCalledWith(1, 'loadedmetadata');
    expect(onVideoLifecycle).toHaveBeenNthCalledWith(2, 'canplay');
    expect(screen.getByTestId('remote-window-overview-crop')).toBeTruthy();
    const overviewCanvas = screen.getByTestId('remote-window-overview-crop');
    expect(overviewCanvas.style.objectFit).toBe('contain');
    expect(overviewCanvas.style.objectPosition).toBe('50% 50%');
    expect(screen.queryByTestId('remote-window-focus-display-canvas')).toBeNull();
  });

  it('renders focus display canvas instead of visible video when no overview crop', () => {
    render(<RemoteWindowVideoContent
      streamStarted
      streamStatus="streaming"
      target={target}
      receiverAttached
      overviewCropVisible={false}
      videoHasPlayed={false}
      
      focusedVideoStyle={null}
      {...refs}
      onVideoLifecycle={vi.fn()}
    />);
    const canvas = screen.getByTestId('remote-window-focus-display-canvas');
    expect(canvas).toBeTruthy();
    expect(canvas.style.objectFit).toBe('contain');
    expect(canvas.style.objectPosition).toBe('50% 50%');
    const video = screen.getByTestId('remote-window-video');
    expect(video.style.opacity).toBe('0');
  });

  it('renders explicit starting, error, and waiting truth', () => {
    const common = {
      target,
      receiverAttached: false,
      overviewCropVisible: false,
      videoHasPlayed: false,
      
      focusedVideoStyle: null,
      ...refs,
      onVideoLifecycle: vi.fn(),
    };
    const { rerender } = render(<RemoteWindowVideoContent streamStarted={false} streamStatus="starting" {...common} />);
    expect(screen.getByText('正在建立视频流')).toBeTruthy();
    rerender(<RemoteWindowVideoContent streamStarted={false} streamStatus="error" streamErrorMessage="capture failed" {...common} />);
    expect(screen.getByTestId('remote-window-stream-error').textContent).toContain('capture failed');
    rerender(<RemoteWindowVideoContent streamStarted={false} streamStatus="idle" {...common} />);
    expect(screen.getByText('等待视频流')).toBeTruthy();
  });

  it('names the post-connect gap instead of reusing the idle text', () => {
    const common = {
      target,
      receiverAttached: true,
      overviewCropVisible: false,
      videoHasPlayed: false,
      focusedVideoStyle: null,
      ...refs,
      onVideoLifecycle: vi.fn(),
    };
    const { rerender } = render(<RemoteWindowVideoContent streamStarted streamStatus="awaiting-first-data" {...common} />);
    expect(screen.getByTestId('remote-window-stage-status').textContent).toBe('已连接，正在传输数据');
    rerender(<RemoteWindowVideoContent streamStarted streamStatus="awaiting-first-frame" {...common} />);
    expect(screen.getByTestId('remote-window-stage-status').textContent).toBe('正在接收画面数据');
    // The stage chip disappears once frames actually play.
    rerender(<RemoteWindowVideoContent streamStarted streamStatus="streaming" {...common} videoHasPlayed />);
    expect(screen.queryByTestId('remote-window-stage-status')).toBeNull();
  });
});
