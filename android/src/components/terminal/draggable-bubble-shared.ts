/**
 * 共享悬浮控件拖拽逻辑（文件 bubble / 串流浮钮 / 串流浮层手柄同一套实现）。
 *
 * 与 QuickBar 📁 bubble 完全同构：
 * - pointer(鼠标/触控笔) + touch 双套；
 * - 位移阈值（默认 8px）激活拖拽；
 * - 拖拽激活时通过 onDragActive 抑制点击（防拖动后误触）；
 * - 位置 = 起点 rect 左上角 + 本次位移，经 clamp 钳制在视口内（left/top 绝对定位语义）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject, TouchEvent as ReactTouchEvent } from 'react';

export const SHARED_DRAG_THRESHOLD_PX = 8;
export const SHARED_DRAG_SUPPRESS_CLICK_MS = 180;

export interface SharedDragRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PointerDragState {
  pointerId: number;
  active: boolean;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

interface TouchDragState {
  active: boolean;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface SharedDragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchMove: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export function useIndependentFloatingEntryDrag(
  buttonRef: RefObject<HTMLButtonElement | null>,
  onPositionChange: (position: { x: number; y: number }) => void,
  onDragActive?: () => void,
  onDragFinished?: () => void,
): SharedDragHandlers {
  return useSharedDraggableDrag({
    getRect: () => {
      const button = buttonRef.current;
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width || 44, height: rect.height || 44 };
    },
    clampPosition: (x, y, width, height) => {
      const viewportWidth = Math.max(width + 16, Math.round(window.visualViewport?.width || window.innerWidth || 0));
      const viewportHeight = Math.max(height + 16, Math.round(window.visualViewport?.height || window.innerHeight || 0));
      return {
        x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
        y: Math.max(24, Math.min(y, viewportHeight - height - 8)),
      };
    },
    onPositionChange,
    onDragActive: onDragActive ?? (() => {}),
    onDragFinished: onDragFinished ?? (() => {}),
  });
}

export function useSharedDraggableDrag(options: {
  /** 当前元素 rect（touchstart/pointerdown 时刻）。返回 null 时不启动拖拽。 */
  getRect: () => SharedDragRect | null;
  /** 将新的 left/top 钳制在视口内（与文件 bubble 的 clamp 同语义）。 */
  clampPosition: (x: number, y: number, width: number, height: number) => { x: number; y: number };
  /** 拖拽位移生效（位置变化）。 */
  onPositionChange: (pos: { x: number; y: number }) => void;
  /** 拖拽激活（可在此抑制后续点击）。 */
  onDragActive: () => void;
  /** 拖拽结束且发生过位移（可在此恢复点击 180ms 后）。 */
  onDragFinished: () => void;
  /** 拖拽激活时的位移阈值。 */
  dragThresholdPx?: number;
}): SharedDragHandlers {
  const pointerRef = useRef<PointerDragState | null>(null);
  const touchRef = useRef<TouchDragState | null>(null);
  const suppressTimerRef = useRef<number | null>(null);
  const threshold = options.dragThresholdPx ?? SHARED_DRAG_THRESHOLD_PX;

  const clearSuppressTimer = useCallback(() => {
    if (suppressTimerRef.current !== null) {
      window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = null;
    }
  }, []);

  const finishDrag = useCallback(() => {
    const wasActive = pointerRef.current?.active === true || touchRef.current?.active === true;
    pointerRef.current = null;
    touchRef.current = null;
    clearSuppressTimer();
    if (wasActive) {
      options.onDragFinished();
      suppressTimerRef.current = window.setTimeout(() => {
        suppressTimerRef.current = null;
      }, SHARED_DRAG_SUPPRESS_CLICK_MS);
    }
  }, [clearSuppressTimer, options]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') {
      return;
    }
    const rect = options.getRect();
    if (!rect) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[SharedDrag] pointer capture failed:', error);
    }
    pointerRef.current = {
      pointerId: event.pointerId,
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, [options]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') {
      return;
    }
    const drag = pointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.active && Math.hypot(deltaX, deltaY) >= threshold) {
      drag.active = true;
      options.onDragActive();
    }
    if (!drag.active) {
      return;
    }
    event.preventDefault();
    options.onPositionChange(options.clampPosition(
      drag.originX + deltaX,
      drag.originY + deltaY,
      drag.width,
      drag.height,
    ));
  }, [options, threshold]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') {
      return;
    }
    const drag = pointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    finishDrag();
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[SharedDrag] pointer release failed:', error);
    }
  }, [finishDrag]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') {
      return;
    }
    if (pointerRef.current?.pointerId === event.pointerId) {
      finishDrag();
    }
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch (error) {
      console.warn('[SharedDrag] pointer release failed:', error);
    }
  }, [finishDrag]);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    const rect = options.getRect();
    if (!touch || !rect) {
      return;
    }
    touchRef.current = {
      active: false,
      startX: touch.clientX,
      startY: touch.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, [options]);

  const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    const drag = touchRef.current;
    if (!touch || !drag) {
      return;
    }
    const deltaX = touch.clientX - drag.startX;
    const deltaY = touch.clientY - drag.startY;
    if (!drag.active && Math.hypot(deltaX, deltaY) >= threshold) {
      drag.active = true;
      options.onDragActive();
    }
    if (!drag.active) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    options.onPositionChange(options.clampPosition(
      drag.originX + deltaX,
      drag.originY + deltaY,
      drag.width,
      drag.height,
    ));
  }, [options, threshold]);

  const handleTouchEnd = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  const handleTouchCancel = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchCancel,
  };
}

export function useIndependentFloatingEntryPosition(
  initialPosition: { x: number | null; y: number | null },
  persistPosition: (position: { x: number | null; y: number | null }) => void,
  onDragActive?: () => void,
  onDragFinished?: () => void,
) {
  const [position, setPosition] = useState(initialPosition);
  const positionRef = useRef(position);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const setStoredPosition = useCallback((next: { x: number; y: number }) => {
    positionRef.current = next;
    setPosition(next);
    persistPosition(next);
  }, [persistPosition]);
  const handlers = useIndependentFloatingEntryDrag(buttonRef, setStoredPosition, onDragActive, onDragFinished);
  useEffect(() => {
    const rescue = () => {
      const current = positionRef.current;
      if (current.x === null || current.y === null) return;
      const width = 44;
      const height = 44;
      const viewportWidth = Math.max(width + 16, Math.round(window.visualViewport?.width || window.innerWidth || 0));
      const viewportHeight = Math.max(height + 16, Math.round(window.visualViewport?.height || window.innerHeight || 0));
      const next = {
        x: Math.max(8, Math.min(current.x, viewportWidth - width - 8)),
        y: Math.max(24, Math.min(current.y, viewportHeight - height - 8)),
      };
      if (next.x !== current.x || next.y !== current.y) setStoredPosition(next);
    };
    window.addEventListener('resize', rescue);
    window.visualViewport?.addEventListener('resize', rescue);
    return () => {
      window.removeEventListener('resize', rescue);
      window.visualViewport?.removeEventListener('resize', rescue);
    };
  }, [setStoredPosition]);
  return { position, buttonRef, handlers };
}
