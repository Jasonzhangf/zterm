import type { MutableRefObject, ReactNode } from 'react';
import type {
  Session,
  SessionDebugOverlayMetrics,
  TerminalViewportMode,
  TwoFingerWheelDebugSnapshot,
} from '../types';

export const DEBUG_CONSOLE_UI_SLOT_ID = 'terminal.debug-console' as const;

export type TerminalDebugSessionProjection = Pick<
  Session,
  | 'state'
  | 'id'
  | 'sessionName'
  | 'title'
  | 'customName'
  | 'resolvedPath'
  | 'resolvedRelayTransport'
  | 'lastConnectStage'
  | 'selectedIcePair'
>;

export function toTerminalDebugSessionProjection(
  session: Session | null,
): TerminalDebugSessionProjection | null {
  if (!session) {
    return null;
  }
  return {
    state: session.state,
    id: session.id,
    sessionName: session.sessionName,
    title: session.title,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
    resolvedRelayTransport: session.resolvedRelayTransport,
    lastConnectStage: session.lastConnectStage,
    selectedIcePair: session.selectedIcePair,
  };
}

export type RemoteWindowInputDebugSnapshot = {
  contextActive: boolean;
  contextLabel: string;
  sessionId: string;
  streamId: string;
  targetId: string;
  inputRoute: string;
  focusPolicy: string;
  lastSource: string;
  lastEvent: string;
  lastSent: boolean | null;
  lastAt: number | null;
  lastPoint: string;
  lastResult: string;
  lastResultAt: number | null;
  counts: {
    focus: number;
    pointerDown: number;
    pointerMove: number;
    pointerUp: number;
    click: number;
    scroll: number;
    key: number;
    text: number;
    accepted: number;
    error: number;
  };
  video: string;
};

export interface TerminalDebugCopySelection {
  active: boolean;
  sessionId: string | null;
  startRowIndex: number | null;
  endRowIndex: number | null;
  menu: { x: number; y: number; rowIndex: number } | null;
}

export interface TerminalDebugSessionDrawerSnapshot {
  open: boolean;
  lastEvent: string;
  eventSeq: number;
  callbackSeq: number;
  pageCallbackSeq: number;
  pickerMode: string | null;
}

export interface TerminalDebugOverlayProps {
  readonly visible: boolean;
  readonly session: TerminalDebugSessionProjection | null;
  readonly visiblePaneCount?: number;
  readonly viewportMode: TerminalViewportMode;
  readonly wheelDebug: TwoFingerWheelDebugSnapshot;
  readonly getSessionDebugMetrics?: (
    sessionId: string,
  ) => SessionDebugOverlayMetrics | null;
  readonly debugOverlayPos: { x: number; y: number };
  readonly debugOverlayDragRef: MutableRefObject<{
    startX: number;
    startY: number;
    startPosX: number;
    startPosY: number;
    dragging: boolean;
  }>;
  readonly onClose: () => void;
  readonly onMove: (next: { x: number; y: number }) => void;
  readonly keyboardInset?: number;
  readonly shellHeight?: number;
  readonly rawShellHeight?: number;
  readonly visualViewportHeight?: number;
  readonly visualViewportWidth?: number;
  readonly visualViewportOffsetTop?: number;
  readonly currentLayoutViewportHeight?: number;
  readonly terminalKeyboardRequested?: boolean;
  readonly keyboardViewportAlreadyResized?: boolean;
  readonly containerHeightPx?: number;
  readonly viewportRows?: number;
  readonly copyModeActive?: boolean;
  readonly copyStartRowIndex?: number | null;
  readonly effectiveKeyboardLiftPx?: number;
  readonly terminalImeLiftPx?: number;
  readonly quickBarShellKeyboardLiftPx?: number;
  readonly quickBarHeight?: number;
  readonly terminalChromeBottomPx?: number;
  readonly layoutMode?: string;
  readonly landscape?: boolean;
  readonly splitVisible?: boolean;
  readonly quickBarCollapsed?: boolean;
  readonly copySelection?: TerminalDebugCopySelection;
  readonly sessionDrawerDebug?: TerminalDebugSessionDrawerSnapshot;
  readonly getRemoteWindowInputDebug?: () => RemoteWindowInputDebugSnapshot;
}

export interface TerminalDebugOverlaySlot {
  readonly slotId: typeof DEBUG_CONSOLE_UI_SLOT_ID;
  render(props: TerminalDebugOverlayProps): ReactNode;
}
