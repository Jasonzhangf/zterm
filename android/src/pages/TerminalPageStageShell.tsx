import { memo as ReactMemo, useCallback, useMemo } from "react";
import { TerminalView } from "../components/TerminalView";
import type { SessionRenderBufferStore } from "../lib/session-render-buffer-store";
import { TerminalTabSwipeSurface } from "../components/terminal/TerminalTabSwipeSurface";
import { resolveTerminalLayoutProfile } from "../lib/terminal-layout-profile";
import { resolveTerminalOrientation } from "../lib/terminal-viewport-metrics";
import { mobileTheme } from "../lib/mobile-ui";
import { terminalPageRenderedSessionUiKey, terminalPageRenderedSessionsUiKey, resolveRenderedSessionsInputEpochKey } from "./terminal-page-render-keys";
import type { AndroidWorkspacePane, Session, TerminalResizeHandler, TerminalViewportChangeHandler, TerminalWidthMode } from "../lib/types";
import type { CopySelectionState } from "./useTerminalPageCopyRuntime";

const TerminalStageShell = ReactMemo(
  function TerminalStageShell({
    interactiveSession,
    sessionBufferStore,
    renderedPaneSessions,
    visiblePaneEntries,
    splitVisible,
    activePaneId,
    terminalChromeBottomPx,
    terminalImeLiftPx,
    inputResetEpochBySession,
    followResetEpoch,
    terminalKeyboardRequested,
    isAndroid,
    onResize,
    onTerminalInput,
    onTerminalWidthModeChange,
    handleTerminalViewportChange,
    handleSwipeTab,
    handleActiveTerminalActivateInput,
    onActivatePane,
    focusNonce,
    terminalFontSize,
    terminalThemeId,
    terminalWidthMode,
    absoluteLineNumbersVisible,
    copySelection,
    onLongPressRow,
  }: {
    interactiveSession: Session | null;
    sessionBufferStore?: SessionRenderBufferStore | null;
    renderedPaneSessions: Session[];
    visiblePaneEntries: {
      pane: AndroidWorkspacePane;
      paneIndex: number;
      session: Session;
    }[];
    splitVisible: boolean;
    activePaneId: string;
    terminalChromeBottomPx: number;
    terminalImeLiftPx: number;
    inputResetEpochBySession?: Record<string, number>;
    followResetEpoch?: number;
    terminalKeyboardRequested: boolean;
    isAndroid: boolean;
    onResize?: TerminalResizeHandler;
    onTerminalInput?: (sessionId: string, data: string) => void;
    onTerminalWidthModeChange?: (
      sessionId: string,
      mode: TerminalWidthMode,
      cols?: number | null,
    ) => void;
    handleTerminalViewportChange: TerminalViewportChangeHandler;
    handleSwipeTab: (sessionId: string, direction: "previous" | "next") => void;
    handleActiveTerminalActivateInput: () => void;
    onActivatePane?: (paneId: string) => void;
    focusNonce: number;
    terminalFontSize: number;
    terminalThemeId?: string;
    terminalWidthMode: TerminalWidthMode;
    absoluteLineNumbersVisible: boolean;
    copySelection: CopySelectionState;
    onLongPressRow: (
      sessionId: string,
      rowIndex: number,
      clientX: number,
      clientY: number,
    ) => void;
  }) {
    const landscape =
      typeof window !== "undefined"
        ? resolveTerminalOrientation() === "landscape"
        : false;
    const layoutProfile = useMemo(
      () => resolveTerminalLayoutProfile({ splitVisible, landscape }),
      [landscape, splitVisible],
    );

    const renderTerminal = useCallback(
      (
        session: Session,
        sessionIsActive: boolean,
        renderInstanceKey?: string,
      ) => (
        <TerminalTabSwipeSurface
          key={renderInstanceKey || session.id}
          sessionId={session.id}
          active={sessionIsActive}
          enabled={terminalWidthMode !== "mirror-fixed"}
          onSwipeTab={handleSwipeTab}
        >
          <TerminalView
            sessionId={session.id}
            sessionBufferStore={sessionBufferStore}
            active={sessionIsActive}
            live
            inputResetEpoch={inputResetEpochBySession?.[session.id] || 0}
            followResetEpoch={sessionIsActive ? followResetEpoch : 0}
            allowDomFocus={
              isAndroid ? false : sessionIsActive && terminalKeyboardRequested
            }
            domInputOffscreen={isAndroid}
            onActivateInput={
              isAndroid && sessionIsActive
                ? handleActiveTerminalActivateInput
                : undefined
            }
            onResize={sessionIsActive && !isAndroid ? onResize : undefined}
            onWidthModeChange={
              sessionIsActive ? onTerminalWidthModeChange : undefined
            }
            onInput={sessionIsActive ? onTerminalInput : undefined}
            onViewportChange={handleTerminalViewportChange}
            focusNonce={isAndroid ? 0 : sessionIsActive ? focusNonce : 0}
            fontSize={terminalFontSize}
            rowHeight={`${Math.max(terminalFontSize + 4, Math.ceil(terminalFontSize * 1.5))}px`}
            themeId={terminalThemeId || "default"}
            widthMode={terminalWidthMode}
            showAbsoluteLineNumbers={absoluteLineNumbersVisible}
            copyModeActive={
              copySelection.active &&
              (copySelection.sessionId === null ||
                copySelection.sessionId === session.id)
            }
            copyStartRowIndex={
              copySelection.sessionId === session.id
                ? copySelection.startRowIndex
                : null
            }
            copyEndRowIndex={
              copySelection.sessionId === session.id
                ? copySelection.endRowIndex
                : null
            }
            copyPreviewRowIndex={
              copySelection.sessionId === session.id
                ? (copySelection.menu?.rowIndex ?? null)
                : null
            }
            onLongPressRow={onLongPressRow}
          />
        </TerminalTabSwipeSurface>
      ),
      [
        absoluteLineNumbersVisible,
        focusNonce,
        followResetEpoch,
        handleActiveTerminalActivateInput,
        handleSwipeTab,
        handleTerminalViewportChange,
        inputResetEpochBySession,
        isAndroid,
        onResize,
        onTerminalInput,
        onTerminalWidthModeChange,
        sessionBufferStore,
        terminalFontSize,
        terminalKeyboardRequested,
        terminalThemeId,
        terminalWidthMode,
        layoutProfile.stage.containerRadius,
        layoutProfile.stage.outerMargin,
        layoutProfile.stage.paneGap,
        layoutProfile.stage.paneRadius,
        layoutProfile.stage.rowBottomPadding,
        copySelection,
        onLongPressRow,
      ],
    );

    return (
      <div
        data-testid="terminal-stage-shell"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: `${terminalChromeBottomPx + terminalImeLiftPx}px`,
          display: "flex",
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            margin: layoutProfile.stage.outerMargin,
            borderRadius: layoutProfile.stage.containerRadius,
            backgroundColor: splitVisible
              ? "transparent"
              : mobileTheme.colors.canvas,
            overflow: "hidden",
            border: splitVisible
              ? "none"
              : `1px solid ${mobileTheme.colors.cardBorder}`,
            position: "relative",
            overscrollBehaviorY: "contain",
          }}
        >
          {interactiveSession ? (
            splitVisible ? (
              <div
                style={{
                  flex: 1,
                  height: "100%",
                  minHeight: 0,
                  display: "flex",
                  gap: layoutProfile.stage.paneGap,
                  padding: layoutProfile.stage.rowBottomPadding,
                }}
              >
                {visiblePaneEntries.map(({ pane, session }) => {
                  const paneIsActive = pane.id === activePaneId;
                  const sessionIsActive = session.id === interactiveSession?.id;
                  return (
                    <div
                      key={pane.id}
                      data-testid="terminal-pane-shell"
                      data-pane-id={pane.id}
                      onPointerDown={() => onActivatePane?.(pane.id)}
                      style={{
                        flex: `${Math.max(0.01, pane.size ?? 1)} 1 0%`,
                        minWidth: 0,
                        height: "100%",
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                        borderRadius: layoutProfile.stage.paneRadius,
                        backgroundColor: mobileTheme.colors.canvas,
                        overflow: "hidden",
                        border: `1px solid ${mobileTheme.colors.cardBorder}`,
                        outline: paneIsActive
                          ? "2px solid rgba(83, 139, 255, 0.78)"
                          : undefined,
                        outlineOffset: paneIsActive ? "-2px" : undefined,
                        boxSizing: "border-box",
                        cursor: !paneIsActive ? "pointer" : undefined,
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          minHeight: 0,
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        {renderTerminal(
                          session,
                          sessionIsActive,
                          `${pane.id}:${session.id}`,
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              renderedPaneSessions.map((session) => {
                const sessionIsActive = session.id === interactiveSession?.id;
                return (
                  <div
                    key={session.id}
                    style={{
                      position: "absolute",
                      inset: 0,
                      visibility: sessionIsActive ? "visible" : "hidden",
                      opacity: sessionIsActive ? 1 : 0,
                      zIndex: sessionIsActive ? 1 : 0,
                      pointerEvents: sessionIsActive ? "auto" : "none",
                      overflow: "hidden",
                    }}
                  >
                    {renderTerminal(session, sessionIsActive, session.id)}
                  </div>
                );
              })
            )
          ) : (
            <div
              style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: mobileTheme.colors.textSecondary,
                gap: "10px",
              }}
            >
              <div style={{ fontSize: "18px", fontWeight: 700 }}>
                No terminal attached
              </div>
              <div style={{ fontSize: "14px" }}>
                Go back to Connections and open a host card.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    terminalPageRenderedSessionUiKey(prev.interactiveSession) ===
      terminalPageRenderedSessionUiKey(next.interactiveSession) &&
    terminalPageRenderedSessionsUiKey(prev.renderedPaneSessions) ===
      terminalPageRenderedSessionsUiKey(next.renderedPaneSessions) &&
    prev.sessionBufferStore === next.sessionBufferStore &&
    prev.splitVisible === next.splitVisible &&
    prev.activePaneId === next.activePaneId &&
    prev.terminalChromeBottomPx === next.terminalChromeBottomPx &&
    prev.terminalImeLiftPx === next.terminalImeLiftPx &&
    resolveRenderedSessionsInputEpochKey(
      prev.inputResetEpochBySession,
      prev.renderedPaneSessions,
    ) ===
      resolveRenderedSessionsInputEpochKey(
        next.inputResetEpochBySession,
        next.renderedPaneSessions,
      ) &&
    prev.followResetEpoch === next.followResetEpoch &&
    prev.terminalKeyboardRequested === next.terminalKeyboardRequested &&
    prev.isAndroid === next.isAndroid &&
    prev.onResize === next.onResize &&
    prev.onTerminalInput === next.onTerminalInput &&
    prev.onTerminalWidthModeChange === next.onTerminalWidthModeChange &&
    prev.handleTerminalViewportChange === next.handleTerminalViewportChange &&
    prev.handleSwipeTab === next.handleSwipeTab &&
    prev.handleActiveTerminalActivateInput ===
      next.handleActiveTerminalActivateInput &&
    prev.focusNonce === next.focusNonce &&
    prev.terminalFontSize === next.terminalFontSize &&
    prev.terminalThemeId === next.terminalThemeId &&
    prev.terminalWidthMode === next.terminalWidthMode &&
    prev.absoluteLineNumbersVisible === next.absoluteLineNumbersVisible &&
    prev.copySelection === next.copySelection &&
    prev.onLongPressRow === next.onLongPressRow &&
    prev.visiblePaneEntries
      .map((entry) => `${entry.pane.id}:${entry.session.id}`)
      .join("||") ===
      next.visiblePaneEntries
        .map((entry) => `${entry.pane.id}:${entry.session.id}`)
        .join("||") &&
    prev.onActivatePane === next.onActivatePane,
);

export { TerminalStageShell };
