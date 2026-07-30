/**
 * 跨平台 pane 布局 profile 真源。
 *
 * 设计原则（与 android/docs/decisions/0001-cross-platform-layout-profile.md 一致）：
 * - pane / split / header / stage 的核心语义由唯一真源输出
 * - 平台差异只发生在 尺寸 / 触控 vs 指针 / gesture 行为 上
 * - 视觉 token 与手势 token 同源同住，便于一次改动两侧生效
 */

export type PanePlatform = 'phone' | 'tablet' | 'desktop';

export type PaneProfileMode =
  | 'single-pane'
  | 'split-default'
  | 'split-landscape'
  | 'desktop-single'
  | 'desktop-split';

export interface PaneHeaderTokens {
  outerPadding: string;
  rowGap: string;
  paneGap: string;
  backButtonSize: string;
  backButtonRadius: string;
  backButtonFontSize: string;
  panePadding: string;
  paneRadius: string;
  paneBadgeMinWidth: string;
  paneBadgeHeight: string;
  paneScrollerMinHeight: string;
  tabMinWidthActive: string;
  tabMaxWidthActive: string;
  tabMinWidthIdle: string;
  tabMaxWidthIdle: string;
  tabMinHeight: string;
  tabRadius: string;
  tabFontSize: string;
  tabActivePadding: string;
  tabIdlePadding: string;
  closeButtonRight: string;
  plusButtonSize: string;
  plusButtonRadius: string;
  plusButtonFontSize: string;
}

export interface PaneStageTokens {
  outerMargin: string;
  containerRadius: string;
  paneGap: string;
  rowBottomPadding: string;
  paneRadius: string;
}

export type PaneContextMenuTrigger = 'long-press' | 'right-click' | 'both';
export type PaneTabSwitchTrigger = 'horizontal-swipe' | 'ctrl-page' | 'wheel' | 'cmd-option-arrow';

export interface PaneGestureTokens {
  longPressMs: number;
  doubleTapMs: number;
  swipeLockPx: number;
  swipeTriggerPx: number;
  dividerHitPx: number;
  contextMenuTrigger: PaneContextMenuTrigger;
  tabSwitchTrigger: PaneTabSwitchTrigger;
  dragResizeEnabled: boolean;
}

export interface PanePlatformProfile {
  platform: PanePlatform;
  header: Omit<PaneHeaderTokens, 'outerPadding'> & {
    outerPadding: (topInsetPx: number) => string;
  };
  stage: PaneStageTokens;
  gesture: PaneGestureTokens;
  quickBar: {
    touchSafeOffsetPx: number;
    shellMode: 'inline' | 'floating-collapsed';
  };
}

export interface PaneProfileInput {
  platform: PanePlatform;
  splitVisible: boolean;
  landscape?: boolean;
  topInsetPx?: number;
}

export interface PaneProfile {
  mode: PaneProfileMode;
  platform: PanePlatform;
  splitVisible: boolean;
  header: PaneHeaderTokens;
  stage: PaneStageTokens;
  gesture: PaneGestureTokens;
  quickBar: PanePlatformProfile['quickBar'];
}

const PHONE_HEADER_TOUCH_SAFE_OFFSET_PX = 20;
const PHONE_SPLIT_HEADER_TOUCH_SAFE_OFFSET_PX = 0;
const DESKTOP_HEADER_TOUCH_SAFE_OFFSET_PX = 8;

