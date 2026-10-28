import type { Dispatch, SetStateAction } from 'react';
import { AmbientButton, AmbientInput } from '../ambient';
import { DrawerCloseIcon } from './TerminalSessionDrawerIcons';

export interface TerminalSessionDrawerNewSessionDraft { hostKey?: string; sessionName: string; cwd: string; terminalBackend: 'tmux' | 'herdr'; }
interface Props { draft: TerminalSessionDrawerNewSessionDraft; setDraft: Dispatch<SetStateAction<TerminalSessionDrawerNewSessionDraft | null>>; onCancel: () => void; onConfirm: () => void; }

export function TerminalSessionDrawerNewSessionDialog({ draft, setDraft, onCancel, onConfirm }: Props) {
  const fieldStyle = {
    height: '40px',
    borderRadius: '7px',
    border: '1px solid var(--zterm-panel-border)',
    background: 'var(--zterm-panel-surface)',
    color: 'var(--zterm-panel-text)',
    padding: '0 10px',
    fontSize: '13px',
  };
  const compactActionStyle = {
    flex: '1 1 0',
    height: '40px',
    minHeight: '40px',
    borderRadius: '7px',
    fontWeight: 800,
  };

  return (
    <div
      data-testid="terminal-session-drawer-new-session-dialog"
      style={{
        flexShrink: 0,
        padding: '10px 12px 12px',
        borderTop: '1px solid var(--zterm-panel-border)',
        background: 'var(--zterm-panel-bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: '9px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ color: 'var(--zterm-panel-text)', fontSize: '13px', fontWeight: 800 }}>新建 Session</div>
        <AmbientButton
          type="button"
          aria-label="取消新建 session"
          data-amb-flat="true"
          onClick={onCancel}
          style={{
            width: '40px',
            minWidth: '40px',
            height: '40px',
            minHeight: '40px',
            padding: 0,
            borderRadius: '8px',
            border: 'none',
            background: 'transparent',
            color: 'var(--zterm-panel-muted)',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <DrawerCloseIcon size={18} />
        </AmbientButton>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0, flex: '1 1 0', color: 'var(--zterm-panel-muted)', fontSize: '11px', fontWeight: 800 }}>
          名称
          <AmbientInput
            aria-label="新 session 名称"
            value={draft.sessionName}
            onChange={(event) => setDraft((current) => current ? { ...current, sessionName: event.target.value } : current)}
            style={fieldStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0, flex: '1 1 0', color: 'var(--zterm-panel-muted)', fontSize: '11px', fontWeight: 800 }}>
          启动路径
          <AmbientInput
            aria-label="新 session 启动路径"
            value={draft.cwd}
            placeholder="~/"
            onChange={(event) => setDraft((current) => current ? { ...current, cwd: event.target.value } : current)}
            style={fieldStyle}
          />
        </label>
      </div>
      <div
        aria-label="新 session backend"
        style={{
          display: 'flex',
          gap: '2px',
          padding: '2px',
          borderRadius: '8px',
          border: '1px solid var(--zterm-panel-border)',
          background: 'var(--zterm-panel-surface)',
        }}
      >
        {(['tmux', 'herdr'] as const).map((backend) => (
          <AmbientButton
            key={backend}
            type="button"
            data-amb-flat="true"
            aria-pressed={draft.terminalBackend === backend}
            onClick={() => setDraft((current) => current ? { ...current, terminalBackend: backend } : current)}
            style={{
              flex: '1 1 0',
              height: '38px',
              minHeight: '38px',
              borderRadius: '6px',
              border: draft.terminalBackend === backend
                ? '1px solid var(--zterm-panel-accent-border)'
                : '1px solid transparent',
              background: draft.terminalBackend === backend ? 'var(--zterm-panel-active)' : 'transparent',
              color: draft.terminalBackend === backend
                ? 'var(--zterm-panel-active-text)'
                : 'var(--zterm-panel-muted)',
              fontWeight: 800,
              fontSize: '12px',
            }}
          >
            {backend === 'tmux' ? 'tmux' : 'Herdr'}
          </AmbientButton>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <AmbientButton
          type="button"
          data-amb-flat="true"
          onClick={onCancel}
          style={{
            ...compactActionStyle,
            border: '1px solid var(--zterm-panel-border)',
            background: 'transparent',
            color: 'var(--zterm-panel-muted)',
          }}
        >
          取消
        </AmbientButton>
        <AmbientButton
          type="button"
          data-amb-flat="true"
          disabled={!draft.sessionName.trim()}
          onClick={onConfirm}
          style={{
            ...compactActionStyle,
            border: '1px solid var(--zterm-panel-accent-border)',
            background: draft.sessionName.trim()
              ? 'var(--zterm-panel-active)'
              : 'var(--zterm-panel-surface)',
            color: draft.sessionName.trim()
              ? 'var(--zterm-panel-active-text)'
              : 'var(--zterm-panel-muted)',
            fontWeight: 900,
          }}
        >
          创建
        </AmbientButton>
      </div>
    </div>
  );
}
