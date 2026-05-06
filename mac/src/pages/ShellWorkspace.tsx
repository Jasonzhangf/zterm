import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  TerminalView,
  buildBridgeServerPresetIdentityId,
  formatBridgeEndpoint,
  formatBridgeSessionTarget,
  getResolvedSessionName,
  setDefaultBridgeServer,
  upsertBridgeServer,
  type BridgeSettings,
  type EditableHost,
  type Host,
} from '@zterm/shared';
import {
  createTerminalRuntime,
  useTerminalRuntimeState,
  type TerminalRuntimeController,
} from '../lib/terminal-runtime';
import { createIdleConnectionState, type TerminalConnectionState } from '../lib/bridge-transport';
import { DetailsSlot } from './DetailsSlot';
import { QuickConnectSheet } from './QuickConnectSheet';
import { SessionScheduleModal } from '../components/SessionScheduleModal';
import { RemoteScreenshotSheet, type RemoteScreenshotPreviewState } from '../components/RemoteScreenshotSheet';
import { FileTransferSheet } from '../components/FileTransferSheet';
import {
  cloneWorkspaceState,
  createConnectionWorkspaceTab,
  createEmptyWorkspaceTab,
  createLocalTmuxWorkspaceTab,
  createShellProfile,
  createWorkspacePane,
  loadShellProfiles,
  loadShellWorkspaceState,
  normalizePaneSizes,
  normalizeWorkspaceState,
  saveShellProfiles,
  saveShellWorkspaceState,
  type QuickPaletteTab,
  type ShellProfileRecord,
  type ShellWorkspacePane,
  type ShellWorkspaceState,
  type ShellWorkspaceTab,
} from '../lib/shell-workspace';

interface ShellWorkspaceProps {
  hosts: Host[];
  isLoaded: boolean;
  bridgeSettings: BridgeSettings;
  setBridgeSettings: Dispatch<SetStateAction<BridgeSettings>>;
  addHost: (host: EditableHost) => Host;
  updateHost: (id: string, updates: Partial<EditableHost>) => void;
}

interface ConnectionPickerState {
  paneId: string;
  mode: 'replace-active' | 'append-tab';
}

interface ConnectionEditorState {
  paneId: string;
  mode: 'replace-active' | 'append-tab';
  hostId?: string;
}

interface QuickPaletteItem {
  id: string;
  title: string;
  subtitle: string;
  value: string;
}

type ConnectionRequest =
  | {
      kind: 'local-tmux';
      resourceKey: string;
      sessionName: string;
      connectSignature: string;
    }
  | {
      kind: 'connection';
      resourceKey: string;
      target: EditableHost;
      connectSignature: string;
    };

const MAX_PANES = 3;
const MIN_PANE_RATIO = 0.18;
const QUICK_SHORTCUTS: QuickPaletteItem[] = [
  {
    id: 'attach-main',
    title: 'tmux attach -t main',
    subtitle: '常用 attach 命令',
    value: 'tmux attach -t main',
  },
  {
    id: 'attach-zterm',
    title: 'tmux attach -t zterm',
    subtitle: '切回 zterm 工作会话',
    value: 'tmux attach -t zterm',
  },
  {
    id: 'cd-zterm',
    title: 'cd ~/Documents/github/zterm',
    subtitle: '进入当前项目目录',
    value: 'cd ~/Documents/github/zterm',
  },
  {
    id: 'pnpm-mac-package',
    title: 'pnpm --filter @zterm/mac package',
    subtitle: '本地打包 Mac 包',
    value: 'pnpm --filter @zterm/mac package',
  },
  {
    id: 'tailscale-status',
    title: 'tailscale status',
    subtitle: '检查 Tailscale / bridge 网络状态',
    value: 'tailscale status',
  },
];

function toEditableHost(host: Host | EditableHost): EditableHost {
  return {
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName: host.sessionName,
    authToken: host.authToken,
    authType: host.authType,
    password: host.password,
    privateKey: host.privateKey,
    tags: host.tags,
    pinned: host.pinned,
    lastConnected: host.lastConnected,
    autoCommand: host.autoCommand,
  };
}

function resolveTabTarget(tab: ShellWorkspaceTab | null | undefined, hosts: Host[]) {
  if (!tab || tab.kind !== 'connection') {
    return null;
  }
  if (tab.persistedHostId) {
    const persisted = hosts.find((host) => host.id === tab.persistedHostId);
    if (persisted) {
      return toEditableHost(persisted);
    }
  }
  return tab.target ? toEditableHost(tab.target) : null;
}

function resolveLocalSessionName(tab: ShellWorkspaceTab | null | undefined) {
  return tab?.kind === 'local-tmux' ? tab.localSessionName?.trim() || '' : '';
}

function buildRemoteSessionResourceKey(target: EditableHost) {
  return JSON.stringify({
    kind: 'remote',
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    sessionName: target.sessionName,
  });
}

function buildRemoteConnectSignature(target: EditableHost) {
  return JSON.stringify({
    kind: 'remote',
    authToken: target.authToken || '',
    authType: target.authType,
    password: target.password || '',
    privateKey: target.privateKey || '',
    autoCommand: target.autoCommand || '',
  });
}

function buildLocalSessionResourceKey(sessionName: string) {
  return JSON.stringify({
    kind: 'local-tmux',
    sessionName,
  });
}

function resolveRuntimeResourceKey(tab: ShellWorkspaceTab | null | undefined, hosts: Host[]) {
  if (!tab || tab.kind === 'empty') {
    return null;
  }

  if (tab.kind === 'local-tmux') {
    const localSessionName = resolveLocalSessionName(tab);
    return localSessionName ? buildLocalSessionResourceKey(localSessionName) : null;
  }

  const target = resolveTabTarget(tab, hosts);
  return target ? buildRemoteSessionResourceKey(target) : null;
}

async function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unsupported image payload'));
        return;
      }
      const [, dataBase64 = ''] = result.split(',', 2);
      resolve(dataBase64);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

