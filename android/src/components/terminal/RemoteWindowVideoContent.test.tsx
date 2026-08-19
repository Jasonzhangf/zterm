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
      dualStreamPhase="overview-crop-visible"
      focusedVideoStyle={null}
      {...refs}
      onVideoLifecycle={onVideoLifecycle}
    />);
    fireEvent.loadedMetadata(screen.getByTestId('remote-window-video'));
    fireEvent.canPlay(screen.getByTestId('remote-window-video'));
    expect(onVideoLifecycle).toHaveBeenNthCalledWith(1, 'loadedmetadata');
    expect(onVideoLifecycle).toHaveBeenNthCalledWith(2, 'canplay');
    expect(screen.getByTestId('remote-window-overview-crop')).toBeTruthy();
  });

  it('renders explicit starting, error, and waiting truth', () => {
    const common = {
      target,
      receiverAttached: false,
      overviewCropVisible: false,
      videoHasPlayed: false,
      dualStreamPhase: 'idle',
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
});
