import { describe, expect, it } from 'vitest';
import {
  resolvePaneProfile,
  resolvePlatformProfile,
  type PanePlatform,
} from './pane-profile';

describe('pane-profile', () => {
  it('phone single-pane keeps the phone-only 36px back button', () => {
    const profile = resolvePaneProfile({
      platform: 'phone',
      splitVisible: false,
      topInsetPx: 0,
    });
    expect(profile.mode).toBe('single-pane');
    expect(profile.header.backButtonSize).toBe('36px');
    expect(profile.header.outerPadding).toBe('20px 6px 6px');
    expect(profile.gesture.contextMenuTrigger).toBe('long-press');
    expect(profile.gesture.dragResizeEnabled).toBe(false);
  });

  it('phone split portrait uses split-default token set', () => {
    const profile = resolvePaneProfile({
      platform: 'phone',
      splitVisible: true,
      landscape: false,
      topInsetPx: 0,
    });
    expect(profile.mode).toBe('split-default');
    expect(profile.header.tabMinHeight).toBe('28px');
    expect(profile.gesture.tabSwitchTrigger).toBe('horizontal-swipe');
  });

  it('phone split landscape keeps dense tab strip tokens', () => {
    const profile = resolvePaneProfile({
      platform: 'phone',
      splitVisible: true,
      landscape: true,
      topInsetPx: 0,
    });
    expect(profile.mode).toBe('split-landscape');
    expect(profile.header.outerPadding).toBe('1px 4px 2px');
    expect(profile.header.tabMinHeight).toBe('22px');
    expect(profile.gesture.tabSwitchTrigger).toBe('horizontal-swipe');
  });

  it('desktop single-pane enables right-click and drag-resize', () => {
    const profile = resolvePaneProfile({
      platform: 'desktop',
      splitVisible: false,
      topInsetPx: 0,
    });
    expect(profile.mode).toBe('desktop-single');
    expect(profile.gesture.contextMenuTrigger).toBe('right-click');
    expect(profile.gesture.dragResizeEnabled).toBe(true);
    expect(profile.gesture.tabSwitchTrigger).toBe('ctrl-page');
    expect(profile.quickBar.shellMode).toBe('floating-collapsed');
  });

  it('desktop split uses iTerm2-like zero pane gap and a thin divider hit band', () => {
    const profile = resolvePaneProfile({
      platform: 'desktop',
      splitVisible: true,
      topInsetPx: 0,
    });
    expect(profile.mode).toBe('desktop-split');
    expect(profile.stage.paneGap).toBe('0');
    expect(profile.stage.paneRadius).toBe('0');
    expect(profile.header.panePadding).toBe('0');
    expect(profile.gesture.dividerHitPx).toBe(3);
    expect(profile.gesture.dragResizeEnabled).toBe(true);
    expect(profile.gesture.contextMenuTrigger).toBe('right-click');
  });

  it('tablet enables both long-press and right-click for context menu', () => {
    const profile = resolvePaneProfile({
      platform: 'tablet',
      splitVisible: true,
      topInsetPx: 0,
    });
    expect(profile.gesture.contextMenuTrigger).toBe('both');
    expect(profile.gesture.dragResizeEnabled).toBe(true);
    expect(profile.gesture.tabSwitchTrigger).toBe('horizontal-swipe');
  });

  it('topInsetPx only adds to outerPadding header token', () => {
    const profile = resolvePaneProfile({
      platform: 'phone',
      splitVisible: false,
      topInsetPx: 44,
    });
    expect(profile.header.outerPadding).toBe('64px 6px 6px');
  });

  it('resolvePlatformProfile is pure and platform-agnostic of mode', () => {
    const phone = resolvePlatformProfile('phone', true);
    const desktop = resolvePlatformProfile('desktop', true);
    expect(phone.platform).toBe('phone');
    expect(desktop.platform).toBe('desktop');
    expect(phone.gesture.contextMenuTrigger).not.toBe(desktop.gesture.contextMenuTrigger);
  });

  it('phone gesture longPress is longer than desktop gesture longPress', () => {
    const phone = resolvePlatformProfile('phone', true);
    const desktop = resolvePlatformProfile('desktop', true);
    expect(phone.gesture.longPressMs).toBeGreaterThan(desktop.gesture.longPressMs);
  });
});