function updateWorkspacePane(
  current: ShellWorkspaceState,
  paneId: string,
  updater: (pane: ShellWorkspacePane) => ShellWorkspacePane,
) {
  const next = cloneWorkspaceState(current);
  const index = next.panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) {
    return current;
  }
  next.panes[index] = updater(next.panes[index]);
  return normalizeWorkspaceState(next);
}

function resolveActivePane(workspace: ShellWorkspaceState) {
  return workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? workspace.panes[0] ?? null;
}

function resolveActiveTab(workspace: ShellWorkspaceState) {
  const pane = resolveActivePane(workspace);
  if (!pane) {
    return null;
  }
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
}

function formatProfileTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function normalizeSizesWithDelta(panes: ShellWorkspacePane[], index: number, deltaRatio: number) {
  if (index < 0 || index >= panes.length - 1) {
    return panes;
  }
  const next = panes.map((pane) => ({ ...pane }));
  const left = next[index];
  const right = next[index + 1];
  const combined = left.size + right.size;
  const proposedLeft = Math.min(combined - MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, left.size + deltaRatio));
  const proposedRight = combined - proposedLeft;
  if (proposedRight < MIN_PANE_RATIO) {
    return panes;
  }
  left.size = proposedLeft;
  right.size = proposedRight;
  return normalizePaneSizes(next);
}

function EmptyPane({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="shell-empty-pane" type="button" onClick={onOpen}>
      <span className="shell-empty-plus">+</span>
      <span className="shell-empty-title">Open connection</span>
      <span className="shell-empty-copy">默认就是干净 shell，只有需要时再挂连接。</span>
    </button>
  );
}

function PaneTabStatus({
  tab,
  runtime,
}: {
  tab: ShellWorkspaceTab;
  runtime: TerminalRuntimeController | null;
}) {
  const runtimeState = useTerminalRuntimeState(runtime);
  const runtimeStatus = tab.kind !== 'empty' ? runtimeState.connection.status : 'idle';
  return <span className={`shell-tab-dot ${runtimeStatus}`} />;
}

function PaneSurface({
  tab,
  target,
  localSessionName,
  runtime,
  isVisible,
  isInputFocused,
  onOpenConnection,
  terminalThemeId,
  showAbsoluteLineNumbers,
}: {
  tab: ShellWorkspaceTab;
  target: EditableHost | null;
  localSessionName: string;
  runtime: TerminalRuntimeController | null;
  isVisible: boolean;
  isInputFocused: boolean;
  onOpenConnection: () => void;
  terminalThemeId?: string;
  showAbsoluteLineNumbers?: boolean;
}) {
  const runtimeState = useTerminalRuntimeState(runtime);

  if (tab.kind === 'empty' || (tab.kind === 'connection' && !target) || (tab.kind === 'local-tmux' && !localSessionName)) {
    return <EmptyPane onOpen={onOpenConnection} />;
  }

  return (
    <div className="shell-terminal-live">
      {runtimeState.connection.error ? <div className="shell-terminal-banner error">{runtimeState.connection.error}</div> : null}
      <div className="shell-terminal-statusbar">
        <span className={`shell-runtime-pill ${runtimeState.connection.status}`}>{runtimeState.connection.status}</span>
        <span>{tab.kind === 'local-tmux' ? `Local tmux · ${localSessionName}` : formatBridgeSessionTarget(target!)}</span>
        <span>
          {runtimeState.connection.connectedSessionId
            || (tab.kind === 'local-tmux' ? localSessionName : getResolvedSessionName(target!))}
        </span>
      </div>
      <div className="shell-terminal-canvas">
        <TerminalView
          sessionId={
            runtimeState.connection.connectedSessionId
            || (tab.kind === 'local-tmux' ? localSessionName : getResolvedSessionName(target!))
          }
          projection={runtimeState.render}
          active={isVisible}
          allowDomFocus={isInputFocused}
          onInput={(data) => runtime?.sendInput(data)}
          onImagePaste={
            tab.kind === 'connection'
              ? async (file) => {
                  const dataBase64 = await fileToBase64(file);
                  const ok = runtime?.pasteImage({
                    name: file.name || 'clipboard-image',
                    mimeType: file.type || 'image/png',
                    dataBase64,
                    pasteSequence: '\x16',
                  });
                  if (!ok) {
                    throw new Error('当前远端会话还没连上，暂时不能贴图。');
                  }
                }
              : undefined
          }
          onResize={(cols, rows) => runtime?.resizeTerminal(cols, rows)}
          onViewportChange={(viewState) => runtime?.updateViewport(viewState)}
          themeId={terminalThemeId}
          showAbsoluteLineNumbers={showAbsoluteLineNumbers}
        />
      </div>
    </div>
  );
}

