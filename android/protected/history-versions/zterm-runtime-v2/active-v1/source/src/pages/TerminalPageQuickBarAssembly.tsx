import { TerminalQuickBar } from "../components/terminal/TerminalQuickBar";
import type { QuickAction, TerminalShortcutAction } from "../lib/types";
import type { QuickBarScreenshotPhase } from "./terminal-page-quickbar-adapters";

export interface TerminalPageQuickBarAssemblyProps {
  activeSessionId: string | null;
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  onMeasuredHeightChange: (height: number) => void;
  onSendSequence: (sequence: string) => void;
  onImagePaste?: (sessionId: string, file: File) => Promise<void> | void;
  onFileAttach?: (sessionId: string, file: File) => Promise<void> | void;
  keyboardVisible: boolean;
  keyboardInsetPx: number;
  onToggleKeyboard: () => void;
  onQuickActionsChange?: (actions: QuickAction[]) => void;
  onShortcutActionsChange?: (actions: TerminalShortcutAction[]) => void;
  sessionDraft: string;
  onSessionDraftChange: (value: string) => void;
  onSessionDraftSend: (value: string) => void;
  onOpenScheduleComposer: (text: string) => void;
  splitAvailable: boolean;
  splitVisible: boolean;
  shellMode: "inline" | "floating-collapsed";
  collapseAvailable: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  currentSplitCount: number;
  splitCountOptions: number[];
  onSetSplitCount: (count: number) => void;
  onToggleSplitLayout: () => void;
  onCycleSplitPane: () => void;
  onEditorDomFocusChange: (active: boolean) => void;
  onOpenFileTransfer: (mode?: "browser" | "sync") => void;
  onToggleDebugOverlay: () => void;
  debugOverlayVisible: boolean;
  onToggleAbsoluteLineNumbers: () => void;
  copyDebugLabel: string;
  absoluteLineNumbersVisible: boolean;
  copyModeActive: boolean;
  onToggleCopyMode: () => void;
  onRequestRemoteScreenshot: () => void;
  remoteScreenshotStatus: QuickBarScreenshotPhase;
  shortcutSmartSort?: boolean;
  shortcutFrequencyMap?: Record<string, number>;
  onShortcutUse?: (shortcutId: string) => void;
}

export function TerminalPageQuickBarAssembly(props: TerminalPageQuickBarAssemblyProps) {
  return (
    <TerminalQuickBar
      activeSessionId={props.activeSessionId}
      quickActions={props.quickActions}
      shortcutActions={props.shortcutActions}
      onMeasuredHeightChange={props.onMeasuredHeightChange}
      onSendSequence={props.onSendSequence}
      onImagePaste={props.onImagePaste}
      onFileAttach={props.onFileAttach}
      keyboardVisible={props.keyboardVisible}
      keyboardInsetPx={props.keyboardInsetPx}
      onToggleKeyboard={props.onToggleKeyboard}
      onQuickActionsChange={props.onQuickActionsChange}
      onShortcutActionsChange={props.onShortcutActionsChange}
      sessionDraft={props.sessionDraft}
      onSessionDraftChange={props.onSessionDraftChange}
      onSessionDraftSend={props.onSessionDraftSend}
      onOpenScheduleComposer={props.onOpenScheduleComposer}
      splitAvailable={props.splitAvailable}
      splitVisible={props.splitVisible}
      shellMode={props.shellMode}
      collapseAvailable={props.collapseAvailable}
      collapsed={props.collapsed}
      onCollapsedChange={props.onCollapsedChange}
      currentSplitCount={props.currentSplitCount}
      splitCountOptions={props.splitCountOptions}
      onSetSplitCount={props.onSetSplitCount}
      onToggleSplitLayout={props.onToggleSplitLayout}
      onCycleSplitPane={props.onCycleSplitPane}
      onEditorDomFocusChange={props.onEditorDomFocusChange}
      onOpenFileTransfer={(mode) => props.onOpenFileTransfer(mode)}
      onToggleDebugOverlay={props.onToggleDebugOverlay}
      copyModeActive={props.copyModeActive}
      onToggleCopyMode={props.onToggleCopyMode}
      copyDebugLabel={props.copyDebugLabel}
      onToggleAbsoluteLineNumbers={props.onToggleAbsoluteLineNumbers}
      onRequestRemoteScreenshot={() => props.onRequestRemoteScreenshot()}
      debugOverlayVisible={props.debugOverlayVisible}
      absoluteLineNumbersVisible={props.absoluteLineNumbersVisible}
      remoteScreenshotStatus={props.remoteScreenshotStatus ?? undefined}
      shortcutSmartSort={props.shortcutSmartSort}
      shortcutFrequencyMap={props.shortcutFrequencyMap}
      onShortcutUse={props.onShortcutUse}
    />
  );
}
