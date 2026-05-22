// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { VisibleRow } from './VisibleRow';

describe('VisibleRow system text selection', () => {
  it('keeps row selectable in normal mode (system copy should work)', () => {
    render(
      <VisibleRow
        row={[{ char: 'a', width: 1 } as any, { char: 'b', width: 1 } as any]}
        rowIndex={0}
        absoluteIndex={1}
        rowHeight="18px"
        cellWidthPx={8}
        isGap={false}
        theme={{
          background: '#000',
          foreground: '#fff',
          cursor: '#fff',
          selection: '#333',
          ansi: ['#000','#f00','#0f0','#ff0','#00f','#f0f','#0ff','#fff'],
          brightAnsi: ['#000','#f00','#0f0','#ff0','#00f','#f0f','#0ff','#fff'],
        } as any}
        cursorColumn={-1}
      />,
    );

    const rowEl = document.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(rowEl).toBeTruthy();
    expect(rowEl.style.userSelect).toBe('text');
  });
});

