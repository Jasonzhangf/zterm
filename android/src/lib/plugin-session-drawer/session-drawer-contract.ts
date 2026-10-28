import type { ReactNode } from 'react';
import type { TerminalSessionCollabProjection } from '@zterm/shared/protocol';
import type { SessionDrawerFilterMode } from './session-drawer-visibility';

export const SESSION_DRAWER_UI_SLOT_ID = 'terminal.session-drawer' as const;

export type TerminalSessionGroupSlotName = 'top' | 'center' | 'bottom';
export type TerminalSessionGroupLayoutAxis = 'vertical' | 'horizontal';

export interface TerminalSessionDrawerItem {
  id: string;
  stableKey: string;
  title: string;
  subtitle: string;
  sessionName?: string;
  paneLabel?: string | null;
  sessionGroupSlot?: TerminalSessionGroupSlotName | null;
  active?: boolean;
  hostKey?: string;
  hostLabel?: string;
  terminalBackend?: 'tmux' | 'herdr';
  cwd?: string;
  /** Read-only daemon Collab projection; absent means unclassified. */
  collab?: TerminalSessionCollabProjection;
}

export interface TerminalSessionDrawerHost {
  hostKey: string;
  hostLabel: string;
  connected?: boolean;
}

/**
 * Per-host pre-filter membership and removal reasons. Empty states must be
 * derived from the selected host, never from a global count or from stale
 * persisted hidden names that belong to another host.
 */
export interface TerminalSessionDrawerHostSummary {
  hostKey: string;
  /** Live sessions on this host before any drawer visibility filtering. */
  unfilteredSessionCount: number;
  /** Sessions removed because their name is in the persisted hidden list. */
  hiddenSessionCount: number;
  /** Sessions removed only by the active role filter (not by hiding). */
  roleFilteredSessionCount: number;
}

export interface TerminalSessionDrawerProps {
  open: boolean;
  topInsetPx?: number;
  bottomInsetPx?: number;
  sessions: TerminalSessionDrawerItem[];
  /**
   * Non-hidden sessions before role filter (`only-master` / `hide-worker`).
   * Used in `only-master` mode so a project folder with a Collab Master can
   * expand and reveal the remaining sessions in that project on demand.
   */
  unfilteredSessions?: TerminalSessionDrawerItem[];
  hosts?: TerminalSessionDrawerHost[];
  /**
   * Host-scoped membership facts. When present, the empty state reflects the
   * selected host instead of the global catalog counts.
   */
  hostSummaries?: TerminalSessionDrawerHostSummary[];
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
  onHideSession?: (sessionId: string) => void;
  onRestoreAllHiddenSessions?: () => void;
  hiddenSessionCount?: number;
  hiddenSessionNames?: string[];
  onRestoreHiddenSession?: (sessionName: string) => void;
  /**
   * Total session count before drawer visibility filtering. Used to report a
   * truthful "showing N / M" header line and to distinguish an empty host from
   * a filter that matched nothing. Derived from the same catalog as `sessions`.
   */
  unfilteredSessionCount?: number;
  filterMode?: SessionDrawerFilterMode;
  onFilterModeChange?: (mode: SessionDrawerFilterMode) => void;
  terminalShellSkin?: 'light' | 'blue' | 'black';
}

export type SessionDrawerUiProps = TerminalSessionDrawerProps;

export interface TerminalSessionDrawerSlot {
  readonly slotId: typeof SESSION_DRAWER_UI_SLOT_ID;
  render(props: TerminalSessionDrawerProps): ReactNode;
}
