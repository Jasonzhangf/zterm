import type { ReactNode } from 'react';
import type { FileTransferSheetProps } from '../../components/terminal/FileTransferSheet';

export const FILE_BROWSER_UI_SLOT_ID = 'terminal.file-browser' as const;

export type FileBrowserUiProps = FileTransferSheetProps;

export interface TerminalFileBrowserSlot {
  readonly slotId: typeof FILE_BROWSER_UI_SLOT_ID;
  render(props: FileBrowserUiProps): ReactNode;
}
