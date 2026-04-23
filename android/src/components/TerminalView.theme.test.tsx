// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
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
          bufferViewportEndIndex={1}
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
          bufferViewportEndIndex={1}
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
});
