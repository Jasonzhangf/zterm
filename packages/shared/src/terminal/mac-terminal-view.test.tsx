// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacTerminalView } from './mac-terminal-view';
import type { TerminalCell, TerminalRenderBufferProjection } from '../connection/types';

const writeMock = vi.fn();
const resizeMock = vi.fn();
const destroyMock = vi.fn();

vi.mock('@jsonstudio/wtermmod-react', () => ({
  Terminal: React.forwardRef(({ onReady, onData, onResize, cols, rows }: any, ref: any) => {
    const handle = React.useMemo(
      () => ({ write: writeMock, resize: resizeMock, focus: vi.fn(), instance: null }),
      [],
    );
    React.useImperativeHandle(ref, () => handle, [handle]);
    React.useEffect(() => {
      onReady?.(handle);
    }, [handle, onReady]);
    React.useEffect(() => {
      onData?.('');
      onResize?.(cols, rows);
    }, [cols, onData, onResize, rows]);
    return <div data-testid="mock-wterm" />;
  }),
}));

function cell(char: string): TerminalCell {
  return {
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
  };
}

function projection(text: string, revision = 1): TerminalRenderBufferProjection {
  return {
    lines: text.split('\n').map((line) => Array.from(line).map(cell)),
    gapRanges: [],
    startIndex: 0,
    endIndex: text.split('\n').length,
    viewportEndIndex: text.split('\n').length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    revision,
  };
}

afterEach(() => {
  cleanup();
  writeMock.mockClear();
  resizeMock.mockClear();
  destroyMock.mockClear();
});

describe('MacTerminalView render projection bridge', () => {
  it('writes projection text into the wterm surface when daemon buffer changes', async () => {
    render(<MacTerminalView projection={projection('daemon ready', 7)} />);
    await waitFor(() => expect(writeMock).toHaveBeenCalled());
    expect(writeMock).toHaveBeenCalledWith(expect.stringContaining('daemon ready'));
  });
});
