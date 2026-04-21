import type {
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportUpdate,
} from './types';

export interface HostConfigMessage {
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  cols?: number;
  rows?: number;
  authToken?: string;
  autoCommand?: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
}

export type BridgeClientMessage =
  | { type: 'connect'; payload: HostConfigMessage }
  | { type: 'stream-mode'; payload: { mode: 'active' | 'idle' } }
  | { type: 'list-sessions' }
  | { type: 'input'; payload: string }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'ping' }
  | { type: 'close' };

export type BridgeBufferMessage =
  | { type: 'data'; payload: string }
  | { type: 'snapshot'; payload: TerminalSnapshot }
  | { type: 'viewport-update'; payload: TerminalViewportUpdate }
  | { type: 'scrollback-update'; payload: TerminalScrollbackUpdate };

export type BridgeServerControlMessage =
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

export type BridgeServerMessage = BridgeBufferMessage | BridgeServerControlMessage;

export function isBridgeBufferMessage(message: BridgeServerMessage): message is BridgeBufferMessage {
  return (
    message.type === 'data'
    || message.type === 'snapshot'
    || message.type === 'viewport-update'
    || message.type === 'scrollback-update'
  );
}
