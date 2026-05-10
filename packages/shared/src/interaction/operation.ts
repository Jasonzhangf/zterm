/**
 * operation.ts — Terminal operation contract (唯一真源)
 *
 * 所有 UI / control 发出的操作意图。
 * operation 由 UI 层 dispatch，由 block 层消费，产出 event。
 *
 * 不允许在 orchestration / adapter 中直接执行业务；
 * 必须先转为 operation 进入管道。
 */

export interface TerminalOperationMap {
  'terminal/input': { sessionId: string; data: string };
  'terminal/resize': { sessionId: string; cols: number; rows?: number };

  'session/create': { host: string; port: number; token?: string; sessionName: string };
  'session/attach': { sessionId: string };
  'session/detach': { sessionId: string };
  'session/close': { sessionId: string };
  'session/switch-active': { sessionId: string };

  'open-tab/open': { sessionId: string; paneId?: string };
  'open-tab/close': { sessionId: string };
  'open-tab/move-pane': { sessionId: string; targetPaneId: string };

  'pane/split': { paneId: string; direction: 'horizontal' | 'vertical' };
  'pane/merge': { paneId: string };
  'pane/activate': { paneId: string };

  'transport/reconnect': { sessionId: string };
  'transport/disconnect': { sessionId: string };

  'file-transfer/send': { sessionId: string; fileName: string; remotePath: string };
  'file-transfer/cancel': { transferId: string };

  'screenshot/capture': { sessionId: string };

  'schedule/create': { sessionId: string; prompt: string; intervalMs: number };
  'schedule/toggle': { scheduleId: string; enabled: boolean };
  'schedule/remove': { scheduleId: string };

  'update/check': Record<string, never>;
  'update/apply': Record<string, never>;

  'foreground/resume': Record<string, never>;
  'background/pause': Record<string, never>;

  'app/cold-start': { persistedSessionIds: string[]; tombstonedSessionIds: string[] };
}

export type OperationType = keyof TerminalOperationMap;

export type TerminalOperation = {
  [K in OperationType]: { type: K; payload: TerminalOperationMap[K] };
}[OperationType];

export function createOperation<T extends OperationType>(
  type: T,
  payload: TerminalOperationMap[T],
): TerminalOperation {
  return { type, payload } as TerminalOperation;
}

export function isOperationType<T extends OperationType>(
  op: TerminalOperation,
  type: T,
): op is Extract<TerminalOperation, { type: T }> {
  return op.type === type;
}
