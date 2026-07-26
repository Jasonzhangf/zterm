import { memo as ReactMemo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from '@capacitor/keyboard';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import { createSessionViewportModeStore } from '../lib/session-viewport-mode-store';
import { SessionScheduleSheet } from '../components/terminal/SessionScheduleSheet';
import { FileTransferSheet } from '../components/terminal/FileTransferSheet';
import { RemoteScreenshotSheet } from '../components/terminal/RemoteScreenshotSheet';
import {
  RemoteWindowOverlay,
  type RemoteWindowInputContext,
  type RemoteWindowVideoDebugSnapshot,
} from '../components/terminal/RemoteWindowOverlay';
import { TerminalHeader } from '../components/terminal/TerminalHeader';
import { TerminalSessionDrawer, type TerminalSessionDrawerHost, type TerminalSessionDrawerItem } from '../components/terminal/TerminalSessionDrawer';
import { TabManagerSheet } from '../components/terminal/TabManagerSheet';
import { TerminalQuickBar } from '../components/terminal/TerminalQuickBar';
import {
  resolveTerminalCtrlChord,
  resolveTerminalKeyboardInput,
} from '@zterm/shared/terminal/renderer';
import { TerminalPageCopyMenu } from './TerminalPageCopyMenu';
import { TerminalDebugOverlay, type RemoteWindowInputDebugSnapshot } from './TerminalPageDebugOverlay';
import { TerminalNetworkBanner, TerminalQuickBarShell } from './terminal-page-shell-ui';
import { formatDebugRate, resolveDebugStatus } from './terminal-page-debug-helpers';
import { useTerminalPageCopyRuntime } from './useTerminalPageCopyRuntime';
import { getBrowserStorage } from '../lib/browser-storage';
import { mobileTheme } from '../lib/mobile-ui';
import { isPrivateLanIpv4Host, parseEndpointHost } from '../lib/network-target';
import { buildServerIdentityAliasMap, resolveServerIdentity, type ServerIdentityInput } from '../lib/server-identity';
import { getRelayRtcEndpointCandidates } from '../lib/session-picker';
import { buildSessionSemanticOwnerKey, buildSessionSemanticReuseKey } from '../lib/session-semantic-identity';
import { listOnlineTraversalRelayDaemonDevices } from '../lib/traversal-relay-devices';
import { resolveSessionRemoteMissing } from '../lib/terminal-drawer-remote-missing';
import { ImeAnchor } from '../plugins/ImeAnchorPlugin';
import { registerClientDebugSnapshotSource } from '../lib/client-debug-snapshot';
import { runtimeDebug } from '../lib/runtime-debug';
import { DebugInput, isDebugInputSupported } from '../plugins/DebugInputPlugin';
import { useTerminalWorkspace } from '../hooks/useTerminalWorkspace';
import { normalizeTerminalCommittedText } from '../lib/terminal-input-normalization';
import {
  buildRemoteWindowBackspaceInputEvents,
  buildRemoteWindowKeyInputEventsFromSequence,
  buildRemoteWindowKeyboardInputEvents,
  buildRemoteWindowTextInputEvents,
} from '../lib/remote-window-input-mapping';
import {
  resolveTerminalLayoutProfile,
  resolveTerminalSessionGroupLayoutAxis,
  type TerminalSessionGroupLayoutMode,
} from '../lib/terminal-layout-profile';
import { resolveTerminalOrientation } from '../lib/terminal-viewport-metrics';
import {
  isKeyboardViewportAlreadyResized,
  resolveCurrentLayoutViewportHeight,
  resolveTerminalBottomChromeLiftPx,
  resolveKeyboardLiftPx,
  resolveLayoutViewportHeight,
  resolveTerminalHeaderTopInsetPx,
  resolveWindowWidth,
} from './terminal-keyboard-lift';
import {
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportProjection,
  type TerminalSessionGroupSlotIds,
  type TerminalSessionGroupSlotName,
} from '../lib/session-group-viewport';
import { TerminalStageShell } from './TerminalPageStageShell';
import {
  appendSessionPreviewTarget,
  moveSessionPreviewTarget,
  projectSessionPreviewLiveIds,
  pruneSessionPreviewSelectionToOpenSessions,
  readSessionPreviewSelection,
  removeSessionPreviewTarget,
  replaceSessionPreviewTarget,
  resolveSessionPreviewTargets,
  toggleSessionPreviewTarget,
  writeSessionPreviewSelection,
  type SessionPreviewSelectionV1,
  type SessionPreviewTarget,
} from '../lib/session-preview-selection';
export {
  resolveTerminalSessionGroupSlotReplacement,
  resolveTerminalSessionGroupViewportSlots,
  resolveTerminalSessionGroupViewportProjection,
} from '../lib/session-group-viewport';
import {
  createRemoteScreenshotPreviewRuntime,
  persistRemoteScreenshotCaptureRuntime,
  resolveRemoteScreenshotQuickBarStatus,
  type RemoteScreenshotPreviewState,
} from '../lib/remote-screenshot-preview-runtime';
import {
  DEFAULT_BRIDGE_PORT,
  type AndroidWorkspacePane,
  type QuickAction,
  type Host,
  type RemoteScreenshotCapture,
  type RemoteScreenshotRequestPayload,
  type RemoteScreenshotStatusPayload,
  type PasteImageStartPayload,
  type RemoteWindowInputEventPayload,
  type RemoteWindowStreamQualityRequestPayload,
  type RemoteWindowStreamTargetManifest,
  type RemoteWindowStreamTargetsResponsePayload,
  type RemoteWindowVideoBitrateConfig,
  type Session,
  type SessionDebugOverlayMetrics,
  type SessionGroupHistory,
  type SessionScheduleState,
  type ScheduleJobDraft,
  type TerminalResizeHandler,
  type TerminalShortcutAction,
  type TerminalViewportChangeHandler,
  type TerminalWidthMode,
  type TraversalRelayDeviceSnapshot,
} from '../lib/types';
import type { RemoteWindowReceiverStartResult } from '../lib/remote-window-receiver-runtime';
import type { RemoteWindowControlMessage } from '../lib/remote-window-message-runtime';

export { TerminalNetworkBanner } from './terminal-page-shell-ui';

type DrawerRemoteSessionTarget = {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  daemonHostId?: string;
  relayHostId?: string;
  authToken?: string;
  relayEndpointCandidates?: SessionGroupHistory['relayEndpointCandidates'];
  transportMode?: Host['transportMode'];
  sessionNames: string[];
};

type RemoteWindowInputDebugSource =
  | 'overlay'
  | 'quickbar-sequence'
  | 'quickbar-draft'
  | 'ime-input'
  | 'ime-backspace'
  | 'ime-key'
  | 'debug-input';

type RemoteWindowInputDebugEvent = {
  source: RemoteWindowInputDebugSource;
  sent: boolean;
  sessionId: string | null;
  streamId: string | null;
  targetId: string | null;
  event: RemoteWindowInputEventPayload['event'];
};

function createRemoteWindowInputDebugCounts(): RemoteWindowInputDebugSnapshot['counts'] {
  return {
    focus: 0,
    pointerDown: 0,
    pointerMove: 0,
    pointerUp: 0,
    click: 0,
    scroll: 0,
    key: 0,
    text: 0,
    accepted: 0,
    error: 0,
  };
}

function createRemoteWindowInputDebugSnapshot(): RemoteWindowInputDebugSnapshot {
  return {
    contextActive: false,
    contextLabel: '-',
    sessionId: '-',
    streamId: '-',
    targetId: '-',
    inputRoute: '-',
    focusPolicy: '-',
    lastSource: '-',
    lastEvent: '-',
    lastSent: null,
    lastAt: null,
    lastPoint: '-',
    lastResult: '-',
    lastResultAt: null,
    counts: createRemoteWindowInputDebugCounts(),
    video: '-',
  };
}

function abbreviateRemoteWindowDebugId(value?: string | null) {
  if (!value) {
    return '-';
  }
  if (value.length <= 20) {
    return value;
  }
  return `${value.slice(0, 7)}...${value.slice(-8)}`;
}

function formatRemoteWindowInputDebugEvent(event: RemoteWindowInputEventPayload['event']) {
  switch (event.kind) {
    case 'focus':
      return 'focus';
    case 'pointer':
      return `ptr:${event.phase} #${event.pointerId} b${event.buttons}`;
    case 'click':
      return `click #${event.pointerId} ${event.button}`;
    case 'scroll':
      return `scroll ${Math.round(event.deltaX)},${Math.round(event.deltaY)}`;
    case 'gesture':
      return `gesture:${event.gesture}/${event.phase}`;
    case 'window-resize':
      return `resize ${Math.round(event.width)}x${Math.round(event.height)}`;
    case 'key': {
      const keyLabel = event.text
        ? `text:${event.text.length}`
        : `key:${event.key || event.code || '-'}`;
      return `${keyLabel}/${event.phase}`;
    }
    default:
      return 'unknown';
  }
}

function formatRemoteWindowInputDebugPoint(event: RemoteWindowInputEventPayload['event']) {
  if (event.kind === 'pointer' || event.kind === 'scroll' || event.kind === 'click') {
    return `${Math.round(event.x)},${Math.round(event.y)} n=${event.normalizedX.toFixed(2)},${event.normalizedY.toFixed(2)}`;
  }
  if (event.kind === 'gesture') {
    return `${Math.round(event.startX)},${Math.round(event.startY)} -> ${Math.round(event.x)},${Math.round(event.y)}`;
  }
  if (event.kind === 'window-resize') {
    return `${Math.round(event.width)}x${Math.round(event.height)}`;
  }
  return '-';
}

function formatRemoteWindowInputDebugAge(lastAt: number | null) {
  if (!lastAt) {
    return '-';
  }
  const ageMs = Math.max(0, Date.now() - lastAt);
  if (ageMs < 1000) {
    return `${Math.round(ageMs)}ms`;
  }
  return `${Math.round(ageMs / 1000)}s`;
}

function truncateRemoteWindowInputResult(value: string) {
  if (value.length <= 44) {
    return value;
  }
  return `${value.slice(0, 41)}...`;
}

function formatRemoteWindowVideoDebug(snapshot: RemoteWindowVideoDebugSnapshot) {
  const age = formatRemoteWindowInputDebugAge(snapshot.updatedAt);
  const error = snapshot.lastError && snapshot.lastError !== '-'
    ? ` err:${truncateRemoteWindowInputResult(snapshot.lastError)}`
    : '';
  return [
    `a${snapshot.attached ? 'Y' : 'N'}`,
    `v${snapshot.visible ? 'Y' : 'N'}`,
    `r${snapshot.readyState}`,
    `p${snapshot.paused ? 'Y' : 'N'}`,
    `${snapshot.videoWidth}x${snapshot.videoHeight}`,
    `try${snapshot.playAttempts}`,
    `ok${snapshot.playAccepted}`,
    `rej${snapshot.playRejected}`,
    snapshot.lastEvent,
    age,
  ].join(' · ') + error;
}

function incrementRemoteWindowInputDebugCounts(
  counts: RemoteWindowInputDebugSnapshot['counts'],
  event: RemoteWindowInputEventPayload['event'],
): RemoteWindowInputDebugSnapshot['counts'] {
  const next = { ...counts };
  if (event.kind === 'focus') {
    next.focus += 1;
  } else if (event.kind === 'pointer') {
    if (event.phase === 'down') {
      next.pointerDown += 1;
    } else if (event.phase === 'move') {
      next.pointerMove += 1;
    } else {
      next.pointerUp += 1;
    }
  } else if (event.kind === 'scroll') {
    next.scroll += 1;
  } else if (event.kind === 'click') {
    next.click += 1;
  } else if (event.kind === 'key') {
    next.key += 1;
    if (event.text) {
      next.text += 1;
    }
  }
  return next;
}

function projectRemoteWindowInputDebugContext(
  context: RemoteWindowInputContext | null,
): Pick<RemoteWindowInputDebugSnapshot, 'contextActive' | 'contextLabel' | 'sessionId' | 'streamId' | 'targetId' | 'inputRoute' | 'focusPolicy'> {
  if (!context) {
    return {
      contextActive: false,
      contextLabel: '-',
      sessionId: '-',
      streamId: '-',
      targetId: '-',
      inputRoute: '-',
      focusPolicy: '-',
    };
  }
  return {
    contextActive: true,
    contextLabel: `${context.targetKind}/${context.inputTargetKind}`,
    sessionId: abbreviateRemoteWindowDebugId(context.sessionId),
    streamId: abbreviateRemoteWindowDebugId(context.streamId),
    targetId: abbreviateRemoteWindowDebugId(context.targetId),
    inputRoute: context.inputRoute,
    focusPolicy: context.focusPolicy,
  };
}

type VirtualKeyboardApi = {
  overlaysContent: boolean;
  boundingRect: DOMRectReadOnly;
  addEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: 'geometrychange', listener: EventListenerOrEventListenerObject) => void;
};

const NETWORK_BANNER_GRACE_MS = 3000;

function logAsyncCleanupFailure(scope: string, error: unknown) {
  console.warn(`[TerminalPage] ${scope} failed:`, error);
}

