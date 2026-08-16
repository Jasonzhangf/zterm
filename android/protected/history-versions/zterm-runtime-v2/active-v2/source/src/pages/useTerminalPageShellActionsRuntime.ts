import * as React from "react";
import type { SessionViewportModeStore } from "../lib/session-viewport-mode-store";
import type { TerminalViewportChangeHandler } from "../lib/types";

export interface UseTerminalPageShellActionsRuntimeOptions {
  activatePaneAndSession: (paneId: string) => void;
  onOpenQuickTabPicker: (paneId?: string) => void;
  onOpenTabManagerOpenStateChange?: (open: boolean) => void;
  onTerminalViewportChange?: TerminalViewportChangeHandler;
  sessionViewportModeStore: SessionViewportModeStore;
}

export interface UseTerminalPageShellActionsRuntimeResult {
  handleOpenQuickTabPickerForPane: (paneId?: string) => void;
  handleOpenTabManager: (paneId?: string) => void;
  handleCloseTabManager: () => void;
  handleOpenQuickTabPickerFromTabManager: () => void;
  handleTerminalViewportChange: TerminalViewportChangeHandler;
  tabManagerScopePaneId: string | null;
  tabManagerOpen: boolean;
}

export function useTerminalPageShellActionsRuntime(
  options: UseTerminalPageShellActionsRuntimeOptions,
): UseTerminalPageShellActionsRuntimeResult {
  const {
    activatePaneAndSession,
    onOpenQuickTabPicker,
    onOpenTabManagerOpenStateChange,
    onTerminalViewportChange,
    sessionViewportModeStore,
  } = options;

  const [tabManagerScopePaneId, setTabManagerScopePaneId] = React.useState<string | null>(null);
  const [tabManagerOpen, setTabManagerOpen] = React.useState(false);

  const handleOpenQuickTabPickerForPane = React.useCallback(
    (paneId?: string) => {
      if (paneId) {
        activatePaneAndSession(paneId);
      }
      onOpenQuickTabPicker(paneId);
    },
    [activatePaneAndSession, onOpenQuickTabPicker],
  );

  const handleOpenTabManager = React.useCallback(
    (paneId?: string) => {
      setTabManagerScopePaneId(paneId || null);
      if (paneId) {
        activatePaneAndSession(paneId);
      }
      setTabManagerOpen(true);
      onOpenTabManagerOpenStateChange?.(true);
    },
    [activatePaneAndSession, onOpenTabManagerOpenStateChange],
  );

  const handleCloseTabManager = React.useCallback(() => {
    setTabManagerOpen(false);
    setTabManagerScopePaneId(null);
    onOpenTabManagerOpenStateChange?.(false);
  }, [onOpenTabManagerOpenStateChange]);

  const handleOpenQuickTabPickerFromTabManager = React.useCallback(() => {
    const targetPaneId = tabManagerScopePaneId || undefined;
    setTabManagerOpen(false);
    setTabManagerScopePaneId(null);
    onOpenTabManagerOpenStateChange?.(false);
    handleOpenQuickTabPickerForPane(targetPaneId);
  }, [handleOpenQuickTabPickerForPane, onOpenTabManagerOpenStateChange, tabManagerScopePaneId]);

  const handleTerminalViewportChange = React.useCallback<TerminalViewportChangeHandler>(
    (sessionId, viewState) => {
      sessionViewportModeStore.setMode(sessionId, viewState.mode);
      onTerminalViewportChange?.(sessionId, viewState);
    },
    [onTerminalViewportChange, sessionViewportModeStore],
  );

  return {
    handleOpenQuickTabPickerForPane,
    handleOpenTabManager,
    handleCloseTabManager,
    handleOpenQuickTabPickerFromTabManager,
    handleTerminalViewportChange,
    tabManagerScopePaneId,
    tabManagerOpen,
  };
}
