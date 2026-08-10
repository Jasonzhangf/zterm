import { memo as ReactMemo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaneStage, type PaneSlotDefinition } from "@zterm/shared";
import { TerminalView } from "../components/TerminalView";
import type { SessionRenderBufferStore } from "../lib/session-render-buffer-store";
import { TerminalTabSwipeSurface } from "../components/terminal/TerminalTabSwipeSurface";
import { TerminalPreviewGrid } from "../components/terminal/TerminalPreviewGrid";
import {
  beginSessionPreviewGesture,
  createSessionPreviewGestureState,
  resolveSessionPreviewGesture,
  updateSessionPreviewGesture,
} from "../lib/session-preview-gesture";
import { resolveTerminalOrientation } from "../lib/terminal-viewport-metrics";
import {
  resolveTerminalLayoutProfile,
  type TerminalSessionGroupLayoutAxis,
} from "../lib/terminal-layout-profile";
import type { TerminalShellSkin } from "../lib/bridge-settings";
import { getServerIdentityTone, resolveServerDisplayName, resolveServerIdentityKey } from "../lib/server-identity";
import type { TerminalSessionGroupSlotName, TerminalSessionGroupViewportProjection } from "../lib/session-group-viewport";
import { terminalPageRenderedSessionUiKey, terminalPageRenderedSessionsUiKey, resolveRenderedSessionsInputEpochKey } from "./terminal-page-render-keys";
import type { AndroidWorkspacePane, Session, TerminalResizeHandler, TerminalViewportChangeHandler, TerminalWidthMode } from "../lib/types";
import type { CopySelectionState } from "./useTerminalPageCopyRuntime";