function buildPhoneSplitLandscapeProfile(): PanePlatformProfile {
  return {
    platform: 'phone',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${topInsetPx + PHONE_SPLIT_HEADER_TOUCH_SAFE_OFFSET_PX + 1}px 4px 2px`,
      rowGap: '3px',
      paneGap: '3px',
      backButtonSize: '22px',
      backButtonRadius: '8px',
      backButtonFontSize: '15px',
      panePadding: '1px 3px',
      paneRadius: '10px',
      paneBadgeMinWidth: '18px',
      paneBadgeHeight: '18px',
      paneScrollerMinHeight: '24px',
      tabMinWidthActive: '84px',
      tabMaxWidthActive: '120px',
      tabMinWidthIdle: '58px',
      tabMaxWidthIdle: '96px',
      tabMinHeight: '22px',
      tabRadius: '9px',
      tabFontSize: '10px',
      tabActivePadding: '0 24px 0 7px',
      tabIdlePadding: '0 7px',
      closeButtonRight: '2px',
      plusButtonSize: '22px',
      plusButtonRadius: '8px',
      plusButtonFontSize: '15px',
    },
    stage: {
      outerMargin: '0 3px',
      containerRadius: '0',
      paneGap: '6px',
      rowBottomPadding: '0 0 2px',
      paneRadius: '12px',
    },
    gesture: {
      longPressMs: 920,
      doubleTapMs: 280,
      swipeLockPx: 12,
      swipeTriggerPx: 48,
      dividerHitPx: 18,
      contextMenuTrigger: 'long-press',
      tabSwitchTrigger: 'horizontal-swipe',
      dragResizeEnabled: false,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'inline' },
  };
}

function buildPhoneSplitDefaultProfile(): PanePlatformProfile {
  return {
    platform: 'phone',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${topInsetPx + PHONE_SPLIT_HEADER_TOUCH_SAFE_OFFSET_PX + 2}px 4px 4px`,
      rowGap: '4px',
      paneGap: '4px',
      backButtonSize: '24px',
      backButtonRadius: '8px',
      backButtonFontSize: '16px',
      panePadding: '2px 4px',
      paneRadius: '12px',
      paneBadgeMinWidth: '20px',
      paneBadgeHeight: '20px',
      paneScrollerMinHeight: '30px',
      tabMinWidthActive: '96px',
      tabMaxWidthActive: '136px',
      tabMinWidthIdle: '66px',
      tabMaxWidthIdle: '112px',
      tabMinHeight: '28px',
      tabRadius: '10px',
      tabFontSize: '10.5px',
      tabActivePadding: '0 28px 0 8px',
      tabIdlePadding: '0 8px',
      closeButtonRight: '3px',
      plusButtonSize: '24px',
      plusButtonRadius: '8px',
      plusButtonFontSize: '16px',
    },
    stage: {
      outerMargin: '0 4px',
      containerRadius: '0',
      paneGap: '8px',
      rowBottomPadding: '0 0 2px',
      paneRadius: '14px',
    },
    gesture: {
      longPressMs: 920,
      doubleTapMs: 280,
      swipeLockPx: 12,
      swipeTriggerPx: 48,
      dividerHitPx: 18,
      contextMenuTrigger: 'long-press',
      tabSwitchTrigger: 'horizontal-swipe',
      dragResizeEnabled: false,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'inline' },
  };
}

