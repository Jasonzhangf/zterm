// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacTerminalView } from './mac-terminal-view';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';

const writeMock = vi.fn();

vi.mock('@jsonstudio/wtermmod-react', () => ({
  Terminal: () => <div data-testid="mock-wterm-input-proxy" />,
}));

function cell(char: string, extra: Partial<TerminalCell> = {}): TerminalCell {
  return {
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
    ...extra,
  };
}

function projection(lines: string[], revision = 1, mutate?: (line: TerminalCell[], rowIndex: number) => TerminalCell[]): TerminalRenderBufferProjection {
  return {
    lines: lines.map((line, rowIndex) => {
      const cells = Array.from(line).map((char) => cell(char));
      return mutate ? mutate(cells, rowIndex) : cells;
    }),
    gapRanges: [],
    startIndex: 0,
    endIndex: lines.length,
    viewportEndIndex: lines.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    revision,
  };
}

afterEach(() => {
  cleanup();
  writeMock.mockClear();
});

describe('MacTerminalView render projection bridge', () => {
  it('renders projection as scrollable colored DOM rows instead of a write-only snapshot', () => {
    const { container } = render(
      <MacTerminalView
        projection={projection(['daemon ready'], 7, (line) => {
          line[0] = { ...line[0], fg: 1 };
          return line;
        })}
      />,
    );
    const viewport = container.querySelector('[data-mac-terminal-scroll="true"]') as HTMLElement;
    expect(viewport).toBeTruthy();
    expect(viewport.style.overflowY).toBe('auto');
    expect(container.querySelector('[data-terminal-row="true"]')?.textContent).toContain('daemon ready');
    expect(container.querySelector('[data-terminal-row="true"] span span')?.getAttribute('style')).toContain('color:');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('updates rendered daemon content when projection revision changes', () => {
    const { container, rerender } = render(<MacTerminalView projection={projection(['first frame'], 1)} />);
    expect(container.querySelector('[data-terminal-row="true"]')?.textContent).toContain('first frame');
    rerender(<MacTerminalView projection={projection(['second live frame'], 2)} />);
    expect(container.querySelector('[data-terminal-row="true"]')?.textContent).toContain('second live frame');
  });
});