const connectionRouteOptionStyle = {
  minHeight: '34px',
  borderRadius: '10px',
  border: '1px solid rgba(151, 164, 186, 0.16)',
  background: 'rgba(28, 39, 59, 0.9)',
  color: '#dce8ff',
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
}: {
  session: Session | null;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  topInsetPx: number;
  onForceRelaySession?: (id: string) => void;
  onUseAutoSession?: (id: string) => void;
  onUseWebSocketSession?: (id: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [routeMenuOpen, setRouteMenuOpen] = useState(false);

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
  const status = resolveDebugStatus(session, metrics || undefined);
  const statusTone = status === 'error' || status === 'closed'
    ? '#ff8a8a'
    : status === 'reconnecting' || status === 'connecting'
      ? '#ffd27a'
      : '#8ce6b5';

  return (
    <div
      data-testid="terminal-connection-status-strip"
      aria-label={`连接状态 ${routeLabel} 上行 ${formatDebugRate(uplinkBps)} 下行 ${formatDebugRate(downlinkBps)}`}
      role="button"
      tabIndex={0}
      onClick={() => setRouteMenuOpen((current) => !current)}
      style={{
        position: 'absolute',
        top: `${Math.max(8, topInsetPx + 8)}px`,
        left: '56px',
        right: '84px',
        zIndex: 15,
        height: '34px',
        minWidth: 0,
        borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(10, 16, 26, 0.58)',
        color: '#dce8ff',
        boxShadow: '0 8px 18px rgba(0,0,0,0.14)',
        backdropFilter: 'blur(8px)',
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
        data-testid="terminal-connection-status-route"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          minWidth: 0,
          flex: '1 1 auto',
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
            boxShadow: `0 0 10px ${statusTone}`,
            flex: '0 0 auto',
          }}
        />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{routeLabel}</span>
      </span>
      <span
        data-testid="terminal-connection-status-rates"
        style={{
          flex: '0 0 auto',
          color: 'rgba(220,232,255,0.74)',
          fontSize: '10px',
          fontWeight: 750,
        }}
      >
        ↑ {formatDebugRate(uplinkBps)} ↓ {formatDebugRate(downlinkBps)}
      </span>
      {routeMenuOpen ? (
        <div
          data-testid="terminal-connection-route-menu"
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
            border: '1px solid rgba(151, 164, 186, 0.22)',
            background: 'rgba(13, 19, 31, 0.97)',
            boxShadow: '0 18px 42px rgba(0,0,0,0.38)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            data-testid="terminal-route-option-auto"
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
            data-testid="terminal-route-option-websocket"
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
            data-testid="terminal-route-option-webrtc"
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
  );
});

export {
  resolveTerminalBottomChromeLiftPx,
  resolveKeyboardLiftPx,
  resolveLayoutViewportHeight,
  resolveTerminalHeaderTopInsetPx,
};

interface TerminalPageProps {
  appForegroundActive?: boolean;
  sessions: Session[];
  sessionGroups?: SessionGroupHistory[];
  activeSession: Session | null;
  getSessionDebugMetrics?: (sessionId: string) => SessionDebugOverlayMetrics | null;
  sessionBufferStore?: SessionRenderBufferStore | null;
  inputResetEpochBySession?: Record<string, number>;
  followResetEpoch?: number;
  onSwitchSession: (id: string) => void;
  onMoveSession: (id: string, toIndex: number) => void;
  onRenameSession: (id: string, name: string) => void;
  onCloseSession: (id: string, source?: string) => void;
  onForceRelaySession?: (id: string) => void;
  onUseAutoSession?: (id: string) => void;
  onUseWebSocketSession?: (id: string) => void;
  onOpenConnections: () => void;
  onOpenQuickTabPicker: (paneId?: string, hostKey?: string, createOptions?: { sessionName?: string; cwd?: string }) => void;
  onOpenDrawerRemoteSession?: (target: DrawerRemoteSessionTarget, sessionName: string, options?: { activate?: boolean; navigate?: boolean }) => string | null | undefined | void;
  onCloseDrawerRemoteSession?: (target: DrawerRemoteSessionTarget, sessionName: string) => void | Promise<void>;
  onRefreshDrawerHostSessions?: (hostKey?: string) => void | Promise<void>;
  relayDevices?: TraversalRelayDeviceSnapshot[];
  serverIdentityAliasInputs?: ServerIdentityInput[];
  sessionPickerDebugMode?: string | null;
  pendingPaneAttachIntent?: { sessionIds: string[]; paneId: string; nonce: number } | null;
  onPaneAttachIntentApplied?: (intent: { sessionIds: string[]; paneId: string; nonce: number }) => void;
  onResize?: TerminalResizeHandler;
  onTerminalInput?: (sessionId: string, data: string) => void;
  onTerminalViewportChange?: TerminalViewportChangeHandler;
  onLiveSessionIdsChange?: (ids: string[]) => void;
  onActiveBodySubscriptionSuppressedChange?: (suppressed: boolean) => void;
  onImagePaste?: (
    sessionId: string,
    file: File,
    options?: { pasteTarget?: PasteImageStartPayload['pasteTarget'] },
  ) => Promise<void> | void;
  onFileAttach?: (sessionId: string, file: File) => Promise<void> | void;
  onOpenSettings?: () => void;
  onRequestRemoteScreenshot?: (
    sessionId: string,
    onProgress?: (progress: RemoteScreenshotStatusPayload) => void,
    request?: Omit<RemoteScreenshotRequestPayload, 'requestId'>,
  ) => Promise<RemoteScreenshotCapture>;
  onRequestRemoteWindowTargets?: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<RemoteWindowStreamTargetsResponsePayload>;
  onRequestRemoteWindowStreamStart?: (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    streamId: string,
    options?: { videoBitrate?: RemoteWindowVideoBitrateConfig },
  ) => Promise<RemoteWindowReceiverStartResult>;
  onUpdateRemoteWindowStreamQuality?: (
    sessionId: string,
    payload: Omit<RemoteWindowStreamQualityRequestPayload, 'requestId'>,
  ) => void;
  onStopRemoteWindowStream?: (sessionId: string, streamId: string) => boolean;
  onSendRemoteWindowInput?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  onResizeRemoteWindowTarget?: (
    sessionId: string,
    payload: Omit<RemoteWindowInputEventPayload, 'requestId'>,
  ) => void;
  onRemoteWindowMessage?: (handler: (msg: RemoteWindowControlMessage) => void) => () => void;
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onQuickActionInput?: (sequence: string, sessionId?: string) => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange?: (value: string, sessionId?: string) => void;
  onSessionDraftSend?: (value: string, sessionId?: string) => void;
  scheduleState?: SessionScheduleState | null;
  getScheduleState?: (sessionId: string) => SessionScheduleState;
  onRequestScheduleList?: (sessionId: string) => void;
  onUpsertScheduleJob?: (sessionId: string, job: ScheduleJobDraft) => void;
  onDeleteScheduleJob?: (sessionId: string, jobId: string) => void;
  onToggleScheduleJob?: (sessionId: string, jobId: string, enabled: boolean) => void;
  onRunScheduleJobNow?: (sessionId: string, jobId: string) => void;
  terminalThemeId?: string;
  terminalWidthMode?: TerminalWidthMode;
  terminalSessionGroupLayoutMode?: TerminalSessionGroupLayoutMode;
  onTerminalWidthModeChange?: (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
  onSendMessage?: (sessionId: string, msg: any) => void;
  onFileTransferMessage?: (handler: (msg: any) => void) => () => void;
  shortcutSmartSort?: boolean;
  shortcutFrequencyMap?: Record<string, number>;
  onShortcutUse?: (shortcutId: string) => void;
}

interface ScheduleComposerTarget {
  sessionId: string;
  sessionName: string;
  nonce: number;
  seedText: string;
}

interface TerminalTabChromeItem {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  customName?: string;
  resolvedPath?: Session['resolvedPath'];
  resolvedRelayTransport?: Session['resolvedRelayTransport'];
}

function normalizeDrawerStatus(state: Session['state'] | undefined): TerminalSessionDrawerItem['status'] {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'closed':
      return 'closed';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function terminalPageHeaderSessionUiKey(session: Session | null | undefined) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.bridgeHost,
    String(session.bridgePort),
    session.sessionName,
    session.customName || '',
    session.resolvedPath || '',
    session.resolvedRelayTransport || '',
    session.selectedIcePair?.local?.candidateType || '',
    session.selectedIcePair?.local?.address || '',
    String(session.selectedIcePair?.local?.port || ''),
    session.selectedIcePair?.remote?.candidateType || '',
    session.selectedIcePair?.remote?.address || '',
    String(session.selectedIcePair?.remote?.port || ''),
  ].join('::');
}

function terminalPageHeaderSessionsUiKey(sessions: Session[]) {
  return sessions.map((session) => terminalPageHeaderSessionUiKey(session)).join('||');
}

function terminalPageActiveRuntimeStatusKey(session: Session | null | undefined) {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.state,
    session.lastError || '',
  ].join('::');
}

function resolveRelayDeviceEndpointAliasInput(
  device: TraversalRelayDeviceSnapshot,
  endpoint: NonNullable<TraversalRelayDeviceSnapshot['daemon']['endpoints']>[number],
) {
  if (endpoint.kind !== 'tailscale' && endpoint.kind !== 'ipv6' && endpoint.kind !== 'ipv4') {
    return null;
  }
  const daemonHostId = device.daemon.hostId.trim();
  if (!daemonHostId) {
    return null;
  }
  const directHost = endpoint.host?.trim();
  if (directHost) {
    return {
      bridgeHost: directHost,
      bridgePort: endpoint.port || DEFAULT_BRIDGE_PORT,
      daemonHostId,
      connectionName: device.deviceName,
    };
  }
  const wsUrl = endpoint.wsUrl?.trim();
  if (!wsUrl) {
    return null;
  }
  try {
    const parsed = new URL(wsUrl);
    return {
      bridgeHost: parsed.hostname || parsed.host,
      bridgePort: endpoint.port || (parsed.port ? Number.parseInt(parsed.port, 10) : DEFAULT_BRIDGE_PORT),
      daemonHostId,
      connectionName: device.deviceName,
    };
  } catch {
    return null;
  }
}

function buildRelayDeviceServerIdentityAliasInputs(relayDevices: TraversalRelayDeviceSnapshot[]) {
  return relayDevices.flatMap((device) =>
    (device.daemon.endpoints || [])
      .map((endpoint) => resolveRelayDeviceEndpointAliasInput(device, endpoint))
      .filter((item): item is { bridgeHost: string; bridgePort: number; daemonHostId: string; connectionName: string } => item !== null),
  );
}

function buildRelayDeviceSessionCatalogAliasInputs(
  relayDevices: TraversalRelayDeviceSnapshot[],
  sessionGroups: SessionGroupHistory[],
): ServerIdentityInput[] {
  const relayCatalogs = relayDevices
    .map((device) => ({
      device,
      daemonHostId: device.daemon.hostId.trim(),
      sessionNames: new Set((device.daemon.sessions || [])
        .map((session) => session.name?.trim())
        .filter((name): name is string => Boolean(name))),
    }))
    .filter((catalog) => catalog.daemonHostId && catalog.sessionNames.size > 0);

  const aliases: ServerIdentityInput[] = [];
  for (const group of sessionGroups) {
    const bridgeHost = group.bridgeHost?.trim();
    if (!bridgeHost || group.daemonHostId?.trim()) {
      continue;
    }
    const missing = new Set((group.missingSessionNames || []).map((name) => name.trim()).filter(Boolean));
    const groupSessionNames = group.sessionNames
      .map((name) => name.trim())
      .filter((name) => name && !missing.has(name));
    if (groupSessionNames.length === 0) {
      continue;
    }
    const matches = relayCatalogs.filter((catalog) =>
      groupSessionNames.every((name) => catalog.sessionNames.has(name)),
    );
    if (matches.length !== 1) {
      continue;
    }
    const match = matches[0];
    aliases.push({
      bridgeHost,
      bridgePort: group.bridgePort || DEFAULT_BRIDGE_PORT,
      daemonHostId: match.daemonHostId,
      connectionName: match.device.deviceName.trim() || match.daemonHostId,
    });
  }
  return aliases;
}

function buildRelayDeviceLiveSessionCatalogAliasInputs(
  relayDevices: TraversalRelayDeviceSnapshot[],
  sessions: Session[],
): ServerIdentityInput[] {
  const relayCatalogs = relayDevices
    .map((device) => ({
      device,
      daemonHostId: device.daemon.hostId.trim(),
      sessionNames: new Set((device.daemon.sessions || [])
        .map((session) => session.name?.trim())
        .filter((name): name is string => Boolean(name))),
    }))
    .filter((catalog) => catalog.daemonHostId && catalog.sessionNames.size > 0);

  const aliases: ServerIdentityInput[] = [];
  for (const session of sessions) {
    const bridgeHost = session.bridgeHost?.trim();
    if (!bridgeHost || session.daemonHostId?.trim()) {
      continue;
    }
    const sessionName = session.sessionName.trim();
    if (!sessionName) {
      continue;
    }
    const matches = relayCatalogs.filter((catalog) => catalog.sessionNames.has(sessionName));
    if (matches.length !== 1) {
      continue;
    }
    const match = matches[0];
    aliases.push({
      bridgeHost,
      bridgePort: session.bridgePort || DEFAULT_BRIDGE_PORT,
      daemonHostId: match.daemonHostId,
      connectionName: match.device.deviceName.trim() || match.daemonHostId,
    });
  }
  return aliases;
}

function terminalPageRelayDevicesUiKey(relayDevices: readonly TraversalRelayDeviceSnapshot[] | undefined) {
  return (relayDevices || []).map((device) => [
    device.deviceId,
    device.deviceName,
    device.daemon.hostId,
    device.daemon.connected ? '1' : '0',
    (device.daemon.endpoints || []).map((endpoint) => [
      endpoint.id,
      endpoint.kind,
      endpoint.host || '',
      endpoint.wsUrl || '',
      endpoint.relayHostId || '',
      String(endpoint.port || ''),
    ].join('~')).join(','),
    (device.daemon.sessions || []).map((session) => [
      session.name || '',
      session.updatedAt || '',
    ].join('~')).join(','),
  ].join('|')).join('||');
}

function terminalPageServerIdentityAliasInputsUiKey(inputs: readonly ServerIdentityInput[] | undefined) {
  return (inputs || []).map((input) => [
    input.bridgeHost || '',
    String(input.bridgePort || ''),
    input.daemonHostId || '',
    input.connectionName || '',
  ].join('|')).join('||');
}

function resolveSessionInputEpoch(
  inputResetEpochBySession: Record<string, number> | undefined,
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return -1;
  }
  return inputResetEpochBySession?.[sessionId] || 0;
}

function toTerminalTabChromeItem(session: Session): TerminalTabChromeItem {
  return {
    id: session.id,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
    resolvedRelayTransport: session.resolvedRelayTransport,
  };
}

function resolveTerminalSessionGroupSlotIds(options: {
  slots: TerminalSessionGroupSlotIds;
  sessions: Session[];
  centerSessionId: string | null;
}): TerminalSessionGroupSlotIds {
  const sessionIds = new Set(options.sessions.map((session) => session.id));
  const center = (
    options.slots.center && sessionIds.has(options.slots.center)
      ? options.slots.center
      : options.centerSessionId && sessionIds.has(options.centerSessionId)
        ? options.centerSessionId
        : null
  );
  const top = (
    options.slots.top && sessionIds.has(options.slots.top) && options.slots.top !== center
      ? options.slots.top
      : null
  );
  const bottom = (
    options.slots.bottom &&
      sessionIds.has(options.slots.bottom) &&
      options.slots.bottom !== center &&
      options.slots.bottom !== top
      ? options.slots.bottom
      : null
  );

  return { top, center, bottom };
}

function terminalSessionGroupSlotIdsEqual(
  left: TerminalSessionGroupSlotIds,
  right: TerminalSessionGroupSlotIds,
) {
  return left.top === right.top && left.center === right.center && left.bottom === right.bottom;
}

function resolveTerminalSessionGroupActiveSessionProjection(options: {
  slots: TerminalSessionGroupSlotIds;
  sessions: Session[];
  activeSessionId: string | null;
}): { slots: TerminalSessionGroupSlotIds; focusSlot: TerminalSessionGroupSlotName } | null {
  if (!options.activeSessionId) {
    return null;
  }
  const sessionIds = new Set(options.sessions.map((session) => session.id));
  if (!sessionIds.has(options.activeSessionId)) {
    return null;
  }
  const normalizedSlots = resolveTerminalSessionGroupSlotIds({
    slots: options.slots,
    sessions: options.sessions,
    centerSessionId: options.activeSessionId,
  });
  if (normalizedSlots.top === options.activeSessionId) {
    return { slots: normalizedSlots, focusSlot: 'top' };
  }
  if (normalizedSlots.center === options.activeSessionId) {
    return { slots: normalizedSlots, focusSlot: 'center' };
  }
  if (normalizedSlots.bottom === options.activeSessionId) {
    return { slots: normalizedSlots, focusSlot: 'bottom' };
  }
  return {
    slots: resolveTerminalSessionGroupSlotIds({
      slots: resolveTerminalSessionGroupSlotReplacement(normalizedSlots, options.activeSessionId, 'center'),
      sessions: options.sessions,
      centerSessionId: options.activeSessionId,
    }),
    focusSlot: 'center',
  };
}

function formatConnectionRouteLabel(session: Session) {
  switch (session.resolvedPath) {
    case 'rtc-direct':
      return 'UDP';
    case 'tailscale':
      return 'Tailscale';
    case 'ipv6':
      return 'IPv6';
    case 'ipv4': {
      const endpointHost = parseEndpointHost(session.resolvedEndpoint || session.bridgeHost);
      return isPrivateLanIpv4Host(endpointHost) ? '局域网' : 'IPv4';
    }
    case 'rtc-relay':
      return session.resolvedRelayTransport === 'turn' ? 'Relay/TURN' : 'Relay';
    default:
      return session.state === 'connected' ? '连接中' : '未连接';
  }
}

