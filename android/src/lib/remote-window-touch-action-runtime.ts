import type {
  RemoteWindowInputEventPayload,
  RemoteWindowStreamRect,
  RemoteWindowStreamTargetManifest,
} from './types';

export type RemoteWindowTouchActionSource =
  | 'overlay'
  | 'quickbar-sequence'
  | 'quickbar-draft'
  | 'ime-input'
  | 'ime-backspace'
  | 'ime-key'
  | 'debug-input';

export interface RemoteWindowTouchSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RemoteWindowTouchSurfaceGeometry {
  surfaceRect: RemoteWindowTouchSurfaceRect;
  contentRect: RemoteWindowTouchSurfaceRect;
  sourceRect: RemoteWindowStreamRect;
}

export interface RemoteWindowTouchPointerSample {
  pointerId: number;
  pointerType: 'mouse' | 'pen' | 'touch' | string;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  timeMs: number;
}

export interface RemoteWindowTouchSurfacePoint {
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
}

export type RemoteWindowTouchPointerState =
  | { mode: 'idle' }
  | {
      mode: 'actionPending';
      pointerId: number;
      button: 'left' | 'middle' | 'right';
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
      startAtMs: number;
    }
  | {
      mode: 'actionScroll';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
      startAtMs: number;
    }
  | {
      mode: 'actionLongPress';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startAtMs: number;
    }
  | {
      mode: 'actionDrag';
      pointerId: number;
      button: 'left' | 'middle' | 'right';
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
      startAtMs: number;
    }
  | {
      mode: 'twoFingerCandidate';
      firstPointerId: number;
      secondPointerId: number;
      firstStart: { clientX: number; clientY: number };
      secondStart: { clientX: number; clientY: number };
      startDistance: number;
      startMidX: number;
      startMidY: number;
      lastMidX: number;
      lastMidY: number;
      startedAtMs: number;
      moveCount: number;
      committed: false;
    }
  | {
      mode: 'twoFingerScroll';
      firstPointerId: number;
      secondPointerId: number;
      firstStart: { clientX: number; clientY: number };
      secondStart: { clientX: number; clientY: number };
      startDistance: number;
      startMidX: number;
      startMidY: number;
      lastMidX: number;
      lastMidY: number;
      startedAtMs: number;
      committed: true;
    }
  | {
      mode: 'pinch';
      firstPointerId: number;
      secondPointerId: number;
      firstStart: { clientX: number; clientY: number };
      secondStart: { clientX: number; clientY: number };
      startDistance: number;
      startMidX: number;
      startMidY: number;
      startedAtMs: number;
      lastMidX: number;
      lastMidY: number;
      lastScaleRatio: number;
      committed: true;
    }
  | {
      mode: 'localPan';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      moved: boolean;
    };

export type RemoteWindowTouchLocalEffect =
  | {
      kind: 'none';
    }
  | {
      kind: 'local-pan-start';
      pointerId: number;
      clientX: number;
      clientY: number;
    }
  | {
      kind: 'local-pan-move';
      pointerId: number;
      deltaX: number;
      deltaY: number;
      moved: boolean;
    }
  | {
      kind: 'local-pan-end';
      pointerId: number;
      moved: boolean;
    }
  | {
      kind: 'two-finger-scroll-start';
      pointerId: number;
    }
  | {
      kind: 'two-finger-scroll-move';
      pointerId: number;
      deltaX: number;
      deltaY: number;
      commit: boolean;
    }
  | {
      kind: 'two-finger-scroll-end';
      pointerId: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      kind: 'pinch-start';
      pointerId: number;
    }
  | {
      kind: 'pinch-move';
      pointerId: number;
      scaleRatio: number;
      anchorClientX: number;
      anchorClientY: number;
      commit: boolean;
    }
  | {
      kind: 'pinch-end';
      pointerId: number;
      scaleRatio: number;
    };

export interface RemoteWindowTouchPairPointerSample {
  pointerId: number;
  pointerType: 'mouse' | 'pen' | 'touch' | string;
  clientX: number;
  clientY: number;
  timeMs: number;
}

export interface RemoteWindowTouchPairPointerState {
  first: RemoteWindowTouchPairPointerSample;
  second: RemoteWindowTouchPairPointerSample;
}

export interface RemoteWindowTouchPairRuntimeOptions {
  state: RemoteWindowTouchPointerState;
  pair: RemoteWindowTouchPairPointerState;
  geometry: RemoteWindowTouchSurfaceGeometry;
  timeMs: number;
  scrollFraction?: number;
  invertGestureDirection?: boolean;
  pinchEnabled: boolean;
  scrollEnabled: boolean;
}

export interface RemoteWindowTouchPairRuntimeResult {
  nextState: RemoteWindowTouchPointerState;
  remoteEvents: Array<RemoteWindowInputEventPayload['event']>;
  localEffect: RemoteWindowTouchLocalEffect;
  consumed: boolean;
}

export interface RemoteWindowTouchPointerRuntimeResult {
  nextState: RemoteWindowTouchPointerState;
  remoteEvents: Array<RemoteWindowInputEventPayload['event']>;
  localEffect: RemoteWindowTouchLocalEffect;
  consumed: boolean;
}

const REMOTE_WINDOW_TOUCH_DRAG_THRESHOLD_PX = 8;
const REMOTE_WINDOW_LOCAL_PAN_TAP_THRESHOLD_PX = 8;
const REMOTE_WINDOW_INPUT_STALE_MS = 1_000;
const REMOTE_WINDOW_TWO_FINGER_SCROLL_DEADZONE_PX = 4;
export const REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION = 0.25;
export const REMOTE_WINDOW_TOUCH_SCROLL_MIN_FRACTION = 0.125;
export const REMOTE_WINDOW_TOUCH_SCROLL_MAX_FRACTION = 1;
export const REMOTE_WINDOW_TWO_FINGER_OBSERVE_MS = 120;
export const REMOTE_WINDOW_TWO_FINGER_OBSERVE_MOVES = 1;
export const REMOTE_WINDOW_TWO_FINGER_PINCH_MIN_SCALE_RATIO = 0.08;
export const REMOTE_WINDOW_TWO_FINGER_SCROLL_MIN_MIDPOINT_PX = 8;
export const REMOTE_WINDOW_LONG_PRESS_MS = 500;

