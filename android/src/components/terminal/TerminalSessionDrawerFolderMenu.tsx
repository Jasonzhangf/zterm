interface Props { cwd: string; x: number; y: number; onPreview: (cwd: string) => void; onClose: () => void; }

export function TerminalSessionDrawerFolderMenu({ cwd, x, y, onPreview, onClose }: Props) {
  return <>
    <button
      type="button"
      data-testid="terminal-session-drawer-folder-menu-scrim"
      aria-label="关闭文件夹菜单"
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
    <div role="menu" data-testid="terminal-session-drawer-folder-menu" style={{ position: 'fixed', left: x, top: y, zIndex: 170, display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px', borderRadius: '10px', border: '1px solid var(--zterm-panel-border)', background: 'var(--zterm-panel-bg)', boxShadow: '0 12px 30px rgba(0,0,0,.35)' }}>
      <button type="button" role="menuitem" onClick={() => { onPreview(cwd); onClose(); }} style={{ minHeight: '34px', padding: '0 10px', border: 0, borderRadius: '7px', background: 'var(--zterm-panel-active)', color: 'var(--zterm-panel-text)', fontWeight: 800 }}>预览</button>
      <button type="button" role="menuitem" onClick={onClose} style={{ minHeight: '30px', padding: '0 10px', border: 0, borderRadius: '7px', background: 'transparent', color: 'var(--zterm-panel-muted)' }}>取消</button>
    </div>
  </>;
}
