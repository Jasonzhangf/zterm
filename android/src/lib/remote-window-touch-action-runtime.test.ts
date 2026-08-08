import { describe, expect, it, vi } from 'vitest';
import type { RemoteWindowStreamTargetManifest } from './types';
import {
  createRemoteWindowTouchPointerState,
  dispatchRemoteWindowTouchInputActionRuntime,
  isRemoteWindowInputSupportedTarget,
  resolveRemoteWindowTouchScrollDeltaRuntime,
  resolveRemoteWindowTouchScrollFractionRuntime,
  resolveRemoteWindowTouchWheelDeltaRuntime,
  resolveRemoteWindowTouchPointerCancelRuntime,
  resolveRemoteWindowTouchPointerDownRuntime,
  resolveRemoteWindowTouchPointerMoveRuntime,
  resolveRemoteWindowTouchPointerUpRuntime,
  resolveRemoteWindowTouchPairPointerDownRuntime,
  resolveRemoteWindowTouchPairPointerMoveRuntime,
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
      kind: 'click' as const,
      pointerId: 7,
      button: 'left' as const,
      clickCount: 1,
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

  it('maps an unzoomed touch tap to one click action without React or WebView state', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ clientX: 110, clientY: 70 }),
      geometry,
      zoomedProjection: false,
    });
    expect(down.remoteEvents).toEqual([]);
    expect(down.nextState.mode).toBe('actionPending');

    const up = resolveRemoteWindowTouchPointerUpRuntime({
      state: down.nextState,
      pointer: pointer({ clientX: 110, clientY: 70, buttons: 0, timeMs: 1_020 }),
      geometry,
    });

    expect(up.nextState.mode).toBe('idle');
    expect(up.remoteEvents).toEqual([
      expect.objectContaining({
        kind: 'click',
        pointerId: 7,
        button: 'left',
        clickCount: 1,
        x: 500,
        y: 420,
        normalizedX: 0.5,
        normalizedY: 0.5,
      }),
    ]);
  });

  it('maps mouse click and drag to action records instead of pointer streams', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({
        pointerId: 20,
        pointerType: 'mouse',
        clientX: 110,
        clientY: 70,
        button: 0,
        buttons: 1,
        timeMs: 1_000,
      }),
      geometry,
      zoomedProjection: false,
    });
    expect(down.remoteEvents).toEqual([]);
    expect(down.nextState.mode).toBe('actionPending');

    const click = resolveRemoteWindowTouchPointerUpRuntime({
      state: down.nextState,
      pointer: pointer({
        pointerId: 20,
        pointerType: 'mouse',
        clientX: 110,
        clientY: 70,
        button: 0,
        buttons: 0,
        timeMs: 1_020,
      }),
      geometry,
    });
    expect(click.remoteEvents).toEqual([
      expect.objectContaining({
        kind: 'click',
        pointerId: 20,
        button: 'left',
        x: 500,
        y: 420,
      }),
    ]);

    const dragDown = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({
        pointerId: 21,
        pointerType: 'mouse',
        clientX: 110,
        clientY: 70,
        button: 0,
        buttons: 1,
        timeMs: 2_000,
      }),
      geometry,
      zoomedProjection: false,
    });
    const dragMove = resolveRemoteWindowTouchPointerMoveRuntime({
      state: dragDown.nextState,
      pointer: pointer({
        pointerId: 21,
        pointerType: 'mouse',
        clientX: 110,
        clientY: 40,
        button: 0,
        buttons: 1,
        timeMs: 2_020,
      }),
      geometry,
    });
    expect(dragMove.remoteEvents).toEqual([]);
    expect(dragMove.nextState.mode).toBe('actionDrag');
    const dragUp = resolveRemoteWindowTouchPointerUpRuntime({
      state: dragMove.nextState,
      pointer: pointer({
        pointerId: 21,
        pointerType: 'mouse',
        clientX: 110,
        clientY: 40,
        button: 0,
        buttons: 0,
        timeMs: 2_040,
      }),
      geometry,
    });
    expect(dragUp.remoteEvents).toEqual([
      expect.objectContaining({
        kind: 'gesture',
        gesture: 'swipe',
        phase: 'end',
        pointerId: 21,
        deltaX: 0,
        deltaY: -150,
      }),
    ]);
    expect([...click.remoteEvents, ...dragUp.remoteEvents].some((remoteEvent) => remoteEvent.kind === 'pointer')).toBe(false);
  });

  it('maps an unzoomed touch drag to one gesture action on release without streaming moves', () => {
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
    expect(firstMove.nextState.mode).toBe('actionDrag');
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
        deltaY: -150,
      }),
    ]);
    expect(up.remoteEvents.some((event) => event.kind === 'pointer')).toBe(false);
  });

  it('uses absolute visible-source fractions for release-time gesture deltas without changing mapped coordinates', () => {
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
      scrollFraction: 0.5,
      invertGestureDirection: true,
    });

    expect(up.remoteEvents).toEqual([
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
        deltaY: 300,
        durationMs: 40,
        velocityY: 7.5,
      }),
    ]);
    expect(resolveRemoteWindowTouchScrollFractionRuntime(Number.POSITIVE_INFINITY)).toBe(0.25);
    expect(resolveRemoteWindowTouchScrollFractionRuntime(10)).toBe(1);
    expect(resolveRemoteWindowTouchScrollDeltaRuntime(-10, 600, { fraction: 0.25 })).toBe(-150);
    expect(resolveRemoteWindowTouchScrollDeltaRuntime(-10, 600, { fraction: 0.25, inverted: true })).toBe(150);
    expect(resolveRemoteWindowTouchWheelDeltaRuntime(-10, 200, 600, { fraction: 0.25 })).toBe(-30);
    expect(resolveRemoteWindowTouchWheelDeltaRuntime(-10, 200, 600, { fraction: 0.25, inverted: true })).toBe(30);
    expect(resolveRemoteWindowTouchWheelDeltaRuntime(-500, 200, 600, { fraction: 0.25, inverted: true })).toBe(150);
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
    expect(tapUp.remoteEvents.map((event) => event.kind)).toEqual(['click']);
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

  describe('touch mode single-finger actions', () => {
    it('maps a touch tap to one left click in touch mode', () => {
      const down = resolveRemoteWindowTouchPointerDownRuntime({
        state: createRemoteWindowTouchPointerState(),
        pointer: pointer({ clientX: 110, clientY: 70 }),
        geometry,
        zoomedProjection: false,
        touchMode: true,
      });
      expect(down.nextState.mode).toBe('actionPending');

      const up = resolveRemoteWindowTouchPointerUpRuntime({
        state: down.nextState,
        pointer: pointer({ clientX: 110, clientY: 70, buttons: 0, timeMs: 1_020 }),
        geometry,
        touchMode: true,
      });
      expect(up.nextState.mode).toBe('idle');
      expect(up.remoteEvents).toEqual([
        expect.objectContaining({ kind: 'click', button: 'left' }),
      ]);
    });

    it('maps a touch drag to incremental scroll actions instead of mouse drag in touch mode', () => {
      const down = resolveRemoteWindowTouchPointerDownRuntime({
        state: createRemoteWindowTouchPointerState(),
        pointer: pointer({ clientX: 110, clientY: 70 }),
        geometry,
        zoomedProjection: false,
        touchMode: true,
      });
      const moveIntoScroll = resolveRemoteWindowTouchPointerMoveRuntime({
        state: down.nextState,
        pointer: pointer({ clientX: 110, clientY: 90, timeMs: 1_030 }),
        geometry,
        touchMode: true,
      });
      expect(moveIntoScroll.nextState.mode).toBe('actionScroll');
      expect(moveIntoScroll.remoteEvents.length).toBe(1);
      expect(moveIntoScroll.remoteEvents[0].kind).toBe('scroll');

      const scrollMove = resolveRemoteWindowTouchPointerMoveRuntime({
        state: moveIntoScroll.nextState,
        pointer: pointer({ clientX: 110, clientY: 110, timeMs: 1_050 }),
        geometry,
        touchMode: true,
        scrollFraction: 1,
      });
      expect(scrollMove.nextState.mode).toBe('actionScroll');
      expect(scrollMove.remoteEvents.length).toBe(1);
      const event = scrollMove.remoteEvents[0];
      expect(event.kind).toBe('scroll');
      if (event.kind === 'scroll') {
        expect(event.deltaY).not.toBe(0);
      }

      const up = resolveRemoteWindowTouchPointerUpRuntime({
        state: scrollMove.nextState,
        pointer: pointer({ clientX: 110, clientY: 110, buttons: 0, timeMs: 1_060 }),
        geometry,
        touchMode: true,
      });
      expect(up.nextState.mode).toBe('idle');
      expect(up.remoteEvents).toEqual([]);
    });

    it('fires a right click on long press in touch mode', () => {
      const down = resolveRemoteWindowTouchPointerDownRuntime({
        state: createRemoteWindowTouchPointerState(),
        pointer: pointer({ clientX: 110, clientY: 70 }),
        geometry,
        zoomedProjection: false,
        touchMode: true,
      });
      const longPress = resolveRemoteWindowTouchPointerMoveRuntime({
        state: down.nextState,
        pointer: pointer({ clientX: 110, clientY: 70, timeMs: 1_600 }),
        geometry,
        touchMode: true,
      });
      expect(longPress.nextState.mode).toBe('actionLongPress');
      expect(longPress.remoteEvents).toEqual([
        expect.objectContaining({ kind: 'click', button: 'right' }),
      ]);

      const up = resolveRemoteWindowTouchPointerUpRuntime({
        state: longPress.nextState,
        pointer: pointer({ clientX: 110, clientY: 70, buttons: 0, timeMs: 1_620 }),
        geometry,
        touchMode: true,
      });
      expect(up.nextState.mode).toBe('idle');
      expect(up.remoteEvents).toEqual([]);
    });

    it('keeps touch mode mouse drag path unchanged for mouse pointers', () => {
      const down = resolveRemoteWindowTouchPointerDownRuntime({
        state: createRemoteWindowTouchPointerState(),
        pointer: pointer({ pointerType: 'mouse', clientX: 110, clientY: 70 }),
        geometry,
        zoomedProjection: false,
        touchMode: true,
      });
      expect(down.nextState.mode).toBe('actionPending');
      const drag = resolveRemoteWindowTouchPointerMoveRuntime({
        state: down.nextState,
        pointer: pointer({ pointerType: 'mouse', clientX: 130, clientY: 90, timeMs: 1_030 }),
        geometry,
        touchMode: true,
      });
      expect(drag.nextState.mode).toBe('actionDrag');
    });
  });

  describe('two-finger gesture arbitration', () => {
    function pairDown(first: { clientX: number; clientY: number }, second: { clientX: number; clientY: number }) {
      return resolveRemoteWindowTouchPairPointerDownRuntime({
        firstPointer: {
          pointerId: 1,
          pointerType: 'touch',
          clientX: first.clientX,
          clientY: first.clientY,
          timeMs: 1_000,
        },
        secondPointer: {
          pointerId: 2,
          pointerType: 'touch',
          clientX: second.clientX,
          clientY: second.clientY,
          timeMs: 1_000,
        },
        timeMs: 1_000,
        pinchEnabled: true,
        scrollEnabled: true,
      });
    }

    it('keeps both fingers inside the observe window without committing', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      expect(candidate.nextState.mode).toBe('twoFingerCandidate');
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 80, timeMs: 1_050 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 80, timeMs: 1_050 },
        },
        geometry,
        timeMs: 1_050,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(move.nextState.mode).toBe('twoFingerCandidate');
      expect(move.remoteEvents).toEqual([]);
    });

    it('commits same-direction two-finger motion to scroll after the observe window', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      // 观察期 2 个 move（moveCount 0→1→2）
      const observe1 = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 80, timeMs: 1_050 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 80, timeMs: 1_050 },
        },
        geometry,
        timeMs: 1_050,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      const observe2 = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe1.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 90, timeMs: 1_060 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 90, timeMs: 1_060 },
        },
        geometry,
        timeMs: 1_060,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      // 观察期后 move：判定为 scroll
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe2.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 100, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
        scrollFraction: 1,
      });
      expect(move.nextState.mode).toBe('twoFingerScroll');
      expect(move.remoteEvents.length).toBeGreaterThan(0);
      expect(move.remoteEvents[0].kind).toBe('scroll');
    });

    it('commits opposite-direction two-finger motion to pinch after the observe window', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      // 观察期 2 个 move
      const observe1 = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 60, timeMs: 1_050 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 60, timeMs: 1_050 },
        },
        geometry,
        timeMs: 1_050,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      const observe2 = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe1.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 90, clientY: 60, timeMs: 1_060 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 130, clientY: 60, timeMs: 1_060 },
        },
        geometry,
        timeMs: 1_060,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe2.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 60, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 60, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(move.nextState.mode).toBe('pinch');
      expect(move.localEffect.kind).toBe('pinch-move');
    });

    it('does not commit a one-finger-only pinch (a stationary finger must not trigger pinch)', () => {
      // 第一指固定不动、第二指远离：不提交 pinch（防"单指移动被识别为缩放"误判）
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 60, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 160, clientY: 60, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(move.nextState.mode).not.toBe('pinch');
    });
  });
});