export interface RemoteWindowTouchGestureTuning {
  fraction?: number;
  inverted?: boolean;
}

export interface RemoteWindowTouchInputAction {
  source: RemoteWindowTouchActionSource;
  sessionId: string | null;
  streamId: string | null;
  target: RemoteWindowStreamTargetManifest | null;
  event: RemoteWindowInputEventPayload['event'];
}

export interface RemoteWindowTouchInputDebugEvent {
  source: RemoteWindowTouchActionSource;
  sent: boolean;
  sessionId: string | null;
  streamId: string | null;
  targetId: string | null;
  targetTitle: string | null;
  surfaceId?: string;
  webViewId?: string;
  event: RemoteWindowInputEventPayload['event'];
}

export interface RemoteWindowTouchInputDispatchResult {
  sent: boolean;
  reason?: 'missing-context' | 'unsupported-target' | 'missing-dispatcher';
}

export function isRemoteWindowInputSupportedTarget(target: RemoteWindowStreamTargetManifest) {
  return target.streamMode === 'interactive'
    && target.videoTarget.kind === 'app-window'
    && target.inputTarget.kind === 'app-window'
    && target.inputRoute === 'os-event'
    && target.focusPolicy === 'bring-to-focus';
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveRemoteWindowTouchScrollFractionRuntime(fraction?: number) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    return REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION;
  }
  return clampNumber(
    fraction,
    REMOTE_WINDOW_TOUCH_SCROLL_MIN_FRACTION,
    REMOTE_WINDOW_TOUCH_SCROLL_MAX_FRACTION,
  );
}

export function resolveRemoteWindowTouchScrollDeltaRuntime(
  sourceDelta: number,
  visibleSizePx: number,
  tuning: RemoteWindowTouchGestureTuning = {},
) {
  if (
    !Number.isFinite(sourceDelta)
    || sourceDelta === 0
    || !Number.isFinite(visibleSizePx)
    || visibleSizePx <= 0
  ) {
    return 0;
  }
  const direction = tuning.inverted ? -1 : 1;
  return Math.sign(sourceDelta)
    * visibleSizePx
    * resolveRemoteWindowTouchScrollFractionRuntime(tuning.fraction)
    * direction;
}

export function resolveRemoteWindowTouchWheelDeltaRuntime(
  sourceDelta: number,
  surfaceSizePx: number,
  visibleSizePx: number,
  tuning: RemoteWindowTouchGestureTuning = {},
) {
  if (
    !Number.isFinite(sourceDelta)
    || sourceDelta === 0
    || !Number.isFinite(surfaceSizePx)
    || surfaceSizePx <= 0
    || !Number.isFinite(visibleSizePx)
    || visibleSizePx <= 0
  ) {
    return 0;
  }
  const direction = tuning.inverted ? -1 : 1;
  const maxDelta = visibleSizePx * resolveRemoteWindowTouchScrollFractionRuntime(tuning.fraction);
  const proportionalDelta = (sourceDelta / surfaceSizePx) * visibleSizePx * direction;
  return clampNumber(proportionalDelta, -maxDelta, maxDelta);
}

function emptyResult(
  nextState: RemoteWindowTouchPointerState,
  consumed = false,
): RemoteWindowTouchPointerRuntimeResult {
  return {
    nextState,
    remoteEvents: [],
    localEffect: { kind: 'none' },
    consumed,
  };
}

function withRemoteEvents(
  nextState: RemoteWindowTouchPointerState,
  remoteEvents: Array<RemoteWindowInputEventPayload['event']>,
): RemoteWindowTouchPointerRuntimeResult {
  return {
    nextState,
    remoteEvents,
    localEffect: { kind: 'none' },
    consumed: true,
  };
}

function withLocalEffect(
  nextState: RemoteWindowTouchPointerState,
  localEffect: RemoteWindowTouchLocalEffect,
): RemoteWindowTouchPointerRuntimeResult {
  return {
    nextState,
    remoteEvents: [],
    localEffect,
    consumed: true,
  };
}

function mapMouseButton(button: number): 'left' | 'middle' | 'right' | 'none' {
  if (button === 0) {
    return 'left';
  }
  if (button === 1) {
    return 'middle';
  }
  if (button === 2) {
    return 'right';
  }
  return 'none';
}

export function createRemoteWindowTouchPointerState(): RemoteWindowTouchPointerState {
  return { mode: 'idle' };
}

export function resolveRemoteWindowTouchSurfacePointRuntime(
  geometry: RemoteWindowTouchSurfaceGeometry,
  clientX: number,
  clientY: number,
): RemoteWindowTouchSurfacePoint | null {
  const { surfaceRect, contentRect, sourceRect } = geometry;
  if (
    !Number.isFinite(surfaceRect.left)
    || !Number.isFinite(surfaceRect.top)
    || !Number.isFinite(surfaceRect.width)
    || !Number.isFinite(surfaceRect.height)
    || !Number.isFinite(contentRect.left)
    || !Number.isFinite(contentRect.top)
    || !Number.isFinite(contentRect.width)
    || !Number.isFinite(contentRect.height)
    || !Number.isFinite(sourceRect.x)
    || !Number.isFinite(sourceRect.y)
    || !Number.isFinite(sourceRect.width)
    || !Number.isFinite(sourceRect.height)
    || surfaceRect.width <= 0
    || surfaceRect.height <= 0
    || contentRect.width <= 0
    || contentRect.height <= 0
    || sourceRect.width <= 0
    || sourceRect.height <= 0
  ) {
    return null;
  }
  const normalizedX = clampNumber(
    (clientX - surfaceRect.left - contentRect.left) / Math.max(1, contentRect.width),
    0,
    1,
  );
  const normalizedY = clampNumber(
    (clientY - surfaceRect.top - contentRect.top) / Math.max(1, contentRect.height),
    0,
    1,
  );
  return {
    x: sourceRect.x + normalizedX * sourceRect.width,
    y: sourceRect.y + normalizedY * sourceRect.height,
    normalizedX,
    normalizedY,
  };
}

