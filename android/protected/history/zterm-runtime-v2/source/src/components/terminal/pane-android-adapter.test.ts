// @vitest-environment jsdom
/**
 * mobile-2.0.a 红测：Android pane 真源适配器 (mobileTheme → shared PaneProfile)
 *
 * 真源目标：
 * - `resolveAndroidPaneProfile({ splitVisible, landscape, topInsetPx })`
 *   返回 shared PaneProfile，等价于 `resolvePaneProfile({ platform: 'phone' })`
 *   但注入 Android `mobileTheme` 颜色 token 作为渲染覆盖层
 *
 * - `buildAndroidPaneTabDescriptor(session, paneGroup, serverColor)`
 *   把 Android `TerminalHeaderSessionItem` + `TerminalHeaderPaneGroup`
 *   转成 shared `PaneTabDescriptor`
 *
 * - `splitAndroidWorkbench(panes)` 把 `AndroidWorkspacePane` 列表
 *   转成 shared `PaneSlotDefinition[]`
 *
 * 这些适配器**还没有**在 android 端落地（mobile-2 切片才接入），
 * 本测试将 **全红** —— 是 mobile-2 切片的 TDD 入口。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import {
  resolveAndroidPaneProfile,
  buildAndroidPaneTabDescriptor,
  splitAndroidWorkbench,
  type AndroidPaneContext,
} from './pane-android-adapter';
import { mobileTheme } from '../../lib/mobile-ui';
import { resolvePaneProfile } from '@zterm/shared';

afterEach(() => {
  cleanup();
});

describe('resolveAndroidPaneProfile', () => {
  it('returns a phone profile that matches shared resolvePaneProfile(phone)', () => {
    const android = resolveAndroidPaneProfile({ splitVisible: false, topInsetPx: 24 });
    const shared = resolvePaneProfile({ platform: 'phone', splitVisible: false, topInsetPx: 24 });
    expect(android.mode).toBe(shared.mode);
    expect(android.header.outerPadding).toBe(shared.header.outerPadding);
    expect(android.header.tabMinHeight).toBe(shared.header.tabMinHeight);
  });

  it('returns split-default profile for portrait split', () => {
    const profile = resolveAndroidPaneProfile({ splitVisible: true, landscape: false, topInsetPx: 0 });
    expect(profile.mode).toBe('split-default');
  });

  it('returns split-landscape profile for landscape split', () => {
    const profile = resolveAndroidPaneProfile({ splitVisible: true, landscape: true, topInsetPx: 0 });
    expect(profile.mode).toBe('split-landscape');
    expect(profile.header.tabMinHeight).toBe('22px');
  });

  it('inherits mobileTheme token via theme overlay for android dark surface', () => {
    const profile = resolveAndroidPaneProfile({ splitVisible: false, topInsetPx: 0 });
    expect((profile as AndroidPaneContext).theme?.colors.shell).toBe(mobileTheme.colors.shell);
    expect((profile as AndroidPaneContext).theme?.colors.accent).toBe(mobileTheme.colors.accent);
  });
});

describe('buildAndroidPaneTabDescriptor', () => {
  it('maps active session to isActive=true', () => {
    const descriptor = buildAndroidPaneTabDescriptor({
      id: 's1',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'dev',
      title: 'dev',
      active: true,
    });
    expect(descriptor.id).toBe('s1');
    expect(descriptor.title).toBe('dev');
    expect(descriptor.isActive).toBe(true);
  });

  it('uses customName over sessionName when present', () => {
    const descriptor = buildAndroidPaneTabDescriptor({
      id: 's2',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'main',
      customName: 'production',
    });
    expect(descriptor.title).toBe('production');
  });

  it('marks resolved-relay tab with isResolvedRelay=true', () => {
    const descriptor = buildAndroidPaneTabDescriptor({
      id: 's3',
      bridgeHost: '127.0.0.1',
      bridgePort: 3333,
      sessionName: 'relay',
      resolvedPath: 'rtc-relay',
    });
    expect(descriptor.isResolvedRelay).toBe(true);
  });
});

describe('splitAndroidWorkbench', () => {
  it('returns one slot for single-pane', () => {
    const slots = splitAndroidWorkbench([
      {
        id: 'p1',
        size: 1,
        sessions: [{ id: 's1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'dev' }],
        activeSessionId: 's1',
        isActivePane: true,
      },
    ]);
    expect(slots.length).toBe(1);
    expect(slots[0].id).toBe('p1');
    expect(slots[0].isActive).toBe(true);
  });

  it('returns multiple slots in workspace order for split', () => {
    const slots = splitAndroidWorkbench([
      {
        id: 'p1',
        size: 1,
        sessions: [{ id: 's1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'a' }],
        activeSessionId: 's1',
        isActivePane: true,
      },
      {
        id: 'p2',
        size: 1,
        sessions: [{ id: 's2', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'b' }],
        activeSessionId: 's2',
        isActivePane: false,
      },
    ]);
    expect(slots.length).toBe(2);
    expect(slots[1].isActive).toBe(false);
    expect(slots[1].tabIds).toEqual(['s2']);
  });

  it('preserves pane size as PaneStage widthWeight', () => {
    const slots = splitAndroidWorkbench([
      {
        id: 'p1',
        size: 0.7,
        sessions: [{ id: 's1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'a' }],
        activeSessionId: 's1',
        isActivePane: true,
      },
      {
        id: 'p2',
        size: 0.3,
        sessions: [{ id: 's2', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'b' }],
        activeSessionId: 's2',
        isActivePane: false,
      },
    ]);
    expect(slots[0].size).toBe(0.7);
    expect(slots[1].size).toBe(0.3);
  });
});

describe('integration: shared PaneStage via Android adapter (placeholder)', () => {
  it('profile mode is single-pane when splitVisible=false', () => {
    const profile = resolveAndroidPaneProfile({ splitVisible: false, topInsetPx: 0 });
    expect(profile.mode).toBe('single-pane');
  });

  it('profile mode is split-default when splitVisible=true and landscape=false', () => {
    const profile = resolveAndroidPaneProfile({ splitVisible: true, landscape: false, topInsetPx: 0 });
    expect(profile.mode).toBe('split-default');
  });
});
