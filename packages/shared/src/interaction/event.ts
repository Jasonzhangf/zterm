/**
 * event.ts — Terminal event contract (唯一真源)
 *
 * block 层执行 operation 后产出的事实记录。
 * event 由 block 层发射，由 projection 层和 orchestration 层消费。
 *
 * event 是不可变的已发生事实，不允许包含 undo/retry/planning 语义。
 */

import type { OperationType } from './operation';

export interface TerminalEventMap {
  'session/created': { sessionId: string; host: string; port: number; sessionName: string };
  'session/attached': { sessionId: string };
  'session/detached': { sessionId: string };
  'session/closed': { sessionId: string };
  'session/error': { sessionId: string; error: string; code?: string };

  'transport/connected': { sessionId: string };
  'transport/disconnected': { sessionId: string; reason?: string };
  'transport/reconnecting': { sessionId: string; attempt: number };

  'buffer/head-received': { sessionId: string; revision: number; latestEndIndex: number };
  'buffer/sync-applied': { sessionId: string; startIndex: number; endIndex: number; lineCount: number };
  'buffer/gap-detected': { sessionId: string; gapStart: number; gapEnd: number };

  'renderer/follow': { sessionId: string; renderBottomIndex: number };
  'renderer/reading': { sessionId: string; renderBottomIndex: number; viewportRows: number };
  'renderer/commit': { sessionId: string; rowsRendered: number };

  'open-tab/opened': { sessionId: string; paneId?: string };
  'open-tab/closed': { sessionId: string };
  'open-tab/moved': { sessionId: string; fromPaneId: string; targetPaneId: string };
  'open-tab/active-changed': { sessionId: string; previousSessionId?: string };

  'pane/split': { paneId: string; newPaneId: string; direction: 'horizontal' | 'vertical' };
  'pane/merged': { sourcePaneId: string; targetPaneId: string };
  'pane/activated': { paneId: string };

  'file-transfer/started': { transferId: string; sessionId: string; fileName: string; remotePath: string };
  'file-transfer/progress': { transferId: string; bytesSent: number; totalBytes: number };
  'file-transfer/completed': { transferId: string };
  'file-transfer/failed': { transferId: string; error: string };
  'file-transfer/cancelled': { transferId: string };

  'screenshot/captured': { sessionId: string; dataUrl?: string };
  'screenshot/failed': { sessionId: string; error: string };

  'schedule/created': { scheduleId: string; sessionId: string };
  'schedule/toggled': { scheduleId: string; enabled: boolean };
  'schedule/removed': { scheduleId: string };
  'schedule/fired': { scheduleId: string; sessionId: string; prompt: string };

  'app/foreground-resumed': Record<string, never>;
  'app/background-paused': Record<string, never>;
  'app/update-available': { version: string };
  'app/update-applied': Record<string, never>;

  'operation/failed': { operationType: OperationType; error: string };
}

export type EventType = keyof TerminalEventMap;

export type TerminalEvent = {
  [K in EventType]: {
    type: K;
    payload: TerminalEventMap[K];
    timestamp: number;
    operationCorrelation?: string;
  };
}[EventType];

export function createEvent<K extends EventType>(
  type: K,
  payload: TerminalEventMap[K],
  correlation?: string,
): TerminalEvent {
  return {
    type,
    payload,
    timestamp: Date.now(),
    operationCorrelation: correlation,
  } as TerminalEvent;
}

export function isEventType<K extends EventType>(
  event: TerminalEvent,
  type: K,
): event is Extract<TerminalEvent, { type: K }> {
  return event.type === type;
}
