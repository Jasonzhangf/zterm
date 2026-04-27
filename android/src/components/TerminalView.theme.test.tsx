// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalView } from './TerminalView';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function hexToRgbString(hex: string) {
  const normalized = hex.replace('#', '');
  const safe = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
  const red = Number.parseInt(safe.slice(0, 2), 16);
  const green = Number.parseInt(safe.slice(2, 4), 16);
  const blue = Number.parseInt(safe.slice(4, 6), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

describe('TerminalView terminal themes', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 640;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 408;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 408,
        width: 640,
        height: 17,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('maps ANSI colors from the selected theme preset', () => {
    const cell = {
      char: 'A'.codePointAt(0) || 65,
      fg: 1,
      bg: 4,
      flags: 0,
      width: 1,
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="theme-s1"
          initialBufferLines={[[cell]]}
          bufferStartIndex={0}
          bufferEndIndex={1}
          bufferTailEndIndex={1}
          active
          fontSize={5}
          themeId="gruvbox-dark"
        />
      </div>,
    );

    const cellNode = view.container.querySelector('[data-terminal-row="true"] span') as HTMLSpanElement;
    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;

    expect(cellNode).toBeTruthy();
    expect(scroller).toBeTruthy();
    expect(cellNode.style.color).toBe(hexToRgbString('#cc241d'));
    expect(cellNode.style.background).toBe(hexToRgbString('#458588'));
    expect(scroller.style.backgroundColor).toBe(hexToRgbString('#282828'));
  });

  it('uses theme foreground/background for default color cells', () => {
    const cell = {
      char: 'B'.codePointAt(0) || 66,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="theme-s2"
          initialBufferLines={[[cell]]}
          bufferStartIndex={0}
          bufferEndIndex={1}
          bufferTailEndIndex={1}
          active
          fontSize={5}
          themeId="iterm2-light"
        />
      </div>,
    );

    const cellNode = view.container.querySelector('[data-terminal-row="true"] span') as HTMLSpanElement;
    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;

    expect(cellNode.style.color).toBe(hexToRgbString('#222222'));
    expect(cellNode.style.background).toBe('transparent');
    expect(scroller.style.backgroundColor).toBe(hexToRgbString('#ffffff'));
  });

  it('does not invent cursor colors on the client and only echoes the payload styling', () => {
    const cell = {
      char: 'X'.codePointAt(0) || 88,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="theme-cursor"
          initialBufferLines={[[cell]]}
          bufferStartIndex={0}
          bufferEndIndex={1}
          bufferTailEndIndex={1}
          cursor={{ rowIndex: 0, col: 0, visible: true }}
          active
          fontSize={5}
          themeId="catppuccin-mocha"
        />
      </div>,
    );

    const cellNode = view.container.querySelector('[data-terminal-row="true"] span') as HTMLSpanElement;
    expect(cellNode.dataset.terminalCursor).toBe('true');
    expect(cellNode.style.background).toBe(hexToRgbString('#cdd6f4'));
    expect(cellNode.style.color).toBe(hexToRgbString('#1e1e2e'));
  });

  it('keeps plain reverse cells separate from cursor styling', () => {
    const FLAG_REVERSE = 0x20;
    const cell = {
      char: 'R'.codePointAt(0) || 82,
      fg: 256,
      bg: 256,
      flags: FLAG_REVERSE,
      width: 1,
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="theme-reverse"
          initialBufferLines={[[cell]]}
          bufferStartIndex={0}
          bufferEndIndex={1}
          bufferTailEndIndex={1}
          active
          fontSize={5}
          themeId="catppuccin-mocha"
        />
      </div>,
    );

    const cellNode = view.container.querySelector('[data-terminal-row="true"] span') as HTMLSpanElement;
    expect(cellNode.dataset.terminalCursor).toBeUndefined();
    expect(cellNode.style.background).toBe(hexToRgbString('#cdd6f4'));
    expect(cellNode.style.color).toBe(hexToRgbString('#1e1e2e'));
  });

  it('renders newly added Tabby-inspired theme presets', () => {
    const cell = {
      char: 'C'.codePointAt(0) || 67,
      fg: 2,
      bg: 256,
      flags: 0,
      width: 1,
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="theme-s3"
          initialBufferLines={[[cell]]}
          bufferStartIndex={0}
          bufferEndIndex={1}
          bufferTailEndIndex={1}
          active
          fontSize={5}
          themeId="tabby-encom"
        />
      </div>,
    );

    const cellNode = view.container.querySelector('[data-terminal-row="true"] span') as HTMLSpanElement;
    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;

    expect(cellNode.style.color).toBe(hexToRgbString('#008b00'));
    expect(scroller.style.backgroundColor).toBe(hexToRgbString('#000000'));
  });

  it('uses measured pixel cell widths for mixed ASCII/CJK rows instead of browser ch units', async () => {
    const originalGetBoundingClientRectForTest = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.textContent === 'W') {
        return {
          x: 0, y: 0, top: 0, left: 0, right: 6, bottom: 17, width: 6, height: 17,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (this.textContent === '你') {
        return {
          x: 0, y: 0, top: 0, left: 0, right: 14, bottom: 17, width: 14, height: 17,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return originalGetBoundingClientRectForTest.call(this);
    };

    try {
      const asciiCell = {
        char: 'A'.codePointAt(0) || 65,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 1,
      };
      const cjkLeadCell = {
        char: '你'.codePointAt(0) || 20320,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 2,
      };
      const cjkContinuationCell = {
        char: 0,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 0,
      };

      const view = render(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId="theme-width-mixed"
            initialBufferLines={[[asciiCell, cjkLeadCell, cjkContinuationCell]]}
            bufferStartIndex={0}
            bufferEndIndex={1}
            bufferTailEndIndex={1}
            active
            fontSize={5}
            themeId="catppuccin-mocha"
          />
        </div>,
      );

      await waitFor(() => {
        const spans = Array.from(view.container.querySelectorAll('[data-terminal-row="true"] span')) as HTMLSpanElement[];
        expect(spans[0]?.style.width).toBe('7px');
        expect(spans[1]?.style.width).toBe('14px');
        expect(spans[2]?.style.width).toBe('0px');
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRectForTest;
    }
  });
});
