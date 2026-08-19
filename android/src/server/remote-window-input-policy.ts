import type {
  RemoteWindowCanvasLayoutV1,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
} from '@zterm/shared/protocol';

export interface RemoteWindowInputValidationContext {
  targetId: string;
  target: RemoteWindowStreamTargetManifest;
  canvasLayout: RemoteWindowCanvasLayoutV1 | null;
}

function assertFinite(values: number[], message: string) {
  if (!values.every((value) => Number.isFinite(value))) {
    throw new Error(message);
  }
}

function assertNormalizedPoint(x: number, y: number, message: string) {
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error(message);
  }
}

export function validateRemoteWindowInputPayload(
  payload: RemoteWindowInputEventPayload,
  context: RemoteWindowInputValidationContext,
) {
  if (!payload.requestId || !payload.streamId || !payload.targetId) {
    throw new Error('remote window input requires requestId, streamId, and targetId');
  }
  if (payload.targetId !== context.targetId) {
    throw new Error(`remote window input target mismatch: ${payload.targetId}`);
  }

  const eventUsesCanvasCoordinates = payload.event.kind === 'pointer'
    || payload.event.kind === 'click'
    || payload.event.kind === 'scroll'
    || payload.event.kind === 'gesture';
  if (
    context.target.compositeWindows?.length
    && eventUsesCanvasCoordinates
    && (
      !context.canvasLayout
      || payload.layoutGeneration !== context.canvasLayout.layoutGeneration
    )
  ) {
    throw new Error(
      `remote window input layout generation mismatch: expected ${context.canvasLayout?.layoutGeneration ?? 'unavailable'}, received ${payload.layoutGeneration ?? 'missing'}`,
    );
  }
  if (context.target.inputRoute === 'os-event' && context.target.focusPolicy !== 'bring-to-focus') {
    throw new Error('remote window OS input requires bring-to-focus policy');
  }
  if (context.target.inputRoute !== 'os-event') {
    throw new Error(`remote window input route is not implemented: ${context.target.inputRoute}`);
  }

  const event = payload.event;
  if (event.kind === 'focus') {
    return;
  }
  if (event.kind === 'window-resize') {
    if (
      !Number.isFinite(event.width)
      || !Number.isFinite(event.height)
      || event.width < 120
      || event.height < 120
    ) {
      throw new Error('remote window resize dimensions are invalid');
    }
    return;
  }
  if (event.kind === 'click') {
    assertFinite(
      [event.x, event.y, event.normalizedX, event.normalizedY],
      'remote window click input coordinates are invalid',
    );
    assertNormalizedPoint(
      event.normalizedX,
      event.normalizedY,
      'remote window click input normalized coordinates are out of range',
    );
    if (event.button !== 'left' && event.button !== 'middle' && event.button !== 'right') {
      throw new Error('remote window click input button is invalid');
    }
    if (
      event.clickCount !== undefined
      && (!Number.isInteger(event.clickCount) || event.clickCount < 1 || event.clickCount > 3)
    ) {
      throw new Error('remote window click input click count is invalid');
    }
    return;
  }
  if (event.kind === 'pointer') {
    assertFinite(
      [event.x, event.y, event.normalizedX, event.normalizedY],
      'remote window pointer input coordinates are invalid',
    );
    assertNormalizedPoint(
      event.normalizedX,
      event.normalizedY,
      'remote window pointer input normalized coordinates are out of range',
    );
    return;
  }
  if (event.kind === 'scroll') {
    assertFinite(
      [event.x, event.y, event.normalizedX, event.normalizedY, event.deltaX, event.deltaY],
      'remote window scroll input coordinates or delta are invalid',
    );
    assertNormalizedPoint(
      event.normalizedX,
      event.normalizedY,
      'remote window scroll input normalized coordinates are out of range',
    );
    if (event.unit !== 'pixel') {
      throw new Error('remote window scroll input unit is invalid');
    }
    return;
  }
  if (event.kind === 'gesture') {
    assertFinite(
      [
        event.startX,
        event.startY,
        event.x,
        event.y,
        event.startNormalizedX,
        event.startNormalizedY,
        event.normalizedX,
        event.normalizedY,
        event.deltaX,
        event.deltaY,
        event.durationMs,
        event.velocityX,
        event.velocityY,
      ],
      'remote window gesture input coordinates, delta, or timing are invalid',
    );
    assertNormalizedPoint(
      event.startNormalizedX,
      event.startNormalizedY,
      'remote window gesture input normalized coordinates are out of range',
    );
    assertNormalizedPoint(
      event.normalizedX,
      event.normalizedY,
      'remote window gesture input normalized coordinates are out of range',
    );
    if (
      event.gesture !== 'swipe'
      || event.phase !== 'end'
      || event.unit !== 'pixel'
      || event.durationMs <= 0
    ) {
      throw new Error('remote window gesture input contract is invalid');
    }
    return;
  }
  if (event.kind === 'key' && event.phase !== 'down' && event.phase !== 'up') {
    throw new Error('remote window key input phase is invalid');
  }
}
