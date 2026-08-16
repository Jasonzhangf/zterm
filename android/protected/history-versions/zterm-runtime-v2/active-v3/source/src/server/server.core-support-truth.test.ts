import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readCoreSupportSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-core-support.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 2400) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server terminal core support truth gates', () => {
  it('keeps server glue delegating terminal helper normalization to dedicated support module', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalCoreSupport');
    expect(source).toContain('const terminalCoreSupport = createTerminalCoreSupport({');
    expect(source).toContain('resolveMirrorCacheLines,');
    expect(source).toContain('sanitizeSessionName,');
    expect(source).toContain('getMirrorKey,');
    expect(source).toContain('mirrorCursorEqual,');
    expect(source).toContain('normalizeTerminalCols,');
    expect(source).toContain('normalizeTerminalRows,');
    expect(source).toContain('normalizeBufferSyncRequestPayload,');
    expect(source).toContain('} = terminalCoreSupport;');
  });

  it('does not keep terminal helper implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function resolveMirrorCacheLines(');
    expect(source).not.toContain('function sanitizeSessionName(');
    expect(source).not.toContain('function getMirrorKey(');
    expect(source).not.toContain('function mirrorCursorEqual(');
    expect(source).not.toContain('function normalizeTerminalCols(');
    expect(source).not.toContain('function normalizeTerminalRows(');
    expect(source).not.toContain('function normalizeBufferSyncRequestPayload(');
  });

  it('keeps terminal helpers inside dedicated support and delegates tmux name normalization to the shared contract', () => {
    const source = readCoreSupportSource();
    const sanitizeBlock = extractBlock(source, 'function sanitizeSessionName(');
    const bufferRequestBlock = extractBlock(source, 'function normalizeBufferSyncRequestPayload(');
    const cursorBlock = extractBlock(source, 'function mirrorCursorEqual(');

    expect(source).toContain("import { sanitizeTmuxSessionName } from '@zterm/shared/tmux-session-name';");
    expect(sanitizeBlock).toContain("sanitizeTmuxSessionName(input || '', deps.defaultSessionName)");
    expect(bufferRequestBlock).toContain('buffer-sync-request missing request window');
    expect(bufferRequestBlock).toContain('requestEndIndex: Math.max(requestStartIndex, requestEndIndex)');
    expect(cursorBlock).toContain('left.rowIndex === right.rowIndex');
    expect(cursorBlock).toContain('left.visible === right.visible');
  });
});
