import { useEffect, useMemo, useState } from 'react';
import { sortBridgeServers, type BridgeServerPreset, type BridgeSettings } from '../../lib/bridge-settings';
import { DEFAULT_BRIDGE_PORT } from '../../lib/mobile-config';
import { mobileTheme } from '../../lib/mobile-ui';
import { formatTargetBadge, isLikelyTailscaleHost } from '../../lib/network-target';
import { type BridgeTarget, createTmuxSession, fetchTmuxSessions, killTmuxSession, renameTmuxSession } from '../../lib/tmux-sessions';

interface TmuxSessionPickerSheetProps {
  mode: 'new-connection' | 'quick-tab' | 'edit-group';
  open: boolean;
  servers: BridgeServerPreset[];
  bridgeSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode'>;
  initialTarget?: Partial<BridgeTarget> | null;
  initialSelectedSessions?: string[];
  onClose: () => void;
  onOpenTmuxSession: (target: BridgeTarget, sessionName: string) => void;
  onOpenMultipleTmuxSessions: (target: BridgeTarget, sessionNames: string[]) => void;
  onSelectCleanSession: (target: BridgeTarget) => void;
  onSaveGroupSelection?: (target: BridgeTarget, sessionNames: string[]) => void;
}

type DiscoveryState = 'idle' | 'loading' | 'done' | 'error';

function normalizeTarget(target?: Partial<BridgeTarget> | null): BridgeTarget {
  return {
    bridgeHost: target?.bridgeHost?.trim() || '',
    bridgePort: target?.bridgePort || DEFAULT_BRIDGE_PORT,
    authToken: target?.authToken?.trim() || '',
    tailscaleHost: target?.tailscaleHost?.trim() || '',
    ipv6Host: target?.ipv6Host?.trim() || '',
    ipv4Host: target?.ipv4Host?.trim() || '',
    signalUrl: target?.signalUrl?.trim() || '',
    transportMode: target?.transportMode || 'auto',
  };
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>{title}</div>
      {subtitle && <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>{subtitle}</div>}
    </div>
  );
}

