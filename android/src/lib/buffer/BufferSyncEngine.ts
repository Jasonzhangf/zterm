/**
 * BufferSyncEngine - 管理 buffer 同步请求（tail-refresh 和 reading-repair）。
 * 
 * 职责：
 * 1. 维护每个 session 的请求状态，防止重复发送。
 * 2. 提供 requestTailRefresh 和 requestReadingRepair 方法。
 * 3. 当收到 daemon 的 buffer-sync 响应时，通过回调通知上层。
 * 4. 依赖注入发送函数和诊断记录函数。
 * 
 * 不处理 buffer 数据的应用（由上层通过回调完成）。
 */

import {
  buildSessionBufferSyncRequestPayload,
  doesSessionPullStateCoverRequest,
  getPrimarySessionPullState,
  hasActiveSessionPullState,
  type SessionPullPurpose,
  type SessionPullStates,
} from '../../contexts/session-sync-helpers';
import type { TerminalBufferPayload, SessionVisibleRangeState } from '../../lib/types';

export type BufferSyncTransport = {
  send(data: string | ArrayBuffer): void;
  readonly readyState: number;
};

export type BufferSyncDiagnostics = {
  recordTx: (sessionId: string, data: string | ArrayBuffer, options?: any) => void;
  runtimeDebug: (scope: string, data: any) => void;
};

export type BufferSyncCallbacks = {
  onBufferSync: (sessionId: string, payload: TerminalBufferPayload) => void;
  onRequestFailure?: (sessionId: string, purpose: SessionPullPurpose, error: Error) => void;
};

/**
 * 请求状态，与 session-sync-helpers 中的 SessionPullStates 兼容。
 */
type PullStateEntry = SessionPullStates[string] & {
  purpose: SessionPullPurpose;
  startedAt: number;
};

export class BufferSyncEngine {
  private pullStates: Map<string, SessionPullStates> = new Map();
  private getTransport: (sessionId: string) => BufferSyncTransport | null;
  private diagnostics: BufferSyncDiagnostics;
  private callbacks: BufferSyncCallbacks;

  constructor(
    getTransport: (sessionId: string) => BufferSyncTransport | null,
    diagnostics: BufferSyncDiagnostics,
    callbacks: BufferSyncCallbacks,
  ) {
    this.getTransport = getTransport;
    this.diagnostics = diagnostics;
    this.callbacks = callbacks;
  }

  /**
   * 请求 tail-refresh（跟随模式下的尾部刷新或首次加载）。
   * @param sessionId
   * @param window 期望的窗口范围 { startIndex, endIndex }
   * @param viewportRows 视口行数，用于构建请求中的窗口大小。
   * @param currentBufferState 当前 buffer 状态，用于计算 missingRanges（如果需要）。
   */
  requestTailRefresh(
    sessionId: string,
    window: { startIndex: number; endIndex: number },
    viewportRows: number,
    currentBufferState?: { startIndex: number; endIndex: number; lines: (string | null)[] }
  ): void {
    const purpose: SessionPullPurpose = 'tail-refresh';
    const payload = buildSessionBufferSyncRequestPayload(
      { buffer: currentBufferState || { startIndex: 0, endIndex: 0, lines: [] } },
      window,
      { purpose, viewportRows }
    );
    if (!payload) {
      // 无法构建 payload（例如窗口无效）
      return;
    }
    this.executeRequest(sessionId, purpose, payload);
  }

