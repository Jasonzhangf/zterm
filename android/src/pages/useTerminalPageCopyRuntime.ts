import * as React from "react";
import {
  type CopySelectionState,
  EMPTY_COPY_SELECTION_STATE,
  resolveCopySelectionBufferOrWarn,
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
      if (typeof console !== 'undefined') {
        console.log('[CopyTrace] handleLongPressCopyRow', {
          sessionId,
          rowIndex,
          clientX,
          clientY,
          splitVisible,
        });
      }
      const targetPane = splitVisible ? findPaneForSession(sessionId) : null;
      if (targetPane) {
        setActivePane(targetPane.id);
        if (sessionId !== activeSessionId) {
          onSwitchSession(sessionId);
        }
      }
      setCopySelection((current) => {
        if (typeof console !== 'undefined') {
          console.log('[CopyTrace] handleLongPressCopyRow setCopySelection', {
            currentActive: current.active,
            currentSessionId: current.sessionId,
            currentMenu: current.menu,
            targetSessionId: sessionId,
          });
        }
        if (
          !current.active ||
          (current.sessionId !== null && current.sessionId !== sessionId)
        ) {
          if (typeof console !== 'undefined') {
            console.log('[CopyTrace] handleLongPressCopyRow SKIP - guard returned current', {
              guardActive: !current.active,
              guardSessionMismatch:
                current.sessionId !== null && current.sessionId !== sessionId,
            });
          }
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

  /** Copy text and reset copy mode to inactive on success; preserve state on failure. */
  const copyTextAndResetOnSuccess = React.useCallback((text: string) => {
    void writeTextToClipboard(text)
      .then(() => {
        setCopySelection(EMPTY_COPY_SELECTION_STATE);
      })
      .catch((error) => {
        logAsyncCleanupFailure("[CopyRuntime] writeTextToClipboard", error);
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
      const buffer = resolveCopySelectionBufferOrWarn(
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
      if (!text) {
        logAsyncCleanupFailure(
          `[CopyRuntime] selected text is empty, session=${pendingCopy.sessionId}, rows=${Math.min(pendingCopy.startRowIndex, pendingCopy.endRowIndex)}-${Math.max(pendingCopy.startRowIndex, pendingCopy.endRowIndex)}`,
          new Error("empty copy selection"),
        );
        keepTerminalInputFocused();
        return;
      }
      copyTextAndResetOnSuccess(text);
      keepTerminalInputFocused();
    }
  }, [keepTerminalInputFocused, sessionBufferStore, sessions, copyTextAndResetOnSuccess]);

  const handleCopySelectedText = React.useCallback(() => {
    const current = copySelectionRef.current;
    const sessionId = current.sessionId;
    if (!sessionId || current.startRowIndex === null) {
      return;
    }
    const endRowIndex = current.endRowIndex ?? current.startRowIndex;
    const buffer = resolveCopySelectionBufferOrWarn(
      sessionBufferStore,
      sessions,
      sessionId,
      current.startRowIndex,
      endRowIndex,
    );
    const text = terminalBufferRowsToPlainText(buffer, current.startRowIndex, endRowIndex);
    if (!text) {
      logAsyncCleanupFailure(
        `[CopyRuntime] selected text is empty, session=${sessionId}, rows=${Math.min(current.startRowIndex, endRowIndex)}-${Math.max(current.startRowIndex, endRowIndex)}`,
        new Error("empty copy selection"),
      );
      return;
    }
    copyTextAndResetOnSuccess(text);
    keepTerminalInputFocused();
  }, [keepTerminalInputFocused, sessionBufferStore, sessions, copyTextAndResetOnSuccess]);

  const handleCloseCopyMenu = React.useCallback(() => {
    setCopySelection(EMPTY_COPY_SELECTION_STATE);
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
