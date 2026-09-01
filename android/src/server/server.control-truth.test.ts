import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readControlRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-control-runtime.ts'), 'utf8');
}

function readDaemonInputQueueRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'daemon-input-queue-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 2200) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server control runtime truth gates', () => {
  it('keeps server glue delegating tmux and shell control to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalControlRuntime');
    expect(source).toContain('terminalControlRuntime = createTerminalControlRuntime({');
    expect(source).toContain('const {');
    expect(source).toContain('runTmux,');
    expect(source).toContain('writeToTmuxSession,');
    expect(source).toContain('writeToLiveMirror,');
    expect(source).toContain('listTmuxSessions,');
    expect(source).toContain('createDetachedTmuxSession,');
    expect(source).toContain('renameTmuxSession,');
    expect(source).toContain('} = terminalControlRuntime;');
  });

  it('does not keep tmux/shell control implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function cleanEnv(): Record<string, string>');
    expect(source).not.toContain('function writeToTmuxSession(');
    expect(source).not.toContain('function writeToLiveMirror(');
    expect(source).not.toContain('function runTmux(');
    expect(source).not.toContain('function runCommand(');
    expect(source).not.toContain('function listTmuxSessions(');
    expect(source).not.toContain('function createDetachedTmuxSession(');
    expect(source).not.toContain('function renameTmuxSession(');
  });

  it('keeps wezterm attach assertion backend-aware instead of falling through tmux has-session', () => {
    const source = readServerSource();
    const assertBlock = extractBlock(source, 'assertTmuxSessionExists: (sessionName, backend) => {', 700);

    expect(assertBlock).toContain("if (backend === 'herdr')");
    expect(assertBlock).toContain('HERDR_BACKEND_RUNTIME.listSessions()');
    expect(assertBlock).toContain("TERMINAL_BACKEND_RUNTIMES.wezterm?.listSessions()");
  });

  it('keeps tmux adaptive resize on the tmux owner instead of the backend adapter hook', () => {
    const source = readServerSource();
    const resizeBlock = extractBlock(source, 'resizeBackendSession:', 900);

    expect(resizeBlock).toContain("(backend || 'tmux') === 'tmux'");
    expect(resizeBlock).toContain('HERDR_BACKEND_RUNTIME');
    expect(resizeBlock).toContain('externalBackend?.resizeSession');
  });

  it('keeps tmux/shell control implementations inside dedicated control runtime', () => {
    const source = readControlRuntimeSource();
    const runBlock = extractBlock(source, 'function runTmux(');
    const tmuxLiteralChunkBlock = extractBlock(source, 'function writeTmuxLiteralChunksSync(');
    const mirrorWriteBlock = extractBlock(source, 'function writeToLiveMirror(');
    const backendWriteBlock = extractBlock(source, 'async function writeBackendInputGroup(');
    const sessionsBlock = extractBlock(source, 'function listTmuxSessions(');

    expect(runBlock).toContain("spawnSync(deps.tmuxBinary, args");
    expect(runBlock).toContain('isTmuxNoServerForListSessions(stderr, args)');
    expect(source).toContain("stderr.includes('no server running on')");
    expect(source).toContain("stderr.includes('error connecting to') && stderr.includes('No such file or directory')");
    expect(tmuxLiteralChunkBlock).toContain('splitTerminalInputUtf8Chunks(');
    expect(tmuxLiteralChunkBlock).toContain('TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES');
    expect(source).toContain('function buildExactTmuxPaneTarget(sessionName: string)');
    expect(source).toContain(":.{top-left}");
    expect(source).toContain('const target = buildExactTmuxPaneTarget(sessionName)');
    expect(tmuxLiteralChunkBlock).toContain("const segments = chunks[index]!.split('\\x04');");
    expect(tmuxLiteralChunkBlock).toContain("runTmux(['send-keys', '-t', target, '-l', '--', segments[segmentIndex]!])");
    expect(tmuxLiteralChunkBlock).toContain("runTmux(['send-keys', '-H', '-t', target, '04'])");
    expect(mirrorWriteBlock).toContain('writeTmuxLiteralChunksSync(payload, target)');
    expect(mirrorWriteBlock).not.toContain("runTmux(['send-keys', '-t', sessionName, '-l', '--', payload])");
    expect(backendWriteBlock).toContain("const segments = payload.split('\\x04');");
    expect(backendWriteBlock).toContain("await runTmuxAsync(['send-keys', '-t', target, '-l', '--', segments[index]!])");
    expect(source).not.toContain('const liveMirrorInputBatches = new Map<string, {');
    expect(source).not.toContain('function buildLiveMirrorInputGroups(');
    expect(source).not.toContain('function enqueueLiveMirrorInput(');
    expect(source).not.toContain('function disposeLiveMirrorInputBatch(');
    expect(sessionsBlock).toContain("runTmux(['list-sessions', '-F', '#S'])");
    expect(sessionsBlock).toContain('!deps.hiddenTmuxSessions.has(line)');
  });

  it('keeps daemon input receive/ack/dedupe/queue ownership in the dedicated input queue runtime', () => {
    const source = readDaemonInputQueueRuntimeSource();
    const queueBlock = extractBlock(source, 'const liveMirrorInputBatches = new Map<string, {');
    const enqueueWriteBlock = extractBlock(source, 'function enqueueLiveMirrorInput(');
    const backendWriteBlock = extractBlock(source, 'async function handleTransportInput(');

    expect(source).toContain('function normalizeReliableInputPayload(');
    expect(source).toContain('function sendInputAck(');
    expect(source).toContain('const reliableInputAckCache = createReliableInputAckCache();');
    expect(queueBlock).toContain('function buildLiveMirrorInputGroups(');
    expect(enqueueWriteBlock).toContain('schedulePendingLiveMirrorInput(mirrorKey)');
    expect(enqueueWriteBlock).not.toContain("await runTmuxAsync(['send-keys', '-t', sessionName, '-l', '--', payload])");
    expect(backendWriteBlock).toContain("await deps.handleInput(inputSession, data");
  });
});
