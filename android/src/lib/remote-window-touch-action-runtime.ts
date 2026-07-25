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
    };

export interface RemoteWindowTouchPointerRuntimeResult {
  nextState: RemoteWindowTouchPointerState;
  remoteEvents: Array<RemoteWindowInputEventPayload['event']>;
  localEffect: RemoteWindowTouchLocalEffect;
  consumed: boolean;
}

const REMOTE_WINDOW_TOUCH_DRAG_THRESHOLD_PX = 8;
const REMOTE_WINDOW_LOCAL_PAN_TAP_THRESHOLD_PX = 8;
const REMOTE_WINDOW_INPUT_STALE_MS = 1_000;
export const REMOTE_WINDOW_TOUCH_SCROLL_DEFAULT_FRACTION = 0.25;
export const REMOTE_WINDOW_TOUCH_SCROLL_MIN_FRACTION = 0.125;
export const REMOTE_WINDOW_TOUCH_SCROLL_MAX_FRACTION = 1;

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
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer } = options;
  if (state.mode === 'actionPending' && state.pointerId === pointer.pointerId) {
    const totalDeltaX = pointer.clientX - state.startClientX;
    const totalDeltaY = pointer.clientY - state.startClientY;
    if (Math.hypot(totalDeltaX, totalDeltaY) < REMOTE_WINDOW_TOUCH_DRAG_THRESHOLD_PX) {
      return emptyResult({
        ...state,
        lastClientX: pointer.clientX,
        lastClientY: pointer.clientY,
      }, true);
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

export function resolveRemoteWindowTouchPointerCancelRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer } = options;
  const idle = createRemoteWindowTouchPointerState();
  if (state.mode === 'actionDrag' && state.pointerId === pointer.pointerId) {
    return emptyResult(idle, true);
  }
  if (
    state.mode !== 'idle'
    && state.pointerId === pointer.pointerId
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
