import { TerminalView, formatBridgeSessionTarget, type Host } from '@zterm/shared';
import type { BridgeTerminalState } from '../lib/use-bridge-terminal';

interface TerminalSlotProps {
  host?: Host;
  session: BridgeTerminalState;
  isDetailsVisible: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onDisconnect: () => void;
}

export function TerminalSlot({ host, session, isDetailsVisible, onInput, onResize, onDisconnect }: TerminalSlotProps) {
  const activeTarget = session.activeTarget;
  const hasLiveTerminal = Boolean(activeTarget);
  const targetLabel = activeTarget
    ? formatBridgeSessionTarget(activeTarget)
    : host
      ? formatBridgeSessionTarget(host)
      : 'Select a connection';
  const liveSessionId = activeTarget ? session.connectedSessionId || activeTarget.sessionName : null;

  return (
    <div className="slot-stack terminal-slot-shell">
      <div className="terminal-meta-bar">
        <div className="terminal-meta-copy">
          <span className={`terminal-status-pill ${session.status}`}>{session.status.toUpperCase()}</span>
          <span className="terminal-target-label">{targetLabel}</span>
          <span>
            {activeTarget
              ? activeTarget.name || activeTarget.sessionName
              : host
                ? host.name
                : 'No target'}
          </span>
          <span>{`sessionId: ${session.connectedSessionId || '-'}`}</span>
          <span>{`buffer lines: ${session.buffer.lines.length}`}</span>
          {isDetailsVisible ? <span>Inspector drawer open</span> : null}
        </div>
        {hasLiveTerminal ? (
          <button className="ghost-button" type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : null}
      </div>

      <div className="terminal-surface-shell">
        {hasLiveTerminal ? (
          <>
            {session.error ? <div className="terminal-error-banner">{session.error}</div> : null}
            <div className="terminal-surface live">
              <TerminalView
                sessionId={liveSessionId}
                initialBufferLines={session.buffer.lines}
                scrollbackStartIndex={session.buffer.scrollbackStartIndex}
                bufferRevision={session.buffer.revision}
                snapshot={session.buffer.remoteSnapshot}
                active
                onInput={onInput}
                onResize={onResize}
              />
            </div>
          </>
        ) : (
          <div className="terminal-empty-state">
            <div className="terminal-empty-title">Terminal render 已接入</div>
            <div className="terminal-empty-copy">
              现在这里会消费 bridge snapshot / viewport-update / scrollback-update。先从左侧选择连接，再在 Details 里点 Connect。
            </div>
            {host ? (
              <div className="terminal-empty-hint">当前选中：{formatBridgeSessionTarget(host)}</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
