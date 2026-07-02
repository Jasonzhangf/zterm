// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacTerminalView } from './mac-terminal-view';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';

const writeMock = vi.fn();

vi.mock('@jsonstudio/wtermmod-react', () => ({
  Terminal: () => <div data-testid="legacy-wterm-should-not-render" />,
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

  it('follows the latest daemon rows and exposes visible DOM input without hidden proxy or resize side effects', () => {
    const onViewportChange = vi.fn();
    const onInput = vi.fn();
    const onResize = vi.fn();
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
    const { container } = render(
      <MacTerminalView projection={projection(lines, 3)} onViewportChange={onViewportChange} onInput={onInput} onResize={onResize} allowDomFocus />,
    );
    const viewport = container.querySelector('[data-mac-terminal-scroll="true"]') as HTMLElement;
    expect(viewport.getAttribute('data-follow-bottom')).toBe('true');
    const terminalRows = Array.from(container.querySelectorAll('[data-terminal-row="true"]'));
    expect(terminalRows.at(-1)?.textContent).toContain('line 80');
    const terminal = container.querySelector('[data-mac-terminal-input="visible-dom"]') as HTMLElement;
    expect(terminal).toBeTruthy();
    expect(container.querySelector('[data-testid="legacy-wterm-should-not-render"]')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(onResize).not.toHaveBeenCalled();
    fireEvent.keyDown(terminal, { key: 'a' });
    expect(onInput).toHaveBeenCalledWith('a');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
    expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'reading' }));
  });

  it('does not add an extra bottom row outside Android render geometry', () => {
    const { container } = render(<MacTerminalView projection={projection(['prompt $'], 4)} allowDomFocus />);
    const grid = container.querySelector('.term-grid') as HTMLElement;
    expect(container.querySelector('[data-mac-terminal-bottom-sentinel="true"]')).toBeNull();
    expect(grid.lastElementChild?.getAttribute('data-terminal-row')).toBe('true');
    expect(grid.lastElementChild?.textContent).toContain('prompt $');
  });

  it('uses measured Mac viewport rows with Android follow geometry to keep the prompt at the bottom', async () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
    const { container } = render(<MacTerminalView projection={projection(lines, 5)} allowDomFocus />);
    const viewport = container.querySelector('[data-mac-terminal-scroll="true"]') as HTMLElement;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 170 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(viewport.scrollTop).toBe((80 - 10) * 17));
    const terminalRows = Array.from(container.querySelectorAll('[data-terminal-row="true"]'));
    expect(terminalRows.at(-1)?.textContent).toContain('line 80');
  });

  it('bottom-aligns short buffers against the real viewport bottom when height is not row-aligned', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    const { container } = render(<MacTerminalView projection={projection(lines, 6)} allowDomFocus />);
    const viewport = container.querySelector('[data-mac-terminal-scroll="true"]') as HTMLElement;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 1885 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => {
      const grid = container.querySelector('.term-grid') as HTMLElement;
      expect(grid.style.paddingTop).toBe('865px');
    });
    const terminalRows = Array.from(container.querySelectorAll('[data-terminal-row="true"]'));
    expect(terminalRows.at(-1)?.textContent).toContain('line 60');
  });

  it('pins follow mode to the real DOM bottom when the viewport height is not row-aligned', async () => {
    const lines = Array.from({ length: 160 }, (_, index) => `line ${index + 1}`);
    const { container } = render(<MacTerminalView projection={projection(lines, 7)} allowDomFocus />);
    const viewport = container.querySelector('[data-mac-terminal-scroll="true"]') as HTMLElement;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 859 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2720 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(viewport.scrollTop).toBe(2720 - 859));
    const terminalRows = Array.from(container.querySelectorAll('[data-terminal-row="true"]'));
    expect(terminalRows.at(-1)?.textContent).toContain('line 160');
  });
});
