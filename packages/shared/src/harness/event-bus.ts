/**
 * event-bus.ts — Typed synchronous event bus (pure function, zero dependencies)
 *
 * 唯一职责：注册 listener / 发射 event / 按类型过滤。
 * 不做持久化、不做重放、不做异步调度。
 */

import type { TerminalEvent, EventType } from '../interaction/event';

export type EventListener<T extends TerminalEvent = TerminalEvent> = (event: T) => void;

export interface TypedEventBus {
  /** 注册全量监听器，返回 unsubscribe */
  on<E extends TerminalEvent>(listener: EventListener<E>): () => void;
  /** 按事件类型注册，返回 unsubscribe */
  onType<K extends EventType>(type: K, listener: EventListener<Extract<TerminalEvent, { type: K }>>): () => void;
  /** 同步发射一个事件 */
  emit(event: TerminalEvent): void;
  /** 查询某类型最近一次事件（只缓存最新一条） */
  last<K extends EventType>(type: K): Extract<TerminalEvent, { type: K }> | undefined;
  /** 清除全部 listeners 和 last cache */
  clear(): void;
}

export function createEventBus(): TypedEventBus {
  // 全量 listener 列表
  const allListeners = new Set<EventListener>();
  // 按类型分组的 listener
  const typedListeners = new Map<EventType, Set<EventListener>>();
  // 每个类型缓存最新一条
  const lastCache = new Map<EventType, TerminalEvent>();

  return {
    on(listener) {
      allListeners.add(listener as EventListener);
      return () => { allListeners.delete(listener as EventListener); };
    },
    onType(type, listener) {
      let bucket = typedListeners.get(type);
      if (!bucket) {
        bucket = new Set();
        typedListeners.set(type, bucket);
      }
      bucket.add(listener as EventListener);
      return () => { bucket!.delete(listener as EventListener); };
    },
    emit(event) {
      lastCache.set(event.type, event);
      // 全量 listeners
      for (const fn of allListeners) {
        fn(event);
      }
      // 类型 listeners
      const bucket = typedListeners.get(event.type);
      if (bucket) {
        for (const fn of bucket) {
          fn(event);
        }
      }
    },
    last(type) {
      return lastCache.get(type) as Extract<TerminalEvent, { type: typeof type }> | undefined;
    },
    clear() {
      allListeners.clear();
      typedListeners.clear();
      lastCache.clear();
    },
  };
}

