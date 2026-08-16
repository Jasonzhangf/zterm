/**
 * Submodule tests: terminal-buffer-sync-wire (daemon.mirror_store).
 */
import { describe, expect, it } from 'vitest';
import {
  buildBufferSyncMessageText,
  getWireLineAbsoluteIndex,
  splitBufferSyncPayloadMessages,
} from './terminal-buffer-sync-wire';
import type { TerminalBufferPayload } from '@zterm/shared/types';

function payload(lines: Array<{ i?: number; index?: number }>, startIndex = 0): TerminalBufferPayload {
  return {
    type: 'buffer-sync',
    sessionId: 's1',
    revision: 1,
    startIndex,
    endIndex: startIndex + lines.length,
    lines: lines as TerminalBufferPayload['lines'],
    cols: 80,
    rows: 24,
    frameStartIndex: startIndex,
    frameEndIndex: startIndex + lines.length,
  } as unknown as TerminalBufferPayload;
}

describe('terminal-buffer-sync-wire', () => {
  it('resolves wire line absolute indices from i or index fields', () => {
    expect(getWireLineAbsoluteIndex({ i: 5 } as never)).toBe(5);
    expect(getWireLineAbsoluteIndex({ index: 7 } as never)).toBe(7);
    expect(getWireLineAbsoluteIndex({ i: -3 } as never)).toBe(0);
    expect(getWireLineAbsoluteIndex({} as never)).toBeNull();
    expect(getWireLineAbsoluteIndex(null as never)).toBeNull();
  });

  it('builds buffer-sync wire text', () => {
    const text = buildBufferSyncMessageText(payload([{ i: 0 }]));
    expect(text).toContain('"type":"buffer-sync"');
  });

  it('keeps small payloads unchunked', () => {
    const messages = splitBufferSyncPayloadMessages(payload([{ i: 0 }, { i: 1 }]), 10_000_000);
    expect(messages.length).toBe(1);
    expect(messages[0]!.payload.frameChunkCount).toBeUndefined();
  });

  it('splits oversized payloads into continuous frame chunks with correct indices', () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ i }));
    const messages = splitBufferSyncPayloadMessages(payload(lines), 300);
    expect(messages.length).toBeGreaterThan(1);
    let cursor = 0;
    for (const message of messages) {
      expect(message.payload.frameChunkCount).toBe(messages.length);
      expect(message.payload.startIndex).toBe(cursor);
      cursor = message.payload.endIndex;
      const lineIndices = message.payload.lines.map((line) => getWireLineAbsoluteIndex(line));
      expect(lineIndices[0]).toBe(message.payload.startIndex);
      expect(lineIndices[lineIndices.length - 1]).toBe(message.payload.endIndex - 1);
    }
    expect(cursor).toBe(50);
  });
});
