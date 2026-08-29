import type { ReactNode } from 'react';

export const SESSION_DRAWER_UI_SLOT_ID = 'terminal.session-drawer' as const;

export type TerminalSessionGroupSlotName = 'top' | 'center' | 'bottom';
export type TerminalSessionGroupLayoutAxis = 'vertical' | 'horizontal';

export interface TerminalSessionDrawerItem {
  id: string;
  stableKey: string;
  title: string;
  subtitle: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'closed' | 'error' | 'idle';
  paneLabel?: string | null;
  sessionGroupSlot?: TerminalSessionGroupSlotName | null;
  active?: boolean;
  hostKey?: string;
  hostLabel?: string;
  terminalBackend?: 'tmux' | 'herdr';
}

export interface TerminalSessionDrawerHost {
  hostKey: string;
  hostLabel: string;
  connected?: boolean;
}

export interface TerminalSessionDrawerProps {
  open: boolean;
  topInsetPx?: number;
  bottomInsetPx?: number;
  sessions: TerminalSessionDrawerItem[];
  hosts?: TerminalSessionDrawerHost[];
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onAssignSessionGroupSlot?: (sessionId: string, slot: TerminalSessionGroupSlotName) => void;
  sessionGroupLayoutAxis?: TerminalSessionGroupLayoutAxis;
  onOpenQuickTabPicker: (hostKey?: string, createOptions?: {
    sessionName?: string;
    cwd?: string;
    terminalBackend?: 'tmux' | 'herdr';
  }) => void;
  onDebugAddEvent?: (eventName: string) => void;
  previewSelectionMode?: boolean;
  previewSelectedSessionIds?: string[];
  previewSelectionError?: string | null;
  onPreviewSelectionModeChange?: (active: boolean) => void;
  onTogglePreviewSession?: (sessionId: string) => void;
  onClearPreviewSelection?: () => void;
  terminalShellSkin?: 'light' | 'blue' | 'black';
}

export type SessionDrawerUiProps = TerminalSessionDrawerProps;

export interface TerminalSessionDrawerSlot {
  readonly slotId: typeof SESSION_DRAWER_UI_SLOT_ID;
  render(props: TerminalSessionDrawerProps): ReactNode;
}
