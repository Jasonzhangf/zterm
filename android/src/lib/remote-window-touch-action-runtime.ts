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
      mode: 'pointerInput';
      pointerId: number;
    }
  | {
      mode: 'touchPending';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      lastClientX: number;
      lastClientY: number;
      startAtMs: number;
    }
  | {
      mode: 'touchDrag';
      pointerId: number;
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

export function buildRemoteWindowFocusFirstInputEvents(
  events: Array<RemoteWindowInputEventPayload['event']>,
): Array<RemoteWindowInputEventPayload['event']> {
  return events.flatMap((event) => (
    event.kind === 'focus'
      ? [event]
      : [{ kind: 'focus' } as const, event]
  ));
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

function buildPointerAtPointEvent(options: {
  pointerId: number;
  clientX: number;
  clientY: number;
  geometry: RemoteWindowTouchSurfaceGeometry;
  phase: 'move' | 'down' | 'up';
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
    kind: 'pointer',
    phase: options.phase,
    pointerId: options.pointerId,
    button: 'left',
    buttons: options.phase === 'up' ? 0 : 1,
    ...point,
  };
}

function buildFocusFirstPointerAtPointEvents(options: {
  pointerId: number;
  clientX: number;
  clientY: number;
  geometry: RemoteWindowTouchSurfaceGeometry;
  phase: 'move' | 'down' | 'up';
}): Array<RemoteWindowInputEventPayload['event']> {
  const pointerEvent = buildPointerAtPointEvent(options);
  return pointerEvent ? buildRemoteWindowFocusFirstInputEvents([pointerEvent]) : [];
}

function buildGestureSwipeEvent(options: {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  endClientX: number;
  endClientY: number;
  startTimeMs: number;
  endTimeMs: number;
  geometry: RemoteWindowTouchSurfaceGeometry;
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
  const deltaX = options.endClientX - options.startClientX;
  const deltaY = options.endClientY - options.startClientY;
  if (deltaX === 0 && deltaY === 0) {
    return null;
  }
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
  if (pointer.pointerType === 'touch') {
    if (options.zoomedProjection) {
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
      mode: 'touchPending',
      pointerId: pointer.pointerId,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      lastClientX: pointer.clientX,
      lastClientY: pointer.clientY,
      startAtMs: pointer.timeMs,
    }, true);
  }

  const event = buildRemoteWindowPointerInputEventRuntime({
    pointer,
    geometry: options.geometry,
    phase: 'down',
  });
  return withRemoteEvents(
    {
      mode: 'pointerInput',
      pointerId: pointer.pointerId,
    },
    event ? buildRemoteWindowFocusFirstInputEvents([event]) : [],
  );
}

export function resolveRemoteWindowTouchPointerMoveRuntime(options: {
  state: RemoteWindowTouchPointerState;
  pointer: RemoteWindowTouchPointerSample;
  geometry: RemoteWindowTouchSurfaceGeometry;
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer, geometry } = options;
  if (state.mode === 'pointerInput' && state.pointerId === pointer.pointerId) {
    const event = buildRemoteWindowPointerInputEventRuntime({
      pointer,
      geometry,
      phase: 'move',
    });
    return withRemoteEvents(state, event ? buildRemoteWindowFocusFirstInputEvents([event]) : []);
  }

  if (state.mode === 'touchPending' && state.pointerId === pointer.pointerId) {
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
        mode: 'touchDrag',
        pointerId: state.pointerId,
        startClientX: state.startClientX,
        startClientY: state.startClientY,
        lastClientX: pointer.clientX,
        lastClientY: pointer.clientY,
        startAtMs: state.startAtMs,
      },
      [],
    );
  }

  if (state.mode === 'touchDrag' && state.pointerId === pointer.pointerId) {
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
}): RemoteWindowTouchPointerRuntimeResult {
  const { state, pointer, geometry } = options;
  const idle = createRemoteWindowTouchPointerState();
  if (state.mode === 'pointerInput' && state.pointerId === pointer.pointerId) {
    const event = buildRemoteWindowPointerInputEventRuntime({
      pointer,
      geometry,
      phase: 'up',
    });
    return withRemoteEvents(idle, event ? buildRemoteWindowFocusFirstInputEvents([event]) : []);
  }

  if (state.mode === 'touchPending' && state.pointerId === pointer.pointerId) {
    if (pointer.timeMs - state.startAtMs > REMOTE_WINDOW_INPUT_STALE_MS) {
      return emptyResult(idle, true);
    }
    return withRemoteEvents(
      idle,
      [
        ...buildFocusFirstPointerAtPointEvents({
          pointerId: state.pointerId,
          clientX: state.startClientX,
          clientY: state.startClientY,
          geometry,
          phase: 'down',
        }),
        ...buildFocusFirstPointerAtPointEvents({
          pointerId: state.pointerId,
          clientX: pointer.clientX,
          clientY: pointer.clientY,
          geometry,
          phase: 'up',
        }),
      ],
    );
  }

  if (state.mode === 'touchDrag' && state.pointerId === pointer.pointerId) {
    if (pointer.timeMs - state.startAtMs > REMOTE_WINDOW_INPUT_STALE_MS) {
      return emptyResult(idle, true);
    }
    const clientX = Number.isFinite(pointer.clientX) ? pointer.clientX : state.lastClientX;
    const clientY = Number.isFinite(pointer.clientY) ? pointer.clientY : state.lastClientY;
    const event = buildGestureSwipeEvent({
      pointerId: state.pointerId,
      startClientX: state.startClientX,
      startClientY: state.startClientY,
      endClientX: clientX,
      endClientY: clientY,
      startTimeMs: state.startAtMs,
      endTimeMs: pointer.timeMs,
      geometry,
    });
    return withRemoteEvents(
      idle,
      event ? buildRemoteWindowFocusFirstInputEvents([event]) : [],
    );
  }

  if (state.mode === 'localPan' && state.pointerId === pointer.pointerId) {
    if (!state.moved) {
      return {
        nextState: idle,
        remoteEvents: [
          ...buildFocusFirstPointerAtPointEvents({
            pointerId: state.pointerId,
            clientX: state.startClientX,
            clientY: state.startClientY,
            geometry,
            phase: 'down',
          }),
          ...buildFocusFirstPointerAtPointEvents({
            pointerId: state.pointerId,
            clientX: pointer.clientX,
            clientY: pointer.clientY,
            geometry,
            phase: 'up',
          }),
        ],
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
  if (state.mode === 'touchDrag' && state.pointerId === pointer.pointerId) {
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
