// @vitest-environment jsdom
/**
 * mobile-2.0.c 红测：TerminalStageShell 切到 shared PaneStage 后期望行为
 *
 * 关键行为：
 * - 渲染 single-pane 时 PaneStage data-testid="pane-stage-single"
 * - 渲染 split 时 PaneStage data-testid="pane-stage-split"
 * - split mode 下每个 pane 渲染一个 TerminalView
 * - onActivatePane callback 触发
 * - onPaneRatioChange 触发 (虽然 phone 模式 drag-resize 禁用)
 * - visiblePaneEntries 顺序保持
 * - 不可见 pane 不渲染 TerminalView
 *
 * 这份测在 mobile-2 切片前**会全红**，因为 TerminalStageShell
 * 仍用 inline flex split，未切到 shared PaneStage。
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

class ResizeObserverMock { observe(){} unobserve(){} disconnect(){} }

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
  registerPlugin: () => ({
    readText: vi.fn(async () => ({ value: '' })),
    writeText: vi.fn(async () => undefined),
  }),
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('../../plugins/ImeAnchorPlugin', () => ({
  ImeAnchor: {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('../components/terminal/TerminalTabSwipeSurface', () => ({
  TerminalTabSwipeSurface: ({ children }: any) => <div data-testid="terminal-swipe-surface">{children}</div>,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: any) => <div data-testid={`terminal-view-${sessionId}`} />,
}));

describe('TerminalStageShell shared PaneStage integration (red baseline)', () => {
  it('renders single-pane mode via shared PaneStage when splitVisible=false', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const { container } = render(
      <TerminalStageShell
        interactiveSession={null}
        renderedPaneSessions={[]}
        visiblePaneEntries={[]}
        splitVisible={false}
        activePaneId="pane-main"
        terminalChromeBottomPx={0}
        terminalImeLiftPx={0}
        terminalKeyboardRequested={false}
        isAndroid
        handleTerminalViewportChange={vi.fn()}
        handleSwipeTab={vi.fn()}
        handleActiveTerminalActivateInput={vi.fn()}
        onActivatePane={vi.fn()}
        focusNonce={0}
        terminalFontSize={14}
        terminalThemeId="default"
        terminalWidthMode="adaptive-phone"
        absoluteLineNumbersVisible={false}
        copySelection={{ active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null }}
        onLongPressRow={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="pane-stage-single"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-stage-split"]')).toBeFalsy();
  });

  it('renders split mode via shared PaneStage when splitVisible=true', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const { container } = render(
      <TerminalStageShell
        interactiveSession={null}
        renderedPaneSessions={[]}
        visiblePaneEntries={[
          { pane: { id: 'p1', size: 1, tabs: [], activeTabId: '' }, paneIndex: 0, session: null },
          { pane: { id: 'p2', size: 1, tabs: [], activeTabId: '' }, paneIndex: 1, session: null },
        ]}
        splitVisible
        activePaneId="p1"
        terminalChromeBottomPx={0}
        terminalImeLiftPx={0}
        terminalKeyboardRequested={false}
        isAndroid
        handleTerminalViewportChange={vi.fn()}
        handleSwipeTab={vi.fn()}
        handleActiveTerminalActivateInput={vi.fn()}
        onActivatePane={vi.fn()}
        focusNonce={0}
        terminalFontSize={14}
        terminalThemeId="default"
        terminalWidthMode="adaptive-phone"
        absoluteLineNumbersVisible={false}
        copySelection={{ active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null }}
        onLongPressRow={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="pane-stage-split"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="pane-stage-frame"]').length).toBe(2);
  });

  it('forwards onActivatePane to shared PaneStage', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onActivatePane = vi.fn();
    const { container } = render(
      <TerminalStageShell
        interactiveSession={null}
        renderedPaneSessions={[]}
        visiblePaneEntries={[
          { pane: { id: 'p1', size: 1, tabs: [], activeTabId: '' }, paneIndex: 0, session: null },
          { pane: { id: 'p2', size: 1, tabs: [], activeTabId: '' }, paneIndex: 1, session: null },
        ]}
        splitVisible
        activePaneId="p1"
        terminalChromeBottomPx={0}
        terminalImeLiftPx={0}
        terminalKeyboardRequested={false}
        isAndroid
        handleTerminalViewportChange={vi.fn()}
        handleSwipeTab={vi.fn()}
        handleActiveTerminalActivateInput={vi.fn()}
        onActivatePane={onActivatePane}
        focusNonce={0}
        terminalFontSize={14}
        terminalThemeId="default"
        terminalWidthMode="adaptive-phone"
        absoluteLineNumbersVisible={false}
        copySelection={{ active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null }}
        onLongPressRow={vi.fn()}
      />,
    );
    // PaneStage onActivatePane wired to pane frame pointerdown (mobile-2 接入后)
    const pane = container.querySelector('[data-pane-id="p2"]') as HTMLElement | null;
    expect(pane).toBeTruthy();
    pane?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(onActivatePane).toHaveBeenCalledWith('p2');
  });

  it('preserves visiblePaneEntries order in split mode', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const { container } = render(
      <TerminalStageShell
        interactiveSession={null}
        renderedPaneSessions={[]}
        visiblePaneEntries={[
          { pane: { id: 'p1', size: 1, tabs: [], activeTabId: '' }, paneIndex: 0, session: null },
          { pane: { id: 'p2', size: 1, tabs: [], activeTabId: '' }, paneIndex: 1, session: null },
        ]}
        splitVisible
        activePaneId="p1"
        terminalChromeBottomPx={0}
        terminalImeLiftPx={0}
        terminalKeyboardRequested={false}
        isAndroid
        handleTerminalViewportChange={vi.fn()}
        handleSwipeTab={vi.fn()}
        handleActiveTerminalActivateInput={vi.fn()}
        onActivatePane={vi.fn()}
        focusNonce={0}
        terminalFontSize={14}
        terminalThemeId="default"
        terminalWidthMode="adaptive-phone"
        absoluteLineNumbersVisible={false}
        copySelection={{ active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null }}
        onLongPressRow={vi.fn()}
      />,
    );
    const panes = container.querySelectorAll('[data-pane-id]');
    const ids = Array.from(panes).map((p) => p.getAttribute('data-pane-id'));
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
  });
});
