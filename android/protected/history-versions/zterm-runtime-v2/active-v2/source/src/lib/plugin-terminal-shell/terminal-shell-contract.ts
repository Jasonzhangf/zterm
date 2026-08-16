import type { ReactNode } from 'react';
import type { TerminalConnectionStatusStripProps } from '../../pages/TerminalConnectionStatusStrip';
import type { TerminalPageCopyMenuProps } from '../../pages/TerminalPageCopyMenu';
import type { TerminalStageShellProps } from '../../pages/TerminalPageStageShell';
import type { TerminalNetworkBannerProps } from '../../pages/terminal-page-shell-ui';

export const TERMINAL_SHELL_UI_SLOT_ID = 'terminal.shell' as const;

export interface TerminalShellTopProjection {
  statusStrip: TerminalConnectionStatusStripProps | null;
  controls: ReactNode;
}

export interface TerminalShellQuickBarProjection {
  visible: boolean;
  bottomPx: number;
  zIndex: number;
  centered: boolean;
  children: ReactNode;
}

export interface TerminalShellUiProps {
  networkBanner: TerminalNetworkBannerProps;
  topProjection: TerminalShellTopProjection;
  stage: TerminalStageShellProps;
  copyMenu: TerminalPageCopyMenuProps | null;
  bottomProjection: ReactNode;
  quickBarShell: TerminalShellQuickBarProjection;
}

export interface TerminalShellUiSlot {
  readonly slotId: typeof TERMINAL_SHELL_UI_SLOT_ID;
  render(props: Readonly<TerminalShellUiProps>): ReactNode;
}
