// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainRuntimeDebugEntries,
  getPendingRuntimeDebugEntryCount,
  MAX_RUNTIME_DEBUG_BATCH_ENTRIES,
  MAX_RUNTIME_DEBUG_PAYLOAD_CHARS,
  MAX_RUNTIME_DEBUG_QUEUE,
  runtimeDebug,
} from './runtime-debug';

describe('runtime-debug queue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem('zterm:runtime-debug-log', '1');
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    while (getPendingRuntimeDebugEntryCount() > 0) {
      drainRuntimeDebugEntries();
    }
  });

  it('truncates oversized payloads before enqueue', () => {
    runtimeDebug('scope.a', 'x'.repeat(MAX_RUNTIME_DEBUG_PAYLOAD_CHARS + 100));
    const entries = drainRuntimeDebugEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload?.length).toBeLessThanOrEqual(MAX_RUNTIME_DEBUG_PAYLOAD_CHARS);
  });

  it('caps in-memory queue and emits drop summary', () => {
    for (let index = 0; index < MAX_RUNTIME_DEBUG_QUEUE + 5; index += 1) {
      runtimeDebug(`scope.${index}`, { index });
    }

    const firstBatch = drainRuntimeDebugEntries();
    expect(firstBatch[0]?.scope).toBe('runtime.debug.drop-summary');
    expect(firstBatch[0]?.payload).toContain('dropped=');
  });

  it('drains in bounded batches', () => {
    for (let index = 0; index < MAX_RUNTIME_DEBUG_BATCH_ENTRIES + 3; index += 1) {
      runtimeDebug(`scope.${index}`, { index });
    }

    const firstBatch = drainRuntimeDebugEntries();
    expect(firstBatch.length).toBe(MAX_RUNTIME_DEBUG_BATCH_ENTRIES);
    expect(getPendingRuntimeDebugEntryCount()).toBe(3);
  });
});
