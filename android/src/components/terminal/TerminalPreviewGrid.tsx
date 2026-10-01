import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type TouchEvent,
} from 'react';
import { TERMINAL_DRAWER_EDGE_SWIPE_START_PX } from '@zterm/shared';
import { TerminalView } from '../TerminalView';
import type { SessionRenderBufferStore } from '../../lib/session-render-buffer-store';
import type { Session } from '../../lib/types';
import type { TerminalSessionDrawerItem } from '../../lib/plugin-session-drawer/session-drawer-contract';
import { getServerIdentityTone, resolveServerDisplayName } from '../../lib/server-identity';
import { mobileTheme } from '../../lib/mobile-ui';
import { AmbientButton } from '../ambient';
import {
  JUNCTION_PREVIEW_HEADER_HEIGHT_PX,
  JUNCTION_PREVIEW_GAP_PX,
  resolveJunctionPreviewLayout,
} from '../../lib/junction-preview-layout';
import {
  resolveJunctionPreviewCell,
  type JunctionPreviewCoordinate,
  type JunctionPreviewLatticeV1,
} from '../../lib/junction-preview-lattice';

export interface TerminalPreviewGridProps {
  lattice: JunctionPreviewLatticeV1;
  focus: JunctionPreviewCoordinate;
  candidates: Session[];
  slotMenuCandidates?: TerminalSessionDrawerItem[];
  sessionBufferStore?: SessionRenderBufferStore | null;
  fontSize: number;
  themeId?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  sideEdge?: 'left' | 'right';
  onFocusChange: (coordinate: JunctionPreviewCoordinate) => void;
  onSetCell: (coordinate: JunctionPreviewCoordinate, sessionId: string) => void;
  onClearCell: (coordinate: JunctionPreviewCoordinate) => void;
  onCycleSession?: (direction: 'next' | 'previous') => void;
  onPinchVerticalCwdStep?: (direction: 'next' | 'previous') => void;
  onClose: () => void;
}

const PREVIEW_LONG_PRESS_MS = 420;
const PREVIEW_LONG_PRESS_CLICK_SUPPRESSION_MS = 1_000;
const PREVIEW_SESSION_SWIPE_LOCK_PX = 12;
const PREVIEW_SESSION_SWIPE_MIN_DX = 48;
const PREVIEW_CWD_PINCH_LOCK_PX = 48;

type TerminalPreviewSlotMenuCandidate = {
  id: string;
  title: string;
  sessionName?: string;
  hostKey?: string;
  hostLabel?: string;
  bridgeHost?: string;
  bridgePort?: number;
  daemonHostId?: string;
};

function touchSpan(touches: React.TouchList) {
  if (touches.length < 2) return 0;
  return Math.hypot(
    touches[1].clientX - touches[0].clientX,
    touches[1].clientY - touches[0].clientY,
  );
}

function resolveSlotMenuCandidateTone(candidate: TerminalPreviewSlotMenuCandidate) {
  return getServerIdentityTone({
    bridgeHost: candidate.bridgeHost || candidate.hostKey,
    bridgePort: candidate.bridgePort,
    daemonHostId: candidate.daemonHostId,
    connectionName: candidate.hostLabel,
  });
}

function resolveSlotMenuCandidateHostLabel(candidate: TerminalPreviewSlotMenuCandidate) {
  if (candidate.hostLabel) return candidate.hostLabel;
  if (candidate.bridgeHost || candidate.bridgePort || candidate.daemonHostId) {
    return resolveServerDisplayName(candidate);
  }
  return candidate.hostKey || 'unknown server';
}

function coordinateKey(coord: JunctionPreviewCoordinate) {
  return `${coord.col}:${coord.row}`;
}

function isPreviewEdgeExitGesture(startX: number) {
  return startX >= Math.max(0, window.innerWidth - TERMINAL_DRAWER_EDGE_SWIPE_START_PX);
}

