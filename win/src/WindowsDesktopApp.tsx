import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { MacTerminalView } from '@zterm/shared';
import { createWindowsTerminalSession, projectWindowsTerminalBuffer, type WindowsTerminalTarget } from './windows-terminal-session';

const STORAGE_KEY = 'zterm:windows:target.v1';
const DEFAULT_TARGET: WindowsTerminalTarget = { bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'zterm' };

function readTarget() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '') as Partial<WindowsTerminalTarget>;
    if (!parsed.bridgeHost || !parsed.sessionName || !Number.isFinite(parsed.bridgePort)) return DEFAULT_TARGET;
    return { ...DEFAULT_TARGET, ...parsed };
  } catch {
    return DEFAULT_TARGET;
  }
}

export function WindowsDesktopApp() {
  const terminal = useMemo(() => createWindowsTerminalSession(), []);
  const snapshot = useSyncExternalStore(terminal.subscribe, terminal.getSnapshot, terminal.getSnapshot);
  const [target, setTarget] = useState<WindowsTerminalTarget>(readTarget);
  const [settingsOpen, setSettingsOpen] = useState(true);
  useEffect(() => () => terminal.dispose(), [terminal]);
  const projection = projectWindowsTerminalBuffer(snapshot.buffer);
  const connect = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
    terminal.connect(target);
    setSettingsOpen(false);
  };

  return (
    <main className="windows-shell" data-platform={window.ztermWindows?.platform || 'browser'}>
      <header className="titlebar">
        <div className="brand">ZTerm</div>
        <div className={`connection-state connection-state--${snapshot.status}`}>
          <span className="state-dot" />
          {snapshot.status === 'connected' ? target.sessionName : snapshot.status}
        </div>
        <button className="icon-button" title="连接设置" aria-label="连接设置" onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
      </header>
      <section className="terminal-stage">
        {snapshot.error ? <div className="error-banner">{snapshot.error}</div> : null}
        <MacTerminalView
          sessionId={snapshot.sessionId}
          projection={projection}
          active={snapshot.status === 'connected'}
          allowDomFocus
          onInput={terminal.sendInput}
          onViewportChange={(value) => terminal.requestVisibleRange(value as { startIndex?: number; endIndex?: number })}
        />
        {snapshot.status === 'idle' && !settingsOpen ? <button className="connect-empty" onClick={() => setSettingsOpen(true)}>连接终端</button> : null}
      </section>
      {settingsOpen ? (
        <aside className="connection-panel" aria-label="连接设置">
          <div className="panel-title">连接</div>
          <label>主机<input value={target.bridgeHost} onChange={(event) => setTarget({ ...target, bridgeHost: event.target.value })} /></label>
          <label>端口<input type="number" value={target.bridgePort} onChange={(event) => setTarget({ ...target, bridgePort: Number(event.target.value) })} /></label>
          <label>Session<input value={target.sessionName} onChange={(event) => setTarget({ ...target, sessionName: event.target.value })} /></label>
          <label>Token<input type="password" value={target.authToken || ''} onChange={(event) => setTarget({ ...target, authToken: event.target.value || undefined })} /></label>
          <div className="panel-actions">
            {snapshot.status !== 'idle' ? <button className="secondary" onClick={terminal.disconnect}>断开</button> : null}
            <button className="primary" disabled={!target.bridgeHost.trim() || !target.sessionName.trim() || target.bridgePort < 1} onClick={connect}>连接</button>
          </div>
        </aside>
      ) : null}
    </main>
  );
}
