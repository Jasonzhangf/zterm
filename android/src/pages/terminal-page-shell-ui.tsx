import { memo as ReactMemo, type ReactNode } from "react";
import type { Session } from "../lib/types";

export function copyMenuButtonStyle(disabled = false, subtle = false) {
  return {
    minHeight: "34px",
    padding: "0 12px",
    borderRadius: "12px",
    border: "1px solid var(--zterm-panel-border)",
    background: subtle
      ? "var(--zterm-panel-surface)"
      : disabled
        ? "var(--zterm-panel-surface)"
        : "var(--zterm-panel-active)",
    color: disabled ? "var(--zterm-panel-muted)" : "var(--zterm-panel-text)",
    fontSize: "13px",
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap" as const,
  };
}



const TerminalQuickBarShell = ReactMemo(function TerminalQuickBarShell({
  bottomPx,
  zIndex = 10,
  centered = false,
  children,
}: {
  bottomPx: number;
  zIndex?: number;
  centered?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="terminal-quickbar-shell"
      data-layout={centered ? 'remote-window-centered' : 'standard'}
      style={{
        position: "absolute",
        left: centered ? "50%" : 0,
        right: centered ? "auto" : 0,
        bottom: `${bottomPx}px`,
        zIndex,
        width: centered ? "min(calc(100vw - 24px), 720px)" : undefined,
        transform: centered ? "translateX(-50%)" : undefined,
        pointerEvents: "auto",
      }}
    >
      {children}
    </div>
  );
});



const TerminalNetworkBanner = ReactMemo(function TerminalNetworkBanner({
  connectionIssueVisible,
  activeSessionState,
}: {
  connectionIssueVisible: boolean;
  activeSessionState: Session["state"] | null | undefined;
  activeSessionLastError?: string;
}) {
  const networkBanner = !connectionIssueVisible
    ? null
    : activeSessionState === "error"
      ? {
          tone: "#ff6b6b",
          background: "rgba(109, 24, 33, 0.92)",
          border: "rgba(255, 107, 107, 0.42)",
          title: "连接失败",
          detail: "标准自动恢复流程未能恢复连接，请检查网络或服务器状态。",
        }
      : null;

  if (!networkBanner) {
    return null;
  }

  return (
    <div
      data-testid="terminal-network-banner"
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 10px)",
        left: 12,
        right: 12,
        zIndex: 140,
        pointerEvents: "none",
        padding: "9px 12px",
        borderRadius: "12px",
        border: `1px solid ${networkBanner.border}`,
        background: networkBanner.background,
        color: "#fff",
        boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
      }}
    >
      <div
        style={{ fontSize: "13px", fontWeight: 800, color: networkBanner.tone }}
      >
        {networkBanner.title}
      </div>
      <div
        style={{
          marginTop: "3px",
          fontSize: "12px",
          lineHeight: 1.35,
          color: "rgba(255,255,255,0.9)",
        }}
      >
        {networkBanner.detail}
      </div>
    </div>
  );
});

export { TerminalQuickBarShell, TerminalNetworkBanner };
