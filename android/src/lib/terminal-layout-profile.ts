export interface TerminalLayoutProfile {
  header: {
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
  };
  stage: {
    outerMargin: string;
    containerRadius: string;
    paneGap: string;
    rowBottomPadding: string;
    paneRadius: string;
  };
  quickBar: {
    touchSafeOffsetPx: number;
  };
}

const PHONE_HEADER_TOUCH_SAFE_OFFSET_PX = 20;

export function resolveTerminalLayoutProfile(options: {
  splitVisible: boolean;
  topInsetPx?: number;
}): TerminalLayoutProfile {
  const safeTopInsetPx = Math.max(0, Math.round(options.topInsetPx || 0));
  if (options.splitVisible) {
    return {
      header: {
        outerPadding: `${safeTopInsetPx + 2}px 4px 4px`,
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
      quickBar: {
        touchSafeOffsetPx: 0,
      },
    };
  }

  return {
    header: {
      outerPadding: `${safeTopInsetPx + PHONE_HEADER_TOUCH_SAFE_OFFSET_PX}px 6px 6px`,
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
    quickBar: {
      touchSafeOffsetPx: 0,
    },
  };
}
