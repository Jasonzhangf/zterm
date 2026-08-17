import type { ReactNode } from 'react';
import type { RemoteWindowOverlayProps } from '../../components/terminal/RemoteWindowOverlay';

export const REMOTE_WINDOW_UI_SLOT_ID = 'terminal.remote-window' as const;

export type RemoteWindowUiProps = RemoteWindowOverlayProps;

export interface TerminalRemoteWindowSlot {
  readonly slotId: typeof REMOTE_WINDOW_UI_SLOT_ID;
  render(props: RemoteWindowUiProps): ReactNode;
}

export type {
  RemoteWindowInputContext,
  RemoteWindowOverlayProps,
  RemoteWindowVideoDebugSnapshot,
} from '../../components/terminal/RemoteWindowOverlay';
