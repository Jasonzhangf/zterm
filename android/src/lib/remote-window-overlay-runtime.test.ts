import { describe, expect, it } from 'vitest';
import {
  applyRemoteWindowTargetCatalog,
  applyRemoteWindowTargetCatalogSnapshot,
  attachRemoteWindowStreamReceiver,
  beginRemoteWindowStreamSetup,
  beginRemoteWindowTargetEnumeration,
  closeRemoteWindowOverlay,
  enterRemoteWindowFullscreen,
  failRemoteWindowStream,
  failRemoteWindowTargetCatalog,
  initialRemoteWindowOverlayState,
  selectRemoteWindowTarget,
  shrinkRemoteWindowOverlay,
  upsertRemoteWindowCatalogTarget,
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

  it('starts and attaches a real stream without changing target projection', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const target = makeTarget('pane-1', 'iterm2-pane');
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [target],
    });
    const locked = selectRemoteWindowTarget(picker, 'pane-1');
    const streamStarting = beginRemoteWindowStreamSetup(locked, 'stream-1');
    const fullscreen = enterRemoteWindowFullscreen(streamStarting);
    const attached = attachRemoteWindowStreamReceiver(fullscreen, 'stream-1');
    const floating = shrinkRemoteWindowOverlay(attached);

    expect(streamStarting).toMatchObject({
      phase: 'targetLocked',
      streamId: 'stream-1',
      streamStarted: false,
      streamStatus: 'starting',
      target,
    });
    expect(attached).toMatchObject({
      phase: 'targetLocked',
      mode: 'fullscreen',
      streamId: 'stream-1',
      streamStarted: true,
      streamStatus: 'streaming',
      target,
    });
    expect(floating).toMatchObject({
      phase: 'targetLocked',
      mode: 'floating',
      streamId: 'stream-1',
      streamStarted: true,
    });
  });

  it('updates the locked target from an active catalog snapshot without restarting the stream', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const target = makeTarget('app-1', 'app-window');
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [target],
    });
    const locked = attachRemoteWindowStreamReceiver(
      beginRemoteWindowStreamSetup(selectRemoteWindowTarget(picker, 'app-1'), 'stream-1'),
      'stream-1',
    );
    const resized = {
      ...target,
      videoTarget: {
        ...target.videoTarget,
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 1200 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 1200 },
      },
    };

    const synced = applyRemoteWindowTargetCatalogSnapshot(locked, {
      requestId: 'rw-sync',
      targets: [resized, makeTarget('app-2', 'app-window')],
    });

    expect(synced).toMatchObject({
      phase: 'targetLocked',
      streamId: 'stream-1',
      streamStarted: true,
      streamStatus: 'streaming',
      target: resized,
    });
    expect(synced.phase === 'targetLocked' ? synced.targets.map((item) => item.streamTargetId) : []).toEqual(['app-1', 'app-2']);
  });

  it('keeps the active stream target when an active catalog snapshot no longer contains it', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const target = makeTarget('app-1', 'app-window');
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [target],
    });
    const locked = attachRemoteWindowStreamReceiver(
      beginRemoteWindowStreamSetup(selectRemoteWindowTarget(picker, 'app-1'), 'stream-1'),
      'stream-1',
    );

    const synced = applyRemoteWindowTargetCatalogSnapshot(locked, {
      requestId: 'rw-sync',
      targets: [makeTarget('app-2', 'app-window')],
    });

    expect(synced).toMatchObject({
      phase: 'targetLocked',
      streamId: 'stream-1',
      streamStarted: true,
      target,
    });
    expect(synced.phase === 'targetLocked' ? synced.targets.map((item) => item.streamTargetId) : []).toEqual(['app-2']);
  });

  it('surfaces stream setup errors explicitly without falling back to screenshot or terminal buffer preview', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'iterm2-pane')],
    });
    const locked = beginRemoteWindowStreamSetup(selectRemoteWindowTarget(picker, 'pane-1'), 'stream-1');
    const failed = failRemoteWindowStream(locked, 'stream-1', new Error('ScreenCaptureKit capture start failure'));

    expect(failed).toMatchObject({
      phase: 'targetLocked',
      streamId: 'stream-1',
      streamStarted: false,
      streamStatus: 'error',
      streamErrorMessage: 'ScreenCaptureKit capture start failure',
    });
  });

  it('upserts resize ACK targets into catalog snapshots when the previous catalog missed the target', () => {
    const target = makeTarget('app-resized', 'app-window');
    const payload = upsertRemoteWindowCatalogTarget({
      requestId: 'rw-cached',
      targets: [makeTarget('app-other', 'app-window')],
    }, target);

    expect(payload.targets.map((item) => item.streamTargetId)).toEqual(['app-resized', 'app-other']);
    expect(payload.targets[0]).toBe(target);
  });

  it('ignores late stream events for closed or different stream ids', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'iterm2-pane')],
    });
    const locked = beginRemoteWindowStreamSetup(selectRemoteWindowTarget(picker, 'pane-1'), 'stream-1');
    const wrongStream = attachRemoteWindowStreamReceiver(locked, 'stream-other');
    const closed = closeRemoteWindowOverlay(locked);
    const lateAttached = attachRemoteWindowStreamReceiver(closed, 'stream-1');

    expect(wrongStream).toBe(locked);
    expect(lateAttached).toBe(closed);
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