export const TerminalPreviewGrid = memo(function TerminalPreviewGrid({
  lattice,
  focus,
  candidates,
  slotMenuCandidates,
  sessionBufferStore = null,
  fontSize,
  themeId,
  viewportWidth,
  viewportHeight,
  sideEdge,
  onFocusChange,
  onSetCell,
  onClearCell,
  onCycleSession,
  onPinchVerticalCwdStep,
  onClose,
}: TerminalPreviewGridProps) {
  const resolvedViewportWidth = Math.max(
    1,
    viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth || 0 : 0),
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [measuredViewport, setMeasuredViewport] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setMeasuredViewport((current) => {
        const width = rect.width;
        const height = rect.height;
        return current && current.width === width && current.height === height
          ? current
          : { width, height };
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  const resolvedViewportHeight = Math.max(
    1,
    measuredViewport?.height ?? (
      (viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight || 0 : 0))
        - JUNCTION_PREVIEW_HEADER_HEIGHT_PX
    ),
  );
  const layoutViewportWidth = measuredViewport?.width ?? resolvedViewportWidth;
  const layout = resolveJunctionPreviewLayout({
    viewportWidth: layoutViewportWidth,
    viewportHeight: resolvedViewportHeight,
    fontSize: Math.max(1, fontSize),
    focus,
    sideEdge,
  });
  const rowHeightPx = Math.max(fontSize + 4, Math.ceil(fontSize * 1.5));
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef<JunctionPreviewCoordinate | null>(null);
  const suppressClickTimerRef = useRef<number | null>(null);
  const suppressPreviewClickRef = useRef(false);
  const suppressPreviewClickTimerRef = useRef<number | null>(null);
  const pinchGestureRef = useRef<{ startSpan: number; startY: number; cwdStepFired: boolean } | null>(null);
  const previewHorizontalSwipeRef = useRef<{
    startX: number;
    startY: number;
    locked: 'none' | 'session' | 'exit';
    fired: boolean;
    exitArmed: boolean;
  } | null>(null);
  const [slotMenu, setSlotMenu] = useState<{
    coordinate: JunctionPreviewCoordinate;
    existingSessionId?: string;
  } | null>(null);

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
    }
    if (suppressPreviewClickTimerRef.current !== null) {
      window.clearTimeout(suppressPreviewClickTimerRef.current);
    }
  }, []);

  const suppressNextPreviewClick = () => {
    suppressPreviewClickRef.current = true;
    if (suppressPreviewClickTimerRef.current !== null) {
      window.clearTimeout(suppressPreviewClickTimerRef.current);
    }
    suppressPreviewClickTimerRef.current = window.setTimeout(() => {
      suppressPreviewClickRef.current = false;
      suppressPreviewClickTimerRef.current = null;
    }, PREVIEW_LONG_PRESS_CLICK_SUPPRESSION_MS);
  };

  const clearSuppressedPreviewClick = () => {
    suppressPreviewClickRef.current = false;
    if (suppressPreviewClickTimerRef.current !== null) {
      window.clearTimeout(suppressPreviewClickTimerRef.current);
      suppressPreviewClickTimerRef.current = null;
    }
  };

  const consumeSuppressedPreviewClick = () => {
    if (!suppressPreviewClickRef.current) return false;
    clearSuppressedPreviewClick();
    return true;
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = null;
    longPressStartRef.current = null;
  };

  const startLongPress = (
    coordinate: JunctionPreviewCoordinate,
    existingSessionId: string | undefined,
    event: PointerEvent<HTMLElement>,
  ) => {
    clearLongPress();
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
      suppressClickRef.current = { col: coordinate.col, row: coordinate.row };
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = null;
        suppressClickTimerRef.current = null;
      }, PREVIEW_LONG_PRESS_CLICK_SUPPRESSION_MS);
      setSlotMenu({ coordinate, existingSessionId });
    }, PREVIEW_LONG_PRESS_MS);
  };

  const updateLongPress = (event: PointerEvent<HTMLElement>) => {
    const start = longPressStartRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      clearLongPress();
    }
  };

  const finishLongPress = () => {
    clearLongPress();
  };

  const focusWidth = layout.focusSizePx.width;
  const focusHeight = layout.focusSizePx.height;
  const sideSizePx = layout.side.sizePx;
  const topBottomSizePx = layout.topBottomSizePx;
  const centerTop = topBottomSizePx + JUNCTION_PREVIEW_GAP_PX;
  const centerLeft = layout.form === 'portrait' && layout.side.edge === 'right'
    ? 0
    : sideSizePx + JUNCTION_PREVIEW_GAP_PX;
  const cellRects = new Map<string, {
    clip: { left: number; top: number; width: number; height: number };
    pane: { left: number; top: number; width: number; height: number };
    isFocus: boolean;
  }>();

  for (const cell of layout.visibleCells) {
    const isFocus = cell.col === focus.col && cell.row === focus.row;
    let clip = { left: 0, top: 0, width: 0, height: 0 };
    let pane = { left: centerLeft, top: centerTop, width: focusWidth, height: focusHeight };

    if (layout.form === 'landscape' && cell.edge === 'focus') {
      const paneLeft = cell.col === focus.col ? focusWidth + JUNCTION_PREVIEW_GAP_PX : 0;
      clip = { left: paneLeft, top: centerTop, width: focusWidth, height: focusHeight };
      pane = { left: paneLeft, top: centerTop, width: focusWidth, height: focusHeight };
    } else if (cell.edge === 'focus') {
      clip = { left: centerLeft, top: centerTop, width: focusWidth, height: focusHeight };
      pane = { left: centerLeft, top: centerTop, width: focusWidth, height: focusHeight };
    } else if (cell.edge === 'left') {
      clip = { left: 0, top: centerTop, width: sideSizePx, height: focusHeight };
      pane = { left: centerLeft - focusWidth, top: centerTop, width: focusWidth, height: focusHeight };
    } else if (cell.edge === 'right') {
      clip = {
        left: layoutViewportWidth - sideSizePx,
        top: centerTop,
        width: sideSizePx,
        height: focusHeight,
      };
      pane = { left: centerLeft + focusWidth, top: centerTop, width: focusWidth, height: focusHeight };
    } else if (cell.edge === 'top') {
      const topWidth = focusWidth;
      const topLeft = layout.form === 'landscape' ? focusWidth + JUNCTION_PREVIEW_GAP_PX : centerLeft;
      clip = { left: topLeft, top: 0, width: topWidth, height: topBottomSizePx };
      pane = { left: topLeft, top: centerTop - focusHeight, width: topWidth, height: focusHeight };
    } else if (cell.edge === 'bottom') {
      const bottomWidth = focusWidth;
      const bottomLeft = layout.form === 'landscape' ? focusWidth + JUNCTION_PREVIEW_GAP_PX : centerLeft;
      clip = {
        left: bottomLeft,
        top: resolvedViewportHeight - topBottomSizePx,
        width: bottomWidth,
        height: topBottomSizePx,
      };
      pane = { left: bottomLeft, top: centerTop + focusHeight, width: bottomWidth, height: focusHeight };
    }

    cellRects.set(coordinateKey(cell), { clip, pane, isFocus });
  }

  const usedSessionIds = new Set(
    lattice.cells
      .filter((candidate) => (
        candidate.col !== slotMenu?.coordinate.col
        || candidate.row !== slotMenu?.coordinate.row
      ))
      .map((candidate) => candidate.target.sessionId),
  );
  const menuCatalog: TerminalPreviewSlotMenuCandidate[] = slotMenuCandidates ?? candidates;
  const menuCandidates = menuCatalog.filter((candidate) => !usedSessionIds.has(candidate.id));
  const menuSession = slotMenu?.existingSessionId
    ? candidates.find((candidate) => candidate.id === slotMenu.existingSessionId) || null
    : null;

  const onPreviewTouchStartCapture = (event: TouchEvent<HTMLElement>) => {
    const touches = event.touches;
    // A new touch sequence is a fresh user intent. The synthetic click emitted
    // after the previous pinch/pan has no intervening touchstart.
    clearSuppressedPreviewClick();
    if (touches.length >= 2) {
      clearLongPress();
      pinchGestureRef.current = {
        startSpan: Math.max(1, touchSpan(touches)),
        startY: (touches[0]?.clientY + touches[1]?.clientY) / 2,
        cwdStepFired: false,
      };
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (touches.length === 1) {
      const touch = touches[0];
      previewHorizontalSwipeRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        locked: 'none',
        fired: false,
        exitArmed: isPreviewEdgeExitGesture(touch.clientX),
      };
    }
  };

  const onPreviewTouchMoveCapture = (event: TouchEvent<HTMLElement>) => {
    const touches = event.touches;
    const pinch = pinchGestureRef.current;
    if (pinch && touches.length >= 2) {
      const dy = ((touches[0]?.clientY + touches[1]?.clientY) / 2) - pinch.startY;
      if (!pinch.cwdStepFired && Math.abs(dy) >= PREVIEW_CWD_PINCH_LOCK_PX) {
        pinch.cwdStepFired = true;
        onPinchVerticalCwdStep?.(dy > 0 ? 'next' : 'previous');
      }
      suppressNextPreviewClick();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const horizontalSwipe = previewHorizontalSwipeRef.current;
    if (horizontalSwipe && touches.length === 1) {
      const touch = touches[0];
      const dx = touch.clientX - horizontalSwipe.startX;
      const dy = touch.clientY - horizontalSwipe.startY;
      if (horizontalSwipe.locked === 'none' && Math.hypot(dx, dy) >= PREVIEW_SESSION_SWIPE_LOCK_PX) {
        if (Math.abs(dx) <= Math.abs(dy)) return;
        if (
          horizontalSwipe.exitArmed
          && dx > 0
        ) {
          horizontalSwipe.locked = 'exit';
          return;
        }
        horizontalSwipe.locked = 'session';
      }
      if (horizontalSwipe.locked === 'session' && !horizontalSwipe.fired && Math.abs(dx) >= PREVIEW_SESSION_SWIPE_MIN_DX) {
        horizontalSwipe.fired = true;
        onCycleSession?.(dx < 0 ? 'next' : 'previous');
        suppressNextPreviewClick();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
  };

  const onPreviewTouchEndCapture = (event: TouchEvent<HTMLElement>) => {
    const horizontalSwipe = previewHorizontalSwipeRef.current;
    if (pinchGestureRef.current) {
      if (event.touches.length < 2) {
        pinchGestureRef.current = null;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    previewHorizontalSwipeRef.current = null;
    if (horizontalSwipe?.locked === 'exit' && event.changedTouches.length > 0) {
      const touch = event.changedTouches[0];
      const dx = touch.clientX - horizontalSwipe.startX;
      const dy = touch.clientY - horizontalSwipe.startY;
      if (dx >= PREVIEW_SESSION_SWIPE_MIN_DX && Math.abs(dx) > Math.abs(dy)) {
        suppressNextPreviewClick();
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      return;
    }
  };

  const onPreviewTouchCancelCapture = () => {
    pinchGestureRef.current = null;
    previewHorizontalSwipeRef.current = null;
  };

  const renderPreviewCell = (
    cell: JunctionPreviewCoordinate & { edge?: string },
    rect: {
      clip?: { left: number; top: number; width: number; height: number };
      pane?: { left: number; top: number; width: number; height: number };
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      isFocus?: boolean;
    },
  ) => {
    const session = resolveJunctionPreviewCell(lattice, cell, candidates);
    const canPan = !rect.isFocus && Boolean(session);
    const tone = session ? getServerIdentityTone(session) : null;
    const title = session ? session.customName || session.title || session.sessionName || session.id : '';
    const clip = rect.clip || {
      left: rect.left || 0,
      top: rect.top || 0,
      width: rect.width || 0,
      height: rect.height || 0,
    };
    const pane = rect.pane || clip;
    return (
      <div
        key={coordinateKey(cell)}
        data-testid={session
          ? `terminal-preview-tile-${session.id}`
          : `terminal-preview-empty-${cell.col}-${cell.row}`}
        data-preview-coordinate={coordinateKey(cell)}
        data-preview-edge={cell.edge}
        data-preview-focus={rect.isFocus ? 'true' : 'false'}
        data-preview-session-id={session?.id || ''}
        role={session ? undefined : 'button'}
        tabIndex={session ? undefined : 0}
        onClick={session
          ? () => {
            if (consumeSuppressedPreviewClick()) return;
            const suppressed = suppressClickRef.current;
            suppressClickRef.current = null;
            if (suppressClickTimerRef.current !== null) {
              window.clearTimeout(suppressClickTimerRef.current);
              suppressClickTimerRef.current = null;
            }
            if (suppressed?.col === cell.col && suppressed.row === cell.row) {
              return;
            }
            if (canPan) onFocusChange({ col: cell.col, row: cell.row });
          }
          : () => {
            if (consumeSuppressedPreviewClick()) return;
            setSlotMenu({ coordinate: { col: cell.col, row: cell.row } });
          }}
        onKeyDown={session ? undefined : (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setSlotMenu({ coordinate: { col: cell.col, row: cell.row } });
        }}
        onPointerDown={(event) => {
          if (!session || rect.isFocus) return;
          startLongPress({ col: cell.col, row: cell.row }, session.id, event);
        }}
        onPointerMove={updateLongPress}
        onPointerUp={clearLongPress}
        onPointerCancel={finishLongPress}
        onContextMenu={(event) => {
          if (!session || rect.isFocus) return;
          event.preventDefault();
          setSlotMenu({
            coordinate: { col: cell.col, row: cell.row },
            existingSessionId: session.id,
          });
        }}
        style={{
          position: 'absolute',
          left: clip.left,
          top: clip.top,
          width: clip.width,
          height: clip.height,
          overflow: 'hidden',
          border: rect.isFocus ? `1px solid ${mobileTheme.colors.cardBorder}` : 'none',
          background: mobileTheme.colors.canvas,
          boxSizing: 'border-box',
        }}
      >
        {session ? (
          <div
            data-testid={`terminal-preview-body-${session.id}`}
            data-preview-scroll-surface="true"
            style={{
              position: 'absolute',
              left: pane.left - clip.left,
              top: pane.top - clip.top,
              width: pane.width,
              height: pane.height,
            }}
          >
            <TerminalView
              sessionId={session.id}
              sessionBufferStore={sessionBufferStore}
              active={false}
              live
              projectionMode="preview-primary"
              allowDomFocus={false}
              domInputOffscreen
              focusNonce={0}
              fontSize={fontSize}
              rowHeight={`${rowHeightPx}px`}
              themeId={themeId || 'default'}
              widthMode="mirror-fixed"
              showAbsoluteLineNumbers={false}
              copyModeActive={false}
              splitVisible
            />
          </div>
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontSize: '22px', fontWeight: 900, color: mobileTheme.colors.textSecondary }}>+</span>
          </div>
        )}
        {session && tone ? (
          <div
            data-preview-chip="true"
            style={{
              position: 'absolute',
              left: 2,
              top: 2,
              maxWidth: 'calc(100% - 4px)',
              padding: '1px 4px',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              background: tone.previewBackground,
              color: tone.previewText,
              borderRadius: '3px',
              fontSize: '9px',
              fontWeight: 800,
              pointerEvents: 'none',
            }}
          >
            {title} · {resolveServerDisplayName(session)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section
      data-testid="terminal-preview-grid"
      data-layout-form={layout.form}
      data-columns={layout.centerColumns}
      aria-label="终端快捷预览"
      onTouchStartCapture={onPreviewTouchStartCapture}
      onTouchMoveCapture={onPreviewTouchMoveCapture}
      onTouchEndCapture={onPreviewTouchEndCapture}
      onTouchCancelCapture={onPreviewTouchCancelCapture}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 12,
        display: 'flex',
        flexDirection: 'column',
        background: mobileTheme.colors.shell,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          height: '36px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 850, color: mobileTheme.colors.textPrimary }}>
          交界取景
        </span>
        <AmbientButton
          type="button"
          aria-label="退出终端预览"
          onClick={onClose}
          style={{
            width: '30px',
            height: '30px',
            border: `1px solid ${mobileTheme.colors.cardBorder}`,
            borderRadius: '6px',
            background: mobileTheme.colors.canvas,
            color: mobileTheme.colors.textPrimary,
            fontSize: '18px',
            lineHeight: 1,
          }}
        >
          ×
        </AmbientButton>
      </header>

      <div ref={contentRef} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
          }}
        >
          {layout.visibleCells.map((cell) => {
            const rect = cellRects.get(coordinateKey(cell));
            return rect ? renderPreviewCell(cell, rect) : null;
          })}
        </div>

        {slotMenu ? (
          <div
            role="menu"
            aria-label={`配置预览格 ${slotMenu.coordinate.col},${slotMenu.coordinate.row}`}
            data-testid="terminal-preview-slot-menu"
            data-preview-menu-surface="true"
            style={{
              position: 'absolute',
              left: 10,
              right: 10,
              bottom: 10,
              zIndex: 18,
              border: `1px solid ${mobileTheme.colors.cardBorder}`,
              borderRadius: '8px',
              background: mobileTheme.colors.canvas,
              boxShadow: 'var(--zterm-settings-shadow)',
              padding: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              maxHeight: '60%',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ color: mobileTheme.colors.textPrimary, fontSize: '12px', fontWeight: 850 }}>
                {menuSession
                  ? `重选格 ${slotMenu.coordinate.col},${slotMenu.coordinate.row}`
                  : `给空格 ${slotMenu.coordinate.col},${slotMenu.coordinate.row} 指定 session`}
              </span>
              <AmbientButton
                type="button"
                aria-label="关闭预览格菜单"
                onClick={() => setSlotMenu(null)}
                style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '6px',
                  border: `1px solid ${mobileTheme.colors.cardBorder}`,
                  background: mobileTheme.colors.shell,
                  color: mobileTheme.colors.textPrimary,
                }}
              >
                ×
              </AmbientButton>
            </div>
            {menuSession ? (
              <AmbientButton
                type="button"
                role="menuitem"
                data-testid={`terminal-preview-clear-${slotMenu.coordinate.col}-${slotMenu.coordinate.row}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onClearCell(slotMenu.coordinate);
                  setSlotMenu(null);
                }}
                style={{
                  minHeight: '38px',
                  borderRadius: '6px',
                  border: '1px solid var(--zterm-settings-border)',
                  background: mobileTheme.colors.shell,
                  color: mobileTheme.colors.textPrimary,
                }}
              >
                清空格位
              </AmbientButton>
            ) : null}
            {menuCandidates.length > 0 ? menuCandidates.map((candidate) => {
              const candidateTone = resolveSlotMenuCandidateTone(candidate);
              return (
                <AmbientButton
                  key={`${slotMenu.coordinate.col}:${slotMenu.coordinate.row}:${candidate.id}`}
                  type="button"
                  role="menuitem"
                  data-testid={`terminal-preview-assign-${candidate.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSetCell(slotMenu.coordinate, candidate.id);
                    setSlotMenu(null);
                  }}
                  style={{
                    minHeight: '38px',
                    borderRadius: '6px',
                    border: `1px solid ${candidateTone.lightCardBorder}`,
                    background: candidateTone.previewBackground,
                    color: mobileTheme.colors.textPrimary,
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '0 10px',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 800 }}>
                    {candidate.title || candidate.sessionName || candidate.id}
                  </span>
                  <span style={{
                    color: candidateTone.previewText,
                    fontSize: '10px',
                    maxWidth: '90px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {resolveSlotMenuCandidateHostLabel(candidate)}
                  </span>
                </AmbientButton>
              );
            }) : (
              <div role="note" style={{ color: mobileTheme.colors.textSecondary, fontSize: '12px', padding: '4px 2px' }}>
                没有可用的 session
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
});