function buildPhoneSinglePaneProfile(): PanePlatformProfile {
  return {
    platform: 'phone',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${topInsetPx + PHONE_HEADER_TOUCH_SAFE_OFFSET_PX}px 6px 6px`,
      rowGap: '6px',
      paneGap: '6px',
      backButtonSize: '36px',
      backButtonRadius: '12px',
      backButtonFontSize: '20px',
      panePadding: '0',
      paneRadius: '0',
      paneBadgeMinWidth: '20px',
      paneBadgeHeight: '20px',
      paneScrollerMinHeight: '36px',
      tabMinWidthActive: '112px',
      tabMaxWidthActive: '154px',
      tabMinWidthIdle: '74px',
      tabMaxWidthIdle: '128px',
      tabMinHeight: '34px',
      tabRadius: '12px',
      tabFontSize: '11px',
      tabActivePadding: '0 34px 0 12px',
      tabIdlePadding: '0 12px',
      closeButtonRight: '8px',
      plusButtonSize: '36px',
      plusButtonRadius: '12px',
      plusButtonFontSize: '20px',
    },
    stage: {
      outerMargin: '0 4px',
      containerRadius: '14px',
      paneGap: '8px',
      rowBottomPadding: '0',
      paneRadius: '14px',
    },
    gesture: {
      longPressMs: 920,
      doubleTapMs: 280,
      swipeLockPx: 12,
      swipeTriggerPx: 48,
      dividerHitPx: 18,
      contextMenuTrigger: 'long-press',
      tabSwitchTrigger: 'horizontal-swipe',
      dragResizeEnabled: false,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'inline' },
  };
}

function buildDesktopSplitProfile(): PanePlatformProfile {
  return {
    platform: 'desktop',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${Math.max(0, topInsetPx) + 2}px 2px 2px`,
      rowGap: '1px',
      paneGap: '2px',
      backButtonSize: '28px',
      backButtonRadius: '8px',
      backButtonFontSize: '14px',
      panePadding: '0',
      paneRadius: '0',
      paneBadgeMinWidth: '22px',
      paneBadgeHeight: '20px',
      paneScrollerMinHeight: '22px',
      tabMinWidthActive: '116px',
      tabMaxWidthActive: '190px',
      tabMinWidthIdle: '72px',
      tabMaxWidthIdle: '150px',
      tabMinHeight: '22px',
      tabRadius: '4px',
      tabFontSize: '11px',
      tabActivePadding: '0 24px 0 8px',
      tabIdlePadding: '0 8px',
      closeButtonRight: '3px',
      plusButtonSize: '24px',
      plusButtonRadius: '6px',
      plusButtonFontSize: '14px',
    },
    stage: {
      outerMargin: '0',
      containerRadius: '0',
      paneGap: '0',
      rowBottomPadding: '0',
      paneRadius: '0',
    },
    gesture: {
      longPressMs: 600,
      doubleTapMs: 280,
      swipeLockPx: 8,
      swipeTriggerPx: 32,
      dividerHitPx: 3,
      contextMenuTrigger: 'right-click',
      tabSwitchTrigger: 'ctrl-page',
      dragResizeEnabled: true,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'floating-collapsed' },
  };
}

function buildDesktopSingleProfile(): PanePlatformProfile {
  return {
    platform: 'desktop',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${Math.max(0, topInsetPx) + DESKTOP_HEADER_TOUCH_SAFE_OFFSET_PX}px 10px 8px`,
      rowGap: '6px',
      paneGap: '4px',
      backButtonSize: '32px',
      backButtonRadius: '8px',
      backButtonFontSize: '15px',
      panePadding: '0',
      paneRadius: '0',
      paneBadgeMinWidth: '24px',
      paneBadgeHeight: '24px',
      paneScrollerMinHeight: '36px',
      tabMinWidthActive: '160px',
      tabMaxWidthActive: '260px',
      tabMinWidthIdle: '100px',
      tabMaxWidthIdle: '200px',
      tabMinHeight: '32px',
      tabRadius: '8px',
      tabFontSize: '12.5px',
      tabActivePadding: '0 36px 0 12px',
      tabIdlePadding: '0 12px',
      closeButtonRight: '6px',
      plusButtonSize: '32px',
      plusButtonRadius: '8px',
      plusButtonFontSize: '17px',
    },
    stage: {
      outerMargin: '0',
      containerRadius: '8px',
      paneGap: '4px',
      rowBottomPadding: '0',
      paneRadius: '8px',
    },
    gesture: {
      longPressMs: 600,
      doubleTapMs: 280,
      swipeLockPx: 8,
      swipeTriggerPx: 32,
      dividerHitPx: 8,
      contextMenuTrigger: 'right-click',
      tabSwitchTrigger: 'ctrl-page',
      dragResizeEnabled: true,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'floating-collapsed' },
  };
}

function buildTabletSplitProfile(): PanePlatformProfile {
  return {
    platform: 'tablet',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${Math.max(0, topInsetPx) + 12}px 8px 6px`,
      rowGap: '6px',
      paneGap: '4px',
      backButtonSize: '28px',
      backButtonRadius: '10px',
      backButtonFontSize: '16px',
      panePadding: '2px 4px',
      paneRadius: '12px',
      paneBadgeMinWidth: '22px',
      paneBadgeHeight: '22px',
      paneScrollerMinHeight: '32px',
      tabMinWidthActive: '120px',
      tabMaxWidthActive: '180px',
      tabMinWidthIdle: '76px',
      tabMaxWidthIdle: '140px',
      tabMinHeight: '30px',
      tabRadius: '10px',
      tabFontSize: '11.5px',
      tabActivePadding: '0 30px 0 10px',
      tabIdlePadding: '0 10px',
      closeButtonRight: '4px',
      plusButtonSize: '28px',
      plusButtonRadius: '10px',
      plusButtonFontSize: '16px',
    },
    stage: {
      outerMargin: '0 6px',
      containerRadius: '12px',
      paneGap: '8px',
      rowBottomPadding: '0 0 4px',
      paneRadius: '12px',
    },
    gesture: {
      longPressMs: 720,
      doubleTapMs: 280,
      swipeLockPx: 10,
      swipeTriggerPx: 40,
      dividerHitPx: 12,
      contextMenuTrigger: 'both',
      tabSwitchTrigger: 'horizontal-swipe',
      dragResizeEnabled: true,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'inline' },
  };
}

