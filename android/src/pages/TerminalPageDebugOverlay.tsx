import { memo as ReactMemo, useEffect, useState } from "react";
import { APP_VERSION, APP_VERSION_CODE } from "../lib/app-version";
import { useSessionViewportModeSnapshot, type SessionViewportModeStore } from "../lib/session-viewport-mode-store";
import type { Session, SessionDebugOverlayMetrics } from "../lib/types";
import { formatDebugHz, formatDebugRate, resolveDebugStatus } from "./terminal-page-debug-helpers";

const TerminalDebugOverlay = ReactMemo(function TerminalDebugOverlay({
  visible,
  session,
  sessionViewportModeStore,
  getSessionDebugMetrics,
  debugOverlayPos,
  debugOverlayDragRef,
  onClose,
  onMove,
  keyboardInset,
  shellHeight,
  visualViewportHeight,
  terminalKeyboardRequested,
  containerHeightPx,
  viewportRows,
  copyModeActive,
  copyStartRowIndex,
  copySelection,
}: {
  visible: boolean;
  session: Session | null;
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
  visualViewportHeight?: number;
  terminalKeyboardRequested?: boolean;
  containerHeightPx?: number;
  viewportRows?: number;
  copyModeActive?: boolean;
  copyStartRowIndex?: number | null;
  copySelection?: { active: boolean; sessionId: string | null; startRowIndex: number | null; endRowIndex: number | null; menu: { x: number; y: number; rowIndex: number } | null } | undefined;
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
  const overlayStyle: React.CSSProperties = {
    position: "absolute",
    top: debugOverlayPos.y >= 0 ? `${debugOverlayPos.y}px` : "10px",
    left: debugOverlayPos.x >= 0 ? `${debugOverlayPos.x}px` : undefined,
    right: debugOverlayPos.x >= 0 ? undefined : "10px",
    zIndex: 12,
    minWidth: "88px",
    maxWidth: "96px",
    padding: "5px 6px",
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
          startPosX:
            debugOverlayPos.x >= 0
              ? debugOverlayPos.x
              : window.innerWidth - 10 - 96,
          startPosY: debugOverlayPos.y >= 0 ? debugOverlayPos.y : 10,
          dragging: false,
        };
      }}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        const dx = touch.clientX - debugOverlayDragRef.current.startX;
        const dy = touch.clientY - debugOverlayDragRef.current.startY;
        if (
          !debugOverlayDragRef.current.dragging &&
          Math.abs(dx) + Math.abs(dy) < 8
        )
          return;
        debugOverlayDragRef.current.dragging = true;
        e.preventDefault();
        const newX = debugOverlayDragRef.current.startPosX + dx;
        const newY = debugOverlayDragRef.current.startPosY + dy;
        const clampedX = Math.max(0, Math.min(newX, window.innerWidth - 96));
        const clampedY = Math.max(0, Math.min(newY, window.innerHeight - 80));
        onMove({ x: clampedX, y: clampedY });
      }}
      onTouchEnd={() => {
        debugOverlayDragRef.current.dragging = false;
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "4px",
          fontWeight: 700,
        }}
      >
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
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "4px",
          fontWeight: 700,
        }}
      >
        <span>渲染</span>
        <span
          style={{ color: viewportMode === "reading" ? "#fbbf24" : "#93c5fd" }}
        >
          {viewportMode}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "4px",
          fontWeight: 700,
        }}
      >
        <span>状态</span>
        <span
          style={{ color: metrics?.bufferPullActive ? "#86efac" : "#93c5fd" }}
        >
          {status}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "4px",
          fontWeight: 700,
        }}
      >
        <span>A</span>
        <span
          data-testid="terminal-debug-active-flag"
          style={{ color: metrics?.active ? "#86efac" : "#fca5a5" }}
        >
          {metrics?.active ? "1" : "0"}
        </span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>↑</span>
        <span>{formatDebugRate(metrics?.uplinkBps || 0)}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>↓</span>
        <span>{formatDebugRate(metrics?.downlinkBps || 0)}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>R</span>
        <span>{formatDebugHz(metrics?.renderHz || 0)}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>P</span>
        <span>{formatDebugHz(metrics?.pullHz || 0)}</span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "4px",
          marginTop: "2px",
        }}
      >
        <span>KB</span>
        <span
          style={{ color: (keyboardInset ?? 0) > 0 ? "#86efac" : "#fca5a5" }}
        >
          {keyboardInset ?? 0}
        </span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>IM</span>
        <span
          style={{ color: terminalKeyboardRequested ? "#86efac" : "#fca5a5" }}
        >
          {terminalKeyboardRequested ? "Y" : "N"}
        </span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>SH</span>
        <span>{shellHeight ?? "?"}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>VV</span>
        <span>{visualViewportHeight ?? "?"}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>CH</span>
        <span>{containerHeightPx ?? "?"}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>VR</span>
        <span>{viewportRows ?? "?"}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>CM</span>
        <span style={{ color: copyModeActive ? "#86efac" : "#fca5a5" }}>
          {copyModeActive ? "ON" : "OFF"}
        </span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>CS</span>
        <span>{copyStartRowIndex ?? "-"}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>CE</span>
        <span>{copySelection?.endRowIndex ?? "-"}</span>
      </div>
      <div
        style={{ display: "flex", justifyContent: "space-between", gap: "4px" }}
      >
        <span>MU</span>
        <span style={{ color: copySelection?.menu ? "#86efac" : "#fca5a5" }}>
          {copySelection?.menu
            ? `x=${copySelection.menu.x} y=${copySelection.menu.y} r=${copySelection.menu.rowIndex}`
            : "null"}
        </span>
      </div>
      <div
        style={{
          marginTop: "2px",
          paddingTop: "2px",
          borderTop: "1px solid rgba(255,255,255,0.10)",
          color: "rgba(231, 238, 252, 0.65)",
          fontSize: "7px",
          lineHeight: 1.2,
          wordBreak: "break-all",
        }}
      >
        V {APP_VERSION} / {APP_VERSION_CODE}
      </div>
    </div>
  );
});

export { TerminalDebugOverlay };
