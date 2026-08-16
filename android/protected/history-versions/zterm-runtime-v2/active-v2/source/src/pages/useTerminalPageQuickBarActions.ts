import * as React from "react";

export interface UseTerminalPageQuickBarActionsOptions {
  uiSessionId: string | null;
  keyboardInset: number;
  terminalKeyboardRequested: boolean;
  setQuickBarHeight: React.Dispatch<React.SetStateAction<number>>;
  keepTerminalInputFocused: () => void;
  onQuickActionInput?: (sequence: string, sessionId?: string) => void;
  onSessionDraftChange?: (value: string, sessionId?: string) => void;
  onSessionDraftSend?: (value: string, sessionId?: string) => void;
}

export interface UseTerminalPageQuickBarActionsResult {
  handleQuickBarMeasuredHeightChange: (height: number) => void;
  handleQuickBarSendSequence: (sequence: string) => void;
  handleQuickBarSessionDraftChange: (value: string) => void;
  handleQuickBarSessionDraftSend: (value: string) => void;
}

export function useTerminalPageQuickBarActions(
  options: UseTerminalPageQuickBarActionsOptions,
): UseTerminalPageQuickBarActionsResult {
  const {
    uiSessionId,
    keyboardInset,
    terminalKeyboardRequested,
    setQuickBarHeight,
    keepTerminalInputFocused,
    onQuickActionInput,
    onSessionDraftChange,
    onSessionDraftSend,
  } = options;

  const handleQuickBarMeasuredHeightChange = React.useCallback((height: number) => {
    setQuickBarHeight((current: number) => (current === height ? current : height));
  }, [setQuickBarHeight]);

  const handleQuickBarSendSequence = React.useCallback((sequence: string) => {
    onQuickActionInput?.(sequence, uiSessionId || undefined);
    if (terminalKeyboardRequested || keyboardInset > 0) {
      keepTerminalInputFocused();
    }
  }, [keyboardInset, keepTerminalInputFocused, onQuickActionInput, terminalKeyboardRequested, uiSessionId]);

  const handleQuickBarSessionDraftChange = React.useCallback((value: string) => {
    onSessionDraftChange?.(value, uiSessionId || undefined);
  }, [onSessionDraftChange, uiSessionId]);

  const handleQuickBarSessionDraftSend = React.useCallback((value: string) => {
    onSessionDraftSend?.(value, uiSessionId || undefined);
    if (terminalKeyboardRequested || keyboardInset > 0) {
      keepTerminalInputFocused();
    }
  }, [keyboardInset, keepTerminalInputFocused, onSessionDraftSend, terminalKeyboardRequested, uiSessionId]);

  return {
    handleQuickBarMeasuredHeightChange,
    handleQuickBarSendSequence,
    handleQuickBarSessionDraftChange,
    handleQuickBarSessionDraftSend,
  };
}