function formatRefreshAge(ts?: number | null) {
  if (!ts) {
    return '未刷新';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function formatRefreshClock(ts?: number | null) {
  if (!ts) {
    return '--:--:--';
  }
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

export function TmuxSessionPickerSheet({
  mode,
  open,
  servers,
  bridgeSettings,
  initialTarget,
  initialSelectedSessions = [],
  onClose,
  onOpenTmuxSession,
  onOpenMultipleTmuxSessions,
  onSelectCleanSession,
  onSaveGroupSelection,
}: TmuxSessionPickerSheetProps) {
  const [selectedTarget, setSelectedTarget] = useState<BridgeTarget>(() => normalizeTarget(initialTarget));
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [newSessionName, setNewSessionName] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedTarget(normalizeTarget(initialTarget));
    setSelectedSessions(initialSelectedSessions);
    setNewSessionName('');
    setAvailableSessions([]);
    setDiscoveryState('idle');
    setErrorMessage('');
    setLastRefreshedAt(null);
  }, [initialSelectedSessions, initialTarget, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setAvailableSessions([]);
    setSelectedSessions([]);
    setDiscoveryState('idle');
    setErrorMessage('');
    setLastRefreshedAt(null);
  }, [open, selectedTarget.authToken, selectedTarget.bridgeHost, selectedTarget.bridgePort]);

  const sortedServers = useMemo(() => sortBridgeServers(servers), [servers]);
  const selectedCount = selectedSessions.length;
  const statusTone =
    discoveryState === 'done' ? mobileTheme.colors.accent : discoveryState === 'error' ? mobileTheme.colors.danger : '#f2b94b';
  void clockTick;
  const isEditGroupMode = mode === 'edit-group';

  const handleRefreshNow = async () => {
    const bridgeHost = selectedTarget.bridgeHost.trim();
    const authToken = selectedTarget.authToken?.trim() || '';

    if (!bridgeHost) {
      setAvailableSessions([]);
      setSelectedSessions([]);
      setDiscoveryState('idle');
      setErrorMessage('先输入 Tailscale IP / bridge host，再点击 Connect。');
      setLastRefreshedAt(null);
      return;
    }

    if (!authToken) {
      setAvailableSessions([]);
      setSelectedSessions([]);
      setDiscoveryState('idle');
      setErrorMessage('先填写 bridge auth token，再点击 Connect。');
      setLastRefreshedAt(null);
      return;
    }

    setDiscoveryState('loading');
    setErrorMessage('');
    try {
      const sessions = await fetchTmuxSessions(selectedTarget, bridgeSettings);
      setAvailableSessions(sessions);
      setSelectedSessions((current) => current.filter((item) => sessions.includes(item)));
      setDiscoveryState('done');
      setErrorMessage('');
      setLastRefreshedAt(Date.now());
    } catch (error) {
      setAvailableSessions([]);
      setSelectedSessions([]);
      setDiscoveryState('error');
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setLastRefreshedAt(null);
    }
  };

  const handleCreateSession = async () => {
    const sessionName = newSessionName.trim();
    if (!selectedTarget.bridgeHost.trim()) {
      alert('先输入 Tailscale IP 或选择服务器');
      return;
    }
    if (!sessionName) {
      alert('请输入新的 tmux session 名称');
      return;
    }

    setBusyAction(`create:${sessionName}`);
    try {
      await createTmuxSession(selectedTarget, bridgeSettings, sessionName);
      setNewSessionName('');
      await handleRefreshNow();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRenameSession = async (sessionName: string) => {
    const nextSessionName = window.prompt('Rename tmux session', sessionName)?.trim();
    if (!nextSessionName || nextSessionName === sessionName) {
      return;
    }

    setBusyAction(`rename:${sessionName}`);
    try {
      await renameTmuxSession(selectedTarget, bridgeSettings, sessionName, nextSessionName);
      setSelectedSessions((current) => current.map((item) => (item === sessionName ? nextSessionName : item)));
      await handleRefreshNow();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleKillSession = async (sessionName: string) => {
    const confirmed = window.confirm(`Kill tmux session ${sessionName}?`);
    if (!confirmed) {
      return;
    }

    setBusyAction(`kill:${sessionName}`);
    try {
      await killTmuxSession(selectedTarget, bridgeSettings, sessionName);
      setSelectedSessions((current) => current.filter((item) => item !== sessionName));
      await handleRefreshNow();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSession = (sessionName: string) => {
    setSelectedSessions((current) =>
      current.includes(sessionName) ? current.filter((item) => item !== sessionName) : [...current, sessionName],
    );
  };

  if (!open) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        backgroundColor: 'rgba(10, 14, 24, 0.48)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxHeight: '86dvh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          borderTopLeftRadius: '28px',
          borderTopRightRadius: '28px',
          backgroundColor: mobileTheme.colors.lightBg,
          padding: `${mobileTheme.safeArea.top} 16px ${mobileTheme.safeArea.bottom}`,
          boxShadow: mobileTheme.shadow.strong,
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '21px', fontWeight: 800, color: mobileTheme.colors.lightText }}>
              {mode === 'quick-tab' ? 'Quick New Tab' : mode === 'edit-group' ? 'Edit Server Group' : 'New Connection'}
            </div>
            <div style={{ marginTop: '4px', fontSize: '13px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
              {isEditGroupMode
                ? '先显式 Connect/Refresh，再把这个服务器上要记住的 tmux sessions 勾出来。'
                : '先输入/选择 Tailscale IP，再拉 tmux sessions。支持多选勾选后一次打开多个 tab。'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '14px',
              border: 'none',
              backgroundColor: '#ffffff',
              color: mobileTheme.colors.lightText,
              fontSize: '20px',
              boxShadow: mobileTheme.shadow.soft,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            borderRadius: '22px',
            padding: '16px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <SectionTitle title="Target" subtitle="支持手动输入 Tailscale IP/域名；填写完成后显式点击 Connect，才会测试连通并刷新 tmux sessions。" />
          <input
            value={selectedTarget.bridgeHost}
            onChange={(event) => setSelectedTarget((current) => ({ ...current, bridgeHost: event.target.value }))}
            placeholder="100.127.23.27 或 your-device.ts.net"
            style={{
              minHeight: '48px',
              borderRadius: '16px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              padding: '0 14px',
              fontSize: '15px',
            }}
          />
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="number"
              value={selectedTarget.bridgePort}
              onChange={(event) =>
                setSelectedTarget((current) => ({
                  ...current,
                  bridgePort: Number.parseInt(event.target.value, 10) || DEFAULT_BRIDGE_PORT,
                }))
              }
              style={{
                width: '136px',
                minHeight: '48px',
                borderRadius: '16px',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                padding: '0 14px',
                fontSize: '15px',
              }}
            />
            <input
              value={selectedTarget.authToken || ''}
              onChange={(event) => setSelectedTarget((current) => ({ ...current, authToken: event.target.value }))}
              placeholder="Bridge auth token"
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: '48px',
                borderRadius: '16px',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                padding: '0 14px',
                fontSize: '15px',
              }}
            />
          </div>

          <div
            style={{
              borderRadius: '16px',
              padding: '12px 14px',
              backgroundColor: '#f6f8fb',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: mobileTheme.colors.lightText, fontWeight: 700 }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '999px',
                    backgroundColor: statusTone,
                    flexShrink: 0,
                  }}
                />
                {discoveryState === 'idle' && '等待输入目标'}
                {discoveryState === 'loading' && '正在测试 bridge 连通并刷新 tmux...'}
                {discoveryState === 'done' && 'Bridge 已连通，tmux 列表已刷新'}
                {discoveryState === 'error' && 'Bridge 连接失败 / 刷新失败'}
              </div>
              <div style={{ fontSize: '11px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
                {selectedTarget.bridgeHost ? `Current target: ${formatTargetBadge(selectedTarget.bridgeHost)} · ${selectedTarget.bridgeHost}:${selectedTarget.bridgePort}` : 'Current target: 未填写'}
                {selectedTarget.authToken ? ' · Auth on' : ' · No auth'}
              </div>
              <div style={{ fontSize: '11px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>
                {discoveryState === 'done' && `Last refreshed ${formatRefreshAge(lastRefreshedAt)} (${formatRefreshClock(lastRefreshedAt)})`}
                {discoveryState === 'idle' && errorMessage}
                {discoveryState === 'error' && errorMessage}
                {discoveryState === 'loading' && '连接完成前，不要把下面的 tmux 视为最新。'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => void handleRefreshNow()}
                style={{
                  minWidth: '84px',
                  height: '38px',
                  border: 'none',
                  borderRadius: '12px',
                  backgroundColor: mobileTheme.colors.shell,
                  color: '#ffffff',
                  fontWeight: 800,
                  boxShadow: mobileTheme.shadow.soft,
                }}
              >
                {discoveryState === 'done' ? 'Reconnect' : 'Connect'}
              </button>
              {discoveryState === 'done' && (
                <button
                  onClick={() => void handleRefreshNow()}
                  style={{
                    minWidth: '72px',
                    height: '38px',
                    border: 'none',
                    borderRadius: '12px',
                    backgroundColor: '#ffffff',
                    color: mobileTheme.colors.lightText,
                    fontWeight: 700,
                    boxShadow: mobileTheme.shadow.soft,
                  }}
                >
                  Refresh
                </button>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {sortedServers.map((server) => {
              const active = server.targetHost === selectedTarget.bridgeHost && server.targetPort === selectedTarget.bridgePort;
              return (
                <button
                  key={server.id}
                  onClick={() =>
                    setSelectedTarget({
                      bridgeHost: server.targetHost,
                      bridgePort: server.targetPort,
                      authToken: server.authToken || '',
                    })
                  }
                  style={{
                    border: 'none',
                    borderRadius: '16px',
                    padding: '10px 12px',
                    backgroundColor: active ? mobileTheme.colors.shell : '#ffffff',
                    color: active ? '#ffffff' : mobileTheme.colors.lightText,
                    boxShadow: mobileTheme.shadow.soft,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontWeight: 800 }}>{server.name}</div>
                  <div style={{ fontSize: '11px', opacity: 0.78 }}>{server.targetHost}:{server.targetPort}</div>
                  <div style={{ fontSize: '10px', opacity: 0.72 }}>{formatTargetBadge(server.targetHost)} · {server.authToken ? 'Auth' : 'No auth'}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            borderRadius: '22px',
            padding: '16px',
            backgroundColor: '#ffffff',
            boxShadow: mobileTheme.shadow.soft,
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <SectionTitle title="Tmux Sessions" subtitle="有明确勾选框；先点 Connect，再勾选并批量打开。这里不再自动刷新。" />

          <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted }}>
            {!selectedTarget.bridgeHost && '先输入 Tailscale IP 或选择一个服务器'}
            {selectedTarget.bridgeHost && discoveryState === 'loading' && '正在拉取 tmux session...'}
            {selectedTarget.bridgeHost && discoveryState === 'error' && errorMessage}
            {selectedTarget.bridgeHost && discoveryState === 'done' && availableSessions.length === 0 && '当前服务器还没有 tmux session'}
          </div>

          {availableSessions.map((sessionName) => {
            const selected = selectedSessions.includes(sessionName);
            return (
              <div
                key={sessionName}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <button
                  onClick={() => toggleSession(sessionName)}
                  aria-label={`Select ${sessionName}`}
                  style={{
                    width: '38px',
                    height: '38px',
                    borderRadius: '12px',
                    border: selected ? `2px solid ${mobileTheme.colors.accent}` : `1px solid ${mobileTheme.colors.lightBorder}`,
                    backgroundColor: selected ? mobileTheme.colors.accentSoft : '#ffffff',
                    color: selected ? mobileTheme.colors.accent : mobileTheme.colors.lightMuted,
                    fontWeight: 900,
                    flexShrink: 0,
                  }}
                >
                  {selected ? '✓' : ''}
                </button>
                <button
                  onClick={() => toggleSession(sessionName)}
                  style={{
                    flex: 1,
                    border: 'none',
                    borderRadius: '18px',
                    padding: '12px 14px',
                    backgroundColor: selected ? 'rgba(31,214,122,0.14)' : '#f6f8fb',
                    color: mobileTheme.colors.lightText,
                    textAlign: 'left',
                    fontWeight: 800,
                  }}
                >
                  <div>{sessionName}</div>
                </button>
                <button
                  onClick={() => onOpenTmuxSession(selectedTarget, sessionName)}
                  style={{
                    minWidth: '56px',
                    height: '44px',
                    border: 'none',
                    borderRadius: '14px',
                    backgroundColor: mobileTheme.colors.accentSoft,
                    color: mobileTheme.colors.accent,
                    fontWeight: 800,
                  }}
                >
                  Open
                </button>
                <button
                  onClick={() => handleRenameSession(sessionName)}
                  disabled={busyAction !== null}
                  style={{
                    width: '44px',
                    height: '44px',
                    border: 'none',
                    borderRadius: '14px',
                    backgroundColor: mobileTheme.colors.shellMuted,
                    color: '#ffffff',
                  }}
                >
                  ✎
                </button>
                <button
                  onClick={() => handleKillSession(sessionName)}
                  disabled={busyAction !== null}
                  style={{
                    width: '44px',
                    height: '44px',
                    border: 'none',
                    borderRadius: '14px',
                    backgroundColor: 'rgba(255,124,146,0.16)',
                    color: mobileTheme.colors.danger,
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}

          {(selectedCount > 0 || isEditGroupMode) && (
            <button
              onClick={() => {
                if (isEditGroupMode) {
                  onSaveGroupSelection?.(selectedTarget, selectedSessions);
                  return;
                }
                onOpenMultipleTmuxSessions(selectedTarget, selectedSessions);
              }}
              style={{
                minHeight: '48px',
                border: 'none',
                borderRadius: '16px',
                backgroundColor: mobileTheme.colors.shell,
                color: '#ffffff',
                fontWeight: 800,
              }}
            >
              {isEditGroupMode
                ? selectedCount > 0
                  ? `Save ${selectedCount} selected sessions`
                  : 'Clear remembered group'
                : `Open ${selectedCount} selected sessions as tabs`}
            </button>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              value={newSessionName}
              onChange={(event) => setNewSessionName(event.target.value)}
              placeholder="new-session"
              style={{
                flex: 1,
                minWidth: 0,
                borderRadius: '16px',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                padding: '12px 14px',
                fontSize: '14px',
              }}
            />
            <button
              onClick={handleCreateSession}
              disabled={busyAction !== null}
              style={{
                minWidth: '88px',
                border: 'none',
                borderRadius: '16px',
                backgroundColor: mobileTheme.colors.shell,
                color: '#ffffff',
                fontWeight: 800,
              }}
            >
              Create
            </button>
          </div>
        </div>

        {mode !== 'new-connection' && (
          <div
            style={{
              borderRadius: '22px',
              padding: '16px',
              backgroundColor: '#ffffff',
              boxShadow: mobileTheme.shadow.soft,
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <SectionTitle title="Clean Session" subtitle="不选历史和现有 tmux session，就走干净的新连接/新 tab。" />
            <button
              onClick={() => onSelectCleanSession(selectedTarget)}
              style={{
                border: 'none',
                borderRadius: '18px',
                padding: '14px',
                backgroundColor: mobileTheme.colors.accentSoft,
                color: mobileTheme.colors.lightText,
                fontWeight: 800,
                textAlign: 'left',
              }}
            >
              {mode === 'quick-tab' ? 'Create blank tab target' : isEditGroupMode ? 'Use full connection form' : 'Open full connection form'}
            </button>
            {isLikelyTailscaleHost(selectedTarget.bridgeHost) && (
              <div style={{ fontSize: '11px', color: mobileTheme.colors.lightMuted }}>
                当前目标是 Tailscale，会优先记忆这个 IP。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
