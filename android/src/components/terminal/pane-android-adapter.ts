/**
 * mobile-2.1.a Android pane 真源适配器
 *
 * 桥 Android 端 native session/pane 模型 → shared PaneStage/PaneTabs contract。
 *
 * 设计原则：
 * - mobileTheme 颜色 token 通过 theme overlay 注入，**不改 shared PaneProfile 自身**
 * - pane/tab 描述符转 shared PaneSlotDefinition/PaneTabDescriptor 时保真
 * - 不持有 workspace 状态，只做 map
 * - 与 android/src/lib/terminal-layout-profile.ts 的关系：
 *   本文件是新版真源，旧的 phone-only helper 后续切片可下线
 */

import {
  resolvePaneProfile,
  type PaneProfile,
  type PaneSlotDefinition,
  type PaneTabDescriptor,
} from '@zterm/shared';
import { mobileTheme } from '../../lib/mobile-ui';

/**
 * Android pane session 入口（与 TerminalHeader.tsx 当前的 TerminalHeaderSessionItem 形态兼容）
 */
export interface AndroidPaneSessionInput {
  id: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  title?: string;
  customName?: string;
  resolvedPath?: 'lan' | 'rtc-direct' | 'tailscale' | 'ipv6' | 'ipv4' | 'rtc-relay';
  active?: boolean;
}

/**
 * Android pane 组（与 TerminalHeader.tsx 当前的 TerminalHeaderPaneGroup 形态兼容）
 */
export interface AndroidPaneGroupInput {
  id: string;
  size?: number;
  sessions: AndroidPaneSessionInput[];
  activeSessionId: string | null;
  isActivePane: boolean;
}

/**
 * Theme overlay：把 mobileTheme 颜色 token 注入 PaneProfile theme 字段
 * shared PaneTabs/PaneStage 当前不读 theme 字段（占位），但保留契约
 * 方便后续 PaneStage/PaneTabs 真实读取时无需再改 adapter
 */
export interface AndroidPaneTheme {
  colors: typeof mobileTheme.colors;
}

/**
 * AndroidPaneContext = PaneProfile + theme overlay
 */
export interface AndroidPaneContext extends PaneProfile {
  theme: AndroidPaneTheme;
}

/**
 * resolveAndroidPaneProfile: 等价 shared resolvePaneProfile(phone) + theme overlay
 */
export interface AndroidPaneProfileInput {
  splitVisible: boolean;
  landscape?: boolean;
  topInsetPx?: number;
}

export function resolveAndroidPaneProfile(input: AndroidPaneProfileInput): AndroidPaneContext {
  const profile = resolvePaneProfile({
    platform: 'phone',
    splitVisible: input.splitVisible,
    landscape: input.landscape ?? false,
    topInsetPx: input.topInsetPx ?? 0,
  });
  return {
    ...profile,
    theme: {
      colors: mobileTheme.colors,
    },
  };
}

/**
 * buildAndroidPaneTabDescriptor: Android session → shared PaneTabDescriptor
 */
export function buildAndroidPaneTabDescriptor(session: AndroidPaneSessionInput): PaneTabDescriptor {
  return {
    id: session.id,
    title: session.customName ?? session.title ?? session.sessionName,
    isActive: session.active ?? false,
    isResolvedRelay: session.resolvedPath === 'rtc-relay',
  };
}

/**
 * splitAndroidWorkbench: Android pane 列表 → shared PaneSlotDefinition[]
 *
 * 保留 pane size / active 状态 / tabIds / activeTabId 字段
 */
export function splitAndroidWorkbench(panes: AndroidPaneGroupInput[]): PaneSlotDefinition[] {
  return panes.map((pane, index) => {
    const tabDescriptors = pane.sessions.map((session) => buildAndroidPaneTabDescriptor({
      ...session,
      active: session.id === pane.activeSessionId,
    }));
    return {
      id: pane.id,
      title: `Pane ${index + 1}`,
      size: pane.size ?? 1,
      isActive: pane.isActivePane,
      render: () => null,
      tabIds: tabDescriptors.map((tab) => tab.id),
      activeTabId: pane.activeSessionId,
    };
  });
}
