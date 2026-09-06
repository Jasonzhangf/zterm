import type { ReactNode } from 'react';
import type { ClientMessage } from '../types';
import type { FileTransferMessage } from '../file-transfer-message-runtime';

export type FileBrowserCommand = Extract<ClientMessage, { type: `file-${string}` }>;

export interface FileBrowserSessionPort {
  readonly daemonFileScopeId: string;
  readonly sendJson: (message: FileBrowserCommand) => void;
  readonly onFileTransferMessage: (handler: (message: FileTransferMessage) => void) => () => void;
}

export type ResolveFileBrowserSessionPort = (sessionId: string) => FileBrowserSessionPort;

export const FILE_BROWSER_UI_SLOT_ID = 'terminal.file-browser' as const;

export interface FileBrowserUiProps {
  open: boolean;
  remoteCwd: string;
  onClose: () => void;
  sendJson?: FileBrowserSessionPort['sendJson'];
  onFileTransferMessage?: FileBrowserSessionPort['onFileTransferMessage'];
  avoidSide?: 'left' | 'right' | null;
  mode?: 'browser' | 'sync';
  daemonFileScopeId?: string;
  terminalShellSkin?: 'light' | 'blue' | 'black';
  embedded?: boolean;
}

export interface TerminalFileBrowserSlot {
  readonly slotId: typeof FILE_BROWSER_UI_SLOT_ID;
  render(props: FileBrowserUiProps): ReactNode;
}

export type FileTransferSheetProps = FileBrowserUiProps;
