import { resolveSessionGroupSlotTone } from './terminal-session-drawer-helpers';
import type { TerminalSessionGroupLayoutAxis } from '../../lib/plugin-session-drawer/session-drawer-contract';
import { AmbientButton } from '../ambient';

interface Props {
  sessionId: string;
  title: string;
  x: number;
  y: number;
  axis: TerminalSessionGroupLayoutAxis;
  onAssign?: (sessionId: string, slot: 'top' | 'center' | 'bottom') => void;
  onHide?: (sessionId: string) => void;
  onClose: () => void;
}

export function TerminalSessionDrawerSlotMenu({ sessionId, title, x, y, axis, onAssign, onHide, onClose }: Props) {
  const slots = [['top', axis === 'horizontal' ? '放到左侧' : '放到上方'], ['center', '放到中间'], ['bottom', axis === 'horizontal' ? '放到右侧' : '放到下方']] as const;
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
    <div className="t-dropdown is-open" data-origin="top-left" data-testid="terminal-session-drawer-slot-menu" style={{ position: 'fixed', left: `${Math.min(Math.max(12, x), 190)}px`, top: `${Math.max(72, y - 18)}px`, zIndex: 170, width: '160px', padding: '8px', borderRadius: '14px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-bg)', boxShadow: '0 14px 30px var(--zterm-panel-shadow)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ padding: '2px 4px 5px', color: 'var(--zterm-panel-muted)', fontSize: '11px', lineHeight: 1.3 }}>操作 {title}</div>
      {onAssign ? slots.map(([slot, label]) => { const tone = resolveSessionGroupSlotTone(slot, axis); return <AmbientButton key={slot} type="button" data-testid={`terminal-session-drawer-slot-menu-${slot}`} onClick={(event) => { event.stopPropagation(); onAssign(sessionId, slot); onClose(); }} style={{ height: '34px', borderRadius: '10px', border: `1px solid ${tone?.border || 'var(--zterm-panel-border)'}`, background: tone?.background || 'var(--zterm-panel-surface)', color: tone?.color || 'var(--zterm-panel-text)', fontSize: '13px', fontWeight: 800 }}>{label}</AmbientButton>; }) : null}
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
            height: '34px',
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
      <AmbientButton type="button" data-testid="terminal-session-drawer-slot-menu-cancel" onClick={(event) => { event.stopPropagation(); onClose(); }} style={{ height: '32px', borderRadius: '10px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-surface)', color: 'var(--zterm-panel-muted)', fontSize: '12px', fontWeight: 750 }}>取消</AmbientButton>
    </div>
  </>;
}
