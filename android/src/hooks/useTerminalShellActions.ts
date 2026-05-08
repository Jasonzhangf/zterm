import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { OpenTabRuntimeRefs } from './useOpenTabRuntime';
import type { SessionRenderBufferStore } from '../lib/session-render-buffer-store';
import type { TerminalViewportState, TerminalWidthMode } from '../lib/types';

interface UseTerminalShellActionsOptions {
  sendInput: (sessionId: string, data: string) => void;
  updateSessionViewport: (sessionId: string, visibleRange: TerminalViewportState) => void;
  sendTerminalResize: (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: TerminalWidthMode) => boolean;
  getSessionRenderBufferStore: () => SessionRenderBufferStore;
  setSessionDraft: (sessionId: string, value: string) => void;
  clearSessionDraft: (sessionId: string) => void;
  pruneDrafts: (activeSessionIds: string[]) => void;
  sessionIds: string[];
  runtimeRefs: Pick<OpenTabRuntimeRefs, 'openTabStateRef' | 'terminalActiveSessionIdRef'>;
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
  handleTerminalViewportChange: (sessionId: string, visibleRange: TerminalViewportState) => void;
  handleTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  handleTerminalWidthModeChange: (sessionId: string, mode: TerminalWidthMode, cols?: number | null) => void;
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
    sendTerminalResize,
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

  const { openTabStateRef, terminalActiveSessionIdRef } = runtimeRefs;

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

  const handleTerminalViewportChange = useCallback((sessionId: string, viewportState: TerminalViewportState) => {
    updateSessionViewport(sessionId, viewportState);
  }, [updateSessionViewport]);

  const handleTerminalResize = useCallback((sessionId: string, cols: number, rows: number) => {
    sendTerminalResize(sessionId, cols, rows, bridgeSettings.terminalWidthMode);
  }, [bridgeSettings.terminalWidthMode, sendTerminalResize]);

  const handleTerminalWidthModeChange = useCallback((sessionId: string, mode: TerminalWidthMode, cols?: number | null) => {
    if (mode === 'adaptive-phone') {
      sendTerminalResize(sessionId, cols, undefined, mode);
      return;
    }
    sendTerminalResize(sessionId, undefined, undefined, mode);
  }, [sendTerminalResize]);

  const handleSendSessionDraft = useCallback((sessionId: string, value: string) => {
    if (!value) {
      return;
    }
    const normalized = value.replace(/\r?\n/g, '\r');
    const payload = /[\r\n]$/.test(normalized) ? normalized : `${normalized}\r`;
    if (openTabStateRef.current.activeSessionId !== sessionId) {
      handleSwitchSession(sessionId);
    }
    handleTerminalInput(sessionId, payload);
    clearSessionDraft(sessionId);
  }, [clearSessionDraft, handleSwitchSession, handleTerminalInput, openTabStateRef]);

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
    handleTerminalViewportChange,
    handleTerminalResize,
    handleTerminalWidthModeChange,
    handleQuickActionInput,
    handleSessionDraftChange,
    handleSessionDraftSend,
    sessionRenderBufferStore,
    shortcutFrequencyMap,
    handleShortcutUse,
  };
}