export function buildRemoteWindowPointerInputEventRuntime(options: {
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
  phase: 'move' | 'down' | 'up';
  button?: 'left' | 'middle' | 'right' | 'none';
  buttons?: number;
}): RemoteWindowInputEventPayload['event'] | null {
  const { pointer, geometry, phase } = options;
  const point = resolveRemoteWindowTouchSurfacePointRuntime(
    geometry,
    pointer.clientX,
    pointer.clientY,
  );
  if (!point) {
    return null;
  }
  return {
    kind: 'pointer',
    phase,
    pointerId: pointer.pointerId,
    button: options.button ?? mapMouseButton(pointer.button),
    buttons: options.buttons ?? pointer.buttons,
    ...point,
  };
}

export function buildRemoteWindowClickInputEventRuntime(options: {
  pointerId: number;
  clientX: number;
  clientY: number;
  geometry: RemoteWindowTouchSurfaceGeometry;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
}): RemoteWindowInputEventPayload['event'] | null {
  const point = resolveRemoteWindowTouchSurfacePointRuntime(
    options.geometry,
    options.clientX,
    options.clientY,
  );
  if (!point) {
    return null;
  }
  return {
    kind: 'click',
    pointerId: options.pointerId,
    button: options.button ?? 'left',
    clickCount: options.clickCount ?? 1,
    ...point,
  };
}

function buildClickAtPointEvents(options: {
  pointerId: number;
  clientX: number;
  clientY: number;
  geometry: RemoteWindowTouchSurfaceGeometry;
  button?: 'left' | 'middle' | 'right';
}): Array<RemoteWindowInputEventPayload['event']> {
  const clickEvent = buildRemoteWindowClickInputEventRuntime(options);
  return clickEvent ? [clickEvent] : [];
}

export function buildRemoteWindowTouchGestureSwipeEventRuntime(options: {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  endClientX: number;
  endClientY: number;
  startTimeMs: number;
  endTimeMs: number;
  geometry: RemoteWindowTouchSurfaceGeometry;
  scrollFraction?: number;
  invertGestureDirection?: boolean;
  deltaMode?: 'fraction' | 'proportional';
}): RemoteWindowInputEventPayload['event'] | null {
  const startPoint = resolveRemoteWindowTouchSurfacePointRuntime(
    options.geometry,
    options.startClientX,
    options.startClientY,
  );
  const endPoint = resolveRemoteWindowTouchSurfacePointRuntime(
    options.geometry,
    options.endClientX,
    options.endClientY,
  );
  if (!startPoint || !endPoint) {
    return null;
  }
  const rawDeltaX = options.endClientX - options.startClientX;
  const rawDeltaY = options.endClientY - options.startClientY;
  if (rawDeltaX === 0 && rawDeltaY === 0) {
    return null;
  }
  const tuning = {
    fraction: options.scrollFraction,
    inverted: options.invertGestureDirection,
  };
  const deltaX = options.deltaMode === 'proportional'
    ? resolveRemoteWindowTouchWheelDeltaRuntime(
        rawDeltaX,
        options.geometry.surfaceRect.width,
        options.geometry.sourceRect.width,
        tuning,
      )
    : resolveRemoteWindowTouchScrollDeltaRuntime(rawDeltaX, options.geometry.sourceRect.width, tuning);
  const deltaY = options.deltaMode === 'proportional'
    ? resolveRemoteWindowTouchWheelDeltaRuntime(
        rawDeltaY,
        options.geometry.surfaceRect.height,
        options.geometry.sourceRect.height,
        tuning,
      )
    : resolveRemoteWindowTouchScrollDeltaRuntime(rawDeltaY, options.geometry.sourceRect.height, tuning);
  const durationMs = Math.max(1, options.endTimeMs - options.startTimeMs);
  return {
    kind: 'gesture',
    gesture: 'swipe',
    phase: 'end',
    unit: 'pixel',
    pointerId: options.pointerId,
    startX: startPoint.x,
    startY: startPoint.y,
    x: endPoint.x,
    y: endPoint.y,
    startNormalizedX: startPoint.normalizedX,
    startNormalizedY: startPoint.normalizedY,
    normalizedX: endPoint.normalizedX,
    normalizedY: endPoint.normalizedY,
    deltaX,
    deltaY,
    durationMs,
    velocityX: deltaX / durationMs,
    velocityY: deltaY / durationMs,
  };
}

export function resolveRemoteWindowTouchPointerDownRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
  zoomedProjection: boolean;
  touchMode?: boolean;
}): RemoteWindowTouchPointerRuntimeResult {
  const { pointer } = options;
  if (pointer.pointerType === 'mouse' && pointer.button > 2) {
    return emptyResult(options.state, false);
  }
  const button = pointer.pointerType === 'touch' ? 'left' : mapMouseButton(pointer.button);
  if (button === 'none') {
    return emptyResult(options.state, false);
  }
  if (options.zoomedProjection && pointer.pointerType === 'touch') {
    return withLocalEffect(
      {
        mode: 'localPan',
        pointerId: pointer.pointerId,
        startClientX: pointer.clientX,
        startClientY: pointer.clientY,
        moved: false,
      },
      {
        kind: 'local-pan-start',
        pointerId: pointer.pointerId,
        clientX: pointer.clientX,
        clientY: pointer.clientY,
      },
    );
  }
  return emptyResult({
    mode: 'actionPending',
    pointerId: pointer.pointerId,
    button,
    startClientX: pointer.clientX,
    startClientY: pointer.clientY,
    lastClientX: pointer.clientX,
    lastClientY: pointer.clientY,
    startAtMs: pointer.timeMs,
  }, true);
}

