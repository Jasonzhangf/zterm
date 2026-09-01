import { memo, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { TerminalView } from '../TerminalView';
import type { SessionRenderBufferStore } from '../../lib/session-render-buffer-store';
import type { Session } from '../../lib/types';
import { getServerIdentityTone, resolveServerDisplayName } from '../../lib/server-identity';
import { mobileTheme } from '../../lib/mobile-ui';
import { WindowGroupLayout } from './WindowGroupLayout';
import { encodeTerminalSgrMouseClick, TERMINAL_MOUSE_LEFT_BUTTON } from '../../lib/terminal-mouse-wheel-sgr';

export interface TerminalPreviewGridProps {
  sessions: Session[];
  replacementCandidates?: Session[];
  sessionBufferStore?: SessionRenderBufferStore | null;
  landscape: boolean;
  fontSize: number;
  themeId?: string;
  onActivateSession: (sessionId: string) => void;
  onAddSession?: (sessionId: string) => void;
  onRemoveSession?: (sessionId: string) => void;
  onMoveSession?: (sourceSessionId: string, targetIndex: number) => void;
  onReplaceSession?: (sourceSessionId: string, replacementSessionId: string) => void;
  onPrimarySessionChange?: (sessionId: string) => void;
  onTerminalInput?: (sessionId: string, data: string) => void;
  onClose: () => void;
}

const PREVIEW_TILE_LONG_PRESS_MS = 420;

// Approximate char width ratio for preview font calculation
const PREVIEW_CHAR_WIDTH_RATIO = 0.55;

// Compute terminal row/col from click position in preview body
// titlebarHeight: non-compact=24px, compact=22px
// previewFontSize: non-compact=5-7, compact=3
// previewRows: estimated ~10 for non-compact, ~30 for compact
function computePreviewClickPosition(
  clientX: number,
  clientY: number,
  element: HTMLElement,
  compact: boolean,
): { row: number; col: number } {
  const rect = element.getBoundingClientRect();
  const titlebarHeight = compact ? 22 : 24;
  const previewFontSize = compact ? 3 : 6;
  const charHeight = previewFontSize;
  const charWidth = previewFontSize * PREVIEW_CHAR_WIDTH_RATIO;
  
  // Relative position within the body (below titlebar)
  const relY = clientY - rect.top - titlebarHeight;
  const relX = clientX - rect.left;
  
  // Compute row/col (1-based for SGR protocol)
  const row = Math.max(1, Math.floor(relY / charHeight) + 1);
  const col = Math.max(1, Math.floor(relX / charWidth) + 1);
  
  return { row, col };
}


export const TerminalPreviewGrid = memo(function TerminalPreviewGrid({
  sessions,
  replacementCandidates = [],
  sessionBufferStore = null,
  landscape,
  fontSize,
  themeId,
  onActivateSession,
  onAddSession,
  onRemoveSession,
  onMoveSession,
  onReplaceSession,
  onPrimarySessionChange,
  onTerminalInput,
  onClose,
}: TerminalPreviewGridProps) {
  const exitGestureRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressActivationClickRef = useRef<string | null>(null);
  const suppressActivationClickTimerRef = useRef<number | null>(null);
  const bodyGestureStartRef = useRef<{ sessionId: string; x: number; y: number } | null>(null);
  const [replacementSourceSessionId, setReplacementSourceSessionId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [moveSourceSessionId, setMoveSourceSessionId] = useState<string | null>(null);
  const [edgeQueueVisible, setEdgeQueueVisible] = useState(false);
  const [primaryPreviewSessionId, setPrimaryPreviewSessionId] = useState<string | null>(() => sessions[0]?.id || null);
  const resolvedPrimaryPreviewSessionId = sessions.some((session) => session.id === primaryPreviewSessionId)
    ? primaryPreviewSessionId
    : (sessions[0]?.id || null);
  const replacementSourceSession = sessions.find((session) => session.id === replacementSourceSessionId) || null;
  const moveSourceSession = sessions.find((session) => session.id === moveSourceSessionId) || null;
  const canAddSession = sessions.length < 6 && replacementCandidates.length > 0;

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = null;
    longPressStartRef.current = null;
  };

  const clearSuppressedActivationClick = () => {
    if (suppressActivationClickTimerRef.current !== null) {
      window.clearTimeout(suppressActivationClickTimerRef.current);
    }
    suppressActivationClickTimerRef.current = null;
    suppressActivationClickRef.current = null;
  };

  const suppressNextActivationClick = (sessionId: string) => {
    if (suppressActivationClickTimerRef.current !== null) {
      window.clearTimeout(suppressActivationClickTimerRef.current);
    }
    suppressActivationClickRef.current = sessionId;
    suppressActivationClickTimerRef.current = window.setTimeout(() => {
      if (suppressActivationClickRef.current === sessionId) {
        suppressActivationClickRef.current = null;
      }
      suppressActivationClickTimerRef.current = null;
    }, 500);
  };

  const consumeSuppressedActivationClick = (sessionId: string) => {
    if (suppressActivationClickRef.current !== sessionId) {
      return false;
    }
    clearSuppressedActivationClick();
    return true;
  };

  const beginBodyGesture = (sessionId: string, x: number, y: number) => {
    clearLongPress();
    bodyGestureStartRef.current = { sessionId, x, y };
  };

  const updateBodyGesture = (sessionId: string, x: number, y: number) => {
    const start = bodyGestureStartRef.current;
    if (!start || start.sessionId !== sessionId) {
      return;
    }
    if (Math.hypot(x - start.x, y - start.y) > 8) {
      suppressNextActivationClick(sessionId);
    }
  };

  const finishBodyGesture = () => {
    bodyGestureStartRef.current = null;
    clearLongPress();
  };

  const beginBodyPointerGesture = (sessionId: string, event: PointerEvent<HTMLElement>) => {
    beginBodyGesture(sessionId, event.clientX, event.clientY);
  };

  const updateBodyPointerGesture = (sessionId: string, event: PointerEvent<HTMLElement>) => {
    updateBodyGesture(sessionId, event.clientX, event.clientY);
  };

  const beginBodyTouchGesture = (sessionId: string, event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0] || event.changedTouches[0];
    if (!touch) {
      return;
    }
    beginBodyGesture(sessionId, touch.clientX, touch.clientY);
  };

  const updateBodyTouchGesture = (sessionId: string, event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0] || event.changedTouches[0];
    if (!touch) {
      return;
    }
    updateBodyGesture(sessionId, touch.clientX, touch.clientY);
  };

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    if (suppressActivationClickTimerRef.current !== null) {
      window.clearTimeout(suppressActivationClickTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (sessions.some((session) => session.id === primaryPreviewSessionId)) {
      return;
    }
    setPrimaryPreviewSessionId(sessions[0]?.id || null);
  }, [primaryPreviewSessionId, sessions]);

  useEffect(() => {
    if (!resolvedPrimaryPreviewSessionId) {
      return;
    }
    onPrimarySessionChange?.(resolvedPrimaryPreviewSessionId);
  }, [onPrimarySessionChange, resolvedPrimaryPreviewSessionId]);

  const renderPreviewTile = (session: Session, index: number, variant: 'primary' | 'secondary') => {
    const tone = getServerIdentityTone(session);
    const title = session.customName || session.title || session.sessionName || session.id;
    const compact = variant === 'secondary';
    const previewFontSize = compact
      ? 3
      : Math.max(5, Math.min(7, fontSize - 3));
    const previewRowHeight = compact
      ? '4px'
      : `${Math.max(7, Math.min(10, fontSize))}px`;
    const handlePreviewClick = (event: MouseEvent<HTMLElement>) => {
      if (consumeSuppressedActivationClick(session.id)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (compact) {
        setPrimaryPreviewSessionId(session.id);
        return;
      }
      onActivateSession(session.id);
    };
    return (
      <div
        key={session.id}
        style={{
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          flex: 1,
        }}
      >
        <div
          role="button"
          tabIndex={0}
          data-testid={`terminal-preview-tile-${session.id}`}
          data-preview-session-id={session.id}
          data-preview-order={index + 1}
          data-preview-variant={variant}
          onPointerDown={(event) => {
            clearLongPress();
            longPressStartRef.current = { x: event.clientX, y: event.clientY };
            longPressTimerRef.current = window.setTimeout(() => {
              longPressTimerRef.current = null;
              longPressStartRef.current = null;
              suppressNextActivationClick(session.id);
              setReplacementSourceSessionId(session.id);
            }, PREVIEW_TILE_LONG_PRESS_MS);
          }}
          onPointerMove={(event) => {
            const start = longPressStartRef.current;
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
              suppressNextActivationClick(session.id);
              clearLongPress();
            }
          }}
          onPointerUp={clearLongPress}
          onPointerCancel={clearLongPress}
          onPointerLeave={clearLongPress}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            suppressNextActivationClick(session.id);
            setReplacementSourceSessionId(session.id);
          }}
          onClick={handlePreviewClick}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (variant === 'secondary') {
              setPrimaryPreviewSessionId(session.id);
              return;
            }
            onActivateSession(session.id);
          }}
          style={{
            width: '100%', height: '100%', minWidth: 0, minHeight: 0, padding: 0,
            overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column',
            border: `1px solid ${tone.lightCardBorder}`, borderRadius: '6px',
            background: mobileTheme.colors.canvas, color: mobileTheme.colors.textPrimary, textAlign: 'left',
          }}
        >
          <span
            data-preview-titlebar="true"
            onClick={handlePreviewClick}
            onPointerDown={(event) => {
              event.stopPropagation();
              clearLongPress();
              longPressStartRef.current = { x: event.clientX, y: event.clientY };
              longPressTimerRef.current = window.setTimeout(() => {
                longPressTimerRef.current = null;
                longPressStartRef.current = null;
                suppressNextActivationClick(session.id);
                setMoveSourceSessionId(session.id);
                setReplacementSourceSessionId(null);
                setAddMenuOpen(false);
              }, PREVIEW_TILE_LONG_PRESS_MS);
            }}
            onPointerMove={(event) => {
              event.stopPropagation();
              const start = longPressStartRef.current;
              if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
                suppressNextActivationClick(session.id);
                clearLongPress();
              }
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
              clearLongPress();
            }}
            onPointerCancel={(event) => {
              event.stopPropagation();
              clearLongPress();
            }}
            style={{
              height: compact ? '22px' : '24px', flexShrink: 0, display: 'grid',
              gridTemplateColumns: compact ? 'minmax(0, 1fr) 20px' : 'minmax(0, 1fr) 54px 20px',
              alignItems: 'center', gap: '4px',
              padding: '0 4px 0 8px', background: tone.previewBackground, boxSizing: 'border-box',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: compact ? '9px' : '10px', fontWeight: 800 }}>
              {title}
            </span>
            {!compact ? (
              <span style={{ color: tone.previewText, fontSize: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {resolveServerDisplayName(session)}
              </span>
            ) : null}
            <span aria-hidden="true" />
          </span>
          <span
            data-testid={`terminal-preview-body-${session.id}`}
            data-preview-scroll-surface="true"
            onClick={(event) => {
              handlePreviewClick(event);
              // Sync click to remote terminal via SGR mouse click
              const element = event.currentTarget as HTMLElement;
              const { row, col } = computePreviewClickPosition(
                event.clientX,
                event.clientY,
                element,
                compact,
              );
              const clickSequence = encodeTerminalSgrMouseClick(
                TERMINAL_MOUSE_LEFT_BUTTON,
                col,
                row,
              );
              onTerminalInput?.(session.id, clickSequence);
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              beginBodyPointerGesture(session.id, event);
            }}
            onPointerMove={(event) => {
              event.stopPropagation();
              updateBodyPointerGesture(session.id, event);
            }}
            onPointerUp={(event) => {
              event.stopPropagation();
              finishBodyGesture();
            }}
            onPointerCancel={(event) => {
              event.stopPropagation();
              finishBodyGesture();
            }}
            onTouchStart={(event) => {
              event.stopPropagation();
              beginBodyTouchGesture(session.id, event);
            }}
            onTouchMove={(event) => {
              event.stopPropagation();
              updateBodyTouchGesture(session.id, event);
            }}
            onTouchEnd={(event) => {
              event.stopPropagation();
              finishBodyGesture();
            }}
            onTouchCancel={(event) => {
              event.stopPropagation();
              finishBodyGesture();
            }}
            style={{
              flex: 1,
              minHeight: 0,
              width: '100%',
              overflow: 'hidden',
              pointerEvents: 'auto',
              WebkitTextSizeAdjust: 'none',
              textSizeAdjust: 'none',
            }}
          >
            <TerminalView
              sessionId={session.id}
              sessionBufferStore={sessionBufferStore}
              active={false}
              live
              projectionMode={compact ? 'preview-secondary' : 'preview-primary'}
              allowDomFocus={false}
              domInputOffscreen
              focusNonce={0}
              fontSize={previewFontSize}
              rowHeight={previewRowHeight}
              themeId={themeId || 'default'}
              widthMode="mirror-fixed"
              showAbsoluteLineNumbers={false}
              copyModeActive={false}
              splitVisible
            />
          </span>
        </div>
        <button
          type="button"
          aria-label={`从预览移除 ${title}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemoveSession?.(session.id);
          }}
          style={{
            position: 'absolute', top: '2px', right: '2px', zIndex: 2,
            width: '20px', height: '20px', padding: 0, border: 0, borderRadius: '4px',
            background: 'rgba(0,0,0,0.24)', color: mobileTheme.colors.textPrimary,
            fontSize: '14px', lineHeight: '20px', textAlign: 'center',
          }}
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <section
      data-testid="terminal-preview-grid-shell"
      aria-label="终端快捷预览"
      onTouchStart={(event) => {
        if ((event.target as HTMLElement | null)?.closest('[data-preview-scroll-surface="true"]')) {
          exitGestureRef.current = null;
          return;
        }
        if ((event.target as HTMLElement | null)?.closest('[data-preview-menu-surface="true"]')) {
          exitGestureRef.current = null;
          return;
        }
        const touch = event.touches[0];
        exitGestureRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(event) => {
        const start = exitGestureRef.current;
        exitGestureRef.current = null;
        const touch = event.changedTouches[0];
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dx >= 48 && Math.abs(dx) > Math.abs(dy)) onClose();
      }}
      onPointerMove={(event) => {
        const edgeDistance = Math.min(event.clientX, window.innerWidth - event.clientX);
        if (edgeDistance <= 28) setEdgeQueueVisible(true);
      }}
      onPointerLeave={() => setEdgeQueueVisible(false)}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 12,
        display: 'flex',
        flexDirection: 'column',
        background: mobileTheme.colors.shell,
        padding: '8px',
        boxSizing: 'border-box',
      }}
    >
      <header
        style={{
          height: '36px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 2px 6px 6px',
        }}
      >
            <span style={{ color: mobileTheme.colors.textPrimary, fontSize: '13px', fontWeight: 800 }}>
              终端预览 · {sessions.length}/6
            </span>
        <button
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
        </button>
      </header>

      <WindowGroupLayout
        testId="terminal-preview-grid"
        items={sessions.slice(0, 6).map((session, index) => ({
          id: session.id,
          node: renderPreviewTile(
            session,
            index,
            session.id === resolvedPrimaryPreviewSessionId ? 'primary' : 'secondary',
          ),
          testId: `terminal-preview-secondary-${session.id}`,
          roleLabel: `切换预览主窗口 ${session.customName || session.title || session.sessionName || session.id}`,
        }))}
        primaryItemId={resolvedPrimaryPreviewSessionId}
        onPrimaryItemChange={setPrimaryPreviewSessionId}
        landscape={landscape}
        secondaryItemFlex="1 1 0"
        style={{ flex: 1, minHeight: 0 }}
      />
      <div
        data-testid="terminal-preview-edge-queue"
        aria-hidden={!edgeQueueVisible}
        style={{
          position: 'absolute', inset: '42px 0 34px', pointerEvents: edgeQueueVisible ? 'auto' : 'none',
          opacity: edgeQueueVisible ? 1 : 0, transition: 'opacity 120ms ease', zIndex: 14,
        }}
        onTouchStart={() => setEdgeQueueVisible(true)}
      >
        <button type="button" aria-label="向上浏览预览队列" onClick={() => setPrimaryPreviewSessionId((current) => {
          const index = Math.max(0, sessions.findIndex((session) => session.id === current));
          return sessions[(index - 1 + sessions.length) % sessions.length]?.id || current;
        })} style={{ position: 'absolute', top: 4, left: 4, width: 34, height: 44, border: 0, borderRadius: 10, background: 'rgba(10,15,22,.72)', color: '#dce8ff' }}>↑</button>
        <button type="button" aria-label="向下浏览预览队列" onClick={() => setPrimaryPreviewSessionId((current) => {
          const index = Math.max(0, sessions.findIndex((session) => session.id === current));
          return sessions[(index + 1) % sessions.length]?.id || current;
        })} style={{ position: 'absolute', bottom: 4, right: 4, width: 34, height: 44, border: 0, borderRadius: 10, background: 'rgba(10,15,22,.72)', color: '#dce8ff' }}>↓</button>
      </div>
      {canAddSession ? (
        <button
          type="button"
          data-testid="terminal-preview-add-row"
          aria-label="增加预览窗口"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setAddMenuOpen(true);
            setReplacementSourceSessionId(null);
            setMoveSourceSessionId(null);
          }}
          style={{
            height: '30px', flexShrink: 0, marginTop: '6px', borderRadius: '6px',
            border: `1px dashed ${mobileTheme.colors.cardBorder}`,
            background: mobileTheme.colors.canvas, color: mobileTheme.colors.textSecondary,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            fontSize: '12px', fontWeight: 800,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: '18px', lineHeight: 1 }}>+</span>
          增加窗口
        </button>
      ) : null}
      {addMenuOpen ? (
        <div
          role="menu"
          aria-label="增加预览窗口"
          data-testid="terminal-preview-add-menu"
          data-preview-menu-surface="true"
          style={{
            position: 'absolute', left: '10px', right: '10px', bottom: '10px', zIndex: 18,
            border: `1px solid ${mobileTheme.colors.cardBorder}`, borderRadius: '8px',
            background: mobileTheme.colors.canvas, boxShadow: '0 16px 40px rgba(0,0,0,0.38)',
            padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px',
            maxHeight: '48%', overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ color: mobileTheme.colors.textPrimary, fontSize: '12px', fontWeight: 850 }}>增加窗口</span>
            <button type="button" aria-label="关闭增加窗口菜单" onClick={() => setAddMenuOpen(false)}
              style={{ width: '26px', height: '26px', borderRadius: '6px', border: `1px solid ${mobileTheme.colors.cardBorder}`, background: mobileTheme.colors.shell, color: mobileTheme.colors.textPrimary }}>
              ×
            </button>
          </div>
          {replacementCandidates.map((candidate) => {
            const tone = getServerIdentityTone(candidate);
            const candidateTitle = candidate.customName || candidate.title || candidate.sessionName || candidate.id;
            return (
              <button
                key={candidate.id}
                type="button"
                role="menuitem"
                data-testid={`terminal-preview-add-${candidate.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onAddSession?.(candidate.id);
                  setAddMenuOpen(false);
                }}
                style={{
                  minHeight: '38px', borderRadius: '6px', border: `1px solid ${tone.lightCardBorder}`,
                  background: tone.previewBackground, color: mobileTheme.colors.textPrimary,
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center',
                  gap: '8px', padding: '0 10px', textAlign: 'left',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 800 }}>{candidateTitle}</span>
                <span style={{ color: tone.previewText, fontSize: '10px', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resolveServerDisplayName(candidate)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {moveSourceSession ? (
        <div
          role="menu"
          aria-label={`移动预览 ${moveSourceSession.customName || moveSourceSession.title || moveSourceSession.sessionName || moveSourceSession.id}`}
          data-testid="terminal-preview-move-menu"
          data-preview-menu-surface="true"
          style={{
            position: 'absolute', left: '10px', right: '10px', bottom: '10px', zIndex: 18,
            border: `1px solid ${mobileTheme.colors.cardBorder}`, borderRadius: '8px',
            background: mobileTheme.colors.canvas, boxShadow: '0 16px 40px rgba(0,0,0,0.38)',
            padding: '8px', display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, sessions.length)}, minmax(0, 1fr))`, gap: '6px',
          }}
        >
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ color: mobileTheme.colors.textPrimary, fontSize: '12px', fontWeight: 850 }}>移动到位置</span>
            <button type="button" aria-label="关闭移动菜单" onClick={() => setMoveSourceSessionId(null)}
              style={{ width: '26px', height: '26px', borderRadius: '6px', border: `1px solid ${mobileTheme.colors.cardBorder}`, background: mobileTheme.colors.shell, color: mobileTheme.colors.textPrimary }}>
              ×
            </button>
          </div>
          {sessions.map((_, targetIndex) => (
            <button
              key={targetIndex}
              type="button"
              role="menuitem"
              data-testid={`terminal-preview-move-to-${targetIndex + 1}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMoveSession?.(moveSourceSession.id, targetIndex);
                setMoveSourceSessionId(null);
              }}
              style={{
                height: '38px', borderRadius: '6px', border: `1px solid ${mobileTheme.colors.cardBorder}`,
                background: mobileTheme.colors.shell, color: mobileTheme.colors.textPrimary, fontWeight: 850,
              }}
            >
              {targetIndex + 1}
            </button>
          ))}
        </div>
      ) : null}
      {replacementSourceSession ? (
        <div
          role="menu"
          aria-label={`替换预览 ${replacementSourceSession.customName || replacementSourceSession.title || replacementSourceSession.sessionName || replacementSourceSession.id}`}
          data-testid="terminal-preview-replacement-menu"
          data-preview-menu-surface="true"
          style={{
            position: 'absolute',
            left: '10px',
            right: '10px',
            bottom: '10px',
            zIndex: 18,
            border: `1px solid ${mobileTheme.colors.cardBorder}`,
            borderRadius: '8px',
            background: mobileTheme.colors.canvas,
            boxShadow: '0 16px 40px rgba(0,0,0,0.38)',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            maxHeight: '48%',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ color: mobileTheme.colors.textPrimary, fontSize: '12px', fontWeight: 850 }}>替换预览</span>
            <button
              type="button"
              aria-label="关闭替换菜单"
              onClick={() => setReplacementSourceSessionId(null)}
              style={{
                width: '26px', height: '26px', borderRadius: '6px', border: `1px solid ${mobileTheme.colors.cardBorder}`,
                background: mobileTheme.colors.shell, color: mobileTheme.colors.textPrimary,
              }}
            >
              ×
            </button>
          </div>
          {replacementCandidates.length > 0 ? replacementCandidates.map((candidate) => {
            const tone = getServerIdentityTone(candidate);
            const candidateTitle = candidate.customName || candidate.title || candidate.sessionName || candidate.id;
            return (
              <button
                key={candidate.id}
                type="button"
                role="menuitem"
                data-testid={`terminal-preview-replace-${candidate.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onReplaceSession?.(replacementSourceSession.id, candidate.id);
                  setReplacementSourceSessionId(null);
                }}
                style={{
                  minHeight: '38px', borderRadius: '6px', border: `1px solid ${tone.lightCardBorder}`,
                  background: tone.previewBackground, color: mobileTheme.colors.textPrimary,
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: '8px',
                  padding: '0 10px', textAlign: 'left',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 800 }}>
                  {candidateTitle}
                </span>
                <span style={{ color: tone.previewText, fontSize: '10px', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {resolveServerDisplayName(candidate)}
                </span>
              </button>
            );
          }) : (
            <div role="note" style={{ color: mobileTheme.colors.textSecondary, fontSize: '12px', padding: '4px 2px' }}>
              没有可替换的未选中 session
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
});