const TerminalStageShell = ReactMemo(
  function TerminalStageShell({
    interactiveSession,
    sessionBufferStore,
    renderedPaneSessions,
    sessionGroupViewport,
    sessionGroupLayoutAxis = "vertical",
    visiblePaneEntries,
    splitVisible,
    activePaneId,
    terminalChromeBottomPx,
    terminalChromeTopPx = 0,
    inputResetEpochBySession,
    followResetEpoch,
    inputIntentFollowResetEpoch,
    terminalKeyboardRequested,
    isAndroid,
    onResize,
    onTerminalInput,
    onTerminalWidthModeChange,
    handleTerminalViewportChange,
    handleSwipeTab,
    handleActiveTerminalActivateInput,
    onActivatePane,
    onOpenPaneSessionPicker,
    onActivateSession,
    onTerminalFocusOwnerActivate,
    focusNonce,
    terminalFontSize,
    terminalThemeId,
    terminalShellSkin = "light",
    terminalWidthMode,
    allowSessionDrawerSwipe = false,
    absoluteLineNumbersVisible,
    copySelection,
    onLongPressRow,
    onCopySelectionDismiss,
    sessionPreviewOpen = false,
    sessionPreviewSessions = [],
    sessionPreviewReplacementCandidates = [],
    onOpenSessionPreview,
    onCloseSessionPreview,
    onActivatePreviewSession,
    onAddPreviewSession,
    onRemovePreviewSession,
    onMovePreviewSession,
    onReplacePreviewSession,
    onPreviewPrimarySessionChange,
  }: {
    interactiveSession: Session | null;
    sessionBufferStore?: SessionRenderBufferStore | null;
    renderedPaneSessions: Session[];
    sessionGroupViewport?: TerminalSessionGroupViewportProjection<Session> | null;
    sessionGroupLayoutAxis?: TerminalSessionGroupLayoutAxis;
    visiblePaneEntries: {
      pane: AndroidWorkspacePane;
      paneIndex: number;
      session: Session | null;
    }[];
    splitVisible: boolean;
    activePaneId: string;
    terminalChromeBottomPx: number;
    terminalChromeTopPx?: number;
    inputResetEpochBySession?: Record<string, number>;
    followResetEpoch?: number;
    inputIntentFollowResetEpoch?: number;
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
    onOpenPaneSessionPicker?: (paneId: string) => void;
    onActivateSession?: (sessionId: string, sourceSlot?: TerminalSessionGroupSlotName) => void;
    onTerminalFocusOwnerActivate?: () => void;
    focusNonce: number;
    terminalFontSize: number;
    terminalThemeId?: string;
    terminalShellSkin?: TerminalShellSkin;
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
    onCopySelectionDismiss?: () => void;
    sessionPreviewOpen?: boolean;
    sessionPreviewSessions?: Session[];
    sessionPreviewReplacementCandidates?: Session[];
    onOpenSessionPreview?: () => void;
    onCloseSessionPreview?: () => void;
    onActivatePreviewSession?: (sessionId: string) => void;
    onAddPreviewSession?: (sessionId: string) => void;
    onRemovePreviewSession?: (sessionId: string) => void;
    onMovePreviewSession?: (sourceSessionId: string, targetIndex: number) => void;
    onReplacePreviewSession?: (sourceSessionId: string, replacementSessionId: string) => void;
    onPreviewPrimarySessionChange?: (sessionId: string) => void;
  }) {
    const previewGestureRef = useRef(createSessionPreviewGestureState());
    const landscape =
      typeof window !== "undefined"
        ? resolveTerminalOrientation() === "landscape"
        : false;
    const [slideSlot, setSlideSlot] = useState<TerminalSessionGroupSlotName | null>(null);
    const slideTimerRef = useRef<number | null>(null);
    const sessionGroupVisible = Boolean(
      !splitVisible &&
        !landscape &&
        sessionGroupViewport?.slots.center,
    );
    const paneProfile = useMemo(
      () => resolveTerminalLayoutProfile({
        splitVisible,
        landscape,
        sessionGroupVisible,
        sessionGroupAxis: sessionGroupLayoutAxis,
      }),
      [landscape, sessionGroupLayoutAxis, sessionGroupVisible, splitVisible],
    );

    const sessionGroup = useMemo(() => {
      if (!sessionGroupVisible || !sessionGroupViewport?.slots.center) {
        return null;
      }
      return {
        top: sessionGroupViewport.slots.top,
        center: sessionGroupViewport.slots.center,
        bottom: sessionGroupViewport.slots.bottom,
        visible: sessionGroupViewport.visible,
      };
    }, [sessionGroupViewport, sessionGroupVisible]);

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
          allowedStartEdge={terminalWidthMode === "mirror-fixed" ? "left" : "both"}
          allowedDirections={terminalWidthMode === "mirror-fixed" ? "previous" : "both"}
          onSwipeTab={handleSwipeTab}
        >
          <TerminalView
            sessionId={session.id}
            sessionBufferStore={sessionBufferStore}
            active={sessionIsActive}
            live
            inputResetEpoch={inputResetEpochBySession?.[session.id] || 0}
            followResetEpoch={
              sessionIsActive
                ? (followResetEpoch || 0) + (inputIntentFollowResetEpoch || 0)
                : 0
            }
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
            onCopySelectionDismiss={onCopySelectionDismiss}
            splitVisible={splitVisible}
            reserveRightEdgeSwipe={Boolean(onOpenSessionPreview && sessionPreviewSessions.length > 0)}
          />
        </TerminalTabSwipeSurface>
      ),
      [
        absoluteLineNumbersVisible,
        focusNonce,
        followResetEpoch,
        inputIntentFollowResetEpoch,
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
        onCopySelectionDismiss,
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
              return (
                <button
                  type="button"
                  data-testid={`terminal-empty-pane-${pane.id}`}
                  aria-label={`选择 Pane ${paneIndex + 1} 的 session`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onTerminalFocusOwnerActivate?.();
                    onActivatePane?.(pane.id);
                    onOpenPaneSessionPicker?.(pane.id);
                  }}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    width: "100%",
                    border: "1px dashed rgba(220,232,255,0.24)",
                    borderRadius: paneProfile.stage.paneRadius,
                    backgroundColor: "var(--zterm-stage-bg)",
                    color: "var(--zterm-stage-muted)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    fontSize: "13px",
                    fontWeight: 800,
                  }}
                >
                  <span style={{ color: "var(--zterm-stage-text)" }}>Pane {paneIndex + 1}</span>
                  <span>选择 session</span>
                </button>
              );
            }
            return (
              <div
                data-testid="terminal-pane-shell"
                data-pane-id={pane.id}
                onPointerDown={() => {
                  onTerminalFocusOwnerActivate?.();
                  onActivatePane?.(pane.id);
                }}
                style={{
                  flex: `${Math.max(0.01, pane.size ?? 1)} 1 0%`,
                  minHeight: 0,
                  height: "100%",
                  position: "relative",
                  overflow: "hidden",
                  backgroundColor: "var(--zterm-stage-bg)",
                  borderWidth: "0px",
                  borderStyle: "none",
                  boxSizing: "border-box",
                }}
              >
                {renderTerminal(session, sessionIsActive, splitVisible ? `${pane.id}:${session.id}` : session.id)}
              </div>
            );
          },
        };
      });
    }, [activePaneId, interactiveSession?.id, onActivatePane, onOpenPaneSessionPicker, onTerminalFocusOwnerActivate, paneProfile.stage.paneRadius, renderedPaneSessions, renderTerminal, splitVisible, visiblePaneEntries]);

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
      (session: Session | null, slot: "top" | "bottom", visible: boolean) => {
        if (!visible || !session) {
          return null;
        }
        const sideLabel = sessionGroupLayoutAxis === "horizontal"
          ? (slot === "top" ? "左侧" : "右侧")
          : (slot === "top" ? "上方" : "下方");
        const serverTone = getServerIdentityTone(session);
        const serverKey = resolveServerIdentityKey(session);
        const serverLabel = resolveServerDisplayName(session);
        const title = session.customName || session.title || session.sessionName || session.id;
        const detail = session.sessionName || session.title || session.id;
        return (
        <button
          type="button"
          data-testid={`terminal-session-group-peek-${slot}`}
          data-server-key={serverKey}
          onClick={() => { if (session) activateSessionGroupSlot(session, slot); }}
          disabled={!session}
          style={{
            height: sessionGroupLayoutAxis === "horizontal" ? "100%" : "13%",
            minHeight: sessionGroupLayoutAxis === "horizontal" ? 0 : "42px",
            maxHeight: sessionGroupLayoutAxis === "horizontal" ? "none" : "62px",
            width: sessionGroupLayoutAxis === "horizontal" ? "clamp(92px, 13vw, 136px)" : "100%",
            minWidth: sessionGroupLayoutAxis === "horizontal" ? "92px" : undefined,
            maxWidth: sessionGroupLayoutAxis === "horizontal" ? "136px" : undefined,
            border: `1px solid ${serverTone.lightCardBorder}`,
            borderRadius: "14px",
            background: serverTone.previewBackground,
            color: "var(--zterm-stage-text)",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "center",
            gap: sessionGroupLayoutAxis === "horizontal" ? "9px" : "5px",
            padding: sessionGroupLayoutAxis === "horizontal" ? "68px 10px 26px" : "7px 10px",
            textAlign: "left",
            boxSizing: "border-box",
            overflow: "hidden",
            touchAction: "manipulation",
            opacity: 1,
          }}
        >
          <span
              style={{
                display: "flex",
                flexDirection: sessionGroupLayoutAxis === "horizontal" ? "column" : "row",
                alignItems: sessionGroupLayoutAxis === "horizontal" ? "flex-start" : "baseline",
                gap: sessionGroupLayoutAxis === "horizontal" ? "6px" : "7px",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontSize: "10px",
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: serverTone.previewText,
                }}
              >
                {sideLabel}
              </span>
              <span
              style={{
                minWidth: 0,
                fontSize: sessionGroupLayoutAxis === "horizontal" ? "15px" : "13px",
                fontWeight: 820,
                color: "var(--zterm-stage-text)",
                whiteSpace: sessionGroupLayoutAxis === "horizontal" ? "normal" : "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                wordBreak: sessionGroupLayoutAxis === "horizontal" ? "break-word" : undefined,
                display: sessionGroupLayoutAxis === "horizontal" ? "-webkit-box" : undefined,
                WebkitBoxOrient: sessionGroupLayoutAxis === "horizontal" ? "vertical" : undefined,
                WebkitLineClamp: sessionGroupLayoutAxis === "horizontal" ? 2 : undefined,
                lineHeight: sessionGroupLayoutAxis === "horizontal" ? 1.12 : undefined,
                }}
              >
                {title}
              </span>
            </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "999px",
                background: serverTone.accent,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                minWidth: 0,
                fontSize: sessionGroupLayoutAxis === "horizontal" ? "10.5px" : "9.5px",
                color: serverTone.previewText,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {serverLabel}
            </span>
          </span>
          <span
            style={{
              fontSize: sessionGroupLayoutAxis === "horizontal" ? "10.5px" : "9.5px",
              color: "var(--zterm-stage-muted)",
              whiteSpace: sessionGroupLayoutAxis === "horizontal" ? "normal" : "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              wordBreak: sessionGroupLayoutAxis === "horizontal" ? "break-word" : undefined,
              display: sessionGroupLayoutAxis === "horizontal" ? "-webkit-box" : undefined,
              WebkitBoxOrient: sessionGroupLayoutAxis === "horizontal" ? "vertical" : undefined,
              WebkitLineClamp: sessionGroupLayoutAxis === "horizontal" ? 2 : undefined,
              lineHeight: sessionGroupLayoutAxis === "horizontal" ? 1.18 : undefined,
            }}
          >
            {detail}
          </span>
        </button>
      );
      },
      [activateSessionGroupSlot, sessionGroupLayoutAxis],
    );

    const sessionGroupContainerTransform = sessionGroupLayoutAxis === "horizontal"
      ? slideSlot === "top"
        ? "translateX(calc(100% - 76px))"
        : slideSlot === "bottom"
          ? "translateX(calc(-100% + 76px))"
          : "translateX(0)"
      : slideSlot === "top"
        ? "translateY(calc(100% - 76px))"
        : slideSlot === "bottom"
          ? "translateY(calc(-100% + 76px))"
          : "translateY(0)";

    return (
      <div
        data-testid="terminal-stage-shell"
        data-terminal-shell-skin={terminalShellSkin}
        onTouchStartCapture={(event) => {
          if (sessionPreviewOpen || !onOpenSessionPreview || sessionPreviewSessions.length === 0) {
            previewGestureRef.current = createSessionPreviewGestureState();
            return;
          }
          const touch = event.touches[0];
          const width = window.visualViewport?.width || window.innerWidth || 0;
          previewGestureRef.current = touch
            ? beginSessionPreviewGesture(touch.clientX, touch.clientY, width)
            : createSessionPreviewGestureState();
        }}
        onTouchMoveCapture={(event) => {
          const touch = event.touches[0];
          if (!touch) return;
          previewGestureRef.current = updateSessionPreviewGesture(
            previewGestureRef.current,
            touch.clientX,
            touch.clientY,
          );
          const state = previewGestureRef.current;
          if (state.armed && state.axis === 'horizontal' && state.currentX < state.startX) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onTouchEndCapture={() => {
          const intent = resolveSessionPreviewGesture(previewGestureRef.current);
          previewGestureRef.current = createSessionPreviewGestureState();
          if (intent === 'open-preview') onOpenSessionPreview?.();
        }}
        onTouchCancelCapture={() => {
          previewGestureRef.current = createSessionPreviewGestureState();
        }}
        style={{
          position: "absolute",
          top: `${Math.max(0, Math.floor(terminalChromeTopPx))}px`,
          left: 0,
          right: 0,
          bottom: `${terminalChromeBottomPx}px`,
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
              : "var(--zterm-stage-bg)",
            overflow: "hidden",
            borderWidth: "0px",
            borderStyle: "none",
            position: "relative",
            overscrollBehaviorY: "contain",
          }}
        >
          {sessionPreviewOpen && sessionPreviewSessions.length > 0 ? (
            <TerminalPreviewGrid
              sessions={sessionPreviewSessions}
              replacementCandidates={sessionPreviewReplacementCandidates}
              sessionBufferStore={sessionBufferStore}
              landscape={landscape}
              fontSize={terminalFontSize}
              themeId={terminalThemeId}
              onActivateSession={(sessionId) => onActivatePreviewSession?.(sessionId)}
              onAddSession={(sessionId) => onAddPreviewSession?.(sessionId)}
              onRemoveSession={(sessionId) => onRemovePreviewSession?.(sessionId)}
              onMoveSession={(sourceSessionId, targetIndex) => onMovePreviewSession?.(sourceSessionId, targetIndex)}
              onReplaceSession={(sourceSessionId, replacementSessionId) => onReplacePreviewSession?.(sourceSessionId, replacementSessionId)}
              onPrimarySessionChange={onPreviewPrimarySessionChange}
              onTerminalInput={onTerminalInput}
              onClose={() => onCloseSessionPreview?.()}
            />
          ) : sessionGroup ? (
            <div
              data-testid="terminal-session-group-stage"
              data-layout-mode={paneProfile.mode}
              style={{
                height: "100%",
                minHeight: 0,
                display: "flex",
                flexDirection: sessionGroupLayoutAxis === "horizontal" ? "row" : "column",
                gap: "7px",
                padding: sessionGroupLayoutAxis === "horizontal" ? "0" : "24px 0 0",
                boxSizing: "border-box",
                transform: sessionGroupContainerTransform,
                transition: slideSlot ? "transform 180ms ease-out" : "none",
              }}
            >
              {renderSessionGroupPeek(sessionGroup.top, "top", sessionGroup.visible.top)}
              <div
                data-testid="terminal-session-group-center"
                style={{
                  flex: "1 1 auto",
                  minHeight: 0,
                  position: "relative",
                  overflow: "hidden",
                  borderWidth: "0px",
                  borderStyle: "none",
                  borderRadius: paneProfile.stage.paneRadius,
                  backgroundColor: "var(--zterm-stage-bg)",
                }}
              >
                {renderTerminal(sessionGroup.center, true, `group-center:${sessionGroup.center.id}`)}
              </div>
              {renderSessionGroupPeek(sessionGroup.bottom, "bottom", sessionGroup.visible.bottom)}
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
                color: "var(--zterm-stage-muted)",
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
      prev.sessionGroupViewport?.slots.top,
      prev.sessionGroupViewport?.slots.center,
      prev.sessionGroupViewport?.slots.bottom,
    ].filter((session): session is Session => Boolean(session))) ===
      terminalPageRenderedSessionsUiKey([
        next.sessionGroupViewport?.slots.top,
        next.sessionGroupViewport?.slots.center,
        next.sessionGroupViewport?.slots.bottom,
      ].filter((session): session is Session => Boolean(session))) &&
    prev.sessionGroupViewport?.visible.top === next.sessionGroupViewport?.visible.top &&
    prev.sessionGroupViewport?.visible.bottom === next.sessionGroupViewport?.visible.bottom &&
    prev.sessionGroupLayoutAxis === next.sessionGroupLayoutAxis &&
    prev.splitVisible === next.splitVisible &&
    prev.activePaneId === next.activePaneId &&
    prev.terminalChromeBottomPx === next.terminalChromeBottomPx &&
    resolveRenderedSessionsInputEpochKey(
      prev.inputResetEpochBySession,
      prev.renderedPaneSessions,
    ) ===
      resolveRenderedSessionsInputEpochKey(
        next.inputResetEpochBySession,
        next.renderedPaneSessions,
      ) &&
    prev.followResetEpoch === next.followResetEpoch &&
    prev.inputIntentFollowResetEpoch === next.inputIntentFollowResetEpoch &&
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
    prev.terminalShellSkin === next.terminalShellSkin &&
    prev.terminalWidthMode === next.terminalWidthMode &&
    prev.allowSessionDrawerSwipe === next.allowSessionDrawerSwipe &&
    prev.absoluteLineNumbersVisible === next.absoluteLineNumbersVisible &&
    prev.copySelection === next.copySelection &&
    prev.onLongPressRow === next.onLongPressRow &&
    prev.onCopySelectionDismiss === next.onCopySelectionDismiss &&
    prev.sessionPreviewOpen === next.sessionPreviewOpen &&
    terminalPageRenderedSessionsUiKey(prev.sessionPreviewSessions || []) ===
      terminalPageRenderedSessionsUiKey(next.sessionPreviewSessions || []) &&
    terminalPageRenderedSessionsUiKey(prev.sessionPreviewReplacementCandidates || []) ===
      terminalPageRenderedSessionsUiKey(next.sessionPreviewReplacementCandidates || []) &&
    prev.onOpenSessionPreview === next.onOpenSessionPreview &&
    prev.onCloseSessionPreview === next.onCloseSessionPreview &&
    prev.onActivatePreviewSession === next.onActivatePreviewSession &&
    prev.onAddPreviewSession === next.onAddPreviewSession &&
    prev.onRemovePreviewSession === next.onRemovePreviewSession &&
    prev.onMovePreviewSession === next.onMovePreviewSession &&
    prev.onReplacePreviewSession === next.onReplacePreviewSession &&
    prev.onPreviewPrimarySessionChange === next.onPreviewPrimarySessionChange &&
    prev.visiblePaneEntries
      .map((entry) => `${entry.pane.id}:${entry.session?.id || ""}`)
      .join("||") ===
      next.visiblePaneEntries
        .map((entry) => `${entry.pane.id}:${entry.session?.id || ""}`)
        .join("||") &&
    prev.onActivatePane === next.onActivatePane &&
    prev.onOpenPaneSessionPicker === next.onOpenPaneSessionPicker,
);

export { TerminalStageShell };