export function resolveRemoteWindowTouchPointerMoveRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
  touchMode?: boolean;
  scrollFraction?: number;
  invertGestureDirection?: boolean;
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer } = options;
  if (state.mode === 'actionPending' && state.pointerId === pointer.pointerId) {
    const totalDeltaX = pointer.clientX - state.startClientX;
    const totalDeltaY = pointer.clientY - state.startClientY;
    if (Math.hypot(totalDeltaX, totalDeltaY) < REMOTE_WINDOW_TOUCH_DRAG_THRESHOLD_PX) {
      // 触控模式长按（>500ms 不动）→ 右键（仅 touch 指针）
      if (options.touchMode && pointer.pointerType === 'touch' && pointer.timeMs - state.startAtMs >= REMOTE_WINDOW_LONG_PRESS_MS) {
        const rightClick = buildRemoteWindowClickInputEventRuntime({
          pointerId: state.pointerId,
          clientX: pointer.clientX,
          clientY: pointer.clientY,
          geometry: options.geometry,
          button: 'right',
        });
        return withRemoteEvents(
          {
            mode: 'actionLongPress',
            pointerId: state.pointerId,
            startClientX: state.startClientX,
            startClientY: state.startClientY,
            startAtMs: state.startAtMs,
          },
          rightClick ? [rightClick] : [],
        );
      }
      return emptyResult({
        ...state,
        lastClientX: pointer.clientX,
        lastClientY: pointer.clientY,
      }, true);
    }
    if (options.touchMode && pointer.pointerType === 'touch') {
      // 触控模式单指拖动 = 远程滚动（注入 scroll action，不模拟鼠标拖拽）；
      // 转移时即发首帧 scroll（start → current），后续 move 发增量
      const rawDeltaX = pointer.clientX - state.startClientX;
      const rawDeltaY = pointer.clientY - state.startClientY;
      const { deltaX, deltaY } = resolveRemoteWindowPairScrollDeltaRuntime({
        rawDeltaX,
        rawDeltaY,
        surfaceRect: {
          width: options.geometry.surfaceRect.width,
          height: options.geometry.surfaceRect.height,
        },
        sourceRect: {
          width: options.geometry.sourceRect.width,
          height: options.geometry.sourceRect.height,
        },
        scrollFraction: options.scrollFraction ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION,
        inverted: options.invertGestureDirection ?? false,
      });
      const nextState = {
        mode: 'actionScroll',
        pointerId: state.pointerId,
        startClientX: state.startClientX,
        startClientY: state.startClientY,
        lastClientX: pointer.clientX,
        lastClientY: pointer.clientY,
        startAtMs: state.startAtMs,
      } as const;
      if (deltaX === 0 && deltaY === 0) {
        return withRemoteEvents(nextState, []);
      }
      const point = resolveRemoteWindowPairPointerGeometry({
        geometry: options.geometry,
        clientX: pointer.clientX,
        clientY: pointer.clientY,
      });
      if (!point) {
        return withRemoteEvents(nextState, []);
      }
      return withRemoteEvents(
        nextState,
        [{
          kind: 'scroll',
          unit: 'pixel',
          deltaX,
          deltaY,
          x: point.x,
          y: point.y,
          normalizedX: point.normalizedX,
          normalizedY: point.normalizedY,
        }],
      );
    }
    return withRemoteEvents(
      {
        mode: 'actionDrag',
        pointerId: state.pointerId,
        button: state.button,
        startClientX: state.startClientX,
        startClientY: state.startClientY,
        lastClientX: pointer.clientX,
        lastClientY: pointer.clientY,
        startAtMs: state.startAtMs,
      },
      [],
    );
  }

  if (state.mode === 'actionScroll' && state.pointerId === pointer.pointerId) {
    if (pointer.clientX === state.lastClientX && pointer.clientY === state.lastClientY) {
      return emptyResult(state, true);
    }
    const rawDeltaX = pointer.clientX - state.lastClientX;
    const rawDeltaY = pointer.clientY - state.lastClientY;
    const { deltaX, deltaY } = resolveRemoteWindowPairScrollDeltaRuntime({
      rawDeltaX,
      rawDeltaY,
      surfaceRect: {
        width: options.geometry.surfaceRect.width,
        height: options.geometry.surfaceRect.height,
      },
      sourceRect: {
        width: options.geometry.sourceRect.width,
        height: options.geometry.sourceRect.height,
      },
      scrollFraction: options.scrollFraction ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION,
      inverted: options.invertGestureDirection ?? false,
    });
    const nextState = {
      ...state,
      lastClientX: pointer.clientX,
      lastClientY: pointer.clientY,
    };
    if (deltaX === 0 && deltaY === 0) {
      return emptyResult(nextState, true);
    }
    const point = resolveRemoteWindowPairPointerGeometry({
      geometry: options.geometry,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
    });
    if (!point) {
      return emptyResult(nextState, true);
    }
    return withRemoteEvents(
      nextState,
      [{
        kind: 'scroll',
        unit: 'pixel',
        deltaX,
        deltaY,
        x: point.x,
        y: point.y,
        normalizedX: point.normalizedX,
        normalizedY: point.normalizedY,
        moveCursor: false,
      }],
    );
  }

  if (state.mode === 'actionLongPress' && state.pointerId === pointer.pointerId) {
    return emptyResult(state, true);
  }

  if (state.mode === 'actionDrag' && state.pointerId === pointer.pointerId) {
    if (pointer.clientX === state.lastClientX && pointer.clientY === state.lastClientY) {
      return emptyResult(state, true);
    }
    return withRemoteEvents(
      {
        ...state,
        lastClientX: pointer.clientX,
        lastClientY: pointer.clientY,
      },
      [],
    );
  }

  if (state.mode === 'localPan' && state.pointerId === pointer.pointerId) {
    const deltaX = pointer.clientX - state.startClientX;
    const deltaY = pointer.clientY - state.startClientY;
    const moved = state.moved || Math.hypot(deltaX, deltaY) > REMOTE_WINDOW_LOCAL_PAN_TAP_THRESHOLD_PX;
    return withLocalEffect(
      {
        ...state,
        moved,
      },
      {
        kind: 'local-pan-move',
        pointerId: state.pointerId,
        deltaX,
        deltaY,
        moved,
      },
    );
  }

  return emptyResult(state, false);
}

export function resolveRemoteWindowTouchPointerUpRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
  scrollFraction?: number;
  invertGestureDirection?: boolean;
  touchMode?: boolean;
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer, geometry } = options;
  const idle = createRemoteWindowTouchPointerState();
  if (state.mode === 'actionPending' && state.pointerId === pointer.pointerId) {
    if (pointer.timeMs - state.startAtMs > REMOTE_WINDOW_INPUT_STALE_MS) {
      return emptyResult(idle, true);
    }
    return withRemoteEvents(
      idle,
      buildClickAtPointEvents({
        pointerId: state.pointerId,
        clientX: pointer.clientX,
        clientY: pointer.clientY,
        geometry,
        button: state.button,
      }),
    );
  }

  if (state.mode === 'actionLongPress' && state.pointerId === pointer.pointerId) {
    // 长按已发右键，抬起不重复注入
    return emptyResult(idle, true);
  }

  if (state.mode === 'actionScroll' && state.pointerId === pointer.pointerId) {
    // 单指滚动已增量注入，抬起收尾
    return emptyResult(idle, true);
  }

  if (state.mode === 'actionDrag' && state.pointerId === pointer.pointerId) {
    if (pointer.timeMs - state.startAtMs > REMOTE_WINDOW_INPUT_STALE_MS) {
      return emptyResult(idle, true);
    }
    const clientX = Number.isFinite(pointer.clientX) ? pointer.clientX : state.lastClientX;
    const clientY = Number.isFinite(pointer.clientY) ? pointer.clientY : state.lastClientY;
    const event = buildRemoteWindowTouchGestureSwipeEventRuntime({
      pointerId: state.pointerId,
      startClientX: state.startClientX,
      startClientY: state.startClientY,
      endClientX: clientX,
      endClientY: clientY,
      startTimeMs: state.startAtMs,
      endTimeMs: pointer.timeMs,
      geometry,
      scrollFraction: options.scrollFraction,
      invertGestureDirection: options.invertGestureDirection,
    });
    return withRemoteEvents(
      idle,
      event ? [event] : [],
    );
  }

  if (state.mode === 'localPan' && state.pointerId === pointer.pointerId) {
    if (!state.moved) {
      return {
        nextState: idle,
        remoteEvents: buildClickAtPointEvents({
          pointerId: state.pointerId,
          clientX: pointer.clientX,
          clientY: pointer.clientY,
          geometry,
        }),
        localEffect: {
          kind: 'local-pan-end',
          pointerId: state.pointerId,
          moved: false,
        },
        consumed: true,
      };
    }
    return withLocalEffect(
      idle,
      {
        kind: 'local-pan-end',
        pointerId: state.pointerId,
        moved: true,
      },
    );
  }

  return emptyResult(state, false);
}

function resolveRemoteWindowPairPointerGeometry(options: {
  geometry: RemoteWindowTouchSurfaceGeometry;
  clientX: number;
  clientY: number;
}) {
  const point = resolveRemoteWindowTouchSurfacePointRuntime(
    options.geometry,
    options.clientX,
    options.clientY,
  );
  if (!point) {
    return null;
  }
  return point;
}

function resolveRemoteWindowPairScrollDeltaRuntime(options: {
  rawDeltaX: number;
  rawDeltaY: number;
  surfaceRect: { width: number; height: number };
  sourceRect: { width: number; height: number };
  scrollFraction: number;
  inverted: boolean;
}) {
  const { rawDeltaY, surfaceRect, sourceRect } = options;
  if (rawDeltaY === 0) {
    return { deltaX: 0, deltaY: 0 };
  }
  const tuning = {
    fraction: options.scrollFraction,
    inverted: options.inverted,
  };
  const deltaX = 0;
  const deltaY = resolveRemoteWindowTouchWheelDeltaRuntime(
    rawDeltaY,
    surfaceRect.height,
    sourceRect.height,
    tuning,
  );
  return { deltaX, deltaY };
}

function buildRemoteWindowTwoFingerScrollEventsRuntime(options: {
  geometry: RemoteWindowTouchSurfaceGeometry;
  midClientX: number;
  midClientY: number;
  rawDeltaX: number;
  rawDeltaY: number;
  scrollFraction: number;
  inverted: boolean;
}): Array<RemoteWindowInputEventPayload['event']> {
  const { deltaX, deltaY } = resolveRemoteWindowPairScrollDeltaRuntime({
    rawDeltaX: options.rawDeltaX,
    rawDeltaY: options.rawDeltaY,
    surfaceRect: {
      width: options.geometry.surfaceRect.width,
      height: options.geometry.surfaceRect.height,
    },
    sourceRect: {
      width: options.geometry.sourceRect.width,
      height: options.geometry.sourceRect.height,
    },
    scrollFraction: options.scrollFraction,
    inverted: options.inverted,
  });
  if (deltaX === 0 && deltaY === 0) {
    return [];
  }
  const point = resolveRemoteWindowPairPointerGeometry({
    geometry: options.geometry,
    clientX: options.midClientX,
    clientY: options.midClientY,
  });
  if (!point) {
    return [];
  }
  return [{
    kind: 'scroll',
    unit: 'pixel',
    deltaX,
    deltaY,
    x: point.x,
    y: point.y,
    normalizedX: point.normalizedX,
    normalizedY: point.normalizedY,
    moveCursor: false,
  }];
}

function resolvePointerProjectionRatio(options: {
  start: { clientX: number; clientY: number };
  current: { clientX: number; clientY: number };
  axisStart: { clientX: number; clientY: number };
  axisEnd: { clientX: number; clientY: number };
}) {
  const axisX = options.axisEnd.clientX - options.axisStart.clientX;
  const axisY = options.axisEnd.clientY - options.axisStart.clientY;
  const axisLength = Math.max(1, Math.hypot(axisX, axisY));
  const deltaX = options.current.clientX - options.start.clientX;
  const deltaY = options.current.clientY - options.start.clientY;
  return (deltaX * axisX + deltaY * axisY) / axisLength;
}

function isPinchIntentPair(options: {
  firstStart: { clientX: number; clientY: number };
  firstCurrent: { clientX: number; clientY: number };
  secondStart: { clientX: number; clientY: number };
  secondCurrent: { clientX: number; clientY: number };
  scaleRatio: number;
}) {
  if (Math.abs(options.scaleRatio - 1) < REMOTE_WINDOW_TWO_FINGER_PINCH_MIN_SCALE_RATIO) {
    return false;
  }
  const firstProjection = resolvePointerProjectionRatio({
    start: options.firstStart,
    current: options.firstCurrent,
    axisStart: options.firstStart,
    axisEnd: options.secondStart,
  });
  const secondProjection = resolvePointerProjectionRatio({
    start: options.secondStart,
    current: options.secondCurrent,
    axisStart: options.firstStart,
    axisEnd: options.secondStart,
  });
  if (Math.abs(firstProjection) < REMOTE_WINDOW_TWO_FINGER_SCROLL_MIN_MIDPOINT_PX
    || Math.abs(secondProjection) < REMOTE_WINDOW_TWO_FINGER_SCROLL_MIN_MIDPOINT_PX) {
    return false;
  }
  return Math.sign(firstProjection) !== Math.sign(secondProjection);
}

