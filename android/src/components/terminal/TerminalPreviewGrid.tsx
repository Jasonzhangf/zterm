import { memo, useEffect, useRef, useState } from 'react';
import { TerminalView } from '../TerminalView';
import type { SessionRenderBufferStore } from '../../lib/session-render-buffer-store';
import type { Session } from '../../lib/types';
import { getServerIdentityTone, resolveServerDisplayName } from '../../lib/server-identity';
import { mobileTheme } from '../../lib/mobile-ui';
import { WindowGroupLayout } from './WindowGroupLayout';

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
  onClose: () => void;
}

const PREVIEW_TILE_LONG_PRESS_MS = 420;

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
  onClose,
}: TerminalPreviewGridProps) {
  const exitGestureRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressActivationClickRef = useRef<string | null>(null);
  const [replacementSourceSessionId, setReplacementSourceSessionId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [moveSourceSessionId, setMoveSourceSessionId] = useState<string | null>(null);
  const [primaryPreviewSessionId, setPrimaryPreviewSessionId] = useState<string | null>(() => sessions[0]?.id || null);
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

  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);

  useEffect(() => {
    if (sessions.some((session) => session.id === primaryPreviewSessionId)) {
      return;
    }
    setPrimaryPreviewSessionId(sessions[0]?.id || null);
  }, [primaryPreviewSessionId, sessions]);

  const renderPreviewTile = (session: Session, index: number, variant: 'primary' | 'secondary') => {
    const tone = getServerIdentityTone(session);
    const title = session.customName || session.title || session.sessionName || session.id;
    const compact = variant === 'secondary';
    const previewFontSize = compact
      ? Math.max(4, Math.min(5, fontSize - 5))
      : Math.max(5, Math.min(7, fontSize - 3));
    const previewRowHeight = compact
      ? `${Math.max(6, Math.min(8, fontSize - 2))}px`
      : `${Math.max(7, Math.min(10, fontSize))}px`;
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
              suppressActivationClickRef.current = session.id;
              setReplacementSourceSessionId(session.id);
            }, PREVIEW_TILE_LONG_PRESS_MS);
          }}
          onPointerMove={(event) => {
            const start = longPressStartRef.current;
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
              suppressActivationClickRef.current = session.id;
              clearLongPress();
            }
          }}
          onPointerUp={clearLongPress}
          onPointerCancel={clearLongPress}
          onPointerLeave={clearLongPress}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            suppressActivationClickRef.current = session.id;
            setReplacementSourceSessionId(session.id);
          }}
          onClick={(event) => {
            if (suppressActivationClickRef.current === session.id) {
              event.preventDefault();
              event.stopPropagation();
              suppressActivationClickRef.current = null;
              return;
            }
            if (variant === 'secondary') {
              event.preventDefault();
              event.stopPropagation();
              setPrimaryPreviewSessionId(session.id);
              return;
            }
            onActivateSession(session.id);
          }}
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
            onPointerDown={(event) => {
              event.stopPropagation();
              clearLongPress();
              longPressStartRef.current = { x: event.clientX, y: event.clientY };
              longPressTimerRef.current = window.setTimeout(() => {
                longPressTimerRef.current = null;
                longPressStartRef.current = null;
                suppressActivationClickRef.current = session.id;
                setMoveSourceSessionId(session.id);
                setReplacementSourceSessionId(null);
                setAddMenuOpen(false);
              }, PREVIEW_TILE_LONG_PRESS_MS);
            }}
            onPointerMove={(event) => {
              event.stopPropagation();
              const start = longPressStartRef.current;
              if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
                suppressActivationClickRef.current = session.id;
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
              gridTemplateColumns: compact ? '16px minmax(0, 1fr) 20px' : '18px minmax(0, 1fr) 54px 20px',
              alignItems: 'center', gap: '4px',
              padding: '0 4px 0 6px', background: tone.previewBackground, boxSizing: 'border-box',
            }}
          >
            <span style={{ color: tone.previewText, fontSize: compact ? '9px' : '10px', fontWeight: 900 }}>{index + 1}</span>
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
            onPointerDown={(event) => {
              event.stopPropagation();
              clearLongPress();
            }}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden', pointerEvents: 'auto' }}
          >
            <TerminalView
              sessionId={session.id}
              sessionBufferStore={sessionBufferStore}
              active={false}
              live
              allowDomFocus={false}
              domInputOffscreen
              focusNonce={0}
              fontSize={previewFontSize}
              rowHeight={previewRowHeight}
              themeId={themeId || 'default'}
              widthMode="mirror-fixed"
              showAbsoluteLineNumbers={false}
              copyModeActive={false}
              splitVisible={false}
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
            session.id === (primaryPreviewSessionId || sessions[0]?.id) ? 'primary' : 'secondary',
          ),
          testId: `terminal-preview-secondary-${session.id}`,
          roleLabel: `切换预览主窗口 ${session.customName || session.title || session.sessionName || session.id}`,
        }))}
        primaryItemId={primaryPreviewSessionId || sessions[0]?.id || null}
        onPrimaryItemChange={setPrimaryPreviewSessionId}
        landscape={landscape}
        style={{ flex: 1, minHeight: 0 }}
      />
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
