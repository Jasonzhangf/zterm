import type { ReactNode } from 'react';
import type { Session } from '../types';
import type { ClientMessage } from '../types';
import type { FileTransferMessage } from '../file-transfer-message-runtime';
import type { FileTransferSessionRuntime } from '../file-transfer-session-runtime';

export type FileBrowserCommand = Extract<ClientMessage, { type: `file-${string}` }>;

export interface FileBrowserSessionPort {
  readonly daemonFileScopeId: string;
  readonly fileTransferRuntime: FileTransferSessionRuntime;
  readonly sendJson: (message: FileBrowserCommand) => void;
  readonly onFileTransferMessage: (handler: (message: FileTransferMessage) => void) => () => void;
  readonly onFileTransferStateChange: (handler: () => void) => () => void;
  readonly dispose: () => Promise<void>;
}

export interface FileBrowserSessionPortOwner {
  resolve(input: {
    session: Pick<Session, 'id' | 'daemonHostId' | 'bridgeHost' | 'bridgePort'> | undefined;
  }): FileBrowserSessionPort;
  reconcile(liveSessionIds: Iterable<string>): void;
  dispose(): Promise<void>;
}

export type ResolveFileBrowserSessionPort = (sessionId: string) => FileBrowserSessionPort;

export const FILE_BROWSER_UI_SLOT_ID = 'terminal.file-browser' as const;

export interface FileBrowserUiProps {
  open: boolean;
  remoteCwd: string;
  onClose: () => void;
  sendJson?: FileBrowserSessionPort['sendJson'];
  onFileTransferMessage?: FileBrowserSessionPort['onFileTransferMessage'];
  fileTransferRuntime: FileBrowserSessionPort['fileTransferRuntime'];
  onFileTransferStateChange: FileBrowserSessionPort['onFileTransferStateChange'];
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