  /**
   * 请求 reading-repair（用户滚动时修复可见区域的缺失行）。
   * @param sessionId
   * @param missingRanges 缺失的行范围数组 [{ start, end }]
   * @param viewportRows 视口行数
   * @param currentBufferState 当前 buffer 状态
   */
  requestReadingRepair(
    sessionId: string,
    missingRanges: { start: number; end: number }[],
    viewportRows: number,
    currentBufferState: { startIndex: number; endIndex: number; lines: (string | null)[] }
  ): void {
    const purpose: SessionPullPurpose = 'reading-repair';
    // 对于 reading-repair，我们需要一个可见窗口。通常 missingRanges 已经表达了需要修复的区域，
    // 但 buildSessionBufferSyncRequestPayload 期望提供一个可见窗口范围。我们取 missingRanges 的并集作为窗口。
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const range of missingRanges) {
      if (range.start < minStart) minStart = range.start;
      if (range.end > maxEnd) maxEnd = range.end;
    }
    if (!isFinite(minStart) || !isFinite(maxEnd)) return;
    const window = { startIndex: minStart, endIndex: maxEnd };
    const payload = buildSessionBufferSyncRequestPayload(
      { buffer: currentBufferState },
      window,
      { purpose, viewportRows }
    );
    if (!payload) return;
    this.executeRequest(sessionId, purpose, payload);
  }

  /**
   * 处理来自 daemon 的 buffer-sync 响应。
   * 上层在收到消息后调用此方法，引擎会清除对应的 pull state 并触发回调。
   * @param sessionId
   * @param payload 原始 TerminalBufferPayload
   */
  handleBufferSync(sessionId: string, payload: TerminalBufferPayload): void {
    // 清除该 session 的所有 pull states（因为响应已到达）
    this.clearPullState(sessionId);
    this.callbacks.onBufferSync(sessionId, payload);
  }

  /**
   * 当 session 断开或销毁时，清理相关状态。
   */
  dispose(sessionId: string): void {
    this.pullStates.delete(sessionId);
  }

  /**
   * 内部执行请求：检查是否有飞行中的请求覆盖当前需求，若无则发送消息并记录状态。
   */
  private executeRequest(
    sessionId: string,
    purpose: SessionPullPurpose,
    payload: { type: 'buffer-sync-request'; payload: any }
  ): void {
    const transport = this.getTransport(sessionId);
    if (!transport || transport.readyState !== WebSocket.OPEN) {
      // 无可用 transport，忽略请求（上层应有重试机制）
      this.diagnostics.runtimeDebug('buffer-sync.no-transport', { sessionId, purpose });
      return;
    }

    // 检查是否已有飞行中的请求覆盖此需求
    const existingPullStates = this.pullStates.get(sessionId) || {};
    const inFlight = existingPullStates[purpose] as PullStateEntry | undefined;
    if (inFlight && doesSessionPullStateCoverRequest(inFlight, payload)) {
      // 已有请求覆盖，跳过重复发送
      this.diagnostics.runtimeDebug('buffer-sync.duplicate-skipped', { sessionId, purpose });
      return;
    }

    // 更新状态
    const newPullState: PullStateEntry = {
      purpose,
      startedAt: Date.now(),
      targetHeadRevision: payload.payload.targetHeadRevision,
      targetStartIndex: payload.payload.startIndex,
      targetEndIndex: payload.payload.endIndex,
      requestKnownRevision: payload.payload.requestKnownRevision,
      requestLocalStartIndex: payload.payload.requestLocalStartIndex,
      requestLocalEndIndex: payload.payload.requestLocalEndIndex,
    };
    const nextPullStates = {
      ...existingPullStates,
      [purpose]: newPullState,
    };
    this.pullStates.set(sessionId, nextPullStates);

    // 发送消息
    const messageStr = JSON.stringify(payload);
    try {
      transport.send(messageStr);
      this.diagnostics.recordTx(sessionId, messageStr, {
        pullPurpose: purpose,
        targetHeadRevision: payload.payload.targetHeadRevision,
        targetStartIndex: payload.payload.startIndex,
        targetEndIndex: payload.payload.endIndex,
        requestKnownRevision: payload.payload.requestKnownRevision,
        requestLocalStartIndex: payload.payload.requestLocalStartIndex,
        requestLocalEndIndex: payload.payload.requestLocalEndIndex,
      });
    } catch (err) {
      // 发送失败，清除状态并通知上层
      this.clearPullStateForPurpose(sessionId, purpose);
      this.diagnostics.runtimeDebug('buffer-sync.send-error', { sessionId, purpose, error: String(err) });
      this.callbacks.onRequestFailure?.(sessionId, purpose, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private clearPullState(sessionId: string): void {
    this.pullStates.delete(sessionId);
  }

  private clearPullStateForPurpose(sessionId: string, purpose: SessionPullPurpose): void {
    const existing = this.pullStates.get(sessionId);
    if (existing) {
      const { [purpose]: _, ...rest } = existing;
      if (Object.keys(rest).length === 0) {
        this.pullStates.delete(sessionId);
      } else {
        this.pullStates.set(sessionId, rest);
      }
    }
  }
}
