import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readControlRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-control-runtime.ts'), 'utf8');
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
    const assertBlock = extractBlock(source, 'assertTmuxSessionExists: (sessionName) => {', 700);

    expect(assertBlock).toContain('if (WEZTERM_BACKEND)');
    expect(assertBlock).toContain('WEZTERM_BACKEND.listSessions()');
    expect(assertBlock).toContain("terminalControlRuntime.runTmux(['has-session', '-t', sessionName])");
    expect(assertBlock.indexOf('WEZTERM_BACKEND.listSessions()')).toBeLessThan(
      assertBlock.indexOf("terminalControlRuntime.runTmux(['has-session', '-t', sessionName])"),
    );
  });

  it('keeps tmux/shell control implementations inside dedicated control runtime', () => {
    const source = readControlRuntimeSource();
    const runBlock = extractBlock(source, 'function runTmux(');
    const tmuxLiteralChunkBlock = extractBlock(source, 'function writeTmuxLiteralChunksSync(');
    const mirrorWriteBlock = extractBlock(source, 'function writeToLiveMirror(');
    const enqueueWriteBlock = extractBlock(source, 'function enqueueLiveMirrorInput(');
    const sessionsBlock = extractBlock(source, 'function listTmuxSessions(');

    expect(runBlock).toContain("spawnSync(deps.tmuxBinary, args");
    expect(runBlock).toContain('isTmuxNoServerForListSessions(stderr, args)');
    expect(source).toContain("stderr.includes('no server running on')");
    expect(source).toContain("stderr.includes('error connecting to') && stderr.includes('No such file or directory')");
    expect(tmuxLiteralChunkBlock).toContain('splitTerminalInputUtf8Chunks(');
    expect(tmuxLiteralChunkBlock).toContain('TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES');
    expect(tmuxLiteralChunkBlock).toContain("runTmux(['send-keys', '-t', sessionName, '-l', '--', chunks[index]!])");
    expect(mirrorWriteBlock).toContain('writeTmuxLiteralChunksSync(sessionName, payload)');
    expect(mirrorWriteBlock).not.toContain("runTmux(['send-keys', '-t', sessionName, '-l', '--', payload])");
    expect(source).toContain('const liveMirrorInputBatches = new Map<string, {');
    expect(source).toContain('function buildLiveMirrorInputGroups(');
    expect(source).toContain('TERMINAL_INPUT_TMUX_WRITE_CHUNK_BYTES');
    expect(enqueueWriteBlock).toContain('schedulePendingLiveMirrorInput(mirrorKey)');
    expect(enqueueWriteBlock).not.toContain("await runTmuxAsync(['send-keys', '-t', sessionName, '-l', '--', payload])");
    expect(sessionsBlock).toContain("runTmux(['list-sessions', '-F', '#S'])");
    expect(sessionsBlock).toContain('!deps.hiddenTmuxSessions.has(line)');
  });
});