function TerminalPageComponent({
  appForegroundActive = true,
  sessions,
  sessionGroups = [],
  activeSession,
  getSessionDebugMetrics,
  sessionBufferStore = null,
  inputResetEpochBySession,
  followResetEpoch = 0,
  onSwitchSession,
  onMoveSession,
  onRenameSession,
  onCloseSession,
  onForceRelaySession,
  onUseAutoSession,
  onUseWebSocketSession,
  onOpenConnections,
  onOpenQuickTabPicker,
  onOpenDrawerRemoteSession,
  onCloseDrawerRemoteSession,
  onRefreshDrawerHostSessions,
  relayDevices = [],
  serverIdentityAliasInputs = [],
  sessionPickerDebugMode = null,
  pendingPaneAttachIntent = null,
  onPaneAttachIntentApplied,
  onResize,
  onTerminalInput,
  onTerminalViewportChange,
  onLiveSessionIdsChange,
  onActiveBodySubscriptionSuppressedChange,
  onImagePaste,
  onFileAttach,
  onOpenSettings,
  onRequestRemoteScreenshot,
  onRequestRemoteWindowTargets,
  onRequestRemoteWindowStreamStart,
  onUpdateRemoteWindowStreamQuality,
  onStopRemoteWindowStream,
  onSendRemoteWindowInput,
  onResizeRemoteWindowTarget,
  onRemoteWindowMessage,
  quickActions,
  shortcutActions,
  onQuickActionInput,
  onQuickActionsChange,
  onShortcutActionsChange,
  sessionDraft,
  onSessionDraftChange,
  onSessionDraftSend,
  scheduleState,
  getScheduleState,
  onRequestScheduleList,
  onUpsertScheduleJob,
  onDeleteScheduleJob,
  onToggleScheduleJob,
  onRunScheduleJobNow,
  terminalThemeId,
  terminalWidthMode = 'adaptive-phone',
  terminalSessionGroupLayoutMode = 'auto',
  onTerminalWidthModeChange,
  onSendMessage,
  onFileTransferMessage,
  shortcutSmartSort,
  shortcutFrequencyMap,
  onShortcutUse,
}: TerminalPageProps) {
  const isAndroid = Capacitor.getPlatform() === 'android';
  const [focusNonce, setFocusNonce] = useState(0);
  const [inputIntentFollowResetEpoch, setInputIntentFollowResetEpoch] = useState(0);
  const terminalFontSize = 10;
  const [terminalKeyboardRequested, setTerminalKeyboardRequested] = useState(false);
  const terminalKeyboardRequestedRef = useRef(false);
  const [androidImeVisible, setAndroidImeVisible] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [connectionIssueVisible, setConnectionIssueVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [quickBarHeight, setQuickBarHeight] = useState(0);
  const [quickBarCollapsed, setQuickBarCollapsed] = useState(false);
  const [quickBarEditorFocused, setQuickBarEditorFocused] = useState(false);
  const [remoteWindowOverlayOpen, setRemoteWindowOverlayOpen] = useState(false);
  const [remoteWindowInputContext, setRemoteWindowInputContext] = useState<RemoteWindowInputContext | null>(null);
  const [remoteWindowStreamInvalidation, setRemoteWindowStreamInvalidation] = useState<{
    streamId: string;
    message: string;
    nonce: number;
  } | null>(null);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const initialSessionPreviewRead = useMemo(() => {
    const storage = getBrowserStorage();
    return storage
      ? readSessionPreviewSelection(storage)
      : { status: 'empty' as const, selection: { version: 1 as const, orderedTargets: [] } };
  }, []);
  const [sessionPreviewSelection, setSessionPreviewSelection] = useState<SessionPreviewSelectionV1>(() =>
    initialSessionPreviewRead.status === 'invalid'
      ? { version: 1, orderedTargets: [] }
      : initialSessionPreviewRead.selection,
  );
  const [sessionPreviewSelectionMode, setSessionPreviewSelectionMode] = useState(false);
  const [sessionPreviewOpen, setSessionPreviewOpen] = useState(false);
  const [sessionPreviewError, setSessionPreviewError] = useState<string | null>(() =>
    initialSessionPreviewRead.status === 'invalid' ? '预览选择存储损坏，请重新选择。' : null,
  );
  const [sessionDrawerDebug, setSessionDrawerDebug] = useState({
    lastEvent: '-',
    eventSeq: 0,
    callbackSeq: 0,
    pageCallbackSeq: 0,
  });
  const [tabManagerOpen, setTabManagerOpen] = useState(false);
  const [tabManagerScopePaneId, setTabManagerScopePaneId] = useState<string | null>(null);
  const [scheduleComposerTarget, setScheduleComposerTarget] = useState<ScheduleComposerTarget | null>(null);
  const [fileTransferOpen, setFileTransferOpen] = useState(false);
  const [remoteScreenshotPreview, setRemoteScreenshotPreview] = useState<RemoteScreenshotPreviewState | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
  const [currentLayoutViewportHeight, setCurrentLayoutViewportHeight] = useState(
    () => resolveCurrentLayoutViewportHeight(),
  );
  const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() => resolveTerminalHeaderTopInsetPx(isAndroid));
  const viewportMetricsFrameRef = useRef<number | null>(null);
  const [debugOverlayVisible, setDebugOverlayVisible] = useState(false);
  const [absoluteLineNumbersVisible, setAbsoluteLineNumbersVisible] = useState(false);
  const [sessionGroupSlotIds, setSessionGroupSlotIds] = useState<TerminalSessionGroupSlotIds>(() => ({
    top: null,
    center: activeSession?.id || null,
    bottom: null,
  }));
  const [sessionGroupFocusSlot, setSessionGroupFocusSlot] = useState<TerminalSessionGroupSlotName>('center');
  const sessionPreviewEntryRef = useRef<{
    activeSessionId: string | null;
    slotIds: TerminalSessionGroupSlotIds;
    focusSlot: TerminalSessionGroupSlotName;
  } | null>(null);
  const landscape = typeof window !== 'undefined' ? resolveTerminalOrientation() === 'landscape' : false;
  const portraitSessionDrawerEnabled = !landscape;
  const sessionViewportModeStoreRef = useRef(createSessionViewportModeStore());
  const [debugOverlayPos, setDebugOverlayPos] = useState({ x: -1, y: -1 }); // -1 means use defaults
  const debugOverlayDragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; dragging: boolean }>({ startX: 0, startY: 0, startPosX: 0, startPosY: 0, dragging: false });
  const connectionIssueTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSession?.id || null);
  const quickBarEditorFocusedRef = useRef(quickBarEditorFocused);
  const androidImeVisibleRef = useRef(false);
  const terminalInputHandlerRef = useRef<typeof onTerminalInput>(onTerminalInput);
  const remoteWindowInputContextRef = useRef<RemoteWindowInputContext | null>(null);
  const remoteWindowInputDebugRef = useRef<RemoteWindowInputDebugSnapshot>(createRemoteWindowInputDebugSnapshot());
  const appliedPaneAttachIntentNonceRef = useRef<number | null>(null);
  const pendingAndroidImeFocusTimerRef = useRef<number | null>(null);
  const androidImeFocusRouteKeyRef = useRef<string | null>(null);
  const terminalFocusRetryTimeoutsRef = useRef<number[]>([]);
  const remoteScreenshotPreviewRuntimeRef = useRef(createRemoteScreenshotPreviewRuntime());
  const stableLayoutViewportHeightRef = useRef(resolveLayoutViewportHeight());


  const captureStableLayoutViewportHeight = useCallback(() => {
    if (!isAndroid) {
      return;
    }
    const layoutHeight = resolveLayoutViewportHeight();
    if (layoutHeight > 0) {
      // Keyboard popup race on some devices can report a post-shrink layout
      // height at the time keyboardState(visible=true) arrives. Never let that
      // transient value pull the stable anchor downward during IME-active flow.
      stableLayoutViewportHeightRef.current = Math.max(
        stableLayoutViewportHeightRef.current,
        layoutHeight,
      );
    }
  }, [isAndroid]);

  const sendFileTransferMessage = useCallback((msg: any) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !onSendMessage) {
      return;
    }
    onSendMessage(sessionId, msg);
  }, [onSendMessage]);

  useEffect(() => {
    terminalInputHandlerRef.current = onTerminalInput;
  }, [onTerminalInput]);

  useEffect(() => {
    quickBarEditorFocusedRef.current = quickBarEditorFocused;
  }, [quickBarEditorFocused]);

  useEffect(() => {
    remoteWindowInputContextRef.current = remoteWindowInputContext;
  }, [remoteWindowInputContext]);

  const recordRemoteWindowInputDebug = useCallback((debug: RemoteWindowInputDebugEvent) => {
    const context = remoteWindowInputContextRef.current;
    const contextProjection = projectRemoteWindowInputDebugContext(context);
    remoteWindowInputDebugRef.current = {
      ...remoteWindowInputDebugRef.current,
      ...contextProjection,
      sessionId: abbreviateRemoteWindowDebugId(debug.sessionId || context?.sessionId || null),
      streamId: abbreviateRemoteWindowDebugId(debug.streamId || context?.streamId || null),
      targetId: abbreviateRemoteWindowDebugId(debug.targetId || context?.targetId || null),
      lastSource: debug.source,
      lastEvent: formatRemoteWindowInputDebugEvent(debug.event),
      lastSent: debug.sent,
      lastAt: Date.now(),
      lastPoint: formatRemoteWindowInputDebugPoint(debug.event),
      counts: incrementRemoteWindowInputDebugCounts(remoteWindowInputDebugRef.current.counts, debug.event),
    };
  }, []);

  const recordRemoteWindowInputResultDebug = useCallback((msg: RemoteWindowControlMessage) => {
    const context = remoteWindowInputContextRef.current;
    const currentCounts = remoteWindowInputDebugRef.current.counts;
    if (msg.type === 'remote-window-input-result') {
      remoteWindowInputDebugRef.current = {
        ...remoteWindowInputDebugRef.current,
        ...projectRemoteWindowInputDebugContext(context),
        streamId: abbreviateRemoteWindowDebugId(msg.payload.streamId || context?.streamId || null),
        targetId: abbreviateRemoteWindowDebugId(msg.payload.targetId || context?.targetId || null),
        lastResult: `${msg.payload.accepted ? 'ACK' : 'NAK'} ${abbreviateRemoteWindowDebugId(msg.payload.requestId)}`,
        lastResultAt: Date.now(),
        counts: {
          ...currentCounts,
          accepted: currentCounts.accepted + (msg.payload.accepted ? 1 : 0),
          error: currentCounts.error + (msg.payload.accepted ? 0 : 1),
        },
      };
      return;
    }
    if (msg.type === 'remote-window-error' && msg.payload.code.startsWith('remote_window_input')) {
      if (msg.payload.code === 'remote_window_input_stream_missing' && msg.payload.streamId) {
        setRemoteWindowStreamInvalidation({
          streamId: msg.payload.streamId,
          message: msg.payload.message,
          nonce: Date.now(),
        });
      }
      remoteWindowInputDebugRef.current = {
        ...remoteWindowInputDebugRef.current,
        ...projectRemoteWindowInputDebugContext(context),
        streamId: abbreviateRemoteWindowDebugId(msg.payload.streamId || context?.streamId || null),
        lastResult: `ERR ${msg.payload.code} ${truncateRemoteWindowInputResult(msg.payload.message)}`,
        lastResultAt: Date.now(),
        counts: {
          ...currentCounts,
          error: currentCounts.error + 1,
        },
      };
    }
  }, []);

  const recordRemoteWindowVideoDebug = useCallback((snapshot: RemoteWindowVideoDebugSnapshot) => {
    remoteWindowInputDebugRef.current = {
      ...remoteWindowInputDebugRef.current,
      video: formatRemoteWindowVideoDebug(snapshot),
    };
  }, []);

  const getRemoteWindowInputDebug = useCallback(() => remoteWindowInputDebugRef.current, []);

  useEffect(() => {
    if (!onRemoteWindowMessage) {
      return undefined;
    }
    return onRemoteWindowMessage((msg) => {
      recordRemoteWindowInputResultDebug(msg);
    });
  }, [onRemoteWindowMessage, recordRemoteWindowInputResultDebug]);

  const rawShellHeight = resolveLayoutViewportHeight();
  const keyboardViewportAlreadyResized = isAndroid
    && keyboardInset > 0
    && isKeyboardViewportAlreadyResized(
      keyboardInset,
      stableLayoutViewportHeightRef.current,
    );
  const keyboardViewportFreezeActive = isAndroid
    && (terminalKeyboardRequested || keyboardInset > 0)
    && !keyboardViewportAlreadyResized;
  const shellHeight = keyboardViewportFreezeActive
    ? Math.max(rawShellHeight, stableLayoutViewportHeightRef.current)
    : Math.max(rawShellHeight, resolveCurrentLayoutViewportHeight());
  const sessionGroupLayoutAxis = resolveTerminalSessionGroupLayoutAxis({
    viewportWidth,
    viewportHeight: shellHeight,
    landscape,
    mode: terminalSessionGroupLayoutMode,
  });

  useEffect(() => {
    if (!isAndroid) {
      stableLayoutViewportHeightRef.current = rawShellHeight;
      return;
    }
    if (keyboardViewportFreezeActive) {
      return;
    }
    if (rawShellHeight > 0) {
      stableLayoutViewportHeightRef.current = rawShellHeight;
    }
  }, [isAndroid, keyboardViewportFreezeActive, rawShellHeight]);

  const updateTerminalKeyboardRequested = useCallback((next: boolean) => {
    terminalKeyboardRequestedRef.current = next;
    setTerminalKeyboardRequested((current) => (current === next ? current : next));
  }, []);

  const updateAndroidImeVisible = useCallback((next: boolean) => {
    androidImeVisibleRef.current = next;
    setAndroidImeVisible((current) => (current === next ? current : next));
  }, []);

  const updateKeyboardInset = useCallback((next: number) => {
    const safeNext = Math.max(0, Math.round(next || 0));
    setKeyboardInset((current) => (current === safeNext ? current : safeNext));
  }, []);

  const updateViewportMetrics = useCallback(() => {
    const nextWidth = resolveWindowWidth();
    const nextCurrentLayoutViewportHeight = resolveCurrentLayoutViewportHeight();
    const nextTopInset = resolveTerminalHeaderTopInsetPx(isAndroid);
    setViewportWidth((current) => (current === nextWidth ? current : nextWidth));
    setCurrentLayoutViewportHeight((current) => (
      current === nextCurrentLayoutViewportHeight ? current : nextCurrentLayoutViewportHeight
    ));
    setHeaderTopInsetPx((current) => (current === nextTopInset ? current : nextTopInset));
  }, [isAndroid]);

  const scheduleViewportMetricsSync = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (viewportMetricsFrameRef.current !== null) {
      return;
    }
    viewportMetricsFrameRef.current = window.requestAnimationFrame(() => {
      viewportMetricsFrameRef.current = null;
      updateViewportMetrics();
    });
  }, [updateViewportMetrics]);

  const querySessionInput = (sessionId: string | null | undefined) => {
    if (!sessionId || typeof document === 'undefined') {
      return null;
    }
    return document.querySelector(
      `textarea[data-wterm-input="true"][data-terminal-input-session-id="${sessionId}"]`,
    ) as HTMLTextAreaElement | null;
  };

  const {
    workspace,
    splitAvailable,
    splitVisible,
    activePaneSessionId,
    currentMaxSplitCount,
    findPaneForSession,
    getPaneSessionIds,
    setSplitCount,
    assignSessionToPane,
    attachSessionsToPane,
    setActivePane,
    switchTabInPane,
  } = useTerminalWorkspace({
    sessions,
    activeSessionId: activeSession?.id || null,
    viewportWidth,
    viewportHeight: shellHeight,
    maxSplitCount: 4,
  });
  const availableSplitCount = splitAvailable
    ? Math.max(1, Math.min(currentMaxSplitCount, sessions.length))
    : 1;
  const splitCountOptions = useMemo(
    () => (
      splitAvailable
        ? Array.from({ length: availableSplitCount }, (_, index) => index + 1)
        : []
    ),
    [availableSplitCount, splitAvailable],
  );
  const workspacePanes = splitVisible ? workspace.panes : workspace.panes.slice(0, 1);
  const paneGroups = workspacePanes.map((pane) => ({
    paneId: pane.id,
    size: pane.size,
    sessions: pane.tabs
      .map((tab) => sessions.find((session) => session.id === tab.sessionId) || null)
      .filter((session): session is Session => Boolean(session))
      .map(toTerminalTabChromeItem),
    activeSessionId: pane.tabs.find((tab) => tab.id === pane.activeTabId)?.sessionId || null,
    isActivePane: pane.id === workspace.activePaneId,
  }));
  const visiblePaneEntries = splitVisible
    ? workspacePanes
        .map((pane, paneIndex) => {
          const sessionId = pane.tabs.find((tab) => tab.id === pane.activeTabId)?.sessionId || null;
          if (!sessionId) {
            return null;
          }
          const session = sessions.find((candidate) => candidate.id === sessionId) || null;
          if (!session) {
            return null;
          }
          return { pane, paneIndex, session };
        })
        .filter((entry): entry is { pane: AndroidWorkspacePane; paneIndex: number; session: Session } => Boolean(entry))
    : [];
  const interactiveSessionId = splitVisible
    ? (paneGroups.find((group) => group.paneId === workspace.activePaneId)?.activeSessionId || activePaneSessionId)
    : (activeSession?.id || activePaneSessionId);
  const interactiveSession = interactiveSessionId
    ? sessions.find((session) => session.id === interactiveSessionId) || activeSession || null
    : activeSession || null;
  const uiSession = interactiveSession || activeSession || null;

  const keepTerminalInputFocusedRef = useRef<() => void>(() => {});
  const handleCopyRuntimeSwitchSession = useCallback((sessionId: string) => {
    onSwitchSession?.(sessionId);
  }, [onSwitchSession]);
  const handleCopyRuntimeSetActivePane = useCallback((paneId: string) => {
    setActivePane(paneId);
  }, [setActivePane]);
  const copyRuntime = useTerminalPageCopyRuntime({
    uiSessionId: uiSession?.id || null,
    activeSessionId: activeSession?.id || null,
    splitVisible,
    findPaneForSession,
    onSwitchSession: handleCopyRuntimeSwitchSession,
    setActivePane: handleCopyRuntimeSetActivePane,
    keepTerminalInputFocused: keepTerminalInputFocusedRef.current,
    sessionBufferStore,
    sessions,
  });
  const {
    copySelection,
    handleLongPressCopyRow,
    handleCopySelectionStart,
    handleCopySelectionEnd,
    handleCopySelectedText,
    handleCloseCopyMenu,
    handleQuickBarToggleCopyMode,
  } = copyRuntime;
  const uiSessionId = uiSession?.id || null;
  useLayoutEffect(() => {
    if (sessionPreviewOpen) {
      return;
    }
    const projection = resolveTerminalSessionGroupActiveSessionProjection({
      slots: sessionGroupSlotIds,
      sessions,
      activeSessionId: uiSessionId,
    });
    if (!projection) {
      return;
    }
    if (!terminalSessionGroupSlotIdsEqual(sessionGroupSlotIds, projection.slots)) {
      setSessionGroupSlotIds(projection.slots);
    }
    if (sessionGroupFocusSlot !== projection.focusSlot) {
      setSessionGroupFocusSlot(projection.focusSlot);
    }
  }, [sessionGroupFocusSlot, sessionGroupSlotIds, sessionPreviewOpen, sessions, uiSessionId]);

  const effectiveSessionGroupSlotIds = useMemo(() => resolveTerminalSessionGroupSlotIds({
    slots: sessionGroupSlotIds,
    sessions,
    centerSessionId: uiSessionId,
  }), [sessionGroupSlotIds, sessions, uiSessionId]);
  const sessionGroupViewportProjection = useMemo(() => resolveTerminalSessionGroupViewportProjection(
    effectiveSessionGroupSlotIds,
    sessionGroupFocusSlot,
  ), [effectiveSessionGroupSlotIds, sessionGroupFocusSlot]);
  const resolveSessionGroupSlot = useCallback((sessionId: string): TerminalSessionGroupSlotName | null => {
    if (effectiveSessionGroupSlotIds.top === sessionId) {
      return 'top';
    }
    if (effectiveSessionGroupSlotIds.center === sessionId) {
      return 'center';
    }
    if (effectiveSessionGroupSlotIds.bottom === sessionId) {
      return 'bottom';
    }
    return null;
  }, [effectiveSessionGroupSlotIds]);
  const sessionGroupViewportSlotSessions = useMemo(() => ({
    slots: {
      top: sessionGroupViewportProjection.slots.top
        ? sessions.find((session) => session.id === sessionGroupViewportProjection.slots.top) || null
        : null,
      center: sessionGroupViewportProjection.slots.center
        ? sessions.find((session) => session.id === sessionGroupViewportProjection.slots.center) || null
        : null,
      bottom: sessionGroupViewportProjection.slots.bottom
        ? sessions.find((session) => session.id === sessionGroupViewportProjection.slots.bottom) || null
        : null,
    },
    visible: sessionGroupViewportProjection.visible,
  }), [sessionGroupViewportProjection, sessions]);
  const renderedPaneSessions = splitVisible
    ? visiblePaneEntries.map((entry) => entry.session)
    : (interactiveSession ? [interactiveSession] : []);
  const sessionPreviewSessions = useMemo(
    () => resolveSessionPreviewTargets(sessionPreviewSelection, sessions),
    [sessionPreviewSelection, sessions],
  );
  const sessionPreviewReplacementCandidates = useMemo(() => {
    const selectedIds = new Set(sessionPreviewSessions.map((session) => session.id));
    return sessions.filter((session) =>
      !selectedIds.has(session.id)
      && !session.remoteMissing
      && session.state !== 'closed',
    );
  }, [sessionPreviewSessions, sessions]);
  const livePaneSessionIds = useMemo(() => projectSessionPreviewLiveIds(
    renderedPaneSessions.map((session) => session.id),
    sessionPreviewSessions.map((session) => session.id),
    sessionPreviewOpen,
    appForegroundActive !== false,
  ), [appForegroundActive, renderedPaneSessions, sessionPreviewOpen, sessionPreviewSessions]);
  const livePaneSessionIdsKey = useMemo(
    () => livePaneSessionIds.join('||'),
    [livePaneSessionIds],
  );
  const headerSessionsUiKey = useMemo(() => terminalPageHeaderSessionsUiKey(sessions), [sessions]);
  const activeHeaderSessionUiKey = useMemo(() => terminalPageHeaderSessionUiKey(activeSession), [activeSession]);
  const chromeSessions = useMemo(() => sessions.map(toTerminalTabChromeItem), [headerSessionsUiKey]);
  const activeChromeSession = useMemo(() => (
    interactiveSession ? toTerminalTabChromeItem(interactiveSession) : null
  ), [activeHeaderSessionUiKey, interactiveSession]);
  const onlineRelayDaemonDevices = useMemo(
    () => listOnlineTraversalRelayDaemonDevices(relayDevices),
    [relayDevices],
  );
  const drawerServerIdentityAliases = useMemo(() => buildServerIdentityAliasMap([
    ...sessions,
    ...sessionGroups,
    ...buildRelayDeviceSessionCatalogAliasInputs(onlineRelayDaemonDevices, sessionGroups),
    ...buildRelayDeviceLiveSessionCatalogAliasInputs(onlineRelayDaemonDevices, sessions),
    ...serverIdentityAliasInputs,
    ...buildRelayDeviceServerIdentityAliasInputs(onlineRelayDaemonDevices),
  ]), [onlineRelayDaemonDevices, serverIdentityAliasInputs, sessionGroups, sessions]);
  const relayDeviceByDaemonHostId = useMemo(() => {
    const devices = new Map<string, TraversalRelayDeviceSnapshot>();
    for (const device of onlineRelayDaemonDevices) {
      const hostId = device.daemon.hostId.trim();
      if (hostId) {
        devices.set(hostId, device);
      }
    }
    return devices;
  }, [onlineRelayDaemonDevices]);
  const drawerRemoteSessions = useMemo(() => {
    const liveSessionByReuseKey = new Map<string, Session>();
    for (const session of sessions) {
      liveSessionByReuseKey.set(
        buildSessionSemanticReuseKey({
          daemonHostId: session.daemonHostId,
          bridgeHost: session.bridgeHost,
          bridgePort: session.bridgePort,
          sessionName: session.sessionName,
        }),
        session,
      );
      const rawIdentity = resolveServerIdentity(session);
      const aliasedIdentity = resolveServerIdentity(session, drawerServerIdentityAliases);
      if (aliasedIdentity.key && aliasedIdentity.key !== rawIdentity.key) {
        liveSessionByReuseKey.set(
          buildSessionSemanticReuseKey({
            daemonHostId: aliasedIdentity.key,
            bridgeHost: session.bridgeHost,
            bridgePort: session.bridgePort,
            sessionName: session.sessionName,
          }),
          session,
        );
      }
    }
    const catalogLiveSessionIds = new Set<string>();
    const targets = new Map<string, {
      target: DrawerRemoteSessionTarget;
      sessionName: string;
    }>();
    const closeTargets = new Map<string, {
      target: DrawerRemoteSessionTarget;
      sessionName: string;
      localSessionId: string | null;
    }>();
    const rowIdByCanonicalSessionKey = new Map<string, string>();
    const items: TerminalSessionDrawerItem[] = [];
    for (const group of sessionGroups) {
      const missing = new Set(group.missingSessionNames || []);
      const ownerKey = buildSessionSemanticOwnerKey(group);
      const serverIdentity = resolveServerIdentity(group, drawerServerIdentityAliases);
      for (const sessionName of group.sessionNames) {
        if (!sessionName || missing.has(sessionName)) {
          continue;
        }
        const reuseKey = buildSessionSemanticReuseKey({
          daemonHostId: group.daemonHostId,
          bridgeHost: group.bridgeHost,
          bridgePort: group.bridgePort,
          sessionName,
        });
        const liveSession = liveSessionByReuseKey.get(reuseKey) || null;
        const id = liveSession?.id || `remote:${ownerKey}::session:${sessionName}`;
        const relayDevice = relayDeviceByDaemonHostId.get(serverIdentity.key) || null;
        const relayRtcCandidates = getRelayRtcEndpointCandidates(relayDevice?.daemon.endpoints || []);
        const useRelayRouteTarget = Boolean(relayDevice && relayRtcCandidates.length > 0);
        const targetBridgeHost = useRelayRouteTarget && liveSession?.bridgeHost?.trim() && !group.bridgeHost.trim()
          ? liveSession.bridgeHost
          : group.bridgeHost;
        const targetBridgePort = useRelayRouteTarget && liveSession?.bridgeHost?.trim() && !group.bridgeHost.trim()
          ? liveSession.bridgePort || group.bridgePort
          : group.bridgePort;
        const relayEndpointCandidates = relayDevice && relayRtcCandidates.length > 0
          ? relayDevice.daemon.endpoints || relayRtcCandidates
          : group.relayEndpointCandidates || [];
        const canonicalDaemonHostId = group.daemonHostId?.trim()
          || (relayDevice && relayRtcCandidates.length > 0 ? serverIdentity.key : '');
        const remoteCatalogTarget = {
          name: group.name,
          bridgeHost: targetBridgeHost,
          bridgePort: targetBridgePort,
          ...(canonicalDaemonHostId ? { daemonHostId: canonicalDaemonHostId, relayHostId: canonicalDaemonHostId } : {}),
          authToken: group.authToken,
          ...(relayEndpointCandidates?.length ? { relayEndpointCandidates } : {}),
          ...(useRelayRouteTarget ? { transportMode: 'auto' as const } : {}),
          sessionNames: group.sessionNames,
        };
        const canonicalSessionRowKey = `${serverIdentity.key}::session:${sessionName}`;
        const existingRowId = rowIdByCanonicalSessionKey.get(canonicalSessionRowKey);
        if (existingRowId) {
          const existingCloseTarget = closeTargets.get(existingRowId);
          closeTargets.set(existingRowId, {
            target: useRelayRouteTarget ? remoteCatalogTarget : existingCloseTarget?.target || remoteCatalogTarget,
            sessionName,
            localSessionId: existingCloseTarget?.localSessionId || liveSession?.id || null,
          });
          if (!liveSession && !targets.has(existingRowId)) {
            targets.set(existingRowId, {
              target: remoteCatalogTarget,
              sessionName,
            });
          }
          if (liveSession) {
            catalogLiveSessionIds.add(liveSession.id);
          }
          continue;
        }
        rowIdByCanonicalSessionKey.set(canonicalSessionRowKey, id);
        closeTargets.set(id, {
          target: remoteCatalogTarget,
          sessionName,
          localSessionId: liveSession?.id || null,
        });
        if (liveSession) {
          catalogLiveSessionIds.add(liveSession.id);
        } else {
          targets.set(id, {
            target: remoteCatalogTarget,
            sessionName,
          });
        }
        items.push({
          id,
          title: liveSession?.customName || liveSession?.title || sessionName,
          subtitle: `${serverIdentity.label} · ${sessionName}`,
          status: liveSession ? normalizeDrawerStatus(liveSession.state) : 'idle',
          paneLabel: undefined,
          sessionGroupSlot: null,
          active: false,
          hostKey: serverIdentity.key,
          hostLabel: serverIdentity.label,
        });
      }
    }
    return { items, targets, closeTargets, catalogLiveSessionIds };
  }, [drawerServerIdentityAliases, relayDeviceByDaemonHostId, sessionGroups, sessions]);
  const drawerHosts = useMemo<TerminalSessionDrawerHost[]>(() => {
    const hosts = new Map<string, TerminalSessionDrawerHost>();
    for (const device of onlineRelayDaemonDevices) {
      const hostKey = device.daemon.hostId.trim();
      if (!hostKey) {
        continue;
      }
      hosts.set(hostKey, {
        hostKey,
        hostLabel: device.deviceName.trim() || hostKey,
        connected: device.daemon.connected,
      });
    }
    for (const item of drawerRemoteSessions.items) {
      const hostKey = item.hostKey?.trim();
      if (!hostKey || hosts.has(hostKey)) {
        continue;
      }
      hosts.set(hostKey, {
        hostKey,
        hostLabel: item.hostLabel?.trim() || hostKey,
      });
    }
    return [...hosts.values()];
  }, [drawerRemoteSessions.items, onlineRelayDaemonDevices]);
  const drawerSessions = useMemo(() => {
    const activeSessionIds = new Set(renderedPaneSessions.map((session) => session.id));
    const resolveDrawerServerIdentity = (session: Session) => resolveServerIdentity(session, drawerServerIdentityAliases);

    const catalogItems = drawerRemoteSessions.items.map((item) => {
      const liveSession = sessions.find((session) => session.id === item.id) || null;
      if (!liveSession) {
        return item;
      }
      const serverIdentity = resolveDrawerServerIdentity(liveSession);
      return {
        ...item,
        title: liveSession.customName || liveSession.title || liveSession.sessionName,
        subtitle: `${serverIdentity.label} · ${liveSession.sessionName}`,
        status: normalizeDrawerStatus(liveSession.state),
        remoteMissing: resolveSessionRemoteMissing(liveSession, sessionGroups),
        paneLabel: undefined,
        sessionGroupSlot: resolveSessionGroupSlot(liveSession.id),
        active: activeSessionIds.has(liveSession.id),
        hostKey: serverIdentity.key,
        hostLabel: serverIdentity.label,
      };
    });

    return catalogItems;
  }, [drawerRemoteSessions.items, drawerServerIdentityAliases, renderedPaneSessions, resolveSessionGroupSlot, sessionGroups, sessions]);
  useEffect(() => {
    if (!portraitSessionDrawerEnabled || sessionDrawerOpen || sessions.length > 0 || drawerHosts.length === 0) {
      return;
    }
    setSessionDrawerOpen(true);
  }, [drawerHosts.length, portraitSessionDrawerEnabled, sessionDrawerOpen, sessions.length]);
  const activeDraft = sessionDraft;
  const activeScheduleState = scheduleState || null;
  const scheduleOpen = scheduleComposerTarget !== null;
  const frozenScheduleState = scheduleComposerTarget
    ? getScheduleState?.(scheduleComposerTarget.sessionId)
      || (activeScheduleState?.sessionName === scheduleComposerTarget.sessionName ? activeScheduleState : null)
    : null;
  const activeSessionRef = useRef(activeSession);
  const sessionsRef = useRef(sessions);
  const splitVisibleRef = useRef(splitVisible);
  const activePaneIdRef = useRef<string>(workspace.activePaneId);
  const previousLivePaneSessionIdsKeyRef = useRef<string>('');
  activeSessionRef.current = activeSession;
  sessionsRef.current = sessions;
  splitVisibleRef.current = splitVisible;
  activePaneIdRef.current = workspace.activePaneId;

  useEffect(() => {
    activeSessionIdRef.current = interactiveSession?.id || null;
  }, [interactiveSession?.id]);

  useEffect(() => {
    if (!portraitSessionDrawerEnabled && sessionDrawerOpen) {
      setSessionDrawerOpen(false);
    }
  }, [portraitSessionDrawerEnabled, sessionDrawerOpen]);

  useEffect(() => {
    const closePreviewWhenHidden = () => {
      if (document.visibilityState !== 'visible') setSessionPreviewOpen(false);
    };
    document.addEventListener('visibilitychange', closePreviewWhenHidden);
    return () => document.removeEventListener('visibilitychange', closePreviewWhenHidden);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;
    const next = pruneSessionPreviewSelectionToOpenSessions(sessionPreviewSelection, sessions);
    if (next === sessionPreviewSelection) return;
    setSessionPreviewSelection(next);
    const storage = getBrowserStorage();
    if (storage) writeSessionPreviewSelection(storage, next);
  }, [sessionPreviewSelection, sessions]);

  useEffect(() => {
    setSessionDrawerOpen(false);
  }, [interactiveSession?.id]);

  useEffect(() => {
    if (!pendingPaneAttachIntent) {
      return;
    }
    if (appliedPaneAttachIntentNonceRef.current === pendingPaneAttachIntent.nonce) {
      return;
    }
    const normalizedSessionIds = [...new Set(pendingPaneAttachIntent.sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))];
    const normalizedPaneId = pendingPaneAttachIntent.paneId.trim();
    if (normalizedSessionIds.length === 0 || !normalizedPaneId) {
      console.error('[TerminalPage] Refused pane-attach intent without explicit sessionIds/paneId.', pendingPaneAttachIntent);
      appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
      onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
      return;
    }
    const knownSessionIds = new Set(sessions.map((session) => session.id));
    const allSessionsPresent = normalizedSessionIds.every((sessionId) => knownSessionIds.has(sessionId));
    const paneExists = workspace.panes.some((pane) => pane.id === normalizedPaneId);
    if (!paneExists) {
      console.error('[TerminalPage] Refused pane-attach intent because target pane does not exist.', {
        paneId: normalizedPaneId,
        workspacePaneIds: workspace.panes.map((pane) => pane.id),
        sessionIds: normalizedSessionIds,
      });
      appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
      onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
      return;
    }
    if (!allSessionsPresent) {
      return;
    }
    appliedPaneAttachIntentNonceRef.current = pendingPaneAttachIntent.nonce;
    attachSessionsToPane(normalizedSessionIds, normalizedPaneId);
    onPaneAttachIntentApplied?.(pendingPaneAttachIntent);
  }, [attachSessionsToPane, onPaneAttachIntentApplied, pendingPaneAttachIntent, sessions, workspace.panes]);

  useLayoutEffect(() => {
    if (!onLiveSessionIdsChange) {
      previousLivePaneSessionIdsKeyRef.current = livePaneSessionIdsKey;
      return;
    }
    if (previousLivePaneSessionIdsKeyRef.current === livePaneSessionIdsKey) {
      return;
    }
    previousLivePaneSessionIdsKeyRef.current = livePaneSessionIdsKey;
    onLiveSessionIdsChange(livePaneSessionIds);
  }, [livePaneSessionIds, livePaneSessionIdsKey, onLiveSessionIdsChange]);

  useLayoutEffect(() => {
    if (!splitVisible || !onTerminalViewportChange) {
      return;
    }
    renderedPaneSessions.forEach((session) => {
      if (session.id === interactiveSession?.id) {
        return;
      }
      onTerminalViewportChange(session.id, {
        mode: 'follow',
        viewportEndIndex: session.buffer?.endIndex ?? 0,
        viewportRows: session.buffer?.rows ?? 24,
      });
    });
  }, [interactiveSession?.id, livePaneSessionIdsKey, onTerminalViewportChange, renderedPaneSessions, splitVisible]);

  useEffect(() => {
    return () => {
      previousLivePaneSessionIdsKeyRef.current = '';
      onLiveSessionIdsChange?.([]);
    };
  }, [onLiveSessionIdsChange]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const visualViewport = window.visualViewport;

    updateViewportMetrics();
    window.addEventListener('resize', scheduleViewportMetricsSync);
    visualViewport?.addEventListener('resize', scheduleViewportMetricsSync);
    if (!isAndroid) {
      visualViewport?.addEventListener('scroll', scheduleViewportMetricsSync);
    }
    return () => {
      window.removeEventListener('resize', scheduleViewportMetricsSync);
      visualViewport?.removeEventListener('resize', scheduleViewportMetricsSync);
      if (!isAndroid) {
        visualViewport?.removeEventListener('scroll', scheduleViewportMetricsSync);
      }
      if (viewportMetricsFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportMetricsFrameRef.current);
        viewportMetricsFrameRef.current = null;
      }
    };
  }, [isAndroid, scheduleViewportMetricsSync, updateViewportMetrics]);

  const focusTerminalInput = useCallback(() => {
    setFocusNonce((value) => value + 1);

    const input = querySessionInput(uiSessionId);
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [uiSessionId]);

  const alignActiveTerminalToFollowForInput = useCallback(() => {
    if (!uiSessionId) {
      return;
    }
    setInputIntentFollowResetEpoch((value) => value + 1);
  }, [uiSessionId]);
  const alignActiveTerminalToFollowForInputRef = useRef(alignActiveTerminalToFollowForInput);

  useEffect(() => {
    alignActiveTerminalToFollowForInputRef.current = alignActiveTerminalToFollowForInput;
  }, [alignActiveTerminalToFollowForInput]);

  const clearPendingAndroidImeFocus = useCallback(() => {
    if (pendingAndroidImeFocusTimerRef.current === null) {
      return;
    }
    window.clearTimeout(pendingAndroidImeFocusTimerRef.current);
    pendingAndroidImeFocusTimerRef.current = null;
  }, []);

  const clearTerminalFocusRetries = useCallback(() => {
    if (terminalFocusRetryTimeoutsRef.current.length === 0) {
      return;
    }
    terminalFocusRetryTimeoutsRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    terminalFocusRetryTimeoutsRef.current = [];
  }, []);

  const scheduleTerminalFocusRetries = useCallback((options?: {
    delaysMs?: number[];
    includeKeyboardShow?: boolean;
  }) => {
    const delaysMs = options?.delaysMs || [0, 32, 120];
    const includeKeyboardShow = Boolean(options?.includeKeyboardShow);
    clearTerminalFocusRetries();
    terminalFocusRetryTimeoutsRef.current = delaysMs.map((delayMs) => window.setTimeout(() => {
      focusTerminalInput();
      if (includeKeyboardShow) {
        void Keyboard.show().catch((error) => {
          logAsyncCleanupFailure(`Keyboard.show retry(${delayMs}ms)`, error);
        });
      }
    }, delayMs));
  }, [clearTerminalFocusRetries, focusTerminalInput]);

  const setAndroidEditorActive = useCallback((active: boolean) => {
    if (!isAndroid) {
      return;
    }
    void ImeAnchor.setEditorActive({ active }).catch((error) => {
      console.warn(`[TerminalPage] ImeAnchor.setEditorActive(${active ? 'true' : 'false'}) failed:`, error);
    });
  }, [isAndroid]);

  const requestAndroidImeFocus = useCallback((options?: { force?: boolean; delayMs?: number }) => {
    if (!isAndroid || quickBarEditorFocusedRef.current) {
      return;
    }
    captureStableLayoutViewportHeight();
    const routeKey = uiSessionId || '__no-session__';
    if (!options?.force && androidImeFocusRouteKeyRef.current === routeKey) {
      return;
    }
    androidImeFocusRouteKeyRef.current = routeKey;
    clearPendingAndroidImeFocus();
    const delayMs = Math.max(0, Math.round(options?.delayMs || 0));
    pendingAndroidImeFocusTimerRef.current = window.setTimeout(() => {
      pendingAndroidImeFocusTimerRef.current = null;
      if (quickBarEditorFocusedRef.current) {
        return;
      }
      void ImeAnchor.show().catch((error) => {
        console.warn('[TerminalPage] ImeAnchor.show() failed:', error);
      });
    }, delayMs);
  }, [captureStableLayoutViewportHeight, clearPendingAndroidImeFocus, isAndroid, uiSessionId]);

  const keepTerminalInputFocused = useCallback(() => {
    if (quickBarEditorFocused) {
      clearTerminalFocusRetries();
      return;
    }

    if (isAndroid) {
      return;
    }

    scheduleTerminalFocusRetries();
  }, [clearTerminalFocusRetries, isAndroid, quickBarEditorFocused, scheduleTerminalFocusRetries]);

  useEffect(() => {
    keepTerminalInputFocusedRef.current = keepTerminalInputFocused;
  }, [keepTerminalInputFocused]);

  const closeRemoteScreenshotPreview = useCallback(() => {
    setRemoteScreenshotPreview(remoteScreenshotPreviewRuntimeRef.current.closePreview());
  }, []);

  useEffect(() => () => {
    remoteScreenshotPreviewRuntimeRef.current.dispose();
  }, []);

  const handleRequestRemoteScreenshot = useCallback(async () => {
    const targetSessionId = uiSessionId;
    if (!targetSessionId || !onRequestRemoteScreenshot) {
      alert('当前没有可用的目标 session');
      return;
    }

    const started = remoteScreenshotPreviewRuntimeRef.current.beginRequest();
    const requestEpoch = started.requestEpoch;
    setRemoteScreenshotPreview(started.state);

    try {
      const capture = await onRequestRemoteScreenshot(targetSessionId, (progress) => {
        setRemoteScreenshotPreview((current) => (
          remoteScreenshotPreviewRuntimeRef.current.applyProgress(current, requestEpoch, progress)
        ));
      });

      if (!remoteScreenshotPreviewRuntimeRef.current.isRequestCurrent(requestEpoch)) {
        return;
      }
      setRemoteScreenshotPreview((current) => (
        remoteScreenshotPreviewRuntimeRef.current.markTransferComplete(current, requestEpoch, capture)
      ));
      setRemoteScreenshotPreview((current) => (
        remoteScreenshotPreviewRuntimeRef.current.completeCapture(current, requestEpoch, capture)
      ));
    } catch (error) {
      if (!remoteScreenshotPreviewRuntimeRef.current.isRequestCurrent(requestEpoch)) {
        return;
      }
      setRemoteScreenshotPreview((current) => (
        remoteScreenshotPreviewRuntimeRef.current.failCapture(current, requestEpoch, error)
      ));
    }
  }, [onRequestRemoteScreenshot, uiSessionId]);

  const handleRequestRemoteWindowScreenshot = useCallback(async (
    sessionId: string,
    target: RemoteWindowStreamTargetManifest,
    options?: { persist?: boolean },
  ) => {
    if (!onRequestRemoteScreenshot) {
      throw new Error('当前没有可用的截图通道');
    }
    const capture = await onRequestRemoteScreenshot(sessionId, undefined, {
      target: {
        kind: 'remote-window',
        target,
      },
    });
    if (options?.persist === false) {
      return {
        fileName: capture.fileName,
        savedPath: '',
        dataUrl: `data:${capture.mimeType || 'image/png'};base64,${capture.dataBase64}`,
      };
    }
    const savedPath = await persistRemoteScreenshotCaptureRuntime({
      fileName: capture.fileName,
      dataBase64: capture.dataBase64,
      directory: Directory.ExternalStorage,
      mkdir: Filesystem.mkdir,
      writeFile: Filesystem.writeFile,
    });
    return {
      fileName: capture.fileName,
      savedPath,
      dataUrl: `data:${capture.mimeType || 'image/png'};base64,${capture.dataBase64}`,
    };
  }, [onRequestRemoteScreenshot]);

  const handleQuickBarMeasuredHeightChange = useCallback((height: number) => {
    runtimeDebug('terminal.quickbar.measure', {
      measuredHeight: height,
      keyboardInset,
      timestamp: Date.now(),
    });
    setQuickBarHeight(Math.max(0, height));
  }, [keyboardInset]);

  const emitRemoteWindowInputEvents = useCallback((
    events: Array<RemoteWindowInputEventPayload['event']>,
    source: Exclude<RemoteWindowInputDebugSource, 'overlay'>,
  ) => {
    const context = remoteWindowInputContextRef.current;
    if (!context) {
      return false;
    }
    runtimeDebug('desktop.remote_window_stream.input.route', {
      source,
      sessionId: context.sessionId,
      streamId: context.streamId,
      targetId: context.targetId,
      targetKind: context.targetKind,
      inputTargetKind: context.inputTargetKind,
      inputRoute: context.inputRoute,
      focusPolicy: context.focusPolicy,
      eventCount: events.length,
    });
    if (events.length === 0) {
      return true;
    }
    const recordDebug = (event: RemoteWindowInputEventPayload['event'], sent: boolean) => {
      recordRemoteWindowInputDebug({
        source,
        sent,
        sessionId: context.sessionId,
        streamId: context.streamId,
        targetId: context.targetId,
        event,
      });
    };
    if (!onSendRemoteWindowInput) {
      events.forEach((event) => {
        recordDebug(event, false);
      });
      return true;
    }
    events.forEach((event) => {
      onSendRemoteWindowInput(context.sessionId, {
        streamId: context.streamId,
        targetId: context.targetId,
        event,
      });
      recordDebug(event, true);
    });
    return true;
  }, [onSendRemoteWindowInput, recordRemoteWindowInputDebug]);

  const handleQuickBarImagePaste = useCallback((
    sessionId: string,
    file: File,
  ) => {
    const context = remoteWindowInputContextRef.current;
    if (context?.streamId && context.targetId) {
      return onImagePaste?.(sessionId, file, {
        pasteTarget: {
          kind: 'remote-window',
          streamId: context.streamId,
          targetId: context.targetId,
        },
      });
    }
    return onImagePaste?.(sessionId, file);
  }, [onImagePaste]);

  const handleQuickBarSendSequence = useCallback((sequence: string) => {
    if (emitRemoteWindowInputEvents(
      buildRemoteWindowKeyInputEventsFromSequence(sequence),
      'quickbar-sequence',
    )) {
      return;
    }
    onQuickActionInput?.(sequence, uiSessionId || undefined);
    if (terminalKeyboardRequested) {
      keepTerminalInputFocused();
    }
  }, [emitRemoteWindowInputEvents, keepTerminalInputFocused, onQuickActionInput, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarSessionDraftChange = useCallback((value: string) => {
    onSessionDraftChange?.(value, uiSessionId || undefined);
  }, [onSessionDraftChange, uiSessionId]);

  const handleQuickBarSessionDraftSend = useCallback((value: string) => {
    if (emitRemoteWindowInputEvents(
      buildRemoteWindowKeyInputEventsFromSequence(value),
      'quickbar-draft',
    )) {
      return;
    }
    onSessionDraftSend?.(value, uiSessionId || undefined);
    if (terminalKeyboardRequested) {
      keepTerminalInputFocused();
    }
  }, [emitRemoteWindowInputEvents, keepTerminalInputFocused, onSessionDraftSend, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarOpenScheduleComposer = useCallback((text: string) => {
    const targetSessionId = uiSessionId;
    if (!targetSessionId) {
      return;
    }
    const targetSession = sessionsRef.current.find((session) => session.id === targetSessionId);
    if (!targetSession) {
      return;
    }
    onRequestScheduleList?.(targetSessionId);
    setScheduleComposerTarget({
      sessionId: targetSession.id,
      sessionName: targetSession.sessionName,
      nonce: Date.now(),
      seedText: text,
    });
  }, [onRequestScheduleList, uiSessionId]);

  const handleQuickBarOpenFileTransfer = useCallback(() => {
    setFileTransferOpen(true);
  }, []);

  const handleQuickBarToggleDebugOverlay = useCallback(() => {
    setDebugOverlayVisible((v) => !v);
  }, []);

  const handleQuickBarToggleAbsoluteLineNumbers = useCallback(() => {
    setAbsoluteLineNumbersVisible((v) => !v);
  }, []);
  const handleQuickBarRequestRemoteScreenshot = useCallback(() => {
    void handleRequestRemoteScreenshot();
  }, [handleRequestRemoteScreenshot]);

  const handleActiveTerminalActivateInput = useCallback(() => {
    alignActiveTerminalToFollowForInput();
  }, [alignActiveTerminalToFollowForInput]);

  const handleSwipeTab = useCallback((sessionId: string, direction: 'previous' | 'next') => {
    if (portraitSessionDrawerEnabled && direction === 'previous') {
      setSessionDrawerDebug((current) => ({
        ...current,
        lastEvent: 'page:drawer-open',
        eventSeq: current.eventSeq + 1,
      }));
      setSessionDrawerOpen(true);
      return;
    }
    const currentSplitVisible = splitVisibleRef.current;
    const currentSessions = sessionsRef.current;
    const currentActivePaneId = activePaneIdRef.current;
    const paneScopedSessions = currentSplitVisible
      ? getPaneSessionIds(currentActivePaneId)
          .map((paneSessionId) => currentSessions.find((session) => session.id === paneSessionId) || null)
          .filter((session): session is Session => Boolean(session))
      : currentSessions;
    const currentIndex = paneScopedSessions.findIndex((session) => session.id === sessionId);
    if (currentIndex < 0) {
      return;
    }
    const targetIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    const targetSession = paneScopedSessions[targetIndex] || null;
    if (!targetSession || targetSession.id === sessionId) {
      return;
    }
    const targetPane = currentSplitVisible ? findPaneForSession(targetSession.id) : null;
    if (currentSplitVisible && targetPane) {
      switchTabInPane(targetPane.id, `tab-${targetSession.id}`);
    }
    onSwitchSession(targetSession.id);
  }, [findPaneForSession, getPaneSessionIds, onSwitchSession, portraitSessionDrawerEnabled, switchTabInPane]);

  const handleSaveRemoteScreenshot = useCallback(async () => {
    if (
      !remoteScreenshotPreview?.previewDataUrl
      || !remoteScreenshotPreview.rawDataBase64
      || remoteScreenshotPreview.phase !== 'preview-ready'
    ) {
      return;
    }

    setRemoteScreenshotPreview((current) => remoteScreenshotPreviewRuntimeRef.current.beginSave(current));
    try {
      const savedPath = await persistRemoteScreenshotCaptureRuntime({
        fileName: remoteScreenshotPreview.fileName,
        dataBase64: remoteScreenshotPreview.rawDataBase64,
        directory: Directory.ExternalStorage,
        mkdir: Filesystem.mkdir,
        writeFile: Filesystem.writeFile,
      });
      closeRemoteScreenshotPreview();
      alert(`截图已保存到 ${savedPath}`);
    } catch (error) {
      setRemoteScreenshotPreview((current) => remoteScreenshotPreviewRuntimeRef.current.restorePreviewReady(current));
      alert(error instanceof Error ? error.message : '保存远程截图失败');
    }
  }, [closeRemoteScreenshotPreview, remoteScreenshotPreview]);

  const handleToggleKeyboard = useCallback(async () => {
    if (quickBarEditorFocused && typeof document !== 'undefined') {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      quickBarEditorFocusedRef.current = false;
      setQuickBarEditorFocused(false);
      if (isAndroid) {
        setAndroidEditorActive(false);
      }
    }

    const keyboardVisible = keyboardInset > 0;
    let androidKeyboardVisible = androidImeVisibleRef.current;
    if (isAndroid) {
      try {
        const state = await ImeAnchor.getState();
        androidKeyboardVisible = Boolean((state as { keyboardVisible?: unknown }).keyboardVisible);
        updateAndroidImeVisible(androidKeyboardVisible);
        const stateKeyboardHeight = Number((state as { keyboardHeight?: unknown }).keyboardHeight || 0);
        if (Number.isFinite(stateKeyboardHeight)) {
          updateKeyboardInset(stateKeyboardHeight);
        }
      } catch (error) {
        console.warn('[TerminalPage] ImeAnchor.getState() failed:', error);
      }
    }
    const shouldHideKeyboard = isAndroid ? androidKeyboardVisible : terminalKeyboardRequested || keyboardVisible;
    if (shouldHideKeyboard) {
      updateTerminalKeyboardRequested(false);
      clearPendingAndroidImeFocus();
      clearTerminalFocusRetries();
      androidImeFocusRouteKeyRef.current = null;
      if (isAndroid) {
        try {
          await ImeAnchor.hide();
          updateAndroidImeVisible(false);
        } catch (error) {
          console.warn('[TerminalPage] ImeAnchor.hide() failed:', error);
        }
      } else {
        try {
          await Keyboard.hide();
        } catch (error) {
          console.warn('[TerminalPage] Keyboard.hide() failed:', error);
        }
      }
      const input = querySessionInput(uiSessionId);
      input?.blur();
      return;
    }

    updateTerminalKeyboardRequested(true);
    alignActiveTerminalToFollowForInput();
    if (isAndroid) {
      requestAndroidImeFocus({ force: true, delayMs: 48 });
      return;
    }

    focusTerminalInput();
    try {
      void Keyboard.show();
    } catch (error) {
      console.warn('[TerminalPage] Keyboard.show() failed:', error);
    }

    scheduleTerminalFocusRetries({ delaysMs: [32, 120], includeKeyboardShow: true });
  }, [alignActiveTerminalToFollowForInput, clearPendingAndroidImeFocus, clearTerminalFocusRetries, focusTerminalInput, isAndroid, keyboardInset, quickBarEditorFocused, requestAndroidImeFocus, scheduleTerminalFocusRetries, setAndroidEditorActive, terminalKeyboardRequested, uiSessionId, updateAndroidImeVisible, updateKeyboardInset]);

  const handleRemoteWindowRequestKeyboard = useCallback(() => {
    if (quickBarEditorFocusedRef.current && typeof document !== 'undefined') {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      quickBarEditorFocusedRef.current = false;
      setQuickBarEditorFocused(false);
      if (isAndroid) {
        setAndroidEditorActive(false);
      }
    }

    updateTerminalKeyboardRequested(true);
    if (isAndroid) {
      requestAndroidImeFocus({ force: true, delayMs: 48 });
      return;
    }

    focusTerminalInput();
    try {
      void Keyboard.show();
    } catch (error) {
      console.warn('[TerminalPage] Keyboard.show() failed for remote window:', error);
    }
    scheduleTerminalFocusRetries({ delaysMs: [32, 120], includeKeyboardShow: true });
  }, [
    focusTerminalInput,
    isAndroid,
    requestAndroidImeFocus,
    scheduleTerminalFocusRetries,
    setAndroidEditorActive,
    updateTerminalKeyboardRequested,
  ]);

  const hideTerminalInputForRemoteWindow = useCallback(() => {
    if (quickBarEditorFocusedRef.current && typeof document !== 'undefined') {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      quickBarEditorFocusedRef.current = false;
      setQuickBarEditorFocused(false);
      if (isAndroid) {
        setAndroidEditorActive(false);
      }
    }

    updateTerminalKeyboardRequested(false);
    clearPendingAndroidImeFocus();
    clearTerminalFocusRetries();
    androidImeFocusRouteKeyRef.current = null;
    const input = querySessionInput(uiSessionId);
    input?.blur();

    if (isAndroid) {
      void ImeAnchor.hide()
        .then(() => {
          updateAndroidImeVisible(false);
          updateKeyboardInset(0);
        })
        .catch((error) => {
          console.warn('[TerminalPage] ImeAnchor.hide() failed while opening remote window:', error);
        });
      return;
    }

    void Keyboard.hide()
      .then(() => updateKeyboardInset(0))
      .catch((error) => {
        console.warn('[TerminalPage] Keyboard.hide() failed while opening remote window:', error);
      });
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, isAndroid, setAndroidEditorActive, uiSessionId, updateAndroidImeVisible, updateKeyboardInset, updateTerminalKeyboardRequested]);

  const handleRemoteWindowOverlayOpenStateChange = useCallback((open: boolean) => {
    setRemoteWindowOverlayOpen(open);
    if (open) {
      hideTerminalInputForRemoteWindow();
    }
  }, [hideTerminalInputForRemoteWindow]);

  const handleRemoteWindowBodySubscriptionSuppressedChange = useCallback((suppressed: boolean) => {
    onActiveBodySubscriptionSuppressedChange?.(suppressed);
  }, [onActiveBodySubscriptionSuppressedChange]);

  const handleRemoteWindowInputContextChange = useCallback((context: RemoteWindowInputContext | null) => {
    remoteWindowInputContextRef.current = context;
    remoteWindowInputDebugRef.current = {
      ...remoteWindowInputDebugRef.current,
      ...projectRemoteWindowInputDebugContext(context),
    };
    setRemoteWindowInputContext(context);
  }, []);

  const handleTerminalFocusOwnerActivate = useCallback(() => {
    remoteWindowInputContextRef.current = null;
    remoteWindowInputDebugRef.current = {
      ...remoteWindowInputDebugRef.current,
      ...projectRemoteWindowInputDebugContext(null),
    };
    setRemoteWindowInputContext(null);
  }, []);

  useEffect(() => () => {
    onActiveBodySubscriptionSuppressedChange?.(false);
  }, [onActiveBodySubscriptionSuppressedChange]);

  const handleQuickBarEditorDomFocusChange = useCallback((active: boolean) => {
    quickBarEditorFocusedRef.current = active;
    setQuickBarEditorFocused(active);
    setAndroidEditorActive(active);

    if (active) {
      clearTerminalFocusRetries();
      androidImeFocusRouteKeyRef.current = null;
    }
    if (active || !isAndroid) {
      return;
    }
  }, [clearTerminalFocusRetries, isAndroid, setAndroidEditorActive]);

  useEffect(() => {
    const syncOnlineState = () => {
      setNetworkOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    };

    syncOnlineState();
    window.addEventListener('online', syncOnlineState);
    window.addEventListener('offline', syncOnlineState);

    return () => {
      window.removeEventListener('online', syncOnlineState);
      window.removeEventListener('offline', syncOnlineState);
    };
  }, []);

  useEffect(() => {
    const hasIssue = !networkOnline || uiSession?.state === 'reconnecting' || uiSession?.state === 'error';

    if (!hasIssue) {
      if (connectionIssueTimerRef.current !== null) {
        window.clearTimeout(connectionIssueTimerRef.current);
        connectionIssueTimerRef.current = null;
      }
      setConnectionIssueVisible(false);
      return;
    }

    if (connectionIssueVisible || connectionIssueTimerRef.current !== null) {
      return;
    }

    connectionIssueTimerRef.current = window.setTimeout(() => {
      connectionIssueTimerRef.current = null;
      setConnectionIssueVisible(true);
    }, NETWORK_BANNER_GRACE_MS);

    return () => {
      if (connectionIssueTimerRef.current !== null) {
        window.clearTimeout(connectionIssueTimerRef.current);
        connectionIssueTimerRef.current = null;
      }
    };
  }, [connectionIssueVisible, networkOnline, uiSession?.state]);


  useEffect(() => {
    updateTerminalKeyboardRequested(false);
    setQuickBarEditorFocused(false);
    if (isAndroid) {
      return;
    }
    clearPendingAndroidImeFocus();
    clearTerminalFocusRetries();

    const input = querySessionInput(uiSessionId);
    input?.blur();
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries, isAndroid, uiSessionId, updateTerminalKeyboardRequested]);

  useEffect(() => {
    if (!isAndroid) {
      return;
    }

    let disposed = false;
    let inputListener: { remove: () => Promise<void> } | null = null;
    let backspaceListener: { remove: () => Promise<void> } | null = null;
    let keyListener: { remove: () => Promise<void> } | null = null;
    let keyboardStateListener: { remove: () => Promise<void> } | null = null;
    let debugInputListener: { remove: () => Promise<void> } | null = null;

    const emitToActiveSession = (data: string, source: 'ime-input' | 'ime-backspace' | 'ime-key' | 'debug-input') => {
      const sessionId = activeSessionIdRef.current;
      const quickBarEditorFocused = quickBarEditorFocusedRef.current;
      runtimeDebug(`terminal.${source}.received`, {
        sessionId,
        size: data.length,
        splitVisible: splitVisibleRef.current,
        activePaneId: activePaneIdRef.current,
        quickBarEditorFocused,
      });
      if (!sessionId) {
        runtimeDebug(`terminal.${source}.drop`, {
          why: 'missing-active-session',
          size: data.length,
          splitVisible: splitVisibleRef.current,
          activePaneId: activePaneIdRef.current,
        });
        return;
      }
      if (!data) {
        runtimeDebug(`terminal.${source}.drop`, {
          why: 'empty-input',
          sessionId,
          splitVisible: splitVisibleRef.current,
          activePaneId: activePaneIdRef.current,
        });
        return;
      }
      if (quickBarEditorFocused) {
        runtimeDebug(`terminal.${source}.drop`, {
          why: 'quick-editor-focused',
          sessionId,
          size: data.length,
          splitVisible: splitVisibleRef.current,
          activePaneId: activePaneIdRef.current,
        });
        return;
      }
      runtimeDebug(`terminal.${source}.emit`, {
        sessionId,
        size: data.length,
        splitVisible: splitVisibleRef.current,
        activePaneId: activePaneIdRef.current,
      });
      terminalInputHandlerRef.current?.(sessionId, data);
    };

    const attachListeners = async () => {
      try {
        inputListener = await ImeAnchor.addListener('input', (event) => {
          const rawText = event.text || '';
          if (emitRemoteWindowInputEvents(
            buildRemoteWindowTextInputEvents(rawText),
            'ime-input',
          )) {
            return;
          }
          const text = normalizeTerminalCommittedText(rawText);
          emitToActiveSession(
            text,
            'ime-input',
          );
        });
        if (disposed) {
          void inputListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor input listener remove after dispose', error);
          });
          inputListener = null;
          return;
        }
        backspaceListener = await ImeAnchor.addListener('backspace', (event) => {
          const count = Math.max(1, Math.round(event.count || 1));
          if (emitRemoteWindowInputEvents(
            buildRemoteWindowBackspaceInputEvents(count),
            'ime-backspace',
          )) {
            return;
          }
          emitToActiveSession('\x7f'.repeat(count), 'ime-backspace');
        });
        if (disposed) {
          void backspaceListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor backspace listener remove after dispose', error);
          });
          backspaceListener = null;
          return;
        }
        keyListener = await ImeAnchor.addListener('key', (event) => {
          if (disposed) return;
          const sessionId = activeSessionIdRef.current;
          if (!sessionId || quickBarEditorFocusedRef.current) {
            return;
          }
          if (remoteWindowInputContextRef.current) {
            emitRemoteWindowInputEvents(
              buildRemoteWindowKeyboardInputEvents({
                key: event.key || '',
                code: event.code || '',
                ctrlKey: Boolean(event.ctrlKey),
                altKey: Boolean(event.altKey),
                metaKey: Boolean(event.metaKey),
                shiftKey: Boolean(event.shiftKey),
              }),
              'ime-key',
            );
            return;
          }
          const keyboardEvent = new KeyboardEvent('keydown', {
            key: event.key || '',
            code: event.code || '',
            ctrlKey: Boolean(event.ctrlKey),
            altKey: Boolean(event.altKey),
            metaKey: Boolean(event.metaKey),
            shiftKey: Boolean(event.shiftKey),
            bubbles: true,
            cancelable: true,
          });
          if (keyboardEvent.metaKey) {
            return;
          }
          const ctrlChord = resolveTerminalCtrlChord(keyboardEvent);
          if (ctrlChord) {
            emitToActiveSession(ctrlChord, 'ime-key');
            return;
          }
          const cursorKeysApp = Boolean(
            sessionBufferStore?.getSnapshot(sessionId).buffer.cursorKeysApp,
          );
          const keyboardInput = resolveTerminalKeyboardInput(
            keyboardEvent,
            cursorKeysApp,
          );
          if (keyboardInput) {
            emitToActiveSession(keyboardInput, 'ime-key');
          }
        });
        if (disposed) {
          void keyListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor key listener remove after dispose', error);
          });
          keyListener = null;
          return;
        }
        keyboardStateListener = await ImeAnchor.addListener('keyboardState', (event) => {
          const visible = Boolean(event.visible);
          const height = Math.max(0, Math.round(event.height || 0));
          // Keep stable layout height anchored before IME show, and refresh once
          // after hide so future popup anchor remains accurate per-device.
          if (visible && isAndroid) {
            captureStableLayoutViewportHeight();
          }
          updateKeyboardInset(height);
          updateAndroidImeVisible(visible);
          if (visible && isAndroid && terminalKeyboardRequestedRef.current && !quickBarEditorFocusedRef.current) {
            alignActiveTerminalToFollowForInputRef.current();
          }
          if (!quickBarEditorFocusedRef.current) {
            updateTerminalKeyboardRequested(visible);
          }
          if (!visible && isAndroid) {
            window.setTimeout(() => {
              captureStableLayoutViewportHeight();
            }, 0);
          }
        });
        if (disposed) {
          void keyboardStateListener.remove().catch((error) => {
            logAsyncCleanupFailure('ImeAnchor keyboardState listener remove after dispose', error);
          });
          keyboardStateListener = null;
          return;
        }
        if (isDebugInputSupported()) {
          debugInputListener = await DebugInput.addListener('debug-input', (event) => {
            const payload = `${event.text || ''}${event.newline || ''}`;
            if (emitRemoteWindowInputEvents(
              buildRemoteWindowTextInputEvents(normalizeTerminalCommittedText(payload)),
              'debug-input',
            )) {
              return;
            }
            emitToActiveSession(payload, 'debug-input');
          });
          if (disposed) {
            void debugInputListener.remove().catch((error) => {
              logAsyncCleanupFailure('DebugInput listener remove after dispose', error);
            });
            debugInputListener = null;
          }
        }
      } catch (error) {
        console.warn('[TerminalPage] Failed to attach ImeAnchor listeners:', error);
      }
    };

    void attachListeners();

    return () => {
      disposed = true;
      if (inputListener) {
        void inputListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor input listener remove', error);
        });
      }
      if (backspaceListener) {
        void backspaceListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor backspace listener remove', error);
        });
      }
      if (keyListener) {
        void keyListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor key listener remove', error);
        });
      }
      if (keyboardStateListener) {
        void keyboardStateListener.remove().catch((error) => {
          logAsyncCleanupFailure('ImeAnchor keyboardState listener remove', error);
        });
      }
      if (debugInputListener) {
        void debugInputListener.remove().catch((error) => {
          logAsyncCleanupFailure('DebugInput listener remove', error);
        });
      }
    };
  }, [captureStableLayoutViewportHeight, emitRemoteWindowInputEvents, isAndroid]);

  useEffect(() => {
    if (!isAndroid || !quickBarEditorFocused) {
      return;
    }

    updateTerminalKeyboardRequested(false);
    clearPendingAndroidImeFocus();
    void ImeAnchor.blur().catch((error) => {
      console.warn('[TerminalPage] ImeAnchor.blur() failed:', error);
    });
  }, [
    clearPendingAndroidImeFocus,
    isAndroid,
    quickBarEditorFocused,
  ]);

  useEffect(() => () => {
    clearPendingAndroidImeFocus();
    clearTerminalFocusRetries();
  }, [clearPendingAndroidImeFocus, clearTerminalFocusRetries]);

  useEffect(() => {
    let disposed = false;
    let hideTimer: number | null = null;

    const cancelPendingHide = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    const showListenerPromise = Keyboard.addListener('keyboardDidShow', (info) => {
      if (!disposed) {
        cancelPendingHide();
        updateKeyboardInset(info.keyboardHeight || 0);
        if (isAndroid) {
          updateAndroidImeVisible(true);
        }
        if (isAndroid && !quickBarEditorFocusedRef.current) {
          updateTerminalKeyboardRequested(true);
        }
      }
    });
    const hideListenerPromise = Keyboard.addListener('keyboardDidHide', () => {
      if (!disposed) {
        if (isAndroid) {
          // Debounce hide on Android to survive fold/unfold display-change
          // transitions that fire keyboardDidHide then keyboardDidShow in rapid succession.
          cancelPendingHide();
          hideTimer = window.setTimeout(() => {
            hideTimer = null;
            if (!disposed) {
              updateTerminalKeyboardRequested(false);
              updateAndroidImeVisible(false);
              updateKeyboardInset(0);
            }
          }, 400);
        } else {
          updateTerminalKeyboardRequested(false);
          updateKeyboardInset(0);
        }
      }
    });

    return () => {
      disposed = true;
      cancelPendingHide();
      void showListenerPromise
        .then((listener) => listener.remove())
        .catch((error) => {
          logAsyncCleanupFailure('keyboardDidShow listener remove', error);
        });
      void hideListenerPromise
        .then((listener) => listener.remove())
        .catch((error) => {
          logAsyncCleanupFailure('keyboardDidHide listener remove', error);
        });
    };
  }, [isAndroid, updateAndroidImeVisible, updateKeyboardInset, updateTerminalKeyboardRequested]);

  useEffect(() => {
    if (typeof navigator === 'undefined') {
      return;
    }

    const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardApi }).virtualKeyboard;
    if (!virtualKeyboard) {
      return;
    }

    virtualKeyboard.overlaysContent = true;
    const syncKeyboardInset = () => {
      const nextInset = Math.max(0, Math.round(virtualKeyboard.boundingRect?.height || 0));
      updateKeyboardInset(nextInset);
    };

    syncKeyboardInset();
    virtualKeyboard.addEventListener('geometrychange', syncKeyboardInset);
    return () => {
      virtualKeyboard.removeEventListener('geometrychange', syncKeyboardInset);
    };
  }, [updateKeyboardInset]);

  const layoutProfile = useMemo(() => resolveTerminalLayoutProfile({
    splitVisible,
    topInsetPx: headerTopInsetPx,
    landscape,
  }), [headerTopInsetPx, landscape, splitVisible]);
  const effectiveKeyboardLiftPx = resolveKeyboardLiftPx(keyboardInset, shellHeight);
  const terminalImeActive = (isAndroid ? androidImeVisible : terminalKeyboardRequested) && !quickBarEditorFocused;
  const quickBarShellKeyboardLiftPx = keyboardInset > 0 ? effectiveKeyboardLiftPx : 0;
  const terminalImeLiftPx = quickBarShellKeyboardLiftPx;
  const terminalBottomChromeLiftPx = resolveTerminalBottomChromeLiftPx({
    viewportWidth,
    viewportHeight: shellHeight,
    landscape,
  });
  const terminalChromeBottomPx = Math.max(
    0,
    quickBarHeight
      + layoutProfile.quickBar.touchSafeOffsetPx
      + terminalBottomChromeLiftPx,
  );
  const terminalStageBottomPx = remoteWindowOverlayOpen
    ? 0
    : terminalChromeBottomPx + terminalImeLiftPx;
  const terminalStageTopPx = portraitSessionDrawerEnabled
    ? Math.max(0, headerTopInsetPx + 50)
    : 0;
  const visualViewportDebugWidth = typeof window !== 'undefined'
    ? Math.round(window.visualViewport?.width || 0)
    : 0;
  const visualViewportDebugHeight = typeof window !== 'undefined'
    ? Math.round(window.visualViewport?.height || 0)
    : 0;
  const visualViewportDebugOffsetTop = typeof window !== 'undefined'
    ? Math.round(window.visualViewport?.offsetTop || 0)
    : 0;
  const currentLayoutViewportDebugHeight = currentLayoutViewportHeight;
  // Use a ref to hold the live snapshot lambda so the registration useEffect
  // never needs to re-run. The producer reads ref.current, which is kept fresh
  // every render. This decouples the snapshot source from all reactive deps,
  // stopping the 27-item useEffect dep chain that fires on every keyboard/tick change.
  const terminalPageSnapshotProducerRef = useRef<() => Record<string, unknown>>(() => ({}));
  terminalPageSnapshotProducerRef.current = () => ({
    activeSessionId: uiSessionId,
    activeSessionState: uiSession?.state || null,
    activeSessionRoute: {
      resolvedPath: uiSession?.resolvedPath || null,
      resolvedRelayTransport: uiSession?.resolvedRelayTransport || null,
      resolvedEndpoint: uiSession?.resolvedEndpoint || null,
      selectedIcePair: uiSession?.selectedIcePair || null,
      lastConnectStage: uiSession?.lastConnectStage || null,
      lastError: uiSession?.lastError || null,
    },
    sessionCount: sessions.length,
    splitVisible,
    layoutProfile,
    headerTopInsetPx,
    quickBarHeight,
    terminalChromeBottomPx,
    shellHeight,
    layoutViewportHeight: shellHeight,
    keyboardInset,
    keyboardViewportAlreadyResized,
    effectiveKeyboardLiftPx,
    terminalKeyboardRequested,
    quickBarEditorFocused,
    terminalImeActive,
    terminalImeLiftPx,
    quickBarShellKeyboardLiftPx,
    terminalBottomChromeLiftPx,
    terminalStageBottomPx,
    networkOnline,
    connectionIssueVisible,
    isAndroid,
    widthMode: terminalWidthMode,
  });
  useEffect(() => registerClientDebugSnapshotSource(
    'terminal-page',
    () => terminalPageSnapshotProducerRef.current(),
  ), []);
  const handleSetSplitCount = useCallback((count: number) => {
    setSplitCount(count);
  }, [setSplitCount]);

  const toggleSplitLayout = useCallback(() => {
    setSplitCount(splitVisible ? 1 : 2);
  }, [setSplitCount, splitVisible]);

  const cycleSecondaryPane = useCallback(() => {
    if (!splitVisible || workspace.panes.length < 2) {
      return;
    }
    const activePaneId = workspace.activePaneId;
    const passivePane = workspace.panes.find((pane) => pane.id !== activePaneId) || null;
    if (!passivePane || passivePane.tabs.length <= 1) {
      return;
    }
    const currentIndex = passivePane.tabs.findIndex((tab) => tab.id === passivePane.activeTabId);
    const nextIndex = (currentIndex + 1) % passivePane.tabs.length;
    const nextTab = passivePane.tabs[nextIndex];
    if (!nextTab) {
      return;
    }
    switchTabInPane(passivePane.id, nextTab.id);
  }, [splitVisible, switchTabInPane, workspace.activePaneId, workspace.panes]);

  const moveSessionToOtherPane = useCallback((sessionId: string) => {
    const pane = findPaneForSession(sessionId);
    if (!pane || workspace.panes.length < 2) {
      return;
    }
    const targetPane = workspace.panes.find((candidate) => candidate.id !== pane.id);
    if (!targetPane) {
      return;
    }
    assignSessionToPane(sessionId, targetPane.id);
  }, [assignSessionToPane, findPaneForSession, workspace.panes]);

  const activatePaneAndSession = useCallback((paneId: string) => {
    const normalizedPaneId = paneId.trim();
    if (!normalizedPaneId) {
      return;
    }
    const targetPane = workspace.panes.find((pane) => pane.id === normalizedPaneId) || null;
    if (!targetPane) {
      console.error('[TerminalPage] Refused to activate missing pane.', {
        paneId: normalizedPaneId,
        workspacePaneIds: workspace.panes.map((pane) => pane.id),
      });
      return;
    }
    const targetSessionId = targetPane.tabs.find((tab) => tab.id === targetPane.activeTabId)?.sessionId || null;
    setActivePane(normalizedPaneId);
    runtimeDebug('terminal.pane.activate', {
      paneId: normalizedPaneId,
      sessionId: targetSessionId,
      workspacePaneIds: workspace.panes.map((pane) => pane.id),
    });
    if (targetSessionId && targetSessionId !== activeSessionRef.current?.id) {
      onSwitchSession(targetSessionId);
    }
  }, [onSwitchSession, setActivePane, workspace.panes]);

  const handleSwitchSessionFromChrome = useCallback((sessionId: string) => {
    if (splitVisibleRef.current) {
      const targetPane = findPaneForSession(sessionId);
      if (!targetPane) {
        console.error('[TerminalPage] Refused to switch split tab without a pane owner.', {
          sessionId,
          workspacePaneIds: workspace.panes.map((pane) => pane.id),
        });
        return;
      }
      switchTabInPane(targetPane.id, `tab-${sessionId}`);
    }
    onSwitchSession(sessionId);
  }, [findPaneForSession, onSwitchSession, switchTabInPane, workspace.panes]);

  const activateSessionInViewportSlot = useCallback((sessionId: string) => {
    setSessionGroupSlotIds((current) => resolveTerminalSessionGroupSlotReplacement(
      current,
      sessionId,
      sessionGroupFocusSlot,
    ));
  }, [sessionGroupFocusSlot]);

  const handleActivateOpenSessionInViewport = useCallback((sessionId: string) => {
    activateSessionInViewportSlot(sessionId);
    handleSwitchSessionFromChrome(sessionId);
  }, [activateSessionInViewportSlot, handleSwitchSessionFromChrome]);

  const handleSelectSessionFromDrawer = useCallback((sessionId: string) => {
    const remoteTarget = drawerRemoteSessions.targets.get(sessionId);
    if (remoteTarget) {
      const openedSessionId = onOpenDrawerRemoteSession?.(remoteTarget.target, remoteTarget.sessionName);
      if (typeof openedSessionId === 'string' && openedSessionId.trim()) {
        activateSessionInViewportSlot(openedSessionId.trim());
      }
      setSessionDrawerOpen(false);
      return;
    }
    handleActivateOpenSessionInViewport(sessionId);
    setSessionDrawerOpen(false);
  }, [
    activateSessionInViewportSlot,
    drawerRemoteSessions.targets,
    handleActivateOpenSessionInViewport,
    onOpenDrawerRemoteSession,
  ]);

  const persistSessionPreviewSelection = useCallback((next: SessionPreviewSelectionV1) => {
    setSessionPreviewSelection(next);
    const storage = getBrowserStorage();
    if (!storage) {
      setSessionPreviewError('无法访问预览选择存储。');
      return;
    }
    const result = writeSessionPreviewSelection(storage, next);
    setSessionPreviewError(result.ok ? null : '保存预览选择失败。');
  }, []);

  const resolveSessionPreviewTargetFromDrawerSelection = useCallback((sessionId: string): SessionPreviewTarget | null => {
    const openSession = sessions.find((candidate) =>
      candidate.id === sessionId
      && !candidate.remoteMissing
      && candidate.state !== 'closed',
    );
    if (openSession) {
      return {
        sessionId: openSession.id,
        daemonHostId: openSession.daemonHostId,
        bridgeHost: openSession.bridgeHost,
        bridgePort: openSession.bridgePort,
        sessionName: openSession.sessionName,
      };
    }

    const remoteTarget = drawerRemoteSessions.targets.get(sessionId);
    if (!remoteTarget) {
      setSessionPreviewError('该 session 尚未打开，不能加入实时预览。');
      return null;
    }

    const openedSessionId = onOpenDrawerRemoteSession?.(remoteTarget.target, remoteTarget.sessionName, {
      activate: false,
      navigate: false,
    });
    const materializedSessionId = typeof openedSessionId === 'string' ? openedSessionId.trim() : '';
    if (!materializedSessionId) {
      setSessionPreviewError('无法打开该 session，不能加入实时预览。');
      return null;
    }

    const materializedSession = sessions.find((candidate) =>
      candidate.id === materializedSessionId
      && !candidate.remoteMissing
      && candidate.state !== 'closed',
    );
    if (materializedSession) {
      return {
        sessionId: materializedSession.id,
        daemonHostId: materializedSession.daemonHostId,
        bridgeHost: materializedSession.bridgeHost,
        bridgePort: materializedSession.bridgePort,
        sessionName: materializedSession.sessionName,
      };
    }

    return {
      sessionId: materializedSessionId,
      daemonHostId: remoteTarget.target.daemonHostId,
      bridgeHost: remoteTarget.target.bridgeHost,
      bridgePort: remoteTarget.target.bridgePort,
      sessionName: remoteTarget.sessionName,
    };
  }, [drawerRemoteSessions.targets, onOpenDrawerRemoteSession, sessions]);

  const handleToggleSessionPreviewSelection = useCallback((sessionId: string) => {
    const target = resolveSessionPreviewTargetFromDrawerSelection(sessionId);
    if (!target) {
      return;
    }
    const currentSelection = pruneSessionPreviewSelectionToOpenSessions(sessionPreviewSelection, sessions);
    const result = toggleSessionPreviewTarget(currentSelection, target);
    if (!result.ok) {
      setSessionPreviewError(result.reason === 'limit' ? '最多选择 6 个 session。' : '该 session 无法加入预览。');
      return;
    }
    persistSessionPreviewSelection(result.selection);
  }, [persistSessionPreviewSelection, resolveSessionPreviewTargetFromDrawerSelection, sessionPreviewSelection, sessions]);

  const handleSessionPreviewSelectionModeChange = useCallback((active: boolean) => {
    setSessionPreviewSelectionMode(active);
    setSessionPreviewError(null);
    if (!active) setSessionDrawerOpen(false);
  }, []);

  const handleReplaceSessionPreview = useCallback((sourceSessionId: string, replacementSessionId: string) => {
    const replacementSession = sessions.find((session) => session.id === replacementSessionId);
    if (!replacementSession) {
      setSessionPreviewError('替换目标已不在打开的 session 中。');
      return;
    }
    const result = replaceSessionPreviewTarget(sessionPreviewSelection, sourceSessionId, {
      sessionId: replacementSession.id,
      daemonHostId: replacementSession.daemonHostId,
      bridgeHost: replacementSession.bridgeHost,
      bridgePort: replacementSession.bridgePort,
      sessionName: replacementSession.sessionName,
    });
    if (!result.ok) {
      setSessionPreviewError(
        result.reason === 'already-selected'
          ? '该 session 已在预览中。'
          : '当前预览项已失效，无法替换。',
      );
      return;
    }
    persistSessionPreviewSelection(result.selection);
  }, [persistSessionPreviewSelection, sessionPreviewSelection, sessions]);

  const handleAddSessionPreview = useCallback((sessionId: string) => {
    const session = sessions.find((item) =>
      item.id === sessionId && !item.remoteMissing && item.state !== 'closed',
    );
    if (!session) {
      setSessionPreviewError('只能添加当前仍打开的 session。');
      return;
    }
    const currentSelection = pruneSessionPreviewSelectionToOpenSessions(sessionPreviewSelection, sessions);
    const result = appendSessionPreviewTarget(currentSelection, {
      sessionId: session.id,
      daemonHostId: session.daemonHostId,
      bridgeHost: session.bridgeHost,
      bridgePort: session.bridgePort,
      sessionName: session.sessionName,
    });
    if (!result.ok) {
      setSessionPreviewError(
        result.reason === 'limit'
          ? '最多选择 6 个 session。'
          : result.reason === 'already-selected'
            ? '该 session 已在预览中。'
            : '该 session 无法加入预览。',
      );
      return;
    }
    persistSessionPreviewSelection(result.selection);
  }, [persistSessionPreviewSelection, sessionPreviewSelection, sessions]);

  const handleMoveSessionPreview = useCallback((sourceSessionId: string, targetIndex: number) => {
    const currentSelection = pruneSessionPreviewSelectionToOpenSessions(sessionPreviewSelection, sessions);
    const result = moveSessionPreviewTarget(currentSelection, sourceSessionId, targetIndex);
    if (!result.ok) {
      setSessionPreviewError('当前预览项或目标位置已失效，无法移动。');
      return;
    }
    persistSessionPreviewSelection(result.selection);
  }, [persistSessionPreviewSelection, sessionPreviewSelection, sessions]);

  const handleOpenSessionPreview = useCallback(() => {
    if (sessionPreviewSessions.length === 0) {
      setSessionPreviewError('请先在抽屉中选择至少一个已打开的 session。');
      return;
    }
    if (keyboardInset > 0 || terminalKeyboardRequestedRef.current) {
      setSessionPreviewError('请先收起输入法再进入终端预览。');
      return;
    }
    sessionPreviewEntryRef.current = {
      activeSessionId: activeSession?.id || null,
      slotIds: { ...effectiveSessionGroupSlotIds },
      focusSlot: sessionGroupFocusSlot,
    };
    setSessionPreviewOpen(true);
  }, [activeSession?.id, effectiveSessionGroupSlotIds, keyboardInset, sessionGroupFocusSlot, sessionPreviewSessions.length]);

  const handleCancelSessionPreview = useCallback(() => {
    const entry = sessionPreviewEntryRef.current;
    sessionPreviewEntryRef.current = null;
    setSessionPreviewOpen(false);
    if (!entry) return;
    setSessionGroupSlotIds(entry.slotIds);
    setSessionGroupFocusSlot(entry.focusSlot);
    if (entry.activeSessionId && entry.activeSessionId !== activeSession?.id) {
      const entryStillOpen = sessions.some((session) => session.id === entry.activeSessionId);
      if (!entryStillOpen) {
        setSessionPreviewError('进入预览前的 session 已关闭，无法恢复。');
        return;
      }
      handleSwitchSessionFromChrome(entry.activeSessionId);
    }
  }, [activeSession?.id, handleSwitchSessionFromChrome, sessions]);

  const handleActivateSessionFromPreview = useCallback((sessionId: string) => {
    sessionPreviewEntryRef.current = null;
    handleActivateOpenSessionInViewport(sessionId);
    setSessionPreviewOpen(false);
  }, [handleActivateOpenSessionInViewport]);

  const handleRemoveSessionFromPreview = useCallback((sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      setSessionPreviewError('要移除的预览 session 已不在打开列表中。');
      return;
    }
    const currentSelection = pruneSessionPreviewSelectionToOpenSessions(sessionPreviewSelection, sessions);
    const result = removeSessionPreviewTarget(currentSelection, session.id);
    if (!result.ok) {
      setSessionPreviewError('无法从预览中移除该 session。');
      return;
    }
    persistSessionPreviewSelection(result.selection);
    if (result.selection.orderedTargets.length === 0) handleCancelSessionPreview();
  }, [handleCancelSessionPreview, persistSessionPreviewSelection, sessionPreviewSelection, sessions]);

  useEffect(() => {
    if (!sessionPreviewOpen) return;
    let disposed = false;
    let listenerHandle: { remove: () => Promise<void> | void } | null = null;
    void Promise.resolve(CapacitorApp.addListener('backButton', handleCancelSessionPreview))
      .then((handle) => {
        if (disposed) {
          void handle.remove();
          return;
        }
        listenerHandle = handle;
      })
      .catch((error) => {
        setSessionPreviewError(`系统返回监听失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      disposed = true;
      if (listenerHandle) void listenerHandle.remove();
    };
  }, [handleCancelSessionPreview, sessionPreviewOpen]);

  const handleAssignSessionGroupSlot = useCallback((sessionId: string, slot: TerminalSessionGroupSlotName) => {
    setSessionGroupSlotIds((current) => {
      const next: TerminalSessionGroupSlotIds = {
        top: current.top === sessionId ? null : current.top,
        center: current.center === sessionId ? null : current.center,
        bottom: current.bottom === sessionId ? null : current.bottom,
      };
      next[slot] = sessionId;
      return next;
    });
    if (slot === 'center') {
      setSessionGroupFocusSlot('center');
      handleSwitchSessionFromChrome(sessionId);
    }
  }, [handleSwitchSessionFromChrome]);

  const handleActivateSessionGroupSlot = useCallback((sessionId: string, sourceSlot?: TerminalSessionGroupSlotName) => {
    void sourceSlot;
    const fixedSlot = resolveSessionGroupSlot(sessionId);
    if (fixedSlot) {
      setSessionGroupFocusSlot(fixedSlot);
    }
    handleSwitchSessionFromChrome(sessionId);
  }, [handleSwitchSessionFromChrome, resolveSessionGroupSlot]);

  const handleCloseSessionFromDrawer = useCallback((sessionId: string) => {
    const remoteCloseTarget = drawerRemoteSessions.closeTargets.get(sessionId);
    if (remoteCloseTarget) {
      if (!onCloseDrawerRemoteSession) {
        window.alert?.('Remote close is unavailable.');
        return;
      }
      void Promise.resolve(onCloseDrawerRemoteSession(remoteCloseTarget.target, remoteCloseTarget.sessionName))
        .then(() => {
          if (remoteCloseTarget.localSessionId) {
            onCloseSession(remoteCloseTarget.localSessionId, 'terminal-session-drawer-remote-close-success');
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[TerminalPage] Failed to close remote tmux session from drawer:', error);
          window.alert?.(message);
        });
      return;
    }
    onCloseSession(sessionId, 'terminal-session-drawer-close-button');
  }, [drawerRemoteSessions.closeTargets, onCloseDrawerRemoteSession, onCloseSession]);

  const handleOpenQuickTabPickerForPane = useCallback((paneId?: string, hostKey?: string, createOptions?: { sessionName?: string; cwd?: string }) => {
    if (paneId) {
      activatePaneAndSession(paneId);
    }
    setSessionDrawerDebug((current) => ({
      ...current,
      lastEvent: 'page:open-picker',
      eventSeq: current.eventSeq + 1,
      pageCallbackSeq: current.pageCallbackSeq + 1,
    }));
    onOpenQuickTabPicker(paneId, hostKey, createOptions);
  }, [activatePaneAndSession, onOpenQuickTabPicker]);

  const handleOpenQuickTabPickerFromDrawer = useCallback((hostKey?: string, createOptions?: { sessionName?: string; cwd?: string }) => {
    setSessionDrawerDebug((current) => ({
      ...current,
      lastEvent: 'page:drawer-callback',
      eventSeq: current.eventSeq + 1,
      callbackSeq: current.callbackSeq + 1,
    }));
    setSessionDrawerOpen(false);
    handleOpenQuickTabPickerForPane(splitVisible ? workspace.activePaneId : undefined, hostKey, createOptions);
  }, [handleOpenQuickTabPickerForPane, splitVisible, workspace.activePaneId]);

  const handleSessionDrawerDebugAddEvent = useCallback((eventName: string) => {
    setSessionDrawerDebug((current) => ({
      ...current,
      lastEvent: eventName,
      eventSeq: current.eventSeq + 1,
    }));
  }, []);

  const handleOpenTabManager = useCallback((paneId?: string) => {
    setTabManagerScopePaneId(paneId || null);
    if (paneId) {
      activatePaneAndSession(paneId);
    }
    setTabManagerOpen(true);
  }, [activatePaneAndSession]);

  const handleTerminalViewportChange = useCallback<TerminalViewportChangeHandler>((sessionId, viewState) => {
    sessionViewportModeStoreRef.current.setMode(sessionId, viewState.mode);
    onTerminalViewportChange?.(sessionId, viewState);
  }, [onTerminalViewportChange]);

  const quickBarNode = useMemo(() => (
    <TerminalQuickBar
      activeSessionId={uiSessionId}
      quickActions={quickActions}
      shortcutActions={shortcutActions}
      onMeasuredHeightChange={handleQuickBarMeasuredHeightChange}
      onSendSequence={handleQuickBarSendSequence}
      onImagePaste={handleQuickBarImagePaste}
      onFileAttach={onFileAttach}
      keyboardVisible={terminalImeActive && effectiveKeyboardLiftPx > 0}
      keyboardInsetPx={quickBarShellKeyboardLiftPx}
      onToggleKeyboard={handleToggleKeyboard}
      onQuickActionsChange={onQuickActionsChange}
      onShortcutActionsChange={onShortcutActionsChange}
      sessionDraft={activeDraft}
      onSessionDraftChange={handleQuickBarSessionDraftChange}
      onSessionDraftSend={handleQuickBarSessionDraftSend}
      onOpenScheduleComposer={handleQuickBarOpenScheduleComposer}
      splitAvailable={splitAvailable}
      splitVisible={splitVisible}
      shellMode={layoutProfile.quickBar.shellMode}
      collapseAvailable
      collapsed={quickBarCollapsed}
      onCollapsedChange={setQuickBarCollapsed}
      currentSplitCount={workspacePanes.length}
      splitCountOptions={splitCountOptions}
      onSetSplitCount={handleSetSplitCount}
      onToggleSplitLayout={toggleSplitLayout}
      onCycleSplitPane={cycleSecondaryPane}
      onEditorDomFocusChange={handleQuickBarEditorDomFocusChange}
      onOpenFileTransfer={handleQuickBarOpenFileTransfer}
      onToggleDebugOverlay={handleQuickBarToggleDebugOverlay}
      copyModeActive={copySelection.active}
      onToggleCopyMode={handleQuickBarToggleCopyMode}
      copyDebugLabel={`IME KB:${keyboardInset} L:${effectiveKeyboardLiftPx} ST:${terminalStageBottomPx} VV:${visualViewportDebugWidth}x${visualViewportDebugHeight} SH:${shellHeight} R:${keyboardViewportAlreadyResized ? 'Y' : 'N'}`}
      onToggleAbsoluteLineNumbers={handleQuickBarToggleAbsoluteLineNumbers}
      onRequestRemoteScreenshot={handleQuickBarRequestRemoteScreenshot}
      debugOverlayVisible={debugOverlayVisible}
      absoluteLineNumbersVisible={absoluteLineNumbersVisible}
      remoteScreenshotStatus={resolveRemoteScreenshotQuickBarStatus(remoteScreenshotPreview)}
      remoteWindowInputActive={Boolean(remoteWindowInputContext)}
      shortcutSmartSort={shortcutSmartSort}
      shortcutFrequencyMap={shortcutFrequencyMap}
      onShortcutUse={onShortcutUse}
    />
  ), [
    absoluteLineNumbersVisible,
    activeDraft,
    uiSessionId,
    debugOverlayVisible,
    effectiveKeyboardLiftPx,
    handleSetSplitCount,
    handleQuickBarMeasuredHeightChange,
    handleQuickBarOpenFileTransfer,
    handleQuickBarOpenScheduleComposer,
    handleQuickBarRequestRemoteScreenshot,
    handleQuickBarSendSequence,
    handleQuickBarSessionDraftChange,
    handleQuickBarSessionDraftSend,
    handleQuickBarToggleAbsoluteLineNumbers,
    handleQuickBarToggleDebugOverlay,
    handleToggleKeyboard,
    handleQuickBarImagePaste,
    landscape,
    handleQuickBarEditorDomFocusChange,
    keyboardInset,
    keyboardViewportAlreadyResized,
    onFileAttach,
    onQuickActionsChange,
    onShortcutActionsChange,
    onShortcutUse,
    quickActions,
    quickBarShellKeyboardLiftPx,
    remoteScreenshotPreview?.phase,
    remoteWindowInputContext,
    shortcutActions,
    shortcutFrequencyMap,
    shortcutSmartSort,
    splitCountOptions,
    splitAvailable,
    splitVisible,
    quickBarCollapsed,
    cycleSecondaryPane,
    terminalImeActive,
    keyboardInset,
    terminalKeyboardRequested,
    terminalStageBottomPx,
    toggleSplitLayout,
    visualViewportDebugHeight,
    visualViewportDebugWidth,
    workspacePanes.length,
    shellHeight,
    layoutProfile.stage.containerRadius,
    layoutProfile.stage.outerMargin,
    layoutProfile.stage.paneGap,
    layoutProfile.stage.paneRadius,
    layoutProfile.stage.rowBottomPadding,
    copySelection.active,
    handleQuickBarToggleCopyMode,
  ]);

  return (
    <div
      style={{
        height: shellHeight ? `${shellHeight}px` : '100dvh',
        maxHeight: shellHeight ? `${shellHeight}px` : '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: mobileTheme.colors.shell,
      }}
    >
      {!portraitSessionDrawerEnabled ? (
        <div>
          <TerminalHeader
            sessions={chromeSessions}
            activeSession={activeChromeSession}
            topInsetPx={headerTopInsetPx}
            showBackButton
            onBack={onOpenConnections}
            onOpenQuickTabPicker={handleOpenQuickTabPickerForPane}
            onOpenTabManager={handleOpenTabManager}
            onSwitchSession={handleSwitchSessionFromChrome}
            onRenameSession={onRenameSession}
            onCloseSession={onCloseSession}
            onForceRelaySession={onForceRelaySession}
            onUseAutoSession={onUseAutoSession}
            splitVisible={splitVisible}
            paneGroups={paneGroups}
            onAssignSessionToPane={assignSessionToPane}
            onMoveSessionToOtherPane={moveSessionToOtherPane}
            onActivatePane={activatePaneAndSession}
          />
        </div>
      ) : null}
      <TerminalNetworkBanner
        connectionIssueVisible={connectionIssueVisible}
        networkOnline={networkOnline}
        activeSessionState={uiSession?.state}
        activeSessionLastError={uiSession?.lastError}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {portraitSessionDrawerEnabled ? (
          <>
            <TerminalConnectionStatusStrip
              session={uiSession}
              getSessionDebugMetrics={getSessionDebugMetrics}
              topInsetPx={headerTopInsetPx}
              onForceRelaySession={onForceRelaySession}
              onUseAutoSession={onUseAutoSession}
              onUseWebSocketSession={onUseWebSocketSession}
            />
            <button
              type="button"
              aria-label="返回连接列表"
              data-testid="terminal-portrait-back-button"
              onClick={onOpenConnections}
              style={{
                position: 'absolute',
                top: `${Math.max(8, headerTopInsetPx + 8)}px`,
                left: '10px',
                zIndex: 15,
                width: '34px',
                height: '34px',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(10, 16, 26, 0.64)',
                color: '#dce8ff',
                fontSize: '18px',
                lineHeight: 1,
                boxShadow: '0 8px 18px rgba(0,0,0,0.18)',
                backdropFilter: 'blur(8px)',
              }}
            >
              ←
            </button>
            {onOpenSettings ? (
              <button
                type="button"
                aria-label="设置和升级"
                data-testid="terminal-portrait-settings-button"
                onClick={onOpenSettings}
                style={{
                  position: 'absolute',
                  top: `${Math.max(8, headerTopInsetPx + 8)}px`,
                  right: '10px',
                  zIndex: 15,
                  minWidth: '64px',
                  height: '34px',
                  padding: '0 10px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(10, 16, 26, 0.64)',
                  color: '#dce8ff',
                  fontSize: '13px',
                  fontWeight: 850,
                  lineHeight: 1,
                  boxShadow: '0 8px 18px rgba(0,0,0,0.18)',
                  backdropFilter: 'blur(8px)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '5px',
                }}
              >
                <span aria-hidden="true" style={{ fontSize: '15px', lineHeight: 1 }}>⚙</span>
                <span>设置</span>
              </button>
            ) : null}
            <TerminalSessionDrawer
              open={sessionDrawerOpen}
              topInsetPx={headerTopInsetPx}
              bottomInsetPx={keyboardInset}
              sessions={drawerSessions}
              hosts={drawerHosts}
              onClose={() => setSessionDrawerOpen(false)}
              onSelectSession={handleSelectSessionFromDrawer}
              onCloseSession={handleCloseSessionFromDrawer}
              onAssignSessionGroupSlot={handleAssignSessionGroupSlot}
              sessionGroupLayoutAxis={sessionGroupLayoutAxis}
              onOpenQuickTabPicker={handleOpenQuickTabPickerFromDrawer}
              onRefreshHostSessions={onRefreshDrawerHostSessions}
              onDebugAddEvent={handleSessionDrawerDebugAddEvent}
              previewSelectionMode={sessionPreviewSelectionMode}
              previewSelectedSessionIds={sessionPreviewSessions.map((session) => session.id)}
              previewSelectionError={sessionPreviewError}
              onPreviewSelectionModeChange={handleSessionPreviewSelectionModeChange}
              onTogglePreviewSession={handleToggleSessionPreviewSelection}
              onClearPreviewSelection={() => persistSessionPreviewSelection({ version: 1, orderedTargets: [] })}
            />
          </>
        ) : null}
    <TerminalStageShell
      interactiveSession={interactiveSession}
      sessionBufferStore={sessionBufferStore}
      renderedPaneSessions={renderedPaneSessions}
      sessionGroupViewport={sessionGroupViewportSlotSessions}
      sessionGroupLayoutAxis={sessionGroupLayoutAxis}
      visiblePaneEntries={visiblePaneEntries}
          splitVisible={splitVisible}
          activePaneId={workspace.activePaneId}
          terminalChromeTopPx={terminalStageTopPx}
          terminalChromeBottomPx={terminalStageBottomPx}
          inputResetEpochBySession={inputResetEpochBySession}
          followResetEpoch={followResetEpoch}
          inputIntentFollowResetEpoch={inputIntentFollowResetEpoch}
          terminalKeyboardRequested={terminalKeyboardRequested}
          isAndroid={isAndroid}
          onResize={onResize}
          onTerminalInput={onTerminalInput}
          onTerminalWidthModeChange={onTerminalWidthModeChange}
          handleTerminalViewportChange={handleTerminalViewportChange}
          handleSwipeTab={handleSwipeTab}
          handleActiveTerminalActivateInput={handleActiveTerminalActivateInput}
          onActivatePane={activatePaneAndSession}
          onActivateSession={handleActivateSessionGroupSlot}
          onTerminalFocusOwnerActivate={handleTerminalFocusOwnerActivate}
          focusNonce={focusNonce}
          terminalFontSize={terminalFontSize}
          terminalThemeId={terminalThemeId}
          terminalWidthMode={terminalWidthMode}
          allowSessionDrawerSwipe={portraitSessionDrawerEnabled}
          absoluteLineNumbersVisible={absoluteLineNumbersVisible}
          copySelection={copySelection}
          onLongPressRow={handleLongPressCopyRow}
          sessionPreviewOpen={sessionPreviewOpen}
          sessionPreviewSessions={sessionPreviewSessions}
          sessionPreviewReplacementCandidates={sessionPreviewReplacementCandidates}
          onOpenSessionPreview={handleOpenSessionPreview}
          onCloseSessionPreview={handleCancelSessionPreview}
          onActivatePreviewSession={handleActivateSessionFromPreview}
          onAddPreviewSession={handleAddSessionPreview}
          onRemovePreviewSession={handleRemoveSessionFromPreview}
          onMovePreviewSession={handleMoveSessionPreview}
          onReplacePreviewSession={handleReplaceSessionPreview}
        />
        {copySelection.menu ? (
          <TerminalPageCopyMenu
            menu={copySelection.menu}
            viewportWidth={viewportWidth}
            headerTopInsetPx={headerTopInsetPx}
            startRowIndex={copySelection.startRowIndex}
            onSetStart={handleCopySelectionStart}
            onSetEnd={handleCopySelectionEnd}
            onCopy={handleCopySelectedText}
            onClose={handleCloseCopyMenu}
          />
        ) : null}
        <TerminalDebugOverlay
      visible={debugOverlayVisible}
      session={interactiveSession}
      visiblePaneSessions={renderedPaneSessions}
      sessionViewportModeStore={sessionViewportModeStoreRef.current}
      copySelection={copySelection}
      getSessionDebugMetrics={getSessionDebugMetrics}
      debugOverlayPos={debugOverlayPos}
      debugOverlayDragRef={debugOverlayDragRef}
          onClose={() => setDebugOverlayVisible(false)}
          onMove={setDebugOverlayPos}
          keyboardInset={keyboardInset}
          shellHeight={shellHeight}
          rawShellHeight={rawShellHeight}
          visualViewportHeight={visualViewportDebugHeight}
          visualViewportWidth={visualViewportDebugWidth}
          visualViewportOffsetTop={visualViewportDebugOffsetTop}
          currentLayoutViewportHeight={currentLayoutViewportDebugHeight}
          terminalKeyboardRequested={terminalKeyboardRequested}
          keyboardViewportAlreadyResized={keyboardViewportAlreadyResized}
          containerHeightPx={undefined}
          viewportRows={undefined}
          effectiveKeyboardLiftPx={effectiveKeyboardLiftPx}
          terminalImeLiftPx={terminalImeLiftPx}
          quickBarShellKeyboardLiftPx={quickBarShellKeyboardLiftPx}
          quickBarHeight={quickBarHeight}
          terminalChromeBottomPx={terminalStageBottomPx}
          layoutMode={layoutProfile.mode}
          landscape={landscape}
          splitVisible={splitVisible}
          quickBarCollapsed={quickBarCollapsed}
          sessionDrawerDebug={{
            open: sessionDrawerOpen,
            lastEvent: sessionDrawerDebug.lastEvent,
            eventSeq: sessionDrawerDebug.eventSeq,
            callbackSeq: sessionDrawerDebug.callbackSeq,
            pageCallbackSeq: sessionDrawerDebug.pageCallbackSeq,
            pickerMode: sessionPickerDebugMode,
          }}
          getRemoteWindowInputDebug={getRemoteWindowInputDebug}
        />
        <RemoteWindowOverlay
          activeSessionId={uiSessionId}
          appForegroundActive={appForegroundActive}
          streamInvalidation={remoteWindowStreamInvalidation}
          requestTargets={onRequestRemoteWindowTargets}
          startStream={onRequestRemoteWindowStreamStart}
          updateStreamQuality={onUpdateRemoteWindowStreamQuality}
          stopStream={onStopRemoteWindowStream}
          requestScreenshot={handleRequestRemoteWindowScreenshot}
          sendInput={onSendRemoteWindowInput}
          resizeTargetWindow={onResizeRemoteWindowTarget}
          onInputDebug={recordRemoteWindowInputDebug}
          bottomInsetPx={terminalChromeBottomPx + terminalImeLiftPx}
          bottomChromeInsetPx={terminalChromeBottomPx}
          onOpenStateChange={handleRemoteWindowOverlayOpenStateChange}
          onBodySubscriptionSuppressedChange={handleRemoteWindowBodySubscriptionSuppressedChange}
          onInputContextChange={handleRemoteWindowInputContextChange}
          onRequestKeyboard={handleRemoteWindowRequestKeyboard}
          onVideoDebug={recordRemoteWindowVideoDebug}
          onRemoteWindowMessage={onRemoteWindowMessage}
        />
        {!remoteWindowOverlayOpen ? (
          <TerminalQuickBarShell
            zIndex={remoteWindowInputContext ? 96 : 10}
            centered={Boolean(remoteWindowInputContext)}
            bottomPx={
              quickBarShellKeyboardLiftPx
              + layoutProfile.quickBar.touchSafeOffsetPx
              + terminalBottomChromeLiftPx
            }
          >
            {quickBarNode}
          </TerminalQuickBarShell>
        ) : null}
      </div>
      <TabManagerSheet
        open={tabManagerOpen}
        sessions={
          tabManagerScopePaneId
            ? chromeSessions.filter((session) => {
                const pane = findPaneForSession(session.id);
                return pane?.id === tabManagerScopePaneId;
              })
            : chromeSessions
        }
        activeSessionId={interactiveSession?.id}
        onClose={() => {
          setTabManagerOpen(false);
          setTabManagerScopePaneId(null);
        }}
        onSwitchSession={handleSwitchSessionFromChrome}
        onRenameSession={onRenameSession}
        onCloseSession={onCloseSession}
        onMoveSession={onMoveSession}
        onOpenQuickTabPicker={() => {
          setTabManagerOpen(false);
          const targetPaneId = tabManagerScopePaneId || undefined;
          setTabManagerScopePaneId(null);
          handleOpenQuickTabPickerForPane(targetPaneId);
        }}
      />
      {scheduleComposerTarget ? (
        <SessionScheduleSheet
          open={scheduleOpen}
          sessionName={scheduleComposerTarget.sessionName}
          scheduleState={frozenScheduleState || { sessionName: scheduleComposerTarget.sessionName, jobs: [], loading: false }}
          composerSeedText={scheduleComposerTarget.seedText}
          composerSeedNonce={scheduleComposerTarget.nonce}
          keyboardInset={keyboardInset}
          onClose={() => {
            setScheduleComposerTarget(null);
          }}
          onRefresh={() => onRequestScheduleList?.(scheduleComposerTarget.sessionId)}
          onSave={(job) => onUpsertScheduleJob?.(scheduleComposerTarget.sessionId, job)}
          onDelete={(jobId) => onDeleteScheduleJob?.(scheduleComposerTarget.sessionId, jobId)}
          onToggle={(jobId, enabled) => onToggleScheduleJob?.(scheduleComposerTarget.sessionId, jobId, enabled)}
          onRunNow={(jobId) => onRunScheduleJobNow?.(scheduleComposerTarget.sessionId, jobId)}
        />
      ) : null}
      {interactiveSession && onSendMessage && onFileTransferMessage ? (
        <FileTransferSheet
          open={fileTransferOpen}
          remoteCwd=""
          onClose={() => setFileTransferOpen(false)}
          sendJson={sendFileTransferMessage}
          onFileTransferMessage={onFileTransferMessage}
        />
      ) : null}
      <RemoteScreenshotSheet
        state={remoteScreenshotPreview}
        onSave={() => {
          void handleSaveRemoteScreenshot();
        }}
        onDiscard={closeRemoteScreenshotPreview}
      />
    </div>
  );
}

function terminalPagePropsEqual(
  prev: Readonly<TerminalPageProps>,
  next: Readonly<TerminalPageProps>,
) {
  return (
    prev.appForegroundActive === next.appForegroundActive
    && terminalPageHeaderSessionsUiKey(prev.sessions) === terminalPageHeaderSessionsUiKey(next.sessions)
    && terminalPageActiveRuntimeStatusKey(prev.activeSession)
      === terminalPageActiveRuntimeStatusKey(next.activeSession)
    && prev.getSessionDebugMetrics === next.getSessionDebugMetrics
    && prev.sessionBufferStore === next.sessionBufferStore
    && resolveSessionInputEpoch(prev.inputResetEpochBySession, prev.activeSession?.id)
      === resolveSessionInputEpoch(next.inputResetEpochBySession, next.activeSession?.id)
    && prev.followResetEpoch === next.followResetEpoch
    && prev.onSwitchSession === next.onSwitchSession
    && prev.onMoveSession === next.onMoveSession
    && prev.onRenameSession === next.onRenameSession
    && prev.onCloseSession === next.onCloseSession
    && prev.onForceRelaySession === next.onForceRelaySession
    && prev.onUseAutoSession === next.onUseAutoSession
    && prev.onUseWebSocketSession === next.onUseWebSocketSession
    && prev.onOpenConnections === next.onOpenConnections
    && prev.onOpenQuickTabPicker === next.onOpenQuickTabPicker
    && prev.onOpenDrawerRemoteSession === next.onOpenDrawerRemoteSession
    && prev.onCloseDrawerRemoteSession === next.onCloseDrawerRemoteSession
    && prev.onRefreshDrawerHostSessions === next.onRefreshDrawerHostSessions
    && prev.sessionGroups === next.sessionGroups
    && terminalPageRelayDevicesUiKey(prev.relayDevices) === terminalPageRelayDevicesUiKey(next.relayDevices)
    && terminalPageServerIdentityAliasInputsUiKey(prev.serverIdentityAliasInputs)
      === terminalPageServerIdentityAliasInputsUiKey(next.serverIdentityAliasInputs)
    && prev.onResize === next.onResize
    && prev.onTerminalInput === next.onTerminalInput
    && prev.onTerminalViewportChange === next.onTerminalViewportChange
    && prev.onLiveSessionIdsChange === next.onLiveSessionIdsChange
    && prev.onActiveBodySubscriptionSuppressedChange === next.onActiveBodySubscriptionSuppressedChange
    && prev.onImagePaste === next.onImagePaste
    && prev.onFileAttach === next.onFileAttach
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onRequestRemoteScreenshot === next.onRequestRemoteScreenshot
    && prev.onRequestRemoteWindowTargets === next.onRequestRemoteWindowTargets
    && prev.onRequestRemoteWindowStreamStart === next.onRequestRemoteWindowStreamStart
    && prev.onUpdateRemoteWindowStreamQuality === next.onUpdateRemoteWindowStreamQuality
    && prev.onStopRemoteWindowStream === next.onStopRemoteWindowStream
    && prev.onSendRemoteWindowInput === next.onSendRemoteWindowInput
    && prev.onResizeRemoteWindowTarget === next.onResizeRemoteWindowTarget
    && prev.onRemoteWindowMessage === next.onRemoteWindowMessage
    && prev.quickActions === next.quickActions
    && prev.shortcutActions === next.shortcutActions
    && prev.onQuickActionInput === next.onQuickActionInput
    && prev.onQuickActionsChange === next.onQuickActionsChange
    && prev.onShortcutActionsChange === next.onShortcutActionsChange
    && prev.sessionDraft === next.sessionDraft
    && prev.onSessionDraftChange === next.onSessionDraftChange
    && prev.onSessionDraftSend === next.onSessionDraftSend
    && prev.scheduleState === next.scheduleState
    && prev.getScheduleState === next.getScheduleState
    && prev.onRequestScheduleList === next.onRequestScheduleList
    && prev.onUpsertScheduleJob === next.onUpsertScheduleJob
    && prev.onDeleteScheduleJob === next.onDeleteScheduleJob
    && prev.onToggleScheduleJob === next.onToggleScheduleJob
    && prev.onRunScheduleJobNow === next.onRunScheduleJobNow
    && prev.terminalThemeId === next.terminalThemeId
    && prev.terminalWidthMode === next.terminalWidthMode
    && prev.terminalSessionGroupLayoutMode === next.terminalSessionGroupLayoutMode
    && prev.onTerminalWidthModeChange === next.onTerminalWidthModeChange
    && prev.onSendMessage === next.onSendMessage
    && prev.onFileTransferMessage === next.onFileTransferMessage
    && prev.shortcutSmartSort === next.shortcutSmartSort
    && prev.shortcutFrequencyMap === next.shortcutFrequencyMap
    && prev.onShortcutUse === next.onShortcutUse
  );
}

export const TerminalPage = ReactMemo(TerminalPageComponent, terminalPagePropsEqual);
