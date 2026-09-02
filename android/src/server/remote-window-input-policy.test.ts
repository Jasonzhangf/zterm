import { describe, expect, it } from 'vitest';
import type {
  RemoteWindowCanvasLayoutV1,
  RemoteWindowInputEventPayload,
  RemoteWindowStreamTargetManifest,
} from '@zterm/shared/protocol';
import { validateRemoteWindowInputPayload } from './remote-window-input-policy';

const target: RemoteWindowStreamTargetManifest = {
  streamTargetId: 'target-1',
  videoTarget: {
    kind: 'app-window',
    appBundleId: 'com.example.app',
    pid: 42,
    windowId: 'window-1',
    title: 'Example',
    windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
    cropRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
  },
  inputTarget: { kind: 'app-window' },
  streamMode: 'interactive',
  focusPolicy: 'bring-to-focus',
  inputRoute: 'os-event',
  capture: {
    source: 'ScreenCaptureKit',
    coordinateSpace: 'macos-top-left-px',
    scale: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
  },
};

const layout: RemoteWindowCanvasLayoutV1 = {
  version: 1,
  layoutGeneration: 7,
  canvasSize: { width: 1920, height: 1080 },
  focusTargetId: target.streamTargetId,
  windows: [{
    windowId: 'window-1',
    sourceRectTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
    canvasRectPx: { x: 0, y: 0, width: 1440, height: 1080 },
    zIndex: 0,
  }],
};

function clickPayload(overrides: Partial<RemoteWindowInputEventPayload> = {}): RemoteWindowInputEventPayload {
  return {
    streamId: 'stream-1',
    targetId: target.streamTargetId,
    layoutGeneration: layout.layoutGeneration,
    event: {
      kind: 'click',
      pointerId: 1,
      x: 100,
      y: 100,
      normalizedX: 0.5,
      normalizedY: 0.5,
      button: 'left',
    },
    ...overrides,
  };
}

describe('remote window input policy owner', () => {
  it('accepts explicit sample metadata and rejects sample/action mixing', () => {
    expect(() => validateRemoteWindowInputPayload({
      ...clickPayload(),
      deliveryKind: 'sample',
      sampledAtMs: 100,
      event: {
        kind: 'pointer',
        phase: 'move',
        pointerId: 1,
        button: 'none',
        buttons: 0,
        x: 100,
        y: 100,
        normalizedX: 0.5,
        normalizedY: 0.5,
      },
    }, { targetId: target.streamTargetId, target, canvasLayout: layout })).not.toThrow();
    expect(() => validateRemoteWindowInputPayload({
      ...clickPayload(),
      deliveryKind: 'sample',
      sampledAtMs: 100,
      deadlineMs: 200,
    }, { targetId: target.streamTargetId, target, canvasLayout: layout })).toThrow('cannot carry');
    expect(() => validateRemoteWindowInputPayload({
      ...clickPayload(),
      deliveryKind: 'action',
      sampledAtMs: 200,
      deadlineMs: 100,
    }, { targetId: target.streamTargetId, target, canvasLayout: layout })).toThrow('precedes');
  });

  it('accepts current-generation coordinate input and generation-independent key input', () => {
    expect(() => validateRemoteWindowInputPayload(clickPayload(), {
      targetId: target.streamTargetId,
      target: { ...target, compositeWindows: [{
        windowId: 'window-1',
        title: 'Example',
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      }] },
      canvasLayout: layout,
    })).not.toThrow();

    expect(() => validateRemoteWindowInputPayload({
      ...clickPayload({ layoutGeneration: undefined }),
      event: { kind: 'key', phase: 'down', key: 'a', code: 'KeyA' },
    }, {
      targetId: target.streamTargetId,
      target: { ...target, compositeWindows: [{
        windowId: 'window-1',
        title: 'Example',
        windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      }] },
      canvasLayout: layout,
    })).not.toThrow();
  });

  it('rejects stale layout, wrong target, invalid coordinates, and unsupported policy', () => {
    const compositeTarget = { ...target, compositeWindows: [{
      windowId: 'window-1',
      title: 'Example',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
    }] };
    expect(() => validateRemoteWindowInputPayload(clickPayload({ layoutGeneration: 6 }), {
      targetId: target.streamTargetId,
      target: compositeTarget,
      canvasLayout: layout,
    })).toThrow('layout generation mismatch');
    expect(() => validateRemoteWindowInputPayload(clickPayload({ targetId: 'wrong' }), {
      targetId: target.streamTargetId,
      target,
      canvasLayout: null,
    })).toThrow('target mismatch');
    expect(() => validateRemoteWindowInputPayload(clickPayload({
      event: {
        kind: 'click',
        pointerId: 1,
        x: 100,
        y: 100,
        normalizedX: 2,
        normalizedY: 0.5,
        button: 'left',
      },
    }), {
      targetId: target.streamTargetId,
      target,
      canvasLayout: null,
    })).toThrow('normalized coordinates are out of range');
    expect(() => validateRemoteWindowInputPayload(clickPayload(), {
      targetId: target.streamTargetId,
      target: { ...target, focusPolicy: 'no-focus-steal' },
      canvasLayout: null,
    })).toThrow('requires bring-to-focus policy');
  });
});
