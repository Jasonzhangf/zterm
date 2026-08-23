import { describe, expect, it } from 'vitest';
import {
  applyRemoteWindowTargetCatalog,
  applyRemoteWindowTargetCatalogSnapshot,
  attachRemoteWindowStreamReceiver,
  attachSameAppCompositeWindows,
  beginRemoteWindowStreamHandoff,
  beginRemoteWindowStreamSetup,
  beginRemoteWindowTargetEnumeration,
  closeRemoteWindowOverlay,
  commitRemoteWindowStreamHandoff,
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

  it('allows a handoff canvas stream to commit when focus startup fails', () => {
    const started = beginRemoteWindowTargetEnumeration(initialRemoteWindowOverlayState);
    const currentTarget = makeTarget('app-1', 'app-window');
    const nextTarget = makeTarget('app-2', 'app-window');
    const picker = applyRemoteWindowTargetCatalog(started.state, started.requestEpoch, {
      requestId: 'rw-1',
      targets: [currentTarget, nextTarget],
    });
    const locked = attachRemoteWindowStreamReceiver(
      beginRemoteWindowStreamSetup(selectRemoteWindowTarget(picker, 'app-1'), 'current-focus'),
      'current-focus',
    );
    const handoff = {
      epoch: 1,
      previousStreamId: 'current-focus',
      pendingStreamId: 'next-focus',
      acceptedStreamIds: ['next-canvas', 'next-focus'],
      targetId: 'app-2',
      status: 'starting' as const,
    };

    const pending = beginRemoteWindowStreamHandoff(locked, handoff);
    const committed = commitRemoteWindowStreamHandoff(pending, handoff, 'next-canvas');

    expect(committed).toMatchObject({
      phase: 'targetLocked',
      target: nextTarget,
      streamId: 'next-canvas',
      streamStarted: true,
      streamStatus: 'streaming',
      streamHandoff: null,
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
    const error = Object.assign(new Error('ScreenCaptureKit capture start failure'), {
      failureStage: 'focus-capture-start' as const,
    });
    const failed = failRemoteWindowStream(locked, 'stream-1', error);

    expect(failed).toMatchObject({
      phase: 'targetLocked',
      streamId: 'stream-1',
      streamStarted: false,
      streamStatus: 'error',
      streamErrorMessage: 'ScreenCaptureKit capture start failure',
      streamFailureStage: 'focus-capture-start',
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

describe('remote window composite layout', () => {
  function makeTarget(overrides: Record<string, unknown> = {}) {
    return {
      streamTargetId: 'app-window:1:100',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.tencent.xinWeChat',
        pid: 100,
        windowId: '100',
        title: 'WeChat',
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      },
      inputTarget: { kind: 'app-window' },
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
      ...overrides,
    } as RemoteWindowStreamTargetManifest;
  }

  it('does not attach windows from other apps even with shared/missing bundle id', () => {
    const wechat = makeTarget({
      streamTargetId: 'app-window:1:100',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.tencent.xinWeChat',
        ownerName: '微信',
        pid: 100,
        windowId: '100',
        title: 'WeChat',
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      },
      inputTarget: { kind: 'app-window' },
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });
    // 小红书独立 app：即使 catalog 误报相同 bundle id，ownerName 不同也不得聚合
    const xiaohongshu = makeTarget({
      streamTargetId: 'app-window:2:200',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.tencent.xinWeChat',
        ownerName: '小红书',
        pid: 200,
        windowId: '200',
        title: '小红书',
        windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
      },
      inputTarget: { kind: 'app-window' },
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });
    const attached = attachSameAppCompositeWindows(wechat, [wechat, xiaohongshu]);
    expect(attached.compositeWindows ?? []).toHaveLength(0);
  });

  it('attaches same app windows when bundle id and ownerName both match', () => {
    const wechatMain = makeTarget({
      streamTargetId: 'app-window:1:100',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.tencent.xinWeChat',
        ownerName: '微信',
        pid: 100,
        windowId: '100',
        title: 'WeChat',
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      },
      inputTarget: { kind: 'app-window' },
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });
    const wechatPreview = makeTarget({
      streamTargetId: 'app-window:1:200',
      videoTarget: {
        kind: 'app-window',
        appBundleId: 'com.tencent.xinWeChat',
        ownerName: '微信',
        pid: 100,
        windowId: '200',
        title: 'Preview',
        windowBoundsTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
        cropRectTopLeftPx: { x: 900, y: 20, width: 400, height: 500 },
      },
      inputTarget: { kind: 'app-window' },
      capture: {
        source: 'ScreenCaptureKit',
        coordinateSpace: 'macos-top-left-px',
        scale: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });
    const attached = attachSameAppCompositeWindows(wechatMain, [wechatMain, wechatPreview]);
    expect(attached.compositeWindows ?? []).toHaveLength(1);
    expect(attached.compositeWindows![0]).toMatchObject({ windowId: '200', ownerName: '微信' });
  });

  it('does not synthesize the primary window as its own composite child', () => {
    const target = makeTarget();
    const attached = attachSameAppCompositeWindows(target, [target]);
    expect(attached.compositeWindows).toBeUndefined();
  });
});
