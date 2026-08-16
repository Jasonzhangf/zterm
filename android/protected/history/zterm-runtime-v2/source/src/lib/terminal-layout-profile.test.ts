import { describe, expect, it } from 'vitest';
import {
  resolveTerminalLayoutProfile,
  resolveTerminalSessionGroupLayoutAxis,
} from './terminal-layout-profile';

describe('terminal-layout-profile', () => {
  it('uses split-landscape profile when split panes are visible in landscape', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: true,
      landscape: true,
      topInsetPx: 0,
    });

    expect(profile.mode).toBe('split-landscape');
    expect(profile.header.tabMinHeight).toBe('22px');
    expect(profile.header.outerPadding).toBe('1px 4px 2px');
    expect(profile.stage.paneGap).toBe('6px');
    expect(profile.quickBar.shellMode).toBe('inline');
  });

  it('keeps default split profile when not in landscape', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: true,
      landscape: false,
      topInsetPx: 0,
    });

    expect(profile.mode).toBe('split-default');
    expect(profile.header.tabMinHeight).toBe('28px');
    expect(profile.header.outerPadding).toBe('2px 4px 4px');
    expect(profile.quickBar.shellMode).toBe('inline');
  });

  it('keeps single-pane phone profile untouched', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: false,
      topInsetPx: 24,
    });

    expect(profile.mode).toBe('single-pane');
    expect(profile.header.outerPadding).toBe('44px 6px 6px');
    expect(profile.quickBar.shellMode).toBe('inline');
  });

  it('uses phone portrait vertical group profile only for non-split portrait group mode', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: false,
      landscape: false,
      sessionGroupVisible: true,
      topInsetPx: 16,
    });

    expect(profile.mode).toBe('phone-portrait-vertical-group');
    expect(profile.header.outerPadding).toBe('36px 6px 6px');

    const landscapeProfile = resolveTerminalLayoutProfile({
      splitVisible: false,
      landscape: true,
      sessionGroupVisible: true,
      topInsetPx: 16,
    });

    expect(landscapeProfile.mode).toBe('single-pane');
  });

  it('keeps narrow portrait session groups vertical by aspect ratio', () => {
    expect(resolveTerminalSessionGroupLayoutAxis({
      viewportWidth: 360,
      viewportHeight: 900,
      mode: 'horizontal',
    })).toBe('vertical');
  });

  it('defaults wide portrait session groups to horizontal while allowing vertical override', () => {
    expect(resolveTerminalSessionGroupLayoutAxis({
      viewportWidth: 760,
      viewportHeight: 1024,
      mode: 'auto',
    })).toBe('horizontal');

    expect(resolveTerminalSessionGroupLayoutAxis({
      viewportWidth: 760,
      viewportHeight: 1024,
      mode: 'vertical',
    })).toBe('vertical');
  });

  it('keeps landscape session groups horizontal regardless of the setting', () => {
    expect(resolveTerminalSessionGroupLayoutAxis({
      viewportWidth: 1024,
      viewportHeight: 760,
      mode: 'vertical',
    })).toBe('horizontal');
  });

  it('uses a horizontal group profile for wide portrait group mode', () => {
    const profile = resolveTerminalLayoutProfile({
      splitVisible: false,
      landscape: false,
      sessionGroupVisible: true,
      sessionGroupAxis: 'horizontal',
      topInsetPx: 16,
    });

    expect(profile.mode).toBe('tablet-portrait-horizontal-group');
    expect(profile.header.outerPadding).toBe('36px 6px 6px');
  });
});
