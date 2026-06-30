// @vitest-environment jsdom
/**
 * mobile-2.0.d 红测：shared PaneTabs 在 Android jsdom 黑盒下行为
 *
 * 验证 shared PaneTabs 是 Android 端切片的真源：
 * - 渲染 phone profile token (longPressMs=920, swipeLockPx=12)
 * - 接受 platform='phone' 后不渲染 right-click 监听
 * - 接受 platform='tablet' 后既支持 long-press 又支持 right-click
 * - 接受 platform='desktop' 后只支持 right-click
 * - tab 行 data-testid 一致 (pane-tabs-{paneId} / pane-tab-close-{tabId} / pane-plus-{paneId})
 *
 * 本测**应当全绿**（shared PaneTabs 已稳定），用于 mobile-2 切片的真源基线
 * ——防止"接入后回归 shared PaneTabs 行为"。
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneTabs, resolvePaneProfile, type PaneTabDescriptor } from '@zterm/shared';

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

function makeTabs(...overrides: Array<Partial<PaneTabDescriptor>>): PaneTabDescriptor[] {
  return overrides.map((o, i) => ({
    id: o.id ?? `t${i + 1}`,
    title: o.title ?? `Tab ${i + 1}`,
    isActive: o.isActive ?? i === 0,
  }));
}

describe('shared PaneTabs in Android jsdom (red baseline)', () => {
  it('phone profile uses 920ms longPress', () => {
    const profile = resolvePaneProfile({ platform: 'phone', splitVisible: true, topInsetPx: 0 });
    expect(profile.gesture.longPressMs).toBe(920);
    expect(profile.gesture.contextMenuTrigger).toBe('long-press');
  });

  it('tablet profile enables both long-press and right-click', () => {
    const profile = resolvePaneProfile({ platform: 'tablet', splitVisible: true, topInsetPx: 0 });
    expect(profile.gesture.contextMenuTrigger).toBe('both');
  });

  it('desktop profile uses right-click and ctrl-page', () => {
    const profile = resolvePaneProfile({ platform: 'desktop', splitVisible: true, topInsetPx: 0 });
    expect(profile.gesture.contextMenuTrigger).toBe('right-click');
    expect(profile.gesture.tabSwitchTrigger).toBe('ctrl-page');
  });

  it('renders PaneTabs with stable testid for android e2e selectors', () => {
    const profile = resolvePaneProfile({ platform: 'phone', splitVisible: false, topInsetPx: 0 });
    const { container } = render(
      <PaneTabs
        platform="phone"
        profile={profile}
        paneId="p1"
        paneIndex={0}
        isActivePane
        tabs={makeTabs({ id: 't1', isActive: true }, { id: 't2' })}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onActivatePane={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-testid="pane-tabs-p1"]')).toBeTruthy();
    expect(container.querySelector('[data-tab-id="t1"]')).toBeTruthy();
    expect(container.querySelector('[data-tab-id="t2"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pane-tab-close-t1"]')).toBeTruthy();
  });

  it('does NOT render right-click handler on phone', () => {
    const profile = resolvePaneProfile({ platform: 'phone', splitVisible: false, topInsetPx: 0 });
    const onContextMenu = vi.fn();
    const { container } = render(
      <PaneTabs
        platform="phone"
        profile={profile}
        paneId="p1"
        paneIndex={0}
        isActivePane
        tabs={makeTabs({ id: 't1', isActive: true })}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onActivatePane={vi.fn()}
        onContextMenuTab={onContextMenu}
      />,
    );
    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    // right-click on phone: should be noop
    act(() => {
      fireEvent.contextMenu(tab!);
    });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('renders right-click handler on desktop', () => {
    const profile = resolvePaneProfile({ platform: 'desktop', splitVisible: false, topInsetPx: 0 });
    const onContextMenu = vi.fn();
    const { container } = render(
      <PaneTabs
        platform="desktop"
        profile={profile}
        paneId="p1"
        paneIndex={0}
        isActivePane
        tabs={makeTabs({ id: 't1', isActive: true })}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onActivatePane={vi.fn()}
        onContextMenuTab={onContextMenu}
      />,
    );
    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement | null;
    expect(tab).toBeTruthy();
    act(() => {
      fireEvent.contextMenu(tab!, { clientX: 100, clientY: 200 });
    });
    expect(onContextMenu).toHaveBeenCalledWith('t1', { left: 100, top: 200 });
  });

  it('renders plus button testid when plusButton prop provided', () => {
    const profile = resolvePaneProfile({ platform: 'phone', splitVisible: false, topInsetPx: 0 });
    const onQuick = vi.fn();
    const onManager = vi.fn();
    const { container } = render(
      <PaneTabs
        platform="phone"
        profile={profile}
        paneId="p1"
        paneIndex={0}
        isActivePane
        tabs={makeTabs({ id: 't1', isActive: true })}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onActivatePane={vi.fn()}
        plusButton={{ onQuickNew: onQuick, onOpenTabManager: onManager }}
      />,
    );
    const plus = container.querySelector('[data-testid="pane-plus-p1"]') as HTMLElement | null;
    expect(plus).toBeTruthy();
    act(() => {
      fireEvent.click(plus!);
    });
    expect(onQuick).toHaveBeenCalled();
    // 长按 920ms → onOpenTabManager
    act(() => {
      fireEvent.mouseDown(plus!);
    });
    act(() => {
      vi.advanceTimersByTime(950);
    });
    expect(onManager).toHaveBeenCalled();
  });

  it('renders pane badge only when splitVisible=true', () => {
    const profileSingle = resolvePaneProfile({ platform: 'phone', splitVisible: false, topInsetPx: 0 });
    const profileSplit = resolvePaneProfile({ platform: 'phone', splitVisible: true, topInsetPx: 0 });
    const { container: c1 } = render(
      <PaneTabs
        platform="phone"
        profile={profileSingle}
        paneId="p1"
        paneIndex={0}
        isActivePane
        tabs={makeTabs({ id: 't1', isActive: true })}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onActivatePane={vi.fn()}
      />,
    );
    expect(c1.querySelector('[data-testid="pane-badge-p1"]')).toBeFalsy();
    cleanup();
    const { container: c2 } = render(
      <PaneTabs
        platform="phone"
        profile={profileSplit}
        paneId="p1"
        paneIndex={0}
        isActivePane
        tabs={makeTabs({ id: 't1', isActive: true })}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onActivatePane={vi.fn()}
      />,
    );
    expect(c2.querySelector('[data-testid="pane-badge-p1"]')).toBeTruthy();
  });

  it('does not activate pane on tab pointerdown before tab selection', () => {
    const profile = resolvePaneProfile({ platform: 'phone', splitVisible: true, topInsetPx: 0 });
    const onActivatePane = vi.fn();
    const onSelectTab = vi.fn();
    const { container } = render(
      <PaneTabs
        platform="phone"
        profile={profile}
        paneId="p1"
        paneIndex={0}
        isActivePane={false}
        tabs={makeTabs({ id: 't1', isActive: true })}
        onSelectTab={onSelectTab}
        onCloseTab={vi.fn()}
        onActivatePane={onActivatePane}
      />,
    );

    const tab = container.querySelector('[data-tab-id="t1"]') as HTMLElement | null;
    expect(tab).toBeTruthy();

    fireEvent.pointerDown(tab!);
    expect(onActivatePane).not.toHaveBeenCalled();

    fireEvent.click(tab!);
    expect(onSelectTab).toHaveBeenCalledWith('t1');
    expect(onActivatePane).not.toHaveBeenCalled();
  });
});
