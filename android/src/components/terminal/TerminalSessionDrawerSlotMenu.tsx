import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { resolveSessionGroupSlotTone } from './terminal-session-drawer-helpers';
import type { TerminalSessionGroupLayoutAxis } from '../../lib/plugin-session-drawer/session-drawer-contract';
import { AmbientButton } from '../ambient';
import {
  SLOT_MENU_WIDTH_PX,
  computeSlotMenuPosition,
  estimateSlotMenuHeight,
} from './terminal-session-drawer-slot-menu-position';

interface Props {
  sessionId: string;
  title: string;
  x: number;
  y: number;
  anchorTop?: number;
  axis: TerminalSessionGroupLayoutAxis;
  onAssign?: (sessionId: string, slot: 'top' | 'center' | 'bottom') => void;
  onHide?: (sessionId: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onClose: () => void;
}

export function TerminalSessionDrawerSlotMenu({ sessionId, title, x, y, anchorTop, axis, onAssign, onHide, onCloseSession, onClose }: Props) {
  const slots = [['top', axis === 'horizontal' ? '放到左侧' : '放到上方'], ['center', '放到中间'], ['bottom', axis === 'horizontal' ? '放到右侧' : '放到下方']] as const;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const actionCount = (onAssign ? slots.length : 0) + (onHide ? 1 : 0) + (onCloseSession ? 1 : 0) + 1;
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = () => setViewportTick((tick) => tick + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) {
      return;
    }
    // Use scrollHeight so a clamped `maxHeight` does not feed back into the
    // natural content height that drives placement.
    const height = node.scrollHeight || node.getBoundingClientRect().height;
    if (height > 0 && Math.abs(height - measuredHeight) > 0.5) {
      setMeasuredHeight(height);
    }
  }, [actionCount, measuredHeight, viewportTick]);
  const menuHeight = measuredHeight > 0 ? measuredHeight : estimateSlotMenuHeight(actionCount);
  const viewportWidth = typeof window === 'undefined' ? SLOT_MENU_WIDTH_PX + 24 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 640 : window.innerHeight;
  const position = computeSlotMenuPosition({
    anchorTop: anchorTop ?? y,
    anchorBottom: y,
    anchorLeft: x,
    viewportWidth,
    viewportHeight,
    menuHeight,
  });
  return <>
    <AmbientButton
      type="button"
      data-testid="terminal-session-drawer-slot-menu-scrim"
      aria-label="关闭位置菜单"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 169,
        border: 0,
        padding: 0,
        background: 'transparent',
      }}
    />
    <div ref={menuRef} className="t-dropdown is-open" data-origin="top-left" data-testid="terminal-session-drawer-slot-menu" style={{ position: 'fixed', left: `${position.left}px`, top: `${position.top}px`, maxHeight: `${position.maxHeight}px`, overflowY: position.placement === 'clamped' ? 'auto' : undefined, zIndex: 170, width: `${SLOT_MENU_WIDTH_PX}px`, padding: '8px', borderRadius: '14px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-bg)', boxShadow: '0 14px 30px var(--zterm-panel-shadow)', display: 'flex', flexDirection: 'column', gap: '8px', boxSizing: 'border-box' }}>
      <div style={{ padding: '0 4px 4px', color: 'var(--zterm-panel-muted)', fontSize: '11px', lineHeight: 1.3 }}>操作 {title}</div>
      {onAssign ? slots.map(([slot, label]) => { const tone = resolveSessionGroupSlotTone(slot, axis); return <AmbientButton key={slot} type="button" data-testid={`terminal-session-drawer-slot-menu-${slot}`} onClick={(event) => { event.stopPropagation(); onAssign(sessionId, slot); onClose(); }} style={{ height: '44px', borderRadius: '10px', border: `1px solid ${tone?.border || 'var(--zterm-panel-border)'}`, background: tone?.background || 'var(--zterm-panel-surface)', color: tone?.color || 'var(--zterm-panel-text)', fontSize: '13px', fontWeight: 800 }}>{label}</AmbientButton>; }) : null}
      {onHide ? (
        <AmbientButton
          type="button"
          data-testid="terminal-session-drawer-slot-menu-hide"
          onClick={(event) => {
            event.stopPropagation();
            onHide(sessionId);
            onClose();
          }}
          style={{
            height: '44px',
            borderRadius: '10px',
            border: '1px solid var(--zterm-panel-border)',
            background: 'var(--zterm-panel-surface)',
            color: 'var(--zterm-panel-text)',
            fontSize: '13px',
            fontWeight: 800,
          }}
        >
          隐藏会话
        </AmbientButton>
      ) : null}
      {onCloseSession ? (
        <AmbientButton
          type="button"
          data-testid="terminal-session-drawer-slot-menu-close"
          onClick={(event) => {
            event.stopPropagation();
            onCloseSession(sessionId);
            onClose();
          }}
          style={{
            height: '44px',
            borderRadius: '10px',
            border: '1px solid var(--zterm-panel-danger-border)',
            background: 'var(--zterm-panel-danger-soft)',
            color: 'var(--zterm-panel-danger)',
            fontSize: '13px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
        >
          关闭会话
        </AmbientButton>
      ) : null}
      <AmbientButton type="button" data-testid="terminal-session-drawer-slot-menu-cancel" onClick={(event) => { event.stopPropagation(); onClose(); }} style={{ height: '44px', borderRadius: '10px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-surface)', color: 'var(--zterm-panel-muted)', fontSize: '12px', fontWeight: 750 }}>取消</AmbientButton>
    </div>
  </>;
}
