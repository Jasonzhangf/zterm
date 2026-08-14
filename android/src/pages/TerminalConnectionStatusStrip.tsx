/**
 * TerminalConnectionStatusStrip 子组件（client.app_shell，从 TerminalPage.tsx 拆出）。
 * 只消费 Session 投影与回调；不持有 session 生命周期 / 传输真相。
 */
import { memo as ReactMemo, useEffect, useState } from 'react';
import { RenameDialog } from '../components/terminal/RenameDialog';
import { formatDebugRate } from './terminal-page-debug-helpers';
import type { Session, SessionDebugOverlayMetrics } from '../lib/types';
import {
  formatConnectionRouteLabel,
  resolveConnectionActivityLabel,
  resolveEffectiveConnectionStatus,
} from './terminal-page-status-helpers';

const connectionRouteOptionStyle = {
  minHeight: '34px',
  borderRadius: '10px',
  border: '1px solid var(--zterm-panel-border)',
  background: 'var(--zterm-panel-surface)',
  color: 'var(--zterm-panel-text)',
  fontSize: '12px',
  fontWeight: 850,
  textAlign: 'left',
  padding: '0 10px',
} as const;

const TerminalConnectionStatusStrip = ReactMemo(function TerminalConnectionStatusStrip({
  session,
  getSessionDebugMetrics,
  topInsetPx,
  onForceRelaySession,
  onUseAutoSession,
  onUseWebSocketSession,
  onRenameRemoteSession,
}: {
  session: Session | null;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  topInsetPx: number;
  onForceRelaySession?: (id: string) => void;
  onUseAutoSession?: (id: string) => void;
  onUseWebSocketSession?: (id: string) => void;
  onRenameRemoteSession?: (sessionId: string, nextSessionName: string) => void | Promise<void>;
}) {
  const [tick, setTick] = useState(0);
  const [routeMenuOpen, setRouteMenuOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);

  useEffect(() => {
    if (!session) {
      return;
    }
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 500);
    return () => window.clearInterval(timer);
  }, [session]);

  void tick;

  if (!session) {
    return null;
  }

  const metrics = getSessionDebugMetrics ? getSessionDebugMetrics(session.id) : null;
  const uplinkBps = metrics?.uplinkBps || 0;
  const downlinkBps = metrics?.downlinkBps || 0;
  const routeLabel = formatConnectionRouteLabel(session);
  const status = resolveEffectiveConnectionStatus(session, metrics);
  const activityLabel = resolveConnectionActivityLabel(session, status);
  const statusTone = status === 'error' || status === 'closed'
    ? '#ff8a8a'
    : activityLabel
      ? '#ffd27a'
      : 'var(--zterm-panel-muted)';
  const visibleRouteLabel = activityLabel || routeLabel;

  return (
    <>
      <div
      data-testid='terminal-connection-status-strip'
      className='zterm-connection-status-strip'
      aria-label={`连接状态 ${visibleRouteLabel} session ${session.sessionName} 上行 ${formatDebugRate(uplinkBps)} 下行 ${formatDebugRate(downlinkBps)}`}
      role='button'
      tabIndex={0}
      onClick={() => setRouteMenuOpen((current) => !current)}
      style={{
        position: 'absolute',
        top: `${Math.max(8, topInsetPx + 8)}px`,
        left: '94px',
        right: '84px',
        zIndex: 15,
        height: '34px',
        minWidth: 0,
        borderRadius: '12px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--zterm-panel-text)',
        boxShadow: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: '0 9px',
        overflow: 'visible',
        pointerEvents: 'auto',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      <span
        data-testid='terminal-connection-status-route'
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          minWidth: 0,
          flex: '0 1 auto',
          color: statusTone,
          fontSize: '11px',
          fontWeight: 900,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '999px',
            background: statusTone,
            boxShadow: 'none',
            flex: '0 0 auto',
          }}
        />
        <span
          data-testid={activityLabel ? 'terminal-connection-status-activity' : undefined}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {visibleRouteLabel}
        </span>
      </span>
      <button
        type="button"
        data-testid='terminal-connection-status-session'
        aria-label={`重命名 session ${session.sessionName}`}
        onClick={(event) => {
          event.stopPropagation();
          setRouteMenuOpen(false);
          if (!onRenameRemoteSession) {
            return;
          }
          setRenameDialogOpen(true);
        }}
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          padding: 0,
          border: 0,
          background: 'transparent',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: 'var(--zterm-panel-text)',
          fontSize: '11px',
          fontWeight: 800,
          textAlign: 'left',
          whiteSpace: 'nowrap',
          cursor: onRenameRemoteSession ? 'text' : 'default',
        }}
      >
        {session.sessionName}
      </button>
      <span
        data-testid='terminal-connection-status-rates'
        style={{
          flex: '0 0 auto',
          display: 'grid',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
          alignItems: 'center',
          color: 'var(--zterm-panel-muted)',
          fontSize: '9px',
          fontWeight: 750,
          lineHeight: 1.05,
        }}
      >
        <span data-testid='terminal-connection-status-uplink'>↑ {formatDebugRate(uplinkBps)}</span>
        <span data-testid='terminal-connection-status-downlink'>↓ {formatDebugRate(downlinkBps)}</span>
      </span>
      {routeMenuOpen ? (
        <div
          data-testid='terminal-connection-route-menu'
          className='zterm-connection-route-menu'
          style={{
            position: 'absolute',
            left: 0,
            top: '40px',
            width: '210px',
            zIndex: 30,
            display: 'grid',
            gap: '6px',
            padding: '8px',
            borderRadius: '12px',
            border: '1px solid var(--zterm-panel-border)',
            background: 'var(--zterm-panel-bg)',
            boxShadow: '0 18px 42px var(--zterm-panel-shadow)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            data-testid='terminal-route-option-auto'
            onClick={() => {
              setRouteMenuOpen(false);
              onUseAutoSession?.(session.id);
            }}
            style={connectionRouteOptionStyle}
          >
            自动选择
          </button>
          <button
            type="button"
            data-testid='terminal-route-option-websocket'
            onClick={() => {
              setRouteMenuOpen(false);
              onUseWebSocketSession?.(session.id);
            }}
            style={connectionRouteOptionStyle}
          >
            直连 / Tailscale
          </button>
          <button
            type="button"
            data-testid='terminal-route-option-webrtc'
            onClick={() => {
              setRouteMenuOpen(false);
              onForceRelaySession?.(session.id);
            }}
            style={connectionRouteOptionStyle}
          >
            WebRTC / Relay
          </button>
        </div>
      ) : null}
      </div>
      <RenameDialog
        open={renameDialogOpen}
        title="重命名 tmux session"
        inputLabel="新的 tmux session 名称"
        initialValue={session.sessionName}
        onCancel={() => setRenameDialogOpen(false)}
        onSubmit={(nextSessionName) => {
          setRenameDialogOpen(false);
          if (!onRenameRemoteSession) {
            return;
          }
          void Promise.resolve(onRenameRemoteSession(session.id, nextSessionName)).catch((error) => {
            window.alert?.(error instanceof Error ? error.message : String(error));
          });
        }}
      />
    </>
  );
});

export { TerminalConnectionStatusStrip };
