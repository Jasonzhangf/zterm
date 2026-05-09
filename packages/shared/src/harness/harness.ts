/**
 * harness.ts — Headless test harness (pure function, zero framework dependencies)
 *
 * 唯一职责：
 *   1. 注册 block（operation handler）
 *   2. dispatch operation → block 执行 → emit event
 *   3. 管理 projection store（由 block 写入，由 harness 读取）
 *
 * 不依赖 React / WebSocket / 任何平台 API。
 */

import type { TerminalOperation, OperationType } from '../interaction/operation';
import type { TerminalEvent } from '../interaction/event';
import { createEventBus, type TypedEventBus } from './event-bus';

/** Block 是一个 operation handler：接收 operation，返回生成的 events */
export type BlockHandler = (op: TerminalOperation, ctx: BlockContext) => TerminalEvent[];

export interface BlockContext {
  emit(event: TerminalEvent): void;
  getProjection<T>(key: string): T | undefined;
  setProjection<T>(key: string, value: T): void;
}

export interface TestHarness {
  /** 注册一个 block（指定它处理哪些 operation 类型） */
  registerBlock(opTypes: OperationType[], handler: BlockHandler): () => void;
  /** dispatch 一个 operation，同步执行所有匹配的 block */
  dispatch(op: TerminalEvent extends infer _ ? TerminalOperation : never): void;
  /** 读取某个 projection 的当前快照 */
  getProjection<T>(key: string): T | undefined;
  /** 写入某个 projection（供 block helper 调用） */
  setProjection<T>(key: string, value: T): void;
  /** 获取 event bus（用于测试中监听事件） */
  bus: TypedEventBus;
  /** 清除全部状态（projection store + event bus + block 注册） */
  clear(): void;
}

interface BlockRegistration {
  opTypes: Set<OperationType>;
  handler: BlockHandler;
}

export function createTestHarness(): TestHarness {
  const bus = createEventBus();
  const projections = new Map<string, unknown>();
  const blocks: BlockRegistration[] = [];

  const ctx: BlockContext = {
    emit: (event) => bus.emit(event),
    getProjection: <T,>(key: string) => projections.get(key) as T | undefined,
    setProjection: <T,>(key: string, value: T) => { projections.set(key, value); },
  };

  return {
    bus,

    registerBlock(opTypes, handler) {
      const reg: BlockRegistration = { opTypes: new Set(opTypes), handler };
      blocks.push(reg);
      return () => {
        const idx = blocks.indexOf(reg);
        if (idx >= 0) blocks.splice(idx, 1);
      };
    },

    dispatch(op) {
      for (const reg of blocks) {
        if (reg.opTypes.has(op.type)) {
          const events = reg.handler(op as TerminalOperation, ctx);
          for (const ev of events) {
            ctx.emit(ev);
          }
        }
      }
    },

    getProjection<T>(key: string): T | undefined {
      return projections.get(key) as T | undefined;
    },
    setProjection<T>(key: string, value: T): void {
      projections.set(key, value);
    },

    clear() {
      bus.clear();
      projections.clear();
      blocks.length = 0;
    },
  };
}
