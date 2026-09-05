import { useCallback, useRef, useState, type RefObject } from "react";
import {
  clearTerminalViewportLayoutDriftRuntime,
  createTerminalFollowScrollState,
  type TerminalFollowScrollEffect,
  type TerminalFollowScrollState,
  type TerminalFollowScrollTransition,
} from "./terminal-follow-scroll-runtime";

export function useTerminalRendererWindow(options: {
  initialRenderBottomIndex: number;
  containerRef: RefObject<HTMLDivElement | null>;
  emitViewportDemandRef: RefObject<(
    mode: "follow" | "reading",
    renderBottomIndex: number,
  ) => void>;
  flushPendingFollowScrollSyncRef: RefObject<() => boolean>;
}) {
  const followScrollStateRef = useRef<TerminalFollowScrollState>(createTerminalFollowScrollState());
  const followScrollSyncTimerRef = useRef<number | null>(null);
  const recentViewportLayoutChangeTimerRef = useRef<number | null>(null);
  const [renderBottomIndex, setRenderBottomIndex] = useState(options.initialRenderBottomIndex);
  const [readingMode, setReadingMode] = useState(false);
  const setFollowModeState = useCallback((nextRenderBottomIndex: number) => {
    followScrollStateRef.current = createTerminalFollowScrollState({
      lastSettledScrollTop: followScrollStateRef.current.lastSettledScrollTop,
      hasSettledFollowFrame: followScrollStateRef.current.hasSettledFollowFrame,
    });
    setReadingMode(false);
    setRenderBottomIndex(nextRenderBottomIndex);
  }, []);

  const applyFollowScrollTransition = useCallback((transition: TerminalFollowScrollTransition) => {
    followScrollStateRef.current = transition.state;
    transition.effects.forEach((effect: TerminalFollowScrollEffect) => {
      if (effect.type === "schedule-follow-flush") {
        if (followScrollSyncTimerRef.current !== null) return;
        followScrollSyncTimerRef.current = window.setTimeout(() => {
          followScrollSyncTimerRef.current = null;
          options.flushPendingFollowScrollSyncRef.current();
        }, 0);
        return;
      }
      if (effect.type === "cancel-follow-flush") {
        if (followScrollSyncTimerRef.current !== null) {
          window.clearTimeout(followScrollSyncTimerRef.current);
          followScrollSyncTimerRef.current = null;
        }
        return;
      }
      if (effect.type === "set-scroll-top") {
        const host = options.containerRef.current;
        if (host && Math.abs(host.scrollTop - effect.scrollTop) > 1) host.scrollTop = effect.scrollTop;
        return;
      }
      if (effect.type === "set-mode") {
        setReadingMode(effect.mode === "reading");
        return;
      }
      if (effect.type === "set-render-bottom-index") {
        setRenderBottomIndex(effect.renderBottomIndex);
        return;
      }
      if (effect.type === "emit-viewport-demand") {
        options.emitViewportDemandRef.current(effect.mode, effect.renderBottomIndex);
        return;
      }
      if (effect.type === "mark-layout-settling") {
        if (recentViewportLayoutChangeTimerRef.current !== null) {
          window.clearTimeout(recentViewportLayoutChangeTimerRef.current);
        }
        recentViewportLayoutChangeTimerRef.current = window.setTimeout(() => {
          recentViewportLayoutChangeTimerRef.current = null;
          followScrollStateRef.current = clearTerminalViewportLayoutDriftRuntime(
            followScrollStateRef.current,
          ).state;
        }, 0);
      }
    });
  }, [
    options.containerRef,
    options.emitViewportDemandRef,
    options.flushPendingFollowScrollSyncRef,
  ]);

  return {
    followScrollStateRef,
    followScrollSyncTimerRef,
    recentViewportLayoutChangeTimerRef,
    renderBottomIndex,
    readingMode,
    setRenderBottomIndex,
    setReadingMode,
    setFollowModeState,
    applyFollowScrollTransition,
  };
}
