import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from './types';
import {
  createRemoteWindowTouchPointerState,
  dispatchRemoteWindowTouchInputActionRuntime,
  isRemoteWindowInputSupportedTarget,
  resolveRemoteWindowTouchGestureDeltaRuntime,
  resolveRemoteWindowTouchGestureScaleRuntime,
  resolveRemoteWindowTouchPointerCancelRuntime,
  resolveRemoteWindowTouchPointerDownRuntime,
  resolveRemoteWindowTouchPointerMoveRuntime,
  resolveRemoteWindowTouchPointerUpRuntime,
} from './remote-window-touch-action-runtime';

function makeTarget(overrides: Partial<RemoteWindowStreamTargetManifest> = {}): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'app-window:123:456',
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.tencent.xinWeChat',
      pid: 123,
      windowId: '456',
      title: 'WeChat',
      windowBoundsTopLeftPx: { x: 100, y: 120, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 100, y: 120, width: 800, height: 600 },
    },
    inputTarget: {
      kind: 'app-window',
    },
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-23T00:00:00.000Z',
    },
    ...overrides,
  };
}

const geometry = {
  surfaceRect: { left: 10, top: 20, width: 200, height: 100 },
  contentRect: { left: 0, top: 0, width: 200, height: 100 },
  sourceRect: { x: 100, y: 120, width: 800, height: 600 },
};

function pointer(overrides: Partial<{
  pointerId: number;
  pointerType: 'touch' | 'mouse' | 'pen';
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  timeMs: number;
}> = {}) {
  return {
    pointerId: 7,
    pointerType: 'touch' as const,
    clientX: 110,
    clientY: 70,
    button: 0,
    buttons: 1,
    timeMs: 1_000,
    ...overrides,
  };
}