function hasCoherentTwoFingerScrollIntent(options: {
  firstStart: { clientX: number; clientY: number };
  firstCurrent: { clientX: number; clientY: number };
  secondStart: { clientX: number; clientY: number };
  secondCurrent: { clientX: number; clientY: number };
}) {
  const firstDeltaX = options.firstCurrent.clientX - options.firstStart.clientX;
  const firstDeltaY = options.firstCurrent.clientY - options.firstStart.clientY;
  const secondDeltaX = options.secondCurrent.clientX - options.secondStart.clientX;
  const secondDeltaY = options.secondCurrent.clientY - options.secondStart.clientY;
  if (
    Math.abs(firstDeltaY) < REMOTE_WINDOW_TWO_FINGER_SCROLL_DEADZONE_PX
    || Math.abs(secondDeltaY) < REMOTE_WINDOW_TWO_FINGER_SCROLL_DEADZONE_PX
  ) {
    return false;
  }
  if (Math.sign(firstDeltaY) !== Math.sign(secondDeltaY)) {
    return false;
  }
  return Math.abs(firstDeltaY) >= Math.abs(firstDeltaX)
    && Math.abs(secondDeltaY) >= Math.abs(secondDeltaX);
}

export function resolveRemoteWindowTouchPairPointerDownRuntime(options: {
  firstPointer: RemoteWindowTouchPairPointerSample;
  secondPointer: RemoteWindowTouchPairPointerSample;
  timeMs: number;
  pinchEnabled: boolean;
  scrollEnabled: boolean;
}): RemoteWindowTouchPairRuntimeResult {
  if (!options.pinchEnabled && !options.scrollEnabled) {
    return {
      nextState: createRemoteWindowTouchPointerState(),
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: false,
    };
  }
  const distance = Math.max(1, Math.hypot(
    options.firstPointer.clientX - options.secondPointer.clientX,
    options.firstPointer.clientY - options.secondPointer.clientY,
  ));
  const midpoint = {
    clientX: (options.firstPointer.clientX + options.secondPointer.clientX) / 2,
    clientY: (options.firstPointer.clientY + options.secondPointer.clientY) / 2,
  };
  const nextState: RemoteWindowTouchPointerState = {
    mode: 'twoFingerCandidate',
    firstPointerId: options.firstPointer.pointerId,
    secondPointerId: options.secondPointer.pointerId,
    firstStart: { clientX: options.firstPointer.clientX, clientY: options.firstPointer.clientY },
    secondStart: { clientX: options.secondPointer.clientX, clientY: options.secondPointer.clientY },
    startDistance: distance,
    startMidX: midpoint.clientX,
    startMidY: midpoint.clientY,
    lastMidX: midpoint.clientX,
    lastMidY: midpoint.clientY,
    startedAtMs: options.timeMs,
    moveCount: 0,
    committed: false,
  };
  return {
    nextState,
    remoteEvents: [],
    localEffect: { kind: 'none' },
    consumed: true,
  };
}