function buildTabletSingleProfile(): PanePlatformProfile {
  return {
    platform: 'tablet',
    header: {
      outerPadding: (topInsetPx: number) =>
        `${Math.max(0, topInsetPx) + 12}px 10px 8px`,
      rowGap: '6px',
      paneGap: '4px',
      backButtonSize: '32px',
      backButtonRadius: '12px',
      backButtonFontSize: '17px',
      panePadding: '0',
      paneRadius: '0',
      paneBadgeMinWidth: '24px',
      paneBadgeHeight: '24px',
      paneScrollerMinHeight: '36px',
      tabMinWidthActive: '140px',
      tabMaxWidthActive: '220px',
      tabMinWidthIdle: '88px',
      tabMaxWidthIdle: '160px',
      tabMinHeight: '32px',
      tabRadius: '12px',
      tabFontSize: '12px',
      tabActivePadding: '0 32px 0 12px',
      tabIdlePadding: '0 12px',
      closeButtonRight: '6px',
      plusButtonSize: '32px',
      plusButtonRadius: '12px',
      plusButtonFontSize: '17px',
    },
    stage: {
      outerMargin: '0 8px',
      containerRadius: '14px',
      paneGap: '8px',
      rowBottomPadding: '0',
      paneRadius: '14px',
    },
    gesture: {
      longPressMs: 720,
      doubleTapMs: 280,
      swipeLockPx: 10,
      swipeTriggerPx: 40,
      dividerHitPx: 12,
      contextMenuTrigger: 'both',
      tabSwitchTrigger: 'horizontal-swipe',
      dragResizeEnabled: true,
    },
    quickBar: { touchSafeOffsetPx: 0, shellMode: 'inline' },
  };
}

export function resolvePlatformProfile(
  platform: PanePlatform,
  splitVisible: boolean,
  landscape: boolean = false,
): PanePlatformProfile {
  if (platform === 'desktop') {
    return splitVisible ? buildDesktopSplitProfile() : buildDesktopSingleProfile();
  }
  if (platform === 'tablet') {
    return splitVisible ? buildTabletSplitProfile() : buildTabletSingleProfile();
  }
  if (!splitVisible) {
    return buildPhoneSinglePaneProfile();
  }
  return landscape ? buildPhoneSplitLandscapeProfile() : buildPhoneSplitDefaultProfile();
}

export function resolvePaneProfile(input: PaneProfileInput): PaneProfile {
  const safeTopInsetPx = Math.max(0, Math.round(input.topInsetPx || 0));
  const platformProfile = resolvePlatformProfile(input.platform, input.splitVisible, input.landscape ?? false);

  let mode: PaneProfileMode;
  if (input.platform === 'desktop') {
    mode = input.splitVisible ? 'desktop-split' : 'desktop-single';
  } else if (input.platform === 'tablet') {
    mode = input.landscape ? 'split-landscape' : 'split-default';
  } else {
    if (input.splitVisible) {
      mode = input.landscape ? 'split-landscape' : 'split-default';
    } else {
      mode = 'single-pane';
    }
  }

  return {
    mode,
    platform: input.platform,
    splitVisible: input.splitVisible,
    header: {
      ...platformProfile.header,
      outerPadding: platformProfile.header.outerPadding(safeTopInsetPx),
    },
    stage: platformProfile.stage,
    gesture: platformProfile.gesture,
    quickBar: platformProfile.quickBar,
  };
}
