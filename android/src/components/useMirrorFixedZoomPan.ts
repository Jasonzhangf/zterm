import { useCallback, useRef, type TouchEvent } from 'react';

/**
 * UI shell 层手势+缩放 hook（只属于 gesture / visual scale）。
 *
 * 层级：UI shell（本 hook） -> renderer（TerminalView） -> buffer manager。
 * 本 hook 只改变一个**独立视觉层容器**的 transform（scale / translateX），
 * 禁止读写 renderer 的 viewportRows / renderBottomIndex / scrollTop / scrollHeight，
 * 禁止使用 CSS zoom（布局级），禁止 translateY 接管纵向滚动。
 */

export interface MirrorFixedZoomPanOptions {
  widthMode: 'mirror-fixed' | 'adaptive-phone' | string;
  copyModeActive: boolean;
  reserveRightEdgeSwipe?: boolean;
  /** 当前 sessionId（用于持久化横向平移） */
  sessionId?: string | null;
  /** 读当前横向平移 offset（renderer/旧 handler 的真实源） */
  readHorizontalOffset?: () => number;
  onHorizontalOffsetChange?: (offsetPx: number) => void;
}

export interface MirrorFixedZoomPan {
  /** 视觉缩放层 ref 绑定（renderer 之上独立 DOM 层） */
  scaleLayerRef: (node: HTMLDivElement | null) => void;
  /** 当前视觉 scale（只读） */
  visualScale: number;
  /** 供旧两指手势调用点转发：只写视觉层 transform */
  applyVisualScale: (next: number) => void;
  /** 容器 touch 事件处理器（绑定到滚动容器） */
  onTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchMove: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchEnd: (event: TouchEvent<HTMLDivElement>) => void;
}

const HORIZONTAL_PAN_LOCK_PX = 8;
const MIN_PINCH_SPAN_PX = 60;
const MAX_SCALE = 1;
const MIN_SCALE = 0.4;

export function useMirrorFixedZoomPan(options: MirrorFixedZoomPanOptions): MirrorFixedZoomPan {
  const scaleRef = useRef(1);
  const minScaleRef = useRef(MIN_SCALE);
  const pinchRef = useRef<{ startSpan: number; startScale: number } | null>(null);
  const panRef = useRef<{
    active: boolean;
    axis: 'horizontal' | 'vertical' | null;
    startX: number;
    startY: number;
    startOffsetPx: number;
  }>({ active: false, axis: null, startX: 0, startY: 0, startOffsetPx: 0 });
  const twoFingerRef = useRef<{
    active: boolean;
    initialSpanPx: number;
    lastSpanPx: number;
    startClientY: number;
  }>({ active: false, initialSpanPx: 0, lastSpanPx: 0, startClientY: 0 });
  const layerRef = useRef<HTMLDivElement | null>(null);

  const scaleLayerRef = useCallback((node: HTMLDivElement | null) => {
    layerRef.current = node;
    if (!node) return;
    const scale = scaleRef.current;
    node.style.transform = scale < 1 ? `scale(${scale})` : 'none';
    node.style.transformOrigin = 'top left';
    node.style.willChange = scale < 1 ? 'transform' : '';
  }, []);

  const applyScale = useCallback((next: number) => {
    const clamped = Math.min(MAX_SCALE, Math.max(minScaleRef.current, next));
    scaleRef.current = clamped;
    const node = layerRef.current;
    if (!node) return;
    node.style.transform = clamped < 1 ? `scale(${clamped})` : 'none';
    node.style.transformOrigin = 'top left';
    node.style.willChange = clamped < 1 ? 'transform' : '';
  }, []);

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (options.widthMode !== 'mirror-fixed' || options.copyModeActive) {
        panRef.current.active = false;
        return;
      }
      const touches = event.touches;
      if (touches.length === 2) {
        const span = Math.hypot(
          touches[1].clientX - touches[0].clientX,
          touches[1].clientY - touches[0].clientY,
        );
        twoFingerRef.current = {
          active: true,
          initialSpanPx: span,
          lastSpanPx: span,
          startClientY: (touches[0].clientY + touches[1].clientY) / 2,
        };
        pinchRef.current = {
          startSpan: span,
          startScale: scaleRef.current,
        };
        panRef.current.active = false;
        event.stopPropagation();
        return;
      }
      if (touches.length === 1) {
        twoFingerRef.current.active = false;
        pinchRef.current = null;
        const startX = touches[0].clientX;
        const viewportWidth = window.visualViewport?.width || window.innerWidth || 0;
        const reservedRightEdge =
          Boolean(options.reserveRightEdgeSwipe) &&
          viewportWidth > 0 &&
          startX >= viewportWidth - 24;
        panRef.current = {
          active: !reservedRightEdge,
          axis: null,
          startX,
          startY: touches[0].clientY,
          startOffsetPx: options.readHorizontalOffset?.() ?? 0,
        };
        return;
      }
      panRef.current.active = false;
      twoFingerRef.current.active = false;
    },
    [options.copyModeActive, options.reserveRightEdgeSwipe, options.widthMode],
  );

  const onTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (options.widthMode !== 'mirror-fixed') return;
      const touches = event.touches;
      if (touches.length === 2) {
        const span = Math.hypot(
          touches[1].clientX - touches[0].clientX,
          touches[1].clientY - touches[0].clientY,
        );
        const pinch = pinchRef.current;
        if (pinch && pinch.startSpan > 0 && span < MIN_PINCH_SPAN_PX) {
          // 双指距离小于阈值才视为 pinch 缩放（避免两指误触）
          applyScale(pinch.startScale * (span / pinch.startSpan));
        }
        twoFingerRef.current.lastSpanPx = span;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (touches.length === 1) {
        const pan = panRef.current;
        if (!pan.active) return;
        const deltaX = touches[0].clientX - pan.startX;
        const deltaY = touches[0].clientY - pan.startY;
        if (!pan.axis) {
          if (Math.abs(deltaX) < HORIZONTAL_PAN_LOCK_PX && Math.abs(deltaY) < HORIZONTAL_PAN_LOCK_PX) {
            return;
          }
          pan.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
        }
        if (pan.axis !== 'horizontal') {
          // 纵向：交给原生滚动，UI shell 不接管
          return;
        }
        const nextOffset = Math.max(0, pan.startOffsetPx - deltaX);
        if (nextOffset !== pan.startOffsetPx) {
          options.onHorizontalOffsetChange?.(nextOffset);
        }
        // 只有内容确实在横向平移时才拦截（offset 归零后不再 reserve，
        // 让事件冒泡给 TerminalTabSwipeSurface 处理 drawer swipe）
        if (pan.startOffsetPx > 0 || nextOffset !== pan.startOffsetPx) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
    },
    [applyScale, options.onHorizontalOffsetChange, options.widthMode],
  );

  const onTouchEnd = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const touches = event.touches;
      if (touches.length === 2) {
        // 仍是两指，忽略
        return;
      }
      pinchRef.current = null;
      panRef.current.active = false;
      twoFingerRef.current.active = false;
    },
    [],
  );

  return {
    scaleLayerRef,
    visualScale: scaleRef.current,
    applyVisualScale: applyScale,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  };
}