describe('remote-window-touch-action-runtime', () => {
  it('accepts only interactive app-window OS-event targets', () => {
    expect(isRemoteWindowInputSupportedTarget(makeTarget())).toBe(true);
    expect(isRemoteWindowInputSupportedTarget(makeTarget({ inputRoute: 'tmux-input' }))).toBe(false);
    expect(isRemoteWindowInputSupportedTarget(makeTarget({ focusPolicy: 'no-focus-steal' }))).toBe(false);
    expect(isRemoteWindowInputSupportedTarget(makeTarget({
      videoTarget: {
        kind: 'iterm2-pane',
        appBundleId: 'com.googlecode.iterm2',
        pid: 123,
        windowId: '456',
        title: 'pane',
        windowBoundsTopLeftPx: { x: 100, y: 120, width: 800, height: 600 },
        cropRectTopLeftPx: { x: 100, y: 120, width: 800, height: 600 },
      },
    }))).toBe(false);
  });

  it('does not report sent when context or dispatcher is missing', () => {
    const sendInput = vi.fn();
    const onDebug = vi.fn();
    const result = dispatchRemoteWindowTouchInputActionRuntime({
      action: {
        source: 'overlay',
        sessionId: null,
        streamId: 'rw-stream-1',
        target: makeTarget(),
        event: { kind: 'focus' },
      },
      sendInput,
      onDebug,
    });

    expect(result).toEqual({ sent: false, reason: 'missing-context' });
    expect(sendInput).not.toHaveBeenCalled();
    expect(onDebug).toHaveBeenCalledWith(expect.objectContaining({
      sent: false,
      sessionId: null,
      streamId: 'rw-stream-1',
      targetId: 'app-window:123:456',
      event: { kind: 'focus' },
    }));

    expect(dispatchRemoteWindowTouchInputActionRuntime({
      action: {
        source: 'overlay',
        sessionId: 'session-1',
        streamId: 'rw-stream-1',
        target: makeTarget(),
        event: { kind: 'focus' },
      },
      onDebug,
    })).toEqual({ sent: false, reason: 'missing-dispatcher' });
  });

  it('sends a supported action through the supplied dispatch owner and records debug', () => {
    const sendInput = vi.fn();
    const onDebug = vi.fn();
    const target = makeTarget();
    const event = {
      kind: 'pointer' as const,
      phase: 'down' as const,
      pointerId: 7,
      button: 'left' as const,
      buttons: 1,
      x: 500,
      y: 420,
      normalizedX: 0.5,
      normalizedY: 0.5,
    };

    expect(dispatchRemoteWindowTouchInputActionRuntime({
      action: {
        source: 'overlay',
        sessionId: 'session-1',
        streamId: 'rw-stream-1',
        target,
        event,
      },
      sendInput,
      onDebug,
    })).toEqual({ sent: true });

    expect(sendInput).toHaveBeenCalledWith('session-1', {
      streamId: 'rw-stream-1',
      targetId: 'app-window:123:456',
      event,
    });
    expect(onDebug).toHaveBeenCalledWith(expect.objectContaining({
      source: 'overlay',
      sent: true,
      sessionId: 'session-1',
      streamId: 'rw-stream-1',
      targetId: 'app-window:123:456',
      targetTitle: 'WeChat',
      event,
    }));
  });

  it('maps an unzoomed touch tap to focus-first absolute pointer down/up actions without React or WebView state', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ clientX: 110, clientY: 70 }),
      geometry,
      zoomedProjection: false,
    });
    expect(down.remoteEvents).toEqual([]);
    expect(down.nextState.mode).toBe('touchPending');

    const up = resolveRemoteWindowTouchPointerUpRuntime({
      state: down.nextState,
      pointer: pointer({ clientX: 110, clientY: 70, buttons: 0, timeMs: 1_020 }),
      geometry,
    });

    expect(up.nextState.mode).toBe('idle');
    expect(up.remoteEvents).toEqual([
      { kind: 'focus' },
      expect.objectContaining({
        kind: 'pointer',
        phase: 'down',
        pointerId: 7,
        buttons: 1,
        x: 500,
        y: 420,
        normalizedX: 0.5,
        normalizedY: 0.5,
      }),
      { kind: 'focus' },
      expect.objectContaining({
        kind: 'pointer',
        phase: 'up',
        pointerId: 7,
        buttons: 0,
        x: 500,
        y: 420,
        normalizedX: 0.5,
        normalizedY: 0.5,
      }),
    ]);
  });

  it('maps an unzoomed touch drag to one focus-first gesture action on release without streaming moves', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 8, clientX: 130, clientY: 90 }),
      geometry,
      zoomedProjection: false,
    });
    const firstMove = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 8, clientX: 130, clientY: 72 }),
      geometry,
    });
    expect(firstMove.nextState.mode).toBe('touchDrag');
    expect(firstMove.remoteEvents).toEqual([]);

    const secondMove = resolveRemoteWindowTouchPointerMoveRuntime({
      state: firstMove.nextState,
      pointer: pointer({ pointerId: 8, clientX: 130, clientY: 54 }),
      geometry,
    });
    const up = resolveRemoteWindowTouchPointerUpRuntime({
      state: secondMove.nextState,
      pointer: pointer({ pointerId: 8, clientX: 130, clientY: 54, buttons: 0 }),
      geometry,
    });

    expect(secondMove.remoteEvents).toEqual([]);
    expect(up.remoteEvents).toEqual([
      { kind: 'focus' },
      expect.objectContaining({
        kind: 'gesture',
        gesture: 'swipe',
        phase: 'end',
        pointerId: 8,
        startNormalizedX: 0.6,
        startNormalizedY: 0.7,
        normalizedX: 0.6,
        normalizedY: 0.34,
        deltaX: 0,
        deltaY: -72,
      }),
    ]);
    expect(up.remoteEvents.some((event) => event.kind === 'pointer')).toBe(false);
  });

  it('scales and reverses release-time gesture deltas without changing mapped coordinates', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 18, clientX: 130, clientY: 90, timeMs: 1_000 }),
      geometry,
      zoomedProjection: false,
    });
    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 18, clientX: 130, clientY: 54, timeMs: 1_020 }),
      geometry,
    });
    const up = resolveRemoteWindowTouchPointerUpRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 18, clientX: 130, clientY: 54, buttons: 0, timeMs: 1_040 }),
      geometry,
      gestureScale: 3,
      invertGestureDirection: true,
    });

    expect(up.remoteEvents).toEqual([
      { kind: 'focus' },
      expect.objectContaining({
        kind: 'gesture',
        gesture: 'swipe',
        phase: 'end',
        pointerId: 18,
        startNormalizedX: 0.6,
        startNormalizedY: 0.7,
        normalizedX: 0.6,
        normalizedY: 0.34,
        deltaX: 0,
        deltaY: 108,
        durationMs: 40,
        velocityY: 2.7,
      }),
    ]);
    expect(resolveRemoteWindowTouchGestureScaleRuntime(Number.POSITIVE_INFINITY)).toBe(2);
    expect(resolveRemoteWindowTouchGestureScaleRuntime(10)).toBe(4);
    expect(resolveRemoteWindowTouchGestureDeltaRuntime(-10, { scale: 1.5 })).toBe(-15);
    expect(resolveRemoteWindowTouchGestureDeltaRuntime(-10, { scale: 1.5, inverted: true })).toBe(15);
  });

  it('drops stale unzoomed touch drag actions instead of replaying delayed gestures', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 12, clientX: 130, clientY: 90, timeMs: 1_000 }),
      geometry,
      zoomedProjection: false,
    });
    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 12, clientX: 130, clientY: 54, timeMs: 1_020 }),
      geometry,
    });
    const staleUp = resolveRemoteWindowTouchPointerUpRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 12, clientX: 130, clientY: 54, buttons: 0, timeMs: 2_001 }),
      geometry,
    });

    expect(staleUp.nextState.mode).toBe('idle');
    expect(staleUp.remoteEvents).toEqual([]);
  });

  it('keeps zoomed fullscreen touch as local pan and only emits remote tap if it did not move', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 9, clientX: 90, clientY: 50 }),
      geometry,
      zoomedProjection: true,
    });
    expect(down.localEffect).toEqual({
      kind: 'local-pan-start',
      pointerId: 9,
      clientX: 90,
      clientY: 50,
    });
    expect(down.remoteEvents).toEqual([]);

    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 9, clientX: 120, clientY: 80 }),
      geometry,
    });
    expect(move.localEffect).toEqual({
      kind: 'local-pan-move',
      pointerId: 9,
      deltaX: 30,
      deltaY: 30,
      moved: true,
    });

    const upAfterMove = resolveRemoteWindowTouchPointerUpRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 9, clientX: 120, clientY: 80, buttons: 0 }),
      geometry,
    });
    expect(upAfterMove.remoteEvents).toEqual([]);
    expect(upAfterMove.localEffect).toEqual({ kind: 'local-pan-end', pointerId: 9, moved: true });

    const tapDown = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 10, clientX: 110, clientY: 70 }),
      geometry,
      zoomedProjection: true,
    });
    const tapUp = resolveRemoteWindowTouchPointerUpRuntime({
      state: tapDown.nextState,
      pointer: pointer({ pointerId: 10, clientX: 110, clientY: 70, buttons: 0 }),
      geometry,
    });
    expect(tapUp.remoteEvents.map((event) => event.kind)).toEqual(['focus', 'pointer', 'focus', 'pointer']);
  });

  it('releases a remote drag on cancel without producing delayed gesture actions', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 11, clientX: 130, clientY: 90 }),
      geometry,
      zoomedProjection: false,
    });
    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 11, clientX: 130, clientY: 72 }),
      geometry,
    });
    const cancel = resolveRemoteWindowTouchPointerCancelRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 11, clientX: 130, clientY: 72, buttons: 0 }),
      geometry,
    });
    expect(cancel.nextState.mode).toBe('idle');
    expect(cancel.remoteEvents).toEqual([]);
  });
});
