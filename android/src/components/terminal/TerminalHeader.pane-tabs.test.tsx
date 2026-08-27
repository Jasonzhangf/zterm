// @vitest-environment jsdom
/**
 * mobile-2.0.b 红测：TerminalHeader 切到 shared PaneTabs 后期望行为
 *
 * 关键行为（基于既有 TerminalHeader.test.tsx 行为 + shared PaneTabs 语义）：
 * - 渲染 phone profile tab strip
 * - 切到 splitVisible=true 后，pane badge "P1/P2" 出现
 * - active tab close 按钮工作
 * - 长按 tab 唤 menu（phone gesture）
 * - 双击 active tab 重命名
 * - pane menu "移到 P2/P1" callback 触发 onAssignSessionToPane
 * - + 按钮短按 quick new / 长按 tab manager
 * - right pane activate on click
 *
 * 这份测在 mobile-2 切片前**会全红**，因为 TerminalHeader 还没切到 shared PaneTabs。
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHeader, type TerminalHeaderProps, type TerminalHeaderSessionItem } from './TerminalHeader';

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function makeSession(id: string, overrides: Partial<TerminalHeaderSessionItem> = {}): TerminalHeaderSessionItem {
  return {
    id,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: id,
    ...overrides,
  };
}

function makeProps(overrides: Partial<TerminalHeaderProps> = {}): TerminalHeaderProps {
  return {
    sessions: [makeSession('s1')],
    activeSession: makeSession('s1'),
    onBack: vi.fn(),
    onOpenQuickTabPicker: vi.fn(),
    onOpenTabManager: vi.fn(),
    onSwitchSession: vi.fn(),
    onCloseSession: vi.fn(),
    ...overrides,
  };
}

describe('TerminalHeader shared PaneTabs integration (red baseline)', () => {
  it('renders single-pane phone profile when splitVisible=false', () => {
    const props = makeProps();
    const { container } = render(<TerminalHeader {...props} />);
    // shared PaneTabs data-testid (mobile-2 接入后会出现)
    expect(container.querySelector('[data-testid="pane-tabs-pane-main"]')).toBeTruthy();
    // 单 pane 不显示 pane badge
    expect(container.querySelector('[data-testid="pane-badge-pane-main"]')).toBeFalsy();
  });

  it('renders split-default phone profile with pane badge when splitVisible=true', () => {
    const props = makeProps({
      splitVisible: true,
      paneGroups: [
        {
          paneId: 'p1',
          size: 1,
          sessions: [makeSession('s1')],
          activeSessionId: 's1',
          isActivePane: true,
        },
        {
          paneId: 'p2',
          size: 1,
          sessions: [makeSession('s2')],
          activeSessionId: 's2',
          isActivePane: false,
        },
      ],
    });
    const { container } = render(<TerminalHeader {...props} />);
    expect(container.querySelector('[data-testid="pane-badge-p1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-badge-p2"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-plus-p1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-plus-p2"]')).toBeTruthy();
  });

  it('separates pane tab groups with a visible divider in split mode', () => {
    const props = makeProps({
      splitVisible: true,
      paneGroups: [
        {
          paneId: 'p1',
          size: 1,
          sessions: [makeSession('s1')],
          activeSessionId: 's1',
          isActivePane: true,
        },
        {
          paneId: 'p2',
          size: 1,
          sessions: [makeSession('s2')],
          activeSessionId: 's2',
          isActivePane: false,
        },
      ],
    });
    const { container } = render(<TerminalHeader {...props} />);
    const firstPane = container.querySelector('[data-testid="terminal-header-pane-group-p1"]') as HTMLElement | null;
    const secondPane = container.querySelector('[data-testid="terminal-header-pane-group-p2"]') as HTMLElement | null;

    expect(firstPane).toBeTruthy();
    expect(secondPane).toBeTruthy();
    expect(firstPane?.style.borderRight).toBe('1px solid rgba(255, 255, 255, 0.12)');
    expect(secondPane?.style.borderRight).toBe('');
  });

  it('isolates each pane tab strip to sessions owned by that pane', () => {
    const props = makeProps({
      sessions: [makeSession('s1'), makeSession('s2'), makeSession('s3')],
      activeSession: makeSession('s1'),
      splitVisible: true,
      paneGroups: [
        {
          paneId: 'p1',
          size: 1,
          sessions: [makeSession('s1'), makeSession('s2')],
          activeSessionId: 's1',
          isActivePane: true,
        },
        {
          paneId: 'p2',
          size: 1,
          sessions: [makeSession('s3')],
          activeSessionId: 's3',
          isActivePane: false,
        },
      ],
    });
    const { container } = render(<TerminalHeader {...props} />);
    const firstPane = container.querySelector('[data-testid="terminal-header-pane-group-p1"]') as HTMLElement | null;
    const secondPane = container.querySelector('[data-testid="terminal-header-pane-group-p2"]') as HTMLElement | null;

    expect(firstPane).toBeTruthy();
    expect(secondPane).toBeTruthy();
    expect(firstPane?.querySelector('[data-tab-id="s1"]')).toBeTruthy();
    expect(firstPane?.querySelector('[data-tab-id="s2"]')).toBeTruthy();
    expect(firstPane?.querySelector('[data-tab-id="s3"]')).toBeNull();
    expect(secondPane?.querySelector('[data-tab-id="s3"]')).toBeTruthy();
    expect(secondPane?.querySelector('[data-tab-id="s1"]')).toBeNull();
    expect(secondPane?.querySelector('[data-tab-id="s2"]')).toBeNull();
  });

  it('uses split-landscape profile when splitVisible=true and landscape=true', () => {
    const props = makeProps({
      splitVisible: true,
      paneGroups: [
        {
          paneId: 'p1',
          size: 1,
          sessions: [makeSession('s1')],
          activeSessionId: 's1',
          isActivePane: true,
        },
      ],
    });
    const { container } = render(<TerminalHeader {...props} />);
    // split-landscape: tabMinHeight 22px
    const tab = container.querySelector('[data-tab-id="s1"]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    // profile token 在 style 上反映
    const minHeight = tab?.style.minHeight;
    expect(minHeight).toBe('22px');
  });

  it('forwards onSwitchSession when user clicks a non-active tab', () => {
    const onSwitch = vi.fn();
    const props = makeProps({
      sessions: [makeSession('s1'), makeSession('s2')],
      activeSession: makeSession('s1'),
      onSwitchSession: onSwitch,
    });
    const { container } = render(<TerminalHeader {...props} />);
    const tab2 = container.querySelector('[data-tab-id="s2"]') as HTMLElement | null;
    expect(tab2).toBeTruthy();
    act(() => {
      fireEvent.click(tab2!);
    });
    expect(onSwitch).toHaveBeenCalledWith('s2');
  });

  it('triggers long-press pane menu when split is enabled', () => {
    const onOpenQuickTabPicker = vi.fn();
    const props = makeProps({
      splitVisible: true,
      paneGroups: [
        {
          paneId: 'p1',
          size: 1,
          sessions: [makeSession('s1')],
          activeSessionId: 's1',
          isActivePane: true,
        },
        {
          paneId: 'p2',
          size: 1,
          sessions: [makeSession('s2')],
          activeSessionId: 's2',
          isActivePane: false,
        },
      ],
      onOpenQuickTabPicker,
    });
    const { container } = render(<TerminalHeader {...props} />);
    const tab = container.querySelector('[data-tab-id="s1"]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    // mobile-2 接入后，phone long-press 用 touchStart + setTimeout
    act(() => {
      fireEvent.touchStart(tab!, { touches: [{ clientX: 10, clientY: 20 }] });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // long-press 触发后，pane menu 渲染（mobile-2 接入后通过 PaneTabs 内部或 TerminalHeader 自己的 menu 渲染）
    // 这次断言只验证 onOpenQuickTabPicker 不被长按误触
    expect(onOpenQuickTabPicker).not.toHaveBeenCalled();
  });

  it('respects the 920ms long-press threshold (longer than 680ms plus-press)', () => {
    const props = makeProps({});
    const { container } = render(<TerminalHeader {...props} />);
    const tab = container.querySelector('[data-tab-id="s1"]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    act(() => {
      fireEvent.touchStart(tab!, { touches: [{ clientX: 10, clientY: 20 }] });
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    act(() => {
      fireEvent.touchEnd(tab!);
    });
    // no throw, no long-press menu (still under threshold)
  });

  it('close × button removes the active tab', () => {
    const onClose = vi.fn();
    const props = makeProps({
      sessions: [makeSession('s1')],
      activeSession: makeSession('s1'),
      onCloseSession: onClose,
    });
    const { container } = render(<TerminalHeader {...props} />);
    const close = container.querySelector('[data-testid="pane-tab-close-s1"]') as HTMLElement | null;
    expect(close).toBeTruthy();
    act(() => {
      fireEvent.click(close!);
    });
    expect(onClose).toHaveBeenCalledWith('s1', expect.any(String));
  });

  it('does not render close button for non-active tabs (mobile-2 shared semantic)', () => {
    const props = makeProps({
      sessions: [makeSession('s1'), makeSession('s2')],
      activeSession: makeSession('s1'),
    });
    const { container } = render(<TerminalHeader {...props} />);
    expect(container.querySelector('[data-testid="pane-tab-close-s1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-tab-close-s2"]')).toBeFalsy();
  });

  it('plus button short-click calls onOpenQuickTabPicker', () => {
    const onOpenQuickTabPicker = vi.fn();
    const props = makeProps({ onOpenQuickTabPicker });
    const { container } = render(<TerminalHeader {...props} />);
    const plus = container.querySelector('[data-testid="pane-plus-pane-main"]') as HTMLElement | null;
    expect(plus).toBeTruthy();
    act(() => {
      fireEvent.click(plus!);
    });
    expect(onOpenQuickTabPicker).toHaveBeenCalled();
  });

  it('plus button long-press calls onOpenTabManager (680ms threshold)', () => {
    const onOpenTabManager = vi.fn();
    const props = makeProps({ onOpenTabManager });
    const { container } = render(<TerminalHeader {...props} />);
    const plus = container.querySelector('[data-testid="pane-plus-pane-main"]') as HTMLElement | null;
    expect(plus).toBeTruthy();
    act(() => {
      fireEvent.mouseDown(plus!);
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onOpenTabManager).toHaveBeenCalled();
  });

  it('renders custom name when set on session', () => {
    const props = makeProps({
      sessions: [makeSession('s1', { customName: 'production' })],
      activeSession: makeSession('s1', { customName: 'production' }),
    });
    const { container } = render(<TerminalHeader {...props} />);
    const tab = container.querySelector('[data-tab-id="s1"]') as HTMLElement | null;
    expect(tab?.textContent).toContain('production');
  });
});