export function resolveRemoteWindowTouchPairPointerMoveRuntime(options: RemoteWindowTouchPairRuntimeOptions): RemoteWindowTouchPairRuntimeResult {
  const { state, pair, geometry, scrollFraction, invertGestureDirection } = options;
  const idle = createRemoteWindowTouchPointerState();
  // Workaround for TypeScript control flow analysis narrowing: preserve original state
  const originalState = state;
  if (
    state.mode !== 'twoFingerCandidate'
    && state.mode !== 'twoFingerScroll'
    && state.mode !== 'pinch'
  ) {
    return {
      nextState: state,
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: false,
    };
  }
  if (
    pair.first.pointerId !== state.firstPointerId
    || pair.second.pointerId !== state.secondPointerId
  ) {
    return {
      nextState: idle,
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: true,
    };
  }

  const firstCurrent = { clientX: pair.first.clientX, clientY: pair.first.clientY };
  const secondCurrent = { clientX: pair.second.clientX, clientY: pair.second.clientY };
  const distance = Math.max(1, Math.hypot(
    firstCurrent.clientX - secondCurrent.clientX,
    firstCurrent.clientY - secondCurrent.clientY,
  ));
  const midpoint = {
    clientX: (firstCurrent.clientX + secondCurrent.clientX) / 2,
    clientY: (firstCurrent.clientY + secondCurrent.clientY) / 2,
  };
  const scaleRatio = distance / Math.max(1, state.startDistance);
  const midpointDeltaX = midpoint.clientX - state.lastMidX;
  const midpointDeltaY = midpoint.clientY - state.lastMidY;
  const midpointShift = Math.hypot(midpointDeltaX, midpointDeltaY);

  if (
    state.mode === 'twoFingerCandidate'
    && options.timeMs - state.startedAtMs < REMOTE_WINDOW_TWO_FINGER_OBSERVE_MS
    && state.moveCount < REMOTE_WINDOW_TWO_FINGER_OBSERVE_MOVES
  ) {
    // 观察期：只累计样本，不做最终判定（消除抖动/方向误判）；时间或 move 数任一满足即结束
    return {
      nextState: {
        ...state,
        lastMidX: midpoint.clientX,
        lastMidY: midpoint.clientY,
        moveCount: state.moveCount + 1,
      },
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: true,
    };
  }

  if (state.mode === 'twoFingerScroll') {
    if (
      options.pinchEnabled
      && Math.abs(scaleRatio - 1) >= REMOTE_WINDOW_TWO_FINGER_PINCH_MIN_SCALE_RATIO
      && isPinchIntentPair({
        firstStart: state.firstStart,
        firstCurrent,
        secondStart: state.secondStart,
        secondCurrent,
        scaleRatio,
      })
    ) {
      const pinchMoveEffect: RemoteWindowTouchLocalEffect = {
        kind: 'pinch-move',
        pointerId: state.firstPointerId,
        scaleRatio,
        anchorClientX: midpoint.clientX,
        anchorClientY: midpoint.clientY,
        commit: true,
      };
      return {
        nextState: {
          mode: 'pinch',
          firstPointerId: state.firstPointerId,
          secondPointerId: state.secondPointerId,
          firstStart: state.firstStart,
          secondStart: state.secondStart,
          startDistance: state.startDistance,
          startMidX: state.startMidX,
          startMidY: state.startMidY,
          startedAtMs: state.startedAtMs,
          lastMidX: midpoint.clientX,
          lastMidY: midpoint.clientY,
          lastScaleRatio: scaleRatio,
          committed: true,
        },
        remoteEvents: [],
        localEffect: pinchMoveEffect,
        consumed: true,
      };
    }
    if (
      midpointShift < REMOTE_WINDOW_TWO_FINGER_SCROLL_DEADZONE_PX
      && Math.abs(scaleRatio - 1) < REMOTE_WINDOW_TWO_FINGER_PINCH_MIN_SCALE_RATIO
    ) {
      // Neither scroll nor pinch - just update mid tracking
      if (originalState.mode === 'twoFingerScroll' || originalState.mode === 'twoFingerCandidate') {
        return {
          nextState: { ...state, lastMidX: midpoint.clientX, lastMidY: midpoint.clientY },
          remoteEvents: [],
          localEffect: { kind: 'none' },
          consumed: true,
        };
      }
      return { nextState: state, remoteEvents: [], localEffect: { kind: 'none' }, consumed: true };
    }
    if (!hasCoherentTwoFingerScrollIntent({
      firstStart: state.firstStart,
      firstCurrent,
      secondStart: state.secondStart,
      secondCurrent,
    })) {
      return {
        nextState: state,
        remoteEvents: [],
        localEffect: { kind: 'none' },
        consumed: true,
      };
    }
    const events = buildRemoteWindowTwoFingerScrollEventsRuntime({
      geometry,
      midClientX: midpoint.clientX,
      midClientY: midpoint.clientY,
      rawDeltaX: midpointDeltaX,
      rawDeltaY: midpointDeltaY,
      scrollFraction: scrollFraction ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION,
      inverted: invertGestureDirection ?? false,
    });
    const scrollEffect: RemoteWindowTouchLocalEffect = events.length > 0
      ? {
          kind: 'two-finger-scroll-move',
          pointerId: state.firstPointerId,
          deltaX: events[0].kind === 'scroll' ? events[0].deltaX : 0,
          deltaY: events[0].kind === 'scroll' ? events[0].deltaY : 0,
          commit: false,
        }
      : { kind: 'none' };
    // Both twoFingerScroll and twoFingerCandidate can produce scroll events
    return {
      nextState: { ...state, lastMidX: midpoint.clientX, lastMidY: midpoint.clientY },
      remoteEvents: events,
      localEffect: scrollEffect,
      consumed: true,
    };
  }

  if (state.mode === 'pinch') {
    const pinchMoveEffect: RemoteWindowTouchLocalEffect = {
      kind: 'pinch-move',
      pointerId: state.firstPointerId,
      scaleRatio,
      anchorClientX: midpoint.clientX,
      anchorClientY: midpoint.clientY,
      commit: false,
    };
    return {
      nextState: {
        ...state,
        lastScaleRatio: scaleRatio,
      },
      remoteEvents: [],
      localEffect: pinchMoveEffect,
      consumed: true,
    };
  }

  if (
    options.pinchEnabled
    && isPinchIntentPair({
      firstStart: state.firstStart,
      firstCurrent,
      secondStart: state.secondStart,
      secondCurrent,
      scaleRatio,
    })
    && Math.abs(scaleRatio - 1) >= REMOTE_WINDOW_TWO_FINGER_PINCH_MIN_SCALE_RATIO
  ) {
    const pinchMoveEffect: RemoteWindowTouchLocalEffect = {
      kind: 'pinch-move',
      pointerId: state.firstPointerId,
      scaleRatio,
      anchorClientX: midpoint.clientX,
      anchorClientY: midpoint.clientY,
      commit: true,
    };
    return {
      nextState: {
        mode: 'pinch',
        firstPointerId: state.firstPointerId,
        secondPointerId: state.secondPointerId,
        firstStart: state.firstStart,
        secondStart: state.secondStart,
        startDistance: state.startDistance,
        startMidX: state.startMidX,
        startMidY: state.startMidY,
        startedAtMs: state.startedAtMs,
        lastMidX: midpoint.clientX,
        lastMidY: midpoint.clientY,
        lastScaleRatio: scaleRatio,
        committed: true,
      },
      remoteEvents: [],
      localEffect: pinchMoveEffect,
      consumed: true,
    };
  }

  if (
    options.scrollEnabled
    && midpointShift >= REMOTE_WINDOW_TWO_FINGER_SCROLL_MIN_MIDPOINT_PX
    && hasCoherentTwoFingerScrollIntent({
      firstStart: state.firstStart,
      firstCurrent,
      secondStart: state.secondStart,
      secondCurrent,
    })
  ) {
    const events = buildRemoteWindowTwoFingerScrollEventsRuntime({
      geometry,
      midClientX: midpoint.clientX,
      midClientY: midpoint.clientY,
      rawDeltaX: midpointDeltaX,
      rawDeltaY: midpointDeltaY,
      scrollFraction: scrollFraction ?? REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION,
      inverted: invertGestureDirection ?? false,
    });
    return {
      nextState: {
        mode: 'twoFingerScroll',
        firstPointerId: state.firstPointerId,
        secondPointerId: state.secondPointerId,
        firstStart: state.firstStart,
        secondStart: state.secondStart,
        startDistance: state.startDistance,
        startMidX: state.startMidX,
        startMidY: state.startMidY,
        lastMidX: midpoint.clientX,
        lastMidY: midpoint.clientY,
        startedAtMs: state.startedAtMs,
        committed: true,
      },
      remoteEvents: events,
      localEffect: {
        kind: 'two-finger-scroll-start',
        pointerId: state.firstPointerId,
      },
      consumed: true,
    };
  }

  if (
    midpointShift < REMOTE_WINDOW_TWO_FINGER_SCROLL_DEADZONE_PX
    && Math.abs(scaleRatio - 1) < REMOTE_WINDOW_TWO_FINGER_PINCH_MIN_SCALE_RATIO
  ) {
    return {
      nextState: {
        ...state,
        lastMidX: midpoint.clientX,
        lastMidY: midpoint.clientY,
      },
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: true,
    };
  }

  // Final fallback: should not reach here if all above branches return
  if (originalState.mode === 'twoFingerScroll' || originalState.mode === 'twoFingerCandidate') {
    return {
      nextState: { ...originalState, lastMidX: midpoint.clientX, lastMidY: midpoint.clientY },
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: true,
    };
  }
  return {
    nextState: originalState,
    remoteEvents: [],
    localEffect: { kind: 'none' },
    consumed: true,
  };
}

