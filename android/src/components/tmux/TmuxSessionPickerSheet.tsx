import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { buildConnectionConfigShareLink } from '@zterm/shared';
import {
  type BridgeServerPreset,
  type BridgeSettings,
} from '../../lib/bridge-settings';
import { buildBridgeServerPresetViews } from '../../lib/bridge-server-presets-view';
import { RelayDevicePicker } from '../connection-form/RelayDevicePicker';
import { useTraversalRelayDaemonDevices } from '../../hooks/useTraversalRelayDaemonDevices';
import { DEFAULT_BRIDGE_PORT } from '../../lib/mobile-config';
import { mobileTheme } from '../../lib/mobile-ui';
import { RenameDialog } from '../terminal/RenameDialog';
import { formatTargetBadge, isLikelyTailscaleHost } from '../../lib/network-target';
import { normalizeBridgeTarget, resolveRelayDeviceBridgeTarget } from '../../lib/session-picker';
import { normalizeRemoteTmuxSessionNames } from '../../lib/tmux-session-list';
import { type BridgeTarget, createTmuxSession, fetchTmuxSessions, killTmuxSession, renameTmuxSession } from '../../lib/tmux-sessions';
import type { ConfigShareQuickAction, ConfigShareShortcutAction, Host } from '../../lib/types';
import {
  formatRefreshAge,
  formatRefreshClock,
  getTargetRelayHostId,
  hasRelayRtcEndpointCandidate,
  decodeQrImageFile,
} from './tmux-session-picker-helpers';
import {
  buildTmuxSessionPickerRows,
  findOpenTabsMissingFromRemote,
  filterActionableTmuxSelections,
  shouldAutoRefreshTmuxPicker,
} from './tmux-session-picker-rows';

interface TmuxSessionPickerSheetProps {
  mode: 'new-connection' | 'quick-tab' | 'edit-group';
  open: boolean;
  servers: BridgeServerPreset[];
  bridgeSettings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>;
  openTabs?: Array<{
    id: string;
    sessionName: string;
    customName?: string;
    bridgeHost: string;
    bridgePort: number;
    daemonHostId?: string;
  }>;
  activeTabId?: string | null;
  initialTarget?: Partial<BridgeTarget> | null;
  initialSelectedSessions?: string[];
  shareableHosts?: Host[];
  quickActions?: ConfigShareQuickAction[];
  shortcutActions?: ConfigShareShortcutAction[];
  onClose: () => void;
  onSwitchOpenTab?: (sessionId: string) => void;
  onRenameOpenTab?: (sessionId: string, nextName: string) => void;
  onCloseOpenTab?: (sessionId: string, source?: string) => void;
  onOpenTmuxSession: (target: BridgeTarget, sessionName: string) => void;
  onOpenMultipleTmuxSessions: (target: BridgeTarget, sessionNames: string[]) => void;
  onSelectCleanSession: (target: BridgeTarget) => void;
  onImportConnectionLink?: (input: string) => { ok: true; name: string } | { ok: false; error: string };
  onSaveGroupSelection?: (target: BridgeTarget, sessionNames: string[]) => void;
  onRemoteSessionsRefreshed?: (target: BridgeTarget, sessionNames: string[]) => void;
}

type DiscoveryState = 'idle' | 'loading' | 'done' | 'error';
type ShareScope = 'all' | 'single';

const EMPTY_SELECTED_SESSIONS: string[] = [];
const EMPTY_SHAREABLE_HOSTS: Host[] = [];
const EMPTY_QUICK_ACTIONS: ConfigShareQuickAction[] = [];
const EMPTY_SHORTCUT_ACTIONS: ConfigShareShortcutAction[] = [];

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ fontSize: '15px', fontWeight: 800, color: mobileTheme.colors.lightText }}>{title}</div>
      {subtitle && <div style={{ fontSize: '12px', color: mobileTheme.colors.lightMuted, lineHeight: 1.5 }}>{subtitle}</div>}
    </div>
  );
}

