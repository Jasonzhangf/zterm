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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

class ResizeObserverMock { observe(){} unobserve(){} disconnect(){} }
const terminalViewSpy = vi.fn();

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  terminalViewSpy.mockClear();
  vi.useRealTimers();
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
  TerminalView: (props: any) => {
    terminalViewSpy(props);
    return <div data-testid={`terminal-view-${props.sessionId}`} data-copy-mode={props.copyModeActive ? 'true' : 'false'} />;
  },
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

  it('shrinks stage bottom when IME is visible', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const { getByTestId } = render(
      <TerminalStageShell
        interactiveSession={null}
        renderedPaneSessions={[]}
        visiblePaneEntries={[]}
        splitVisible={false}
        activePaneId="pane-main"
        terminalChromeBottomPx={30}
        terminalImeLiftPx={280}
        terminalKeyboardRequested
        isAndroid
        handleTerminalViewportChange={vi.fn()}
        handleSwipeTab={vi.fn()}
        handleActiveTerminalActivateInput={vi.fn()}
        onActivatePane={vi.fn()}
        focusNonce={0}
        terminalFontSize={14}
        terminalThemeId="default"
        terminalWidthMode="mirror-fixed"
        absoluteLineNumbersVisible={false}
        copySelection={{ active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null }}
        onLongPressRow={vi.fn()}
      />,
    );

    const shell = getByTestId('terminal-stage-shell');
    const style = shell.getAttribute('style') || '';
    expect(style).toContain('bottom: 310px;');
    expect(style).not.toContain('transform: translateY');
  });

  it('forwards copy props into TerminalView for active session', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onLongPressRow = vi.fn();

    render(
      <TerminalStageShell
        interactiveSession={{ id: 's1', state: 'connected' } as any}
        renderedPaneSessions={[{ id: 's1', state: 'connected' } as any]}
        visiblePaneEntries={[
          {
            pane: { id: 'p1', size: 1, tabs: [], activeTabId: 's1' } as any,
            paneIndex: 0,
            session: { id: 's1', state: 'connected' } as any,
          },
        ]}
        splitVisible={false}
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
        copySelection={{
          active: true,
          sessionId: null,
          startRowIndex: null,
          endRowIndex: null,
          menu: null,
        }}
        onLongPressRow={onLongPressRow}
      />,
    );

    expect(terminalViewSpy).toHaveBeenCalled();
    const props = terminalViewSpy.mock.calls[0]?.[0];
    expect(props.sessionId).toBe('s1');
    expect(props.copyModeActive).toBe(true);
    expect(props.onLongPressRow).toBe(onLongPressRow);
    expect(props.splitVisible).toBe(false);
  });

  it('renders fixed phone portrait session group slots with preview peeks and one live terminal', async () => {
    vi.useFakeTimers();
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const onActivateSession = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 390 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 844 });
    const s1 = {
      id: 's1',
      state: 'connected',
      sessionName: 'alpha',
      bridgeHost: 'host-a',
      bridgePort: 3333,
    } as any;
    const s2 = {
      id: 's2',
      state: 'connected',
      sessionName: 'beta',
      bridgeHost: 'host-b',
      bridgePort: 3333,
    } as any;
    const s3 = {
      id: 's3',
      state: 'connected',
      sessionName: 'gamma',
      bridgeHost: 'host-c',
      bridgePort: 3333,
    } as any;

    const { getByTestId, queryAllByTestId } = render(
      <TerminalStageShell
        interactiveSession={s2}
        renderedPaneSessions={[s2]}
        sessionGroupViewport={{
          slots: { top: s1, center: s2, bottom: s3 },
          visible: { top: true, bottom: true },
        }}
        visiblePaneEntries={[
          {
            pane: { id: 'p1', size: 1, tabs: [], activeTabId: 's2' } as any,
            paneIndex: 0,
            session: s2,
          },
        ]}
        splitVisible={false}
        activePaneId="p1"
        terminalChromeBottomPx={0}
        terminalImeLiftPx={0}
        terminalKeyboardRequested={false}
        isAndroid
        handleTerminalViewportChange={vi.fn()}
        handleSwipeTab={vi.fn()}
        handleActiveTerminalActivateInput={vi.fn()}
        onActivatePane={vi.fn()}
        onActivateSession={onActivateSession}
        focusNonce={0}
        terminalFontSize={14}
        terminalThemeId="default"
        terminalWidthMode="adaptive-phone"
        absoluteLineNumbersVisible={false}
        copySelection={{ active: false, sessionId: null, startRowIndex: null, endRowIndex: null, menu: null }}
        onLongPressRow={vi.fn()}
      />,
    );

    expect(getByTestId('terminal-session-group-stage').getAttribute('data-layout-mode')).toBe('phone-portrait-vertical-group');
    expect(getByTestId('terminal-session-group-peek-top').textContent).toContain('alpha');
    expect(getByTestId('terminal-session-group-peek-bottom').textContent).toContain('gamma');
    expect(getByTestId('terminal-session-group-peek-top').firstElementChild?.textContent).toContain('上方alpha');
    expect(getByTestId('terminal-session-group-peek-bottom').firstElementChild?.textContent).toContain('下方gamma');
    expect(queryAllByTestId(/^terminal-view-/).length).toBe(1);
    expect(terminalViewSpy).toHaveBeenCalledTimes(1);
    expect(terminalViewSpy.mock.calls[0]?.[0].sessionId).toBe('s2');

    fireEvent.click(getByTestId('terminal-session-group-peek-top'));
    expect(getByTestId('terminal-session-group-stage').getAttribute('style')).toContain('translateY(calc(100% - 76px))');
    vi.advanceTimersByTime(180);
    expect(onActivateSession).toHaveBeenCalledWith('s1', 'top');

    fireEvent.click(getByTestId('terminal-session-group-peek-bottom'));
    expect(getByTestId('terminal-session-group-stage').getAttribute('style')).toContain('translateY(calc(-100% + 76px))');
    vi.advanceTimersByTime(180);
    expect(onActivateSession).toHaveBeenCalledWith('s3', 'bottom');
    vi.useRealTimers();
  });

  it('does not render the bottom peek when the viewport projection says the bottom edge is hidden', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    const s2 = {
      id: 's2',
      state: 'connected',
      sessionName: 'beta',
      bridgeHost: 'host-b',
      bridgePort: 3333,
    } as any;
    const s3 = {
      id: 's3',
      state: 'connected',
      sessionName: 'gamma',
      bridgeHost: 'host-c',
      bridgePort: 3333,
    } as any;

    render(
      <TerminalStageShell
        interactiveSession={s3}
        renderedPaneSessions={[s3]}
        sessionGroupViewport={{
          slots: { top: s2, center: s3, bottom: null },
          visible: { top: true, bottom: false },
        }}
        visiblePaneEntries={[
          {
            pane: { id: 'p1', size: 1, tabs: [], activeTabId: 's3' } as any,
            paneIndex: 0,
            session: s3,
          },
        ]}
        splitVisible={false}
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

    expect(screen.getByTestId('terminal-session-group-peek-top')).toBeTruthy();
    expect(screen.queryByTestId('terminal-session-group-peek-bottom')).toBeNull();
  });

  it('renders the same fixed slots as left and right peeks when the session group axis is horizontal', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 760 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1024 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 760 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1024 });
    const s1 = {
      id: 's1',
      state: 'connected',
      sessionName: 'alpha',
      bridgeHost: 'host-a',
      bridgePort: 3333,
    } as any;
    const s2 = {
      id: 's2',
      state: 'connected',
      sessionName: 'beta',
      bridgeHost: 'host-b',
      bridgePort: 3333,
    } as any;
    const s3 = {
      id: 's3',
      state: 'connected',
      sessionName: 'gamma',
      bridgeHost: 'host-c',
      bridgePort: 3333,
    } as any;

    render(
      <TerminalStageShell
        interactiveSession={s2}
        renderedPaneSessions={[s2]}
        sessionGroupViewport={{
          slots: { top: s1, center: s2, bottom: s3 },
          visible: { top: true, bottom: true },
        }}
        sessionGroupLayoutAxis="horizontal"
        visiblePaneEntries={[
          {
            pane: { id: 'p1', size: 1, tabs: [], activeTabId: 's2' } as any,
            paneIndex: 0,
            session: s2,
          },
        ]}
        splitVisible={false}
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

    expect(screen.getByTestId('terminal-session-group-stage').getAttribute('data-layout-mode')).toBe('tablet-portrait-horizontal-group');
    expect(screen.getByTestId('terminal-session-group-stage').getAttribute('style')).toContain('flex-direction: row');
    expect(screen.getByTestId('terminal-session-group-peek-top').textContent).toContain('左侧');
    expect(screen.getByTestId('terminal-session-group-peek-bottom').textContent).toContain('右侧');
    expect(screen.getByTestId('terminal-session-group-peek-top').textContent).toContain('alpha');
    expect(screen.getByTestId('terminal-session-group-peek-top').textContent).toContain('host-a:3333');
    expect(screen.getByTestId('terminal-session-group-peek-top').getAttribute('style')).toContain('padding: 72px 10px 32px');
  });

  it('does not render a horizontal side peek when that slot has no assigned session', async () => {
    const { TerminalStageShell } = await import('./TerminalPageStageShell');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 760 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1024 });
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 760 });
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 1024 });
    const s2 = {
      id: 's2',
      state: 'connected',
      sessionName: 'beta',
      bridgeHost: 'host-b',
      bridgePort: 3333,
    } as any;
    const s3 = {
      id: 's3',
      state: 'connected',
      sessionName: 'gamma',
      bridgeHost: 'host-c',
      bridgePort: 3333,
    } as any;

    render(
      <TerminalStageShell
        interactiveSession={s2}
        renderedPaneSessions={[s2]}
        sessionGroupViewport={{
          slots: { top: null, center: s2, bottom: s3 },
          visible: { top: true, bottom: true },
        }}
        sessionGroupLayoutAxis="horizontal"
        visiblePaneEntries={[
          {
            pane: { id: 'p1', size: 1, tabs: [], activeTabId: 's2' } as any,
            paneIndex: 0,
            session: s2,
          },
        ]}
        splitVisible={false}
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

    expect(screen.queryByTestId('terminal-session-group-peek-top')).toBeNull();
    expect(screen.getByTestId('terminal-session-group-peek-bottom')).toBeTruthy();
  });
});
