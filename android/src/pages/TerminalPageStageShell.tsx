import { memo as ReactMemo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaneStage, type PaneSlotDefinition } from "@zterm/shared";
import { TerminalView } from "../components/TerminalView";
import type { SessionRenderBufferStore } from "../lib/session-render-buffer-store";
import { TerminalTabSwipeSurface } from "../components/terminal/TerminalTabSwipeSurface";
import { resolveTerminalOrientation } from "../lib/terminal-viewport-metrics";
import { resolveTerminalLayoutProfile } from "../lib/terminal-layout-profile";
import { mobileTheme } from "../lib/mobile-ui";
import { terminalPageRenderedSessionUiKey, terminalPageRenderedSessionsUiKey, resolveRenderedSessionsInputEpochKey } from "./terminal-page-render-keys";
import type { AndroidWorkspacePane, Session, TerminalResizeHandler, TerminalViewportChangeHandler, TerminalWidthMode } from "../lib/types";
import type { CopySelectionState } from "./useTerminalPageCopyRuntime";

export interface TerminalSessionGroupSlots {
  top: Session | null;
  center: Session | null;
  bottom: Session | null;
}

type TerminalSessionGroupSlotName = "top" | "center" | "bottom";

const TerminalStageShell = ReactMemo(
  function TerminalStageShell({
    interactiveSession,
    sessionBufferStore,
    renderedPaneSessions,
    sessionGroupSlots,
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
    onActivateSession,
    focusNonce,
    terminalFontSize,
    terminalThemeId,
    terminalWidthMode,
    allowSessionDrawerSwipe = false,
    absoluteLineNumbersVisible,
    copySelection,
    onLongPressRow,
  }: {
    interactiveSession: Session | null;
    sessionBufferStore?: SessionRenderBufferStore | null;
    renderedPaneSessions: Session[];
    sessionGroupSlots?: TerminalSessionGroupSlots | null;
    visiblePaneEntries: {
      pane: AndroidWorkspacePane;
      paneIndex: number;
      session: Session | null;
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
    onActivateSession?: (sessionId: string, sourceSlot?: TerminalSessionGroupSlotName) => void;
    focusNonce: number;
    terminalFontSize: number;
    terminalThemeId?: string;
    terminalWidthMode: TerminalWidthMode;
    allowSessionDrawerSwipe?: boolean;
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
    const [slideSlot, setSlideSlot] = useState<TerminalSessionGroupSlotName | null>(null);
    const slideTimerRef = useRef<number | null>(null);
    const sessionGroupVisible = Boolean(
      !splitVisible &&
        !landscape &&
        sessionGroupSlots?.center,
    );
    const paneProfile = useMemo(
      () => resolveTerminalLayoutProfile({
        splitVisible,
        landscape,
        sessionGroupVisible,
      }),
      [landscape, sessionGroupVisible, splitVisible],
    );

    const sessionGroup = useMemo(() => {
      if (!sessionGroupVisible || !sessionGroupSlots?.center) {
        return null;
      }
      return {
        top: sessionGroupSlots.top,
        center: sessionGroupSlots.center,
        bottom: sessionGroupSlots.bottom,
      };
    }, [sessionGroupSlots, sessionGroupVisible]);

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
          enabled={allowSessionDrawerSwipe || terminalWidthMode !== "mirror-fixed"}
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
            splitVisible={splitVisible}
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
        allowSessionDrawerSwipe,
        copySelection,
        onLongPressRow,
      ],
    );

    const stageSlots = useMemo<PaneSlotDefinition[]>(() => {
      const entries = splitVisible
        ? visiblePaneEntries
        : (renderedPaneSessions.length > 0 ? renderedPaneSessions : [null]).map((session, index) => ({
            pane: {
              id: index === 0 ? "pane-main" : `pane-hidden-${session?.id ?? index}`,
              size: 1,
              tabs: [],
              activeTabId: session?.id ?? "",
            } as AndroidWorkspacePane,
            paneIndex: index,
            session,
          }));
      return entries.map(({ pane, paneIndex, session }) => {
        const sessionIsActive = Boolean(session && session.id === interactiveSession?.id);
        return {
          id: pane.id,
          title: `Pane ${paneIndex + 1}`,
          size: pane.size ?? 1,
          isActive: splitVisible ? pane.id === activePaneId : sessionIsActive,
          activeTabId: session?.id ?? null,
          tabIds: session ? [session.id] : [],
          render: () => {
            if (!session) {
              return <div style={{ flex: 1, minHeight: 0, backgroundColor: mobileTheme.colors.canvas }} />;
            }
            return (
              <div
                data-testid="terminal-pane-shell"
                data-pane-id={pane.id}
                onPointerDown={() => onActivatePane?.(pane.id)}
                style={{
                  flex: `${Math.max(0.01, pane.size ?? 1)} 1 0%`,
                  minHeight: 0,
                  height: "100%",
                  position: "relative",
                  overflow: "hidden",
                  backgroundColor: mobileTheme.colors.canvas,
                  border: `1px solid ${mobileTheme.colors.cardBorder}`,
                  boxSizing: "border-box",
                }}
              >
                {renderTerminal(session, sessionIsActive, splitVisible ? `${pane.id}:${session.id}` : session.id)}
              </div>
            );
          },
        };
      });
    }, [activePaneId, interactiveSession?.id, renderedPaneSessions, renderTerminal, splitVisible, visiblePaneEntries]);

    const activateSessionGroupSlot = useCallback((session: Session, slot: TerminalSessionGroupSlotName) => {
      if (slot === "center") {
        onActivateSession?.(session.id, slot);
        return;
      }
      if (slideTimerRef.current !== null) {
        window.clearTimeout(slideTimerRef.current);
      }
      setSlideSlot(slot);
      slideTimerRef.current = window.setTimeout(() => {
        slideTimerRef.current = null;
        setSlideSlot(null);
        onActivateSession?.(session.id, slot);
      }, 180);
    }, [onActivateSession]);

    useEffect(() => {
      return () => {
        if (slideTimerRef.current !== null) {
          window.clearTimeout(slideTimerRef.current);
          slideTimerRef.current = null;
        }
      };
    }, []);

    const renderSessionGroupPeek = useCallback(
      (session: Session | null, slot: "top" | "bottom") => {
        const title = session
          ? (session.resolvedPath || session.customName || session.sessionName || session.title || session.id)
          : "未指定 session";
        const detail = session
          ? `${session.customName || session.sessionName || session.id} · ${session.bridgeHost}:${session.bridgePort}`
          : "在左侧抽屉长按 session 后指定到这里";
        return (
        <button
          type="button"
          data-testid={`terminal-session-group-peek-${slot}`}
          onClick={() => { if (session) activateSessionGroupSlot(session, slot); }}
          disabled={!session}
          style={{
            height: "16%",
            minHeight: "46px",
            maxHeight: "78px",
            width: "100%",
            border: `1px solid ${mobileTheme.colors.cardBorder}`,
            borderRadius: "16px",
            background: "linear-gradient(180deg, rgba(24, 35, 55, 0.92), rgba(13, 21, 35, 0.92))",
            color: mobileTheme.colors.textPrimary,
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "center",
            gap: "4px",
            padding: "9px 12px",
            textAlign: "left",
            boxSizing: "border-box",
            overflow: "hidden",
            touchAction: "manipulation",
            opacity: session ? 1 : 0.62,
          }}
        >
          <span
            style={{
              fontSize: "10px",
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "rgba(177, 193, 224, 0.66)",
            }}
          >
            {slot === "top" ? "Top session" : "Bottom session"}
          </span>
          <span
            style={{
              fontSize: "13px",
              fontWeight: 800,
              color: mobileTheme.colors.textPrimary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </span>
          <span
            style={{
              fontSize: "10px",
              color: mobileTheme.colors.textSecondary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {detail}
          </span>
        </button>
      );
      },
      [activateSessionGroupSlot],
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
            margin: paneProfile.stage.outerMargin,
            borderRadius: paneProfile.stage.containerRadius,
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
          {sessionGroup ? (
            <div
              data-testid="terminal-session-group-stage"
              data-layout-mode={paneProfile.mode}
              style={{
                height: "100%",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "14px 0 0",
                boxSizing: "border-box",
                transform:
                  slideSlot === "top"
                    ? "translateY(54px)"
                    : slideSlot === "bottom"
                      ? "translateY(-54px)"
                      : "translateY(0)",
                transition: slideSlot ? "transform 180ms ease-out" : "none",
              }}
            >
              {renderSessionGroupPeek(sessionGroup.top, "top")}
              <div
                data-testid="terminal-session-group-center"
                style={{
                  flex: "1 1 auto",
                  minHeight: 0,
                  position: "relative",
                  overflow: "hidden",
                  border: `1px solid ${mobileTheme.colors.cardBorder}`,
                  borderRadius: paneProfile.stage.paneRadius,
                  backgroundColor: mobileTheme.colors.canvas,
                }}
              >
                {renderTerminal(sessionGroup.center, true, `group-center:${sessionGroup.center.id}`)}
              </div>
              {renderSessionGroupPeek(sessionGroup.bottom, "bottom")}
            </div>
          ) : interactiveSession || stageSlots.length > 0 ? (
            <PaneStage
              platform="phone"
              splitVisible={splitVisible}
              slots={stageSlots}
              landscape={landscape}
              onActivatePane={onActivatePane}
            />
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
    terminalPageRenderedSessionsUiKey([
      prev.sessionGroupSlots?.top,
      prev.sessionGroupSlots?.center,
      prev.sessionGroupSlots?.bottom,
    ].filter((session): session is Session => Boolean(session))) ===
      terminalPageRenderedSessionsUiKey([
        next.sessionGroupSlots?.top,
        next.sessionGroupSlots?.center,
        next.sessionGroupSlots?.bottom,
      ].filter((session): session is Session => Boolean(session))) &&
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
    prev.onActivateSession === next.onActivateSession &&
    prev.focusNonce === next.focusNonce &&
    prev.terminalFontSize === next.terminalFontSize &&
    prev.terminalThemeId === next.terminalThemeId &&
    prev.terminalWidthMode === next.terminalWidthMode &&
    prev.allowSessionDrawerSwipe === next.allowSessionDrawerSwipe &&
    prev.absoluteLineNumbersVisible === next.absoluteLineNumbersVisible &&
    prev.copySelection === next.copySelection &&
    prev.onLongPressRow === next.onLongPressRow &&
    prev.visiblePaneEntries
      .map((entry) => `${entry.pane.id}:${entry.session?.id || ""}`)
      .join("||") ===
      next.visiblePaneEntries
        .map((entry) => `${entry.pane.id}:${entry.session?.id || ""}`)
        .join("||") &&
    prev.onActivatePane === next.onActivatePane,
);

export { TerminalStageShell };
