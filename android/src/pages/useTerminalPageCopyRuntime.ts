import * as React from "react";
import {
  type CopySelectionState,
  EMPTY_COPY_SELECTION_STATE,
  resolveCopySelectionBuffer,
  terminalBufferRowsToPlainText,
  writeTextToClipboard,
  logAsyncCleanupFailure,
} from "./terminal-copy-selection";

export { EMPTY_COPY_SELECTION_STATE, type CopySelectionState };

export interface UseTerminalPageCopyRuntimeOptions {
  uiSessionId: string | null;
  activeSessionId: string | null;
  splitVisible: boolean;
  findPaneForSession: (sessionId: string) => { id: string } | null;
  onSwitchSession: (sessionId: string) => void;
  setActivePane: (paneId: string) => void;
  keepTerminalInputFocused: () => void;
  sessionBufferStore: import("../lib/session-render-buffer-store").SessionRenderBufferStore | null | undefined;
  sessions: import("../lib/types").Session[];
}

export interface UseTerminalPageCopyRuntimeResult {
  copySelection: CopySelectionState;
  setCopySelection: React.Dispatch<React.SetStateAction<CopySelectionState>>;
  copySelectionRef: React.MutableRefObject<CopySelectionState>;
  handleLongPressCopyRow: (
    sessionId: string,
    rowIndex: number,
    clientX: number,
    clientY: number,
  ) => void;
  handleCopySelectionStart: () => void;
  handleCopySelectionEnd: () => void;
  handleCopySelectedText: () => void;
  handleCloseCopyMenu: () => void;
  resetCopySelectionForTabChange: () => void;
  handleQuickBarToggleCopyMode: () => void;
}

export function useTerminalPageCopyRuntime({
  uiSessionId,
  activeSessionId,
  splitVisible,
  findPaneForSession,
  onSwitchSession,
  setActivePane,
  keepTerminalInputFocused,
  sessionBufferStore,
  sessions,
}: UseTerminalPageCopyRuntimeOptions): UseTerminalPageCopyRuntimeResult {
  const [copySelection, setCopySelection] = React.useState<CopySelectionState>(
    EMPTY_COPY_SELECTION_STATE,
  );
  const copySelectionRef = React.useRef<CopySelectionState>(copySelection);

  const handleLongPressCopyRow = React.useCallback(
    (sessionId: string, rowIndex: number, clientX: number, clientY: number) => {
      const targetPane = splitVisible ? findPaneForSession(sessionId) : null;
      if (targetPane) {
        setActivePane(targetPane.id);
        if (sessionId !== activeSessionId) {
          onSwitchSession(sessionId);
        }
      }
      setCopySelection((current) => {
        if (
          !current.active ||
          (current.sessionId !== null && current.sessionId !== sessionId)
        ) {
          return current;
        }
        return { ...current, sessionId, menu: { x: clientX, y: clientY, rowIndex } };
      });
    },
    [activeSessionId, findPaneForSession, onSwitchSession, setActivePane, splitVisible],
  );

  const handleCopySelectionStart = React.useCallback(() => {
    setCopySelection((current) => {
      if (!current.active || !current.menu) {
        return current;
      }
      return { ...current, startRowIndex: current.menu.rowIndex, endRowIndex: null, menu: null };
    });
  }, []);

  const handleCopySelectionEnd = React.useCallback(() => {
    const current = copySelectionRef.current;
    const pendingCopy =
      current.active && current.menu && current.startRowIndex !== null && current.sessionId
        ? {
            sessionId: current.sessionId,
            startRowIndex: current.startRowIndex,
            endRowIndex: current.menu.rowIndex,
          }
        : null;
    setCopySelection((current) => {
      if (!current.active || !current.menu || current.startRowIndex === null) {
        return current;
      }
      return { ...current, endRowIndex: current.menu.rowIndex, menu: null };
    });
    if (pendingCopy?.sessionId) {
      const buffer = resolveCopySelectionBuffer(
        sessionBufferStore,
        sessions,
        pendingCopy.sessionId,
        pendingCopy.startRowIndex,
        pendingCopy.endRowIndex,
      );
      const text = terminalBufferRowsToPlainText(
        buffer,
        pendingCopy.startRowIndex,
        pendingCopy.endRowIndex,
      );
      if (text) {
        void writeTextToClipboard(text).catch((error) => {
          logAsyncCleanupFailure("[CopyRuntime] writeTextToClipboard", error);
        });
      }
      keepTerminalInputFocused();
    }
  }, [keepTerminalInputFocused, sessionBufferStore, sessions]);

  const handleCopySelectedText = React.useCallback(() => {
    const current = copySelectionRef.current;
    const sessionId = current.sessionId;
    if (!sessionId || current.startRowIndex === null) {
      return;
    }
    const endRowIndex = current.endRowIndex ?? current.startRowIndex;
    const buffer = resolveCopySelectionBuffer(
      sessionBufferStore,
      sessions,
      sessionId,
      current.startRowIndex,
      endRowIndex,
    );
    const text = terminalBufferRowsToPlainText(buffer, current.startRowIndex, endRowIndex);
    if (!text) {
      return;
    }
    void writeTextToClipboard(text).catch((error) => {
      logAsyncCleanupFailure("[CopyRuntime] writeTextToClipboard", error);
    });
    keepTerminalInputFocused();
  }, [keepTerminalInputFocused, sessionBufferStore, sessions]);

  const handleCloseCopyMenu = React.useCallback(() => {
    setCopySelection((current) => ({ ...current, menu: null }));
    keepTerminalInputFocused();
  }, [keepTerminalInputFocused]);

  const resetCopySelectionForTabChange = React.useCallback(() => {
    setCopySelection(EMPTY_COPY_SELECTION_STATE);
  }, []);

  const handleQuickBarToggleCopyMode = React.useCallback(() => {
    setCopySelection((current) => {
      if (current.active) {
        return EMPTY_COPY_SELECTION_STATE;
      }
      return { active: true, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null };
    });
  }, []);

  // Keep ref in sync
  React.useEffect(() => {
    copySelectionRef.current = copySelection;
  }, [copySelection]);

  // Reset when active session changes
  React.useEffect(() => {
    setCopySelection((current) => {
      if (!current.active || !current.sessionId) {
        return current;
      }
      return current.sessionId === uiSessionId ? current : EMPTY_COPY_SELECTION_STATE;
    });
  }, [uiSessionId]);

  return {
    copySelection,
    setCopySelection,
    copySelectionRef,
    handleLongPressCopyRow,
    handleCopySelectionStart,
    handleCopySelectionEnd,
    handleCopySelectedText,
    handleCloseCopyMenu,
    resetCopySelectionForTabChange,
    handleQuickBarToggleCopyMode,
  };
}
