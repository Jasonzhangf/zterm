import type {
  BufferSyncRequestPayload,
  TerminalBufferPayload,
  TerminalScrollbackUpdate,
  TerminalSnapshot,
  TerminalViewportUpdate,
} from './types';
import type { ScheduleEventPayload, ScheduleJobDraft, ScheduleStatePayload } from '../schedule/types';

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

export interface PasteImagePayload {
  name: string;
  mimeType: string;
  dataBase64: string;
  pasteSequence?: string;
}

export type BridgeClientMessage =
  | { type: 'connect'; payload: HostConfigMessage }
  | { type: 'stream-mode'; payload: { mode: 'active' | 'idle' } }
  | { type: 'buffer-sync-request'; payload: BufferSyncRequestPayload }
  | { type: 'list-sessions' }
  | { type: 'schedule-list'; payload: { sessionName: string } }
  | { type: 'schedule-upsert'; payload: { job: ScheduleJobDraft } }
  | { type: 'schedule-delete'; payload: { jobId: string } }
  | { type: 'schedule-toggle'; payload: { jobId: string; enabled: boolean } }
  | { type: 'schedule-run-now'; payload: { jobId: string } }
  | { type: 'input'; payload: string }
  | { type: 'paste-image'; payload: PasteImagePayload }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'ping' }
  | { type: 'close' };

export type BridgeBufferMessage =
  | { type: 'buffer-sync'; payload: TerminalBufferPayload }
  | { type: 'data'; payload: string }
  | { type: 'snapshot'; payload: TerminalSnapshot }
  | { type: 'viewport-update'; payload: TerminalViewportUpdate }
  | { type: 'scrollback-update'; payload: TerminalScrollbackUpdate };

export type BridgeServerControlMessage =
  | {
      type: 'connected';
      payload: {
        sessionId: string;
        appUpdate?: {
          versionCode: number;
          versionName: string;
          manifestUrl?: string;
        };
      };
    }
  | { type: 'sessions'; payload: { sessions: string[] } }
  | { type: 'schedule-state'; payload: ScheduleStatePayload }
  | { type: 'schedule-event'; payload: ScheduleEventPayload }
  | { type: 'image-pasted'; payload: { name: string; mimeType: string; bytes: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'title'; payload: string }
  | { type: 'closed'; payload: { reason: string } }
  | { type: 'pong' };

export type BridgeServerMessage = BridgeBufferMessage | BridgeServerControlMessage;

export function isBridgeBufferMessage(message: BridgeServerMessage): message is BridgeBufferMessage {
  return message.type === 'buffer-sync';
}
