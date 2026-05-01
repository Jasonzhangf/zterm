import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readServerSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'server.ts'), 'utf8');
}

function readScheduleRuntimeSource() {
  return readFileSync(join(process.cwd(), 'src', 'server', 'terminal-schedule-runtime.ts'), 'utf8');
}

function extractBlock(source: string, anchor: string, length = 1800) {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + length);
}

describe('server schedule runtime truth gates', () => {
  it('keeps server glue delegating schedule orchestration to dedicated runtime', () => {
    const source = readServerSource();

    expect(source).toContain('createTerminalScheduleRuntime');
    expect(source).toContain('terminalScheduleRuntime = createTerminalScheduleRuntime({');
    expect(source).toContain('const { scheduleEngine, sendScheduleStateToSession } = terminalScheduleRuntime;');
    expect(source).toContain('terminalScheduleRuntime.dispose()');
  });

  it('does not keep schedule state/event broadcast implementations in server.ts', () => {
    const source = readServerSource();

    expect(source).not.toContain('function buildScheduleStatePayload(');
    expect(source).not.toContain('function sendScheduleStateToSession(');
    expect(source).not.toContain('function broadcastScheduleState(');
    expect(source).not.toContain('function broadcastScheduleEvent(');
    expect(source).not.toContain('new ScheduleEngine({');
  });

  it('keeps schedule state/event bridge inside dedicated runtime', () => {
    const source = readScheduleRuntimeSource();
    const stateBlock = extractBlock(source, 'function sendScheduleStateToSession(');
    const eventBlock = extractBlock(source, 'function broadcastScheduleEvent(');
    const engineBlock = extractBlock(source, 'const scheduleEngine = new ScheduleEngine({');

    expect(stateBlock).toContain("type: 'schedule-state'");
    expect(eventBlock).toContain("type: 'schedule-event'");
    expect(engineBlock).toContain('onStateChange: (sessionName) =>');
    expect(engineBlock).toContain('broadcastScheduleState(sessionName)');
    expect(engineBlock).toContain('onEvent: (event) =>');
    expect(engineBlock).toContain('broadcastScheduleEvent(event)');
  });
});
