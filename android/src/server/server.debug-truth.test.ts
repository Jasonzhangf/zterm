import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readDebugRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-debug-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 2200) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server debug runtime truth gates', () => {
  it('keeps server glue delegating debug/log helpers to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalDebugRuntime');
    expect(source).toContain('const terminalDebugRuntime = createTerminalDebugRuntime({');
    expect(source).toContain('logTimePrefix,');
    expect(source).toContain('daemonRuntimeDebug,');
    expect(source).toContain('summarizePayload,');
    expect(source).toContain('handleClientDebugLog,');
    expect(source).toContain('} = terminalDebugRuntime;');
    expect(source).toContain('resolveDebugRouteLimit');
  });

  it('does not keep debug/log helper implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function daemonRuntimeDebug(');
    expect(source).not.toContain('function truncateDaemonLogPayload(');
    expect(source).not.toContain('function normalizeClientDebugEntries(');
    expect(source).not.toContain('function handleClientDebugLog(');
    expect(source).not.toContain('function summarizePayload(');
    expect(source).not.toContain('function formatLocalLogTimestamp(');
    expect(source).not.toContain('function logTimePrefix(');
  });

  it('keeps debug/log helper implementations inside dedicated runtime', () => {
    const source = readDebugRuntimeSource();
    const debugBlock = extractBlock(source, 'function daemonRuntimeDebug(');
    const clientDebugBlock = extractBlock(source, 'function handleClientDebugLog(');
    const summaryBlock = extractBlock(source, 'function summarizePayload(');

    expect(debugBlock).toContain("console.debug(`[daemon-runtime:${scope}] ${timestamp}`");
    expect(clientDebugBlock).toContain('deps.clientRuntimeDebugStore.appendBatch');
    expect(clientDebugBlock).toContain('[client-debug]');
    expect(summaryBlock).toContain("message.type !== 'buffer-sync'");
    expect(summaryBlock).toContain('firstLineIndex');
    expect(summaryBlock).toContain('lastLineIndex');
  });
});
