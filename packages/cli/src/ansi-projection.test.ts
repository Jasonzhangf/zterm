import { describe, expect, it } from 'vitest';
import type { TerminalCell } from '../../shared/src/connection/types.js';
import {
  createAnsiProjection,
  type AnsiOutputTarget,
} from './ansi-projection.js';
import {
  createRendererWindow,
  type RendererSnapshot,
} from './renderer-window.js';

function cell(char: string, overrides: Partial<TerminalCell> = {}): TerminalCell {
  return {
    char: char.codePointAt(0) || 0x20,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
    ...overrides,
  };
}

function snapshotFor(lines: TerminalCell[][]): RendererSnapshot {
  const renderer = createRendererWindow({
    visibleRows: lines.length,
    visibleCols: Math.max(...lines.map((line) => line.length), 1),
  });
  return renderer.commit({
    revision: 1,
    startIndex: 0,
    endIndex: lines.length,
    cols: Math.max(...lines.map((line) => line.length), 1),
    rows: lines.length,
    lines: new Map(lines.map((line, index) => [index, line])),
    cursor: { rowIndex: 0, col: 0, visible: true },
  });
}

function stripControlledAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '');
}

describe('ansi-projection public contract', () => {
  it('projects colors, attributes, wide characters, and canonical cursor movement', () => {
    const writes: string[] = [];
    const projection = createAnsiProjection({
      write(value) {
        writes.push(value);
        return true;
      },
    });
    const snapshot = snapshotFor([
      [cell('A', { fg: 1, bg: 4, flags: 0x01 | 0x04 | 0x08 })],
      [cell('你', { fg: 2, width: 2 }), cell(' ', { width: 0 }), cell('B')],
    ]);

    const result = projection.commit(snapshot);
    const output = writes.join('');
    expect(result.wrote).toBe(true);
    expect(output).toContain('A');
    expect(stripControlledAnsi(output)).toContain('你B');
    expect(output).toContain('38;2;');
    expect(output).toContain('48;2;');
    expect(output).toContain(';1;');
    expect(output).toContain(';3;');
    expect(output).toContain(';4');
    expect(output).toContain('\x1b[?25h');
  });

  it('turns remote control, C1, and OSC-capable code points into safe spaces', () => {
    const writes: string[] = [];
    const projection = createAnsiProjection({
      write(value) {
        writes.push(value);
        return true;
      },
    });
    projection.commit(snapshotFor([[
      cell('\x1b'),
      cell(']'),
      cell('\x07'),
      cell('\u009d'),
      cell('X'),
    ]]));

    const output = writes.join('');
    expect(stripControlledAnsi(output)).not.toContain('\x1b');
    expect(output).not.toContain('\x1b]');
    expect(output).not.toContain('\x07');
    expect(stripControlledAnsi(output)).toBe(' ]  X');
  });

  it('skips unchanged rows and writes only changed rows on later snapshots', () => {
    const writes: string[] = [];
    const projection = createAnsiProjection({
      write(value) {
        writes.push(value);
        return true;
      },
    });
    const renderer = createRendererWindow({ visibleRows: 2, visibleCols: 4 });
    const first = renderer.commit({
      revision: 1,
      startIndex: 0,
      endIndex: 2,
      cols: 4,
      rows: 2,
      lines: new Map([[0, [cell('A')]], [1, [cell('B')]]]),
      cursor: null,
    });
    projection.commit(first);
    const baselineCount = writes.length;

    const unchanged = projection.commit(first);
    expect(unchanged.wrote).toBe(false);
    expect(writes).toHaveLength(baselineCount);

    const changed = renderer.commit({
      revision: 2,
      startIndex: 0,
      endIndex: 2,
      cols: 4,
      rows: 2,
      lines: new Map([[0, [cell('A')]], [1, [cell('C')]]]),
      cursor: null,
    });
    projection.commit(changed);
    const delta = writes.slice(baselineCount).join('');
    expect(delta).toContain('C');
    expect(delta).not.toContain('A');
  });

  it('coalesces pending local projections under stdout backpressure without touching buffer truth', async () => {
    let allow = true;
    const writes: string[] = [];
    const target: AnsiOutputTarget = {
      write(value) {
        writes.push(value);
        return allow;
      },
    };
    const projection = createAnsiProjection(target);
    const renderer = createRendererWindow({ visibleRows: 1, visibleCols: 2 });

    const makeSnapshot = (revision: number, text: string) => renderer.commit({
      revision,
      startIndex: 0,
      endIndex: 1,
      cols: 2,
      rows: 1,
      lines: new Map([[0, [cell(text)]]]),
      cursor: null,
    });

    projection.commit(makeSnapshot(1, 'A'));
    allow = false;
    const blocked = projection.commit(makeSnapshot(2, 'B'));
    expect(blocked.blocked).toBe(true);
    const beforeResume = writes.length;
    const queued = projection.commit(makeSnapshot(3, 'C'));
    expect(queued.pending).toBe(true);
    expect(writes).toHaveLength(beforeResume);

    allow = true;
    await projection.resume();
    expect(writes.slice(beforeResume).join('')).toContain('C');
    expect(writes.slice(beforeResume).join('')).not.toContain('\x1b]');
  });
});
