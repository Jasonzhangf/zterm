import { memo as ReactMemo, useEffect, useState } from "react";
import { useSessionViewportModeSnapshot, type SessionViewportModeStore } from "../lib/session-viewport-mode-store";
import type { Session, SessionDebugOverlayMetrics } from "../lib/types";
import { formatDebugHz, formatDebugRate, resolveDebugStatus } from "./terminal-page-debug-helpers";

export type RemoteWindowInputDebugSnapshot = {
  contextActive: boolean;
  contextLabel: string;
  sessionId: string;
  streamId: string;
  targetId: string;
  inputRoute: string;
  focusPolicy: string;
  lastSource: string;
  lastEvent: string;
  lastSent: boolean | null;
  lastAt: number | null;
  lastPoint: string;
  lastResult: string;
  lastResultAt: number | null;
  counts: {
    focus: number;
    pointerDown: number;
    pointerMove: number;
    pointerUp: number;
    click: number;
    scroll: number;
    key: number;
    text: number;
    accepted: number;
    error: number;
  };
  video: string;
};

const TerminalDebugOverlay = ReactMemo(function TerminalDebugOverlay({
  visible,
  session,
  visiblePaneSessions,
  sessionViewportModeStore,
  getSessionDebugMetrics,
  debugOverlayPos,
  debugOverlayDragRef,
  onClose,
  onMove,
  keyboardInset,
  shellHeight,
  rawShellHeight,
  visualViewportHeight,
  visualViewportWidth,
  visualViewportOffsetTop,
  currentLayoutViewportHeight,
  terminalKeyboardRequested,
  keyboardViewportAlreadyResized,
  containerHeightPx,
  viewportRows,
  copyModeActive,
  copyStartRowIndex,
  effectiveKeyboardLiftPx,
  terminalImeLiftPx,
  quickBarShellKeyboardLiftPx,
  quickBarHeight,
  terminalChromeBottomPx,
  layoutMode,
  landscape,
  splitVisible,
  quickBarCollapsed,
  copySelection,
  sessionDrawerDebug,
  getRemoteWindowInputDebug,
}: {
  visible: boolean;
  session: Session | null;
  visiblePaneSessions?: Session[];
  sessionViewportModeStore: SessionViewportModeStore;
  getSessionDebugMetrics?: (
    sessionId: string,
  ) => SessionDebugOverlayMetrics | null;
  debugOverlayPos: { x: number; y: number };
  debugOverlayDragRef: React.MutableRefObject<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    dragging: boolean;
  }>;
  onClose: () => void;
  onMove: (next: { x: number; y: number }) => void;
  keyboardInset?: number;
  shellHeight?: number;
  rawShellHeight?: number;
  visualViewportHeight?: number;
  visualViewportWidth?: number;
  visualViewportOffsetTop?: number;
  currentLayoutViewportHeight?: number;
  terminalKeyboardRequested?: boolean;
  keyboardViewportAlreadyResized?: boolean;
  containerHeightPx?: number;
  viewportRows?: number;
  copyModeActive?: boolean;
  copyStartRowIndex?: number | null;
  effectiveKeyboardLiftPx?: number;
  terminalImeLiftPx?: number;
  quickBarShellKeyboardLiftPx?: number;
  quickBarHeight?: number;
  terminalChromeBottomPx?: number;
  layoutMode?: string;
  landscape?: boolean;
  splitVisible?: boolean;
  quickBarCollapsed?: boolean;
  copySelection?: { active: boolean; sessionId: string | null; startRowIndex: number | null; endRowIndex: number | null; menu: { x: number; y: number; rowIndex: number } | null } | undefined;
  sessionDrawerDebug?: {
    open: boolean;
    lastEvent: string;
    eventSeq: number;
    callbackSeq: number;
    pageCallbackSeq: number;
    pickerMode: string | null;
  };
  getRemoteWindowInputDebug?: () => RemoteWindowInputDebugSnapshot;
}) {
  const [tick, setTick] = useState(0);
  const viewportModeSnapshot = useSessionViewportModeSnapshot(
    sessionViewportModeStore,
    session?.id || null,
  );

  useEffect(() => {
    if (!visible || !session) {
      return;
    }
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 500);
    return () => window.clearInterval(timer);
  }, [session, visible]);

  void tick;

  if (!visible || !session) {
    return null;
  }

  const metrics = getSessionDebugMetrics
    ? getSessionDebugMetrics(session.id) || undefined
    : undefined;
  const status = resolveDebugStatus(session, metrics);
  const viewportMode = viewportModeSnapshot.mode;
  const sessionLabel = session.customName?.trim() || session.title || session.sessionName;
  const routeLabel = [
    session.resolvedPath || '-',
    session.resolvedRelayTransport || null,
    session.lastConnectStage || null,
  ].filter(Boolean).join(' / ');
  const icePairLabel = formatIcePairLabel(session.selectedIcePair);
  const remoteWindowInputDebug = getRemoteWindowInputDebug?.();
  const overlayStyle: React.CSSProperties = {
    position: "absolute",
    top: debugOverlayPos.y >= 0 ? `${debugOverlayPos.y}px` : "10px",
    left: debugOverlayPos.x >= 0 ? `${debugOverlayPos.x}px` : undefined,
    right: debugOverlayPos.x >= 0 ? undefined : "10px",
    zIndex: 120,
    width: "192px",
    padding: "6px 7px",
    borderRadius: "10px",
    border: `1.5px solid ${metrics?.bufferPullActive ? "rgba(34, 197, 94, 0.6)" : "rgba(83, 139, 255, 0.6)"}`,
    background: "rgba(10, 16, 26, 0.35)",
    boxShadow: "0 8px 18px rgba(0, 0, 0, 0.10)",
    color: "rgba(231, 238, 252, 0.78)",
    fontSize: "8px",
    lineHeight: 1.25,
    backdropFilter: "blur(8px)",
    pointerEvents: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    touchAction: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
  };

  return (
    <div
      style={overlayStyle}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        debugOverlayDragRef.current = {
          startX: touch.clientX,
          startY: touch.clientY,
          startPosX: debugOverlayPos.x >= 0 ? debugOverlayPos.x : window.innerWidth - 10 - 192,
          startPosY: debugOverlayPos.y >= 0 ? debugOverlayPos.y : 10,
          dragging: false,
        };
      }}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        const dx = touch.clientX - debugOverlayDragRef.current.startX;
        const dy = touch.clientY - debugOverlayDragRef.current.startY;
        if (!debugOverlayDragRef.current.dragging && Math.abs(dx) + Math.abs(dy) < 8) {
          return;
        }
        debugOverlayDragRef.current.dragging = true;
        e.preventDefault();
        const newX = debugOverlayDragRef.current.startPosX + dx;
        const newY = debugOverlayDragRef.current.startPosY + dy;
        const clampedX = Math.max(0, Math.min(newX, window.innerWidth - 192));
        const clampedY = Math.max(0, Math.min(newY, window.innerHeight - 132));
        onMove({ x: clampedX, y: clampedY });
      }}
      onTouchEnd={() => {
        debugOverlayDragRef.current.dragging = false;
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px", fontWeight: 700 }}>
        <span>状态</span>
        <button
          type="button"
          aria-label="关闭调试浮窗"
          onClick={onClose}
          style={{
            width: "12px",
            height: "12px",
            padding: 0,
            border: "none",
            borderRadius: "999px",
            background: "rgba(255,255,255,0.12)",
            color: "#e7eefc",
            fontSize: "9px",
            lineHeight: "12px",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>
      <div
        data-testid="terminal-debug-ime-metrics"
        style={{
          display: "grid",
          gridTemplateColumns: "44px 1fr",
          columnGap: "6px",
          rowGap: "3px",
          marginTop: "4px",
          paddingTop: "4px",
          borderTop: "1px solid rgba(255,255,255,0.10)",
          color: "rgba(231, 238, 252, 0.86)",
          fontVariantNumeric: "tabular-nums",
          wordBreak: "break-word",
        }}
      >
        <span>会话</span><span>{sessionLabel} · {session.id}</span>
        <span>状态</span>
        <span
          data-testid="terminal-debug-active-flag"
          style={{ color: metrics?.bufferPullActive ? "#86efac" : "#93c5fd" }}
        >
          {session.state}{metrics ? ` / ${status}` : ""}{metrics?.active ? " · A" : ""}
        </span>
        <span>渲染</span><span>{viewportMode}</span>
        <span>路由</span><span>{routeLabel}</span>
        {icePairLabel ? (
          <>
            <span>ICE</span><span>{icePairLabel}</span>
          </>
        ) : null}
        {remoteWindowInputDebug ? (
          <>
            <span>远控</span>
            <span data-testid="terminal-debug-remote-window-context">
              CTX {remoteWindowInputDebug.contextActive ? "Y" : "N"}
              {" · "}
              {remoteWindowInputDebug.contextLabel}
              {" · "}
              {remoteWindowInputDebug.inputRoute}/{remoteWindowInputDebug.focusPolicy}
            </span>
            <span>RWID</span>
            <span data-testid="terminal-debug-remote-window-id">
              c={remoteWindowInputDebug.sessionId} · s={remoteWindowInputDebug.streamId} · t={remoteWindowInputDebug.targetId}
            </span>
            <span>RW事件</span>
            <span data-testid="terminal-debug-remote-window-event">
              {remoteWindowInputDebug.lastSource}
              {" · "}
              SEND {remoteWindowInputDebug.lastSent === null ? "-" : remoteWindowInputDebug.lastSent ? "Y" : "N"}
              {" · "}
              {remoteWindowInputDebug.lastEvent}
              {" · "}
              {formatRemoteWindowInputDebugAge(remoteWindowInputDebug.lastAt)}
            </span>
            <span>RW点</span>
            <span data-testid="terminal-debug-remote-window-point">{remoteWindowInputDebug.lastPoint}</span>
            <span>RW结果</span>
            <span data-testid="terminal-debug-remote-window-result">
              {remoteWindowInputDebug.lastResult}
              {" · "}
              {formatRemoteWindowInputResultAge(remoteWindowInputDebug.lastResultAt)}
            </span>
            <span>RW计数</span>
            <span data-testid="terminal-debug-remote-window-counts">
              F {remoteWindowInputDebug.counts.focus}
              {" · "}
              D {remoteWindowInputDebug.counts.pointerDown}
              {" · "}
              M {remoteWindowInputDebug.counts.pointerMove}
              {" · "}
              U {remoteWindowInputDebug.counts.pointerUp}
              {" · "}
              C {remoteWindowInputDebug.counts.click}
              {" · "}
              S {remoteWindowInputDebug.counts.scroll}
              {" · "}
              K {remoteWindowInputDebug.counts.key}
              {" · "}
              T {remoteWindowInputDebug.counts.text}
              {" · "}
              A {remoteWindowInputDebug.counts.accepted}
              {" · "}
              E {remoteWindowInputDebug.counts.error}
            </span>
            <span>视频</span>
            <span data-testid="terminal-debug-remote-window-video">{remoteWindowInputDebug.video}</span>
          </>
        ) : null}
        <span>窗格</span><span>x{visiblePaneSessions && visiblePaneSessions.length > 0 ? visiblePaneSessions.length : 1}</span>
        <span>刷新</span><span>{formatDebugHz(metrics?.renderHz || 0)} / {formatDebugHz(metrics?.pullHz || 0)}</span>
        <span>流量</span>
        <span>
          ↑ {formatDebugRate(metrics?.uplinkBps || 0)} ↓ {formatDebugRate(metrics?.downlinkBps || 0)}
          {" · "}
          buf {formatDebugBytes(metrics?.transportBufferedBytes || 0)}
          {metrics?.transportBackpressured ? " · BP" : ""}
        </span>
        <span>视图</span>
        <span>
          LP {layoutMode ?? "?"} · LS {landscape ? "Y" : "N"} · SP {splitVisible ? "Y" : "N"} · QC {quickBarCollapsed ? "Y" : "N"}
        </span>
        <span>IME</span>
        <span>
          KB {keyboardInset ?? 0} · RESZ {keyboardViewportAlreadyResized ? "Y" : "N"} · IME {terminalKeyboardRequested ? "Y" : "N"}
          {" · "}
          SH {shellHeight ?? "?"} / RAW {rawShellHeight ?? "?"}
          {" · "}
          VV {visualViewportHeight ?? "?"}x{visualViewportWidth ?? "?"}@{visualViewportOffsetTop ?? "?"}
          {" · "}
          CUR {currentLayoutViewportHeight ?? "?"} · CH {containerHeightPx ?? "?"} · VR {viewportRows ?? "?"}
          {" · "}
          IMEL {terminalImeLiftPx ?? 0} / QBL {quickBarShellKeyboardLiftPx ?? 0} / LIFT {effectiveKeyboardLiftPx ?? 0}
          {" · "}
          QB {quickBarHeight ?? "?"} · TB {terminalChromeBottomPx ?? "?"}
        </span>
        <span>复制</span>
        <span>
          {copyModeActive ? "ON" : "OFF"}
          {" · "}
          CS {copyStartRowIndex ?? "-"} · CE {copySelection?.endRowIndex ?? "-"}
          {copySelection?.menu ? ` · MU ${copySelection.menu.rowIndex}` : ""}
        </span>
        {sessionDrawerDebug ? (
          <>
            <span>抽屉</span>
            <span>
              {sessionDrawerDebug.open ? "OPEN" : "CLOSED"}
              {" · "}
              EV {sessionDrawerDebug.eventSeq}:{sessionDrawerDebug.lastEvent}
              {" · "}
              CB {sessionDrawerDebug.callbackSeq}/{sessionDrawerDebug.pageCallbackSeq}
              {" · "}
              PM {sessionDrawerDebug.pickerMode || "-"}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
});

function formatDebugBytes(bytes: number) {
  const safeValue = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (safeValue >= 1024 * 1024) {
    return `${(safeValue / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (safeValue >= 1024) {
    return `${(safeValue / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(safeValue)} B`;
}

function formatRemoteWindowInputDebugAge(lastAt: number | null) {
  if (!lastAt) {
    return "-";
  }
  const ageMs = Math.max(0, Date.now() - lastAt);
  if (ageMs < 1000) {
    return `${Math.round(ageMs)}ms`;
  }
  return `${Math.round(ageMs / 1000)}s`;
}

function formatRemoteWindowInputResultAge(lastAt: number | null) {
  return formatRemoteWindowInputDebugAge(lastAt);
}

function formatIceCandidateLabel(candidate?: Session['selectedIcePair'] extends infer T
  ? T extends { local?: infer C } ? C : never
  : never) {
  if (!candidate) {
    return '-';
  }
  const address = typeof candidate.address === 'string' && candidate.address.trim()
    ? candidate.address.trim()
    : '';
  const port = typeof candidate.port === 'number' ? `:${candidate.port}` : '';
  const protocol = candidate.protocol ? `/${candidate.protocol}` : '';
  return [
    candidate.candidateType || '?',
    address ? `${address}${port}` : '',
    protocol,
  ].filter(Boolean).join(' ');
}

function formatIcePairLabel(pair?: Session['selectedIcePair']) {
  if (!pair?.local && !pair?.remote) {
    return '';
  }
  const rtt = typeof pair.roundTripTimeMs === 'number' ? ` · ${pair.roundTripTimeMs}ms` : '';
  return `L ${formatIceCandidateLabel(pair.local)} / R ${formatIceCandidateLabel(pair.remote)}${rtt}`;
}

export { TerminalDebugOverlay };
