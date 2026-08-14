/**
 * buffer-sync wire 分片纯函数子模块（daemon.mirror_store）。
 * 从 terminal-mirror-runtime.ts 拆出：wire line index 解析 / buffer-sync 消息构建 / 大帧分片。
 */
import type { TerminalBufferPayload } from '@zterm/shared/types';


export function getWireLineAbsoluteIndex(line: TerminalBufferPayload['lines'][number]) {
  if (!line) {
    return null;
  }
  if ('i' in line && Number.isFinite(line.i)) {
    return Math.max(0, Math.floor(line.i));
  }
  if ('index' in line && Number.isFinite(line.index)) {
    return Math.max(0, Math.floor(line.index));
  }
  return null;
}

export function buildBufferSyncMessageText(payload: TerminalBufferPayload) {
  return JSON.stringify({ type: 'buffer-sync', payload });
}

export function splitBufferSyncPayloadMessages(payload: TerminalBufferPayload, maxBytes: number) {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const fullText = buildBufferSyncMessageText(payload);
  if (Buffer.byteLength(fullText, 'utf8') <= maxBytes || lines.length <= 1) {
    return [{ payload, text: fullText }];
  }

  const messages: Array<{ payload: TerminalBufferPayload; text: string }> = [];
  let chunkLines: TerminalBufferPayload['lines'] = [];
  let chunkStartIndex: number | null = null;
  let chunkEndIndex: number | null = null;
  const frameStartIndex = Math.max(0, Math.floor(payload.startIndex || 0));
  const frameEndIndex = Math.max(frameStartIndex, Math.floor(payload.endIndex || frameStartIndex));
  const buildChunkPayload = (
    startIndex: number,
    endIndex: number,
    nextLines: TerminalBufferPayload['lines'],
    chunkIndex: number,
    chunkCount: number,
  ): TerminalBufferPayload => ({
    ...payload,
    startIndex,
    endIndex,
    frameStartIndex,
    frameEndIndex,
    frameChunkIndex: chunkIndex,
    frameChunkCount: chunkCount,
    lines: nextLines,
  });

  const flushChunk = () => {
    if (chunkLines.length === 0 || chunkStartIndex === null || chunkEndIndex === null) {
      return;
    }
    const chunkPayload = buildChunkPayload(chunkStartIndex, chunkEndIndex, chunkLines, messages.length, 9999);
    messages.push({ payload: chunkPayload, text: buildBufferSyncMessageText(chunkPayload) });
    chunkLines = [];
    chunkStartIndex = null;
    chunkEndIndex = null;
  };

  for (const line of lines) {
    const lineIndex = getWireLineAbsoluteIndex(line);
    if (lineIndex === null) {
      continue;
    }
    const candidateStartIndex: number = chunkStartIndex === null ? lineIndex : chunkStartIndex;
    const candidateEndIndex: number = Math.max(chunkEndIndex === null ? lineIndex + 1 : chunkEndIndex, lineIndex + 1);
    const candidateLines: TerminalBufferPayload['lines'] = [...chunkLines, line];
    const candidatePayload = buildChunkPayload(candidateStartIndex, candidateEndIndex, candidateLines, messages.length, 9999);
    const candidateText = buildBufferSyncMessageText(candidatePayload);
    if (chunkLines.length > 0 && Buffer.byteLength(candidateText, 'utf8') > maxBytes) {
      flushChunk();
      chunkStartIndex = lineIndex;
      chunkEndIndex = lineIndex + 1;
      chunkLines = [line];
      continue;
    }
    chunkStartIndex = candidateStartIndex;
    chunkEndIndex = candidateEndIndex;
    chunkLines = candidateLines;
  }
  flushChunk();

  if (messages.length <= 1) {
    return messages.length > 0 ? messages : [{ payload, text: fullText }];
  }

  return messages.map((message, index) => {
    const chunkPayload = buildChunkPayload(
      message.payload.startIndex,
      message.payload.endIndex,
      message.payload.lines,
      index,
      messages.length,
    );
    return { payload: chunkPayload, text: buildBufferSyncMessageText(chunkPayload) };
  });
}