export function resolveRemoteWindowTouchPairPointerUpRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pair: RemoteWindowTouchPairPointerState;
  geometry: RemoteWindowTouchSurfaceGeometry;
  remainingPointer: RemoteWindowTouchPairPointerSample | null;
  timeMs: number;
  scrollFraction?: number;
  invertGestureDirection?: boolean;
}): RemoteWindowTouchPairRuntimeResult {
  const { state, pair, geometry, remainingPointer, scrollFraction, invertGestureDirection } = options;
  const idle = createRemoteWindowTouchPointerState();
  if (
    state.mode !== 'twoFingerCandidate'
    && state.mode !== 'twoFingerScroll'
    && state.mode !== 'pinch'
  ) {
    return {
      nextState: idle,
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: false,
    };
  }
  const liftedId = pair.first.pointerId === state.firstPointerId
    ? pair.first.pointerId
    : pair.second.pointerId === state.secondPointerId
      ? pair.second.pointerId
      : null;
  if (liftedId === null) {
    return {
      nextState: idle,
      remoteEvents: [],
      localEffect: { kind: 'none' },
      consumed: true,
    };
  }
  void geometry;
  void scrollFraction;
  void invertGestureDirection;
  const events: Array<RemoteWindowInputEventPayload['event']> = [];
  const localEffect: RemoteWindowTouchLocalEffect = state.mode === 'twoFingerScroll'
    ? {
        kind: 'two-finger-scroll-end',
        pointerId: state.firstPointerId,
        deltaX: events[0]?.kind === 'scroll' ? events[0].deltaX : 0,
        deltaY: events[0]?.kind === 'scroll' ? events[0].deltaY : 0,
      }
    : state.mode === 'pinch'
      ? {
          kind: 'pinch-end',
          pointerId: state.firstPointerId,
          scaleRatio: state.lastScaleRatio,
        }
      : { kind: 'none' };
  if (remainingPointer) {
    const remainingGesture: RemoteWindowTouchPointerState = remainingPointer.pointerType === 'touch'
      ? {
          mode: 'localPan',
          pointerId: remainingPointer.pointerId,
          startClientX: remainingPointer.clientX,
          startClientY: remainingPointer.clientY,
          moved: true,
        }
      : idle;
    return {
      nextState: remainingGesture,
      remoteEvents: events,
      localEffect,
      consumed: true,
    };
  }
  return {
    nextState: idle,
    remoteEvents: events,
    localEffect,
    consumed: true,
  };
}

export function resolveRemoteWindowTouchPointerCancelRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer } = options;
  const idle = createRemoteWindowTouchPointerState();
  const statePointerId = 'pointerId' in state ? (state as any).pointerId : undefined;
  if (state.mode === 'actionDrag' && statePointerId === pointer.pointerId) {
    return emptyResult(idle, true);
  }
  if (
    state.mode !== 'idle'
    && statePointerId === pointer.pointerId
  ) {
    return emptyResult(idle, true);
  }
  return emptyResult(state, false);
}

export function buildRemoteWindowTouchInputDebugEvent(
  action: RemoteWindowTouchInputAction,
  sent: boolean,
): RemoteWindowTouchInputDebugEvent {
  return {
    source: action.source,
    sent,
    sessionId: action.sessionId,
    streamId: action.streamId,
    targetId: action.target?.streamTargetId || null,
    targetTitle: action.target?.videoTarget.title || action.target?.videoTarget.appBundleId || null,
    event: action.event,
  };
}

export function dispatchRemoteWindowTouchInputActionRuntime(options: {
  action: RemoteWindowTouchInputAction;
  sendInput?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  onDebug?: (event: RemoteWindowTouchInputDebugEvent) => void;
}): RemoteWindowTouchInputDispatchResult {
  const { action, sendInput, onDebug } = options;
  const fail = (reason: RemoteWindowTouchInputDispatchResult['reason']) => {
    onDebug?.(buildRemoteWindowTouchInputDebugEvent(action, false));
    return { sent: false, reason };
  };

  if (!action.sessionId || !action.streamId || !action.target) {
    return fail('missing-context');
  }
  if (!isRemoteWindowInputSupportedTarget(action.target)) {
    return fail('unsupported-target');
  }
  if (!sendInput) {
    return fail('missing-dispatcher');
  }

  sendInput(action.sessionId, {
    streamId: action.streamId,
    targetId: action.target.streamTargetId,
    event: action.event,
  });
  onDebug?.(buildRemoteWindowTouchInputDebugEvent(action, true));
  return { sent: true };
}

export function dispatchRemoteWindowTouchInputActionsRuntime(options: {
  source: RemoteWindowTouchActionSource;
  sessionId: string | null;
  streamId: string | null;
  target: RemoteWindowStreamTargetManifest | null;
  events: Array<RemoteWindowInputEventPayload['event']>;
  sendInput?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  onDebug?: (event: RemoteWindowTouchInputDebugEvent) => void;
}): { sentCount: number; failedCount: number; firstFailureReason?: RemoteWindowTouchInputDispatchResult['reason'] } {
  let sentCount = 0;
  let failedCount = 0;
  let firstFailureReason: RemoteWindowTouchInputDispatchResult['reason'];
  for (const event of options.events) {
    const result = dispatchRemoteWindowTouchInputActionRuntime({
      action: {
        source: options.source,
        sessionId: options.sessionId,
        streamId: options.streamId,
        target: options.target,
        event,
      },
      sendInput: options.sendInput,
      onDebug: options.onDebug,
    });
    if (result.sent) {
      sentCount += 1;
    } else {
      failedCount += 1;
      firstFailureReason = firstFailureReason ?? result.reason;
    }
  }
  return { sentCount, failedCount, firstFailureReason };
}
