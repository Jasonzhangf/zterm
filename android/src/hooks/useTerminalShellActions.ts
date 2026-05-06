import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { OpenTabRuntimeRefs } from './useOpenTabRuntime';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { TerminalVisibleRange, TerminalViewportState } from '../lib/types';

interface UseTerminalShellActionsOptions {
  sendInput: (sessionId: string, data: string) => void;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalVisibleRange | TerminalViewportState) => void;
  getSessionRenderBufferStore: () => SessionRenderBufferStore;
  setSessionDraft: (sessionId: string, value: string) => void;
  clearSessionDraft: (sessionId: string) => void;
  pruneDrafts: (activeSessionIds: string[]) => void;
  sessionIds: string[];
  runtimeRefs: Pick<OpenTabRuntimeRefs, 'activeSessionIdRef' | 'terminalActiveSessionIdRef'>;
  handleSwitchSession: (sessionId: string) => void;
  bridgeSettings: BridgeSettings;
  shortcutFrequencyStorage: {
    getFrequencyMap: () => Record<string, number>;
    recordShortcutUse: (value: string) => void;
  };
}

export interface TerminalShellActionsResult {
  inputResetEpochBySession: Record<string, number>;
  handleTerminalInput: (sessionId: string, data: string) => void;
  handleTerminalVisibleRangeChange: (sessionId: string, visibleRange: TerminalVisibleRange) => void;
  handleQuickActionInput: (sequence: string, sessionId?: string) => void;
  handleSessionDraftChange: (value: string, sessionId?: string) => void;
  handleSessionDraftSend: (value: string, sessionId?: string) => void;
  sessionRenderBufferStore: SessionRenderBufferStore;
  shortcutFrequencyMap: Record<string, number> | undefined;
  handleShortcutUse: ((value: string) => void) | undefined;
}

export function useTerminalShellActions(options: UseTerminalShellActionsOptions): TerminalShellActionsResult {
  const {
    sendInput,
    updateSessionViewport,
    getSessionRenderBufferStore,
    setSessionDraft,
    clearSessionDraft,
    pruneDrafts,
    sessionIds,
    runtimeRefs,
    handleSwitchSession,
    bridgeSettings,
    shortcutFrequencyStorage,
  } = options;

  const { activeSessionIdRef, terminalActiveSessionIdRef } = runtimeRefs;

  const [inputResetEpochBySession, setInputResetEpochBySession] = useState<Record<string, number>>({});

  useEffect(() => {
    pruneDrafts(sessionIds);
  }, [pruneDrafts, sessionIds]);

  const bumpInputResetEpoch = useCallback((sessionId: string) => {
    const targetSessionId = sessionId.trim();
    if (!targetSessionId) {
      return;
    }
    setInputResetEpochBySession((current) => ({
      ...current,
      [targetSessionId]: (current[targetSessionId] || 0) + 1,
    }));
  }, []);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    bumpInputResetEpoch(sessionId);
    sendInput(sessionId, data);
  }, [bumpInputResetEpoch, sendInput]);

  const handleSendSessionDraft = useCallback((sessionId: string, value: string) => {
    if (!value) {
      return;
    }
    const normalized = value.replace(/\r?\n/g, '\r');
    const payload = /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
    if (activeSessionIdRef.current !== sessionId) {
      handleSwitchSession(sessionId);
    }
    handleTerminalInput(sessionId, payload);
    clearSessionDraft(sessionId);
  }, [activeSessionIdRef, clearSessionDraft, handleSwitchSession, handleTerminalInput]);

  const handleTerminalVisibleRangeChange = useCallback((sessionId: string, visibleRange: TerminalVisibleRange) => {
    updateSessionViewport(sessionId, visibleRange);
  }, [updateSessionViewport]);

  const handleQuickActionInput = useCallback((sequence: string, sessionId?: string) => {
    const targetSessionId = sessionId || terminalActiveSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    handleTerminalInput(targetSessionId, sequence);
  }, [handleTerminalInput, terminalActiveSessionIdRef]);

  const handleSessionDraftChange = useCallback((value: string, sessionId?: string) => {
    const targetSessionId = sessionId || terminalActiveSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    setSessionDraft(targetSessionId, value);
  }, [setSessionDraft, terminalActiveSessionIdRef]);

  const handleSessionDraftSend = useCallback((value: string, sessionId?: string) => {
    const targetSessionId = sessionId || terminalActiveSessionIdRef.current;
    if (!targetSessionId) {
      return;
    }
    handleSendSessionDraft(targetSessionId, value);
  }, [handleSendSessionDraft, terminalActiveSessionIdRef]);

  const sessionRenderBufferStore = useMemo(() => getSessionRenderBufferStore(), [getSessionRenderBufferStore]);
  const shortcutFrequencyMap = useMemo(
    () => (bridgeSettings.shortcutSmartSort ? shortcutFrequencyStorage.getFrequencyMap() : undefined),
    [bridgeSettings.shortcutSmartSort, shortcutFrequencyStorage],
  );
  const handleShortcutUse = bridgeSettings.shortcutSmartSort
    ? shortcutFrequencyStorage.recordShortcutUse
    : undefined;

  return {
    inputResetEpochBySession,
    handleTerminalInput,
    handleTerminalVisibleRangeChange,
    handleQuickActionInput,
    handleSessionDraftChange,
    handleSessionDraftSend,
    sessionRenderBufferStore,
    shortcutFrequencyMap,
    handleShortcutUse,
  };
}
