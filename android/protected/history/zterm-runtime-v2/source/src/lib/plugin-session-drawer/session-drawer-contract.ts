import type { ReactNode } from 'react';
import type { TerminalSessionDrawerProps } from '../../components/terminal/TerminalSessionDrawer';

export const SESSION_DRAWER_UI_SLOT_ID = 'terminal.session-drawer' as const;

export type SessionDrawerUiProps = TerminalSessionDrawerProps;

export interface TerminalSessionDrawerSlot {
  readonly slotId: typeof SESSION_DRAWER_UI_SLOT_ID;
  render(props: TerminalSessionDrawerProps): ReactNode;
}
