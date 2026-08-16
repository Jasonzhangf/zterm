import type { ReactNode } from 'react';
import type { TerminalQuickBarProps } from '../../components/terminal/TerminalQuickBar';

export const QUICKBAR_UI_SLOT_ID = 'terminal.quickbar' as const;

export type QuickBarUiProps = TerminalQuickBarProps;

export interface TerminalQuickBarSlot {
  readonly slotId: typeof QUICKBAR_UI_SLOT_ID;
  render(props: QuickBarUiProps): ReactNode;
}