export function TmuxSessionPickerSheet({
  mode,
  open,
  servers,
  bridgeSettings,
  openTabs = [],
  activeTabId = null,
  initialTarget,
  initialSelectedSessions = EMPTY_SELECTED_SESSIONS,
  shareableHosts = EMPTY_SHAREABLE_HOSTS,
  quickActions = EMPTY_QUICK_ACTIONS,
  shortcutActions = EMPTY_SHORTCUT_ACTIONS,
  onClose,
  onSwitchOpenTab,
  onRenameOpenTab,
  onCloseOpenTab,
  onOpenTmuxSession,
  onOpenMultipleTmuxSessions,
  onSelectCleanSession,
  onImportConnectionLink,
  onSaveGroupSelection,
  onRemoteSessionsRefreshed,
}: TmuxSessionPickerSheetProps) {
  const [selectedTarget, setSelectedTarget] = useState<BridgeTarget>(() => normalizeBridgeTarget(initialTarget));
  const [availableSessions, setAvailableSessions] = useState<string[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionBackend, setNewSessionBackend] = useState<'tmux' | 'herdr'>(
    initialTarget?.terminalBackend === 'herdr' ? 'herdr' : 'tmux',
  );
  const [backendChoiceOpen, setBackendChoiceOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    kind: 'remote';
    sessionName: string;
  } | {
    kind: 'openTab';
    sessionId: string;
    currentName: string;
  } | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [connectionImportInput, setConnectionImportInput] = useState('');
  const [connectionImportStatus, setConnectionImportStatus] = useState('');
  const [shareScope, setShareScope] = useState<ShareScope>('all');
  const [selectedShareHostId, setSelectedShareHostId] = useState('');
  const [shareQrSvg, setShareQrSvg] = useState('');
  const [shareCopyStatus, setShareCopyStatus] = useState('');
  const qrScanInputRef = useRef<HTMLInputElement | null>(null);
  const { devices: relayDevices, refresh: refreshRelayDevices } = useTraversalRelayDaemonDevices(
    Boolean(bridgeSettings.traversalRelay?.accessToken) && open,
  );
  const shareableHostIds = useMemo(
    () => shareableHosts.map((host) => host.id).join('\u0000'),
    [shareableHosts],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedTarget(normalizeBridgeTarget(initialTarget));
    setSelectedSessions(initialSelectedSessions);
    setNewSessionName('');
    setNewSessionBackend(initialTarget?.terminalBackend === 'herdr' ? 'herdr' : 'tmux');
    setBackendChoiceOpen(false);
    setRenameTarget(null);
    setAvailableSessions([]);
    setDiscoveryState('idle');
    setErrorMessage('');
    setLastRefreshedAt(null);
    setConnectionImportInput('');
    setConnectionImportStatus('');
    setShareScope('all');
    setSelectedShareHostId(shareableHosts[0]?.id || '');
    setShareQrSvg('');
    setShareCopyStatus('');
    refreshRelayDevices();
  }, [initialSelectedSessions, initialTarget, open, refreshRelayDevices, shareableHostIds]);

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

  const serverViews = useMemo(() => buildBridgeServerPresetViews(servers), [servers]);
  const sortedServers = useMemo(() => serverViews.map((entry) => entry.server), [serverViews]);
  const statusTone =
    discoveryState === 'done' ? mobileTheme.colors.accent : discoveryState === 'error' ? mobileTheme.colors.danger : '#f2b94b';
  void clockTick;
  const isEditGroupMode = mode === 'edit-group';
  const relayEnabled = Boolean(bridgeSettings.traversalRelay?.accessToken);
  const relayDevicesAvailable = relayEnabled && relayDevices.length > 0;
  const selectedTargetRelayHostId = getTargetRelayHostId(selectedTarget);
  const selectedTargetCanUseRelayTransport = relayEnabled
    && Boolean(selectedTargetRelayHostId)
    && hasRelayRtcEndpointCandidate(selectedTarget);
  const selectedTargetIsRelayDirectoryTarget = relayEnabled
    && Boolean(selectedTargetRelayHostId)
    && (
      selectedTargetCanUseRelayTransport
      || (selectedTarget.relayTmuxSessions || []).length > 0
      || Boolean(selectedTarget.relayDeviceId?.trim())
    );
  const targetInputLocked = selectedTargetCanUseRelayTransport && !selectedTarget.bridgeHost.trim();
  const showOpenTabState = true;
  const unifiedSessionRows = useMemo(() => buildTmuxSessionPickerRows({
    availableSessions,
    openTabs,
    target: selectedTarget,
    includeOpenTabs: showOpenTabState,
  }), [
    availableSessions,
    openTabs,
    selectedTarget.bridgeHost,
    selectedTarget.bridgePort,
    selectedTarget.daemonHostId,
    selectedTarget.relayHostId,
    showOpenTabState,
  ]);
  const actionableSelectedSessions = useMemo(() => (
    filterActionableTmuxSelections(selectedSessions, unifiedSessionRows, showOpenTabState)
  ), [selectedSessions, showOpenTabState, unifiedSessionRows]);
  const selectedCount = actionableSelectedSessions.length;
  const selectedShareHost = useMemo(
    () => shareableHosts.find((host) => host.id === selectedShareHostId),
    [selectedShareHostId, shareableHosts],
  );
  const shareExportedAt = useMemo(
    () => Math.max(...shareableHosts.map((host) => host.lastConnected || host.createdAt || 0), 0),
    [shareableHosts],
  );
  const selectedShareLink = useMemo(
    () => {
      if (shareableHosts.length === 0) {
        return '';
      }
      if (shareScope === 'single') {
        return selectedShareHost
          ? buildConnectionConfigShareLink({
              host: selectedShareHost,
              exportedAt: selectedShareHost.lastConnected || selectedShareHost.createdAt || shareExportedAt,
            })
          : '';
      }
      return buildConnectionConfigShareLink({
        hosts: shareableHosts,
        quickActions,
        shortcutActions,
        exportedAt: shareExportedAt,
      });
    },
    [quickActions, selectedShareHost, shareExportedAt, shareScope, shareableHosts, shortcutActions],
  );
  const shareTitle = shareScope === 'single' && selectedShareHost
    ? `分享单个连接：${selectedShareHost.name}`
    : `分享全部连接：${shareableHosts.length} 个`;
  const shareSubtitle = shareScope === 'single'
    ? '另一台机器导入后只会新增或更新这个连接。'
    : '另一台机器导入后会同步本机全部已保存连接和快捷指令配置。';

  useEffect(() => {
    if (mode !== 'new-connection') {
      return;
    }
    if (shareableHosts.length === 0) {
      if (selectedShareHostId) {
        setSelectedShareHostId('');
      }
      return;
    }
    if (!selectedShareHostId || !shareableHosts.some((host) => host.id === selectedShareHostId)) {
      setSelectedShareHostId(shareableHosts[0]!.id);
    }
  }, [mode, selectedShareHostId, shareableHostIds, shareableHosts]);

  useEffect(() => {
    let cancelled = false;
    setShareQrSvg('');
    setShareCopyStatus('');
    if (!selectedShareLink) {
      return () => {
        cancelled = true;
      };
    }
    QRCode.toString(selectedShareLink, {
      type: 'svg',
      margin: 1,
      width: 192,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#101218',
        light: '#ffffff',
      },
    })
      .then((svg) => {
        if (!cancelled) {
          setShareQrSvg(svg);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setShareCopyStatus(`二维码生成失败：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedShareLink]);

  const handleImportConnectionLink = (input: string) => {
    if (!onImportConnectionLink) {
      setConnectionImportStatus('当前版本未启用连接导入入口。');
      return;
    }
    const result = onImportConnectionLink(input);
    if (!result.ok) {
      setConnectionImportStatus(`导入失败：${result.error}`);
      return;
    }
    setConnectionImportInput('');
    setConnectionImportStatus(`已导入：${result.name}`);
  };

  const handleCopyShareLink = async () => {
    if (!selectedShareLink) {
      return;
    }
    if (!navigator.clipboard?.writeText) {
      setShareCopyStatus('系统剪贴板不可用，无法复制分享链接。');
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedShareLink);
      setShareCopyStatus('分享链接已复制');
    } catch (error) {
      setShareCopyStatus(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleScanQrFile = async (file?: File | null) => {
    if (!file) {
      return;
    }
    try {
      setConnectionImportStatus('正在识别二维码...');
      const decoded = await decodeQrImageFile(file);
      setConnectionImportInput(decoded);
      handleImportConnectionLink(decoded);
    } catch (error) {
      setConnectionImportStatus(`扫码失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (qrScanInputRef.current) {
        qrScanInputRef.current.value = '';
      }
    }
  };

  const handleRefreshNow = async () => {
    const discoveryTarget = { ...selectedTarget, terminalBackend: undefined };
    const bridgeHost = discoveryTarget.bridgeHost.trim();
    const authToken = discoveryTarget.authToken?.trim() || '';
    const relayHostId = getTargetRelayHostId(discoveryTarget);
    const canUseRelayTransport = relayEnabled && Boolean(relayHostId) && hasRelayRtcEndpointCandidate(selectedTarget);
    if (!bridgeHost && !canUseRelayTransport) {
      setAvailableSessions([]);
      setSelectedSessions([]);
      setDiscoveryState('idle');
      setErrorMessage(relayEnabled ? '先输入 Tailscale IP / bridge host，或选择带 relay-rtc 的在线 daemon。' : '先输入 Tailscale IP / bridge host，再点击 Connect。');
      setLastRefreshedAt(null);
      return;
    }

    if (!authToken && !canUseRelayTransport) {
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
      const sessions = normalizeRemoteTmuxSessionNames(await fetchTmuxSessions(discoveryTarget, bridgeSettings));
      const missingOpenTabs = findOpenTabsMissingFromRemote({
        availableSessions: sessions,
        openTabs,
        target: discoveryTarget,
      });
      setAvailableSessions(sessions);
      setSelectedSessions((current) => {
        const nextRows = buildTmuxSessionPickerRows({
          availableSessions: sessions,
          openTabs,
          target: discoveryTarget,
          includeOpenTabs: showOpenTabState,
        });
        return filterActionableTmuxSelections(current, nextRows, showOpenTabState);
      });
      setDiscoveryState('done');
      setErrorMessage('');
      setLastRefreshedAt(Date.now());
      missingOpenTabs.forEach((tab) => {
        onCloseOpenTab?.(tab.id, 'session-picker-remote-missing');
      });
      onRemoteSessionsRefreshed?.(discoveryTarget, sessions);
    } catch (error) {
      setAvailableSessions([]);
      setSelectedSessions([]);
      setDiscoveryState('error');
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setLastRefreshedAt(null);
    }
  };

  useEffect(() => {
    if (!shouldAutoRefreshTmuxPicker({
      open,
      relayDirectoryTarget: selectedTargetIsRelayDirectoryTarget,
      target: selectedTarget,
    })) {
      return;
    }
    void handleRefreshNow();
  }, [
    open,
    selectedTargetIsRelayDirectoryTarget,
    selectedTarget.authToken,
    selectedTarget.bridgeHost,
    selectedTarget.bridgePort,
    selectedTarget.daemonHostId,
    selectedTarget.relayEndpointCandidates,
    selectedTarget.relayHostId,
    selectedTarget.relayTmuxSessions,
  ]);

  const handleCreateSession = async (backend = newSessionBackend) => {
    const sessionName = newSessionName.trim();
    if (!selectedTarget.bridgeHost.trim() && !selectedTargetCanUseRelayTransport) {
      alert('先输入 Tailscale IP 或选择服务器');
      return;
    }
    if (!sessionName) {
      alert('请输入新的 tmux session 名称');
      return;
    }

    setBusyAction(`create:${sessionName}`);
    try {
      const creationTarget = { ...selectedTarget, terminalBackend: backend };
      await createTmuxSession(creationTarget, bridgeSettings, sessionName);
      setNewSessionName('');
      if (backend === 'herdr') {
        onOpenTmuxSession({ ...creationTarget, terminalBackend: undefined }, sessionName);
        return;
      }
      await handleRefreshNow();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRenameSession = (sessionName: string) => {
    setRenameTarget({ kind: 'remote', sessionName });
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

  const handleRenameOpenTab = (sessionId: string, currentName: string) => {
    setRenameTarget({ kind: 'openTab', sessionId, currentName });
  };

  const submitRename = (nextName: string) => {
    const target = renameTarget;
    setRenameTarget(null);
    if (!target) {
      return;
    }
    const normalizedName = nextName.trim();
    if (!normalizedName) {
      return;
    }
    if (target.kind === 'openTab') {
      if (normalizedName === target.currentName) {
        return;
      }
      onRenameOpenTab?.(target.sessionId, normalizedName);
      return;
    }
    if (normalizedName === target.sessionName) {
      return;
    }

    const previousSessionName = target.sessionName;
    setBusyAction(`rename:${previousSessionName}`);
    void (async () => {
      try {
        await renameTmuxSession(selectedTarget, bridgeSettings, previousSessionName, normalizedName);
        setSelectedSessions((current) => current.map((item) => (item === previousSessionName ? normalizedName : item)));
        await handleRefreshNow();
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction(null);
      }
    })();
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
                : mode === 'new-connection'
                  ? '先新增一台服务器，再继续选择已有 target 或 clean session。'
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

        {mode === 'new-connection' && (
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
            <SectionTitle
              title="新增服务器"
              subtitle="这一步是创建一台新的服务器配置，不和已有服务器混成一个语义。"
            />
            <button
              type="button"
              data-testid="tmux-session-picker-add-server"
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
              新增服务器
            </button>
          </div>
        )}

        {mode === 'new-connection' && (
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
            <SectionTitle
              title="导入 / 分享连接"
              subtitle="粘贴分享链接、扫描二维码图片，或选择已有连接生成二维码给另一台机器同步。"
            />
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => handleImportConnectionLink(connectionImportInput)}
                style={{
                  minHeight: '40px',
                  padding: '0 14px',
                  borderRadius: '14px',
                  border: 'none',
                  backgroundColor: mobileTheme.colors.shell,
                  color: '#ffffff',
                  fontWeight: 800,
                }}
              >
                导入链接
              </button>
              <button
                type="button"
                onClick={() => qrScanInputRef.current?.click()}
                style={{
                  minHeight: '40px',
                  padding: '0 14px',
                  borderRadius: '14px',
                  border: 'none',
                  backgroundColor: 'rgba(14,165,233,0.16)',
                  color: '#0369a1',
                  fontWeight: 800,
                }}
              >
                扫描二维码图片
              </button>
              <input
                ref={qrScanInputRef}
                aria-label="Scan connection QR image"
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={(event) => void handleScanQrFile(event.target.files?.[0])}
              />
            </div>
            <textarea
              aria-label="Connection share link"
              value={connectionImportInput}
              onChange={(event) => {
                setConnectionImportInput(event.target.value);
                setConnectionImportStatus('');
              }}
              placeholder="zterm://connection/import?payload=..."
              rows={3}
              style={{
                width: '100%',
                border: `1px solid ${mobileTheme.colors.lightBorder}`,
                borderRadius: '18px',
                padding: '12px 14px',
                backgroundColor: '#f6f8fb',
                color: mobileTheme.colors.lightText,
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
            {connectionImportStatus && (
              <div
                role="status"
                style={{
                  fontSize: '12px',
                  color: connectionImportStatus.includes('失败') || connectionImportStatus.includes('未启用')
                    ? mobileTheme.colors.danger
                    : mobileTheme.colors.lightMuted,
                }}
              >
                {connectionImportStatus}
              </div>
            )}

            {selectedShareLink && (
              <div style={{ display: 'grid', gap: '10px' }}>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 900, color: mobileTheme.colors.lightText }}>
                    {shareTitle}
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '12px', color: mobileTheme.colors.lightMuted }}>
                    {shareSubtitle} 可以扫下面二维码，或复制链接后导入。
                  </div>
                </div>
                <div
                  data-testid="tmux-session-picker-share-qr"
                  aria-label="Connection share QR code"
                  style={{
                    width: '216px',
                    minHeight: '216px',
                    borderRadius: '24px',
                    backgroundColor: '#ffffff',
                    boxShadow: mobileTheme.shadow.soft,
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    display: 'grid',
                    placeItems: 'center',
                    padding: '12px',
                    overflow: 'hidden',
                  }}
                  dangerouslySetInnerHTML={{ __html: shareQrSvg || '<span>QR building...</span>' }}
                />
                <textarea
                  data-testid="tmux-session-picker-share-link"
                  readOnly
                  value={selectedShareLink}
                  rows={3}
                  style={{
                    width: '100%',
                    border: `1px solid ${mobileTheme.colors.lightBorder}`,
                    borderRadius: '18px',
                    padding: '12px 14px',
                    backgroundColor: '#ffffff',
                    color: mobileTheme.colors.lightText,
                    fontSize: '12px',
                    lineHeight: 1.5,
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {shareScope === 'single' && shareableHosts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setShareScope('all')}
                      style={{
                        minHeight: '40px',
                        padding: '0 14px',
                        borderRadius: '14px',
                        border: `1px solid ${mobileTheme.colors.lightBorder}`,
                        backgroundColor: '#ffffff',
                        color: mobileTheme.colors.lightText,
                        fontWeight: 800,
                      }}
                    >
                      改为分享全部连接
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCopyShareLink()}
                    style={{
                      minHeight: '40px',
                      padding: '0 14px',
                      borderRadius: '14px',
                      border: 'none',
                      backgroundColor: mobileTheme.colors.shell,
                      color: '#ffffff',
                      fontWeight: 800,
                    }}
                  >
                    复制分享链接
                  </button>
                  {shareCopyStatus && (
                    <span style={{ fontSize: '12px', color: shareCopyStatus.includes('失败') ? mobileTheme.colors.danger : mobileTheme.colors.lightMuted }}>
                      {shareCopyStatus}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gap: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: mobileTheme.colors.lightText }}>
                可选：只分享某一个连接
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                {shareableHosts.length > 0 ? shareableHosts.map((host) => {
                  const active = shareScope === 'single' && host.id === selectedShareHostId;
                  return (
                    <button
                      key={host.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setShareScope('single');
                        setSelectedShareHostId(host.id);
                      }}
                      style={{
                        border: active ? `2px solid ${mobileTheme.colors.shell}` : 'none',
                        borderRadius: '16px',
                        padding: active ? '8px 10px' : '10px 12px',
                        backgroundColor: active ? 'rgba(16,18,24,0.06)' : '#ffffff',
                        color: mobileTheme.colors.lightText,
                        boxShadow: mobileTheme.shadow.soft,
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ fontWeight: 800 }}>{host.name}</div>
                      <div style={{ fontSize: '11px', opacity: 0.78 }}>{host.bridgeHost}:{host.bridgePort}</div>
                    </button>
                  );
                }) : (
                  <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted }}>
                    还没有可分享的已保存连接。
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {relayDevicesAvailable && (
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
            <SectionTitle title="Daemon" subtitle="Relay daemon 是可选 route；直接 Tailscale/bridge target 仍可在下方输入或选择后刷新。" />
            <RelayDevicePicker
              relayEnabled
              devices={relayDevices}
              selectedRelayHostId={selectedTarget.relayHostId || selectedTarget.daemonHostId || ''}
              selectedRelayDeviceId={selectedTarget.relayDeviceId || ''}
              onSelect={(device) => {
                const resolvedTarget = resolveRelayDeviceBridgeTarget(sortedServers, device);
                setSelectedTarget((current) => ({
                  ...current,
                  ...resolvedTarget,
                }));
                setAvailableSessions([]);
                setSelectedSessions([]);
                setDiscoveryState('loading');
                setErrorMessage('');
                setLastRefreshedAt(null);
              }}
              onClear={() =>
                setSelectedTarget((current) => ({
                  ...current,
                  daemonHostId: '',
                  relayHostId: '',
                  relayDeviceId: '',
                }))
              }
            />
          </div>
        )}

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
          <SectionTitle
            title={mode === 'new-connection' ? '已有服务器' : 'Target'}
            subtitle={
              relayDevicesAvailable
                ? '可直接刷新 Tailscale/bridge target；选择 Relay daemon 时也可以通过 relay-rtc 刷新 tmux sessions。'
                : '支持手动输入 Tailscale IP/域名；填写完成后显式点击 Connect，才会测试连通并刷新 tmux sessions。'
            }
          />
          <input
            value={selectedTarget.bridgeHost}
            onChange={(event) => setSelectedTarget((current) => ({ ...current, bridgeHost: event.target.value }))}
            placeholder="100.127.23.27 或 your-device.ts.net"
            disabled={targetInputLocked}
            style={{
              minHeight: '48px',
              borderRadius: '16px',
              border: `1px solid ${mobileTheme.colors.lightBorder}`,
              padding: '0 14px',
              fontSize: '15px',
            }}
          />
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }} aria-label="new session backend">
              {(['tmux', 'herdr'] as const).map((backend) => (
                <button
                  key={backend}
                  type="button"
                  aria-pressed={newSessionBackend === backend}
                  onClick={() => {
                    setNewSessionBackend(backend);
                    setSelectedTarget((current) => ({ ...current, terminalBackend: backend }));
                  }}
                  style={{
                    minHeight: '42px',
                    borderRadius: '14px',
                    border: `1px solid ${newSessionBackend === backend ? mobileTheme.colors.accent : mobileTheme.colors.lightBorder}`,
                    backgroundColor: newSessionBackend === backend ? mobileTheme.colors.accentSoft : '#ffffff',
                    color: mobileTheme.colors.lightText,
                    fontWeight: 800,
                    padding: '0 10px',
                  }}
                >
                  {backend === 'tmux' ? 'tmux' : 'Herdr'}
                </button>
              ))}
            </div>
            <input
              type="number"
              value={selectedTarget.bridgePort}
              onChange={(event) =>
                setSelectedTarget((current) => ({
                  ...current,
                  bridgePort: Number.parseInt(event.target.value, 10) || DEFAULT_BRIDGE_PORT,
                }))
              }
              disabled={targetInputLocked}
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
              disabled={targetInputLocked}
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
            {serverViews.map(({ server, daemonHostId, bridgeLabel, daemonLabel, targetBadge }) => {
              const active = server.targetHost === selectedTarget.bridgeHost && server.targetPort === selectedTarget.bridgePort;
              return (
                <button
                  key={server.id}
                  onClick={() =>
                    setSelectedTarget({
                      bridgeHost: server.targetHost,
                      bridgePort: server.targetPort,
                      daemonHostId: daemonHostId || '',
                      authToken: server.authToken || '',
                      relayHostId: daemonHostId || '',
                      relayDeviceId: server.relayDeviceId || '',
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
                  <div style={{ fontSize: '11px', opacity: 0.78 }}>{bridgeLabel}</div>
                  {daemonHostId ? (
                    <div style={{ fontSize: '10px', opacity: 0.72 }}>{daemonLabel}</div>
                  ) : null}
                  <div style={{ fontSize: '10px', opacity: 0.72 }}>{targetBadge} · {server.authToken ? 'Auth' : 'No auth'}</div>
                </button>
              );
            })}
          </div>
        </div>

        {!relayDevicesAvailable && <RelayDevicePicker
          relayEnabled={relayEnabled}
          devices={relayDevices}
          selectedRelayHostId={selectedTarget.relayHostId || selectedTarget.daemonHostId || ''}
          selectedRelayDeviceId={selectedTarget.relayDeviceId || ''}
          onSelect={(device) => {
            const resolvedTarget = resolveRelayDeviceBridgeTarget(sortedServers, device);
            setSelectedTarget((current) => ({
              ...current,
              ...resolvedTarget,
            }));
            setAvailableSessions([]);
            setSelectedSessions([]);
            setDiscoveryState('loading');
            setErrorMessage('');
            setLastRefreshedAt(null);
          }}
          onClear={() =>
            setSelectedTarget((current) => ({
              ...current,
              daemonHostId: '',
              relayHostId: '',
              relayDeviceId: '',
            }))
          }
        />}

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
          <SectionTitle
            title="Sessions"
            subtitle={
              showOpenTabState
                ? '按 daemon session 顺序合并本地 open tabs。已打开的可进入/关闭，未打开的可勾选或直接打开。'
                : '有明确勾选框；先点 Connect，再勾选并批量打开。这里不再自动刷新。'
            }
          />

          <div style={{ fontSize: '13px', color: mobileTheme.colors.lightMuted }}>
            {!selectedTarget.bridgeHost && '先输入 Tailscale IP 或选择一个服务器'}
            {selectedTarget.bridgeHost && discoveryState === 'loading' && '正在拉取 tmux session...'}
            {selectedTarget.bridgeHost && discoveryState === 'error' && errorMessage}
            {selectedTarget.bridgeHost && discoveryState === 'done' && availableSessions.length === 0 && '当前服务器还没有 tmux session'}
          </div>

          {unifiedSessionRows.map((row) => {
            const { sessionName } = row;
            const selected = selectedSessions.includes(sessionName);
            const active = row.openTab?.id === activeTabId;
            const missingRemote = !row.remotePresent;
            const openStatus = row.openTab
              ? row.remotePresent
                ? `Open tab${active ? ' · Active' : ''}`
                : 'Open tab · not reported by daemon'
              : 'Daemon session';
            return (
              <div
                key={row.key}
                data-testid="tmux-session-row"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  opacity: missingRemote ? 0.42 : 1,
                  pointerEvents: missingRemote ? 'none' : 'auto',
                }}
              >
                {!row.openTab && row.remotePresent && !missingRemote ? (
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
                ) : null}
                <button
                  onClick={() => {
                    if (row.openTab && !missingRemote) {
                      onSwitchOpenTab?.(row.openTab.id);
                      onClose();
                      return;
                    }
                    if (!missingRemote) {
                      toggleSession(sessionName);
                    }
                  }}
                  style={{
                    flex: 1,
                    border: 'none',
                    borderRadius: '18px',
                    padding: '12px 14px',
                    backgroundColor: missingRemote
                      ? '#eef1f5'
                      : row.openTab ? 'rgba(113, 164, 255, 0.16)' : selected ? 'rgba(31,214,122,0.14)' : '#f6f8fb',
                    color: mobileTheme.colors.lightText,
                    textAlign: 'left',
                    fontWeight: 800,
                  }}
                >
                  <div data-testid="tmux-session-name">{row.displayName}</div>
                    <div style={{ fontSize: '11px', color: mobileTheme.colors.lightMuted, marginTop: '4px' }}>
                      {openStatus}
                      {row.displayName !== sessionName ? ` · ${sessionName}` : ''}
                    </div>
                  </button>
                {row.openTab && !missingRemote ? (
                  <button
                    onClick={() => {
                      onSwitchOpenTab?.(row.openTab!.id);
                      onClose();
                    }}
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
                    Enter
                  </button>
                ) : !missingRemote ? (
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
                ) : null}
                {missingRemote ? null : (
                <button
                  type="button"
                  aria-label={row.openTab ? `重命名标签页 ${row.displayName}` : `重命名 tmux session ${sessionName}`}
                  onClick={() => {
                    if (row.openTab) {
                      handleRenameOpenTab(row.openTab.id, row.displayName);
                      return;
                    }
                    void handleRenameSession(sessionName);
                  }}
                  disabled={row.openTab ? !onRenameOpenTab : busyAction !== null}
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
                )}
                {missingRemote ? null : (
                <button
                  onClick={() => {
                    if (row.openTab) {
                      onCloseOpenTab?.(row.openTab.id, 'quick-tab-picker-close-button');
                      return;
                    }
                    void handleKillSession(sessionName);
                  }}
                  disabled={row.openTab ? !onCloseOpenTab : busyAction !== null}
                  style={{
                    minWidth: row.openTab ? '58px' : '44px',
                    height: '44px',
                    border: 'none',
                    borderRadius: '14px',
                    backgroundColor: 'rgba(255,124,146,0.16)',
                    color: mobileTheme.colors.danger,
                  }}
                >
                    {row.openTab ? 'Close' : '×'}
                  </button>
                )}
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
                onOpenMultipleTmuxSessions(selectedTarget, actionableSelectedSessions);
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
              onClick={() => setBackendChoiceOpen(true)}
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
      {backendChoiceOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="选择新 session backend"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            backgroundColor: 'rgba(15, 23, 42, 0.42)',
          }}
        >
          <div style={{ width: 'min(420px, 100%)', borderRadius: '24px', padding: '20px', backgroundColor: '#ffffff', boxShadow: mobileTheme.shadow.soft }}>
            <SectionTitle title="选择新 session backend" subtitle="只创建单一 terminal surface；Herdr 不映射 pane、tab 或 workspace。" />
            <div style={{ display: 'grid', gap: '10px', marginTop: '16px' }}>
              {(['tmux', 'herdr'] as const).map((backend) => (
                <button
                  key={backend}
                  type="button"
                  onClick={() => {
                    setNewSessionBackend(backend);
                    setBackendChoiceOpen(false);
                    void handleCreateSession(backend);
                  }}
                  style={{ border: 'none', borderRadius: '16px', padding: '14px', backgroundColor: backend === 'herdr' ? mobileTheme.colors.accentSoft : mobileTheme.colors.shell, color: backend === 'herdr' ? mobileTheme.colors.lightText : '#ffffff', fontWeight: 800, textAlign: 'left' }}
                >
                  {backend === 'tmux' ? 'tmux — existing tmux backend' : 'Herdr — official single-session backend'}
                </button>
              ))}
              <button type="button" onClick={() => setBackendChoiceOpen(false)} style={{ border: `1px solid ${mobileTheme.colors.lightBorder}`, borderRadius: '16px', padding: '12px', backgroundColor: '#ffffff', color: mobileTheme.colors.lightText }}>取消</button>
            </div>
          </div>
        </div>
      )}
      <RenameDialog
        open={renameTarget !== null}
        title={renameTarget?.kind === 'remote' ? '重命名 tmux session' : '重命名标签页'}
        inputLabel={renameTarget?.kind === 'remote' ? '新的 tmux session 名称' : '新的标签页名称'}
        initialValue={renameTarget?.kind === 'remote' ? renameTarget.sessionName : renameTarget?.currentName || ''}
        onCancel={() => setRenameTarget(null)}
        onSubmit={submitRename}
      />
    </div>
  );
}
