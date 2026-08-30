/**
 * Remote window overlay 纯函数/类型子模块（client.remote_window_overlay）。
 * 从 RemoteWindowOverlay.tsx 拆出：几何 / 坐标 / 网络质量 / target 分组等纯逻辑，不含组件状态与 JSX。
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type {
  RemoteWindowStreamStartedPayload,
  RemoteWindowStreamTargetManifest,
  RemoteWindowStreamTargetsResponsePayload,
} from '../../lib/types';
import {
  getRemoteWindowSourceRect,
  type RemoteWindowNetworkQualityInput,
} from '../../lib/remote-window-video-quality';
import {
  createRemoteWindowTouchPointerState,
  isRemoteWindowInputSupportedTarget,
  type RemoteWindowTouchPointerSample,
  type RemoteWindowTouchPointerState,
} from '../../lib/remote-window-touch-action-runtime';
import {
  REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
  REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
  type FloatingResizeAnchor,
} from './remote-window-overlay-constants';

export interface FloatingOverlayOffset {
  x: number;
  y: number;
}

export interface SurfaceSize {
  width: number;
  height: number;
}

export interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FullscreenViewportState {
  scale: number;
  panX: number;
  panY: number;
}

export type FullscreenDisplayMode = 'fit' | 'fill';


export type NavigatorConnectionLike = EventTarget & {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
};

export interface SurfacePointerPosition {
  clientX: number;
  clientY: number;
}

export type SurfacePointerGesture =
  | RemoteWindowTouchPointerState
  | {
      mode: 'pan';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPanX: number;
      startPanY: number;
      moved: boolean;
    };

export interface FloatingOverlayResize {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startOffset: FloatingOverlayOffset;
  minWidth: number;
  maxWidth: number;
  aspectRatio: number;
  anchor: FloatingResizeAnchor;
  captureElement: HTMLDivElement | null;
}





export const initialFullscreenViewport: FullscreenViewportState = {
  scale: 1,
  panX: 0,
  panY: 0,
};

export const initialFullscreenDisplayMode: FullscreenDisplayMode = 'fill';

export function cloneRemoteWindowCatalogPayload(
  payload: RemoteWindowStreamTargetsResponsePayload,
): RemoteWindowStreamTargetsResponsePayload {
  return {
    requestId: payload.requestId,
    targets: Array.isArray(payload.targets) ? payload.targets.slice() : [],
    errors: Array.isArray(payload.errors) ? payload.errors.slice() : undefined,
  };
}

export function clampFloatingOffset(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function resolveAspectRect(
  surface: SurfaceSize,
  source: { width: number; height: number },
  displayMode: FullscreenDisplayMode,
): SurfaceRect {
  const surfaceWidth = Math.max(1, surface.width);
  const surfaceHeight = Math.max(1, surface.height);
  const sourceWidth = Math.max(1, source.width);
  const sourceHeight = Math.max(1, source.height);
  void displayMode;
  const scale = Math.min(surfaceWidth / sourceWidth, surfaceHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (surfaceWidth - width) / 2,
    top: (surfaceHeight - height) / 2,
    width,
    height,
  };
}

export function resolveFullscreenViewportRect(
  surface: SurfaceSize,
  source: { width: number; height: number },
  displayMode: FullscreenDisplayMode,
): SurfaceRect {
  void displayMode;
  return resolveAspectRect(surface, source, 'fit');
}

export function clampFullscreenViewport(
  viewport: FullscreenViewportState,
  surface: SurfaceSize | null,
  source: { width: number; height: number } | null,
  displayMode: FullscreenDisplayMode = initialFullscreenDisplayMode,
  keyboardPanAllowancePx = 0,
): FullscreenViewportState {
  const scale = clampNumber(
    Number.isFinite(viewport.scale) ? viewport.scale : 1,
    REMOTE_WINDOW_FULLSCREEN_MIN_SCALE,
    REMOTE_WINDOW_FULLSCREEN_MAX_SCALE,
  );
  if (!surface || !source) {
    return { scale, panX: 0, panY: 0 };
  }
  const base = resolveAspectRect(surface, source, displayMode);
  const allowKeyboardPan = keyboardPanAllowancePx > 0;
  const viewportRect = allowKeyboardPan
    ? {
        left: 0,
        top: 0,
        width: Math.max(1, surface.width),
        height: Math.max(1, surface.height),
      }
    : resolveFullscreenViewportRect(surface, source, displayMode);
  const scaledWidth = base.width * scale;
  const scaledHeight = base.height * scale;
  const maxPanX = Math.max(0, Math.abs(scaledWidth - viewportRect.width) / 2);
  const maxPanY = Math.max(0, Math.abs(scaledHeight - viewportRect.height) / 2)
    + Math.max(0, keyboardPanAllowancePx);
  return {
    scale,
    panX: clampNumber(viewport.panX, -maxPanX, maxPanX),
    panY: clampNumber(viewport.panY, -maxPanY, maxPanY),
  };
}

export function resolveZoomedContentRect(
  surface: SurfaceSize,
  source: { width: number; height: number },
  viewport: FullscreenViewportState,
  displayMode: FullscreenDisplayMode = initialFullscreenDisplayMode,
): { viewport: SurfaceRect; content: SurfaceRect } {
  const base = resolveAspectRect(surface, source, displayMode);
  const viewportRect = resolveFullscreenViewportRect(surface, source, displayMode);
  const scale = Math.max(1, viewport.scale);
  const width = base.width * scale;
  const height = base.height * scale;
  return {
    viewport: viewportRect,
    content: {
      left: base.left + (base.width - width) / 2 + viewport.panX,
      top: base.top + (base.height - height) / 2 + viewport.panY,
      width,
      height,
    },
  };
}

export function resolveAnchoredFullscreenViewportScale(options: {
  surface: SurfaceSize;
  source: { width: number; height: number };
  current: FullscreenViewportState;
  nextScale: number;
  anchorClientX: number;
  anchorClientY: number;
  surfaceLeft: number;
  surfaceTop: number;
  displayMode: FullscreenDisplayMode;
  keyboardPanAllowancePx: number;
}): FullscreenViewportState {
  const currentRect = resolveZoomedContentRect(
    options.surface,
    options.source,
    options.current,
    options.displayMode,
  ).content;
  const anchorX = options.anchorClientX - options.surfaceLeft;
  const anchorY = options.anchorClientY - options.surfaceTop;
  const normalizedAnchorX = currentRect.width > 0
    ? clampNumber((anchorX - currentRect.left) / currentRect.width, 0, 1)
    : 0.5;
  const normalizedAnchorY = currentRect.height > 0
    ? clampNumber((anchorY - currentRect.top) / currentRect.height, 0, 1)
    : 0.5;
  const base = resolveAspectRect(options.surface, options.source, options.displayMode);
  const nextWidth = base.width * options.nextScale;
  const nextHeight = base.height * options.nextScale;
  const nextLeft = anchorX - normalizedAnchorX * nextWidth;
  const nextTop = anchorY - normalizedAnchorY * nextHeight;
  return clampFullscreenViewport(
    {
      scale: options.nextScale,
      panX: nextLeft - (base.left + (base.width - nextWidth) / 2),
      panY: nextTop - (base.top + (base.height - nextHeight) / 2),
    },
    options.surface,
    options.source,
    options.displayMode,
    options.keyboardPanAllowancePx,
  );
}


















export function resolveFloatingOverlaySizing(source: { width: number; height: number }): Pick<CSSProperties, 'width' | 'maxWidth'> {
  const aspectRatio = Math.max(0.2, Math.min(5, source.width / Math.max(1, source.height)));
  if (aspectRatio < 0.85) {
    const maxWidthPx = Math.round(clampNumber(aspectRatio * 440, 260, 340));
    return { width: '76vw', maxWidth: `${maxWidthPx}px` };
  }
  if (aspectRatio > 1.55) {
    return { width: '92vw', maxWidth: '480px' };
  }
  return { width: '92vw', maxWidth: '420px' };
}

export function resolveStartedCaptureFrameSize(started?: RemoteWindowStreamStartedPayload | null): SurfaceSize | null {
  const width = started?.capture?.frameWidth;
  const height = started?.capture?.frameHeight;
  if (
    typeof width !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    return null;
  }
  return {
    width,
    height,
  };
}

export function resolveRemoteWindowDisplaySourceSize(
  target: RemoteWindowStreamTargetManifest,
  receiverFrameSize: SurfaceSize | null,
  focusedWindowSlot?: { width: number; height: number } | null,
): SurfaceSize {
  // 组合模式：主画面显示焦点窗口（裁切放大），显示源尺寸 = 焦点窗口尺寸，
  // 否则坐标/布局会按整个画布比例计算，与 video 实际显示不一致
  if (focusedWindowSlot && focusedWindowSlot.width > 0 && focusedWindowSlot.height > 0) {
    return { width: focusedWindowSlot.width, height: focusedWindowSlot.height };
  }
  if (receiverFrameSize) {
    return receiverFrameSize;
  }
  const sourceRect = getRemoteWindowSourceRect(target);
  return {
    width: sourceRect.width,
    height: sourceRect.height,
  };
}

export function parseCssPx(value: string | null | undefined) {
  const match = String(value || '').match(/-?\d+(?:\.\d+)?/u);
  const parsed = match ? Number.parseFloat(match[0]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveRemoteWindowFullscreenFillReferenceSize(options: {
  overlay: HTMLElement | null;
  toolbar: HTMLElement | null;
  surface: HTMLElement | null;
  fallbackSurfaceSize: SurfaceSize | null;
}): SurfaceSize | null {
  const overlayRect = options.overlay?.getBoundingClientRect();
  if (overlayRect && overlayRect.width > 0 && overlayRect.height > 0) {
    const computed = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(options.overlay as HTMLElement)
      : null;
    const toolbarRect = options.toolbar?.getBoundingClientRect();
    const toolbarHeight = toolbarRect && toolbarRect.height > 0 ? toolbarRect.height : 0;
    const width = overlayRect.width
      - parseCssPx(computed?.paddingLeft)
      - parseCssPx(computed?.paddingRight);
    const height = overlayRect.height
      - parseCssPx(computed?.paddingTop)
      - parseCssPx(computed?.paddingBottom)
      - toolbarHeight;
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  const surfaceRect = options.surface?.getBoundingClientRect();
  if (surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0) {
    return { width: surfaceRect.width, height: surfaceRect.height };
  }

  return options.fallbackSurfaceSize;
}

export function formatTargetKind(target: RemoteWindowStreamTargetManifest) {
  return target.videoTarget.kind === 'iterm2-pane' ? 'iTerm2 Pane' : 'App Window';
}

export function formatInputRoute(target: RemoteWindowStreamTargetManifest) {
  switch (target.inputRoute) {
    case 'tmux-input':
      return 'tmux';
    case 'iterm2-api':
      return 'iTerm2 API';
    case 'os-event':
      return 'OS event';
  }
}

export function isRemoteWindowInputSupported(target: RemoteWindowStreamTargetManifest) {
  return isRemoteWindowInputSupportedTarget(target);
}

export function readRemoteWindowNetworkQuality(): RemoteWindowNetworkQualityInput | null {
  const connection = typeof navigator === 'undefined'
    ? null
    : ((navigator as Navigator & {
        connection?: NavigatorConnectionLike;
        mozConnection?: NavigatorConnectionLike;
        webkitConnection?: NavigatorConnectionLike;
      }).connection
      || (navigator as Navigator & { mozConnection?: NavigatorConnectionLike }).mozConnection
      || (navigator as Navigator & { webkitConnection?: NavigatorConnectionLike }).webkitConnection
      || null);
  if (!connection) {
    return null;
  }
  return {
    effectiveType: connection.effectiveType || null,
    downlinkMbps: typeof connection.downlink === 'number' ? connection.downlink : null,
    rttMs: typeof connection.rtt === 'number' ? connection.rtt : null,
    saveData: Boolean(connection.saveData),
  };
}

export function pointerSampleFromReactEvent(
  event: ReactPointerEvent<HTMLDivElement>,
): RemoteWindowTouchPointerSample {
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType || 'mouse',
    clientX: event.clientX,
    clientY: event.clientY,
    button: event.button,
    buttons: event.buttons,
    timeMs: Date.now(),
  };
}

export function toOverlayTouchGesture(
  gesture: RemoteWindowTouchPointerState,
  currentViewport: FullscreenViewportState,
  localPanStart: { pointerId: number; startPanX: number; startPanY: number } | null,
): SurfacePointerGesture | null {
  if (gesture.mode === 'idle') {
    return null;
  }
  if (gesture.mode === 'localPan') {
    const start = localPanStart || {
      pointerId: gesture.pointerId,
      startPanX: currentViewport.panX,
      startPanY: currentViewport.panY,
    };
    return {
      mode: 'pan',
      pointerId: gesture.pointerId,
      startClientX: gesture.startClientX,
      startClientY: gesture.startClientY,
      startPanX: start.startPanX,
      startPanY: start.startPanY,
      moved: gesture.moved,
    };
  }
  return gesture;
}

export function toRemoteWindowTouchGestureState(
  gesture: SurfacePointerGesture | null,
): RemoteWindowTouchPointerState {
  if (!gesture) {
    return createRemoteWindowTouchPointerState();
  }
  if (gesture.mode === 'pan') {
    return {
      mode: 'localPan',
      pointerId: gesture.pointerId,
      startClientX: gesture.startClientX,
      startClientY: gesture.startClientY,
      moved: gesture.moved,
    };
  }
  if (
    gesture.mode === 'actionPending'
    || gesture.mode === 'actionDrag'
    || gesture.mode === 'actionScroll'
    || gesture.mode === 'touchGestureDrag'
    || gesture.mode === 'actionLongPress'
    || gesture.mode === 'twoFingerCandidate'
    || gesture.mode === 'twoFingerScroll'
    || gesture.mode === 'pinch'
  ) {
    return gesture;
  }
  return createRemoteWindowTouchPointerState();
}

export function getRemoteWindowNetworkConnection(): NavigatorConnectionLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return ((navigator as Navigator & {
    connection?: NavigatorConnectionLike;
    mozConnection?: NavigatorConnectionLike;
    webkitConnection?: NavigatorConnectionLike;
  }).connection
    || (navigator as Navigator & { mozConnection?: NavigatorConnectionLike }).mozConnection
    || (navigator as Navigator & { webkitConnection?: NavigatorConnectionLike }).webkitConnection
    || null);
}


export function formatTargetSubtitle(target: RemoteWindowStreamTargetManifest) {
  const tmux = target.inputTarget.tmuxSession
    ? `tmux ${target.inputTarget.tmuxSession}${target.inputTarget.tmuxPaneId ? ` ${target.inputTarget.tmuxPaneId}` : ''}`
    : '';
  const geometry = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  const route = formatInputRoute(target);
  const inputMode = isRemoteWindowInputSupported(target) ? '可操作' : '只读';
  return [tmux, `${geometry.width}x${geometry.height}`, route, inputMode].filter(Boolean).join(' · ');
}

export interface RemoteWindowAppTargetGroup {
  groupId: string;
  appBundleId: string;
  pid: number;
  title: string;
  targets: RemoteWindowStreamTargetManifest[];
}

export function remoteWindowTargetArea(target: RemoteWindowStreamTargetManifest) {
  const rect = target.videoTarget.cropRectTopLeftPx || target.videoTarget.windowBoundsTopLeftPx;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function getRemoteWindowAppGroupId(target: RemoteWindowStreamTargetManifest) {
  if (target.videoTarget.kind !== 'app-window') {
    return null;
  }
  const appBundleId = target.videoTarget.appBundleId || 'unknown-app';
  const pid = target.videoTarget.pid || 0;
  return `${appBundleId}:${pid}`;
}

export function buildRemoteWindowAppTargetGroups(
  targets: RemoteWindowStreamTargetManifest[],
): RemoteWindowAppTargetGroup[] {
  const groups = new Map<string, RemoteWindowAppTargetGroup>();
  for (const target of targets) {
    const groupId = getRemoteWindowAppGroupId(target);
    if (!groupId) {
      continue;
    }
    const appBundleId = target.videoTarget.appBundleId || 'unknown-app';
    const pid = target.videoTarget.pid || 0;
    const existing = groups.get(groupId);
    if (existing) {
      existing.targets.push(target);
      continue;
    }
    groups.set(groupId, {
      groupId,
      appBundleId,
      pid,
      title: target.videoTarget.title || appBundleId,
      targets: [target],
    });
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    targets: group.targets.slice().sort((left, right) => remoteWindowTargetArea(right) - remoteWindowTargetArea(left)),
  }));
}

export function safeRemoteWindowGroupId(groupId: string) {
  return groupId.replace(/[^a-zA-Z0-9_-]+/g, '-');
}
