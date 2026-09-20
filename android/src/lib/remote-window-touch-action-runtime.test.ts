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
  resolveRemoteWindowTouchPairPointerUpRuntime,
  resolveRemoteWindowTouchSurfacePointRuntime,
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
    expect(dragMove.remoteEvents).toEqual([
      expect.objectContaining({ kind: 'pointer', phase: 'down', pointerId: 21, buttons: 1 }),
      expect.objectContaining({ kind: 'pointer', phase: 'move', pointerId: 21, buttons: 1 }),
    ]);
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
        kind: 'pointer',
        phase: 'up',
        pointerId: 21,
        buttons: 0,
      }),
    ]);
    expect([...dragMove.remoteEvents, ...dragUp.remoteEvents].map((event) => event.kind === 'pointer' ? event.phase : null)).toEqual(['down', 'move', 'up']);
  });

  it('maps an unzoomed direct-touch drag to realtime scroll during movement', () => {
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
      touchMode: true,
    });
    expect(firstMove.nextState.mode).toBe('actionScroll');
    expect(firstMove.remoteEvents).toEqual([
      expect.objectContaining({ kind: 'scroll', moveCursor: false }),
    ]);

    const secondMove = resolveRemoteWindowTouchPointerMoveRuntime({
      state: firstMove.nextState,
      pointer: pointer({ pointerId: 8, clientX: 130, clientY: 54 }),
      geometry,
      touchMode: true,
    });
    const up = resolveRemoteWindowTouchPointerUpRuntime({
      state: secondMove.nextState,
      pointer: pointer({ pointerId: 8, clientX: 130, clientY: 54, buttons: 0 }),
      geometry,
      touchMode: true,
    });

    expect(secondMove.remoteEvents).toEqual([
      expect.objectContaining({ kind: 'scroll', moveCursor: false }),
    ]);
    expect(up.remoteEvents).toEqual([]);
  });

  it('uses absolute visible-source coordinates for mouse pointer drag', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 18, pointerType: 'mouse', clientX: 130, clientY: 90, timeMs: 1_000 }),
      geometry,
      zoomedProjection: false,
    });
    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 18, pointerType: 'mouse', clientX: 130, clientY: 54, timeMs: 1_020 }),
      geometry,
    });
    const up = resolveRemoteWindowTouchPointerUpRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 18, pointerType: 'mouse', clientX: 130, clientY: 54, buttons: 0, timeMs: 1_040 }),
      geometry,
      scrollFraction: 0.5,
      invertGestureDirection: true,
    });

    expect(up.remoteEvents).toEqual([
      expect.objectContaining({
        kind: 'pointer',
        phase: 'up',
        pointerId: 18,
        normalizedX: 0.6,
        normalizedY: 0.34,
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

  it('rejects letterbox input instead of clamping it to a source edge', () => {
    const letterboxedGeometry = {
      ...geometry,
      contentRect: { left: 20, top: 10, width: 160, height: 80 },
    };
    expect(resolveRemoteWindowTouchSurfacePointRuntime(letterboxedGeometry, 15, 70)).toBeNull();
    expect(resolveRemoteWindowTouchSurfacePointRuntime(letterboxedGeometry, 110, 25)).toBeNull();
    expect(resolveRemoteWindowTouchSurfacePointRuntime(letterboxedGeometry, 110, 70)).toEqual(expect.objectContaining({
      normalizedX: 0.5,
      normalizedY: 0.5,
    }));
  });

  it('keeps a five-second held remote drag valid and releases it', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 12, clientX: 130, clientY: 90, timeMs: 1_000 }),
      geometry,
      zoomedProjection: false,
    });
    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 12, clientX: 130, clientY: 54, timeMs: 1_300 }),
      geometry,
      touchMode: true,
    });
    expect(move.remoteEvents.map((event) => event.kind === 'pointer' ? event.phase : null)).toEqual(['down', 'move']);
    const release = resolveRemoteWindowTouchPointerUpRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 12, clientX: 130, clientY: 54, buttons: 0, timeMs: 6_300 }),
      geometry,
    });

    expect(release.nextState.mode).toBe('idle');
    expect(release.remoteEvents).toEqual([
      expect.objectContaining({ kind: 'pointer', phase: 'up', pointerId: 12, buttons: 0 }),
    ]);
  });

  it('suppresses zoomed fullscreen single-finger motion without local or remote effects', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 9, clientX: 90, clientY: 50 }),
      geometry,
      zoomedProjection: true,
      touchMode: true,
      suppressSingleFinger: true,
    });
    expect(down.nextState.mode).toBe('actionPending');
    expect(down.nextState).toEqual(expect.objectContaining({
      pointerId: 9,
      startClientX: 90,
      startClientY: 50,
      suppressTap: true,
    }));
    expect(down.localEffect).toEqual({ kind: 'none' });
    expect(down.remoteEvents).toEqual([]);

    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 9, clientX: 120, clientY: 80 }),
      geometry,
      touchMode: true,
    });
    expect(move.nextState.mode).toBe('actionPending');
    expect(move.localEffect).toEqual({ kind: 'none' });
    expect(move.remoteEvents).toEqual([]);

    const upAfterMove = resolveRemoteWindowTouchPointerUpRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 9, clientX: 120, clientY: 80, buttons: 0 }),
      geometry,
      touchMode: true,
    });
    expect(upAfterMove.nextState.mode).toBe('idle');
    expect(upAfterMove.localEffect).toEqual({ kind: 'none' });
    expect(upAfterMove.remoteEvents).toEqual([]);

    const tapDown = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 10, clientX: 110, clientY: 70 }),
      geometry,
      zoomedProjection: true,
      touchMode: true,
      suppressSingleFinger: true,
    });
    const tapUp = resolveRemoteWindowTouchPointerUpRuntime({
      state: tapDown.nextState,
      pointer: pointer({ pointerId: 10, clientX: 110, clientY: 70, buttons: 0 }),
      geometry,
      touchMode: true,
    });
    expect(tapUp.remoteEvents).toEqual([]);
    expect(tapUp.localEffect).toEqual({ kind: 'none' });
  });

  it('keeps zoomed floating single-finger local pan when suppression is omitted', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 14, clientX: 90, clientY: 50 }),
      geometry,
      zoomedProjection: true,
      touchMode: true,
    });
    expect(down.nextState.mode).toBe('localPan');
    expect(down.localEffect).toEqual({
      kind: 'local-pan-start',
      pointerId: 14,
      clientX: 90,
      clientY: 50,
    });
    expect(down.remoteEvents).toEqual([]);

    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 14, clientX: 120, clientY: 80 }),
      geometry,
      touchMode: true,
    });
    expect(move.nextState.mode).toBe('localPan');
    expect(move.localEffect).toEqual({
      kind: 'local-pan-move',
      pointerId: 14,
      deltaX: 30,
      deltaY: 30,
      moved: true,
    });
    expect(move.remoteEvents).toEqual([]);
  });

  it('suppresses zoomed single-finger hold without remote events or local pan', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 13, timeMs: 2_000 }),
      geometry,
      zoomedProjection: true,
      touchMode: true,
      suppressSingleFinger: true,
    });
    const hold = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 13, clientX: 120, clientY: 70, timeMs: 2_260 }),
      geometry,
      touchMode: true,
    });
    expect(hold.nextState.mode).toBe('actionPending');
    expect(hold.localEffect).toEqual({ kind: 'none' });
    expect(hold.remoteEvents).toEqual([]);
    const release = resolveRemoteWindowTouchPointerUpRuntime({
      state: hold.nextState,
      pointer: pointer({ pointerId: 13, clientX: 120, clientY: 70, buttons: 0, timeMs: 7_260 }),
      geometry,
      touchMode: true,
    });
    expect(release.remoteEvents).toEqual([]);
    expect(release.localEffect).toEqual({ kind: 'none' });
  });

  it('releases a remote drag on cancel', () => {
    const down = resolveRemoteWindowTouchPointerDownRuntime({
      state: createRemoteWindowTouchPointerState(),
      pointer: pointer({ pointerId: 11, clientX: 130, clientY: 90 }),
      geometry,
      zoomedProjection: false,
    });
    const move = resolveRemoteWindowTouchPointerMoveRuntime({
      state: down.nextState,
      pointer: pointer({ pointerId: 11, clientX: 130, clientY: 72, timeMs: 1_300 }),
      geometry,
      touchMode: true,
    });
    const cancel = resolveRemoteWindowTouchPointerCancelRuntime({
      state: move.nextState,
      pointer: pointer({ pointerId: 11, clientX: 130, clientY: 72, buttons: 0 }),
      geometry,
    });
    expect(cancel.nextState.mode).toBe('idle');
    expect(cancel.remoteEvents).toEqual([
      expect.objectContaining({ kind: 'pointer', phase: 'up', pointerId: 11, buttons: 0 }),
    ]);
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

    it('maps a touch drag to realtime scroll in touch mode', () => {
      const down = resolveRemoteWindowTouchPointerDownRuntime({
        state: createRemoteWindowTouchPointerState(),
        pointer: pointer({ clientX: 110, clientY: 70 }),
        geometry,
        zoomedProjection: false,
        touchMode: true,
      });
      const moveIntoDrag = resolveRemoteWindowTouchPointerMoveRuntime({
        state: down.nextState,
        pointer: pointer({ clientX: 110, clientY: 90, timeMs: 1_030 }),
        geometry,
        touchMode: true,
      });
      expect(moveIntoDrag.nextState.mode).toBe('actionScroll');
      expect(moveIntoDrag.remoteEvents).toEqual([expect.objectContaining({ kind: 'scroll' })]);

      const secondMove = resolveRemoteWindowTouchPointerMoveRuntime({
        state: moveIntoDrag.nextState,
        pointer: pointer({ clientX: 110, clientY: 110, timeMs: 1_050 }),
        geometry,
        touchMode: true,
        scrollFraction: 1,
      });
      expect(secondMove.nextState.mode).toBe('actionScroll');
      expect(secondMove.remoteEvents).toEqual([expect.objectContaining({ kind: 'scroll' })]);

      const up = resolveRemoteWindowTouchPointerUpRuntime({
        state: secondMove.nextState,
        pointer: pointer({ clientX: 110, clientY: 110, buttons: 0, timeMs: 1_060 }),
        geometry,
        touchMode: true,
      });
      expect(up.nextState.mode).toBe('idle');
      expect(up.remoteEvents).toEqual([]);
    });

    it('leaves long-press timing to the single overlay arena timer owner', () => {
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
      expect(longPress.nextState.mode).toBe('actionPending');
      expect(longPress.remoteEvents).toEqual([]);

      const up = resolveRemoteWindowTouchPointerUpRuntime({
        state: longPress.nextState,
        pointer: pointer({ clientX: 110, clientY: 70, buttons: 0, timeMs: 1_620 }),
        geometry,
        touchMode: true,
      });
      expect(up.nextState.mode).toBe('idle');
      expect(up.remoteEvents).toEqual([expect.objectContaining({ kind: 'click', button: 'left' })]);
    });

    it('does not emit a move action from a suppressed pending touch', () => {
      const move = resolveRemoteWindowTouchPointerMoveRuntime({
        state: {
          mode: 'actionPending',
          pointerId: 33,
          button: 'left',
          startClientX: 110,
          startClientY: 70,
          lastClientX: 110,
          lastClientY: 70,
          startAtMs: 1_000,
          suppressTap: true,
        },
        pointer: pointer({ pointerId: 33, clientX: 130, clientY: 90, timeMs: 1_010 }),
        geometry,
        touchMode: true,
      });

      expect(move.nextState).toEqual(expect.objectContaining({
        mode: 'actionPending',
        pointerId: 33,
        lastClientX: 130,
        lastClientY: 90,
        suppressTap: true,
      }));
      expect(move.remoteEvents).toEqual([]);
      expect(move.consumed).toBe(true);
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

    it('classifies the first sample after a second finger upgrades an active local pan', () => {
      const candidate = resolveRemoteWindowTouchPairPointerDownRuntime({
        firstPointer: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 60, timeMs: 1_000 },
        secondPointer: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 60, timeMs: 1_020 },
        timeMs: 1_020,
        pinchEnabled: true,
        scrollEnabled: true,
        skipObserve: true,
      });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeMs: 1_040 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 100, timeMs: 1_040 },
        },
        geometry,
        timeMs: 1_040,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(move.nextState.mode).toBe('twoFingerScroll');
      expect(move.remoteEvents[0]?.kind).toBe('scroll');
    });

    it('keeps axis-parallel upgraded motion available for pinch', () => {
      const candidate = resolveRemoteWindowTouchPairPointerDownRuntime({
        firstPointer: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 60, timeMs: 1_000 },
        secondPointer: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 60, timeMs: 1_020 },
        timeMs: 1_020,
        pinchEnabled: true,
        scrollEnabled: true,
        skipObserve: true,
      });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 140, clientY: 60, timeMs: 1_040 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 60, timeMs: 1_040 },
        },
        geometry,
        timeMs: 1_040,
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

    it.each([4, 5])('commits same-direction two-finger scroll with realistic %ipx samples', (step) => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      let state = candidate.nextState;
      const remoteEvents: Array<{ kind: string; deltaY?: number }> = [];

      for (let index = 1; index <= 10; index += 1) {
        const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
          state,
          pair: {
            first: {
              pointerId: 1,
              pointerType: 'touch',
              clientX: 100,
              clientY: 60 + step * index,
              timeMs: 1_000 + index * 10,
            },
            second: {
              pointerId: 2,
              pointerType: 'touch',
              clientX: 120,
              clientY: 60 + step * index,
              timeMs: 1_000 + index * 10,
            },
          },
          geometry,
          timeMs: 1_000 + index * 10,
          pinchEnabled: true,
          scrollEnabled: true,
        });
        state = move.nextState;
        remoteEvents.push(...move.remoteEvents);
      }

      expect(state.mode).toBe('twoFingerScroll');
      expect(remoteEvents.some((event) => event.kind === 'scroll')).toBe(true);
      // Commit fires once cumulative travel reaches the 8px threshold (sample 2),
      // and the start event must carry that accumulated travel rather than only
      // the last per-sample delta: raw 2*step px over a 100px surface onto a
      // 600px source => step * 12 wheel delta (below the 150px clamp).
      expect(remoteEvents[0]).toEqual(expect.objectContaining({ kind: 'scroll', deltaY: step * 12 }));
    });

    it('keeps interleaved two-finger samples proportional without double-counting travel', () => {
      const step = 4.444;
      const sampleCount = 18;
      const candidate = pairDown({ clientX: 100, clientY: 20 }, { clientX: 120, clientY: 20 });
      let state = candidate.nextState;
      const scrollEvents: Array<{ kind: string; deltaY?: number }> = [];

      for (let index = 1; index <= sampleCount; index += 1) {
        const firstY = 20 + step * index;
        const timeMs = 1_000 + index * 10;
        const firstMove = resolveRemoteWindowTouchPairPointerMoveRuntime({
          state,
          pair: {
            first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: firstY, timeMs },
            second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 20 + step * (index - 1), timeMs },
          },
          geometry,
          timeMs,
          pinchEnabled: true,
          scrollEnabled: true,
        });
        state = firstMove.nextState;
        scrollEvents.push(...firstMove.remoteEvents.filter((event) => event.kind === 'scroll'));

        const secondMove = resolveRemoteWindowTouchPairPointerMoveRuntime({
          state,
          pair: {
            first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: firstY, timeMs },
            second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: firstY, timeMs },
          },
          geometry,
          timeMs,
          pinchEnabled: true,
          scrollEnabled: true,
        });
        state = secondMove.nextState;
        scrollEvents.push(...secondMove.remoteEvents.filter((event) => event.kind === 'scroll'));
      }

      expect(state.mode).toBe('twoFingerScroll');
      expect(scrollEvents.length).toBeGreaterThanOrEqual(10);
      expect(scrollEvents.reduce((sum, event) => sum + (event.deltaY ?? 0), 0)).toBeCloseTo(step * sampleCount * 6);
    });

    it('emits the reversal when a committed two-finger scroll returns to its origin', () => {
      const candidate = pairDown({ clientX: 100, clientY: 20 }, { clientX: 120, clientY: 20 });
      let state = candidate.nextState;
      const scrollEvents: Array<{ kind: string; deltaY?: number }> = [];
      const move = (clientY: number, timeMs: number) => {
        const result = resolveRemoteWindowTouchPairPointerMoveRuntime({
          state,
          pair: {
            first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY, timeMs },
            second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY, timeMs },
          },
          geometry,
          timeMs,
          pinchEnabled: true,
          scrollEnabled: true,
        });
        state = result.nextState;
        scrollEvents.push(...result.remoteEvents.filter((event) => event.kind === 'scroll'));
      };

      // Commit downwards, then drag back up to the exact gesture origin.
      move(40, 1_100);
      move(30, 1_200);
      move(20, 1_300);

      expect(state.mode).toBe('twoFingerScroll');
      const total = scrollEvents.reduce((sum, event) => sum + (event.deltaY ?? 0), 0);
      // Net travel is zero, so the emitted scroll must cancel out. A start-relative
      // deadzone drops the return samples and leaves the remote target displaced.
      expect(total).toBeCloseTo(0);
      expect(scrollEvents.some((event) => (event.deltaY ?? 0) < 0)).toBe(true);
    });

    it('keeps a vertical two-finger swipe as scroll when finger spacing changes during the swipe', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const observe = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeMs: 1_050 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 100, timeMs: 1_050 },
        },
        geometry,
        timeMs: 1_050,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 90, clientY: 120, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 130, clientY: 120, timeMs: 1_200 },
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
      expect(move.localEffect).toEqual(expect.objectContaining({ kind: 'two-finger-scroll-start' }));
    });

    it('commits anti-parallel spacing change with vertical midpoint motion to local pinch', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 100, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 100, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
        scrollFraction: 1,
      });
      expect(move.nextState.mode).toBe('pinch');
      expect(move.remoteEvents).toEqual([]);
      expect(move.localEffect.kind).toBe('pinch-move');
      // 平局边界：共模（中点位移 40px）等于差模（间距变化 40px）时必须仍归
      // pinch。收紧成严格占优会让这条 anti-parallel 手势退回 remote scroll。
      const commonMode = Math.hypot(110 - 110, 100 - 60);
      const differential = Math.abs(60 - 20);
      expect(differential).toBe(commonMode);
    });

    it('accepts coherent horizontal-only and diagonal zoomed two-finger pan motion', () => {
      const horizontal = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const horizontalMove = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: horizontal.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 60, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 60, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
        panEnabled: true,
      });
      expect(horizontalMove.nextState.mode).toBe('twoFingerPan');
      expect(horizontalMove.remoteEvents).toEqual([]);
      expect(horizontalMove.localEffect.kind).toBe('local-pan-start');

      const diagonal = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const diagonalMove = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: diagonal.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 90, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 150, clientY: 90, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
        panEnabled: true,
      });
      expect(diagonalMove.nextState.mode).toBe('twoFingerPan');
      expect(diagonalMove.remoteEvents).toEqual([]);
      expect(diagonalMove.localEffect.kind).toBe('local-pan-start');
    });

    it('commits same-direction two-finger motion to remote scroll when local pan is disabled', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const observe = resolveRemoteWindowTouchPairPointerMoveRuntime({
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
      const commit = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 100, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(commit.nextState.mode).toBe('twoFingerScroll');
      expect(commit.remoteEvents[0]?.kind).toBe('scroll');
      expect(commit.localEffect).toEqual(expect.objectContaining({ kind: 'two-finger-scroll-start' }));
    });

    it('commits zoomed same-direction two-finger motion to local pan without remote events', () => {
      const candidate = pairDown({ clientX: 100, clientY: 100 }, { clientX: 140, clientY: 100 });
      const observe = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 108, clientY: 104, timeMs: 1_050 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 148, clientY: 104, timeMs: 1_050 },
        },
        geometry,
        timeMs: 1_050,
        pinchEnabled: true,
        scrollEnabled: true,
        panEnabled: true,
      });
      const observe2 = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 112, clientY: 106, timeMs: 1_060 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 152, clientY: 106, timeMs: 1_060 },
        },
        geometry,
        timeMs: 1_060,
        pinchEnabled: true,
        scrollEnabled: true,
        panEnabled: true,
      });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: observe2.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 130, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 170, clientY: 130, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
        panEnabled: true,
      });
      // Cumulative travel commits the pan one sample earlier, so the pan-start is
      // emitted on `observe2`; the gesture-level contract is what matters here:
      // exactly one local-pan-start across the gesture, no remote events.
      expect(move.nextState.mode).toBe('twoFingerPan');
      expect(move.remoteEvents).toEqual([]);
      expect([observe.localEffect, observe2.localEffect, move.localEffect].filter(
        (effect) => effect.kind === 'local-pan-start',
      )).toHaveLength(1);
    });

    it('commits zoomed vertical two-finger motion to local pan when enabled', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 140, clientY: 60 });
      const moved = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 140, clientY: 100, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
        panEnabled: true,
        scrollFraction: 1,
      });
      expect(moved.nextState.mode).toBe('twoFingerPan');
      expect(moved.remoteEvents).toEqual([]);
      expect(moved.localEffect.kind).toBe('local-pan-start');
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

    it('keeps dominant vertical movement as scroll when finger spacing only jitters', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 99, clientY: 120, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 121, clientY: 120, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(move.nextState.mode).toBe('twoFingerScroll');
      expect(move.remoteEvents[0]?.kind).toBe('scroll');
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

    it('does not commit pinch when the two-finger center travels with the gesture', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 140, clientY: 60 });
      const move = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 70, clientY: 130, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 130, clientY: 130, timeMs: 1_200 },
        },
        geometry,
        timeMs: 1_200,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(move.nextState.mode).toBe('twoFingerScroll');
      expect(move.localEffect.kind).toBe('two-finger-scroll-start');
    });

    it('locks committed two-finger scroll and cannot switch to pinch mid-sequence', () => {
      const state = {
        mode: 'twoFingerScroll' as const,
        firstPointerId: 1,
        secondPointerId: 2,
        firstStart: { clientX: 100, clientY: 60 },
        secondStart: { clientX: 120, clientY: 60 },
        startDistance: 20,
        startMidX: 110,
        startMidY: 60,
        lastMidX: 110,
        lastMidY: 100,
        startedAtMs: 1_000,
        committed: true as const,
      };
      const moved = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 70, clientY: 100, timeMs: 1_300 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 150, clientY: 100, timeMs: 1_300 },
        },
        geometry,
        timeMs: 1_300,
        pinchEnabled: true,
        scrollEnabled: true,
      });
      expect(moved.nextState.mode).toBe('twoFingerScroll');
      expect(moved.localEffect.kind).not.toBe('pinch-move');
    });

    it('keeps emitting a committed scroll when an interleaved sample also changes finger distance', () => {
      const candidate = pairDown({ clientX: 100, clientY: 60 }, { clientX: 120, clientY: 60 });
      const commit = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: candidate.nextState,
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
      expect(commit.nextState.mode).toBe('twoFingerScroll');
      expect(commit.remoteEvents).toEqual([
        expect.objectContaining({ kind: 'scroll', deltaX: 0, deltaY: 240 }),
      ]);

      const interleavedDistanceChange = resolveRemoteWindowTouchPairPointerMoveRuntime({
        state: commit.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 110, timeMs: 1_300 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 100, timeMs: 1_300 },
        },
        geometry,
        timeMs: 1_300,
        pinchEnabled: true,
        scrollEnabled: true,
        scrollFraction: 1,
      });
      expect(interleavedDistanceChange.remoteEvents).toEqual([
        expect.objectContaining({
          kind: 'scroll',
          deltaX: -40,
          deltaY: 30,
        }),
      ]);
      expect(interleavedDistanceChange.nextState).toEqual(expect.objectContaining({
        mode: 'twoFingerScroll',
        lastMidX: 100,
        lastMidY: 105,
      }));

      const release = resolveRemoteWindowTouchPairPointerUpRuntime({
        state: interleavedDistanceChange.nextState,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 118, timeMs: 1_340 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 100, timeMs: 1_340 },
        },
        geometry,
        remainingPointer: null,
        timeMs: 1_340,
      });

      expect(release.remoteEvents).toEqual([]);
      expect(release.localEffect.kind).toBe('two-finger-scroll-end');
      expect(release.nextState.mode).toBe('idle');
    });

    it('returns the remaining unzoomed direct-touch pointer to remote action, not local pan', () => {
      const state = {
        mode: 'twoFingerScroll' as const,
        firstPointerId: 1,
        secondPointerId: 2,
        firstStart: { clientX: 100, clientY: 60 },
        secondStart: { clientX: 120, clientY: 60 },
        startDistance: 20,
        startMidX: 110,
        startMidY: 60,
        lastMidX: 110,
        lastMidY: 90,
        startedAtMs: 1_000,
        committed: true as const,
      };
      const result = resolveRemoteWindowTouchPairPointerUpRuntime({
        state,
        pair: {
          first: { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 90, timeMs: 1_200 },
          second: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 90, timeMs: 1_200 },
        },
        geometry,
        remainingPointer: { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 90, timeMs: 1_200 },
        timeMs: 1_200,
        remainingPointerMode: 'remote-action',
      });
      expect(result.nextState.mode).toBe('actionPending');
      expect(result.nextState).toEqual(expect.objectContaining({ suppressTap: true }));
      expect(result.remoteEvents).toEqual([]);
    });
  });
});
