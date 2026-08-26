import type { ReactNode } from 'react';

export const FILE_BROWSER_UI_SLOT_ID = 'terminal.file-browser' as const;

export interface FileBrowserUiProps {
  open: boolean;
  remoteCwd: string;
  onClose: () => void;
  sendJson?: (msg: unknown) => void;
  onFileTransferMessage?: (handler: (msg: any) => void) => () => void;
  avoidSide?: 'left' | 'right' | null;
  mode?: 'browser' | 'sync';
  daemonFileScopeId?: string;
  terminalShellSkin?: 'light' | 'blue' | 'black';
}

export interface TerminalFileBrowserSlot {
  readonly slotId: typeof FILE_BROWSER_UI_SLOT_ID;
  render(props: FileBrowserUiProps): ReactNode;
}

export type FileTransferSheetProps = FileBrowserUiProps;