export function ShellWorkspace({
  hosts,
  isLoaded,
  bridgeSettings,
  setBridgeSettings,
  addHost,
  updateHost,
}: ShellWorkspaceProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const runtimeRegistryRef = useRef(new Map<string, TerminalRuntimeController>());
  const connectedResourceSignaturesRef = useRef(new Map<string, string>());
  const [workspace, setWorkspace] = useState<ShellWorkspaceState>(() => loadShellWorkspaceState());
  const [profiles, setProfiles] = useState<ShellProfileRecord[]>(() => loadShellProfiles());
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [connectionPicker, setConnectionPicker] = useState<ConnectionPickerState | null>(null);
  const [connectionEditor, setConnectionEditor] = useState<ConnectionEditorState | null>(null);
  const [quickPaletteOpen, setQuickPaletteOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [fileTransferOpen, setFileTransferOpen] = useState(false);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(false);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{ paneId: string; tabId: string; x: number; y: number } | null>(null);
  const fileTransferSendJsonRef = useRef<(msg: unknown) => void>(() => {});
  const fileTransferOnMessageRef = useRef<((handler: (msg: unknown) => void) => () => void) | undefined>(undefined);
  const [clipboardText, setClipboardText] = useState('');
  const [clipboardError, setClipboardError] = useState('');
  const dragStateRef = useRef<{ index: number; startX: number; sizes: number[] } | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    setWorkspace((current) =>
      normalizeWorkspaceState({
        ...current,
        panes: current.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => {
            if (tab.kind !== 'connection' || !tab.persistedHostId) {
              return tab;
            }
            const host = hosts.find((item) => item.id === tab.persistedHostId);
            if (!host) {
              return tab;
            }
            const target = toEditableHost(host);
            return {
              ...tab,
              title: getResolvedSessionName(target),
              target,
            };
          }),
        })),
      }),
    );
  }, [hosts, isLoaded]);

  useEffect(() => {
    saveShellWorkspaceState(workspace);
  }, [workspace]);

  useEffect(() => {
    saveShellProfiles(profiles);
  }, [profiles]);

  const getRuntimeForResource = useCallback((resourceKey: string) => {
    const existing = runtimeRegistryRef.current.get(resourceKey);
    if (existing) {
      return existing;
    }
    const created = createTerminalRuntime();
    runtimeRegistryRef.current.set(resourceKey, created);
    return created;
  }, []);

  const activeTab = useMemo(() => resolveActiveTab(workspace), [workspace]);
  const activeTarget = useMemo(() => resolveTabTarget(activeTab, hosts), [activeTab, hosts]);
  const activeLocalSessionName = useMemo(() => resolveLocalSessionName(activeTab), [activeTab]);
  const activeRuntimeResourceKey = useMemo(() => resolveRuntimeResourceKey(activeTab, hosts), [activeTab, hosts]);
  const activeRuntime = activeRuntimeResourceKey ? getRuntimeForResource(activeRuntimeResourceKey) : null;
  const activeRuntimeState = useTerminalRuntimeState(activeRuntime);

  useEffect(() => {
    fileTransferSendJsonRef.current = (msg: unknown) => { if (activeRuntime) activeRuntime.sendRawJson(msg); };
    fileTransferOnMessageRef.current = activeRuntime?.onFileTransferMessage;
  }, [activeRuntime]);
  const [quickPaletteTab, setQuickPaletteTab] = useState<QuickPaletteTab>('shortcuts');
  const [quickPaletteQuery, setQuickPaletteQuery] = useState('');
  const [remoteScreenshotPreview, setRemoteScreenshotPreview] = useState<RemoteScreenshotPreviewState | null>(null);
  const remoteScreenshotPreviewUrlRef = useRef<string | null>(null);

  const revokeRemoteScreenshotPreviewUrl = useCallback(() => {
    if (remoteScreenshotPreviewUrlRef.current) {
      URL.revokeObjectURL(remoteScreenshotPreviewUrlRef.current);
      remoteScreenshotPreviewUrlRef.current = null;
    }
  }, []);

  const handleRequestRemoteScreenshot = useCallback(async () => {
    if (!activeRuntime || activeRuntimeState.connection.status !== 'connected') {
      return;
    }
    revokeRemoteScreenshotPreviewUrl();
    setRemoteScreenshotPreview({
      phase: 'request-sent',
      fileName: 'remote-screenshot-' + Date.now() + '.png',
      previewDataUrl: null,
      rawDataBase64: null,
    });
    const requestId = 'rs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    activeRuntime.requestRemoteScreenshot({
      requestId,
      onStatus: (status) => {
        setRemoteScreenshotPreview((current) => ({
          phase: status.phase === 'failed' ? 'failed' : (status.phase as RemoteScreenshotPreviewState['phase']),
          fileName: status.fileName || (current && current.fileName) || 'remote-screenshot-' + Date.now() + '.png',
          previewDataUrl: (current && current.previewDataUrl) || null,
          rawDataBase64: (current && current.rawDataBase64) || null,
          totalBytes: status.totalBytes || (current && current.totalBytes) || 0,
          errorMessage: status.errorMessage || (current && current.errorMessage) || null,
        }));
      },
      onChunk: (chunk) => {
        setRemoteScreenshotPreview((current) => {
          if (!current) return null;
          return {
            ...current,
            phase: 'transferring',
            fileName: chunk.fileName || current.fileName,
            receivedChunks: (current.receivedChunks || 0) + 1,
            totalChunks: chunk.totalChunks,
          };
        });
      },
      onComplete: (result) => {
        setRemoteScreenshotPreview((current) => {
          if (!current) return null;
          return {
            ...current,
            phase: 'transfer-complete',
            fileName: result.fileName,
            totalBytes: result.totalBytes,
          };
        });
        const dataBase64 = result.dataBase64Parts.join('');
        try {
          const binary = Uint8Array.from(atob(dataBase64), function(char) { return char.charCodeAt(0); });
          const blob = new Blob([binary.buffer], { type: 'image/png' });
          const previewUrl = URL.createObjectURL(blob);
          remoteScreenshotPreviewUrlRef.current = previewUrl;
          setRemoteScreenshotPreview({
            phase: 'preview-ready',
            fileName: result.fileName,
            previewDataUrl: previewUrl,
            rawDataBase64: dataBase64,
            totalBytes: result.totalBytes,
          });
        } catch (_e) {
          setRemoteScreenshotPreview((current) => {
            if (!current) return null;
            return {
              ...current,
              phase: 'failed',
              errorMessage: 'Failed to decode screenshot data',
            };
          });
        }
      },
      onError: (error) => {
        setRemoteScreenshotPreview((current) => ({
          phase: 'failed',
          fileName: (current && current.fileName) || 'remote-screenshot-' + Date.now() + '.png',
          previewDataUrl: null,
          rawDataBase64: null,
          totalBytes: (current && current.totalBytes) || 0,
          errorMessage: error.message || 'Remote screenshot failed',
        }));
      },
    });
  }, [activeRuntime, activeRuntimeState.connection.status, revokeRemoteScreenshotPreviewUrl]);

  const handleSaveRemoteScreenshot = useCallback(() => {
    if (!remoteScreenshotPreview || !remoteScreenshotPreview.rawDataBase64 || remoteScreenshotPreview.phase !== 'preview-ready') {
      return;
    }
    setRemoteScreenshotPreview((current) => {
      if (!current) return null;
      return { ...current, phase: 'saving' };
    });
    try {
      const binary = Uint8Array.from(atob(remoteScreenshotPreview.rawDataBase64), function(char) { return char.charCodeAt(0); });
      const blob = new Blob([binary.buffer], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = remoteScreenshotPreview.fileName || 'remote-screenshot.png';
      anchor.click();
      URL.revokeObjectURL(url);
      revokeRemoteScreenshotPreviewUrl();
      setRemoteScreenshotPreview(null);
    } catch (_e) {
      setRemoteScreenshotPreview((current) => {
        if (!current) return null;
        return { ...current, phase: 'preview-ready', errorMessage: 'save failed' };
      });
    }
  }, [remoteScreenshotPreview, revokeRemoteScreenshotPreviewUrl]);

  const activeBridgeRuntime = useMemo<TerminalConnectionState>(() => {
    if (activeTab?.kind === 'connection') {
      return activeRuntimeState.connection as TerminalConnectionState;
    }
    return createIdleConnectionState();
  }, [activeRuntimeState.connection, activeTab?.kind]);
  const connectionRequests = useMemo<ConnectionRequest[]>(() => {
    const requestMap = new Map<string, ConnectionRequest>();
    workspace.panes.forEach((pane) => {
      pane.tabs.forEach((tab) => {
        if (tab.kind === 'empty') {
          return;
        }
        if (tab.kind === 'local-tmux') {
          const localSessionName = resolveLocalSessionName(tab);
          if (!localSessionName) {
            return;
          }
          requestMap.set(buildLocalSessionResourceKey(localSessionName), {
            kind: 'local-tmux',
            resourceKey: buildLocalSessionResourceKey(localSessionName),
            sessionName: localSessionName,
            connectSignature: buildLocalSessionResourceKey(localSessionName),
          });
          return;
        }
        const target = resolveTabTarget(tab, hosts);
        if (!target) {
          return;
        }
        requestMap.set(buildRemoteSessionResourceKey(target), {
          kind: 'connection',
          resourceKey: buildRemoteSessionResourceKey(target),
          target,
          connectSignature: buildRemoteConnectSignature(target),
        });
      });
    });
    return [...requestMap.values()];
  }, [hosts, workspace]);

  // Only eager-connect active visible tab per pane; hidden tabs connect on-demand when activated.
  const eagerConnectionRequests = useMemo<ConnectionRequest[]>(() => {
    const activeTabResourceKeys = new Set<string>();
    workspace.panes.forEach((pane) => {
      const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
      if (tab && tab.kind !== 'empty') {
        const key = resolveRuntimeResourceKey(tab, hosts);
        if (key) activeTabResourceKeys.add(key);
      }
    });
    return connectionRequests.filter((r) => activeTabResourceKeys.has(r.resourceKey));
  }, [connectionRequests, hosts, workspace]);

  useEffect(() => {
    const activeResourceKeys = new Set(
      workspace.panes
        .flatMap((pane) => pane.tabs)
        .map((tab) => resolveRuntimeResourceKey(tab, hosts))
        .filter((resourceKey): resourceKey is string => Boolean(resourceKey)),
    );

    runtimeRegistryRef.current.forEach((runtime, resourceKey) => {
      if (!activeResourceKeys.has(resourceKey)) {
        runtime.dispose();
        runtimeRegistryRef.current.delete(resourceKey);
        connectedResourceSignaturesRef.current.delete(resourceKey);
      }
    });
  }, [hosts, workspace]);

  useEffect(() => {
    const activeVisibleResourceKeys = new Set(
      workspace.panes
        .map((pane) => pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null)
        .map((tab) => resolveRuntimeResourceKey(tab, hosts))
        .filter((resourceKey): resourceKey is string => Boolean(resourceKey)),
    );

    runtimeRegistryRef.current.forEach((runtime, resourceKey) => {
      runtime.setActivityMode(activeVisibleResourceKeys.has(resourceKey) ? 'active' : 'idle');
    });
  }, [hosts, workspace]);

  useEffect(() => {
    const allRequestKeys = new Set<string>();
    connectionRequests.forEach((request) => {
      allRequestKeys.add(request.resourceKey);
    });
    eagerConnectionRequests.forEach((request) => {
      const previousSignature = connectedResourceSignaturesRef.current.get(request.resourceKey);
      if (previousSignature === request.connectSignature) {
        return;
      }
      const runtime = getRuntimeForResource(request.resourceKey);
      if (request.kind === 'local-tmux') {
        runtime.connectLocalTmux({ sessionName: request.sessionName, title: request.sessionName });
      } else {
        runtime.connectRemote(request.target);
      }
      connectedResourceSignaturesRef.current.set(request.resourceKey, request.connectSignature);
    });
    connectedResourceSignaturesRef.current.forEach((_signature, resourceKey) => {
      if (!allRequestKeys.has(resourceKey)) {
        connectedResourceSignaturesRef.current.delete(resourceKey);
      }
    });
  }, [eagerConnectionRequests, connectionRequests, getRuntimeForResource]);

  useEffect(() => () => {
    runtimeRegistryRef.current.forEach((runtime) => runtime.dispose());
    runtimeRegistryRef.current.clear();
    connectedResourceSignaturesRef.current.clear();
  }, []);

  useEffect(() => {
    if (!quickPaletteOpen || quickPaletteTab !== 'clipboard') {
      return;
    }
    let cancelled = false;
    setClipboardError('');
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (!cancelled) {
          setClipboardText(text);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setClipboardText('');
          setClipboardError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [quickPaletteOpen, quickPaletteTab]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuickPaletteOpen((current) => !current);
      }
      if (event.key === 'Escape') {
        setQuickPaletteOpen(false);
        setConnectionPicker(null);
        setConnectionEditor(null);
        setProfileMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const persistBridgeServer = useCallback(
    (hostData: EditableHost) => {
      setBridgeSettings((current) => {
        const nextSettings = upsertBridgeServer(current, {
          name: hostData.name,
          targetHost: hostData.bridgeHost,
          targetPort: hostData.bridgePort,
          authToken: hostData.authToken,
        });
        const presetId = buildBridgeServerPresetIdentityId(hostData.bridgeHost, hostData.bridgePort);
        return nextSettings.defaultServerId ? nextSettings : setDefaultBridgeServer(nextSettings, presetId);
      });
    },
    [setBridgeSettings],
  );

  const assignHostToPane = useCallback(
    (paneId: string, host: Host | EditableHost, mode: 'replace-active' | 'append-tab', persistedHostId?: string) => {
      const nextTab = createConnectionWorkspaceTab(toEditableHost(host), persistedHostId);
      setWorkspace((current) => {
        const next = updateWorkspacePane(current, paneId, (pane) => {
          const tabIndex = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
          const activeTabInPane = tabIndex >= 0 ? pane.tabs[tabIndex] : pane.tabs[0];
          const shouldReplace = mode === 'replace-active' && activeTabInPane?.kind === 'empty';
          const tabs = [...pane.tabs];
          if (shouldReplace && tabIndex >= 0) {
            tabs[tabIndex] = nextTab;
          } else {
            tabs.push(nextTab);
          }
          return {
            ...pane,
            tabs,
            activeTabId: nextTab.id,
          };
        });
        return {
          ...next,
          activePaneId: paneId,
        };
      });
      setConnectionPicker(null);
      setConnectionEditor(null);
    },
    [],
  );

  const assignTabsToPane = useCallback(
    (paneId: string, tabsToOpen: ShellWorkspaceTab[], mode: 'replace-active' | 'append-tab') => {
      if (tabsToOpen.length === 0) {
        return;
      }
      setWorkspace((current) => {
        const next = updateWorkspacePane(current, paneId, (pane) => {
          const tabIndex = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
          const activeTabInPane = tabIndex >= 0 ? pane.tabs[tabIndex] : pane.tabs[0];
          const tabs = [...pane.tabs];
          let activeTabId = pane.activeTabId;

          tabsToOpen.forEach((nextTab, index) => {
            const shouldReplace = index === 0 && mode === 'replace-active' && activeTabInPane?.kind === 'empty';
            if (shouldReplace && tabIndex >= 0) {
              tabs[tabIndex] = nextTab;
            } else {
              tabs.push(nextTab);
            }
            activeTabId = nextTab.id;
          });

          return {
            ...pane,
            tabs,
            activeTabId,
          };
        });
        return {
          ...next,
          activePaneId: paneId,
        };
      });
      setConnectionPicker(null);
      setConnectionEditor(null);
    },
    [],
  );


  const handleOpenRemoteSessions = useCallback(
    (items: Array<{ hostData: EditableHost; persistedHostId?: string }>) => {
      if (!connectionPicker) {
        return;
      }
      const nextTabs: ShellWorkspaceTab[] = [];

      items.forEach(({ hostData, persistedHostId }) => {
        const hostWithHistory: EditableHost = {
          ...hostData,
          lastConnected: Date.now(),
        };
        persistBridgeServer(hostData);
        if (persistedHostId) {
          const currentHost = hosts.find((host) => host.id === persistedHostId);
          if (!currentHost) {
            return;
          }
          updateHost(persistedHostId, hostWithHistory);
          nextTabs.push(createConnectionWorkspaceTab({
            ...toEditableHost(currentHost),
            ...hostWithHistory,
          }, persistedHostId));
          return;
        }
        const created = addHost(hostWithHistory);
        nextTabs.push(createConnectionWorkspaceTab(toEditableHost(created), created.id));
      });

      assignTabsToPane(connectionPicker.paneId, nextTabs, connectionPicker.mode);
    },
    [addHost, assignTabsToPane, connectionPicker, hosts, persistBridgeServer, updateHost],
  );

  const handleOpenLocalTmuxSessions = useCallback((sessionNames: string[]) => {
    if (!connectionPicker) {
      return;
    }
    assignTabsToPane(
      connectionPicker.paneId,
      sessionNames.map((sessionName) => createLocalTmuxWorkspaceTab(sessionName)),
      connectionPicker.mode,
    );
  }, [assignTabsToPane, connectionPicker]);

  const handleSaveConnection = useCallback(
    (hostData: EditableHost) => {
      if (!connectionEditor) {
        return;
      }
      const hostWithHistory: EditableHost = {
        ...hostData,
        lastConnected: Date.now(),
      };
      persistBridgeServer(hostData);
      if (connectionEditor.hostId) {
        const currentHost = hosts.find((host) => host.id === connectionEditor.hostId);
        if (!currentHost) {
          return;
        }
        updateHost(connectionEditor.hostId, hostWithHistory);
        const updatedHost: Host = {
          ...currentHost,
          ...hostWithHistory,
          id: connectionEditor.hostId,
        };
        assignHostToPane(connectionEditor.paneId, updatedHost, connectionEditor.mode, connectionEditor.hostId);
        return;
      }
      const created = addHost(hostWithHistory);
      assignHostToPane(connectionEditor.paneId, created, connectionEditor.mode, created.id);
    },
    [addHost, assignHostToPane, connectionEditor, hosts, persistBridgeServer, updateHost],
  );

  const splitActivePane = useCallback(() => {
    setWorkspace((current) => {
      if (current.panes.length >= MAX_PANES) {
        return current;
      }
      const next = cloneWorkspaceState(current);
      const index = Math.max(0, next.panes.findIndex((pane) => pane.id === next.activePaneId));
      next.panes.splice(index + 1, 0, createWorkspacePane(1));
      next.panes = normalizePaneSizes(next.panes);
      next.activePaneId = next.panes[index + 1].id;
      return next;
    });
  }, []);

  const closePane = useCallback((paneId: string) => {
    setWorkspace((current) => {
      if (current.panes.length <= 1) {
        return current;
      }
      const next = cloneWorkspaceState(current);
      const index = next.panes.findIndex((pane) => pane.id === paneId);
      if (index === -1) {
        return current;
      }
      next.panes.splice(index, 1);
      next.panes = normalizePaneSizes(next.panes);
      if (next.activePaneId === paneId) {
        next.activePaneId = next.panes[Math.max(0, index - 1)]?.id || next.panes[0].id;
      }
      return next;
    });
  }, []);

  const setActivePaneTab = useCallback((paneId: string, tabId: string) => {
    setWorkspace((current) => ({
      ...updateWorkspacePane(current, paneId, (pane) => ({ ...pane, activeTabId: tabId })),
      activePaneId: paneId,
    }));
  }, []);

  const createEmptyTabInPane = useCallback((paneId: string) => {
    const newTab = createEmptyWorkspaceTab();
    setWorkspace((current) => ({
      ...updateWorkspacePane(current, paneId, (pane) => ({
        ...pane,
        tabs: [...pane.tabs, newTab],
        activeTabId: newTab.id,
      })),
      activePaneId: paneId,
    }));
  }, []);

  const closeTab = useCallback((paneId: string, tabId: string) => {
    setWorkspace((current) => {
      const next = updateWorkspacePane(current, paneId, (pane) => {
        const remaining = pane.tabs.filter((tab) => tab.id !== tabId);
        if (remaining.length === 0) {
          const empty = createEmptyWorkspaceTab();
          return {
            ...pane,
            tabs: [empty],
            activeTabId: empty.id,
          };
        }
        const nextActiveId = pane.activeTabId === tabId
          ? remaining[Math.max(0, remaining.length - 1)]!.id
          : pane.activeTabId;
        return {
          ...pane,
          tabs: remaining,
          activeTabId: nextActiveId,
        };
      });
      return {
        ...next,
        activePaneId: paneId,
      };
    });
  }, []);

  const moveTabToPane = useCallback((sourcePaneId: string, tabId: string, targetPaneId: string) => {
    if (sourcePaneId === targetPaneId) return;
    setWorkspace((current) => {
      const next = cloneWorkspaceState(current);
      const sourcePane = next.panes.find((p) => p.id === sourcePaneId);
      const targetPane = next.panes.find((p) => p.id === targetPaneId);
      if (!sourcePane || !targetPane) return current;
      const tabIndex = sourcePane.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return current;
      const [movedTab] = sourcePane.tabs.splice(tabIndex, 1);
      targetPane.tabs.push(movedTab);
      targetPane.activeTabId = movedTab.id;
      next.activePaneId = targetPaneId;
      // If source pane is now empty, add an empty tab
      if (sourcePane.tabs.length === 0) {
        const empty = createEmptyWorkspaceTab();
        sourcePane.tabs.push(empty);
        sourcePane.activeTabId = empty.id;
      } else if (sourcePane.activeTabId === tabId) {
        sourcePane.activeTabId = sourcePane.tabs[Math.max(0, sourcePane.tabs.length - 1)].id;
      }
      return next;
    });
  }, []);

  const handleDividerPointerDown = useCallback((index: number, clientX: number) => {
    dragStateRef.current = {
      index,
      startX: clientX,
      sizes: workspace.panes.map((pane) => pane.size),
    };
  }, [workspace.panes]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current || !stageRef.current) {
        return;
      }
      const { index, startX, sizes } = dragStateRef.current;
      const bounds = stageRef.current.getBoundingClientRect();
      if (!bounds.width) {
        return;
      }
      const deltaRatio = (event.clientX - startX) / bounds.width;
      setWorkspace((current) => {
        const base = current.panes.map((pane, paneIndex) => ({ ...pane, size: sizes[paneIndex] ?? pane.size }));
        return {
          ...current,
          panes: normalizeSizesWithDelta(base, index, deltaRatio),
        };
      });
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);


  const quickPaletteItems = useMemo(() => {
    const base = quickPaletteTab === 'shortcuts'
      ? QUICK_SHORTCUTS
      : clipboardText
        ? clipboardText
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 12)
            .map((line, index) => ({
              id: `clipboard-${index}`,
              title: line,
              subtitle: '来自系统剪贴板',
              value: line,
            }))
        : [];
    const query = quickPaletteQuery.trim().toLowerCase();
    return query
      ? base.filter((item) => `${item.title} ${item.subtitle}`.toLowerCase().includes(query))
      : base;
  }, [clipboardText, quickPaletteQuery, quickPaletteTab]);

  const applyQuickPaletteItem = useCallback(
    async (item: QuickPaletteItem) => {
      if (activeRuntime && activeRuntimeState.connection.status === 'connected') {
        activeRuntime.sendInput(`${item.value}\r`);
      } else {
        await navigator.clipboard.writeText(item.value);
      }
      setQuickPaletteOpen(false);
    },
    [activeRuntime, activeRuntimeState.connection.status],
  );

  const exportWorkspaceProfile = useCallback((name: string, targetWorkspace: ShellWorkspaceState) => {
    const blob = new Blob(
      [JSON.stringify(createShellProfile(name, targetWorkspace), null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name.replace(/\s+/g, '-').toLowerCase() || 'zterm-profile'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  if (!isLoaded) {
    return <div className="shell-loading">Loading shell workspace…</div>;
  }

  return (
    <div className="shell-workspace-root">
      <header className="shell-topbar">
        <div className="shell-topbar-leading" aria-hidden="true">
          <span className="traffic-light red" />
          <span className="traffic-light yellow" />
          <span className="traffic-light green" />
        </div>

        <div className="shell-topbar-title">
          <strong>ZTerm</strong>
          <span>
            {activeLocalSessionName
              ? `Local tmux · ${activeLocalSessionName}`
              : activeTarget
                ? formatBridgeSessionTarget(activeTarget)
                : 'single shell · split on demand'}
          </span>
        </div>

        <div className="shell-topbar-actions">
          <button className="shell-action-button" type="button" onClick={() => setQuickPaletteOpen(true)}>
            ⌘K
          </button>
          <button className="shell-action-button" type="button" onClick={splitActivePane} disabled={workspace.panes.length >= MAX_PANES}>
            Split
          </button>
          <button
            className="shell-action-button"
            type="button"
            disabled={activeTab?.kind !== 'connection' || !activeTarget || !activeRuntime}
            onClick={() => {
              if (activeTab?.kind !== 'connection' || !activeTarget || !activeRuntime) {
                return;
              }
              activeRuntime.requestScheduleList(getResolvedSessionName(activeTarget));
              setScheduleModalOpen(true);
            }}
          >
            Schedule
          </button>
          <button
            className="shell-action-button"
            type="button"
            disabled={activeTab?.kind !== 'connection' || !activeTarget || !activeRuntime || activeRuntimeState.connection.status !== 'connected'}
            onClick={() => void handleRequestRemoteScreenshot()}
          >
            Screenshot
          </button>
          <button
            className="shell-action-button"
            type="button"
            disabled={activeTab?.kind !== 'connection' || !activeTarget || !activeRuntime || activeRuntimeState.connection.status !== 'connected'}
            onClick={() => setFileTransferOpen(true)}
          >
            Sync
          </button>
          <button
            className={"shell-action-button" + (debugOverlayVisible ? " active" : "")}
            type="button"
            onClick={() => setDebugOverlayVisible((v) => !v)}
          >
            Debug
          </button>
          <button
            className={"shell-action-button" + (absoluteLineNumbersVisible ? " active" : "")}
            type="button"
            onClick={() => setAbsoluteLineNumbersVisible((v) => !v)}
          >
            Line#
          </button>
          <div className="shell-menu-anchor">
            <button className="shell-action-button" type="button" onClick={() => setProfileMenuOpen((current) => !current)}>
              Profiles
            </button>
            {profileMenuOpen ? (
              <div className="shell-profile-menu">
                <button
                  className="shell-profile-menu-item"
                  type="button"
                  onClick={() => {
                    const name = window.prompt('Profile 名称', `Workspace ${profiles.length + 1}`)?.trim();
                    if (!name) {
                      return;
                    }
                    setProfiles((current) => {
                      const existing = current.find((profile) => profile.name === name);
                      if (existing) {
                        return current.map((profile) =>
                          profile.id === existing.id
                            ? { ...profile, updatedAt: Date.now(), workspace: normalizeWorkspaceState(workspace) }
                            : profile,
                        );
                      }
                      return [createShellProfile(name, workspace), ...current];
                    });
                    setProfileMenuOpen(false);
                  }}
                >
                  Save current workspace
                </button>
                <button
                  className="shell-profile-menu-item"
                  type="button"
                  onClick={() => {
                    const name = window.prompt('导出文件名', 'zterm-workspace')?.trim() || 'zterm-workspace';
                    exportWorkspaceProfile(name, workspace);
                    setProfileMenuOpen(false);
                  }}
                >
                  Export current workspace
                </button>
                {profiles.length > 0 ? <div className="shell-profile-menu-divider" /> : null}
                {profiles.length > 0 ? (
                  profiles.map((profile) => (
                    <button
                      className="shell-profile-menu-item profile"
                      key={profile.id}
                      type="button"
                      onClick={() => {
                        setWorkspace(normalizeWorkspaceState(profile.workspace));
                        setProfileMenuOpen(false);
                      }}
                    >
                      <span>{profile.name}</span>
                      <span>{formatProfileTime(profile.updatedAt)}</span>
                    </button>
                  ))
                ) : (
                  <div className="shell-profile-menu-empty">还没有保存的 profile</div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="shell-stage" ref={stageRef}>
        {workspace.panes.map((pane, paneIndex) => {
          const paneTarget = resolveTabTarget(
            pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null,
            hosts,
          );
          const paneLocalSessionName = resolveLocalSessionName(
            pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? null,
          );
          const paneActiveTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0] ?? createEmptyWorkspaceTab();
          const paneRuntimeResourceKey = resolveRuntimeResourceKey(paneActiveTab, hosts);
          const paneRuntime = paneRuntimeResourceKey ? getRuntimeForResource(paneRuntimeResourceKey) : null;

          return (
            <Fragment key={pane.id}>
              <div className={`shell-pane ${pane.id === workspace.activePaneId ? 'active' : ''}`} style={{ flexGrow: pane.size, flexBasis: 0 }}>
                <div className="shell-pane-tabs">
                  <div className="shell-pane-tablist">
                    {pane.tabs.map((tab) => {
                      const tabRuntimeResourceKey = resolveRuntimeResourceKey(tab, hosts);
                      const tabRuntime = tabRuntimeResourceKey ? getRuntimeForResource(tabRuntimeResourceKey) : null;
                      return (
                        <div
                          className={`shell-pane-tab ${pane.activeTabId === tab.id ? 'active' : ''}`}
                          key={tab.id}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setTabContextMenu({ paneId: pane.id, tabId: tab.id, x: e.clientX, y: e.clientY });
                          }}
                        >
                          <button type="button" onClick={() => setActivePaneTab(pane.id, tab.id)}>
                            <PaneTabStatus tab={tab} runtime={tabRuntime} />
                            <span>{tab.kind === 'empty' ? '+' : tab.title}</span>
                          </button>
                          {pane.tabs.length > 1 || tab.kind !== 'empty' ? (
                            <button
                              className="shell-pane-tab-close"
                              type="button"
                              onClick={() => closeTab(pane.id, tab.id)}
                              aria-label={`Close ${tab.title}`}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  <div className="shell-pane-actions">
                    <button className="shell-pane-icon-button" type="button" onClick={() => createEmptyTabInPane(pane.id)}>
                      +
                    </button>
                    <button className="shell-pane-icon-button" type="button" onClick={() => setConnectionPicker({ paneId: pane.id, mode: 'append-tab' })}>
                      ⌁
                    </button>
                    {workspace.panes.length > 1 ? (
                      <button className="shell-pane-icon-button" type="button" onClick={() => closePane(pane.id)}>
                        −
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="shell-pane-body" onClick={() => setWorkspace((current) => ({ ...current, activePaneId: pane.id }))}>
                  <PaneSurface
                    tab={paneActiveTab}
                    target={paneTarget}
                    localSessionName={paneLocalSessionName}
                    runtime={paneRuntime}
                    isVisible
                    isInputFocused={pane.id === workspace.activePaneId}
                    onOpenConnection={() => setConnectionPicker({ paneId: pane.id, mode: 'replace-active' })}
                    terminalThemeId={bridgeSettings.terminalThemeId}
                    showAbsoluteLineNumbers={absoluteLineNumbersVisible}
                  />
                </div>
              </div>

              {paneIndex < workspace.panes.length - 1 ? (
                <div
                  className="shell-pane-divider"
                  onPointerDown={(event) => handleDividerPointerDown(paneIndex, event.clientX)}
                  role="separator"
                  aria-orientation="vertical"
                >
                  <span />
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>

      {connectionPicker ? (
        <div className="shell-overlay-backdrop" onClick={() => setConnectionPicker(null)}>
          <QuickConnectSheet
            bridgeSettings={bridgeSettings}
            hosts={hosts}
            onClose={() => setConnectionPicker(null)}
            onOpenRemoteSessions={handleOpenRemoteSessions}
            onOpenLocalTmuxSessions={handleOpenLocalTmuxSessions}
            onOpenAdvanced={() => {
              setConnectionEditor({ paneId: connectionPicker.paneId, mode: connectionPicker.mode });
              setConnectionPicker(null);
            }}
          />
        </div>
      ) : null}

      {connectionEditor ? (
        <div className="shell-overlay-backdrop" onClick={() => setConnectionEditor(null)}>
          <div className="shell-overlay-card connection-editor" onClick={(event) => event.stopPropagation()}>
            <DetailsSlot
              host={connectionEditor.hostId ? hosts.find((host) => host.id === connectionEditor.hostId) : undefined}
              bridgeSettings={bridgeSettings}
              bridgeRuntime={activeBridgeRuntime}
              isEditing
              onSave={handleSaveConnection}
              onCancel={() => setConnectionEditor(null)}
              onConnectRequested={handleSaveConnection}
            />
          </div>
        </div>
      ) : null}

      {quickPaletteOpen ? (
        <div className="shell-overlay-backdrop palette" onClick={() => setQuickPaletteOpen(false)}>
          <div className="shell-overlay-card quick-palette" onClick={(event) => event.stopPropagation()}>
            <div className="shell-overlay-header compact">
              <div className="shell-quick-tabs">
                <button
                  className={quickPaletteTab === 'shortcuts' ? 'active' : ''}
                  type="button"
                  onClick={() => setQuickPaletteTab('shortcuts')}
                >
                  快捷输入
                </button>
                <button
                  className={quickPaletteTab === 'clipboard' ? 'active' : ''}
                  type="button"
                  onClick={() => setQuickPaletteTab('clipboard')}
                >
                  剪贴板
                </button>
              </div>
              <input
                className="shell-search-input"
                value={quickPaletteQuery}
                onChange={(event) => setQuickPaletteQuery(event.target.value)}
                placeholder="搜索命令或剪贴板内容"
                autoFocus
              />
            </div>

            <div className="shell-quick-list">
              {quickPaletteItems.length > 0 ? (
                quickPaletteItems.map((item) => (
                  <button className="shell-quick-item" key={item.id} type="button" onClick={() => void applyQuickPaletteItem(item)}>
                    <strong>{item.title}</strong>
                    <span>{item.subtitle}</span>
                  </button>
                ))
              ) : (
                <div className="shell-quick-empty">
                  {quickPaletteTab === 'clipboard'
                    ? clipboardError || '剪贴板当前没有可展示的多行内容。'
                    : '没有匹配的快捷输入。'}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {activeTab?.kind === 'connection' && activeTarget && activeRuntime ? (
        <SessionScheduleModal
          open={scheduleModalOpen}
          sessionName={getResolvedSessionName(activeTarget)}
          scheduleState={activeRuntimeState.schedule}
          onClose={() => setScheduleModalOpen(false)}
          onRefresh={() => activeRuntime.requestScheduleList(getResolvedSessionName(activeTarget))}
          onSave={(job) => activeRuntime.upsertScheduleJob(job)}
          onDelete={(jobId) => activeRuntime.deleteScheduleJob(jobId)}
          onToggle={(jobId, enabled) => activeRuntime.toggleScheduleJob(jobId, enabled)}
          onRunNow={(jobId) => activeRuntime.runScheduleJobNow(jobId)}
        />
      ) : null}
      <RemoteScreenshotSheet
        state={remoteScreenshotPreview}
        onSave={handleSaveRemoteScreenshot}
        onDiscard={() => {
          revokeRemoteScreenshotPreviewUrl();
          setRemoteScreenshotPreview(null);
        }}
      />
      <FileTransferSheet
        open={fileTransferOpen}
        remoteCwd={activeTarget?.sessionName || ''}
        onClose={() => setFileTransferOpen(false)}
        sendJson={(msg) => fileTransferSendJsonRef.current(msg)}
        onFileTransferMessage={fileTransferOnMessageRef.current}
      />
      {tabContextMenu ? (
        <div
          className="shell-context-backdrop"
          onClick={() => setTabContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setTabContextMenu(null); }}
        >
          <div
            className="shell-context-menu"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shell-context-label">Move to pane</div>
            {workspace.panes.map((targetPane, index) => (
              <button
                key={targetPane.id}
                className="shell-context-item"
                type="button"
                disabled={targetPane.id === tabContextMenu.paneId}
                onClick={() => {
                  moveTabToPane(tabContextMenu.paneId, tabContextMenu.tabId, targetPane.id);
                  setTabContextMenu(null);
                }}
              >
                Pane {index + 1}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
