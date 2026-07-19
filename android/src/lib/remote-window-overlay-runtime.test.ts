import { describe, expect, it } from 'vitest';
import {
  applyRemoteWindowTargetCatalog,
  beginRemoteWindowTargetEnumeration,
  closeRemoteWindowOverlay,
  enterRemoteWindowFullscreen,
  failRemoteWindowTargetCatalog,
  initialRemoteWindowOverlayState,
  selectRemoteWindowTarget,
  shrinkRemoteWindowOverlay,
} from './remote-window-overlay-runtime';
import type { RemoteWindowStreamTargetManifest } from './types';

function makeTarget(id: string, kind: 'app-window' | 'iterm2-pane'): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind,
      appBundleId: kind === 'iterm2-pane' ? 'com.googlecode.iterm2' : 'com.apple.TextEdit',
      pid: 123,
      windowId: 'window-1',
      title: kind === 'iterm2-pane' ? 'iTerm2 pane' : 'TextEdit',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 40, width: 800, height: 560 },
      contentTopInsetPx: kind === 'iterm2-pane' ? 20 : undefined,
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

describe('remote window overlay runtime', () => {
  it('opens picker state from a daemon catalog without starting fake video', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const target = makeTarget('app-1', 'app-window');
    const next = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [target],
      errors: [{ requestId: 'rw-1', code: 'iterm2_api_unavailable', message: 'iTerm2 unavailable' }],
    });

    expect(next).toMatchObject({
      phase: 'pickerOpen',
      targets: [target],
      errors: [{ code: 'iterm2_api_unavailable' }],
    });

    const locked = selectRemoteWindowTarget(next, 'app-1');
    expect(locked).toMatchObject({
      phase: 'targetLocked',
      mode: 'floating',
      streamStarted: false,
      target,
    });
  });

  it('drops stale catalog responses by request epoch', () => {
    const first = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const second = beginRemoteWindowTargetEnumeration(first.state);
    const next = applyRemoteWindowTargetCatalog(second.state, first.requestEpoch, {
      requestId: 'rw-stale',
      targets: [makeTarget('stale', 'app-window')],
    });

    expect(next).toBe(second.state);
  });

  it('keeps fullscreen shrink separate from close teardown', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'iterm2-pane')],
    });
    const locked = selectRemoteWindowTarget(picker, 'pane-1');
    const fullscreen = enterRemoteWindowFullscreen(locked);
    const floating = shrinkRemoteWindowOverlay(fullscreen);
    const closed = closeRemoteWindowOverlay(fullscreen);

    expect(fullscreen).toMatchObject({ phase: 'targetLocked', mode: 'fullscreen' });
    expect(floating).toMatchObject({ phase: 'targetLocked', mode: 'floating' });
    expect(closed).toMatchObject({ phase: 'closed' });
    expect(closed.requestEpoch).toBe(fullscreen.requestEpoch + 1);
  });

  it('surfaces catalog failure explicitly instead of treating it as an empty success', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const failed = failRemoteWindowTargetCatalog(started.state, started.requestEpoch, new Error('permission missing'));

    expect(failed).toMatchObject({
      phase: 'pickerOpen',
      targets: [],
      errorMessage: 'permission missing',
    });
  });
});
