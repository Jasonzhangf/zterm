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

  it('keeps tmux/shell control implementations inside dedicated control runtime', () => {
    const source = readControlRuntimeSource();
    const runBlock = extractBlock(source, 'function runTmux(');
    const mirrorWriteBlock = extractBlock(source, 'function writeToLiveMirror(');
    const sessionsBlock = extractBlock(source, 'function listTmuxSessions(');

    expect(runBlock).toContain("spawnSync(deps.tmuxBinary, args");
    expect(runBlock).toContain("stderr.includes('no server running on') && args[0] === 'list-sessions'");
    expect(mirrorWriteBlock).toContain("runTmux(['send-keys', '-t', sessionName, '-l', '--', payload])");
    expect(sessionsBlock).toContain("runTmux(['list-sessions', '-F', '#S'])");
    expect(sessionsBlock).toContain('!deps.hiddenTmuxSessions.has(line)');
  });
});
